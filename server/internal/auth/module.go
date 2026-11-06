// Package auth 模块装配（D02 §3 module.go）
package auth

import (
	"github.com/baobaowork/server/internal/auth/api"
	"github.com/baobaowork/server/internal/auth/repo"
	"github.com/baobaowork/server/internal/auth/service"
	"github.com/baobaowork/server/internal/org/api"
	"github.com/baobaowork/server/internal/platform/authjwt"
	"github.com/baobaowork/server/internal/platform/config"
)

// Module auth 模块外壳：对外只暴露 api（D02 §4 依赖规则）
type Module struct {
	svc *authservice.Service
}

// NewModule 装配：仓储经构造注入（PG 或内存，D02 §3 构造注入），service 无感知
func NewModule(users orgapi.UserReader, signer *authjwt.Signer, cfg *config.Config,
	tokens authrepo.RefreshTokenRepo, devices authrepo.DeviceRepo, attempts authrepo.LoginAttemptStore) *Module {
	opts := authservice.Options{
		AccessTTL:     cfg.AccessTTL,
		OBOTTL:        cfg.OBOTTL,
		RefreshTTL:    cfg.RefreshTTL,
		MaxLoginFails: cfg.LoginMaxFails,
		LockTTL:       cfg.LoginLockTTL,
	}
	return &Module{svc: authservice.New(opts, users, tokens, devices, attempts, signer)}
}

// API 对外服务接口
func (m *Module) API() authapi.AuthService { return m.svc }
