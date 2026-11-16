// Package authapi 认证域对外接口与 DTO（D02 §3 接口风格示例的本模块落地版）。
// 令牌模型：docs/03-身份认证与权限体系.md §2.2；OBO：§6。
package authapi

import (
	"context"

	"github.com/baobaochat/server/internal/platform/authjwt"
)

// LoginReq 口令登录请求（14 篇 §5.1：写操作幂等键阶段二接 Idempotency-Key）
type LoginReq struct {
	TenantID   int64  `json:"tenant_id"`
	Account    string `json:"account"`  // 工号/邮箱/手机号（客户端字段名；兼容 username）
	Username   string `json:"username"` // 兼容旧字段：Account 为空时回退
	Password   string `json:"password"`
	DID        string `json:"did"` // 设备 ID（refresh 设备绑定）
	DeviceName string `json:"device_name"`
	OS         string `json:"os"`
}

// LoginAccount 取登录账号（account 优先，兼容 username）
func (r LoginReq) LoginAccount() string {
	if r.Account != "" {
		return r.Account
	}
	return r.Username
}

// LoginUser 登录返回的用户信息（camel，对齐客户端 AuthUser）
type LoginUser struct {
	UID   string   `json:"uid"`
	Name  string   `json:"name"`
	Perms []string `json:"perms"`
	// 首登强制改密（0029/D11）：导入用户置位——前端登录二步改密表单
	MustChangePwd bool `json:"must_change_pwd,omitempty"`
}

// RefreshReq 刷新请求（一次性轮换）
type RefreshReq struct {
	RefreshToken string `json:"refresh_token"`
	DID          string `json:"did"`
}

// OBOReq OBO 签发请求（scope 必须是用户权限子集）
type OBOReq struct {
	AgentSessionID string   `json:"agent_session_id"`
	Scope          []string `json:"scope"`
}

// TokenPair access + refresh（refresh 仅登录/刷新响应出现，其余接口只收 access）
type TokenPair struct {
	AccessToken  string     `json:"access_token"`
	RefreshToken string     `json:"refresh_token"`
	ExpiresIn    int64      `json:"expires_in"`     // access 有效期（秒）
	ExpiresAt    int64      `json:"expires_at"`     // 到期时间戳（ms），客户端静默刷新调度用
	User         *LoginUser `json:"user,omitempty"` // 登录者信息（uid/name/perms）
}

// AuthService 认证服务接口（依赖规则：其他模块只 import 本包）
type AuthService interface {
	Login(ctx context.Context, req LoginReq) (*TokenPair, error)
	Refresh(ctx context.Context, req RefreshReq) (*TokenPair, error)
	Logout(ctx context.Context, userID int64, did string, all bool) error
	IssueOBO(ctx context.Context, actorUserID int64, req OBOReq) (string, error)
	Verify(ctx context.Context, token string) (*authjwt.Claims, error) // gateway/httpx 装配用
	// ChangePassword 改密（D11：旧密码校验→更新 hash→清 must_change）
	ChangePassword(ctx context.Context, tenantID, userID int64, oldPwd, newPwd string) error
}

// ChangePwdReq POST /me/password
type ChangePwdReq struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}
