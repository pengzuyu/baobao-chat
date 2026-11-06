package authrepo

import (
	"context"
	"strconv"
	"sync"
	"time"
)

// Memory 三仓储的内存实现（阶段一）
type Memory struct {
	mu       sync.Mutex
	tokens   map[int64]*RefreshToken
	byHash   map[string]int64
	devices  map[int64]*Device
	byDID    map[string]int64 // key: userID|did
	attempts map[string]*attempt
	nextTok  int64
	nextDev  int64
}

type attempt struct {
	fails     int
	lockedTil time.Time
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{
		tokens:   map[int64]*RefreshToken{},
		byHash:   map[string]int64{},
		devices:  map[int64]*Device{},
		byDID:    map[string]int64{},
		attempts: map[string]*attempt{},
		nextTok:  1,
		nextDev:  1,
	}
}

// compile-time 接口断言
var (
	_ RefreshTokenRepo  = (*Memory)(nil)
	_ DeviceRepo        = (*Memory)(nil)
	_ LoginAttemptStore = (*Memory)(nil)
)

// Create 落库（分配 ID）
func (m *Memory) Create(_ context.Context, t RefreshToken) (RefreshToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.ID == 0 {
		t.ID = m.nextTok
		m.nextTok++
	}
	cp := t
	m.tokens[t.ID] = &cp
	m.byHash[t.TokenHash] = t.ID
	return cp, nil
}

// FindByTokenHash 哈希查令牌
func (m *Memory) FindByTokenHash(_ context.Context, hash string) (*RefreshToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.byHash[hash]; ok {
		cp := *m.tokens[id]
		return &cp, nil
	}
	return nil, nil
}

// UpdateStatus 变更状态（轮换/吊销）
func (m *Memory) UpdateStatus(_ context.Context, id int64, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.tokens[id]; ok {
		t.Status = status
	}
	return nil
}

// RevokeForUser 批量吊销（登出/重放处置）
func (m *Memory) RevokeForUser(_ context.Context, userID, deviceID int64, all bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tokens {
		if t.UserID == userID && (all || t.DeviceID == deviceID) {
			t.Status = RefreshRevoked
		}
	}
	return nil
}

// Upsert 设备注册/激活（UK(user_id, did)）
func (m *Memory) Upsert(_ context.Context, d Device) (Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := didKey(d.UserID, d.DID)
	if id, ok := m.byDID[key]; ok {
		old := m.devices[id]
		old.DeviceName = d.DeviceName
		old.OS = d.OS
		old.LastActiveAt = d.LastActiveAt
		return *old, nil
	}
	if d.ID == 0 {
		d.ID = m.nextDev
		m.nextDev++
	}
	cp := d
	m.devices[d.ID] = &cp
	m.byDID[key] = d.ID
	return cp, nil
}

// FindByDID 查设备
func (m *Memory) FindByDID(_ context.Context, userID int64, did string) (*Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.byDID[didKey(userID, did)]; ok {
		cp := *m.devices[id]
		return &cp, nil
	}
	return nil, nil
}

// IsLocked 是否处于锁定窗口
func (m *Memory) IsLocked(_ context.Context, key string) (bool, time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.attempts[key]
	if !ok {
		return false, 0
	}
	if a.lockedTil.After(time.Now()) {
		return true, time.Until(a.lockedTil)
	}
	return false, 0
}

// RecordFailure 计数失败；达阈值锁定 lockTTL
func (m *Memory) RecordFailure(_ context.Context, key string, maxFails int, lockTTL time.Duration) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.attempts[key]
	if !ok {
		a = &attempt{}
		m.attempts[key] = a
	}
	a.fails++
	if a.fails >= maxFails {
		a.lockedTil = time.Now().Add(lockTTL)
	}
	return a.fails
}

// Reset 成功登录清零
func (m *Memory) Reset(_ context.Context, key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.attempts, key)
}

func didKey(userID int64, did string) string {
	return strconv.FormatInt(userID, 10) + "|" + did
}
