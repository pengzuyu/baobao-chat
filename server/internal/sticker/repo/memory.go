// Package stickerrepo 内存实现（无 PG 依赖跑通全链路，D02 §3）。
package stickerrepo

import (
	"context"
	"sync"
	"time"
)

// Memory 内存仓储
type Memory struct {
	mu         sync.Mutex
	nextSetID  int64
	nextItemID int64
	sets       map[int64]*Set
	items      map[int64]*Item // 全量；按 set 过滤
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{sets: map[int64]*Set{}, items: map[int64]*Item{}}
}

func (m *Memory) InsertSet(_ context.Context, s Set) (Set, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextSetID++
	s.ID = m.nextSetID
	if s.Status == 0 {
		s.Status = 1
	}
	s.CreatedAt = time.Now()
	m.sets[s.ID] = &s
	return s, nil
}

func (m *Memory) GetSet(_ context.Context, id int64) (*Set, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sets[id]; ok {
		cp := *s
		return &cp, nil
	}
	return nil, ErrNotFound
}

func (m *Memory) ListSets(_ context.Context, tenantID int64) ([]Set, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Set{}
	for _, s := range m.sets {
		if s.TenantID == tenantID {
			out = append(out, *s)
		}
	}
	return out, nil
}

func (m *Memory) UpdateSetStatus(_ context.Context, id int64, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sets[id]; ok {
		s.Status = status
		return nil
	}
	return ErrNotFound
}

func (m *Memory) UpdateSetCover(_ context.Context, id, coverFileID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sets[id]; ok {
		s.CoverFileID = coverFileID
		return nil
	}
	return ErrNotFound
}

func (m *Memory) DeleteSet(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sets[id]; !ok {
		return ErrNotFound
	}
	delete(m.sets, id)
	for iid, it := range m.items {
		if it.SetID == id {
			delete(m.items, iid)
		}
	}
	return nil
}

func (m *Memory) InsertItem(_ context.Context, it Item) (Item, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, x := range m.items {
		if x.SetID == it.SetID && x.FileID == it.FileID {
			return Item{}, ErrDupItem
		}
	}
	m.nextItemID++
	it.ID = m.nextItemID
	it.CreatedAt = time.Now()
	m.items[it.ID] = &it
	return it, nil
}

func (m *Memory) GetItem(_ context.Context, id int64) (*Item, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if it, ok := m.items[id]; ok {
		cp := *it
		return &cp, nil
	}
	return nil, ErrNotFound
}

func (m *Memory) ListItemsOfSets(_ context.Context, setIDs []int64) ([]Item, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := map[int64]bool{}
	for _, id := range setIDs {
		want[id] = true
	}
	out := []Item{}
	for _, it := range m.items {
		if want[it.SetID] {
			out = append(out, *it)
		}
	}
	return out, nil
}

func (m *Memory) DeleteItem(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.items[id]; !ok {
		return ErrNotFound
	}
	delete(m.items, id)
	return nil
}
