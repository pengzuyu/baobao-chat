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
	"strconv"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	authservice "github.com/baobaochat/server/internal/auth/service"
	"github.com/baobaochat/server/internal/org/api"
	bbwpg "github.com/baobaochat/server/internal/platform/pgxpool"
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
	_, err = s.db.Exec(ctx, `
		INSERT INTO oidc_auth_request (id, tenant_id, client_id, scopes, nonce, state, code_challenge, code_challenge_m, snapshot, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
		ar.ID, s.defaultTenant, ar.ClientID, mustJSON(ar.Scopes), ar.Nonce, ar.State,
		ar.CodeChallenge, ar.CodeChallengeMethod, mustJSON(ar))
	if err != nil {
		return nil, fmt.Errorf("oidc: 存授权请求: %w", err)
	}
	return ar, nil
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

// completeAuthRequest 等待页/web 登录认领（§5.2/§5.3）：回填用户并置 done。
func (s *Storage) completeAuthRequest(ctx context.Context, id, userID string) error {
	ar, err := s.loadAuthRequest(ctx, id)
	if err != nil {
		return err
	}
	uid, _ := strconv.ParseInt(userID, 10, 64)
	// scope 收敛：应用白名单 ∩ 用户有效权限（超集申请在库侧已被 IsScopeAllowed 拦；
	// 这里保证 per-app token 永不超过用户本人权限——OBO 同口径）
	if u, err := s.auth.UserByID(ctx, uid); err == nil {
		ar.Scopes = s.intersectScopes(ctx, ar.Scopes, u)
	}
	ar.UserID = userID
	ar.Completed = true
	ar.AMR = []string{"pwd"}
	ar.AuthTime = s.now()
	_, err = s.db.Exec(ctx, `UPDATE oidc_auth_request SET user_id=$2, snapshot=$3, status='approved', auth_time=$4, approved_at=now() WHERE id=$1`,
		id, uid, mustJSON(ar), ar.AuthTime)
	return err
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
	id, err := bbwpg.AllocID(ctx, tx, lockKeyOIDCRefresh, "oidc_refresh_token")
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
	id, err := bbwpg.AllocID(ctx, tx, lockKeyOIDCGrant, "oidc_grant")
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
	if userID != "" {
		// 撤销 access（tokenID 形态）
		if _, err := s.db.Exec(ctx, `UPDATE oidc_access_token SET revoked=true WHERE id=$1`, tokenOrTokenID); err != nil {
			return oidc.ErrServerError().WithDescription("%s", err.Error())
		}
		return nil
	}
	// 撤销 refresh（token 值形态）：连带其后签发的 access
	var id int64
	err := s.db.QueryRow(ctx, `SELECT id FROM oidc_refresh_token WHERE token_hash=$1`, sha256hex(tokenOrTokenID)).Scan(&id)
	if err != nil {
		return nil // RFC 7009：未知 token 也返回成功（不泄露存在性）
	}
	if _, err := s.db.Exec(ctx, `UPDATE oidc_refresh_token SET status='revoked' WHERE id=$1`, id); err == nil {
		s.db.Exec(ctx, `UPDATE oidc_access_token SET revoked=true WHERE refresh_id=$1`, id)
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

// ── web 会话（§5.3，SSO 免密载体）───────────────────────────────────────────

func (s *Storage) createWebSession(ctx context.Context, userID int64, ua, ip string) (string, error) {
	value := randToken()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	id, err := bbwpg.AllocID(ctx, tx, lockKeyOIDCSession, "oidc_web_session")
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
