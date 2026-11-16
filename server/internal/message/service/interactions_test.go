// 新交互用例（D03 §4）：编辑/撤回/表情回应/正在输入/会话态/转发/引用快照。
package messageservice

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/baobaochat/server/internal/message/api"
	messagerepo "github.com/baobaochat/server/internal/message/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/eventbus"
)

// sendText 便捷构造：alice → conv1 发 text
func sendText(t *testing.T, svc *Service, conv int64, cmid, text string) *messageapi.SendResult {
	t.Helper()
	res, err := svc.Send(context.Background(), 10001, textPayload(conv, cmid, text))
	if err != nil {
		t.Fatalf("send %s: %v", cmid, err)
	}
	return res
}

func TestEditOwnTextWithinWindow(t *testing.T) {
	fixed := time.UnixMilli(1760000000000)
	svc, _, bus := seedFixture(t, Options{Now: func() time.Time { return fixed }})
	editedEvents := countEvents(bus, eventbus.TopicMsgEdited)
	ctx := context.Background()

	res := sendText(t, svc, 1, "e-1", "初版")
	// 窗口内编辑
	edited, err := svc.Edit(ctx, 10001, res.MsgID, "改后（v2）")
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	if edited.EditVersion != 2 || edited.EditedAt == 0 {
		t.Fatalf("edit_version 应为 2: %+v", edited)
	}
	// 事件扇出（msg.edited → gateway 推 msg.updated）
	if got := editedEvents(); got != 1 {
		t.Fatalf("msg.edited 事件数=%d want 1", got)
	}
	// 落库生效：历史里 body 已更新且 status=edited
	msgs, _ := svc.ListMessages(ctx, 1, 0, 0, 20)
	if msgs[0].Status != messageapi.MsgEdited {
		t.Fatalf("status 应为 edited: %d", msgs[0].Status)
	}
	var tb textBody
	_ = json.Unmarshal(msgs[0].Body, &tb)
	if tb.Text != "改后（v2）" {
		t.Fatalf("body 未更新: %s", tb.Text)
	}
}

func TestEditRejected(t *testing.T) {
	base := time.UnixMilli(1760000000000)
	svc, _, _ := seedFixture(t, Options{Now: func() time.Time { return base }})
	ctx := context.Background()

	res := sendText(t, svc, 1, "r-1", "hi")
	// 他人编辑 → 3009
	if _, err := svc.Edit(ctx, 10002, res.MsgID, "x"); errx.From(err).Code != errx.CodeIMNotMessageOwner {
		t.Fatalf("他人编辑应 3009: %v", err)
	}
	// 超窗（6min 后）→ 3008
	svc.opts.Now = func() time.Time { return base.Add(6 * time.Minute) }
	if _, err := svc.Edit(ctx, 10001, res.MsgID, "x"); errx.From(err).Code != errx.CodeIMEditWindowPassed {
		t.Fatalf("超窗编辑应 3008: %v", err)
	}
}

func TestRecallWithin24hAndIdempotent(t *testing.T) {
	base := time.UnixMilli(1760000000000)
	svc, _, bus := seedFixture(t, Options{Now: func() time.Time { return base }})
	recallEvents := countEvents(bus, eventbus.TopicMsgRecalled)
	ctx := context.Background()

	res := sendText(t, svc, 1, "rc-1", "待撤回")
	// 他人撤回 → 3009
	if _, err := svc.Recall(ctx, 10002, res.MsgID, ""); errx.From(err).Code != errx.CodeIMNotMessageOwner {
		t.Fatalf("他人撤回应 3009: %v", err)
	}
	// 23h 内可撤
	svc.opts.Now = func() time.Time { return base.Add(23 * time.Hour) }
	rr, err := svc.Recall(ctx, 10001, res.MsgID, "")
	if err != nil || rr.Status != messageapi.MsgRecalled {
		t.Fatalf("recall: %v %+v", err, rr)
	}
	// 幂等：二次撤回不报错、不重复落库
	if _, err := svc.Recall(ctx, 10001, res.MsgID, ""); err != nil {
		t.Fatalf("重复撤回应幂等: %v", err)
	}
	if got := recallEvents(); got != 2 {
		t.Fatalf("msg.recalled 事件数=%d want 2（首撤+幂等补发占位）", got)
	}
	// 摘要文案：会话列表 digest=撤回了一条消息
	convs, _ := svc.ListUserConversations(ctx, 10001)
	if convs[0].LastMsgDigest != "撤回了一条消息" {
		t.Fatalf("digest=%q", convs[0].LastMsgDigest)
	}
	// 超窗（25h）新消息 → 3003
	res2 := sendText(t, svc, 1, "rc-2", "二条")
	svc.opts.Now = func() time.Time { return base.Add(49 * time.Hour) }
	if _, err := svc.Recall(ctx, 10001, res2.MsgID, ""); errx.From(err).Code != errx.CodeIMRecallTimeout {
		t.Fatalf("超窗撤回应 3003: %v", err)
	}
}

func TestReactionAddRemoveSnapshot(t *testing.T) {
	svc, _, bus := seedFixture(t, Options{})
	rxEvents := countEvents(bus, eventbus.TopicMsgReaction)
	ctx := context.Background()

	res := sendText(t, svc, 1, "rx-1", "点个赞")
	mid := fmt.Sprintf("%d", res.MsgID)
	add := func(uid int64, emoji string) *messageapi.ReactionResult {
		t.Helper()
		r, err := svc.ReactionSet(ctx, uid, messageapi.ReactionSetPayload{MsgID: mid, Emoji: emoji, Action: "add"})
		if err != nil {
			t.Fatalf("reaction add: %v", err)
		}
		return r
	}
	// 同人同 emoji 幂等
	add(10001, "👍")
	add(10001, "👍")
	r := add(10002, "👍")
	if got := r.Reactions["👍"]; len(got) != 2 || got[0] != "10001" || got[1] != "10002" {
		t.Fatalf("reactions 快照=%v", got)
	}
	if got := rxEvents(); got != 3 {
		t.Fatalf("msg.reaction 事件数=%d want 3", got)
	}
	// remove 后空列表清除 key
	if _, err := svc.ReactionSet(ctx, 10002, messageapi.ReactionSetPayload{MsgID: mid, Emoji: "👍", Action: "remove"}); err != nil {
		t.Fatal(err)
	}
	msgs, _ := svc.ListMessages(ctx, 1, 0, 0, 20)
	var ext messageapi.MsgExt
	_ = json.Unmarshal(msgs[0].Ext, &ext)
	if len(ext.Reactions["👍"]) != 1 {
		t.Fatalf("remove 后快照=%v", ext.Reactions)
	}
	// 已撤回不可回应 + 非法 emoji/acion
	if _, err := svc.ReactionSet(ctx, 10001, messageapi.ReactionSetPayload{MsgID: mid, Emoji: "👍👍👍👍👍", Action: "add"}); err == nil {
		t.Fatal("超 8 字节 emoji 应拒绝")
	}
	if _, err := svc.ReactionSet(ctx, 10001, messageapi.ReactionSetPayload{MsgID: mid, Emoji: "👍", Action: "toggle"}); err == nil {
		t.Fatal("非法 action 应拒绝")
	}
}

func TestTypingRoutesToOthers(t *testing.T) {
	svc, _, bus := seedFixture(t, Options{})
	typingEvents := countEvents(bus, eventbus.TopicMsgTyping)
	// 瞬时事件：非成员拒绝（3001）
	if err := svc.Typing(context.Background(), 10003, messageapi.TypingPayload{ConvID: "1"}); errx.From(err).Code != errx.CodeIMNotInConversation {
		t.Fatalf("非成员 typing 应 3001: %v", err)
	}
	if err := svc.Typing(context.Background(), 10001, messageapi.TypingPayload{ConvID: "1"}); err != nil {
		t.Fatal(err)
	}
	if got := typingEvents(); got != 1 {
		t.Fatalf("msg.typing 事件数=%d", got)
	}
}

// TestPinnedLimit OQ-B06：置顶 30 上限——第 31 个新置顶 3023 拒绝；取消置顶不受限
func TestPinnedLimit(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{})
	ctx := context.Background()

	// fixture 的 conv1 未置顶——本测试自造 30 个置顶会话占满名额
	pin := true
	var firstPinned int64
	for i := 2; i <= 31; i++ {
		c, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvSingle, Name: fmt.Sprintf("p%d", i)})
		if err != nil {
			t.Fatal(err)
		}
		_ = r.AddMember(ctx, messagerepo.Member{ConvID: c.ID, UserID: 10001, Role: messageapi.MemberMember})
		if _, err := svc.UpdateConvState(ctx, 10001, c.ID, messageapi.ConvStatePatch{Pinned: &pin}); err != nil {
			t.Fatalf("置顶 %d: %v", i, err)
		}
		if firstPinned == 0 {
			firstPinned = c.ID
		}
	}
	// 第 31 个新置顶 → 3023
	big, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvSingle, Name: "p31"})
	if err != nil {
		t.Fatal(err)
	}
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: big.ID, UserID: 10001, Role: messageapi.MemberMember})
	if _, err := svc.UpdateConvState(ctx, 10001, big.ID, messageapi.ConvStatePatch{Pinned: &pin}); errx.From(err).Code != errx.CodeIMPinnedLimit {
		t.Fatalf("第 31 个置顶应 3023: %v", err)
	}
	// 取消一个后可再置顶
	unpin := false
	if _, err := svc.UpdateConvState(ctx, 10001, firstPinned, messageapi.ConvStatePatch{Pinned: &unpin}); err != nil {
		t.Fatalf("取消置顶: %v", err)
	}
	if _, err := svc.UpdateConvState(ctx, 10001, big.ID, messageapi.ConvStatePatch{Pinned: &pin}); err != nil {
		t.Fatalf("释放名额后置顶应通过: %v", err)
	}
}

func TestConvStatePatchAndDraftGuard(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()

	pin := true
	st, err := svc.UpdateConvState(ctx, 10001, 1, messageapi.ConvStatePatch{Pinned: &pin})
	if err != nil || !st.Pinned {
		t.Fatalf("pin: %v %+v", err, st)
	}
	// 重复置顶幂等（已在置顶不计入增量）
	if _, err := svc.UpdateConvState(ctx, 10001, 1, messageapi.ConvStatePatch{Pinned: &pin}); err != nil {
		t.Fatalf("重复置顶应幂等: %v", err)
	}
	// 草稿超限 3020
	long := strings.Repeat("草", 2001)
	if _, err := svc.UpdateConvState(ctx, 10001, 1, messageapi.ConvStatePatch{Draft: &long}); errx.From(err).Code != errx.CodeIMDraftTooLong {
		t.Fatalf("草稿超限应 3020: %v", err)
	}
	// 草稿在会话列表摘要优先展示（[草稿] 前缀，D03 §3.1）
	draft := "写到一半的话"
	if _, err := svc.UpdateConvState(ctx, 10001, 1, messageapi.ConvStatePatch{Draft: &draft}); err != nil {
		t.Fatal(err)
	}
	convs, _ := svc.ListUserConversations(ctx, 10001)
	// 按 ID 取 conv1（内存版等 ts 时 map 迭代序不定，避免取 [0] 的偶发漂移）
	var conv1 *messageapi.ConversationDTO
	for i := range convs {
		if convs[i].ID == "1" {
			conv1 = &convs[i]
		}
	}
	if conv1 == nil || conv1.My.Draft != draft || conv1.LastMsgDigest != "[草稿] 写到一半的话" {
		t.Fatalf("draft 态=%+v digest=%q", conv1, conv1.LastMsgDigest)
	}
	// 清草稿=空串
	empty := ""
	if _, err := svc.UpdateConvState(ctx, 10001, 1, messageapi.ConvStatePatch{Draft: &empty}); err != nil {
		t.Fatal(err)
	}
	convs, _ = svc.ListUserConversations(ctx, 10001)
	for i := range convs {
		if convs[i].ID == "1" {
			conv1 = &convs[i]
		}
	}
	if conv1 == nil || conv1.My.Draft != "" {
		t.Fatalf("清草稿失败: %+v", conv1)
	}
}

func TestForwardOneByOneAndMerge(t *testing.T) {
	svc, r, _ := seedFixture(t, Options{})
	ctx := context.Background()

	r1 := sendText(t, svc, 1, "f-1", "转发我")
	r2 := sendText(t, svc, 1, "f-2", "也转发我")
	// 第二个会话：bob+alice+carol 群（目标；carol 不在来源会话，用于逐条失败场景）
	c2, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvGroup, Name: "目标群"})
	if err != nil {
		t.Fatal(err)
	}
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: c2.ID, UserID: 10001})
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: c2.ID, UserID: 10002})
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: c2.ID, UserID: 10004})

	p := messageapi.ForwardPayload{
		TargetConvID: messageapi.ConvID(fmt.Sprintf("%d", c2.ID)),
		MsgIDs:       []string{fmt.Sprintf("%d", r1.MsgID), fmt.Sprintf("%d", r2.MsgID)},
		Mode:         "one_by_one",
	}
	res, err := svc.Forward(ctx, 10001, p)
	if err != nil {
		t.Fatalf("forward: %v", err)
	}
	if res.SentCount != 2 || len(res.Failed) != 0 {
		t.Fatalf("sent=%d failed=%v", res.SentCount, res.Failed)
	}
	msgs, _ := svc.ListMessages(ctx, c2.ID, 0, 0, 20)
	if len(msgs) != 2 || msgs[0].Type != "text" {
		t.Fatalf("转发落库=%+v", msgs)
	}
	// 来源不可见：carol（10004）在目标群但不在来源会话 → 逐条 failed 3001 不上抛
	res2, err := svc.Forward(ctx, 10004, p)
	if err != nil {
		t.Fatalf("forward 应逐条失败不上抛: %v", err)
	}
	if res2.SentCount != 0 || len(res2.Failed) != 2 || res2.Failed[0].Code != 3001 {
		t.Fatalf("来源不可见转发 failed=%v", res2.Failed)
	}
	// merge 模式：单条 merge_forward 消息（附言+合并=2 条）
	res3, err := svc.Forward(ctx, 10001, messageapi.ForwardPayload{
		TargetConvID: p.TargetConvID, MsgIDs: p.MsgIDs, Mode: "merge", Note: "看这个",
	})
	if err != nil || res3.SentCount != 2 {
		t.Fatalf("merge: %v %+v", err, res3)
	}
	msgs2, _ := svc.ListMessages(ctx, c2.ID, 0, 0, 100)
	last := msgs2[len(msgs2)-1]
	if last.Type != "merge_forward" {
		t.Fatalf("merge 类型=%s", last.Type)
	}
	var body struct {
		Count int              `json:"count"`
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(last.Body, &body)
	if body.Count != 2 || len(body.Items) != 2 {
		t.Fatalf("merge body=%s", last.Body)
	}
	// 超限 3021
	var many []string
	for i := 0; i < 31; i++ {
		many = append(many, fmt.Sprintf("%d", r1.MsgID))
	}
	if _, err := svc.Forward(ctx, 10001, messageapi.ForwardPayload{TargetConvID: p.TargetConvID, MsgIDs: many, Mode: "merge"}); errx.From(err).Code != errx.CodeIMMergeForwardLimit {
		t.Fatalf("超限应 3021: %v", err)
	}
}

func TestSendBuildsReplyDigest(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()

	orig := sendText(t, svc, 1, "q-1", "被引用的原消息内容比较长需要截断一下哦")
	body, _ := json.Marshal(map[string]string{"text": "回复你"})
	res, err := svc.Send(ctx, 10002, messageapi.SendPayload{
		ConvID: "1", ClientMsgID: "q-2", Type: "text", Body: body, ReplyToSeq: orig.Seq,
	})
	if err != nil {
		t.Fatal(err)
	}
	msgs, _ := svc.ListMessages(ctx, 1, 0, 0, 20)
	var ext messageapi.MsgExt
	if err := json.Unmarshal(msgs[1].Ext, &ext); err != nil || ext.ReplyDigest == nil {
		t.Fatalf("ext.reply_digest 缺失: %s err=%v", msgs[1].Ext, err)
	}
	d := ext.ReplyDigest
	if d.Seq != orig.Seq || d.SenderID != "10001" || d.Digest != "被引用的原消息内容比较长需要截断一下哦" {
		t.Fatalf("reply_digest=%+v", d)
	}
	// 撤回源消息后新引用 → 固定文案
	if _, err := svc.Recall(ctx, 10001, orig.MsgID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Send(ctx, 10002, messageapi.SendPayload{
		ConvID: "1", ClientMsgID: "q-3", Type: "text", Body: body, ReplyToSeq: orig.Seq,
	}); err != nil {
		t.Fatal(err)
	}
	msgs, _ = svc.ListMessages(ctx, 1, 0, 0, 20)
	var ext2 messageapi.MsgExt
	_ = json.Unmarshal(msgs[2].Ext, &ext2)
	if ext2.ReplyDigest.Digest != "原消息已撤回" {
		t.Fatalf("撤回后 digest=%q", ext2.ReplyDigest.Digest)
	}
	_ = res
	// 不存在的引用 seq → 3018
	if _, err := svc.Send(ctx, 10002, messageapi.SendPayload{
		ConvID: "1", ClientMsgID: "q-4", Type: "text", Body: body, ReplyToSeq: 999,
	}); errx.From(err).Code != errx.CodeIMInvalidCursor {
		t.Fatalf("幽灵引用应 3018: %v", err)
	}
}

// countEvents 订阅计数探针：装配期注册，返回读取函数（总线分发为同步，计数即时可见）
func countEvents(bus *eventbus.InMemory, topic string) func() int {
	var n int
	bus.Subscribe(topic, func(_ context.Context, _ eventbus.Event) error {
		n++
		return nil
	})
	return func() int { return n }
}

func TestSyncIncremental(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()
	// bob 视角：seq 1-3 落库，bob 已读到 1
	for i := 1; i <= 3; i++ {
		_ = sendText(t, svc, 1, fmt.Sprintf("sy-%d", i), fmt.Sprintf("消息%d", i))
	}
	_, _ = svc.MarkRead(ctx, 10002, messageapi.ReadPayload{ConvID: "1", ReadSeq: 1})
	// 游标=1 → 增量 2,3
	res, err := svc.Sync(ctx, 10002, map[string]int64{"1": 1}, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Convs) != 1 || len(res.Convs[0].Messages) != 2 || res.Convs[0].Messages[0].Seq != 2 {
		t.Fatalf("sync 增量=%+v", res.Convs[0])
	}
	if res.Convs[0].Unread != 2 || res.Badges.TotalUnread != 2 {
		t.Fatalf("unread=%d total=%d", res.Convs[0].Unread, res.Badges.TotalUnread)
	}
	// 游标=latest → 无消息体
	res2, _ := svc.Sync(ctx, 10002, map[string]int64{"1": 3}, 200)
	if len(res2.Convs[0].Messages) != 0 {
		t.Fatalf("最新游标不应带货: %+v", res2.Convs[0].Messages)
	}
	// 非成员会话不下发；非法游标 3018
	if res3, _ := svc.Sync(ctx, 10003, map[string]int64{"1": 0}, 200); len(res3.Convs) != 0 {
		t.Fatalf("非成员 sync=%+v", res3.Convs)
	}
	if _, err := svc.Sync(ctx, 10002, map[string]int64{"1": -1}, 200); errx.From(err).Code != errx.CodeIMInvalidCursor {
		t.Fatalf("负游标应 3018: %v", err)
	}
	// gap：limit=1 时缺口标记
	res4, _ := svc.Sync(ctx, 10002, map[string]int64{"1": 0}, 1)
	if !res4.Convs[0].Gap || len(res4.Convs[0].Messages) != 1 {
		t.Fatalf("gap 语义=%+v", res4.Convs[0])
	}
}
