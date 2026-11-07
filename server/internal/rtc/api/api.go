// Package rtcapi 通话域对外接口与 DTO（D04 阶段一务实版）。
// 文档：docs/05-音视频通话设计.md §4/§6 · docs/detail/D04-通话模块详细设计.md §5.1。
// 阶段一口径（与 05 篇差异处均已登记）：
//   - 1v1 全链 + 群通话阶段二（callee_id 空=群呼 join 模式：全员 ringing+
//     独立协商加入+all_left 30s 窗口+席位 64）；媒体面 SFU/节点迁移/质量面板不做；
//   - WebRTC P2P：服务端纯信令（SDP/ICE 经 rtc.signal 透传，不落库）；
//   - 通话记录=IM 流内 call_card 消息，服务端不建表（CallRegistry 内存态）；
//   - 推送扇出按 user 广播（多端 did 过滤在客户端做，登记）。
package rtcapi

import "context"

// 通话类型（客户端入口二选一；05 篇 §6.1 call_type 1/2 的字符串化）
const (
	CallTypeAudio = "audio"
	CallTypeVideo = "video"
)

// 通话状态机（服务端视角，05 篇 §4.2/4.3 裁剪）：
// dialing → ringing(被叫推送后) → connecting(accept answer=true)
//
//	→ connected(信令层以 answer 后首个 signal 到达近似，登记) → ended
const (
	StateDialing    = "dialing"
	StateRinging    = "ringing"
	StateConnecting = "connecting"
	StateConnected  = "connected"
	StateEnded      = "ended"
)

// rtc.state.kind 终态 reason（05 篇 end_reason 枚举的务实子集）
const (
	ReasonCanceled  = "canceled"           // 主叫振铃期取消
	ReasonDeclined  = "declined"           // 被叫拒接
	ReasonTimeout   = "timeout"            // 30s 振铃超时（05 篇 no_answer 的阶段一命名）
	ReasonBye       = "bye"                // 接通后任一端挂断
	ReasonFailed    = "failed"             // 信令/媒体失败兜底
	ReasonElsewhere = "answered_elsewhere" // 多端：他端已接听（kind 复用 state 推送）
	// all_left（OQ-C05）：群通话"全员退出自动结束"归一——枚举预登记，
	// 1v1 无产生场景（任一端 bye 即结束），产生逻辑随 D04 阶段二群通话落地
	ReasonAllLeft = "all_left"
)

// InvitePayload WS rtc.call.invite（c→s）
type InvitePayload struct {
	CallID   string `json:"call_id"`   // 客户端生成（UUID，重试不换——幂等键，14 篇 §5.3）
	ConvID   string `json:"conv_id"`   // 关联会话（卡片落此会话）
	CalleeID string `json:"callee_id"` // 被叫 uid（1v1 恰 1 人；空=群呼全员 ringing）
	CallType string `json:"call_type"` // audio | video
}

// InviteAck rtc.call.invite ack 载荷
type InviteAck struct {
	CallID string `json:"call_id"`
}

// CallIDPayload WS rtc.call.cancel / rtc.bye（c→s）
type CallIDPayload struct {
	CallID string `json:"call_id"`
}

// AcceptPayload WS rtc.accept（c→s，被叫）
type AcceptPayload struct {
	CallID string `json:"call_id"`
	Answer bool   `json:"answer"` // true 接听 / false 视同拒接（declined）
	DID    string `json:"did"`    // 接听端设备标识（多端 answered_elsewhere 判定）
	// 挂断并接听（OQ-C06 服务端原子化，D04 INT-RTC-16/开放问题 4）：非空时
	// 服务端在接听前先结束该指定通话——单帧处理消除客户端"bye 未 ack 即
	// accept"的竞态窗口；旧通话已结束/不存在按尽力挂断容忍（不阻断接听）
	ByeCallID string `json:"bye_call_id,omitempty"`
}

// RejectPayload WS rtc.reject（c→s，被叫）
type RejectPayload struct {
	CallID string `json:"call_id"`
	Reason string `json:"reason"` // declined | busy | timeout_local
}

// JoinPayload WS rtc.join（c→s，群通话加入；05 §4.1 群内多人 join 模式）
type JoinPayload struct {
	CallID string `json:"call_id"`
	DID    string `json:"did"` // 加入端设备标识
}

// SignalPayload WS rtc.signal（c→s，SDP/ICE 透传）
type SignalPayload struct {
	CallID string         `json:"call_id"`
	Data   map[string]any `json:"data"` // {kind:sdp|candidate, ...}（服务端不解释，仅校验尺寸）
}

// CallerInfo rtc.ringing 内主叫信息
type CallerInfo struct {
	UID    string `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar,omitempty"` // org 用户模型 v0.1 无头像字段，恒空（登记）
}

// RingingPush rtc.ringing（s→c，推被叫全端；群呼 group=true）
type RingingPush struct {
	CallID   string     `json:"call_id"`
	Caller   CallerInfo `json:"caller"`
	CallType string     `json:"call_type"`
	ConvID   string     `json:"conv_id"`
	Group    bool       `json:"group,omitempty"` // 群呼：端侧展示"群通话·点击加入"
}

// StatePush rtc.state（s→c，双端；kind 判别联合的务实子集）
type StatePush struct {
	CallID   string `json:"call_id"`
	Kind     string `json:"kind"`               // dialing|ringing|connecting|connected|ended|answered_elsewhere|joined|left
	Reason   string `json:"reason,omitempty"`   // kind=ended：canceled|declined|busy|timeout|bye|failed
	Duration int64  `json:"duration,omitempty"` // kind=ended：接通秒数（未接通 0）
	DID      string `json:"did,omitempty"`      // kind=answered_elsewhere：接听端 did（客户端过滤本端）
	TS       int64  `json:"ts"`
}

// SignalPush rtc.signal（s→c，转发给对端 user 全端）
type SignalPush struct {
	CallID string         `json:"call_id"`
	From   string         `json:"from"` // 发起信令一方的 uid（调试辅助；端内按 call_id 归属即可）
	Data   map[string]any `json:"data"`
}

// Pusher 服务端推送出口：gateway 装配时以 hub.PushToUsers 适配注入
// （进程内直调，无 eventbus——通话推送为瞬态无落库语义，登记）
type Pusher interface {
	PushRTC(userIDs []int64, typ string, payload any) int
}

// RTCService 通话信令服务接口（gateway 依赖，D02 §4 依赖倒置）
type RTCService interface {
	// Invite 发起 1v1：校验会话/成员/忙线 → 建 CallRegistry 项 → 推 ringing/落 call_card。
	// 该会话已有进行中通话 → 5009；任一方已在通话 → 5004。
	Invite(ctx context.Context, callerID int64, p InvitePayload) (*InviteAck, error)
	// Cancel 主叫振铃期取消 → 双端 ended(canceled) + 卡片回写
	Cancel(ctx context.Context, callerID int64, p CallIDPayload) error
	// Accept 被叫接听/拒答：answer=true → connecting + 其余端 answered_elsewhere；
	// answer=false 视同 Reject(declined)
	Accept(ctx context.Context, calleeID int64, p AcceptPayload) error
	// Reject 被叫拒接 → 双端 ended(declined)
	Reject(ctx context.Context, calleeID int64, p RejectPayload) error
	// Bye 任一端挂断 → 双端 ended(bye, duration)
	Bye(ctx context.Context, userID int64, p CallIDPayload) error
	// Signal SDP/ICE 透传给对端；connecting 态首个 signal 到达 → connected（近似，登记）
	Signal(ctx context.Context, userID int64, p SignalPayload) error
	// Join 群通话加入（阶段二）：席位校验（64，5002）→ 参与者集 → 全员
	// state{joined}；all_left 窗口内再加入自动取消结束定时器
	Join(ctx context.Context, userID int64, p JoinPayload) error
}
