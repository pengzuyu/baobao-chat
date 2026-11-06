// Package org 模块装配（D02 §3 module.go：构造函数注入，禁止全局单例）
package org

import (
	"github.com/baobaowork/server/internal/org/api"
	"github.com/baobaowork/server/internal/org/repo"
	"github.com/baobaowork/server/internal/org/service"
)

// Module org 模块外壳：只暴露 api 层能力给其他模块（依赖规则 D02 §4）
type Module struct {
	svc *orgservice.Service
}

// NewModule 装配
func NewModule(r orgrepo.Repo) *Module {
	return &Module{svc: orgservice.New(r)}
}

// API 对外只读接口（auth 依赖此实现登录）
func (m *Module) API() orgapi.UserReader { return m.svc }
