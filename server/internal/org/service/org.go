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
