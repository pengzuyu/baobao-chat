// DeliveryRepo 内存实现（开发/测试；生产 PG 见 delivery_pg.go 同文件集）。
package botrepo

import (
	"context"
	"sort"
	"sync"
	"time"
)

// MemoryDeliveries Outgoing 投递内存仓储
type MemoryDeliveries struct {
	mu  sync.Mutex
	seq int64
	dl  map[int64]*Delivery
}

// NewMemoryDeliveries 构造
func NewMemoryDeliveries() *MemoryDeliveries {
	return &MemoryDeliveries{dl: map[int64]*Delivery{}}
}

var _ DeliveryRepo = (*MemoryDeliveries)(nil)

func (m *MemoryDeliveries) InsertDelivery(_ context.Context, d Delivery) (Delivery, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.dl {
		if ex.TenantID == d.TenantID && ex.EventID == d.EventID {
			return Delivery{}, ErrDupDelivery
		}
	}
	m.seq++
	d.ID = m.seq
	if d.CreatedAt.IsZero() {
		d.CreatedAt = time.Now()
	}
	if d.Status == 0 {
		d.Status = 1
	}
	cp := d
	m.dl[d.ID] = &cp
	return d, nil
}

func (m *MemoryDeliveries) GetDelivery(_ context.Context, _, id int64) (*Delivery, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.dl[id]; ok {
		out := *d
		return &out, nil
	}
	return nil, ErrNotFound
}

func (m *MemoryDeliveries) UpdateDeliveryAttempt(_ context.Context, _, id int64,
	attempt, responseCode int, errBrief string, nextRetry time.Time, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.dl[id]
	if !ok {
		return ErrNotFound
	}
	d.Attempt = attempt
	d.ResponseCode = responseCode
	d.ErrorBrief = errBrief
	d.NextRetryAt = nextRetry
	d.Status = status
	return nil
}

func (m *MemoryDeliveries) DueDeliveries(_ context.Context, _ int64, now time.Time, limit int) ([]Delivery, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Delivery{}
	for _, d := range m.dl {
		if d.Status != 1 {
			continue
		}
		if !d.NextRetryAt.IsZero() && d.NextRetryAt.After(now) {
			continue
		}
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *MemoryDeliveries) ListDeliveries(_ context.Context, _ int64, f DeliveryFilter) ([]Delivery, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Delivery{}
	for _, d := range m.dl {
		if f.BotID != 0 && d.BotID != f.BotID {
			continue
		}
		if f.WebhookID != 0 && d.WebhookID != f.WebhookID {
			continue
		}
		if f.Status != 0 && d.Status != f.Status {
			continue
		}
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID }) // 新Record 前
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}

func (m *MemoryDeliveries) ReplayDelivery(_ context.Context, _, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.dl[id]
	if !ok || d.Status != 3 {
		return ErrNotFound
	}
	d.Status = 1
	d.Attempt = 0
	d.NextRetryAt = time.Time{}
	d.ErrorBrief = ""
	return nil
}
