// Package admin 管理域模块装配（D10 阶段一务实版；D02 §3 构造注入，禁止全局单例）。
package admin

import (
	"github.com/baobaowork/server/internal/admin/api"
	"github.com/baobaowork/server/internal/admin/repo"
	"github.com/baobaowork/server/internal/admin/service"
	"github.com/baobaowork/server/internal/org/api"
)

// Module admin 模块外壳
type Module struct {
	svc   *adminservice.Service
	store adminrepo.Repo
}

// NewModule 装配（users/reader=org 域两接口；跨域统计与副作用闭包见 service.Options）
func NewModule(users orgapi.UserAdminReader, reader orgapi.UserReader, store adminrepo.Repo, roles adminrepo.RoleRepo, notices adminrepo.NoticeRepo, opts adminservice.Options) *Module {
	return &Module{svc: adminservice.New(users, reader, store, roles, notices, opts), store: store}
}

// API 对外服务接口（main 路由壳消费）
func (m *Module) API() adminapi.AdminService { return m.svc }

// Store 仓储透出（main 装配 message 域敏感词热更闭包用——词库属 admin 域权威源）
func (m *Module) Store() adminrepo.Repo { return m.store }
