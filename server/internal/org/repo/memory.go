// Package orgrepo 组织域数据访问（D02 §3：repo 是唯一允许写 SQL 的层；本文件为内存实现）。
package orgrepo

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/baobaowork/server/internal/org/api"
)

// PG 实现占位（阶段二接入 pgx + sqlc）：
//   type Postgres struct{ pool *pgxpool.Pool }  // 实现 Repo 接口
//   查询强制走 RLS 会话变量 app.tenant（migrations/0001_init.sql 策略）。
// 替换 NewMemory() → NewPostgres(pool) 即可，service 无感知。

// Repo 组织域仓储接口（先内存后 PG，接口不变）
type Repo interface {
	orgapi.DeptTreeReaderWriter // 组织树（PAD-04；Memory/Postgres 均实现）
	CreateUser(ctx context.Context, u orgapi.User) (orgapi.User, error)
	GetUser(ctx context.Context, id int64) (*orgapi.User, error)
	GetUserByLogin(ctx context.Context, tenantID int64, username string) (*orgapi.User, error)

	// ── 管理端扩展（D10 阶段一务实版）──
	// ListUsers 用户列表（keyword 工号/姓名/邮箱模糊 + status + id 升序 cursor 翻页）；
	// 返回当页行 + has_more（多取一行探测）
	ListUsers(ctx context.Context, f orgapi.UserListFilter) ([]orgapi.User, bool, error)
	// CountUsers 用户总数（仪表盘指标）
	CountUsers(ctx context.Context, tenantID int64) (int64, error)
	// SetUserStatus 启用/禁用（orgapi.UserStatus*）；行不存在返回 ErrUserNotFound
	SetUserStatus(ctx context.Context, id int64, status int) error
}

// Memory 内存实现（阶段一：无 PG 依赖跑通全链路）
type Memory struct {
	mu      sync.RWMutex
	byID    map[int64]*orgapi.User
	byLogin map[string]int64 // key: tenantID + "|" + username（工号/邮箱/手机号统一登录名）
	nextID  int64

	deptMu  sync.RWMutex
	depts   map[int64]deptRow // dept 主键 → 行（含成员计数占位）
	deptSeq int64
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{
		depts: map[int64]deptRow{}, byID: map[int64]*orgapi.User{}, byLogin: map[string]int64{}, nextID: 10000}
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

// ListUsers 用户列表：keyword 子串匹配（大小写不敏感，对齐 PG ILIKE）+ status 过滤 + id 升序翻页
func (m *Memory) ListUsers(_ context.Context, f orgapi.UserListFilter) ([]orgapi.User, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]int64, 0, len(m.byID))
	for id := range m.byID {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	kw := strings.ToLower(f.Keyword)
	limit := f.LimitOrDefault()
	out := make([]orgapi.User, 0, limit)
	hasMore := false
	for _, id := range ids {
		u := m.byID[id]
		if f.TenantID != 0 && u.TenantID != f.TenantID {
			continue
		}
		if f.Cursor > 0 && id <= f.Cursor {
			continue
		}
		if f.Status != 0 && u.Status != f.Status {
			continue
		}
		if kw != "" && !strings.Contains(strings.ToLower(u.EmployeeNo), kw) &&
			!strings.Contains(strings.ToLower(u.DisplayName), kw) &&
			!strings.Contains(strings.ToLower(u.Email), kw) {
			continue
		}
		if len(out) >= limit { // 命中数已满仍继续标志位（无需真取下一行）
			hasMore = true
			break
		}
		cp := *u
		out = append(out, cp)
	}
	return out, hasMore, nil
}

// CountUsers 用户总数
func (m *Memory) CountUsers(_ context.Context, tenantID int64) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var n int64
	for _, u := range m.byID {
		if tenantID == 0 || u.TenantID == tenantID {
			n++
		}
	}
	return n, nil
}

// SetUserStatus 状态变更（启用/禁用）
func (m *Memory) SetUserStatus(_ context.Context, id int64, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.byID[id]
	if !ok {
		return orgapi.ErrUserNotFound
	}
	u.Status = status
	return nil
}

// ── 组织树内存实现（物化路径 /1/7/23/） ──

type deptRow struct {
	D           orgapi.Dept
	memberCount int
}

// Memory 组织树（嵌于既有 Memory——独立方法集）
func (m *Memory) CreateDept(_ context.Context, tenantID, parentID int64, name string, sort int) (*orgapi.DeptNode, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 50 {
		return nil, orgapi.ErrDeptName
	}
	m.deptMu.Lock()
	defer m.deptMu.Unlock()
	if parentID > 0 {
		p, ok := m.depts[parentID]
		if !ok || p.D.TenantID != tenantID {
			return nil, orgapi.ErrDeptNotFound
		}
	}
	m.deptSeq++
	d := orgapi.Dept{ID: m.deptSeq, TenantID: tenantID, ParentID: parentID, Name: name, Sort: sort}
	path := "/" + strconv.FormatInt(d.ID, 10) + "/"
	if parentID > 0 {
		path = m.depts[parentID].D.Path + strconv.FormatInt(d.ID, 10) + "/"
	}
	d.Path = path
	m.depts[d.ID] = deptRow{D: d}
	node := toNode(d)
	return &node, nil
}

func (m *Memory) ListTree(_ context.Context, tenantID int64) ([]orgapi.DeptNode, error) {
	m.deptMu.RLock()
	defer m.deptMu.RUnlock()
	nodes := map[int64]*orgapi.DeptNode{}
	roots := []orgapi.DeptNode{}
	order := []int64{}
	for id, d := range m.depts {
		if d.D.TenantID != tenantID {
			continue
		}
		n := toNode(d.D)
		nodes[id] = &n
		order = append(order, id)
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
	// 倒序装配（子先于父）：塞给父时自身 children 已完整——避免自顶向下副本链丢深层
	rootIDs := []int64{}
	for i := len(order) - 1; i >= 0; i-- {
		id := order[i]
		p := m.depts[id].D.ParentID
		if p > 0 {
			if pn, ok := nodes[p]; ok {
				pn.Children = append([]orgapi.DeptNode{*nodes[id]}, pn.Children...)
				continue
			}
		}
		rootIDs = append([]int64{id}, rootIDs...)
	}
	roots = make([]orgapi.DeptNode, 0, len(rootIDs))
	for _, id := range rootIDs {
		roots = append(roots, *nodes[id])
	}
	return roots, nil
}

func (m *Memory) RenameDept(_ context.Context, tenantID, deptID int64, name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 50 {
		return orgapi.ErrDeptName
	}
	m.deptMu.Lock()
	defer m.deptMu.Unlock()
	d, ok := m.depts[deptID]
	if !ok || d.D.TenantID != tenantID {
		return orgapi.ErrDeptNotFound
	}
	d.D.Name = name
	m.depts[deptID] = d
	return nil
}

func (m *Memory) DeleteDept(_ context.Context, tenantID, deptID int64) error {
	m.deptMu.Lock()
	defer m.deptMu.Unlock()
	d, ok := m.depts[deptID]
	if !ok || d.D.TenantID != tenantID {
		return orgapi.ErrDeptNotFound
	}
	// 有子部门或有挂人拒（user_dept 写侧阶段二接 PAD-07 交接——v0.1 成员计数恒 0）
	for _, c := range m.depts {
		if c.D.ParentID == deptID {
			return orgapi.ErrDeptNotEmpty
		}
	}
	delete(m.depts, deptID)
	_ = d
	return nil
}

func toNode(d orgapi.Dept) orgapi.DeptNode {
	return orgapi.DeptNode{ID: d.ID, ParentID: d.ParentID, Name: d.Name, Sort: d.Sort, Path: d.Path}
}
