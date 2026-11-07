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
// 状态迁移与索引回收同锁原子完成，超时定时器与信令路径的竞态由此收敛为单胜者）
type Registry struct {
	mu     sync.Mutex
	byID   map[string]*Call
	byConv map[int64]*Call // 会话维度进行中（5009 判定）
	byUser map[int64]*Call // 用户维度进行中（5004 忙线判定：主/被叫任一命中）
}

// NewRegistry 构造
func NewRegistry() *Registry {
	return &Registry{
		byID:   map[string]*Call{},
		byConv: map[int64]*Call{},
		byUser: map[int64]*Call{},
	}
}

// Create 注册新通话。冲突语义（返回既存项判定）：
//   - existed：同 call_id 幂等重试（既存仍进行中）→ 调用方直接回 ack 不重推
//   - convConflict：该会话已有进行中通话 → 5009
//   - userConflict：主叫或被叫已在通话 → 5004
//
// 既有索引项若已 ended（未被回收的残留）视为空位直接覆盖。
func (r *Registry) Create(call *Call) (existed, convConflict, userConflict bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, ok := r.byID[call.ID]; ok && old.Active() {
		call.State = old.State
		call.CardMsgID = old.CardMsgID
		call.AnswerDID = old.AnswerDID
		return true, false, false
	}
	if c, ok := r.byConv[call.ConvID]; ok && c.Active() {
		return false, true, false
	}
	if c, ok := r.byUser[call.CallerID]; ok && c.Active() {
		return false, false, true
	}
	if c, ok := r.byUser[call.CalleeID]; ok && c.Active() {
		return false, false, true
	}
	r.byID[call.ID] = call
	r.byConv[call.ConvID] = call
	r.byUser[call.CallerID] = call
	r.byUser[call.CalleeID] = call
	return false, false, false
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

// removeLocked 索引回收（调用方持锁）
func (r *Registry) removeLocked(c *Call) {
	delete(r.byID, c.ID)
	if cur, ok := r.byConv[c.ConvID]; ok && cur == c {
		delete(r.byConv, c.ConvID)
	}
	if cur, ok := r.byUser[c.CallerID]; ok && cur == c {
		delete(r.byUser, c.CallerID)
	}
	if cur, ok := r.byUser[c.CalleeID]; ok && cur == c {
		delete(r.byUser, c.CalleeID)
	}
}
