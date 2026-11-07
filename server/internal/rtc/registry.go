// Package rtc 通话域服务（D04 阶段一务实版）。
// CallRegistry：进程内进行中通话注册表——不建表、不落库（通话记录=IM 流内 call_card 消息，登记）；
// 多实例部署需换 Redis 共享态（阶段二，D02 §11-1 同 eventbus 口径）。
package rtc

import (
	"sync"
	"time"

	rtcapi "github.com/baobaowork/server/internal/rtc/api"
)

// Call 进行中通话（1v1）。字段仅在 Registry 锁内变更（Transition/End），
// 推送等锁外动作消费返回的快照。
type Call struct {
	ID          string    // call_id（客户端生成，幂等键）
	ConvID      int64     // 关联会话（卡片落此会话）
	CallType    string    // audio | video
	CallerID    int64     // 主叫
	CalleeID    int64     // 被叫
	State       string    // rtcapi.State* 状态机
	RingAt      time.Time // ringing 起始（振铃超时计时起点）
	ConnectedAt time.Time // connected 时刻（时长结算起点）
	EndedAt     time.Time
	EndReason   string
	AnswerDID   string // 接听端设备
	CardMsgID   int64  // call_card 消息回链（结束时 PATCH）

	ringTimer *time.Timer // 振铃超时（阶段一 30s：05 篇 45s 收敛，登记）

	// 群通话（阶段二，05 §4.1 join 模式）：Group=true 时 CalleeID 恒 0，
	// 参与者经 rtc.join 独立加入（不受发起时刻限制）；Bye=单成员退出，
	// 全员退出 → allLeftTimer 窗口（30s 再加入窗口）→ 仍空 End(all_left)
	Group        bool
	Participants map[int64]time.Time // uid → 加入时刻（主叫 invite 即入）
	allLeftTimer *time.Timer
}

// InCall uid 参与判定（1v1=主/被叫；群=参与者集）
func (c *Call) InCall(uid int64) bool {
	if c.Group {
		_, ok := c.Participants[uid]
		return ok
	}
	return uid == c.CallerID || uid == c.CalleeID
}

// Recipients 推送目标（1v1=双端；群=参与者集）
func (c *Call) Recipients() []int64 {
	if c.Group {
		out := make([]int64, 0, len(c.Participants))
		for uid := range c.Participants {
			out = append(out, uid)
		}
		return out
	}
	return []int64{c.CallerID, c.CalleeID}
}

// Active 通话仍在进行（未 ended）
func (c *Call) Active() bool { return c.State != rtcapi.StateEnded }

// DurationSec 时长结算：接通起算（未接通=0；now 为结束时刻）
func (c *Call) DurationSec(now time.Time) int64 {
	if c.ConnectedAt.IsZero() {
		return 0
	}
	d := int64(now.Sub(c.ConnectedAt).Seconds())
	if d < 0 {
		d = 0
	}
	return d
}

// Registry 通话注册表：call_id → Call + conv/user 索引（并发安全；
// 状态迁移与索引回收同锁原子完成，超时定时器与信令路径的竞态由此收敛为单胜者）。
// byUser 多值（阶段二）：同用户可同时在 1v1 与群呼（OQ-C06 被叫忙放行后
// 同用户双通合法）——忙线判定=集合非空。
type Registry struct {
	mu     sync.Mutex
	byID   map[string]*Call
	byConv map[int64]*Call            // 会话维度进行中（5009 判定）
	byUser map[int64]map[string]*Call // 用户维度进行中（5004 忙线判定）
}

// NewRegistry 构造
func NewRegistry() *Registry {
	return &Registry{
		byID:   map[string]*Call{},
		byConv: map[int64]*Call{},
		byUser: map[int64]map[string]*Call{},
	}
}

// Create 注册新通话。冲突语义（返回既存项判定）：
//   - existed：同 call_id 幂等重试（既存仍进行中）→ 调用方直接回 ack 不重推
//   - convConflict：该会话已有进行中通话 → 5009
//   - callerBusy/calleeBusy：主叫/被叫任一忙线（5004 判侧——OQ-C06 阶段二
//     AllowBusyCallee 时被叫侧放行重试 CreateBusyAllowed；群呼 callee=0 天然无被叫侧）
//
// 既有索引项若已 ended（未被回收的残留）视为空位直接覆盖。
func (r *Registry) Create(call *Call) (existed, convConflict, callerBusy, calleeBusy bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, ok := r.byID[call.ID]; ok && old.Active() {
		call.State = old.State
		call.CardMsgID = old.CardMsgID
		call.AnswerDID = old.AnswerDID
		return true, false, false, false
	}
	if c, ok := r.byConv[call.ConvID]; ok && c.Active() {
		return false, true, false, false
	}
	if r.userBusyLocked(call.CallerID) {
		return false, false, true, false
	}
	if call.CalleeID != 0 && r.userBusyLocked(call.CalleeID) {
		return false, false, false, true
	}
	r.insertLocked(call)
	return false, false, false, false
}

// CreateBusyAllowed 被叫侧放行版（OQ-C06 阶段二配套：被叫忙时新呼仍到达，
// 端侧收 ringing 后自动回 busy 或经 bye_call_id 挂旧接新；主叫侧仍拦）。
func (r *Registry) CreateBusyAllowed(call *Call) (existed, convConflict, callerBusy bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, ok := r.byID[call.ID]; ok && old.Active() {
		call.State = old.State
		call.CardMsgID = old.CardMsgID
		return true, false, false
	}
	if c, ok := r.byConv[call.ConvID]; ok && c.Active() {
		return false, true, false
	}
	if r.userBusyLocked(call.CallerID) {
		return false, false, true
	}
	r.insertLocked(call)
	return false, false, false
}

func (r *Registry) userBusyLocked(uid int64) bool {
	return len(r.byUser[uid]) > 0
}

func (r *Registry) insertLocked(call *Call) {
	if call.Participants == nil && call.Group {
		call.Participants = map[int64]time.Time{}
	}
	r.byID[call.ID] = call
	r.byConv[call.ConvID] = call
	for _, uid := range call.Recipients() {
		if r.byUser[uid] == nil {
			r.byUser[uid] = map[string]*Call{}
		}
		r.byUser[uid][call.ID] = call
	}
}

// Get 按 call_id 查（返回当前快照引用；字段读取应容忍并发迁移，判定类逻辑用 Transition）
func (r *Registry) Get(callID string) (*Call, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.byID[callID]
	return c, ok
}

// Transition 原子状态迁移：当前态命中 froms 任一 → 置 to（ended 时一并回收索引）。
// 返回迁移后的快照与是否成功；并发单胜者（超时 vs accept 竞态由此裁决）。
func (r *Registry) Transition(callID, to string, froms ...string) (*Call, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.byID[callID]
	if !ok {
		return nil, false
	}
	hit := false
	for _, f := range froms {
		if c.State == f {
			hit = true
			break
		}
	}
	if !hit {
		snap := *c
		return &snap, false
	}
	c.State = to
	snap := *c
	if to == rtcapi.StateEnded {
		r.removeLocked(c)
	}
	return &snap, true
}

// End 终态迁移便捷方法：置 ended + reason/ended_at + 索引回收
func (r *Registry) End(callID, reason string, now time.Time) (*Call, bool) {
	r.mu.Lock()
	c, ok := r.byID[callID]
	if !ok || !c.Active() {
		r.mu.Unlock()
		return c, false
	}
	c.State = rtcapi.StateEnded
	c.EndReason = reason
	c.EndedAt = now
	r.removeLocked(c)
	snap := *c
	r.mu.Unlock()
	return &snap, true
}

// MarkConnected connecting → connected 原子迁移并记 ConnectedAt
// （信令层近似：接听后首帧 rtc.signal 到达即判 connected，D04 阶段一登记口径）
func (r *Registry) MarkConnected(callID string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.byID[callID]
	if !ok || c.State != rtcapi.StateConnecting {
		return false
	}
	c.State = rtcapi.StateConnected
	c.ConnectedAt = now
	return true
}

// removeLocked 索引回收（调用方持锁；1v1=双端、群=参与者全集）
func (r *Registry) removeLocked(c *Call) {
	delete(r.byID, c.ID)
	if cur, ok := r.byConv[c.ConvID]; ok && cur == c {
		delete(r.byConv, c.ConvID)
	}
	for _, uid := range c.Recipients() {
		if calls := r.byUser[uid]; calls != nil {
			delete(calls, c.ID)
			if len(calls) == 0 {
				delete(r.byUser, uid)
			}
		}
	}
}

// JoinParticipant 群成员加入（幂等：已在=直接 true）；群外/已结束=false
func (r *Registry) JoinParticipant(callID string, uid int64, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.byID[callID]
	if !ok || !c.Active() || !c.Group {
		return false
	}
	if _, joined := c.Participants[uid]; joined {
		return true // 幂等
	}
	if c.Participants == nil {
		c.Participants = map[int64]time.Time{}
	}
	c.Participants[uid] = now
	if r.byUser[uid] == nil {
		r.byUser[uid] = map[string]*Call{}
	}
	r.byUser[uid][c.ID] = c
	return true
}

// LeaveParticipant 群成员退出（索引回收）；返回剩余人数与是否成功。
// 退出后参与者集空由调用方（service）启动 all_left 窗口。
func (r *Registry) LeaveParticipant(callID string, uid int64) (remaining int, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, found := r.byID[callID]
	if !found || !c.Active() || !c.Group {
		return 0, false
	}
	if _, joined := c.Participants[uid]; !joined {
		return len(c.Participants), false // 非参与者（5011 由 service 判）
	}
	delete(c.Participants, uid)
	if calls := r.byUser[uid]; calls != nil {
		delete(calls, callID)
		if len(calls) == 0 {
			delete(r.byUser, uid)
		}
	}
	return len(c.Participants), true
}

// SetAllLeftTimer / CancelAllLeftTimer 全员退出窗口定时器管理
func (r *Registry) SetAllLeftTimer(callID string, t *time.Timer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.byID[callID]; ok {
		c.allLeftTimer = t
	}
}

func (r *Registry) CancelAllLeftTimer(callID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.byID[callID]; ok && c.allLeftTimer != nil {
		c.allLeftTimer.Stop()
		c.allLeftTimer = nil
	}
}

// ActiveCallsOf 用户进行中通话（多值索引读取；快照拷贝）
func (r *Registry) ActiveCallsOf(uid int64) []*Call {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Call, 0, len(r.byUser[uid]))
	for _, c := range r.byUser[uid] {
		if c.Active() {
			cp := *c
			out = append(out, &cp)
		}
	}
	return out
}
