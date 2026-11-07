// 内存实现。
package ecorepo

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Memory 生态域内存仓储
type Memory struct {
	mu    sync.Mutex
	seq   int64
	byID  map[int64]*Expert
	byXID map[string]int64 // tenant|expert_id → id
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{byID: map[int64]*Expert{}, byXID: map[string]int64{}}
}

var _ Repo = (*Memory)(nil)

func xkey(tenantID int64, expertID string) string {
	return string(rune('0'+tenantID%10)) + "|" + expertID // 单租户量级够用（PG 侧走 SQL）
}

func (m *Memory) Create(_ context.Context, e Expert) (Expert, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := xkey(e.TenantID, e.ExpertID)
	if _, dup := m.byXID[k]; dup {
		return Expert{}, ErrDupID
	}
	m.seq++
	e.ID = m.seq
	now := time.Now()
	e.CreatedAt, e.UpdatedAt = now, now
	cp := e
	m.byID[e.ID] = &cp
	m.byXID[k] = e.ID
	return e, nil
}

func (m *Memory) Get(_ context.Context, _, id int64) (*Expert, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.byID[id]; ok {
		out := *e
		return &out, nil
	}
	return nil, ErrNotFound
}

func (m *Memory) GetByExpertID(_ context.Context, tenantID int64, expertID string) (*Expert, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.byXID[xkey(tenantID, expertID)]; ok {
		out := *m.byID[id]
		return &out, nil
	}
	return nil, ErrNotFound
}

func (m *Memory) List(_ context.Context, _ int64, f ListFilter) ([]Expert, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Expert{}
	for _, e := range m.byID {
		if f.Source != 0 && e.Source != f.Source {
			continue
		}
		if f.Status != 0 && e.Status != f.Status {
			continue
		}
		if f.Owner != 0 && e.OwnerUserID != f.Owner {
			continue
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) UpdateStatus(_ context.Context, _, id int64, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.byID[id]; ok {
		e.Status = status
		e.UpdatedAt = time.Now()
		return nil
	}
	return ErrNotFound
}

func (m *Memory) UpdateManifest(_ context.Context, _, id int64, version, display, summary, manifest string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.byID[id]; ok {
		e.Version, e.Display, e.Summary, e.Manifest = version, display, summary, manifest
		e.UpdatedAt = time.Now()
		return nil
	}
	return ErrNotFound
}

func (m *Memory) Delete(_ context.Context, _, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.byID[id]; ok {
		delete(m.byID, id)
		delete(m.byXID, xkey(e.TenantID, e.ExpertID))
		return nil
	}
	return ErrNotFound
}
