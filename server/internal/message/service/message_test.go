package messageservice

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/message/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
)

// seedFixture 单聊(conv1: alice=10001/bob=10002) + 广播群(conv2: alice=member, root=10003=publisher)
func seedFixture(t *testing.T, opts Options) (*Service, *messagerepo.Memory, *eventbus.InMemory) {
	t.Helper()
	r := messagerepo.NewMemory()
	bus := eventbus.New()
	svc := New(opts, r, bus)
	ctx := context.Background()

	c1, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvSingle, Name: "alice-bob"})
	if err != nil {
		t.Fatal(err)
	}
	if c1.ID != 1 {
		t.Fatalf("种子会话 ID 应为 1, got %d", c1.ID)
	}
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: 1, UserID: 10001, Role: messageapi.MemberMember})
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: 1, UserID: 10002, Role: messageapi.MemberMember})

	c2, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvBroadcast, Name: "全员公告"})
	if err != nil {
		t.Fatal(err)
	}
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: c2.ID, UserID: 10001, Role: messageapi.MemberMember})
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: c2.ID, UserID: 10003, Role: messageapi.MemberPublisher})
	return svc, r, bus
}

// textPayload conv 参数收 int64（构造器内转字符串，对齐 wire 契约 conv_id:string）
func textPayload(conv int64, cmid, text string) messageapi.SendPayload {
	body, _ := json.Marshal(map[string]string{"text": text})
	return messageapi.SendPayload{ConvID: messageapi.ConvID(strconv.FormatInt(conv, 10)), ClientMsgID: cmid, Type: "text", Body: body}
}

func TestSendAllocatesMonotonicSeq(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{})
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		res, err := svc.Send(ctx, 10001, textPayload(1, fmt.Sprintf("m-%d", i), "hi"))
		if err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
		if res.Seq != int64(i) {
			t.Fatalf("seq 应从 1 单调递增: got %d want %d", res.Seq, i)
		}
		if res.Duplicate {
			t.Fatalf("首发不应命中幂等")
		}
	}
	conv, _ := r.GetConversation(ctx, 1)
	if conv.LatestSeq != 5 {
		t.Fatalf("latest_seq 冗余不符: %d", conv.LatestSeq)
	}
}

// 并发安全：100 并发 × 20 条 → seq 无重复、无空洞（会话内全序，04 篇 §7.2）
func TestSendConcurrentSeqUnique(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{})
	const workers, perWorker = 50, 20
	var wg sync.WaitGroup
	seqs := make(chan int64, workers*perWorker)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				res, err := svc.Send(context.Background(), 10001,
					textPayload(1, fmt.Sprintf("w%d-i%d", w, i), "x"))
				if err != nil {
					t.Errorf("send: %v", err)
					return
				}
				seqs <- res.Seq
			}
		}(w)
	}
	wg.Wait()
	close(seqs)

	seen := map[int64]bool{}
	max := int64(0)
	for s := range seqs {
		if seen[s] {
			t.Fatalf("seq 重复: %d", s)
		}
		seen[s] = true
		if s > max {
			max = s
		}
	}
	if len(seen) != workers*perWorker || max != int64(workers*perWorker) {
		t.Fatalf("seq 应连续覆盖 1..%d: got %d 个, max=%d", workers*perWorker, len(seen), max)
	}
	// 落库有序性：msgs 按 seq 升序
	msgs, _ := r.ListMessages(context.Background(), 1, 0, 0, 1000)
	for i := 1; i < len(msgs); i++ {
		if msgs[i].Seq <= msgs[i-1].Seq {
			t.Fatalf("落库乱序: %d 后出现 %d", msgs[i-1].Seq, msgs[i].Seq)
		}
	}
}

// 幂等：同 client_msg_id 重试返回原 seq 不重复落库（14 篇 §5.3）
func TestSendIdempotent(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{})
	ctx := context.Background()

	first, err := svc.Send(ctx, 10001, textPayload(1, "same-id", "hi"))
	if err != nil {
		t.Fatal(err)
	}
	again, err := svc.Send(ctx, 10001, textPayload(1, "same-id", "hi"))
	if err != nil {
		t.Fatal(err)
	}
	if !again.Duplicate || again.Seq != first.Seq || again.MsgID != first.MsgID {
		t.Fatalf("幂等命中应返回原结果: first=%+v again=%+v", first, again)
	}
	msgs, _ := r.ListMessages(ctx, 1, 0, 0, 100)
	if len(msgs) != 1 {
		t.Fatalf("重复落库: %d 条", len(msgs))
	}

	// 并发同 client_msg_id：两次同时到达也只有一个生效
	var wg sync.WaitGroup
	resCh := make(chan *messageapi.SendResult, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := svc.Send(context.Background(), 10001, textPayload(1, "race-id", "hi"))
			if err != nil {
				t.Errorf("并发发送: %v", err)
				return
			}
			resCh <- res
		}()
	}
	wg.Wait()
	close(resCh)
	seqSet := map[int64]bool{}
	for res := range resCh {
		seqSet[res.Seq] = true
	}
	if len(seqSet) != 1 {
		t.Fatalf("并发幂等失败，出现多个 seq: %v", seqSet)
	}
}

// 表驱动：发送校验矩阵（04 篇 §6.3 错误码）
func TestSendValidation(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{SensitiveWords: []string{"bomb"}})
	ctx := context.Background()
	// 解散 conv1
	_ = r.DissolveConversation(ctx, 1)

	long := make([]byte, 5001)
	for i := range long {
		long[i] = 'a'
	}
	longBody, _ := json.Marshal(map[string]string{"text": string(long)})

	cases := []struct {
		name     string
		sender   int64
		payload  messageapi.SendPayload
		wantCode errx.Code
	}{
		{"会话不存在", 10001, textPayload(999, "a", "x"), errx.CodeIMConvNotFound},
		{"群已解散", 10001, textPayload(1, "b", "x"), errx.CodeIMConvDissolved},
		{"不在会话中", 99999, textPayload(2, "c", "x"), errx.CodeIMNotInConversation},
		{"广播群只读", 10001, textPayload(2, "d", "x"), errx.CodeIMBroadcastReadOnly},
		{"内容超限", 10003, messageapi.SendPayload{ConvID: "2", ClientMsgID: "e", Type: "text", Body: longBody}, errx.CodeIMContentTooLong},
		{"敏感词", 10003, textPayload(2, "f", "this has bomb inside"), errx.CodeIMSensitiveBlocked},
		{"缺 client_msg_id", 10003, messageapi.SendPayload{ConvID: "2", ClientMsgID: "", Type: "text"}, errx.CodeBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := svc.Send(ctx, c.sender, c.payload)
			if errx.From(err).Code != c.wantCode {
				t.Fatalf("code=%d(%v) want=%d", errx.From(err).Code, err, c.wantCode)
			}
		})
	}
}

func TestSendMuted(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{})
	ctx := context.Background()
	_ = r.AddMember(ctx, messagerepo.Member{
		ConvID: 1, UserID: 10001, Role: messageapi.MemberMember,
		MuteUntil: time.Now().Add(time.Hour),
	})
	if _, err := svc.Send(ctx, 10001, textPayload(1, "muted-1", "x")); errx.From(err).Code != errx.CodeIMMuted {
		t.Fatalf("禁言应 3006: %v", err)
	}
}

// Send → msg.created 事件（gateway 扇出的输入）
func TestSendPublishesEvent(t *testing.T) {
	svc, _, bus := seedFixture(t, Options{})
	var got messageapi.MsgCreatedEvent
	bus.Subscribe(eventbus.TopicMsgCreated, func(_ context.Context, e eventbus.Event) error {
		evt, ok := e.Payload.(messageapi.MsgCreatedEvent)
		if !ok {
			t.Errorf("payload 类型错误: %T", e.Payload)
			return nil
		}
		got = evt
		return nil
	})
	if _, err := svc.Send(context.Background(), 10001, textPayload(1, "evt-1", "hello")); err != nil {
		t.Fatal(err)
	}
	if got.Message.Seq != 1 || got.Message.SenderID != 10001 {
		t.Fatalf("事件消息不符: %+v", got.Message)
	}
	if len(got.MemberIDs) != 2 {
		t.Fatalf("扇出成员应 2 人: %v", got.MemberIDs)
	}
}

// 不变量：read_seq 只进不退，取 max（04 篇 §4.2）
func TestMarkReadMonotonic(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{})
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		_, err := svc.Send(ctx, 10002, textPayload(1, fmt.Sprintf("r-%d", i), "x"))
		if err != nil {
			t.Fatal(err)
		}
	}

	res, err := svc.MarkRead(ctx, 10001, messageapi.ReadPayload{ConvID: "1", ReadSeq: 3})
	if err != nil || res.ReadSeq != 3 {
		t.Fatalf("首次上报: res=%+v err=%v", res, err)
	}
	// 回退 → no-op，返回当前值
	res, err = svc.MarkRead(ctx, 10001, messageapi.ReadPayload{ConvID: "1", ReadSeq: 1})
	if err != nil || res.ReadSeq != 3 {
		t.Fatalf("回退应被忽略: res=%+v err=%v", res, err)
	}
	// 前进 → 生效
	res, err = svc.MarkRead(ctx, 10001, messageapi.ReadPayload{ConvID: "1", ReadSeq: 5})
	if err != nil || res.ReadSeq != 5 {
		t.Fatalf("前进应生效: res=%+v err=%v", res, err)
	}
	// 越过 latest_seq → 3018
	_, err = svc.MarkRead(ctx, 10001, messageapi.ReadPayload{ConvID: "1", ReadSeq: 99})
	if errx.From(err).Code != errx.CodeIMInvalidCursor {
		t.Fatalf("非法游标应 3018: %v", err)
	}
	// 底层游标确实推进
	rt, _ := r.GetReceipt(ctx, 1, 10001)
	if rt.ReadSeq != 5 {
		t.Fatalf("receipt 不符: %+v", rt)
	}
}

func TestListMessages(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		_, _ = svc.Send(ctx, 10001, textPayload(1, fmt.Sprintf("l-%d", i), "x"))
	}
	// 补洞场景：after=2 before=5 → seq 3,4（14 篇 §4.2）
	msgs, err := svc.ListMessages(ctx, 1, 2, 5, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 || msgs[0].Seq != 3 || msgs[1].Seq != 4 {
		t.Fatalf("补洞结果不符: %+v", msgs)
	}
	if _, err := svc.ListMessages(ctx, 42, 0, 0, 20); errx.From(err).Code != errx.CodeIMConvNotFound {
		t.Fatalf("会话不存在: %v", err)
	}
}

// ── 文件消息（D06 阶段一）──

// filePayload file/image 消息构造（body.file_id 字符串口径，与客户端一致）
func filePayload(conv int64, cmid, typ, fileID string, extra map[string]any) messageapi.SendPayload {
	body := map[string]any{"file_id": fileID, "name": "a.png", "size": 3}
	for k, v := range extra {
		body[k] = v
	}
	raw, _ := json.Marshal(body)
	return messageapi.SendPayload{
		ConvID:      messageapi.ConvID(strconv.FormatInt(conv, 10)),
		ClientMsgID: cmid, Type: typ, Body: raw,
	}
}

// TestSendFileMessageValidation msg.send type=file/image 的 body.file_id 校验路径：
// 注入闭包拒 4005/2003；file_id 非法 9001；成功后 FileMarkSent 回填（尽力而为）
func TestSendFileMessageValidation(t *testing.T) {
	// 文件表桩：88=alice 的 source=upload 文件；99=source=message（转发复用路径）
	ownerOf := map[int64]int64{88: 10001, 99: 0}
	sourceOf := map[int64]string{88: "upload", 99: "message"}
	var marked []int64
	opts := Options{
		FileCheck: func(ctx context.Context, senderID int64, fileID int64) error {
			src, ok := sourceOf[fileID]
			if !ok {
				return errx.New(errx.CodeFileNotFound, "文件不存在")
			}
			if src != "message" && ownerOf[fileID] != senderID {
				return errx.New(errx.CodePermACLDenied, "仅 owner 可发送该文件")
			}
			return nil
		},
		FileMarkSent: func(ctx context.Context, fileID int64, convID int64, msgSeq int64) error {
			marked = append(marked, fileID)
			return nil
		},
	}
	svc, _, _ := seedFixture(t, opts)
	ctx := context.Background()

	// owner 发送 image：成功 + MarkSent 回填 conv
	res, err := svc.Send(ctx, 10001, filePayload(1, "f-1", "image", "88", nil))
	if err != nil {
		t.Fatalf("owner 发送 image: %v", err)
	}
	if res.Seq == 0 {
		t.Fatalf("应有服务端 seq: %+v", res)
	}
	if len(marked) != 1 || marked[0] != 88 {
		t.Fatalf("MarkSent 应回填: %v", marked)
	}
	// bob 发送他人 source=upload 文件 → 2003
	if _, err := svc.Send(ctx, 10002, filePayload(1, "f-2", "file", "88", nil)); errx.From(err).Code != errx.CodePermACLDenied {
		t.Fatalf("非 owner 发送应拒 2003: %v", err)
	}
	// 不存在 → 4005
	if _, err := svc.Send(ctx, 10001, filePayload(1, "f-3", "file", "404", nil)); errx.From(err).Code != errx.CodeFileNotFound {
		t.Fatalf("不存在应拒 4005: %v", err)
	}
	// source=message：bob 转发复用成功
	if _, err := svc.Send(ctx, 10002, filePayload(1, "f-4", "file", "99", nil)); err != nil {
		t.Fatalf("转发复用应放行: %v", err)
	}
	// body 缺 file_id → 9001
	bad := messageapi.SendPayload{ConvID: "1", ClientMsgID: "f-5", Type: "file", Body: json.RawMessage(`{"name":"x"}`)}
	if _, err := svc.Send(ctx, 10001, bad); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("缺 file_id 应拒 9001: %v", err)
	}
	// file_id 数字形态兼容（旧端/测试）
	if _, err := svc.Send(ctx, 10001, filePayload(1, "f-6", "file", "99", nil)); err != nil {
		t.Fatalf("字符串 file_id 应可发: %v", err)
	}
	// body 透传：msg.new 原样携带宽高等元数据
	bodyExtra := map[string]any{"width": 7, "height": 5}
	_, err = svc.Send(ctx, 10001, filePayload(1, "f-7", "image", "88", bodyExtra))
	if err != nil {
		t.Fatalf("携带宽高发送: %v", err)
	}
	msgs, _ := svc.ListMessages(ctx, 1, 0, 0, 100)
	found := false
	for _, m := range msgs {
		if m.ClientMsgID == "f-7" {
			found = true
			var b map[string]any
			_ = json.Unmarshal(m.Body, &b)
			if b["file_id"] != "88" || b["width"].(float64) != 7 {
				t.Fatalf("body 透传不符: %s", m.Body)
			}
		}
	}
	if !found {
		t.Fatal("f-7 应已落库")
	}
}

// TestSendVoiceValidation audio_clip：duration_ms 1s~60s 窗口 + file_id 校验同 file
func TestSendVoiceValidation(t *testing.T) {
	opts := Options{
		FileCheck: func(ctx context.Context, senderID int64, fileID int64) error {
			if fileID != 88 {
				return errx.New(errx.CodeFileNotFound, "文件不存在")
			}
			return nil
		},
	}
	svc, _, _ := seedFixture(t, opts)
	ctx := context.Background()

	// 正常 5s 语音 → 放行且 body 透传 duration_ms
	if _, err := svc.Send(ctx, 10001, filePayload(1, "v-1", "audio_clip", "88", map[string]any{"duration_ms": 5000})); err != nil {
		t.Fatalf("5s 语音应放行: %v", err)
	}
	// 超 60s → 9001
	if _, err := svc.Send(ctx, 10001, filePayload(1, "v-2", "audio_clip", "88", map[string]any{"duration_ms": 61000})); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("超 60s 应拒 9001: %v", err)
	}
	// 缺 duration_ms → 9001
	if _, err := svc.Send(ctx, 10001, filePayload(1, "v-3", "audio_clip", "88", nil)); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("缺 duration_ms 应拒 9001: %v", err)
	}
	// 文件不存在 → 4005（FileCheck 链路同 file）
	if _, err := svc.Send(ctx, 10001, filePayload(1, "v-4", "audio_clip", "404", map[string]any{"duration_ms": 3000})); errx.From(err).Code != errx.CodeFileNotFound {
		t.Fatalf("文件不存在应拒 4005: %v", err)
	}
}

// TestSendVideoAndCaption video 时长上限 + image caption 上限（04 §1.2 第 5/8 类）
func TestSendVideoAndCaption(t *testing.T) {
	opts := Options{
		FileCheck: func(ctx context.Context, senderID int64, fileID int64) error {
			if fileID != 88 {
				return errx.New(errx.CodeFileNotFound, "文件不存在")
			}
			return nil
		},
	}
	svc, _, _ := seedFixture(t, opts)
	ctx := context.Background()

	// 正常视频（带 poster/duration）→ 放行
	if _, err := svc.Send(ctx, 10001, filePayload(1, "vd-1", "video", "88", map[string]any{"duration_ms": 30000, "poster_file_id": "77"})); err != nil {
		t.Fatalf("正常视频应放行: %v", err)
	}
	// duration 缺省放行（客户端元数据采集失败可无）
	if _, err := svc.Send(ctx, 10001, filePayload(1, "vd-2", "video", "88", nil)); err != nil {
		t.Fatalf("无 duration 视频应放行: %v", err)
	}
	// 超 10min → 9001
	if _, err := svc.Send(ctx, 10001, filePayload(1, "vd-3", "video", "88", map[string]any{"duration_ms": 600001})); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("超 10min 应拒 9001: %v", err)
	}
	// image caption 正常 → 放行
	if _, err := svc.Send(ctx, 10001, filePayload(1, "cap-1", "image", "88", map[string]any{"caption": "周会白板"})); err != nil {
		t.Fatalf("caption 图片应放行: %v", err)
	}
	// caption 超 500 字 → 9001
	long := strings.Repeat("字", 501)
	if _, err := svc.Send(ctx, 10001, filePayload(1, "cap-2", "image", "88", map[string]any{"caption": long})); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("超长 caption 应拒 9001: %v", err)
	}
}

// TestSendFileCheckNil FileCheck 未注入（text-only 部署）：跳过校验直接发送成功
func TestSendFileCheckNil(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()
	if _, err := svc.Send(ctx, 10001, filePayload(1, "fn-1", "file", "88", nil)); err != nil {
		t.Fatalf("未注入校验应放行: %v", err)
	}
}
