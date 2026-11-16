// model.go：内部模型——op.AuthRequest / op.Client / op.RefreshTokenRequest 三接口的
// bbw 实现（列字段持久化 + JSONB 快照，迁移 0038）。
package oidc

import (
	"time"

	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// authRequest 授权请求（列字段与迁移 0038 对应；audience/response_type 等低频
// 字段进 snapshot JSONB）。实现 op.AuthRequest。
type authRequest struct {
	ID       string `json:"id"`
	ClientID string `json:"client_id"`
	// RedirectURI 含 query/fragment（redirect 校验由库做精确匹配），存 snapshot
	RedirectURI        string             `json:"redirect_uri"`
	State              string             `json:"state"`
	Nonce              string             `json:"nonce"`
	ResponseType       oidc.ResponseType  `json:"response_type"`
	ResponseMode       oidc.ResponseMode  `json:"response_mode,omitempty"`
	Scopes             []string           `json:"scopes"`
	Audience           []string           `json:"audience,omitempty"`
	CodeChallenge      string             `json:"code_challenge,omitempty"`
	CodeChallengeMethod string            `json:"code_challenge_method,omitempty"`
	UserID             string             `json:"user_id,omitempty"` // 认领后回填（字符串化 uid）
	Completed          bool               `json:"done"`              // 接口方法 Done() 的持久化载体
	AMR                []string           `json:"amr,omitempty"`
	AuthTime           time.Time          `json:"auth_time"`
}

func (a *authRequest) GetID() string                     { return a.ID }
func (a *authRequest) GetACR() string                    { return "" }
func (a *authRequest) GetAMR() []string                  { return a.AMR }
func (a *authRequest) GetAudience() []string             { return a.Audience }
func (a *authRequest) GetAuthTime() time.Time            { return a.AuthTime }
func (a *authRequest) GetClientID() string               { return a.ClientID }
func (a *authRequest) GetCodeChallenge() *oidc.CodeChallenge {
	if a.CodeChallenge == "" {
		return nil
	}
	return &oidc.CodeChallenge{Challenge: a.CodeChallenge, Method: oidc.CodeChallengeMethod(a.CodeChallengeMethod)}
}
func (a *authRequest) GetNonce() string             { return a.Nonce }
func (a *authRequest) GetRedirectURI() string       { return a.RedirectURI }
func (a *authRequest) GetResponseType() oidc.ResponseType { return a.ResponseType }
func (a *authRequest) GetResponseMode() oidc.ResponseMode { return a.ResponseMode }
func (a *authRequest) GetScopes() []string          { return a.Scopes }
func (a *authRequest) GetState() string             { return a.State }
func (a *authRequest) GetSubject() string           { return a.UserID }
func (a *authRequest) Done() bool                   { return a.Completed }

// client 客户端（oidc_client 行 → op.Client）。一期只开 public client（PKCE-only，
// D28 §9 开放问题 4），LoginURL 定向到 bbw 等待页（§5.2）。
type client struct {
	id            string
	secretHash    string
	name          string
	redirectURIs  []string
	scopes        []string
	grantTypes    []oidc.GrantType
	accessTTL     time.Duration
	refreshTTL    time.Duration
	loginURL      func(string) string
	isPKCEOnly    bool
}

func (c *client) GetID() string                { return c.id }
func (c *client) RedirectURIs() []string       { return c.redirectURIs }
func (c *client) PostLogoutRedirectURIs() []string { return nil }
func (c *client) ApplicationType() op.ApplicationType { return op.ApplicationTypeWeb }
func (c *client) AuthMethod() oidc.AuthMethod {
	if c.isPKCEOnly {
		return oidc.AuthMethodNone
	}
	return oidc.AuthMethodBasic
}
func (c *client) ResponseTypes() []oidc.ResponseType {
	return []oidc.ResponseType{oidc.ResponseTypeCode}
}
func (c *client) GrantTypes() []oidc.GrantType { return c.grantTypes }
func (c *client) LoginURL(id string) string    { return c.loginURL(id) }
func (c *client) AccessTokenType() op.AccessTokenType {
	return op.AccessTokenTypeJWT // per-app JWT（iss/aud/sub/scope，jwks 本地验签——D28 §2.3）
}
func (c *client) IDTokenLifetime() time.Duration { return time.Hour }
func (c *client) DevMode() bool                  { return false }
func (c *client) RestrictAdditionalIdTokenScopes() func(scopes []string) []string {
	return func(scopes []string) []string { return scopes }
}
func (c *client) RestrictAdditionalAccessTokenScopes() func(scopes []string) []string {
	return func(scopes []string) []string { return scopes }
}
func (c *client) IsScopeAllowed(scope string) bool {
	for _, s := range c.scopes {
		if s == scope {
			return true
		}
	}
	return false
}
func (c *client) IDTokenUserinfoClaimsAssertion() bool { return false }
func (c *client) ClockSkew() time.Duration             { return 0 }

// refreshReq op.RefreshTokenRequest 实现（oidc_refresh_token.claims 快照还原）。
type refreshReq struct {
	subject   string
	audience  []string
	scopes    []string
	amr       []string
	authTime  time.Time
	clientID  string
}

func (r *refreshReq) GetSubject() string           { return r.subject }
func (r *refreshReq) GetAudience() []string        { return r.audience }
func (r *refreshReq) GetScopes() []string          { return r.scopes }
func (r *refreshReq) GetAMR() []string             { return r.amr }
func (r *refreshReq) GetAuthTime() time.Time       { return r.authTime }
func (r *refreshReq) GetClientID() string          { return r.clientID }
func (r *refreshReq) SetCurrentScopes(s []string)  { r.scopes = s }
