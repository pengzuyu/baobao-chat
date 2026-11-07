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

// hasState rtc.state 载荷含指定 kind（connecting/connected 等非终态推送）
func hasState(bodies []string, kind string) bool {
	for _, s := range bodies {
		if strings.Contains(s, `"kind":"`+kind+`"`) {
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

// 挂断并接听（OQ-C06 原子化）：accept 携带 bye_call_id——旧通话 ended(bye)、
// 新通话接通；单帧处理消除客户端 bye 未 ack 即 accept 的竞态窗口。
// 注：新呼到达忙线被叫（INT-RTC-16 触发路径）随 D04 阶段二（需端侧自动 busy
// 配套——服务端 userConflict 现拦主/被叫任一忙）；本用例白盒注入第二通，
// 专测服务端原子能力本身
func TestAcceptWithByeCallIDAtomic(t *testing.T) {
	svc, push, card := newTestService(time.Hour)
	ctx := context.Background()

	// alice 呼 bob（conv=1）并接通
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{CallID: "call-a", ConvID: "1", CalleeID: "10002", CallType: rtcapi.CallTypeAudio}); err != nil {
		t.Fatalf("invite A: %v", err)
	}
	if err := svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "call-a", Answer: true, DID: "d0"}); err != nil {
		t.Fatalf("accept A: %v", err)
	}
	// 白盒注入通话 B（conv=2，bob 被叫）——直接写 Registry 索引绕过 Create 的
	// 用户忙拦截（removeLocked 条件删除保证 A 结束不误清 B 的索引），
	// 模拟阶段二"通话中来电"到达后的服务端状态
	now := time.UnixMilli(1760000000000)
	callB := &Call{
		ID: "call-b", ConvID: 2, CallType: rtcapi.CallTypeAudio,
		CallerID: 10001, CalleeID: 10002,
		State: rtcapi.StateRinging, RingAt: now,
	}
	svc.reg.mu.Lock()
	svc.reg.byID["call-b"] = callB
	svc.reg.byConv[2] = callB
	svc.reg.byUser[10001] = map[string]*Call{"call-b": callB}
	svc.reg.byUser[10002] = map[string]*Call{"call-b": callB}
	svc.reg.mu.Unlock()

	// bob 挂断并接听：单帧 bye(call-a) + accept(call-b)
	if err := svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "call-b", Answer: true, DID: "d1", ByeCallID: "call-a"}); err != nil {
		t.Fatalf("挂断并接听: %v", err)
	}

	// 旧通话 A：ended(bye) + 卡片回写
	if !hasReason(push.of("rtc.state"), "bye") {
		t.Fatal("旧通话应 ended(bye)")
	}
	if card.finish != 1 {
		t.Fatalf("旧通话卡片应回写 ended: %+v", card)
	}
	// 新通话 B：connecting（接通链路照常）
	if !hasState(push.of("rtc.state"), "connecting") {
		t.Fatal("新通话应进入 connecting")
	}

	// bye_call_id 指向已结束通话：尽力挂断容忍，接听不受阻
	callC := &Call{
		ID: "call-c", ConvID: 2, CallType: rtcapi.CallTypeAudio,
		CallerID: 10001, CalleeID: 10002,
		State: rtcapi.StateRinging, RingAt: now,
	}
	svc.reg.mu.Lock()
	svc.reg.byID["call-c"] = callC
	svc.reg.byConv[2] = callC
	svc.reg.mu.Unlock()
	if err := svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "call-c", Answer: true, ByeCallID: "call-a"}); err != nil {
		t.Fatalf("旧通话已结束时挂断并接听应容忍: %v", err)
	}
}

// all_left（OQ-C05）：枚举预登记——常量可引用且不与既有 reason 冲突
// （产生场景=群通话全员退出，随 D04 阶段二；1v1 由 bye 覆盖）
func TestAllLeftReasonRegistered(t *testing.T) {
	if rtcapi.ReasonAllLeft != "all_left" {
		t.Fatalf("all_left 常量: %q", rtcapi.ReasonAllLeft)
	}
}

// ---------------------------------------------------------------------------
// 群通话阶段二（05 §4.1 join 模式 / §7.4 all_left / OQ-C06 被叫忙放行）
// ---------------------------------------------------------------------------

// newGroupSvc 三人群呼测试装配（conv=9：alice/bob/carol）
func newGroupSvc(allLeft time.Duration) (*Service, *fakePush, *fakeCard) {
	p := &fakePush{}
	card := &fakeCard{}
	members := map[int64]bool{10001: true, 10002: true, 10003: true}
	svc := New(NewRegistry(), p, card, Options{
		IsConvActive:    func(_ context.Context, convID int64) bool { return convID == 9 },
		IsConvMember:    func(_ context.Context, _, uid int64) bool { return members[uid] },
		ConvMembersOf:   func(_ context.Context, _ int64) []int64 { return []int64{10001, 10002, 10003} },
		NameOf:          func(id int64) string { return "user-" + strconv.FormatInt(id, 10) },
		RingTimeout:     time.Hour,
		AllLeftWindow:   allLeft,
		AllowBusyCallee: true,
		Now:             func() time.Time { return time.UnixMilli(1760000000000) },
	})
	return svc, p, card
}

func groupInviteP(callID string) rtcapi.InvitePayload {
	return rtcapi.InvitePayload{CallID: callID, ConvID: "9", CallType: rtcapi.CallTypeAudio} // 无 callee=群呼
}

// 群呼发起：全员 ringing(group=true，除主叫) + 主叫即参与者 + connecting
func TestGroupInviteFanoutRinging(t *testing.T) {
	svc, push, card := newGroupSvc(time.Hour)
	ack, err := svc.Invite(context.Background(), 10001, groupInviteP("g-1"))
	if err != nil {
		t.Fatal(err)
	}
	if ack.CallID != "g-1" {
		t.Fatal(ack)
	}
	// 群 ringing 一次推送扇出两被叫（fakePush 按调用记录；users 数组断言）
	rang := push.of("rtc.ringing")
	if len(rang) != 1 || !strings.Contains(rang[0], `"group":true`) {
		t.Fatalf("群 ringing 应一条 group 推送：%v", rang)
	}
	// 卡片落流
	if len(card.sent) != 1 {
		t.Fatalf("卡片：%v", card.sent)
	}
	// 主叫 connecting（等待首个成员 signal）
	if !hasState(push.of("rtc.state"), "connecting") {
		t.Fatal("主叫应见 connecting")
	}
	// 主叫已在参与者集（bye 可退出）
	if err := svc.Bye(context.Background(), 10001, rtcapi.CallIDPayload{CallID: "g-1"}); err != nil {
		t.Fatalf("主叫应可退出：%v", err)
	}
}

// join 全链：加入 → joined 推送 → signal 首帧 connected（全员）→ 群内转发
func TestGroupJoinAndSignal(t *testing.T) {
	svc, push, _ := newGroupSvc(time.Hour)
	ctx := context.Background()
	if _, err := svc.Invite(ctx, 10001, groupInviteP("g-2")); err != nil {
		t.Fatal(err)
	}
	// 非 1v1：accept 群呼被拒
	if code := codeOf(t, svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "g-2", Answer: true})); code != 9001 {
		t.Fatalf("群呼 accept 应 9001：%d", code)
	}
	if err := svc.Join(ctx, 10002, rtcapi.JoinPayload{CallID: "g-2", DID: "d-b"}); err != nil {
		t.Fatal(err)
	}
	if !hasState(push.of("rtc.state"), "joined") {
		t.Fatal("应推 joined")
	}
	// 非会话成员 join → 5011（members 集外 uid）
	if code := codeOf(t, svc.Join(ctx, 99999, rtcapi.JoinPayload{CallID: "g-2"})); code != 5011 {
		t.Fatalf("外人 join 应 5011：%d", code)
	}
	// bob 首帧 signal → connected 广播全员；信令转发给其他参与者
	if err := svc.Signal(ctx, 10002, rtcapi.SignalPayload{
		CallID: "g-2", Data: map[string]any{"kind": "sdp", "sdp": "x"}}); err != nil {
		t.Fatal(err)
	}
	if !hasState(push.of("rtc.state"), "connected") {
		t.Fatal("首帧 signal 应 connected")
	}
	sig := push.of("rtc.signal")
	if len(sig) != 1 || !strings.Contains(sig[0], `"from":"10002"`) {
		t.Fatalf("信令应转发其余参与者：%v", sig)
	}
	// 重复 join 幂等
	if err := svc.Join(ctx, 10002, rtcapi.JoinPayload{CallID: "g-2"}); err != nil {
		t.Fatal(err)
	}
}

// all_left：全员退出 → 窗口到点 End(all_left)+卡片；窗口内再加入复活
func TestGroupAllLeftWindow(t *testing.T) {
	svc, push, card := newGroupSvc(60 * time.Millisecond)
	ctx := context.Background()
	if _, err := svc.Invite(ctx, 10001, groupInviteP("g-3")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Join(ctx, 10002, rtcapi.JoinPayload{CallID: "g-3"}); err != nil {
		t.Fatal(err)
	}
	// carol 未加入；bob 退 → 剩主叫；主叫退 → 空 → 窗口
	if err := svc.Bye(ctx, 10002, rtcapi.CallIDPayload{CallID: "g-3"}); err != nil {
		t.Fatal(err)
	}
	if !hasState(push.of("rtc.state"), "left") {
		t.Fatal("应推 left")
	}
	if err := svc.Bye(ctx, 10001, rtcapi.CallIDPayload{CallID: "g-3"}); err != nil {
		t.Fatal(err)
	}
	// 窗口内 carol 加入 → 复活（取消 all_left）
	if err := svc.Join(ctx, 10003, rtcapi.JoinPayload{CallID: "g-3"}); err != nil {
		t.Fatalf("窗口内加入应复活：%v", err)
	}
	time.Sleep(120 * time.Millisecond) // 窗口已取消：不应结束
	if hasReason(push.of("rtc.state"), "all_left") {
		t.Fatal("复活后不应 all_left")
	}
	// carol 再退 → 空窗口 → 到点 all_left + 卡片回写
	if err := svc.Bye(ctx, 10003, rtcapi.CallIDPayload{CallID: "g-3"}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	if !hasReason(push.of("rtc.state"), rtcapi.ReasonAllLeft) {
		t.Fatal("全员退出窗口到点应 all_left")
	}
	if card.finish != 1 {
		t.Fatalf("卡片应回写 ended：%+v", card)
	}
	// 结束后 join → 5010
	if code := codeOf(t, svc.Join(ctx, 10002, rtcapi.JoinPayload{CallID: "g-3"})); code != 5010 {
		t.Fatalf("结束后 join 应 5010：%d", code)
	}
}

// 通话中追加被叫：existed 群呼 + 指定 callee → 仅该被叫 ringing
func TestGroupInviteExtraCallee(t *testing.T) {
	svc, push, _ := newGroupSvc(time.Hour)
	_ = push // 首轮推送后清零复用
	ctx := context.Background()
	if _, err := svc.Invite(ctx, 10001, groupInviteP("g-4")); err != nil {
		t.Fatal(err)
	}
	push.mu.Lock()
	push.pushes = nil // 清首轮
	push.mu.Unlock()
	ack, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{
		CallID: "g-4", ConvID: "9", CalleeID: "10002", CallType: rtcapi.CallTypeAudio})
	if err != nil || ack.CallID != "g-4" {
		t.Fatalf("追加被叫：%v", err)
	}
	// 仅新增被叫收到 ringing（users 断言——payload 不含被叫 uid）
	push.mu.Lock()
	var targets []int64
	for _, pr := range push.pushes {
		if pr.typ == "rtc.ringing" {
			targets = pr.users
		}
	}
	push.mu.Unlock()
	if len(targets) != 1 || targets[0] != 10002 {
		t.Fatalf("应仅推新增被叫 10002：%v", targets)
	}
	// 非参与者不可追加
	_, extraErr := svc.Invite(ctx, 10003, rtcapi.InvitePayload{
		CallID: "g-4", ConvID: "9", CalleeID: "10002", CallType: rtcapi.CallTypeAudio})
	if code := codeOf(t, extraErr); code != 5011 {
		t.Fatalf("非参与者追加应 5011：%d", code)
	}
}

// 被叫忙放行（OQ-C06）：B 在 1v1 中 A 呼 B → ringing 送达 + 主叫收 busy 提示；
// 主叫忙恒拦
func TestInviteBusyCalleeAllowed(t *testing.T) {
	svc, _, _ := newGroupSvc(time.Hour)
	ctx := context.Background()
	// conv=9 内先建 1v1：alice→bob（占线）
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{
		CallID: "b-1", ConvID: "9", CalleeID: "10002", CallType: rtcapi.CallTypeAudio}); err != nil {
		t.Fatal(err)
	}
	// 同会话第二通 1v1 会先撞 5009（conv 互斥）——被叫忙放行验证需另一会话：
	// 本测试装配仅 conv=9，改用群呼与 1v1 并存验证 byUser 多值：carol 发起群呼
	// （carol 空闲、conv=9 已有通话 → 5009）。故被叫忙放行路径在 conv=9 内
	// 无法与 conv 互斥解耦——单独装配验证：
	p2 := &fakePush{}
	c2 := &fakeCard{}
	svc2 := New(NewRegistry(), p2, c2, Options{
		IsConvActive: func(_ context.Context, convID int64) bool { return convID == 1 || convID == 2 || convID == 3 },
		IsConvMember: func(_ context.Context, _, uid int64) bool {
			return uid == 10001 || uid == 10002 || uid == 10003
		},
		NameOf:          func(id int64) string { return "u" },
		RingTimeout:     time.Hour,
		AllowBusyCallee: true,
		Now:             func() time.Time { return time.UnixMilli(1760000000000) },
	})
	// conv=1 既有 1v1（bob 被叫占线）→ conv=2 alice 再呼 bob：放行+busy 提示
	if _, err := svc2.Invite(ctx, 10001, rtcapi.InvitePayload{
		CallID: "b-occ", ConvID: "1", CalleeID: "10002", CallType: rtcapi.CallTypeAudio}); err != nil {
		t.Fatal(err)
	}
	// carol（空闲）呼 bob（被叫占线）→ 放行 + busy 提示给 carol
	ack, err := svc2.Invite(ctx, 10003, rtcapi.InvitePayload{
		CallID: "b-new", ConvID: "2", CalleeID: "10002", CallType: rtcapi.CallTypeAudio})
	if err != nil {
		t.Fatalf("被叫忙应放行：%v", err)
	}
	_ = ack
	states := p2.of("rtc.state")
	busyHint := false
	for _, s := range states {
		if strings.Contains(s, `"reason":"busy"`) {
			busyHint = true
		}
	}
	if !busyHint {
		t.Fatal("主叫应收 busy 提示")
	}
	if len(p2.of("rtc.ringing")) != 2 {
		t.Fatal("两通 ringing 均应送达")
	}
	// bob（被叫占线者）再发起呼叫：主叫忙恒拦 5004（独立 conv=3 避 5009 干扰）
	_, busyErr := svc2.Invite(ctx, 10002, rtcapi.InvitePayload{
		CallID: "b-3", ConvID: "3", CalleeID: "10001", CallType: rtcapi.CallTypeAudio})
	if code := codeOf(t, busyErr); code != 5004 {
		t.Fatalf("主叫忙应 5004：%d", code)
	}
}
