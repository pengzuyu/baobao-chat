// 内存实现：满足 Repo 接口（开发/测试装配）。
package acl

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Memory 资源授权内存仓储
type Memory struct {
	mu  sync.Mutex
	seq int64
	// key: resourceType|resourceID|grantType|grantTarget（uk 镜像）
	byKey map[string]*Entry
}

// NewMemory 构造
func NewMemory() *Memory { return &Memory{byKey: map[string]*Entry{}} }

var _ Repo = (*Memory)(nil)

func key(e Entry) string {
	return e.ResourceType + "|" + e.ResourceID + "|" +
		strconv.Itoa(e.GrantType) + "|" + strconv.FormatInt(e.GrantTarget, 10)
}

// Grant 落授权（uk 命中=覆盖 perm/expires，幂等）
func (m *Memory) Grant(_ context.Context, e Entry) (Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	e.ID = m.seq
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now()
	}
	cp := e
	m.byKey[key(e)] = &cp
	return e, nil
}

func (m *Memory) Revoke(_ context.Context, _, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, e := range m.byKey {
		if e.ID == id {
			delete(m.byKey, k)
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) ListGrants(_ context.Context, _ int64, f EntryFilter) ([]Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Entry{}
	for _, e := range m.byKey {
		if f.ResourceType != "" && e.ResourceType != f.ResourceType {
			continue
		}
		if f.ResourceID != "" && e.ResourceID != f.ResourceID {
			continue
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) EffectiveForUser(_ context.Context, _ int64,
	resourceType, resourceID string, userID int64, deptIDs, roleIDs []int64) ([]Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	depts := map[int64]bool{}
	for _, d := range deptIDs {
		depts[d] = true
	}
	roles := map[int64]bool{}
	for _, r := range roleIDs {
		roles[r] = true
	}
	now := time.Now()
	out := []Entry{}
	for _, e := range m.byKey {
		if e.ResourceType != resourceType || e.ResourceID != resourceID {
			continue
		}
		if !e.ExpiresAt.IsZero() && !e.ExpiresAt.After(now) {
			continue // 过期不参与
		}
		switch e.GrantType {
		case GrantUser:
			if e.GrantTarget != userID {
				continue
			}
		case GrantDept:
			if !depts[e.GrantTarget] {
				continue
			}
		case GrantRole:
			if !roles[e.GrantTarget] {
				continue
			}
		case GrantTenant:
			// 租户内公开：全员
		}
		out = append(out, *e)
	}
	return out, nil
}
