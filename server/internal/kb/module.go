// Package kb 模块装配（D02 §3 module.go；D07 阶段一务实版）。
package kb

import (
	kbapi "github.com/baobaowork/server/internal/kb/api"
	kbrepo "github.com/baobaowork/server/internal/kb/repo"
	kbservice "github.com/baobaowork/server/internal/kb/service"
)

// Module kb 模块外壳：对外只暴露 api
type Module struct {
	svc *kbservice.Service
}

// NewModule 装配（repo 为内存/PG 实现；opts 注入 EmbedFn 与文件读取通道）
func NewModule(opts kbservice.Options, r kbrepo.Repo) *Module {
	return &Module{svc: kbservice.New(opts, r)}
}

// API 对外服务接口（main REST 壳依赖）
func (m *Module) API() kbapi.KBService { return m.svc }
