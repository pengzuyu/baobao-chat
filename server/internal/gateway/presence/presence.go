// Package presence 在线状态域（D03 §5.3 presence.changed / 04 篇 presence 模型）。
// v0.1 口径（登记）：
//   - online/offline 由 WS 连接数派生（连接注册表快照查询），无独立存储；
//   - pres.set 的 away/dnd/invisible 为会话内轻量状态：仅广播，不持久化（重启回落 online）；
//   - 推送范围=进程内全部在线连接（单租户阶段一量级 OK；阶段二按共享会话收窄+Redis）。
package presence

import (
	"sort"
	"sync"
)

// Status 在线状态（14 篇 presence.changed.status）
const (
	StatusOnline    = "online"
	StatusAway      = "away"
	StatusDND       = "dnd"
	StatusInvisible = "invisible"
	StatusOffline   = "offline"
)

// Tracker 连接派生在线 + 用户自报状态合成器（线程安全）
type Tracker struct {
	mu       sync.RWMutex
	conns    map[int64]int    // uid → 活跃连接数
	reported map[int64]string // uid → pres.set 最近状态（缺省 online）
}

// NewTracker 构造
func NewTracker() *Tracker {
	return &Tracker{conns: map[int64]int{}, reported: map[int64]string{}}
}

// ConnUp 连接建立：返回是否发生 offline→online 转变（需广播）
func (t *Tracker) ConnUp(uid int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conns[uid]++
	return t.conns[uid] == 1
}

// ConnDown 连接断开：返回是否发生 online→offline 转变
func (t *Tracker) ConnDown(uid int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conns[uid] <= 1 {
		delete(t.conns, uid)
		delete(t.reported, uid) // 离线即弃自报态（重启回落）
		return true
	}
	t.conns[uid]--
	return false
}

// Set 用户自报状态（pres.set）：返回生效状态（invisible 对他端呈现=offline，自身连接除外——
// v0.1 简化：invisible 直接按 offline 广播，登记）
func (t *Tracker) Set(uid int64, status string) string {
	switch status {
	case StatusAway, StatusDND, StatusInvisible, StatusOnline:
	default:
		status = StatusOnline
	}
	t.mu.Lock()
	t.reported[uid] = status
	t.mu.Unlock()
	return status
}

// Get 合成状态：无连接=offline；invisible=offline（对观察者）；其余=自报态缺省 online
func (t *Tracker) Get(uid int64) string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.conns[uid] == 0 {
		return StatusOffline
	}
	if s, ok := t.reported[uid]; ok && s != StatusInvisible {
		return s
	}
	if s, ok := t.reported[uid]; ok && s == StatusInvisible {
		return StatusOffline // 观察者视角
	}
	return StatusOnline
}

// Snapshot 全量状态（sync presences 用；升序稳定序）
func (t *Tracker) Snapshot() map[int64]string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make(map[int64]string, len(t.conns))
	for uid := range t.conns {
		out[uid] = t.Get(uid)
	}
	return out
}

// OnlineUIDs 在线用户列表（升序，测试/广播目标）
func (t *Tracker) OnlineUIDs() []int64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	ids := make([]int64, 0, len(t.conns))
	for uid := range t.conns {
		ids = append(ids, uid)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
