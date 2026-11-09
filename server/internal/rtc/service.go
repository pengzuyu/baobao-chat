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

// MaxGroupSeats 群通话席位上限（05 §7.3 纯音频 64；视频 16 位为媒体面
// 席位，信令层不区分，登记）
const MaxGroupSeats = 64

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
	// ConvMembersOf 群呼全员解析（message 域闭包；群 invite 推 ringing 目标集）
	ConvMembersOf func(ctx context.Context, convID int64) []int64
	// AllowBusyCallee 被叫忙放行（OQ-C06 阶段二配套：新呼到达 ringing，
	// 端侧自动回 busy 或 bye_call_id 挂旧接新；主叫侧忙仍拦 5004）
	AllowBusyCallee bool
	// AllLeftWindow 群通话全员退出 → 自动结束延迟（缺省 30s：05 §7.4
	// "全员离开后 30s"；窗口内再加入取消）
	AllLeftWindow time.Duration
	// RingTimeout 振铃超时（测试可注入短时长）
	RingTimeout time.Duration
	// Now 时钟注入（测试）
	Now func() time.Time
	// LK LiveKit 统一媒体面（D17：token 签发/配置下发/webhook 验签；
	// 零值=未配置——token/config 返 5003，端侧无媒体降级，信令照走）
	LK LiveKitParams
}

func (o *Options) ringTimeout() time.Duration {
	if o.RingTimeout > 0 {
		return o.RingTimeout
	}
	return RingTimeoutDefault
}

func (o *Options) allLeftWindow() time.Duration {
	if o.AllLeftWindow > 0 {
		return o.AllLeftWindow
	}
	return 30 * time.Second
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

// Invite 发起通话（D04 INT-RTC-01；阶段二扩展三种形态）：
//   - 1v1：callee_id 非空——校验 → 注册（5009/5004/幂等）→ 落卡 → 推 ringing
//   - 群呼：callee_id 空——conv 全员 ringing + 主叫即参与者（join 模式，
//     05 §4.1：各参与者独立协商加入，不受发起时刻限制）
//   - 通话中追加：call_id 已存在且群呼 → 仅对指定 callee 推 ringing
//
// 1v1 被叫忙：AllowBusyCallee=true 时放行（OQ-C06 配套）并给主叫附
// busy 提示（端侧决定展示/自动挂）；主叫忙恒拦。
func (s *Service) Invite(ctx context.Context, callerID int64, p rtcapi.InvitePayload) (*rtcapi.InviteAck, error) {
	if p.CallID == "" || p.ConvID == "" {
		return nil, errx.New(errx.CodeBadRequest, "call_id/conv_id 必填")
	}
	if p.CallType != rtcapi.CallTypeAudio && p.CallType != rtcapi.CallTypeVideo {
		return nil, errx.New(errx.CodeRTCMediaParamInvalid, "call_type 应为 audio/video")
	}
	convID, err := strconv.ParseInt(p.ConvID, 10, 64)
	if err != nil || convID <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "conv_id 非法")
	}
	var calleeID int64
	if p.CalleeID != "" {
		calleeID, err = strconv.ParseInt(p.CalleeID, 10, 64)
		if err != nil || calleeID <= 0 {
			return nil, errx.New(errx.CodeBadRequest, "callee_id 非法")
		}
		if callerID == calleeID {
			return nil, errx.New(errx.CodeBadRequest, "不能呼叫自己")
		}
	}
	// 会话与成员校验（3019/5011）
	if s.opts.IsConvActive == nil || !s.opts.IsConvActive(ctx, convID) {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	if s.opts.IsConvMember == nil || !s.opts.IsConvMember(ctx, convID, callerID) {
		return nil, errx.New(errx.CodeRTCNotCallMember, "发起方不在会话中")
	}

	now := s.opts.now()

	// 群呼：calleeID=0（ConvMember 校验天然覆盖"全员在会话"）
	isGroup := calleeID == 0
	if !isGroup && !s.opts.IsConvMember(ctx, convID, calleeID) {
		return nil, errx.New(errx.CodeRTCNotCallMember, "被叫不在会话中")
	}

	call := &Call{
		ID: p.CallID, ConvID: convID, CallType: p.CallType,
		CallerID: callerID, CalleeID: calleeID,
		Group: isGroup, State: rtcapi.StateDialing, RingAt: now,
	}
	// 幂等/追加前置：同 call_id 既存活动通话——群呼带 callee=追加被叫
	// （05 §4.1 通话中邀请，仅推新增被叫）；否则幂等回 ack 不重推
	if existing, ok := s.reg.Get(p.CallID); ok && existing.Active() {
		if existing.Group && p.CalleeID != "" {
			return s.inviteExtraCallee(ctx, callerID, p, convID, existing)
		}
		return &rtcapi.InviteAck{CallID: p.CallID}, nil
	}
	existed, convConflict, callerBusy, calleeBusy := s.reg.Create(call)
	if convConflict {
		return nil, errx.New(errx.CodeRTCDuplicateCall, "该会话已有进行中通话")
	}
	if callerBusy {
		return nil, errx.New(errx.CodeRTCPeerBusy, "你已在通话中")
	}
	if existed {
		return &rtcapi.InviteAck{CallID: p.CallID}, nil // 1v1 幂等重试
	}
	busyHint := false
	if calleeBusy {
		if !s.opts.AllowBusyCallee {
			return nil, errx.New(errx.CodeRTCPeerBusy, "对方忙线中")
		}
		// 放行重试（OQ-C06：新呼到达，端侧配套自动 busy/挂旧接新）
		existed, convConflict, callerBusy = s.reg.CreateBusyAllowed(call)
		if convConflict || callerBusy || existed {
			return nil, errx.New(errx.CodeRTCPeerBusy, "对方忙线中")
		}
		busyHint = true
	}

	// ① 通话卡片（群呼同卡：status=calling+group 标记，端侧[加入]按钮判定；结束 PATCH ended）
	if s.card != nil {
		if mid := s.card.SendCard(ctx, callerID, convID, "callcard-"+p.CallID, cardBody(p, "calling", 0, "", isGroup)); mid > 0 {
			call.CardMsgID = mid
		}
	}
	if isGroup {
		return s.inviteGroup(ctx, callerID, p, call, now)
	}

	// ② 1v1：dialing → ringing + 双方推送 + 振铃定时器
	if _, ok := s.reg.Transition(p.CallID, rtcapi.StateRinging, rtcapi.StateDialing); !ok {
		return nil, errx.New(errx.CodeRTCCallEnded, "通话状态异常")
	}
	s.pushState([]int64{callerID}, p.CallID, rtcapi.StateDialing, "", 0, "", now)
	s.pushState([]int64{callerID}, p.CallID, rtcapi.StateRinging, "", 0, "", now)
	if busyHint {
		// OQ-C06 配套提示：新呼已送达忙线被叫（端侧展示"对方忙线中"）
		s.pushState([]int64{callerID}, p.CallID, rtcapi.StateRinging, "busy", 0, "", now)
	}
	s.push.PushRTC([]int64{calleeID}, "rtc.ringing", rtcapi.RingingPush{
		CallID: p.CallID,
		Caller: rtcapi.CallerInfo{
			UID:  strconv.FormatInt(callerID, 10),
			Name: s.nameOf(callerID),
		},
		CallType: p.CallType,
		ConvID:   p.ConvID,
	})
	s.startRingTimer(call)
	return &rtcapi.InviteAck{CallID: p.CallID}, nil
}

// inviteGroup 群呼发起（join 模式）：主叫即参与者 → conv 全员（除主叫）
// ringing（group=true）→ 主叫 connecting（等待首个成员 signal → connected）。
// 无振铃超时（加入无期限；全员退出/主叫取消才结束，all_left 窗口兜底）。
func (s *Service) inviteGroup(ctx context.Context, callerID int64, p rtcapi.InvitePayload, call *Call, now time.Time) (*rtcapi.InviteAck, error) {
	s.reg.JoinParticipant(call.ID, callerID, now)
	s.reg.Transition(call.ID, rtcapi.StateConnecting, rtcapi.StateDialing)
	s.pushState([]int64{callerID}, call.ID, rtcapi.StateConnecting, "", 0, "", now)
	members := s.convMembers(ctx, call.ConvID)
	ringing := rtcapi.RingingPush{
		CallID: call.ID,
		Caller: rtcapi.CallerInfo{
			UID:  strconv.FormatInt(callerID, 10),
			Name: s.nameOf(callerID),
		},
		CallType: p.CallType, ConvID: p.ConvID, Group: true,
	}
	targets := make([]int64, 0, len(members))
	for _, uid := range members {
		if uid != callerID {
			targets = append(targets, uid)
		}
	}
	if len(targets) > 0 {
		s.push.PushRTC(targets, "rtc.ringing", ringing)
	}
	return &rtcapi.InviteAck{CallID: call.ID}, nil
}

// inviteExtraCallee 群呼追加被叫（通话中邀请，05 §4.1）：仅校验发起者为
// 参与者+新被叫为会话成员 → 单推 ringing；不落新卡/不改状态
func (s *Service) inviteExtraCallee(ctx context.Context, callerID int64, p rtcapi.InvitePayload, convID int64, call *Call) (*rtcapi.InviteAck, error) {
	calleeID, err := strconv.ParseInt(p.CalleeID, 10, 64)
	if err != nil || calleeID <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "callee_id 非法")
	}
	if _, joined := call.Participants[callerID]; !joined {
		return nil, errx.New(errx.CodeRTCNotCallMember, "仅参与者可追加邀请")
	}
	if !s.opts.IsConvMember(ctx, convID, calleeID) {
		return nil, errx.New(errx.CodeRTCNotCallMember, "被叫不在会话中")
	}
	s.push.PushRTC([]int64{calleeID}, "rtc.ringing", rtcapi.RingingPush{
		CallID: p.CallID,
		Caller: rtcapi.CallerInfo{
			UID:  strconv.FormatInt(callerID, 10),
			Name: s.nameOf(callerID),
		},
		CallType: p.CallType, ConvID: p.ConvID, Group: true,
	})
	return &rtcapi.InviteAck{CallID: p.CallID}, nil
}

// convMembers 群呼目标集（闭包缺失=仅主叫自身，防御）
func (s *Service) convMembers(ctx context.Context, convID int64) []int64 {
	if s.opts.ConvMembersOf == nil {
		return nil
	}
	return s.opts.ConvMembersOf(ctx, convID)
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
	// 群呼引导（join 模式无 accept——先于成员判定给出明确语义）
	if c, ok := s.reg.Get(p.CallID); ok && c.Group && c.Active() {
		return errx.New(errx.CodeBadRequest, "群通话经 rtc.join 加入")
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
	if call.Group {
		return errx.New(errx.CodeBadRequest, "群通话经 rtc.join 加入")
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
	if c, ok := s.reg.Get(p.CallID); ok && c.Group && c.Active() {
		return errx.New(errx.CodeBadRequest, "群通话经 rtc.join 加入")
	}
	call, err := s.mustParticipant(ctx, calleeID, p.CallID)
	if err != nil {
		return err
	}
	if call.Group {
		return errx.New(errx.CodeBadRequest, "群通话经 rtc.join 加入")
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

// Bye 挂断（D04 INT-RTC-18）：1v1=任一端挂断整通；群=单成员退出
// （05 §4.1 join 模式）——剩余成员继续，参与者集空 → all_left 窗口。
func (s *Service) Bye(ctx context.Context, userID int64, p rtcapi.CallIDPayload) error {
	call, err := s.mustParticipant(ctx, userID, p.CallID)
	if err != nil {
		return err
	}
	if call.Group {
		return s.leaveGroup(userID, call)
	}
	snap, ok := s.reg.End(p.CallID, rtcapi.ReasonBye, s.opts.now())
	if !ok {
		return errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	stopTimer(snap)
	s.finishAndNotify(snap, rtcapi.ReasonBye)
	return nil
}

// leaveGroup 群成员退出：推剩余成员 state{left}；全员退出 → all_left
// 窗口定时器（默认 30s，窗口内 Join 取消；到点仍空 → End(all_left)）
func (s *Service) leaveGroup(userID int64, call *Call) error {
	remaining, ok := s.reg.LeaveParticipant(call.ID, userID)
	if !ok {
		return errx.New(errx.CodeRTCNotCallMember, "非通话参与者")
	}
	now := s.opts.now()
	if remaining > 0 {
		// 剩余成员感知退出者
		s.pushState(s.regParticipantIDs(call.ID), call.ID, "left", "", 0, "", now)
		return nil
	}
	// 全员退出：窗口定时器（OQ-C05 all_left 产生点）
	callID := call.ID
	window := s.opts.allLeftWindow()
	timer := time.AfterFunc(window, func() {
		if snap, ended := s.reg.End(callID, rtcapi.ReasonAllLeft, s.opts.now()); ended {
			s.finishAndNotify(snap, rtcapi.ReasonAllLeft)
		}
	})
	s.reg.SetAllLeftTimer(callID, timer)
	return nil
}

// regParticipantIDs 参与者集快照（推送目标）
func (s *Service) regParticipantIDs(callID string) []int64 {
	if c, ok := s.reg.Get(callID); ok && c.Group {
		return c.Recipients()
	}
	return nil
}

// Join 群通话加入（阶段二，05 §4.1）：conv 成员 + 席位校验（64/5002，
// 05 §7.3 纯音频上限——视频 16 位媒体面校验登记）→ 参与者集 → 全员
// state{joined}；all_left 窗口内再加入 → 取消结束定时器。
func (s *Service) Join(ctx context.Context, userID int64, p rtcapi.JoinPayload) error {
	if p.CallID == "" {
		return errx.New(errx.CodeBadRequest, "call_id 必填")
	}
	call, err := s.mustActiveCall(p.CallID)
	if err != nil {
		return err
	}
	if !call.Group {
		return errx.New(errx.CodeBadRequest, "非群通话（1v1 经 rtc.accept 接听）")
	}
	if !s.opts.IsConvMember(ctx, call.ConvID, userID) {
		return errx.New(errx.CodeRTCNotCallMember, "不在会话中")
	}
	// 席位（先查再加入——窗口边界竞态由锁内计数近似，登记）
	if ids := s.regParticipantIDs(p.CallID); len(ids) >= MaxGroupSeats {
		return errx.New(errx.CodeRTCMemberLimit, "通话人数已达上限")
	}
	now := s.opts.now()
	if !s.reg.JoinParticipant(p.CallID, userID, now) {
		return errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	s.reg.CancelAllLeftTimer(p.CallID) // 再加入窗口内复活
	s.pushState(s.regParticipantIDs(p.CallID), p.CallID, "joined", "", 0, p.DID, now)
	return nil
}

// mustActiveCall 存在且非终态（5010）
func (s *Service) mustActiveCall(callID string) (*Call, error) {
	call, ok := s.reg.Get(callID)
	if !ok || !call.Active() {
		return nil, errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	return call, nil
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
	// 群通话：转发给其余参与者（各端独立协商，05 §4.1）；1v1：对端
	var targets []int64
	if call.Group {
		for _, uid := range call.Recipients() {
			if uid != userID {
				targets = append(targets, uid)
			}
		}
	} else {
		peer := call.CalleeID
		if userID == call.CalleeID {
			peer = call.CallerID
		}
		targets = []int64{peer}
	}
	s.push.PushRTC(targets, "rtc.signal", rtcapi.SignalPush{
		CallID: p.CallID,
		From:   strconv.FormatInt(userID, 10),
		Data:   p.Data,
	})
	// connected 近似判定：connecting 态首帧信令（主叫 offer 即触发，双端 ICE 由端侧 connectionstate 收敛）
	if s.reg.MarkConnected(p.CallID, s.opts.now()) {
		s.pushState(call.Recipients(), p.CallID, rtcapi.StateConnected, "", 0, "", s.opts.now())
	}
	return nil
}

// mustParticipant 通话存在且 uid 为主/被叫（5010/5011）
func (s *Service) mustParticipant(_ context.Context, uid int64, callID string) (*Call, error) {
	call, ok := s.reg.Get(callID)
	if !ok || !call.Active() {
		return nil, errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	if !call.InCall(uid) {
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

// finishAndNotify 终态收尾：参与者 rtc.state{ended} + 卡片 PATCH（duration/reason）
func (s *Service) finishAndNotify(snap *Call, reason string) {
	dur := snap.DurationSec(s.opts.now())
	s.pushState(snap.Recipients(), snap.ID, rtcapi.StateEnded, reason, dur, "", s.opts.now())
	if s.card != nil && snap.CardMsgID > 0 {
		s.card.FinishCard(context.Background(), snap.CardMsgID,
			cardBody(rtcapi.InvitePayload{CallID: snap.ID, CallType: snap.CallType}, "ended", dur, reason, snap.Group))
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
//	进行中 {"call_id","call_type","status":"calling"[,"group":true]}
//	已结束 {"call_id","call_type","status":"ended","duration","reason"[,"group":true]}
func cardBody(p rtcapi.InvitePayload, status string, duration int64, reason string, group bool) json.RawMessage {
	b := map[string]any{
		"call_id":   p.CallID,
		"call_type": p.CallType,
		"status":    status,
	}
	if group {
		b["group"] = true // D17：群呼标记（端侧进行中卡片[加入]按钮判定）
	}
	if status == "ended" {
		b["duration"] = duration
		b["reason"] = reason
	}
	raw, _ := json.Marshal(b)
	return raw
}
