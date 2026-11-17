// storage.go：zitadel/oidc v3 op.Storage 的 PG 实现（迁移 0038 六表）。
// 口径（D28）：per-app access = JWT（aud=client，jwks 本地验签）；refresh = opaque
// 一次性轮换（与内部 auth.refresh_token 同语义，按 client 维度分表）；scope 收敛
// =应用白名单（client.IsScopeAllowed，库侧拦）∩ 用户有效权限（此处 CreateAccessToken 拦）。
package oidc

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authservice "github.com/baobaochat/server/internal/auth/service"
	"github.com/baobaochat/server/internal/org/api"
	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// advisory lock 段（eco 用 91xx，oidc 取 9150-9153 防撞）
const (
	lockKeyOIDCGrant   int64 = 9150
	lockKeyOIDCRefresh int64 = 9151
	lockKeyOIDCSession int64 = 9152
	lockKeyOIDCClient  int64 = 9153
)

// 标准保留 scope（openid/profile/email/offline_access 不做用户权限收敛）
var reservedScopes = map[string]bool{"openid": true, "profile": true, "email": true, "offline_access": true}

type Storage struct {
	db            *pgxpool.Pool
	auth          *authservice.Service
	signingKey    esSigningKey
	now           func() time.Time
	defaultTenant int64
	accessTTL     time.Duration
	refreshTTL    time.Duration
	sessionTTL    time.Duration
}

func newStorage(db *pgxpool.Pool, auth *authservice.Service, key *ecdsa.PrivateKey, defaultTenant int64) *Storage {
	return &Storage{
		db:            db,
		auth:          auth,
		signingKey:    esSigningKey{key: key},
		now:           time.Now,
		defaultTenant: defaultTenant,
		accessTTL:     15 * time.Minute,
		refreshTTL:    30 * 24 * time.Hour,
		sessionTTL:    7 * 24 * time.Hour, // v0.2 拍板 7：IdP 浏览器会话滑动窗口
	}
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

func sha256hex(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func randToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("oidc: rand: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func randID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("oidc: rand: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

var errNotFound = errors.New("not found")

// ── AuthStorage：授权请求生命周期 ────────────────────────────────────────────

func (s *Storage) CreateAuthRequest(ctx context.Context, req *oidc.AuthRequest, userID string) (op.AuthRequest, error) {
	if len(req.Prompt) == 1 && req.Prompt[0] == "none" {
		return nil, oidc.ErrLoginRequired() // Q1 纯 web 路径无法静默登录
	}
	c, err := s.clientRow(ctx, s.defaultTenant, req.ClientID)
	if err != nil || c.Status != "active" {
		return nil, fmt.Errorf("client 不可用: %s", req.ClientID)
	}
	ar := &authRequest{
		ID:                  randID(),
		ClientID:            req.ClientID,
		RedirectURI:         req.RedirectURI,
		State:               req.State,
		Nonce:               req.Nonce,
		ResponseType:        req.ResponseType,
		ResponseMode:        req.ResponseMode,
		Scopes:              []string(req.Scopes),
		CodeChallenge:       req.CodeChallenge,
		CodeChallengeMethod: string(req.CodeChallengeMethod),
		UserID:              userID,
	}
	// 6 位确认码（D28 §5.1）：明文存——等待页与 desktop 确认卡都要重新展示（双端
	// 核对的锚点就是展示值本身）；机密性不靠它（300s 短命 + 确认动作用 desktop
	// access token 鉴权）
	_, err = s.db.Exec(ctx, `
		INSERT INTO oidc_auth_request (id, tenant_id, client_id, scopes, nonce, state, code_challenge, code_challenge_m, confirm_code, snapshot, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
		ar.ID, s.defaultTenant, ar.ClientID, mustJSON(ar.Scopes), ar.Nonce, ar.State,
		ar.CodeChallenge, ar.CodeChallengeMethod, genConfirmCode(), mustJSON(ar))
	if err != nil {
		return nil, fmt.Errorf("oidc: 存授权请求: %w", err)
	}
	return ar, nil
}

// genConfirmCode 密码学随机 6 位数字（000000-999999，%06d 补零）
func genConfirmCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		panic("oidc: rand: " + err.Error())
	}
	return fmt.Sprintf("%06d", n.Int64())
}

func (s *Storage) loadAuthRequest(ctx context.Context, id string) (*authRequest, error) {
	var snap []byte
	if err := s.db.QueryRow(ctx, `SELECT snapshot FROM oidc_auth_request WHERE id=$1`, id).Scan(&snap); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	ar := &authRequest{}
	if err := json.Unmarshal(snap, ar); err != nil {
		return nil, err
	}
	return ar, nil
}

func (s *Storage) AuthRequestByID(ctx context.Context, id string) (op.AuthRequest, error) {
	return s.loadAuthRequest(ctx, id)
}

func (s *Storage) AuthRequestByCode(ctx context.Context, code string) (op.AuthRequest, error) {
	var id string
	err := s.db.QueryRow(ctx, `SELECT id FROM oidc_auth_request WHERE code_hash=$1`, sha256hex(code)).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errors.New("code invalid or expired")
		}
		return nil, err
	}
	return s.loadAuthRequest(ctx, id)
}

func (s *Storage) SaveAuthCode(ctx context.Context, id string, code string) error {
	_, err := s.db.Exec(ctx, `UPDATE oidc_auth_request SET code_hash=$2 WHERE id=$1`, id, sha256hex(code))
	return err
}

func (s *Storage) DeleteAuthRequest(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM oidc_auth_request WHERE id=$1`, id)
	return err
}

// completeAuthRequest 等待页/web 登录/desktop 确认三种认领共用（§5.1-§5.3）：
// 回填用户并置 done。amr 区分认领通道（pwd=账密 / desktop-confirm=桌面确认卡）。
func (s *Storage) completeAuthRequest(ctx context.Context, id, userID string, amr []string) error {
	ar, err := s.loadAuthRequest(ctx, id)
	if err != nil {
		return err
	}
	uid, _ := strconv.ParseInt(userID, 10, 64)
	// scope 收敛 + 禁用拦截（Q3 补：SSO 会话直达路径此前不查用户状态——被禁用户
	// 持存活浏览器会话仍可授权新应用）
	if u, err := s.auth.UserByID(ctx, uid); err == nil {
		if u.Status != orgapi.UserStatusActive {
			return errors.New("用户已禁用")
		}
		ar.Scopes = s.intersectScopes(ctx, ar.Scopes, u)
	}
	ar.UserID = userID
	ar.Completed = true
	ar.AMR = amr
	ar.AuthTime = s.now()
	_, err = s.db.Exec(ctx, `UPDATE oidc_auth_request SET user_id=$2, snapshot=$3, status='approved', auth_time=$4, approved_at=now() WHERE id=$1`,
		id, uid, mustJSON(ar), ar.AuthTime)
	if err != nil {
		return err
	}
	// 授权记录在认领时即写（Q2 修：此前只在 offline_access refresh 流才 upsert——
	// 码路径授权不落 grant，覆盖判定永远 false；三种认领通道统一记录）
	s.upsertGrant(ctx, ar.ClientID, userID, ar.Scopes)
	return nil
}

func (s *Storage) intersectScopes(ctx context.Context, scopes []string, u *orgapi.User) []string {
	eff := map[string]bool{}
	for _, sc := range s.auth.EffectiveScopesForUser(ctx, u) {
		eff[sc] = true
	}
	out := make([]string, 0, len(scopes))
	for _, sc := range scopes {
		if reservedScopes[sc] || eff[sc] {
			out = append(out, sc)
		}
	}
	return out
}

// ── AuthStorage：令牌签发 ────────────────────────────────────────────────────

func (s *Storage) CreateAccessToken(ctx context.Context, request op.TokenRequest) (string, time.Time, error) {
	clientID, subject := tokenRequestInfo(request)
	accessID, exp, err := s.insertAccessToken(ctx, clientID, subject, request, 0)
	if err != nil {
		return "", time.Time{}, err
	}
	return accessID, exp, nil
}

func (s *Storage) CreateAccessAndRefreshTokens(ctx context.Context, request op.TokenRequest, currentRefreshToken string) (string, string, time.Time, error) {
	clientID, subject := tokenRequestInfo(request)
	if currentRefreshToken == "" {
		// 授权码流首签：新 refresh + access + grant 记录
		refreshValue, refreshID, err := s.insertRefreshToken(ctx, clientID, subject, request, 0)
		if err != nil {
			return "", "", time.Time{}, err
		}
		accessID, exp, err := s.insertAccessToken(ctx, clientID, subject, request, refreshID)
		if err != nil {
			return "", "", time.Time{}, err
		}
		s.upsertGrant(ctx, clientID, subject, request.GetScopes())
		return accessID, refreshValue, exp, nil
	}
	// 刷新流：一次性轮换（旧值置 rotated，新行 rotated_from 指旧——与内部 refresh 同语义）
	var oldID int64
	if err := s.db.QueryRow(ctx, `SELECT id FROM oidc_refresh_token WHERE token_hash=$1`, sha256hex(currentRefreshToken)).Scan(&oldID); err != nil {
		return "", "", time.Time{}, errors.New("invalid refresh_token")
	}
	if _, err := s.db.Exec(ctx, `UPDATE oidc_refresh_token SET status='rotated' WHERE id=$1`, oldID); err != nil {
		return "", "", time.Time{}, err
	}
	refreshValue, refreshID, err := s.insertRefreshToken(ctx, clientID, subject, request, oldID)
	if err != nil {
		return "", "", time.Time{}, err
	}
	accessID, exp, err := s.insertAccessToken(ctx, clientID, subject, request, refreshID)
	if err != nil {
		return "", "", time.Time{}, err
	}
	return accessID, refreshValue, exp, nil
}

// tokenRequestInfo 各请求形态取 client/subject（*authRequest / *refreshReq 两形态）
func tokenRequestInfo(request op.TokenRequest) (clientID, subject string) {
	switch t := request.(type) {
	case *authRequest:
		return t.ClientID, t.UserID
	case *refreshReq:
		return t.clientID, t.subject
	default:
		return request.GetSubject(), request.GetSubject()
	}
}

func (s *Storage) insertAccessToken(ctx context.Context, clientID, subject string, request op.TokenRequest, refreshID int64) (string, time.Time, error) {
	uid, _ := strconv.ParseInt(subject, 10, 64)
	scopes := request.GetScopes()
	amr := []string{}
	var authTime time.Time
	if r, ok := request.(*refreshReq); ok {
		amr, authTime = r.amr, r.authTime
	} else if r, ok := request.(*authRequest); ok {
		amr, authTime = r.AMR, r.AuthTime
	}
	// 权限收敛（同 completeAuthRequest 口径——防 refresh 流绕过）
	if u, err := s.auth.UserByID(ctx, uid); err == nil {
		scopes = s.intersectScopes(ctx, scopes, u)
	}
	id := randID()
	exp := s.now().Add(s.accessTTL)
	_, err := s.db.Exec(ctx, `
		INSERT INTO oidc_access_token (id, tenant_id, user_id, client_id, scopes, audience, amr, auth_time, refresh_id, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		id, s.defaultTenant, uid, clientID, mustJSON(scopes), mustJSON(request.GetAudience()), mustJSON(amr), authTime, nullIfZero(refreshID), exp)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("oidc: 存 access: %w", err)
	}
	return id, exp, nil
}

func (s *Storage) insertRefreshToken(ctx context.Context, clientID, subject string, request op.TokenRequest, rotatedFrom int64) (string, int64, error) {
	uid, _ := strconv.ParseInt(subject, 10, 64)
	value := randToken()
	amr := []string{}
	var authTime time.Time
	if r, ok := request.(*refreshReq); ok {
		amr, authTime = r.amr, r.authTime
	} else if r, ok := request.(*authRequest); ok {
		amr, authTime = r.AMR, r.AuthTime
	}
	claims := map[string]any{
		"subject": subject, "client_id": clientID, "scopes": request.GetScopes(),
		"audience": request.GetAudience(), "amr": amr, "auth_time": authTime,
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback(ctx)
	id, err := bbcpg.AllocID(ctx, tx, lockKeyOIDCRefresh, "oidc_refresh_token")
	if err != nil {
		return "", 0, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO oidc_refresh_token (id, tenant_id, user_id, client_id, token_hash, claims, rotated_from, status, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
		id, s.defaultTenant, uid, clientID, sha256hex(value), mustJSON(claims), nullIfZero(rotatedFrom), s.now().Add(s.refreshTTL))
	if err != nil {
		return "", 0, fmt.Errorf("oidc: 存 refresh: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return "", 0, err
	}
	return value, id, nil
}

func (s *Storage) upsertGrant(ctx context.Context, clientID, subject string, scopes []string) {
	uid, _ := strconv.ParseInt(subject, 10, 64)
	tag, err := s.db.Exec(ctx, `UPDATE oidc_grant SET scopes=$3, last_used_at=now(), revoked_at=NULL WHERE user_id=$1 AND client_id=$2`,
		uid, clientID, mustJSON(scopes))
	if err == nil && tag.RowsAffected() > 0 {
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	id, err := bbcpg.AllocID(ctx, tx, lockKeyOIDCGrant, "oidc_grant")
	if err != nil {
		return
	}
	tx.Exec(ctx, `INSERT INTO oidc_grant (id, tenant_id, user_id, client_id, scopes) VALUES ($1,$2,$3,$4,$5)`,
		id, s.defaultTenant, uid, clientID, mustJSON(scopes))
	tx.Commit(ctx)
}

func nullIfZero(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func (s *Storage) TokenRequestByRefreshToken(ctx context.Context, refreshToken string) (op.RefreshTokenRequest, error) {
	var claims []byte
	var expiresAt time.Time
	var status string
	err := s.db.QueryRow(ctx, `SELECT claims, expires_at, status FROM oidc_refresh_token WHERE token_hash=$1`, sha256hex(refreshToken)).
		Scan(&claims, &expiresAt, &status)
	if err != nil {
		return nil, errors.New("invalid refresh_token")
	}
	if status != "active" || s.now().After(expiresAt) {
		return nil, errors.New("refresh_token 已失效")
	}
	c := struct {
		Subject  string   `json:"subject"`
		ClientID string   `json:"client_id"`
		Scopes   []string `json:"scopes"`
		Audience []string `json:"audience"`
		AMR      []string `json:"amr"`
		AuthTime time.Time `json:"auth_time"`
	}{}
	if err := json.Unmarshal(claims, &c); err != nil {
		return nil, err
	}
	return &refreshReq{subject: c.Subject, audience: c.Audience, scopes: c.Scopes, amr: c.AMR, authTime: c.AuthTime, clientID: c.ClientID}, nil
}

func (s *Storage) TerminateSession(ctx context.Context, userID string, clientID string) error {
	uid, _ := strconv.ParseInt(userID, 10, 64)
	_, err := s.db.Exec(ctx, `UPDATE oidc_refresh_token SET status='revoked' WHERE user_id=$1 AND client_id=$2`, uid, clientID)
	return err
}

func (s *Storage) RevokeToken(ctx context.Context, tokenOrTokenID string, userID string, clientID string) *oidc.Error {
	// 库的 Revoke 流程（op/token_revocation.go）：refresh 场景经 GetRefreshTokenInfo 转成
	// 「tokenID=refresh 行 id + userID 非空」，与 access 场景（tokenID=access 行 id）入参
	// 不可区分——两路都执行，哪个命中灭哪个；未命中静默（RFC 7009 不泄露存在性）
	if _, err := s.db.Exec(ctx, `UPDATE oidc_access_token SET revoked=true WHERE id=$1`, tokenOrTokenID); err != nil {
		return oidc.ErrServerError().WithDescription("%s", err.Error())
	}
	if rid, err := strconv.ParseInt(tokenOrTokenID, 10, 64); err == nil {
		if _, err := s.db.Exec(ctx, `UPDATE oidc_refresh_token SET status='revoked' WHERE id=$1`, rid); err == nil {
			s.db.Exec(ctx, `UPDATE oidc_access_token SET revoked=true WHERE refresh_id=$1`, rid)
		}
	}
	return nil
}

func (s *Storage) GetRefreshTokenInfo(ctx context.Context, clientID string, token string) (string, string, error) {
	var userID int64
	var id int64
	err := s.db.QueryRow(ctx, `SELECT user_id, id FROM oidc_refresh_token WHERE token_hash=$1`, sha256hex(token)).Scan(&userID, &id)
	if err != nil {
		return "", "", op.ErrInvalidRefreshToken
	}
	return strconv.FormatInt(userID, 10), strconv.FormatInt(id, 10), nil
}

// ── AuthStorage：签名密钥（静态 ES256，手工轮换=换 env）──────────────────────

func (s *Storage) SigningKey(context.Context) (op.SigningKey, error) { return s.signingKey, nil }
func (s *Storage) SignatureAlgorithms(context.Context) ([]jose.SignatureAlgorithm, error) {
	return []jose.SignatureAlgorithm{jose.ES256}, nil
}
func (s *Storage) KeySet(context.Context) ([]op.Key, error) {
	return []op.Key{esPublicKey{key: s.signingKey.key}}, nil
}

// ── OPStorage ────────────────────────────────────────────────────────────────

type clientRow struct {
	ID          int64
	TenantID    int64
	ClientID    string
	SecretHash  string
	Name        string
	Redirect    []string
	Scopes      []string
	GrantTypes  []string
	Status      string
}

func (s *Storage) clientRow(ctx context.Context, tenantID int64, clientID string) (*clientRow, error) {
	r := &clientRow{}
	var redirect, scopes, grants []byte
	err := s.db.QueryRow(ctx, `
		SELECT id, tenant_id, client_id, client_secret_hash, name, redirect_uris, scopes, grant_types, status
		FROM oidc_client WHERE tenant_id=$1 AND client_id=$2`, tenantID, clientID).
		Scan(&r.ID, &r.TenantID, &r.ClientID, &r.SecretHash, &r.Name, &redirect, &scopes, &grants, &r.Status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal(redirect, &r.Redirect)
	_ = json.Unmarshal(scopes, &r.Scopes)
	_ = json.Unmarshal(grants, &r.GrantTypes)
	return r, nil
}

func (s *Storage) GetClientByClientID(ctx context.Context, clientID string) (op.Client, error) {
	r, err := s.clientRow(ctx, s.defaultTenant, clientID)
	if err != nil {
		return nil, fmt.Errorf("client %s 不存在", clientID)
	}
	return clientFromRow(r), nil
}

func clientFromRow(r *clientRow) *client {
	gts := make([]oidc.GrantType, 0, len(r.GrantTypes))
	for _, g := range r.GrantTypes {
		gts = append(gts, oidc.GrantType(g))
	}
	return &client{
		id:           r.ClientID,
		secretHash:   r.SecretHash,
		name:         r.Name,
		redirectURIs: r.Redirect,
		scopes:       r.Scopes,
		grantTypes:   gts,
		loginURL:     func(id string) string { return "/oauth2/wait?id=" + id },
		isPKCEOnly:   r.SecretHash == "",
	}
}

func (s *Storage) AuthorizeClientIDSecret(ctx context.Context, clientID, clientSecret string) error {
	r, err := s.clientRow(ctx, s.defaultTenant, clientID)
	if err != nil || r.SecretHash == "" || r.SecretHash != sha256hex(clientSecret) {
		return errors.New("client secret 不匹配")
	}
	return nil
}

func (s *Storage) SetUserinfoFromScopes(ctx context.Context, userinfo *oidc.UserInfo, userID, clientID string, scopes []string) error {
	return nil // deprecated（库注释口径：留空实现）
}

func (s *Storage) SetUserinfoFromRequest(ctx context.Context, userinfo *oidc.UserInfo, request op.IDTokenRequest, scopes []string) error {
	return s.fillUserinfo(ctx, userinfo, request.GetSubject(), scopes)
}

func (s *Storage) SetUserinfoFromToken(ctx context.Context, userinfo *oidc.UserInfo, tokenID, subject, origin string) error {
	return s.fillUserinfo(ctx, userinfo, subject, nil)
}

func (s *Storage) fillUserinfo(ctx context.Context, userinfo *oidc.UserInfo, subject string, scopes []string) error {
	uid, err := strconv.ParseInt(subject, 10, 64)
	if err != nil {
		return err
	}
	u, err := s.auth.UserByID(ctx, uid)
	if err != nil {
		return err
	}
	userinfo.Subject = subject
	userinfo.Name = u.DisplayName
	userinfo.PreferredUsername = u.EmployeeNo
	if u.Email != "" {
		userinfo.Email = u.Email
		userinfo.EmailVerified = oidc.Bool(true)
	}
	return nil
}

func (s *Storage) SetIntrospectionFromToken(ctx context.Context, introspection *oidc.IntrospectionResponse, tokenID, subject, clientID string) error {
	var scopes []byte
	var expiresAt time.Time
	var revoked bool
	var uid int64
	err := s.db.QueryRow(ctx, `SELECT scopes, expires_at, revoked, user_id FROM oidc_access_token WHERE id=$1`, tokenID).
		Scan(&scopes, &expiresAt, &revoked, &uid)
	if err != nil {
		return err
	}
	introspection.Active = !revoked && s.now().Before(expiresAt)
	introspection.Subject = subject
	introspection.ClientID = clientID
	var sc []string
	_ = json.Unmarshal(scopes, &sc)
	introspection.Scope = sc
	u, err := s.auth.UserByID(ctx, uid)
	if err == nil {
		introspection.Username = u.EmployeeNo
	}
	return nil
}

func (s *Storage) GetPrivateClaimsFromScopes(ctx context.Context, userID, clientID string, scopes []string) (map[string]any, error) {
	uid, _ := strconv.ParseInt(userID, 10, 64)
	if u, err := s.auth.UserByID(ctx, uid); err == nil {
		return map[string]any{"tenant": u.TenantID}, nil
	}
	return nil, nil
}

func (s *Storage) GetKeyByIDAndClientID(ctx context.Context, keyID, clientID string) (*jose.JSONWebKey, error) {
	return nil, errors.New("private_key_jwt 未启用")
}

func (s *Storage) ValidateJWTProfileScopes(ctx context.Context, userID string, scopes []string) ([]string, error) {
	return scopes, nil
}

func (s *Storage) Health(ctx context.Context) error { return s.db.Ping(ctx) }

// ── desktop 确认链（§5.1，批次 Q2）──────────────────────────────────────────

const confirmTTL = 300 * time.Second // 未决授权请求存活期（03 §2.1.1）

type confirmInfo struct {
	ClientID string
	AppName  string
	Scopes   []string
	Code6    string
	Status   string
	Age      time.Duration
}

// confirmInfo 确认卡数据：应用名/scope/6 位码/状态（desktop GET 展示）。
func (s *Storage) confirmInfo(ctx context.Context, reqID string) (*confirmInfo, error) {
	var clientID, code, status string
	var scopes []byte
	var created time.Time
	err := s.db.QueryRow(ctx, `SELECT client_id, scopes, confirm_code, status, created_at FROM oidc_auth_request WHERE id=$1`, reqID).
		Scan(&clientID, &scopes, &code, &status, &created)
	if err != nil {
		return nil, errNotFound
	}
	info := &confirmInfo{ClientID: clientID, Code6: code, Status: status, Age: s.now().Sub(created)}
	_ = json.Unmarshal(scopes, &info.Scopes)
	if c, err := s.clientRow(ctx, s.defaultTenant, clientID); err == nil {
		info.AppName = c.Name
	}
	return info, nil
}

// grantCovered 用户对该应用的既有授权是否覆盖所申请 scope（标准保留 scope 恒覆盖）；
// 命中则 desktop 确认卡降级轻量形态（免 6 位码，D28 §5.1）。
func (s *Storage) grantCovered(ctx context.Context, userID int64, clientID string, scopes []string) bool {
	var granted []byte
	var revoked *time.Time
	err := s.db.QueryRow(ctx, `SELECT scopes, revoked_at FROM oidc_grant WHERE user_id=$1 AND client_id=$2`, userID, clientID).
		Scan(&granted, &revoked)
	if err != nil || revoked != nil {
		return false
	}
	owned := map[string]bool{}
	var gs []string
	_ = json.Unmarshal(granted, &gs)
	for _, g := range gs {
		owned[g] = true
	}
	for _, sc := range scopes {
		if reservedScopes[sc] || owned[sc] {
			continue
		}
		return false
	}
	return true
}

// waitStatus 等待页轮询：只回状态不回身份（public 端点）。
func (s *Storage) waitStatus(ctx context.Context, reqID string) string {
	var status string
	var created time.Time
	if err := s.db.QueryRow(ctx, `SELECT status, created_at FROM oidc_auth_request WHERE id=$1`, reqID).
		Scan(&status, &created); err != nil {
		return "missing"
	}
	if status == "pending" && s.now().Sub(created) > confirmTTL {
		s.db.Exec(ctx, `UPDATE oidc_auth_request SET status='expired' WHERE id=$1 AND status='pending'`, reqID)
		return "expired"
	}
	return status
}

// tryConfirm desktop 确认卡提交：6 位码核对（错 3 次作废）→ 认领（amr=desktop-confirm）。
// 错误口径：1010 请求过期/不存在 · 1012 码不匹配（含作废）。
func (s *Storage) tryConfirm(ctx context.Context, reqID, code6 string, userID int64) (attemptsLeft int, err error) {
	info, err := s.confirmInfo(ctx, reqID)
	if err != nil {
		return 0, errExpiredReq
	}
	if info.Status != "pending" {
		return 0, errExpiredReq
	}
	if info.Age > confirmTTL {
		s.db.Exec(ctx, `UPDATE oidc_auth_request SET status='expired' WHERE id=$1`, reqID)
		return 0, errExpiredReq
	}
	// grant 覆盖 → 轻量形态：点头像即走，免 6 位码（D28 §5.1；首次授权/新增 scope 才核对）
	if s.grantCovered(ctx, userID, info.ClientID, info.Scopes) {
		return 0, s.completeAuthRequest(ctx, reqID, strconv.FormatInt(userID, 10), []string{"desktop-confirm"})
	}
	if info.Code6 != code6 {
		var attempts int
		_ = s.db.QueryRow(ctx, `SELECT confirm_attempts FROM oidc_auth_request WHERE id=$1`, reqID).Scan(&attempts)
		attempts++
		if attempts >= 3 {
			s.db.Exec(ctx, `UPDATE oidc_auth_request SET confirm_attempts=$2, status='denied' WHERE id=$1`, reqID, attempts)
			return 0, errCodeInvalidated
		}
		s.db.Exec(ctx, `UPDATE oidc_auth_request SET confirm_attempts=$2 WHERE id=$1`, reqID, attempts)
		return 3 - attempts, errCodeMismatch
	}
	return 0, s.completeAuthRequest(ctx, reqID, strconv.FormatInt(userID, 10), []string{"desktop-confirm"})
}

var (
	errExpiredReq      = errors.New("请求已过期或不存在")
	errCodeMismatch    = errors.New("确认码不匹配")
	errCodeInvalidated = errors.New("确认码错误次数过多，请求已作废")
)

// ── web 会话（§5.3，SSO 免密载体）───────────────────────────────────────────

func (s *Storage) createWebSession(ctx context.Context, userID int64, ua, ip string) (string, error) {
	value := randToken()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	id, err := bbcpg.AllocID(ctx, tx, lockKeyOIDCSession, "oidc_web_session")
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO oidc_web_session (id, tenant_id, user_id, token_hash, sliding_expires_at, user_agent, ip)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		id, s.defaultTenant, userID, sha256hex(value), s.now().Add(s.sessionTTL), ua, ip)
	if err != nil {
		return "", err
	}
	return value, tx.Commit(ctx)
}

// webSessionUser 有效则返回用户 ID 并滑动续期；无效返回 0。
func (s *Storage) webSessionUser(ctx context.Context, token string) int64 {
	if token == "" {
		return 0
	}
	var uid int64
	var exp time.Time
	var status string
	err := s.db.QueryRow(ctx, `SELECT user_id, sliding_expires_at, status FROM oidc_web_session WHERE token_hash=$1`, sha256hex(token)).
		Scan(&uid, &exp, &status)
	if err != nil || status != "active" || s.now().After(exp) {
		return 0
	}
	s.db.Exec(ctx, `UPDATE oidc_web_session SET sliding_expires_at=$2, last_used_at=now() WHERE user_id=$1 AND status='active' AND token_hash=$3`,
		uid, s.now().Add(s.sessionTTL), sha256hex(token))
	return uid
}

func (s *Storage) revokeWebSessions(ctx context.Context, userID int64) {
	s.db.Exec(ctx, `UPDATE oidc_web_session SET status='revoked', revoked_at=now() WHERE user_id=$1 AND status='active'`, userID)
}

// ── 用户面授权管理（D28 批次 Q3：「已授权应用」+ 浏览器会话远端下线）──────────

type grantDTO struct {
	ClientID    string   `json:"client_id"`
	AppName     string   `json:"app_name"`
	Scopes      []string `json:"scopes"`
	GrantedAt   string   `json:"granted_at"`
	LastUsedAt  string   `json:"last_used_at"`
	Revoked     bool     `json:"revoked"`
}

func (s *Storage) listGrants(ctx context.Context, userID int64) []grantDTO {
	rows, err := s.db.Query(ctx, `
		SELECT g.client_id, COALESCE(c.name,''), g.scopes, g.granted_at, g.last_used_at, g.revoked_at
		FROM oidc_grant g LEFT JOIN oidc_client c ON c.tenant_id=g.tenant_id AND c.client_id=g.client_id
		WHERE g.user_id=$1 ORDER BY g.granted_at DESC`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []grantDTO
	for rows.Next() {
		var dto grantDTO
		var scopes []byte
		var granted, lastUsed time.Time
		var revoked *time.Time
		if err := rows.Scan(&dto.ClientID, &dto.AppName, &scopes, &granted, &lastUsed, &revoked); err != nil {
			continue
		}
		_ = json.Unmarshal(scopes, &dto.Scopes)
		dto.GrantedAt = granted.Format(time.RFC3339)
		dto.LastUsedAt = lastUsed.Format(time.RFC3339)
		dto.Revoked = revoked != nil
		out = append(out, dto)
	}
	return out
}

// revokeGrant 撤销用户对应用的授权：grant 置 revoked + 该应用 refresh/access 全灭
// （已签 access ≤15min 自然过期兜底；introspection 立即 inactive）。
func (s *Storage) revokeGrant(ctx context.Context, userID int64, clientID string) error {
	tag, err := s.db.Exec(ctx, `UPDATE oidc_grant SET revoked_at=now() WHERE user_id=$1 AND client_id=$2 AND revoked_at IS NULL`,
		userID, clientID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.db.Exec(ctx, `UPDATE oidc_refresh_token SET status='revoked' WHERE user_id=$1 AND client_id=$2 AND status='active'`, userID, clientID)
	s.db.Exec(ctx, `UPDATE oidc_access_token SET revoked=true WHERE user_id=$1 AND client_id=$2`, userID, clientID)
	return nil
}

type sessionDTO struct {
	ID          int64  `json:"id"`
	Did         string `json:"did"`
	UserAgent   string `json:"user_agent"`
	IP          string `json:"ip"`
	LastUsedAt  string `json:"last_used_at"`
	CreatedAt   string `json:"created_at"`
	ExpiresAt   string `json:"expires_at"`
}

func (s *Storage) listSessions(ctx context.Context, userID int64) []sessionDTO {
	rows, err := s.db.Query(ctx, `
		SELECT id, did, user_agent, ip, last_used_at, created_at, sliding_expires_at
		FROM oidc_web_session WHERE user_id=$1 AND status='active' ORDER BY last_used_at DESC`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []sessionDTO
	for rows.Next() {
		var dto sessionDTO
		var lastUsed, created, expires time.Time
		if err := rows.Scan(&dto.ID, &dto.Did, &dto.UserAgent, &dto.IP, &lastUsed, &created, &expires); err != nil {
			continue
		}
		dto.LastUsedAt = lastUsed.Format(time.RFC3339)
		dto.CreatedAt = created.Format(time.RFC3339)
		dto.ExpiresAt = expires.Format(time.RFC3339)
		out = append(out, dto)
	}
	return out
}

func (s *Storage) revokeSession(ctx context.Context, userID, sessionID int64) error {
	tag, err := s.db.Exec(ctx, `UPDATE oidc_web_session SET status='revoked', revoked_at=now() WHERE id=$1 AND user_id=$2 AND status='active'`,
		sessionID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

// RevokeAllForUser 改密/禁用全吊销（v0.2 拍板 7：改密即全端 OIDC 凭证失效）：
// 浏览器会话 + 全部应用 refresh/access。
func (m *Module) RevokeAllForUser(ctx context.Context, userID int64) {
	m.storage.revokeWebSessions(ctx, userID)
	m.storage.db.Exec(ctx, `UPDATE oidc_refresh_token SET status='revoked' WHERE user_id=$1 AND status='active'`, userID)
	m.storage.db.Exec(ctx, `UPDATE oidc_access_token SET revoked=true WHERE user_id=$1`, userID)
	m.storage.db.Exec(ctx, `UPDATE oidc_grant SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, userID)
}
