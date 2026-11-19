// Package workday 工作日日历模块装配（D02 §3 module.go 模式；sticker 同款最小壳）。
package workday

import (
	workdayapi "github.com/baobaochat/server/internal/workday/api"
	workdayrepo "github.com/baobaochat/server/internal/workday/repo"
	workdayservice "github.com/baobaochat/server/internal/workday/service"
)

// Module 工作日日历模块外壳：对外只暴露 api
type Module struct {
	svc *workdayservice.Service
}

// NewModule 装配
func NewModule(opts workdayservice.Options, r workdayrepo.Repo) *Module {
	return &Module{svc: workdayservice.New(opts, r)}
}

// API 对外服务接口（REST 壳依赖）
func (m *Module) API() workdayapi.Service { return m.svc }
