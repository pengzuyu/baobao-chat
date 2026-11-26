package agentjwt

import (
	"encoding/base64"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"crypto/x509"

	"github.com/baobaochat/server/internal/platform/authjwt"
)

// 测试脚手架：随机 P-256 密钥 + 假时钟（与 auth service fixture 同手法）
func newPair(t *testing.T, issuer string) (*Issuer, *Verifier) {
	t.Helper()
	key, err := GenDevKey()
	if err != nil {
		t.Fatal(err)
	}
	signer := NewIssuerWithKey(issuer, key)
	verifier := NewVerifierWithKey(issuer, key)
	base := time.Unix(1760000000, 0)
	signer.SetClock(func() time.Time { return base })
	verifier.SetClock(func() time.Time { return base })
	return signer, verifier
}

func sampleClaims() Claims {
	return Claims{
		Subject:   "10001",
		TenantID:  1,
		Audience:  []string{"https://oa.company.internal/mcp"},
		Scope:     []string{"im:message:send"},
		Actor:     &Act{Sub: "desktop-did-1"},
		JWTID:     "jti-1",
		IssuedAt:  1760000000,
		ExpiresAt: 1760000900,
	}
}

// 签发→验签全链：形状映射（act.sub→Actor.AgentSessionID）与字段保真
func TestSignVerifyRoundTrip(t *testing.T) {
	s, v := newPair(t, "https://bbc.test/oauth2")
	tok, err := s.Sign(sampleClaims())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(tok, ".") != 2 {
		t.Fatalf("应为 compact JWS 三段: %q", tok)
	}
	claims, err := v.Verify(tok, "https://oa.company.internal/mcp")
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "10001" || claims.TenantID != 1 {
		t.Fatalf("sub/tenant 失真: %+v", claims)
	}
	if !claims.IsOBO() || claims.Actor.AgentSessionID != "desktop-did-1" {
		t.Fatalf("act 映射缺失: %+v", claims)
	}
	if len(claims.Scope) != 1 || claims.Scope[0] != "im:message:send" {
		t.Fatalf("scope 失真: %v", claims.Scope)
	}
}

// aud 校验（D38 §2.1 ⑤）：串票打 A 的票到 B → 401 语义（ErrInvalid）
func TestVerifyAudienceMismatch(t *testing.T) {
	s, v := newPair(t, "https://bbc.test/oauth2")
	tok, _ := s.Sign(sampleClaims()) // aud=oa
	if _, err := v.Verify(tok, "https://hr.company.internal/mcp"); err == nil {
		t.Fatal("aud 不符应拒绝（串票）")
	}
	if _, err := v.Verify(tok, ""); err != nil {
		t.Fatalf("expectAud 空应不校验 aud: %v", err)
	}
}

// iss 精确匹配：别的签发方（不同 issuer）的票拒绝
func TestVerifyIssuerMismatch(t *testing.T) {
	s, _ := newPair(t, "https://evil.test/oauth2")
	_, v := newPair(t, "https://bbc.test/oauth2")
	tok, _ := s.Sign(sampleClaims())
	if _, err := v.Verify(tok, ""); err == nil {
		t.Fatal("iss 不符应拒绝")
	}
}

// 篡改 payload → 验签失败（ErrInvalid）
func TestVerifyTamperedPayload(t *testing.T) {
	s, v := newPair(t, "https://bbc.test/oauth2")
	tok, _ := s.Sign(sampleClaims())
	parts := strings.Split(tok, ".")
	parts[1] = parts[1][:len(parts[1])-4] + "QUFBQQ==" // 乱改 payload（合法 base64）
	if _, err := v.Verify(strings.Join(parts, "."), ""); err == nil {
		t.Fatal("篡改 payload 应拒绝")
	}
}

// 时间窗（D38 §2.1 ④）：过期（容差外）→ ErrExpired（1003）；容差内放行；nbf 未到拒绝
func TestVerifyTimeWindow(t *testing.T) {
	s, v := newPair(t, "https://bbc.test/oauth2")
	base := time.Unix(1760000000, 0)

	// 恰好过期 61s（容差外）
	c := sampleClaims()
	c.ExpiresAt = base.Add(-61 * time.Second).Unix()
	tok, _ := s.Sign(c)
	if _, err := v.Verify(tok, ""); err != authjwt.ErrExpired {
		t.Fatalf("过期 61s 应 ErrExpired: %v", err)
	}

	// 过期 30s（容差内放行）
	c.ExpiresAt = base.Add(-30 * time.Second).Unix()
	tok, _ = s.Sign(c)
	if _, err := v.Verify(tok, ""); err != nil {
		t.Fatalf("容差内应放行: %v", err)
	}

	// nbf 在未来 61s（容差外）
	c = sampleClaims()
	c.NotBefore = base.Add(61 * time.Second).Unix()
	tok, _ = s.Sign(c)
	if _, err := v.Verify(tok, ""); err == nil {
		t.Fatal("nbf 未到（容差外）应拒绝")
	}
}

// 必填不变量：sub/jti/exp/aud 缺一即拒（与 authjwt.Sign 同口径）
func TestSignRequiredFields(t *testing.T) {
	s, _ := newPair(t, "https://bbc.test/oauth2")
	cases := []Claims{
		{JWTID: "j", ExpiresAt: 1, Audience: []string{"https://a"}},
		{Subject: "s", ExpiresAt: 1, Audience: []string{"https://a"}},
		{Subject: "s", JWTID: "j", Audience: []string{"https://a"}},
		{Subject: "s", JWTID: "j", ExpiresAt: 1},
	}
	for i, c := range cases {
		if _, err := s.Sign(c); err == nil {
			t.Fatalf("case %d 缺必填应拒绝", i)
		}
	}
}

// 默认值回填：iss/client_id/nbf/iat 缺省由 Issuer 补
func TestSignDefaults(t *testing.T) {
	s, v := newPair(t, "https://bbc.test/oauth2")
	c := sampleClaims()
	c.Issuer = ""
	c.ClientID = ""
	tok, err := s.Sign(c)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := v.Verify(tok, "https://oa.company.internal/mcp")
	if err != nil {
		t.Fatal(err)
	}
	if claims.JWTID != "jti-1" {
		t.Fatalf("字段保真: %+v", claims)
	}
}

// kid = 公钥指纹（D38 拍板 7）：换密钥即换 kid；同密钥稳定
func TestKidFingerprint(t *testing.T) {
	k1, _ := GenDevKey()
	k2, _ := GenDevKey()
	id1 := KidFor(&k1.PublicKey)
	if id1 != KidFor(&k1.PublicKey) {
		t.Fatal("同密钥 kid 应稳定")
	}
	if id1 == KidFor(&k2.PublicKey) {
		t.Fatal("不同密钥 kid 应不同（轮换即换 kid）")
	}
	if len(id1) != 16 {
		t.Fatalf("kid 应 16 hex: %q", id1)
	}
}

// 格式闸（D38 §3.3）：合法 http(s) URL 或保留逻辑名
// （2026-11-26 拍板修订：放开 http——内网明文目的地为主流形态，原「票不可明文
// 出站」仅拦 agent 票而主 token 同走明文，属威胁模型错位；暂不限私网，未来再收）
func TestValidAudience(t *testing.T) {
	yes := []string{AudCorp, AudAigw,
		"https://oa.company.internal/mcp", "https://bbc.test/oauth2",
		"http://oa.company.internal/mcp", "http://172.16.105.109:30700/api/mcp"}
	no := []string{"corp", "bbc-corpx",
		"", "oa.company.internal", "ftp://x", "https://", "http://"}
	for _, a := range yes {
		if !ValidAudience(a) {
			t.Fatalf("%q 应通过格式闸", a)
		}
	}
	for _, a := range no {
		if ValidAudience(a) {
			t.Fatalf("%q 应被格式闸拒绝", a)
		}
	}
}

// LoadKey：PEM 与 base64 单行双形态（迁移自 oidc/keys.go 的行为不变性）
func TestLoadKeyForms(t *testing.T) {
	key, _ := GenDevKey()
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
	k1, err := LoadKey(pemStr)
	if err != nil || k1 == nil || k1.D.Cmp(key.D) != 0 {
		t.Fatalf("PEM 形态解析: %v", err)
	}
	b64OneLine := base64.StdEncoding.EncodeToString([]byte(pemStr))
	k2, err := LoadKey(b64OneLine)
	if err != nil || k2 == nil || k2.D.Cmp(key.D) != 0 {
		t.Fatalf("base64 单行形态解析: %v", err)
	}
	if k, err := LoadKey(""); err != nil || k != nil {
		t.Fatalf("空串应 (nil,nil): %v", err)
	}
	if _, err := LoadKey("garbage-not-pem"); err == nil {
		t.Fatal("垃圾输入应报错")
	}
}
