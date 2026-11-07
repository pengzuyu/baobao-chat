// meeting 模块装配（D02 §3：构造注入）。
package meeting

import (
	meetingrepo "github.com/baobaowork/server/internal/meeting/repo"
	meetingservice "github.com/baobaowork/server/internal/meeting/service"
)

// Module 会议域模块
type Module struct {
	svc *meetingservice.Service
}

// NewModule 装配（main 调用）
func NewModule(opts meetingservice.Options, r meetingrepo.Repo) *Module {
	return &Module{svc: meetingservice.New(r, opts)}
}

// API 域服务（REST 壳依赖）
func (m *Module) API() *meetingservice.Service { return m.svc }
