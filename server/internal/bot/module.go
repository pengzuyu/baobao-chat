// bot 模块装配（D02 §3：构造注入）。
package bot

import (
	botapi "github.com/baobaowork/server/internal/bot/api"
	"github.com/baobaowork/server/internal/bot/repo"
	botservice "github.com/baobaowork/server/internal/bot/service"
)

// Module 机器人域模块
type Module struct {
	svc      *botservice.Service
	outgoing *botservice.Outgoing
}

// NewModule 装配（main 调用；deliveries 为 nil 时 Outgoing 不可用——
// 阶段二投递仓由 main 注入，阶段一装配兼容缺省）
func NewModule(opts botservice.Options, r botrepo.Repo, deliveries botrepo.DeliveryRepo) *Module {
	m := &Module{svc: botservice.NewService(opts, r)}
	if deliveries != nil {
		m.outgoing = botservice.NewOutgoing(opts, r, deliveries)
	}
	return m
}

// Outgoing 投递引擎（main 订阅 TopicMsgCreated + go Run；nil=未装配）
func (m *Module) Outgoing() *botservice.Outgoing { return m.outgoing }

// API 域服务（REST 壳依赖）
func (m *Module) API() botapi.BotService { return m.svc }
