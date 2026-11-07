// rtc 模块装配（D02 §3 module.go 模式）：对外只暴露 rtcapi 接口。
package rtc

import (
	rtcapi "github.com/baobaowork/server/internal/rtc/api"
)

// Module rtc 模块外壳
type Module struct {
	svc *Service
}

// NewModule 装配（Registry 内存态；pusher 由 gateway hub 适配注入）
func NewModule(push rtcapi.Pusher, card CardSink, opts Options) *Module {
	return &Module{svc: New(NewRegistry(), push, card, opts)}
}

// API 对外服务接口（gateway 依赖）
func (m *Module) API() rtcapi.RTCService { return m.svc }
