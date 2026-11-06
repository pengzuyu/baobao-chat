package authservice

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/baobaowork/server/internal/auth/api"
	"github.com/baobaowork/server/internal/auth/repo"
	"github.com/baobaowork/server/internal/org/api"
	"github.com/baobaowork/server/internal/org/repo"
	"github.com/baobaowork/server/internal/platform/authjwt"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// sha256Hex 与实现同算法的测试辅助
func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// PBKDF2-HMAC-SHA256 标准测试向量（RFC 7914 §11）
func TestPBKDF2Vectors(t *testing.T) {
	cases := []struct {
		pw     string
		salt   string
		iter   int
		keyLen int
		want   string
	}{
		{"password", "salt", 1, 32, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"},
		{"password", "salt", 2, 32, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"},
		{"password", "salt", 4096, 32, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"},
	}
	for _, c := range cases {
		got := pbkdf2SHA256([]byte(c.pw), []byte(c.salt), c.iter, c.keyLen)
		if hex.EncodeToString(got) != c.want {
			t.Fatalf("iter=%d: %s != %s", c.iter, hex.EncodeToString(got), c.want)
		}
	}
}

func TestPasswordHashVerify(t *testing.T) {
	h, err := hashWithIter("s3cret!", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(h, "s3cret!") {
		t.Fatal("正确口令应通过")
	}
	if VerifyPassword(h, "wrong") {
		t.Fatal("错误口令应拒绝")
	}
	// 破损哈希不 panic、一律拒绝
	for _, bad := range []string{"", "x", "pbkdf2-sha256$abc$", "argon2id$1$xx$yy", "pbkdf2-sha256$1000$!!$??"} {
		if VerifyPassword(bad, "s3cret!") {
			t.Fatalf("非法哈希应拒绝: %q", bad)
		}
	}
}

// ---- 测试脚手架 ----

type fixture struct {
	svc    *Service
	signer *authjwt.Signer
	org    *orgrepo.Memory
	tokens *authrepo.Memory
	now    func() time.Time
}

func newFixture(t *testing.T, mutate func(o *Options)) *fixture {
	t.Helper()
	base := time.Unix(1760000000, 0)
	cur := base
	now := func() time.Time { return cur }
	orgMem := orgrepo.NewMemory()
	hash, err := hashWithIter("right-pass", 1000)
	if err != nil {
		t.Fatal(err)
	}
	_, err = orgMem.CreateUser(context.Background(), orgapi.User{
		TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "alice",
		DisplayName: "Alice", Email: "alice@bbw.io", PasswordHash: hash,
		Status: orgapi.UserStatusActive,
		Scopes: []string{"im:message:send", "im:group:create", "agent:session:use"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = orgMem.CreateUser(context.Background(), orgapi.User{
		TenantID: 1, EmployeeNo: "bob", DisplayName: "Bob", PasswordHash: hash,
		Status: orgapi.UserStatusDisabled, Scopes: []string{"im:message:send"},
	})
	if err != nil {
		t.Fatal(err)
	}

	signer := authjwt.NewSigner([]byte("0123456789abcdef0123456789abcdef"))
	signer.SetClock(now) // 签发与校验共用同一假时钟
	tokMem := authrepo.NewMemory()

	opts := Options{Now: now}
	if mutate != nil {
		mutate(&opts)
	}
	opts.fillDefaults()
	svc := New(opts, orgMem, tokMem, tokMem, tokMem, signer)
	return &fixture{svc: svc, signer: signer, org: orgMem, tokens: tokMem, now: now}
}

func loginReq() authapi.LoginReq {
	return authapi.LoginReq{TenantID: 1, Username: "alice", Password: "right-pass",
		DID: "did-1", DeviceName: "MacBook", OS: "darwin"}
}

func TestLoginSuccess(t *testing.T) {
	f := newFixture(t, nil)
	pair, err := f.svc.Login(context.Background(), loginReq())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if pair.AccessToken == "" || pair.RefreshToken == "" || pair.AccessToken == pair.RefreshToken {
		t.Fatal("令牌对不完整")
	}
	claims, err := f.signer.Parse(pair.AccessToken)
	if err != nil {
		t.Fatalf("access 应可解析: %v", err)
	}
	if claims.Subject != "10001" || claims.TenantID != 1 || claims.DeviceID != "did-1" {
		t.Fatalf("claims 不符: %+v", claims)
	}
	if len(claims.Scope) != 3 {
		t.Fatalf("scope 应为用户权限摘要: %v", claims.Scope)
	}
}

// 表驱动：登录失败路径
func TestLoginFailures(t *testing.T) {
	cases := []struct {
		name     string
		mutate   func(o *Options)
		req      func() authapi.LoginReq
		wantCode errx.Code
	}{
		{
			"未知用户（防枚举→1001）", nil,
			func() authapi.LoginReq { r := loginReq(); r.Username = "nobody"; return r },
			errx.CodeAuthPasswordWrong,
		},
		{
			"禁用用户", nil,
			func() authapi.LoginReq { r := loginReq(); r.Username = "bob"; return r },
			errx.CodeUserDisabled,
		},
		{
			"口令错误", nil,
			func() authapi.LoginReq { r := loginReq(); r.Password = "wrong"; return r },
			errx.CodeAuthPasswordWrong,
		},
		// 注：原"缺 did→9001"用例已随 web 端免 did 登录（兜底设备号）移除——见 Login 内注释
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, c.mutate)
			_, err := f.svc.Login(context.Background(), c.req())
			e := errx.From(err)
			if e.Code != c.wantCode {
				t.Fatalf("code=%d(%s) want=%d", e.Code, e.Msg, c.wantCode)
			}
		})
	}
}

func TestLoginLockout(t *testing.T) {
	f := newFixture(t, func(o *Options) { o.MaxLoginFails = 3; o.LockTTL = 10 * time.Minute })
	bad := loginReq()
	bad.Password = "wrong"

	// 两次失败：1001 且剩余次数递减
	for i, wantRemaining := range []int{2, 1} {
		_, err := f.svc.Login(context.Background(), bad)
		e := errx.From(err)
		if e.Code != errx.CodeAuthPasswordWrong {
			t.Fatalf("第 %d 次: code=%d", i+1, e.Code)
		}
		if d, ok := e.Details.(map[string]int); !ok || d["remaining_attempts"] != wantRemaining {
			t.Fatalf("剩余次数不符: %+v", e.Details)
		}
	}
	// 第三次触发锁定：1007
	if _, err := f.svc.Login(context.Background(), bad); errx.From(err).Code != errx.CodeAuthLoginLocked {
		t.Fatalf("应锁定: %v", err)
	}
	// 锁定期内即使口令正确也 1007
	if _, err := f.svc.Login(context.Background(), loginReq()); errx.From(err).Code != errx.CodeAuthLoginLocked {
		t.Fatalf("锁定期应拒绝: %v", err)
	}
}

// 一次性轮换链：旧值重放 → 全设备下线（03 篇 §2.2 核心不变量）
func TestRefreshRotationChain(t *testing.T) {
	f := newFixture(t, nil)
	ctx := context.Background()
	p1, err := f.svc.Login(ctx, loginReq())
	if err != nil {
		t.Fatal(err)
	}
	p2, err := f.svc.Refresh(ctx, authapi.RefreshReq{RefreshToken: p1.RefreshToken, DID: "did-1"})
	if err != nil {
		t.Fatalf("首次刷新: %v", err)
	}
	// rotated_from 链：新 token 指向旧 token
	rt2, _ := f.tokens.FindByTokenHash(ctx, sha256Hex(p2.RefreshToken))
	if rt2 == nil || rt2.RotatedFrom == nil {
		t.Fatal("轮换链断裂：rotated_from 为空")
	}
	old, _ := f.tokens.FindByTokenHash(ctx, sha256Hex(p1.RefreshToken))
	if old == nil || *rt2.RotatedFrom != old.ID {
		t.Fatal("rotated_from 未指向旧 token")
	}
	// 旧值重放：1004 + 全设备吊销
	if _, err := f.svc.Refresh(ctx, authapi.RefreshReq{RefreshToken: p1.RefreshToken, DID: "did-1"}); errx.From(err).Code != errx.CodeAuthTokenRevoked {
		t.Fatalf("重放应 1004: %v", err)
	}
	// 连坐：重放后新 token 也已被吊销
	if _, err := f.svc.Refresh(ctx, authapi.RefreshReq{RefreshToken: p2.RefreshToken, DID: "did-1"}); errx.From(err).Code != errx.CodeAuthTokenRevoked {
		t.Fatalf("重放后全设备应下线: %v", err)
	}
}

func TestRefreshWrongDevice(t *testing.T) {
	f := newFixture(t, nil)
	ctx := context.Background()
	p1, _ := f.svc.Login(ctx, loginReq())
	if _, err := f.svc.Refresh(ctx, authapi.RefreshReq{RefreshToken: p1.RefreshToken, DID: "did-other"}); errx.From(err).Code != errx.CodeAuthTokenRevoked {
		t.Fatalf("设备不匹配应 1004: %v", err)
	}
}

func TestLogout(t *testing.T) {
	f := newFixture(t, nil)
	ctx := context.Background()
	p1, _ := f.svc.Login(ctx, loginReq())
	if err := f.svc.Logout(ctx, 10001, "did-1", false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Refresh(ctx, authapi.RefreshReq{RefreshToken: p1.RefreshToken, DID: "did-1"}); errx.From(err).Code != errx.CodeAuthTokenRevoked {
		t.Fatalf("登出后刷新应 1004: %v", err)
	}
}

// OBO：scope 子集放行 + act 声明；超集 1006（03 篇 §6.2）
func TestIssueOBO(t *testing.T) {
	f := newFixture(t, nil)
	ctx := context.Background()

	tok, err := f.svc.IssueOBO(ctx, 10001, authapi.OBOReq{
		AgentSessionID: "as-77",
		Scope:          []string{"im:message:send"},
	})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := f.signer.Parse(tok)
	if err != nil {
		t.Fatal(err)
	}
	if !claims.IsOBO() || claims.Actor.AgentSessionID != "as-77" {
		t.Fatalf("act 声明缺失: %+v", claims)
	}
	if len(claims.Scope) != 1 || claims.Scope[0] != "im:message:send" {
		t.Fatalf("OBO scope 应为申请子集: %v", claims.Scope)
	}
	if claims.Subject != "10001" {
		t.Fatalf("sub 必须是用户本人: %s", claims.Subject)
	}
}

func TestIssueOBOFailures(t *testing.T) {
	f := newFixture(t, nil)
	ctx := context.Background()

	cases := []struct {
		name     string
		uid      int64
		req      authapi.OBOReq
		wantCode errx.Code
	}{
		{"scope 超集", 10001, authapi.OBOReq{AgentSessionID: "a", Scope: []string{"admin:org:manage"}}, errx.CodeAuthOBOScopeExceeded},
		{"缺会话 ID", 10001, authapi.OBOReq{Scope: []string{"im:message:send"}}, errx.CodeBadRequest},
		{"用户不存在", 99999, authapi.OBOReq{AgentSessionID: "a"}, errx.CodeNotFound},
		{"用户禁用", 10002, authapi.OBOReq{AgentSessionID: "a"}, errx.CodeUserDisabled},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := f.svc.IssueOBO(ctx, c.uid, c.req)
			if errx.From(err).Code != c.wantCode {
				t.Fatalf("code=%d(%v) want=%d", errx.From(err).Code, err, c.wantCode)
			}
		})
	}
}

func TestVerify(t *testing.T) {
	f := newFixture(t, nil)
	pair, _ := f.svc.Login(context.Background(), loginReq())
	if _, err := f.svc.Verify(context.Background(), pair.AccessToken); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if _, err := f.svc.Verify(context.Background(), "junk"); err == nil {
		t.Fatal("垃圾令牌应拒绝")
	}
}
