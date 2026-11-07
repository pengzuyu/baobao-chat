// bot 模块装配（D02 §3：构造注入）。
package bot

import (
	botapi "github.com/baobaowork/server/internal/bot/api"
	"github.com/baobaowork/server/internal/bot/repo"
	botservice "github.com/baobaowork/server/internal/bot/service"
)

// Module 机器人域模块
type Module struct {
	svc *botservice.Service
}

// NewModule 装配（main 调用）
func NewModule(opts botservice.Options, r botrepo.Repo) *Module {
	return &Module{svc: botservice.NewService(opts, r)}
}

// API 域服务（REST 壳依赖）
func (m *Module) API() botapi.BotService { return m.svc }
