// Package authservice 认证业务逻辑。
// 核心链路：登录 → access(JWT)+refresh（一次性轮换链）→ OBO 签发（scope 子集）。
// 文档：docs/03-身份认证与权限体系.md §2/§6。
package authservice

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/baobaochat/server/internal/auth/api"
	"github.com/baobaochat/server/internal/auth/repo"
	"github.com/baobaochat/server/internal/org/api"
	"github.com/baobaochat/server/internal/platform/authjwt"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"unicode"
)

// Options 可调参数（装配期注入，测试可覆盖时钟）
type Options struct {
	AccessTTL     time.Duration // access token：15min（03 篇 §2.2）
	OBOTTL        time.Duration // OBO：≤15min
	RefreshTTL    time.Duration // refresh：30 天滑动
	MaxLoginFails int           // 口令错误锁定阈值（默认 5）
	LockTTL       time.Duration // 锁定时长（默认 10min）
	DefaultTenant int64         // 登录未带 tenant_id 时的默认租户（阶段一单租户开发态；多租户阶段二改门户域名映射，D12 §2.1）
	// ScopesOf RBAC 权限聚合（03 篇 §4：user_role ⋈ role.permissions 并集；main 以
	// admin 域 roleStore 装配注入——auth 不反向依赖 admin 包，D02 §4）。nil 时退回
	// users 行内 Scopes（内存种子/最小装配）；聚合失败同样退回不阻断登录（登记）。
	ScopesOf func(ctx context.Context, tenantID, userID int64) ([]string, error)
	Now      func() time.Time
	// AgentKillOn 平台总闸读（D9；main 注入 admin 域 AgentKillOn——nil=闸门未装配，
	// killswitch on 时 OBO 签发拒 1013；网关侧每请求同闸，双点拦截）
	AgentKillOn func() bool
	// UserSetPassword 改密落库（D11；main 注 orgRepo.SetPassword——users 为只读
	// UserReader 接口，写通道经闭包避免拓宽 New 签名）
	UserSetPassword func(ctx context.Context, tenantID, userID int64, passwordHash string) error
}

func (o *Options) fillDefaults() {
	if o.AccessTTL == 0 {
		o.AccessTTL = 15 * time.Minute
	}
	if o.OBOTTL == 0 {
		o.OBOTTL = 15 * time.Minute
	}
	if o.RefreshTTL == 0 {
		o.RefreshTTL = 30 * 24 * time.Hour
	}
	if o.MaxLoginFails == 0 {
		o.MaxLoginFails = 5
	}
	if o.LockTTL == 0 {
		o.LockTTL = 10 * time.Minute
	}
	if o.DefaultTenant == 0 {
		o.DefaultTenant = 1 // 种子租户（D12：阶段二由门户域名映射租户）
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Service 实现 authapi.AuthService
type Service struct {
	users    orgapi.UserReader // 口令与状态归属 org 域（表归属 13 篇 §3.1）
	tokens   authrepo.RefreshTokenRepo
	devices  authrepo.DeviceRepo
	attempts authrepo.LoginAttemptStore
	signer   *authjwt.Signer
	opts     Options
}

// New 构造（依赖注入，D02 §3）
func New(opts Options, users orgapi.UserReader, tokens authrepo.RefreshTokenRepo,
	devices authrepo.DeviceRepo, attempts authrepo.LoginAttemptStore, signer *authjwt.Signer) *Service {
	opts.fillDefaults()
	return &Service{users: users, tokens: tokens, devices: devices, attempts: attempts, signer: signer, opts: opts}
}

var _ authapi.AuthService = (*Service)(nil)

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func newRefreshToken() (raw, hash string) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("authservice: rand: " + err.Error())
	}
	raw = base64.RawURLEncoding.EncodeToString(b)
	return raw, sha256hex(raw)
}

// Login 口令登录：防爆破 → 状态校验 → 口令校验 → 签发对
func (s *Service) Login(ctx context.Context, req authapi.LoginReq) (*authapi.TokenPair, error) {
	// 客户端登录表单无租户概念：缺省走默认租户（阶段二换域名映射，D12）
	if req.TenantID == 0 {
		req.TenantID = s.opts.DefaultTenant
	}
	// 阶段一 web 端未上报设备号：兜底命名（阶段二客户端经 Rust 层生成稳定 did，D12）
	if req.DID == "" {
		req.DID = "web-default-" + req.LoginAccount()
	}
	if req.LoginAccount() == "" || req.Password == "" {
		return nil, errx.New(errx.CodeBadRequest, "account/password/did 必填")
	}
	u, err := s.users.GetUserByLogin(ctx, req.TenantID, req.LoginAccount())
	if err != nil {
		// 不变量：不暴露"用户是否存在"，防账号枚举
		return nil, errx.New(errx.CodeAuthPasswordWrong, "账号或口令错误")
	}
	if u.Status != orgapi.UserStatusActive {
		return nil, errx.New(errx.CodeUserDisabled, "用户已禁用")
	}

	lockKey := strconv.FormatInt(req.TenantID, 10) + "|" + req.LoginAccount()
	if locked, retry := s.attempts.IsLocked(ctx, lockKey); locked {
		return nil, errx.NewWithDetails(errx.CodeAuthLoginLocked, "失败次数过多已锁定",
			map[string]int{"retry_after_seconds": int(retry.Seconds()) + 1})
	}
	if !VerifyPassword(u.PasswordHash, req.Password) {
		n := s.attempts.RecordFailure(ctx, lockKey, s.opts.MaxLoginFails, s.opts.LockTTL)
		if n >= s.opts.MaxLoginFails {
			return nil, errx.NewWithDetails(errx.CodeAuthLoginLocked, "失败次数过多已锁定",
				map[string]int{"retry_after_seconds": int(s.opts.LockTTL.Seconds())})
		}
		return nil, errx.NewWithDetails(errx.CodeAuthPasswordWrong, "账号或口令错误",
			map[string]int{"remaining_attempts": s.opts.MaxLoginFails - n})
	}
	s.attempts.Reset(ctx, lockKey)

	dev, err := s.devices.Upsert(ctx, authrepo.Device{
		UserID: u.ID, DID: req.DID, DeviceName: req.DeviceName, OS: req.OS,
		LastActiveAt: s.opts.Now(),
	})
	if err != nil {
		return nil, errx.From(err)
	}
	return s.issuePair(ctx, u, dev.ID, req.DID)
}

// effectiveScopes 用户有效权限点 = users 行内 Scopes ∪ RBAC 角色聚合（03 篇 §4）。
// 登录/续签/OBO 子集校验统一经此口径——角色授权后无需重登录即随下次签发生效。
// 行内值不落库恒 nil（org repo postgres.go「Scopes 不落库」），回退须兜非 nil 空切片，
// 防 perms 字段序列化成 JSON null 穿透前端（2026-11-12 用户管理白屏同根）。
func (s *Service) effectiveScopes(ctx context.Context, u *orgapi.User) []string {
	if s.opts.ScopesOf == nil {
		return nonNilScopes(u.Scopes)
	}
	extra, err := s.opts.ScopesOf(ctx, u.TenantID, u.ID)
	if err != nil || len(extra) == 0 {
		return nonNilScopes(u.Scopes) // 聚合失败不阻断登录，退回行内值（登记）
	}
	seen := make(map[string]struct{}, len(u.Scopes)+len(extra))
	out := make([]string, 0, len(u.Scopes)+len(extra))
	for _, p := range u.Scopes {
		if _, dup := seen[p]; !dup {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}
	for _, p := range extra {
		if _, dup := seen[p]; !dup {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}
	return out
}

// nonNilScopes nil → 空切片（防 JSON null 穿透；与 admin service 同口径）
func nonNilScopes(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// issuePair 签发 access + refresh；refresh 只存哈希，rotated_from 首签为 nil
func (s *Service) issuePair(ctx context.Context, u *orgapi.User, deviceID int64, did string) (*authapi.TokenPair, error) {
	now := s.opts.Now()
	scopes := s.effectiveScopes(ctx, u)
	access, err := s.signer.Sign(authjwt.Claims{
		Subject:   strconv.FormatInt(u.ID, 10),
		TenantID:  u.TenantID,
		Scope:     scopes,
		DeviceID:  did,
		JWTID:     authjwt.NewJTI(),
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(s.opts.AccessTTL).Unix(),
	})
	if err != nil {
		return nil, errx.From(err)
	}
	raw, hash := newRefreshToken()
	if _, err := s.tokens.Create(context.Background(), authrepo.RefreshToken{
		UserID: u.ID, DeviceID: deviceID, TokenHash: hash,
		ExpiresAt: now.Add(s.opts.RefreshTTL), Status: authrepo.RefreshActive, CreatedAt: now,
	}); err != nil {
		return nil, errx.From(err)
	}
	return &authapi.TokenPair{AccessToken: access, RefreshToken: raw, ExpiresIn: int64(s.opts.AccessTTL / time.Second), ExpiresAt: now.Add(s.opts.AccessTTL).UnixMilli(), User: toLoginUser(u, scopes)}, nil
}

// toLoginUser org 用户 → 登录返回体（uid 字符串化；perms=有效权限点口径）
func toLoginUser(u *orgapi.User, scopes []string) *authapi.LoginUser {
	return &authapi.LoginUser{UID: strconv.FormatInt(u.ID, 10), Name: u.DisplayName, Perms: scopes, MustChangePwd: u.MustChangePassword}
}

// Refresh 一次性轮换：旧值换新值；旧值再现=疑似被盗 → 全设备下线（03 篇 §2.2）
func (s *Service) Refresh(ctx context.Context, req authapi.RefreshReq) (*authapi.TokenPair, error) {
	if req.RefreshToken == "" || req.DID == "" {
		return nil, errx.New(errx.CodeBadRequest, "refresh_token/did 必填")
	}
	rt, _ := s.tokens.FindByTokenHash(ctx, sha256hex(req.RefreshToken))
	if rt == nil {
		return nil, errx.New(errx.CodeAuthTokenRevoked, "refresh token 无效")
	}
	if rt.Status == authrepo.RefreshRotated {
		// 不变量：轮换过的旧值再次出现即重放信号——宁可误杀（全下线+重新登录）不可放行
		_ = s.tokens.RevokeForUser(ctx, rt.UserID, 0, true)
		return nil, errx.New(errx.CodeAuthTokenRevoked, "检测到令牌重放，已下线全部设备")
	}
	if rt.Status != authrepo.RefreshActive {
		return nil, errx.New(errx.CodeAuthTokenRevoked, "refresh token 已吊销")
	}
	now := s.opts.Now()
	if rt.ExpiresAt.Before(now) {
		return nil, errx.New(errx.CodeAuthTokenExpired, "refresh token 过期，请重新登录")
	}
	// 设备绑定：did 与签发设备不一致即拒绝（03 篇 §2.2）
	dev, _ := s.devices.FindByDID(ctx, rt.UserID, req.DID)
	if dev == nil || dev.ID != rt.DeviceID {
		return nil, errx.New(errx.CodeAuthTokenRevoked, "设备不匹配")
	}
	u, err := s.users.GetUser(ctx, rt.UserID)
	if err != nil {
		return nil, errx.New(errx.CodeAuthTokenRevoked, "用户不存在")
	}
	if u.Status != orgapi.UserStatusActive {
		return nil, errx.New(errx.CodeUserDisabled, "用户已禁用")
	}

	// 轮换：旧 → rotated；新 token.rotated_from 指向旧 ID（链式审计）
	if err := s.tokens.UpdateStatus(ctx, rt.ID, authrepo.RefreshRotated); err != nil {
		return nil, errx.From(err)
	}
	oldID := rt.ID
	scopes := s.effectiveScopes(ctx, u)
	access, err := s.signer.Sign(authjwt.Claims{
		Subject:   strconv.FormatInt(u.ID, 10),
		TenantID:  u.TenantID,
		Scope:     scopes,
		DeviceID:  req.DID,
		JWTID:     authjwt.NewJTI(),
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(s.opts.AccessTTL).Unix(),
	})
	if err != nil {
		return nil, errx.From(err)
	}
	raw, hash := newRefreshToken()
	if _, err := s.tokens.Create(ctx, authrepo.RefreshToken{
		UserID: u.ID, DeviceID: rt.DeviceID, TokenHash: hash,
		ExpiresAt: now.Add(s.opts.RefreshTTL), RotatedFrom: &oldID,
		Status: authrepo.RefreshActive, CreatedAt: now,
	}); err != nil {
		return nil, errx.From(err)
	}
	return &authapi.TokenPair{AccessToken: access, RefreshToken: raw, ExpiresIn: int64(s.opts.AccessTTL / time.Second), ExpiresAt: now.Add(s.opts.AccessTTL).UnixMilli(), User: toLoginUser(u, scopes)}, nil
}

// Logout 吊销 refresh（all=true 全端下线）
func (s *Service) Logout(ctx context.Context, userID int64, did string, all bool) error {
	if all {
		return s.tokens.RevokeForUser(ctx, userID, 0, true)
	}
	dev, _ := s.devices.FindByDID(ctx, userID, did)
	if dev == nil {
		return nil // 设备未知视为已登出
	}
	return s.tokens.RevokeForUser(ctx, userID, dev.ID, false)
}

// IssueOBO 签发 OBO：scope 必须为用户权限子集，超出即拒（不静默降级，03 篇 §6.2）
func (s *Service) IssueOBO(ctx context.Context, actorUserID int64, req authapi.OBOReq) (string, error) {
	if req.AgentSessionID == "" {
		return "", errx.New(errx.CodeBadRequest, "agent_session_id 必填")
	}
	// 平台总闸（D9）：killswitch on → 拒新签发（1013；网关侧对存量 OBO 同拦）
	if s.opts.AgentKillOn != nil && s.opts.AgentKillOn() {
		return "", errx.New(errx.CodeAuthOBOKillswitch, "Agent 平台总闸已拉下（紧急停止）")
	}
	u, err := s.users.GetUser(ctx, actorUserID)
	if err != nil {
		return "", errx.New(errx.CodeNotFound, "用户不存在")
	}
	if u.Status != orgapi.UserStatusActive {
		return "", errx.New(errx.CodeUserDisabled, "用户已禁用")
	}
	eff := s.effectiveScopes(ctx, u) // OBO 子集校验同用有效权限点口径（角色授权同样生效）
	owned := make(map[string]struct{}, len(eff))
	for _, sc := range eff {
		owned[sc] = struct{}{}
	}
	for _, sc := range req.Scope {
		if _, ok := owned[sc]; !ok {
			// 1006：申请权限 > 用户权限 → 签发失败（03 篇 §6.2 原则 2）
			return "", errx.NewWithDetails(errx.CodeAuthOBOScopeExceeded, "OBO scope 超出用户权限",
				map[string]any{"scope": sc})
		}
	}
	now := s.opts.Now()
	return s.signer.Sign(authjwt.Claims{
		Subject:   strconv.FormatInt(u.ID, 10),
		TenantID:  u.TenantID,
		Scope:     req.Scope,
		JWTID:     authjwt.NewJTI(),
		Actor:     &authjwt.Actor{AgentSessionID: req.AgentSessionID}, // act：动作可归因
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(s.opts.OBOTTL).Unix(),
	})
}

// Verify 令牌校验（gateway/中间件装配）
func (s *Service) Verify(_ context.Context, token string) (*authjwt.Claims, error) {
	return s.signer.Parse(token)
}

// ChangePassword 改密（D11：旧密码校验 → 新密码规则 → 更新 hash + 清首登标志）
func (s *Service) ChangePassword(ctx context.Context, tenantID, userID int64, oldPwd, newPwd string) error {
	if oldPwd == "" || newPwd == "" {
		return errx.New(errx.CodeBadRequest, "新旧密码必填")
	}
	// 新密码规则（03 篇 §5：≥8 位且含字母与数字；不得与旧密码相同）
	if len(newPwd) < 8 || newPwd == oldPwd {
		return errx.New(errx.CodeBadRequest, "新密码至少 8 位且不得与旧密码相同")
	}
	hasLetter, hasDigit := false, false
	for _, r := range newPwd {
		if unicode.IsLetter(r) {
			hasLetter = true
		}
		if unicode.IsDigit(r) {
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return errx.New(errx.CodeBadRequest, "新密码须同时包含字母与数字")
	}
	u, err := s.users.GetUser(ctx, userID)
	if err != nil || u == nil || u.TenantID != tenantID {
		return errx.New(errx.CodeNotFound, "用户不存在")
	}
	if !VerifyPassword(u.PasswordHash, oldPwd) {
		return errx.New(errx.CodeAuthPasswordWrong, "旧密码错误")
	}
	hash, err := HashPassword(newPwd)
	if err != nil {
		return errx.New(errx.CodeInternal, "密码哈希失败")
	}
	if s.opts.UserSetPassword == nil {
		return errx.New(errx.CodeInternal, "改密通道未装配")
	}
	if err := s.opts.UserSetPassword(ctx, tenantID, userID, hash); err != nil {
		return errx.From(err)
	}
	return nil
}
