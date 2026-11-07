package rtc

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	errx "github.com/baobaowork/server/internal/platform/errors"
	rtcapi "github.com/baobaowork/server/internal/rtc/api"
)

// fakePush 测试推送桩：记录 (目标集, type, body)
type fakePush struct {
	mu     sync.Mutex
	pushes []struct {
		users []int64
		typ   string
		body  string
	}
}

func (f *fakePush) PushRTC(users []int64, typ string, payload any) int {
	b, _ := json.Marshal(payload)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pushes = append(f.pushes, struct {
		users []int64
		typ   string
		body  string
	}{append([]int64(nil), users...), typ, string(b)})
	return len(users)
}

// of 取指定 type 的全部推送 body（调试/断言用）
func (f *fakePush) of(typ string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, p := range f.pushes {
		if p.typ == typ {
			out = append(out, p.body)
		}
	}
	return out
}

// fakeCard 测试卡片桩
type fakeCard struct {
	mu     sync.Mutex
	sent   []string // clientMsgID 序列
	finish int
	lastFn string
}

func (f *fakeCard) SendCard(_ context.Context, _, _ int64, clientMsgID string, _ json.RawMessage) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, clientMsgID)
	return int64(100 + len(f.sent))
}

func (f *fakeCard) FinishCard(_ context.Context, _ int64, body json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finish++
	f.lastFn = string(body)
}

// newTestService 内存会话：conv=1 成员 alice(10001)/bob(10002)；时钟注入固定值
func newTestService(ring time.Duration) (*Service, *fakePush, *fakeCard) {
	p := &fakePush{}
	card := &fakeCard{}
	members := map[int64]bool{10001: true, 10002: true}
	svc := New(NewRegistry(), p, card, Options{
		// conv=1/2 均可用（5004 忙线用例需另一会话绕开 5009 同会话优先判定）
		IsConvActive: func(_ context.Context, convID int64) bool { return convID == 1 || convID == 2 },
		IsConvMember: func(_ context.Context, _, uid int64) bool { return members[uid] },
		NameOf:       func(id int64) string { return "user-" + strconv.FormatInt(id, 10) },
		RingTimeout:  ring,
		Now:          func() time.Time { return time.UnixMilli(1760000000000) },
	})
	return svc, p, card
}

func inviteP(callID string) rtcapi.InvitePayload {
	return rtcapi.InvitePayload{CallID: callID, ConvID: "1", CalleeID: "10002", CallType: rtcapi.CallTypeVideo}
}

// codeOf 错误码断言辅助
func codeOf(t *testing.T, err error) int {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误但为 nil")
	}
	return int(errx.From(err).Code)
}

// 全信令流：invite → ringing 推送/落卡 → accept → connecting/answered_elsewhere
// → signal 透传+connected → bye → ended(duration) + 卡片回写 + 5010 兜底
func TestSignalFlowFull(t *testing.T) {
	svc, push, card := newTestService(time.Hour)
	ctx := context.Background()

	ack, err := svc.Invite(ctx, 10001, inviteP("ca-1"))
	if err != nil || ack.CallID != "ca-1" {
		t.Fatalf("invite: %+v %v", ack, err)
	}
	// 推送序列：主叫 dialing+ringing、被叫 rtc.ringing；卡片落流
	if n := len(push.of("rtc.ringing")); n != 1 {
		t.Fatalf("应推 1 次 rtc.ringing: %d", n)
	}
	if n := len(push.of("rtc.state")); n != 2 {
		t.Fatalf("invite 后应推 2 次 rtc.state(dialing/ringing): %d", n)
	}
	if len(card.sent) != 1 || card.sent[0] != "callcard-ca-1" {
		t.Fatalf("应落 1 张 call_card: %v", card.sent)
	}

	// 被叫接听：主叫 connecting + 被叫多端 answered_elsewhere(did)
	if err := svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "ca-1", Answer: true, DID: "d1"}); err != nil {
		t.Fatalf("accept: %v", err)
	}
	var connecting, elsewhere bool
	for _, s := range push.of("rtc.state") {
		if strings.Contains(s, `"kind":"connecting"`) {
			connecting = true
		}
		if strings.Contains(s, `"kind":"answered_elsewhere"`) && strings.Contains(s, `"did":"d1"`) {
			elsewhere = true
		}
	}
	if !connecting || !elsewhere {
		t.Fatalf("accept 后缺 connecting/answered_elsewhere: %v", push.of("rtc.state"))
	}

	// 主叫发 offer：透传给被叫 + connecting→connected（首帧近似）
	if err := svc.Signal(ctx, 10001, rtcapi.SignalPayload{
		CallID: "ca-1", Data: map[string]any{"kind": "sdp", "type": "offer", "sdp": "v=0"},
	}); err != nil {
		t.Fatalf("signal: %v", err)
	}
	if n := len(push.of("rtc.signal")); n != 1 {
		t.Fatalf("应转发 1 次 rtc.signal: %d", n)
	}
	if !hasKind(push.of("rtc.state"), "connected") {
		t.Fatalf("首帧 signal 应触发 connected 推送")
	}

	// 第二帧（被叫 answer）：仍透传、不重复 connected
	_ = svc.Signal(ctx, 10002, rtcapi.SignalPayload{CallID: "ca-1", Data: map[string]any{"kind": "candidate"}})
	if n := len(push.of("rtc.signal")); n != 2 {
		t.Fatalf("第二帧应仍透传: %d", n)
	}
	if cnt := countKind(push.of("rtc.state"), "connected"); cnt != 1 {
		t.Fatalf("connected 只应推一次: %d", cnt)
	}

	// 挂断：ended(bye)+duration+卡片回写
	if err := svc.Bye(ctx, 10001, rtcapi.CallIDPayload{CallID: "ca-1"}); err != nil {
		t.Fatalf("bye: %v", err)
	}
	var ended string
	for _, s := range push.of("rtc.state") {
		if strings.Contains(s, `"kind":"ended"`) && strings.Contains(s, `"reason":"bye"`) {
			ended = s
		}
	}
	if ended == "" {
		t.Fatalf("应推 ended(bye): %v", push.of("rtc.state"))
	}
	if card.finish != 1 || !strings.Contains(card.lastFn, `"status":"ended"`) {
		t.Fatalf("卡片应回写 ended: fin=%d %s", card.finish, card.lastFn)
	}
	// 结束后再 bye → 5010
	if code := codeOf(t, svc.Bye(ctx, 10001, rtcapi.CallIDPayload{CallID: "ca-1"})); code != 5010 {
		t.Fatalf("结束后 bye 应 5010: %d", code)
	}
}

func hasKind(bodies []string, kind string) bool { return countKind(bodies, kind) > 0 }

func countKind(bodies []string, kind string) int {
	n := 0
	for _, s := range bodies {
		if strings.Contains(s, `"kind":"`+kind+`"`) {
			n++
		}
	}
	return n
}

// 主叫取消：canceled 终态 + 卡片回写；被叫不能取消（5011）
func TestCancelFlow(t *testing.T) {
	svc, push, card := newTestService(time.Hour)
	ctx := context.Background()
	if _, err := svc.Invite(ctx, 10001, inviteP("ca-2")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Cancel(ctx, 10001, rtcapi.CallIDPayload{CallID: "ca-2"}); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if !hasReason(push.of("rtc.state"), "canceled") || card.finish != 1 {
		t.Fatalf("cancel 应推 ended(canceled)+回写卡片")
	}
	if _, err := svc.Invite(ctx, 10001, inviteP("ca-2b")); err != nil {
		t.Fatal(err)
	}
	if code := codeOf(t, svc.Cancel(ctx, 10002, rtcapi.CallIDPayload{CallID: "ca-2b"})); code != 5011 {
		t.Fatalf("被叫取消应 5011: %d", code)
	}
}

func hasReason(bodies []string, reason string) bool {
	for _, s := range bodies {
		if strings.Contains(s, `"reason":"`+reason+`"`) {
			return true
		}
	}
	return false
}

// 被叫拒接：declined；accept(answer=false) 同义
func TestRejectFlow(t *testing.T) {
	svc, push, card := newTestService(time.Hour)
	ctx := context.Background()
	if _, err := svc.Invite(ctx, 10001, inviteP("ca-3")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Reject(ctx, 10002, rtcapi.RejectPayload{CallID: "ca-3"}); err != nil {
		t.Fatalf("reject: %v", err)
	}
	if !hasReason(push.of("rtc.state"), "declined") || card.finish != 1 {
		t.Fatalf("reject 应推 ended(declined)+回写卡片")
	}

	// answer=false 视同拒接
	if _, err := svc.Invite(ctx, 10001, inviteP("ca-3b")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "ca-3b", Answer: false}); err != nil {
		t.Fatalf("accept(false): %v", err)
	}
	if !hasReason(push.of("rtc.state"), "declined") {
		t.Fatalf("accept(false) 应 declined")
	}
}

// 振铃超时（注入 1ms）：ended(timeout) + 卡片回写；超时后 accept 失败（竞态单胜者）
func TestRingTimeout(t *testing.T) {
	svc, push, card := newTestService(time.Millisecond)
	ctx := context.Background()
	if _, err := svc.Invite(ctx, 10001, inviteP("ca-4")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !hasReason(push.of("rtc.state"), "timeout") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !hasReason(push.of("rtc.state"), "timeout") {
		t.Fatalf("振铃超时应推 ended(timeout)")
	}
	if card.finish != 1 {
		t.Fatalf("超时应回写卡片: %d", card.finish)
	}
	if err := svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "ca-4", Answer: true}); err == nil {
		t.Fatalf("超时后 accept 应失败")
	}
}

// 冲突：同会话进行中 → 5009；任一方忙 → 5004；同 call_id 幂等重试回原通话
func TestInviteConflicts(t *testing.T) {
	svc, _, _ := newTestService(time.Hour)
	ctx := context.Background()
	if _, err := svc.Invite(ctx, 10001, inviteP("ca-5")); err != nil {
		t.Fatal(err)
	}
	if code := codeOf(t, func() error {
		_, err := svc.Invite(ctx, 10001, inviteP("ca-6"))
		return err
	}()); code != 5009 {
		t.Fatalf("同会话重复呼叫应 5009: %d", code)
	}
	if code := codeOf(t, func() error {
		_, err := svc.Invite(ctx, 10002, rtcapi.InvitePayload{CallID: "ca-7", ConvID: "2", CalleeID: "10001", CallType: "audio"})
		return err
	}()); code != 5004 {
		t.Fatalf("忙线应 5004: %d", code)
	}
	ack, err := svc.Invite(ctx, 10001, inviteP("ca-5"))
	if err != nil || ack.CallID != "ca-5" {
		t.Fatalf("幂等重试应回原通话: %+v %v", ack, err)
	}
}

// 参数校验：call_type 非法 5006、非成员 5011、自呼 9001、signal 超限 9001
func TestValidation(t *testing.T) {
	svc, _, _ := newTestService(time.Hour)
	ctx := context.Background()
	p := inviteP("ca-x")
	p.CallType = "screen"
	if code := codeOf(t, func() error {
		_, err := svc.Invite(ctx, 10001, p)
		return err
	}()); code != 5006 {
		t.Fatalf("call_type 非法应 5006: %d", code)
	}
	if code := codeOf(t, func() error {
		_, err := svc.Invite(ctx, 99999, inviteP("ca-y"))
		return err
	}()); code != 5011 {
		t.Fatalf("非成员应 5011: %d", code)
	}
	p2 := inviteP("ca-z")
	p2.CalleeID = "10001"
	if code := codeOf(t, func() error {
		_, err := svc.Invite(ctx, 10001, p2)
		return err
	}()); code != 9001 {
		t.Fatalf("呼叫自己应 9001: %d", code)
	}
	// signal 超限：>64KB 拒绝
	if _, err := svc.Invite(ctx, 10001, inviteP("ca-big")); err != nil {
		t.Fatal(err)
	}
	_ = svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "ca-big", Answer: true, DID: "d"})
	big := map[string]any{"kind": "sdp", "sdp": strings.Repeat("x", MaxSignalBytes)}
	if code := codeOf(t, svc.Signal(ctx, 10001, rtcapi.SignalPayload{CallID: "ca-big", Data: big})); code != 9001 {
		t.Fatalf("signal 超限应 9001: %d", code)
	}
}
