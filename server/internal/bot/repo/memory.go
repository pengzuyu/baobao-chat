// 内存仓储（无 BBW_DB_DSN 回退 + 单元测试）。
package botrepo

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"
)

// ErrNotFound 统一未找到（服务层映射 3030/9001）
var ErrNotFound = errors.New("botrepo: not found")

type store struct {
	mu        sync.RWMutex
	nextID    int64
	bots      map[int64]Bot
	hooks     map[int64]Webhook // webhook 主键 → 记录
	hookIndex map[string]int64  // hook_id → webhook 主键
}

// NewMemory 内存仓储
func NewMemory() Repo {
	return &store{
		nextID:    100,
		bots:      map[int64]Bot{},
		hooks:     map[int64]Webhook{},
		hookIndex: map[string]int64{},
	}
}

func (s *store) CreateBot(_ context.Context, b Bot) (Bot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	b.ID = s.nextID
	if b.CreatedAt.IsZero() {
		b.CreatedAt = time.Now()
	}
	s.bots[b.ID] = b
	return b, nil
}

func (s *store) GetBot(_ context.Context, tenantID, botID int64) (*Bot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.bots[botID]
	if !ok || b.TenantID != tenantID {
		return nil, ErrNotFound
	}
	bc := b
	return &bc, nil
}

func (s *store) GetBotByUser(_ context.Context, tenantID, userID int64) (*Bot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, b := range s.bots {
		if b.TenantID == tenantID && b.UserID == userID {
			bc := b
			return &bc, nil
		}
	}
	return nil, ErrNotFound
}

func (s *store) ListBots(_ context.Context, tenantID int64, status int) ([]Bot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Bot{}
	for _, b := range s.bots {
		if b.TenantID != tenantID && tenantID != 0 {
			continue
		}
		if status != 0 && b.Status != status {
			continue
		}
		out = append(out, b)
	}
	return out, nil
}

func (s *store) UpdateBotStatus(_ context.Context, tenantID, botID int64, status int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.bots[botID]
	if !ok || b.TenantID != tenantID {
		return ErrNotFound
	}
	b.Status = status
	s.bots[botID] = b
	return nil
}

func (s *store) CreateWebhook(_ context.Context, w Webhook) (Webhook, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	w.ID = s.nextID
	if w.CreatedAt.IsZero() {
		w.CreatedAt = time.Now()
	}
	s.hooks[w.ID] = w
	s.hookIndex[w.HookID] = w.ID
	return w, nil
}

func (s *store) GetWebhook(_ context.Context, tenantID, webhookID int64) (*Webhook, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	w, ok := s.hooks[webhookID]
	if !ok || w.TenantID != tenantID {
		return nil, ErrNotFound
	}
	wc := w
	return &wc, nil
}

func (s *store) GetWebhookByHookID(_ context.Context, hookID string) (*Webhook, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.hookIndex[hookID]
	if !ok {
		return nil, ErrNotFound
	}
	w := s.hooks[id]
	wc := w
	return &wc, nil
}

func (s *store) RotateWebhookSecret(_ context.Context, tenantID, webhookID int64, newSecret, prevSecret string, prevExpiresAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.hooks[webhookID]
	if !ok || w.TenantID != tenantID {
		return ErrNotFound
	}
	w.Secret = newSecret
	w.PrevSecret = prevSecret
	w.PrevExpiresAt = prevExpiresAt
	w.RotatedAt = time.Now()
	s.hooks[webhookID] = w
	return nil
}

// ListWebhooks 按方向列（direction 空=全部；id 升序稳定）
func (m *store) ListWebhooks(_ context.Context, tenantID int64, direction string) ([]Webhook, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]int64, 0, len(m.hooks))
	for id := range m.hooks {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := []Webhook{}
	for _, id := range ids {
		w := m.hooks[id]
		if w.TenantID != tenantID {
			continue
		}
		if direction != "" && w.Direction != direction {
			continue
		}
		out = append(out, w)
	}
	return out, nil
}

// UpdateWebhookStatus 订阅停启用
func (m *store) UpdateWebhookStatus(_ context.Context, _, webhookID int64, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if w, ok := m.hooks[webhookID]; ok {
		w.Status = status
		m.hooks[webhookID] = w
		return nil
	}
	return ErrNotFound
}
