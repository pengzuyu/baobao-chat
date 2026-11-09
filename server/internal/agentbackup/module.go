// Package agentbackup 模块装配（D02 §3 module.go 模式；sticker 同款最小壳）。
package agentbackup

import (
	agentbackupapi "github.com/baobaowork/server/internal/agentbackup/api"
	agentbackuprepo "github.com/baobaowork/server/internal/agentbackup/repo"
	agentbackupservice "github.com/baobaowork/server/internal/agentbackup/service"
)

// Module agent 备份模块外壳：对外只暴露 api
type Module struct {
	svc *agentbackupservice.Service
}

// NewModule 装配
func NewModule(opts agentbackupservice.Options, r agentbackuprepo.Repo) *Module {
	return &Module{svc: agentbackupservice.New(opts, r)}
}

// API 对外服务接口（REST 壳依赖）
func (m *Module) API() agentbackupapi.Service { return m.svc }
