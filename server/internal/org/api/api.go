// Package orgapi 组织域对外接口与 DTO（D02 §3：api = Go interface + DTO，跨模块只允许 import 本包）。
// 模型来源：docs/03-身份认证与权限体系.md §3/§8。
package orgapi

import (
	"context"
	"errors"
)

// ErrUserNotFound 用户不存在（服务内 sentinel；对外映射 9002/2005 由调用方决定）
var ErrUserNotFound = errors.New("orgapi: user not found")

// 用户状态（03 篇 §8 user.status）
const (
	UserStatusActive   = 1
	UserStatusDisabled = 2
)

// 用户类型（20 篇：bot 也是 user）
const (
	UserTypeHuman = 1
	UserTypeBot   = 2
)

// User 用户实体（口令哈希仅 auth 域消费；其余模块不得读取）
type User struct {
	ID           int64    `json:"id"`
	TenantID     int64    `json:"tenant_id"`
	Type         int      `json:"type"`
	EmployeeNo   string   `json:"employee_no"`
	DisplayName  string   `json:"display_name"`
	Email        string   `json:"email,omitempty"`
	Phone        string   `json:"phone,omitempty"`
	PasswordHash string   `json:"-"` // 不序列化外泄
	Status       int      `json:"status"`
	Scopes       []string `json:"scopes,omitempty"` // RBAC 权限点摘要（03 篇 §4.1）
}

// Dept 部门（树 + 物化路径，03 篇 §3.1；阶段一仅定义占位）
type Dept struct {
	ID       int64  `json:"id"`
	TenantID int64  `json:"tenant_id"`
	ParentID int64  `json:"parent_id"`
	Name     string `json:"name"`
	Path     string `json:"path"` // 如 /1/7/23/，前缀匹配判"本部门及以下"
	Sort     int    `json:"sort"`
	Status   int    `json:"status"`
}

// UserReader auth 等模块依赖的最小只读接口（依赖规则 D02 §4：只 import api）
type UserReader interface {
	GetUserByLogin(ctx context.Context, tenantID int64, username string) (*User, error)
	GetUser(ctx context.Context, id int64) (*User, error)
}

// UserListFilter 管理端用户列表过滤（D10 阶段一务实版）：
// keyword 匹配工号/姓名/邮箱（模糊，大小写不敏感）；status 0=全部 1=启用 2=禁用；
// cursor=上一页末条 id（id 升序翻页），0=首页；limit≤0 或 >100 取 20。
type UserListFilter struct {
	TenantID int64
	Keyword  string
	Status   int
	Cursor   int64
	Limit    int
}

// LimitOrDefault limit 归一（缺省/越界取 20，上限 100）
func (f UserListFilter) LimitOrDefault() int {
	if f.Limit <= 0 || f.Limit > 100 {
		return 20
	}
	return f.Limit
}

// UserAdminReader 管理端用户管理最小接口（D10 阶段一务实版；admin 域经本接口
// 消费 org 域——依赖规则 D02 §4：跨模块只 import api 包）。
type UserAdminReader interface {
	// ListUsers 用户列表（keyword/status/cursor；返回当页行 + has_more）
	ListUsers(ctx context.Context, f UserListFilter) ([]User, bool, error)
	// CountUsers 用户总数
	CountUsers(ctx context.Context, tenantID int64) (int64, error)
	// SetUserStatus 启用/禁用（UserStatus*）；不存在返回 ErrUserNotFound
	SetUserStatus(ctx context.Context, id int64, status int) error
}
