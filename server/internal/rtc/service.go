// rtc 信令服务实现（D04 阶段一务实版，docs/05 §4.1 时序裁剪）：
// 服务端纯信令——invite/cancel/accept/reject/bye/signal 六事件 + rtc.ringing/rtc.state/rtc.signal 推送；
// 媒体面 WebRTC P2P（SDP/ICE 经 rtc.signal 透传，服务端不解释不落库）。
package rtc

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	rtcapi "github.com/baobaowork/server/internal/rtc/api"

	errx "github.com/baobaowork/server/internal/platform/errors"
)

// RingTimeoutDefault 振铃超时（05 篇 §4.2 45s 收敛为 30s：内网演示节奏，登记）
const RingTimeoutDefault = 30 * time.Second

// MaxSignalBytes rtc.signal data 上限（SDP/ICE 单帧 ≤64KB，防滥用）
const MaxSignalBytes = 64 << 10

// CardSink 通话卡片落流出口（message 域实现注入；失败不影响信令主流程）
type CardSink interface {
	// SendCard invite 时落 call_card 消息（sender=主叫，client_msg_id 幂等）→ 返回 msg_id（回链）
	SendCard(ctx context.Context, senderID, convID int64, clientMsgID string, body json.RawMessage) int64
	// FinishCard 结束时 PATCH body（status=ended{duration,reason}）→ 复用 msg.updated 扇出
	FinishCard(ctx context.Context, msgID int64, body json.RawMessage)
}

// Options 装配依赖（构造注入，D02 §3）
type Options struct {
	// IsConvActive 会话存在且未解散（main 经 messagerepo 闭包注入，跨域不引包）
	IsConvActive func(ctx context.Context, convID int64) bool
	// IsConvMember 会话成员校验（caller/callee 均须在会话内，5011 判定）
	IsConvMember func(ctx context.Context, convID, userID int64) bool
	// NameOf 主叫展示名解析（rtc.ringing.caller.name）
	NameOf func(id int64) string
	// RingTimeout 振铃超时（测试可注入短时长）
	RingTimeout time.Duration
	// Now 时钟注入（测试）
	Now func() time.Time
}

func (o *Options) ringTimeout() time.Duration {
	if o.RingTimeout > 0 {
		return o.RingTimeout
	}
	return RingTimeoutDefault
}

func (o *Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// Service rtcapi.RTCService 实现
type Service struct {
	reg  *Registry
	push rtcapi.Pusher
	card CardSink
	opts Options
}

var _ rtcapi.RTCService = (*Service)(nil)

// New 构造（pusher 由 gateway hub 适配注入——进程内直调，无 eventbus，登记）
func New(reg *Registry, push rtcapi.Pusher, card CardSink, opts Options) *Service {
	return &Service{reg: reg, push: push, card: card, opts: opts}
}

// Invite 发起 1v1（D04 INT-RTC-01）：
// 校验 → 注册（5009/5004/幂等）→ 落 call_card → 推被叫 ringing + 主叫 state 链 → 振铃定时器。
func (s *Service) Invite(ctx context.Context, callerID int64, p rtcapi.InvitePayload) (*rtcapi.InviteAck, error) {
	if p.CallID == "" || p.ConvID == "" || p.CalleeID == "" {
		return nil, errx.New(errx.CodeBadRequest, "call_id/conv_id/callee_id 必填")
	}
	if p.CallType != rtcapi.CallTypeAudio && p.CallType != rtcapi.CallTypeVideo {
		return nil, errx.New(errx.CodeRTCMediaParamInvalid, "call_type 应为 audio/video")
	}
	convID, err := strconv.ParseInt(p.ConvID, 10, 64)
	if err != nil || convID <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "conv_id 非法")
	}
	calleeID, err := strconv.ParseInt(p.CalleeID, 10, 64)
	if err != nil || calleeID <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "callee_id 非法")
	}
	if callerID == calleeID {
		return nil, errx.New(errx.CodeBadRequest, "不能呼叫自己")
	}
	// 会话与成员校验（3019/5011）：通话入口在会话内，双方均须为活跃成员
	if s.opts.IsConvActive == nil || !s.opts.IsConvActive(ctx, convID) {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	if s.opts.IsConvMember == nil || !s.opts.IsConvMember(ctx, convID, callerID) {
		return nil, errx.New(errx.CodeRTCNotCallMember, "发起方不在会话中")
	}
	if !s.opts.IsConvMember(ctx, convID, calleeID) {
		return nil, errx.New(errx.CodeRTCNotCallMember, "被叫不在会话中")
	}

	now := s.opts.now()
	call := &Call{
		ID: p.CallID, ConvID: convID, CallType: p.CallType,
		CallerID: callerID, CalleeID: calleeID,
		State: rtcapi.StateDialing, RingAt: now,
	}
	existed, convConflict, userConflict := s.reg.Create(call)
	if convConflict {
		return nil, errx.New(errx.CodeRTCDuplicateCall, "该会话已有进行中通话")
	}
	if userConflict {
		return nil, errx.New(errx.CodeRTCPeerBusy, "对方忙线中")
	}
	if existed {
		// 幂等重试：回既存 call_id，不重复推铃声/落卡（14 篇 §5.3）
		return &rtcapi.InviteAck{CallID: p.CallID}, nil
	}

	// ① 通话卡片落 IM 流（status=calling；结束 PATCH ended——通话记录即消息流，登记不建表）
	if s.card != nil {
		if mid := s.card.SendCard(ctx, callerID, convID, "callcard-"+p.CallID, cardBody(p, "calling", 0, "")); mid > 0 {
			call.CardMsgID = mid
		}
	}
	// ② 状态机 dialing → ringing（服务端无被叫回执，铃声推送即视为振铃中，登记）
	if _, ok := s.reg.Transition(p.CallID, rtcapi.StateRinging, rtcapi.StateDialing); !ok {
		return nil, errx.New(errx.CodeRTCCallEnded, "通话状态异常")
	}
	// ③ 主叫推送 dialing→ringing 链 + 被叫全端 rtc.ringing（多端 did 过滤在客户端做，登记）
	s.pushState([]int64{callerID}, p.CallID, rtcapi.StateDialing, "", 0, "", now)
	s.pushState([]int64{callerID}, p.CallID, rtcapi.StateRinging, "", 0, "", now)
	s.push.PushRTC([]int64{calleeID}, "rtc.ringing", rtcapi.RingingPush{
		CallID: p.CallID,
		Caller: rtcapi.CallerInfo{
			UID:  strconv.FormatInt(callerID, 10),
			Name: s.nameOf(callerID),
		},
		CallType: p.CallType,
		ConvID:   p.ConvID,
	})
	// ④ 振铃超时定时器：30s 无 accept → ended(timeout)
	s.startRingTimer(call)
	return &rtcapi.InviteAck{CallID: p.CallID}, nil
}

// Cancel 主叫振铃期取消（D04 INT-RTC-04）：canceled 终态，被叫收下来电窗
func (s *Service) Cancel(ctx context.Context, callerID int64, p rtcapi.CallIDPayload) error {
	call, err := s.mustParticipant(ctx, callerID, p.CallID)
	if err != nil {
		return err
	}
	if call.CallerID != callerID {
		return errx.New(errx.CodeRTCNotCallMember, "仅主叫可取消")
	}
	snap, ok := s.reg.End(p.CallID, rtcapi.ReasonCanceled, s.opts.now())
	if !ok {
		return errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	stopTimer(snap)
	s.finishAndNotify(snap, rtcapi.ReasonCanceled)
	return nil
}

// Accept 被叫接听（D04 INT-RTC-05/07）：
// answer=true → connecting + 其余端 answered_elsewhere(did)；answer=false 视同拒接。
// bye_call_id 非空=挂断并接听（OQ-C06 原子化）：先结束指定通话再接听，单帧无竞态。
func (s *Service) Accept(ctx context.Context, calleeID int64, p rtcapi.AcceptPayload) error {
	if p.CallID == "" {
		return errx.New(errx.CodeBadRequest, "call_id 必填")
	}
	if !p.Answer {
		// answer=false：语义同拒接（declined），与 Reject 共用收尾
		return s.Reject(ctx, calleeID, rtcapi.RejectPayload{CallID: p.CallID, Reason: rtcapi.ReasonDeclined})
	}
	// 挂断并接听（OQ-C06）：在接听状态迁移**前**结束旧通话——服务端单帧内
	// bye→accept 定序，消除客户端两帧间隔的竞态（bye 未 ack 即 accept /
	// 状态互踩）；旧通话已结束/非本人通话按尽力挂断容忍（不阻断接听）
	if p.ByeCallID != "" && p.ByeCallID != p.CallID {
		if _, err := s.mustParticipant(ctx, calleeID, p.ByeCallID); err == nil {
			if snap, ok := s.reg.End(p.ByeCallID, rtcapi.ReasonBye, s.opts.now()); ok {
				stopTimer(snap)
				s.finishAndNotify(snap, rtcapi.ReasonBye)
			}
		}
	}
	call, err := s.mustParticipant(ctx, calleeID, p.CallID)
	if err != nil {
		return err
	}
	if call.CalleeID != calleeID {
		return errx.New(errx.CodeRTCNotCallMember, "仅被叫可接听")
	}
	// ringing → connecting（重复 accept/connecting 后到达为幂等 no-op）
	snap, ok := s.reg.Transition(p.CallID, rtcapi.StateConnecting, rtcapi.StateRinging)
	if !ok {
		if snap != nil && (snap.State == rtcapi.StateConnecting || snap.State == rtcapi.StateConnected) {
			return nil // 幂等：他端/重试已接通
		}
		return errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	stopTimer(snap)
	now := s.opts.now()
	// 被叫多端：answered_elsewhere（接听端按 did 过滤自身，登记）
	s.pushState([]int64{call.CalleeID}, p.CallID, rtcapi.ReasonElsewhere, "", 0, p.DID, now)
	// 主叫：connecting（随后 SDP/ICE 经 rtc.signal 双向透传）
	s.pushState([]int64{call.CallerID}, p.CallID, rtcapi.StateConnecting, "", 0, "", now)
	return nil
}

// Reject 被叫拒接（D04 INT-RTC-06）：declined 终态
func (s *Service) Reject(ctx context.Context, calleeID int64, p rtcapi.RejectPayload) error {
	if p.CallID == "" {
		return errx.New(errx.CodeBadRequest, "call_id 必填")
	}
	call, err := s.mustParticipant(ctx, calleeID, p.CallID)
	if err != nil {
		return err
	}
	if call.CalleeID != calleeID {
		return errx.New(errx.CodeRTCNotCallMember, "仅被叫可拒接")
	}
	reason := p.Reason
	if reason == "" {
		reason = rtcapi.ReasonDeclined
	}
	snap, ok := s.reg.Transition(p.CallID, rtcapi.StateEnded, rtcapi.StateDialing, rtcapi.StateRinging)
	if !ok {
		return errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	snap.EndReason = reason
	stopTimer(snap)
	s.finishAndNotify(snap, reason)
	return nil
}

// Bye 挂断（D04 INT-RTC-18）：任一端、任一非终态；接通后挂断结算时长
func (s *Service) Bye(ctx context.Context, userID int64, p rtcapi.CallIDPayload) error {
	if _, err := s.mustParticipant(ctx, userID, p.CallID); err != nil {
		return err
	}
	snap, ok := s.reg.End(p.CallID, rtcapi.ReasonBye, s.opts.now())
	if !ok {
		return errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	stopTimer(snap)
	s.finishAndNotify(snap, rtcapi.ReasonBye)
	return nil
}

// Signal SDP/ICE 透传（05 §4.1：转发不落库）：
// connecting 态首个 signal 到达 → connected（信令层近似双方 ICE 进行中，登记）。
func (s *Service) Signal(ctx context.Context, userID int64, p rtcapi.SignalPayload) error {
	if p.CallID == "" || p.Data == nil {
		return errx.New(errx.CodeBadRequest, "call_id/data 必填")
	}
	raw, err := json.Marshal(p.Data)
	if err != nil || len(raw) > MaxSignalBytes {
		return errx.New(errx.CodeBadRequest, "signal data 非法或超过 64KB")
	}
	call, err := s.mustParticipant(ctx, userID, p.CallID)
	if err != nil {
		return err
	}
	callerID, calleeID := call.CallerID, call.CalleeID
	// 转发给对端 user 全端（P2P 场景对端即另一人；多端 did 过滤客户端做）
	peer := calleeID
	if userID == calleeID {
		peer = callerID
	}
	s.push.PushRTC([]int64{peer}, "rtc.signal", rtcapi.SignalPush{
		CallID: p.CallID,
		From:   strconv.FormatInt(userID, 10),
		Data:   p.Data,
	})
	// connected 近似判定：connecting 态首帧信令（主叫 offer 即触发，双端 ICE 由端侧 connectionstate 收敛）
	if s.reg.MarkConnected(p.CallID, s.opts.now()) {
		s.pushState([]int64{callerID, calleeID}, p.CallID, rtcapi.StateConnected, "", 0, "", s.opts.now())
	}
	return nil
}

// mustParticipant 通话存在且 uid 为主/被叫（5010/5011）
func (s *Service) mustParticipant(_ context.Context, uid int64, callID string) (*Call, error) {
	call, ok := s.reg.Get(callID)
	if !ok || !call.Active() {
		return nil, errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	if uid != call.CallerID && uid != call.CalleeID {
		return nil, errx.New(errx.CodeRTCNotCallMember, "非通话成员")
	}
	return call, nil
}

// startRingTimer 振铃超时 → ended(timeout)：与 accept 并发由 Registry 原子迁移单胜者裁决
func (s *Service) startRingTimer(call *Call) {
	call.ringTimer = time.AfterFunc(s.opts.ringTimeout(), func() {
		snap, ok := s.reg.End(call.ID, rtcapi.ReasonTimeout, s.opts.now())
		if !ok {
			return // 已 accept/cancel/... 先行结束
		}
		s.finishAndNotify(snap, rtcapi.ReasonTimeout)
	})
}

// stopTimer 停振铃定时器（快照共享 timer 指针）
func stopTimer(c *Call) {
	if c != nil && c.ringTimer != nil {
		c.ringTimer.Stop()
	}
}

// finishAndNotify 终态收尾：双端 rtc.state{ended} + 卡片 PATCH（duration/reason）
func (s *Service) finishAndNotify(snap *Call, reason string) {
	dur := snap.DurationSec(s.opts.now())
	s.pushState([]int64{snap.CallerID, snap.CalleeID}, snap.ID, rtcapi.StateEnded, reason, dur, "", s.opts.now())
	if s.card != nil && snap.CardMsgID > 0 {
		s.card.FinishCard(context.Background(), snap.CardMsgID,
			cardBody(rtcapi.InvitePayload{CallID: snap.ID, CallType: snap.CallType}, "ended", dur, reason))
	}
}

// pushState rtc.state 推送便捷封装
func (s *Service) pushState(users []int64, callID, kind, reason string, dur int64, did string, ts time.Time) {
	s.push.PushRTC(users, "rtc.state", rtcapi.StatePush{
		CallID: callID, Kind: kind, Reason: reason, Duration: dur, DID: did, TS: ts.UnixMilli(),
	})
}

// nameOf 主叫名解析（未注入回退 uid 字符串）
func (s *Service) nameOf(id int64) string {
	if s.opts.NameOf != nil {
		if n := s.opts.NameOf(id); n != "" {
			return n
		}
	}
	return strconv.FormatInt(id, 10)
}

// cardBody call_card 消息 body 构造：
//
//	进行中 {"call_id","call_type","status":"calling"}
//	已结束 {"call_id","call_type","status":"ended","duration","reason"}
func cardBody(p rtcapi.InvitePayload, status string, duration int64, reason string) json.RawMessage {
	b := map[string]any{
		"call_id":   p.CallID,
		"call_type": p.CallType,
		"status":    status,
	}
	if status == "ended" {
		b["duration"] = duration
		b["reason"] = reason
	}
	raw, _ := json.Marshal(b)
	return raw
}
