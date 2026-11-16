// Package org 模块装配（D02 §3 module.go：构造函数注入，禁止全局单例）
package org

import (
	"github.com/baobaochat/server/internal/org/api"
	"github.com/baobaochat/server/internal/org/repo"
	"github.com/baobaochat/server/internal/org/service"
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

// AdminAPI 管理端用户管理接口（D10 admin 域消费；依赖规则 D02 §4 只经 api 包）
func (m *Module) AdminAPI() orgapi.UserAdminReader { return m.svc }

// DeptScopeAPI 部门归属读（kb 三层知识检索经 main 闭包消费；同上依赖规则）
func (m *Module) DeptScopeAPI() orgapi.DeptScopeReader { return m.svc }

// DirectoryAPI 通讯录检索（2026-11-12 登录页公开搜人：工号/姓名/拼音模糊+分页；
// 返回具体类型供 main 公开路由直调）
func (m *Module) DirectoryAPI() *orgservice.Service { return m.svc }
