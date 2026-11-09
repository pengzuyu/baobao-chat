// Package agentbackuprepo 内存仓储（单测/开发；ID 从 1 自增，与 PG advisory lock max+1 语义一致）。
package agentbackuprepo

import (
	"context"
	"sync"
	"time"
)

// Memory 内存版备份索引
type Memory struct {
	mu     sync.Mutex
	rows   map[int64]*Row
	nextID int64
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{rows: map[int64]*Row{}, nextID: 1}
}

// Insert 落行（幂等冲突 → ErrDuplicateIdem）
func (m *Memory) Insert(_ context.Context, r Row) (Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r.IdempotencyKey != "" {
		for _, ex := range m.rows {
			if ex.UserID == r.UserID && ex.IdempotencyKey == r.IdempotencyKey {
				return Row{}, ErrDuplicateIdem
			}
		}
	}
	cp := r
	cp.ID = m.nextID
	m.nextID++
	if cp.CreatedAt.IsZero() {
		cp.CreatedAt = time.Now()
	}
	m.rows[cp.ID] = &cp
	return cp, nil
}

// GetByIdempotency 幂等命中查询
func (m *Memory) GetByIdempotency(_ context.Context, userID int64, key string) (*Row, error) {
	if key == "" {
		return nil, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.rows {
		if ex.UserID == userID && ex.IdempotencyKey == key {
			cp := *ex
			return &cp, nil
		}
	}
	return nil, nil
}

// Get 行详情
func (m *Memory) Get(_ context.Context, id int64) (*Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rows[id]; ok {
		cp := *r
		return &cp, nil
	}
	return nil, ErrNotFound
}

// ListByUser 我的备份（created_at 倒序）
func (m *Memory) ListByUser(_ context.Context, tenantID, userID int64) ([]Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Row{}
	for _, r := range m.rows {
		if r.TenantID == tenantID && r.UserID == userID {
			out = append(out, *r)
		}
	}
	// 等时稳定排序：id 降序兜底（与 PG created_at DESC, id DESC 对齐）
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].CreatedAt.After(out[i].CreatedAt) ||
				(out[j].CreatedAt.Equal(out[i].CreatedAt) && out[j].ID > out[i].ID) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out, nil
}

// Delete 删行
func (m *Memory) Delete(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.rows[id]; !ok {
		return ErrNotFound
	}
	delete(m.rows, id)
	return nil
}
