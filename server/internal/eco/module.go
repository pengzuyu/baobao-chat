// eco 模块装配（D02 §3：构造注入）。
package eco

import (
	ecorepo "github.com/baobaochat/server/internal/eco/repo"
	ecoservice "github.com/baobaochat/server/internal/eco/service"
)

// Module 生态域模块
type Module struct {
	svc *ecoservice.Service
}

// NewModule 装配（main 调用；plugins 可 nil=插件面降级 9004）
func NewModule(r ecorepo.Repo, apps ecorepo.AppRepo, rollouts ecorepo.RolloutRepo, skills ecorepo.SkillRepo, plugins ecorepo.PluginRepo) *Module {
	return &Module{svc: ecoservice.New(r, apps, rollouts, skills, plugins)}
}

// API 域服务
func (m *Module) API() *ecoservice.Service { return m.svc }
