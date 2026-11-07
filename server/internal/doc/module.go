// Package doc 模块装配（D02 §3 module.go；D05 阶段一务实版）。
package doc

import (
	docapi "github.com/baobaowork/server/internal/doc/api"
	docrepo "github.com/baobaowork/server/internal/doc/repo"
	docservice "github.com/baobaowork/server/internal/doc/service"
)

// Module doc 模块外壳：对外只暴露 api
type Module struct {
	svc *docservice.Service
}

// NewModule 装配（repo 为内存/PG 实现）
func NewModule(opts docservice.Options, r docrepo.Repo) *Module {
	return &Module{svc: docservice.New(opts, r)}
}

// API 对外服务接口（main REST 壳依赖）
func (m *Module) API() docapi.DocService { return m.svc }
