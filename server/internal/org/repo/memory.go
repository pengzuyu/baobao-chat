// Package orgrepo 组织域数据访问（D02 §3：repo 是唯一允许写 SQL 的层；本文件为内存实现）。
package orgrepo

import (
	"context"
	"strconv"
	"sync"

	"github.com/baobaowork/server/internal/org/api"
)

// PG 实现占位（阶段二接入 pgx + sqlc）：
//   type Postgres struct{ pool *pgxpool.Pool }  // 实现 Repo 接口
//   查询强制走 RLS 会话变量 app.tenant（migrations/0001_init.sql 策略）。
// 替换 NewMemory() → NewPostgres(pool) 即可，service 无感知。

// Repo 组织域仓储接口（先内存后 PG，接口不变）
type Repo interface {
	CreateUser(ctx context.Context, u orgapi.User) (orgapi.User, error)
	GetUser(ctx context.Context, id int64) (*orgapi.User, error)
	GetUserByLogin(ctx context.Context, tenantID int64, username string) (*orgapi.User, error)
}

// Memory 内存实现（阶段一：无 PG 依赖跑通全链路）
type Memory struct {
	mu      sync.RWMutex
	byID    map[int64]*orgapi.User
	byLogin map[string]int64 // key: tenantID + "|" + username（工号/邮箱/手机号统一登录名）
	nextID  int64
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{byID: map[int64]*orgapi.User{}, byLogin: map[string]int64{}, nextID: 10000}
}

func loginKey(tenantID int64, username string) string {
	return strconv.FormatInt(tenantID, 10) + "|" + username
}

// CreateUser 落库；ID 为 0 时分配（雪花 ID 占位：自增，阶段二换雪花）
func (m *Memory) CreateUser(_ context.Context, u orgapi.User) (orgapi.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if u.ID == 0 {
		m.nextID++
		u.ID = m.nextID
	}
	cp := u
	m.byID[u.ID] = &cp
	// 登录名索引：工号 + 邮箱 + 手机号（03 篇 §2.1 任一可登录）
	for _, name := range []string{u.EmployeeNo, u.Email, u.Phone} {
		if name != "" {
			m.byLogin[loginKey(u.TenantID, name)] = u.ID
		}
	}
	return cp, nil
}

// GetUser 按 ID 查
func (m *Memory) GetUser(_ context.Context, id int64) (*orgapi.User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if u, ok := m.byID[id]; ok {
		cp := *u
		return &cp, nil
	}
	return nil, orgapi.ErrUserNotFound
}

// GetUserByLogin 登录名查（工号/邮箱/手机号）
func (m *Memory) GetUserByLogin(_ context.Context, tenantID int64, username string) (*orgapi.User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if id, ok := m.byLogin[loginKey(tenantID, username)]; ok {
		if u, ok2 := m.byID[id]; ok2 {
			cp := *u
			return &cp, nil
		}
	}
	return nil, orgapi.ErrUserNotFound
}
