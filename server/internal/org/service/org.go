// Package orgservice 组织域业务逻辑（阶段一：用户读取；组织树/异动引擎见 D12，阶段二）
package orgservice

import (
	"context"

	"github.com/baobaowork/server/internal/org/api"
	"github.com/baobaowork/server/internal/org/repo"
)

// Service 实现 orgapi.UserReader
type Service struct {
	repo orgrepo.Repo
}

// New 构造（依赖注入，禁止全局单例——D02 §3）
func New(r orgrepo.Repo) *Service { return &Service{repo: r} }

// compile-time 接口断言
var _ orgapi.UserReader = (*Service)(nil)
var _ orgapi.UserAdminReader = (*Service)(nil)
var _ orgapi.DeptScopeReader = (*Service)(nil)

// GetUserByLogin 登录名查用户
func (s *Service) GetUserByLogin(ctx context.Context, tenantID int64, username string) (*orgapi.User, error) {
	return s.repo.GetUserByLogin(ctx, tenantID, username)
}

// GetUser 按 ID 查用户
func (s *Service) GetUser(ctx context.Context, id int64) (*orgapi.User, error) {
	return s.repo.GetUser(ctx, id)
}

// ── 管理端扩展（D10 阶段一务实版；透传仓储，业务约束由 admin 域施加）──

// ListUsers 用户列表（keyword/status/cursor 翻页）
func (s *Service) ListUsers(ctx context.Context, f orgapi.UserListFilter) ([]orgapi.User, bool, error) {
	return s.repo.ListUsers(ctx, f)
}

// CountUsers 用户总数
func (s *Service) CountUsers(ctx context.Context, tenantID int64) (int64, error) {
	return s.repo.CountUsers(ctx, tenantID)
}

// SetUserStatus 启用/禁用
func (s *Service) SetUserStatus(ctx context.Context, id int64, status int) error {
	return s.repo.SetUserStatus(ctx, id, status)
}

// SetPassword 改密+清首登标志（D11；hash 由 auth 域闭包生成，透传仓储）
func (s *Service) SetPassword(ctx context.Context, tenantID, userID int64, passwordHash string) error {
	return s.repo.SetPassword(ctx, tenantID, userID, passwordHash)
}

// ── 部门归属读（kb 三层知识检索消费；orgapi.DeptScopeReader 实现）──

// UserDeptIDsOf 用户直接所属部门集 + 主部门 ID（primary=0 表示未挂任何部门）
func (s *Service) UserDeptIDsOf(ctx context.Context, tenantID, userID int64) (map[int64]bool, int64, error) {
	rows, err := s.repo.ListUserDepts(ctx, tenantID, userID)
	if err != nil {
		return nil, 0, err
	}
	ids := make(map[int64]bool, len(rows))
	primary := int64(0)
	for _, r := range rows {
		ids[r.DeptID] = true
		if r.IsPrimary {
			primary = r.DeptID
		}
	}
	if primary == 0 && len(rows) > 0 {
		primary = rows[0].DeptID // 无主标记时取首行兜底（数据防御）
	}
	return ids, primary, nil
}

// UserDeptChainOf 用户可见部门集 = 直接部门 ∪ 各部门祖先链（深度无关：
// 沿 parent 向上取并集；visited 防环兜底脏数据；未挂部门=空集）
func (s *Service) UserDeptChainOf(ctx context.Context, tenantID, userID int64) (map[int64]bool, error) {
	direct, _, err := s.UserDeptIDsOf(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	chain := make(map[int64]bool, len(direct)*2)
	if len(direct) == 0 {
		return chain, nil
	}
	// ListTree 为嵌套树（根数组+Children）：一次深度遍历展平为 parent 映射
	parent := make(map[int64]int64)
	var walk func(n orgapi.DeptNode, parentID int64)
	walk = func(n orgapi.DeptNode, parentID int64) {
		if _, dup := parent[n.ID]; dup {
			return // 重复/环防御：首见即登记
		}
		parent[n.ID] = parentID
		for _, c := range n.Children {
			walk(c, n.ID)
		}
	}
	tree, err := s.repo.ListTree(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, r := range tree {
		walk(r, 0)
	}
	for d := range direct {
		cur, visited := d, map[int64]bool{}
		for cur != 0 && !visited[cur] {
			visited[cur] = true
			chain[cur] = true
			cur = parent[cur] // 未知部门（已删/跨租户）→ 缺项 0 终止
		}
	}
	return chain, nil
}
