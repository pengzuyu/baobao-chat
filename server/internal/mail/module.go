// mail 模块装配（D02 §3：构造注入）。
package mail

import (
	mailrepo "github.com/baobaochat/server/internal/mail/repo"
	mailservice "github.com/baobaochat/server/internal/mail/service"
)

// Module 邮件域模块
type Module struct {
	svc *mailservice.Service
}

// NewModule 装配（main 调用）
func NewModule(opts mailservice.Options, r mailrepo.Repo) *Module {
	return &Module{svc: mailservice.New(r, opts)}
}

// API 域服务（REST 壳依赖）
func (m *Module) API() *mailservice.Service { return m.svc }
