package workdayrepo

import (
	"context"
	"sync"
	"time"
)

// Memory 内存实现（单测/无 PG 启动兜底）
type Memory struct {
	mu   sync.RWMutex
	rows map[int64]map[string]Override // tenantID → "YYYY-MM-DD" → row
}

var _ Repo = (*Memory)(nil)

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{rows: map[int64]map[string]Override{}}
}

func key(t time.Time) string { return t.UTC().Format("2006-01-02") }

// ListYear [from,to)
func (m *Memory) ListYear(_ context.Context, tenantID int64, from, to time.Time) ([]Override, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []Override{}
	byDay := m.rows[tenantID]
	for _, r := range byDay {
		if !r.Day.Before(from) && r.Day.Before(to) {
			out = append(out, r)
		}
	}
	return out, nil
}

// UpsertMany 批量覆盖
func (m *Memory) UpsertMany(_ context.Context, rows []Override) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range rows {
		byDay := m.rows[r.TenantID]
		if byDay == nil {
			byDay = map[string]Override{}
			m.rows[r.TenantID] = byDay
		}
		byDay[key(r.Day)] = r
	}
	return nil
}

// DeleteMany 删指定日期
func (m *Memory) DeleteMany(_ context.Context, tenantID int64, days []time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	byDay := m.rows[tenantID]
	if byDay == nil {
		return nil
	}
	for _, d := range days {
		delete(byDay, key(d))
	}
	return nil
}

// DeleteRange 删区间
func (m *Memory) DeleteRange(_ context.Context, tenantID int64, from, to time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	byDay := m.rows[tenantID]
	for k, r := range byDay {
		if !r.Day.Before(from) && r.Day.Before(to) {
			delete(byDay, k)
		}
	}
	return nil
}
