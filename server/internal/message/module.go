// Package message 模块装配（D02 §3 module.go）
package message

import (
	"github.com/baobaochat/server/internal/message/api"
	"github.com/baobaochat/server/internal/message/repo"
	"github.com/baobaochat/server/internal/message/service"
	"github.com/baobaochat/server/internal/platform/eventbus"
)

// Module message 模块外壳：对外只暴露 api
type Module struct {
	svc *messageservice.Service
}

// NewModule 装配（内存仓储；阶段二换 PG+Redis 时仅改此处）
func NewModule(r messagerepo.Repo, bus eventbus.Bus, opts messageservice.Options) *Module {
	return &Module{svc: messageservice.New(opts, r, bus)}
}

// API 对外服务接口（gateway 依赖）
func (m *Module) API() messageapi.MessageService { return m.svc }
