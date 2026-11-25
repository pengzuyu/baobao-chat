// module.go：OIDC Provider 装配（D28 拍板 8：单体内模块，挂 bbc-server /oauth2/*）。
// zitadel/oidc v3 op.NewProvider + 我们的 Storage；等待页/web-login 同子树先行注册
// （std mux 最长前缀优先，未命中的落 provider——authorize/token/jwks/discovery/userinfo/
// introspection/revoke 全由库路由）。
package oidc

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/zitadel/oidc/v3/pkg/op"
	"golang.org/x/text/language"

	authservice "github.com/baobaochat/server/internal/auth/service"
	"github.com/baobaochat/server/internal/platform/agentjwt"
	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

type Module struct {
	storage        *Storage
	auth           *authservice.Service
	provider       *op.Provider
	callbackURL    func(context.Context, string) string
	defaultTenant  int64
	insecure       bool   // issuer 为 http（本地联调）时 cookie 不加 Secure
	brandName      string // 品牌显示名（D31；等待页文案）
	deepLinkScheme string // 深链 scheme（D31；与客户端 brand.json 对齐，默认 bbc）
}

// New 装配 OIDC 模块。signingKey 为单源装载的签名私钥（D38 批2：main 经
// agentjwt.LoadKey 注入，未配置=开发态临时密钥+警告——agent 票与 OIDC 登录票
// 同一把密钥，生态应用经 jwks 验 agent 票，双密钥即验签失配，不再各自兜底）。
// brandName/deepLinkScheme 为 D31 白标参数（空回落 BaobaoChat/bbc）。
func New(db *pgxpool.Pool, auth *authservice.Service, issuer string, signingKey *ecdsa.PrivateKey, brandName, deepLinkScheme string, defaultTenant int64) (*Module, error) {
	if brandName == "" {
		brandName = "BaobaoChat"
	}
	if deepLinkScheme == "" {
		deepLinkScheme = "bbc"
	}
	if signingKey == nil {
		return nil, errors.New("oidc: 签名密钥未装载（单源入口 agentjwt.LoadKey）")
	}
	key := signingKey
	insecure := strings.HasPrefix(issuer, "http://")
	stor := newStorage(db, auth, key, defaultTenant)

	cfg := &op.Config{
		CryptoKey:                deriveCryptoKey(key),
		CryptoKeyId:              agentjwt.KidFor(&key.PublicKey),
		CodeMethodS256:           true, // PKCE S256 强制（public client）
		AuthMethodPost:           true,
		GrantTypeRefreshToken:    true,
		DefaultLogoutRedirectURI: "/oauth2/wait",
		SupportedUILocales:       []language.Tag{language.Chinese, language.English},
	}
	opts := []op.Option{
		// 库默认 token/introspection 路径含 /oauth 前缀，与挂载点 /oauth2 叠加成
		// /oauth2/oauth/token——拍平为 /oauth2/token 与 /oauth2/introspection
		op.WithCustomTokenEndpoint(op.NewEndpoint("token")),
		op.WithCustomIntrospectionEndpoint(op.NewEndpoint("introspection")),
	}
	if insecure {
		opts = append(opts, op.WithAllowInsecure())
	}
	provider, err := op.NewProvider(cfg, stor, op.StaticIssuer(issuer), opts...)
	if err != nil {
		return nil, fmt.Errorf("oidc: 构建 Provider: %w", err)
	}
	// 回跳绝对地址直拼 issuer（op.AuthCallbackURL 依赖请求上下文注入 issuer——
	// 我们的等待页处理器不在 provider 管辖内，上下文缺 issuer 时返回相对路径，
	// 浏览器跟跳会落到挂载点外 404；单 issuer 静态直拼最稳）
	callbackBase := strings.TrimSuffix(issuer, "/") + "/authorize/callback?id="
	return &Module{
		storage:        stor,
		auth:           auth,
		provider:       provider,
		callbackURL:    func(_ context.Context, id string) string { return callbackBase + url.QueryEscape(id) },
		defaultTenant:  defaultTenant,
		insecure:       insecure,
		brandName:      brandName,
		deepLinkScheme: deepLinkScheme,
	}, nil
}

// Handler /oauth2 子树：等待页/web-login + provider（authorize/token/jwks/discovery/...）。
func (m *Module) Handler() http.Handler {
	sub := http.NewServeMux()
	m.registerWebRoutes(sub)
	sub.Handle("/", m.provider) // 库默认相对路径：/authorize /token /.well-known/... /keys 等
	return sub
}

func i64toa(v int64) string { return strconv.FormatInt(v, 10) }

// ── oidc_client CRUD 存储（admin 面）─────────────────────────────────────────

func (s *Storage) createClient(r *http.Request, name string, redirectURIs, scopes []string, createdBy int64) (*clientDTO, error) {
	ctx := r.Context()
	// client_id：bbc- + 8 位随机（一期 public client=PKCE-only，不签 secret——D28 §9-4）
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		return nil, err
	}
	clientID := "bbc-" + hex.EncodeToString(suffix)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	id, err := bbcpg.AllocID(ctx, tx, lockKeyOIDCClient, "oidc_client")
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO oidc_client (id, tenant_id, client_id, name, redirect_uris, scopes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		id, s.defaultTenant, clientID, name, mustJSON(redirectURIs), mustJSON(scopes), createdBy)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &clientDTO{ID: id, ClientID: clientID, Name: name, RedirectURIs: redirectURIs, Scopes: scopes, Status: "active"}, nil
}

func (s *Storage) listClients(r *http.Request) []clientDTO {
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `
		SELECT id, client_id, name, redirect_uris, scopes, status, created_at
		FROM oidc_client WHERE tenant_id=$1 ORDER BY id DESC`, s.defaultTenant)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []clientDTO
	for rows.Next() {
		var dto clientDTO
		var redirect, scopes []byte
		var created time.Time
		if err := rows.Scan(&dto.ID, &dto.ClientID, &dto.Name, &redirect, &scopes, &dto.Status, &created); err != nil {
			continue
		}
		_ = json.Unmarshal(redirect, &dto.RedirectURIs)
		_ = json.Unmarshal(scopes, &dto.Scopes)
		dto.CreatedAt = created.Format(time.RFC3339)
		out = append(out, dto)
	}
	return out
}

func (s *Storage) setClientStatus(r *http.Request, id int64, status string) error {
	tag, err := s.db.Exec(r.Context(), `UPDATE oidc_client SET status=$2, updated_at=now() WHERE id=$1 AND tenant_id=$3`,
		id, status, s.defaultTenant)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("客户端不存在")
	}
	return nil
}

// updateClient 编辑（name/redirect_uris/scopes 全量覆盖；client_id 恒定不可改）。
// GetClientByClientID 每次查库（clientRow），改动即时生效无缓存失效问题。
func (s *Storage) updateClient(r *http.Request, id int64, name string, redirectURIs, scopes []string) (*clientDTO, error) {
	ctx := r.Context()
	tag, err := s.db.Exec(ctx, `UPDATE oidc_client SET name=$2, redirect_uris=$3, scopes=$4, updated_at=now() WHERE id=$1 AND tenant_id=$5`,
		id, name, mustJSON(redirectURIs), mustJSON(scopes), s.defaultTenant)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, errors.New("客户端不存在")
	}
	var dto clientDTO
	var redirect, scopesB []byte
	var created time.Time
	err = s.db.QueryRow(ctx, `
		SELECT id, client_id, name, redirect_uris, scopes, status, created_at
		FROM oidc_client WHERE id=$1 AND tenant_id=$2`, id, s.defaultTenant).
		Scan(&dto.ID, &dto.ClientID, &dto.Name, &redirect, &scopesB, &dto.Status, &created)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(redirect, &dto.RedirectURIs)
	_ = json.Unmarshal(scopesB, &dto.Scopes)
	dto.CreatedAt = created.Format(time.RFC3339)
	return &dto, nil
}
