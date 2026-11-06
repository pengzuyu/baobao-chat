package authjwt

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func newTestSigner() *Signer {
	s := NewSigner([]byte("0123456789abcdef0123456789abcdef"))
	s.now = func() time.Time { return time.Unix(1760000000, 0) } // 固定时钟
	return s
}

func TestSignParseRoundtrip(t *testing.T) {
	s := newTestSigner()
	in := Claims{
		Subject:   "10001",
		TenantID:  1,
		Scope:     []string{"im:message:send", "agent:session:use"},
		DeviceID:  "did-1",
		JWTID:     "jti-1",
		IssuedAt:  1760000000,
		ExpiresAt: 1760000900,
	}
	tok, err := s.Sign(in)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if strings.Count(tok, ".") != 2 {
		t.Fatalf("compact JWT 应为三段: %q", tok)
	}
	got, err := s.Parse(tok)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Subject != in.Subject || got.TenantID != in.TenantID || got.DeviceID != in.DeviceID || got.JWTID != in.JWTID {
		t.Fatalf("claims 不一致: %+v", got)
	}
	if len(got.Scope) != 2 || got.Scope[0] != "im:message:send" {
		t.Fatalf("scope 不一致: %v", got.Scope)
	}
	if got.IsOBO() {
		t.Fatal("无 act 不应识别为 OBO")
	}
}

func TestOBOActClaim(t *testing.T) {
	s := newTestSigner()
	in := Claims{
		Subject: "10001", JWTID: "jti-obo", ExpiresAt: 1760000900,
		Actor: &Actor{AgentSessionID: "as-77"},
	}
	tok, _ := s.Sign(in)
	got, err := s.Parse(tok)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !got.IsOBO() || got.Actor == nil || got.Actor.AgentSessionID != "as-77" {
		t.Fatalf("act 声明丢失: %+v", got)
	}
}

// 表驱动：异常令牌必须被拒绝且原因可映射 1003/1004
func TestParseRejects(t *testing.T) {
	s := newTestSigner()
	valid, _ := s.Sign(Claims{Subject: "u", JWTID: "j", ExpiresAt: 1760000900})
	parts := strings.Split(valid, ".")

	tampered := parts[0] + "." + parts[1] + "." + parts[2][:len(parts[2])-4] + "AAAA"
	badPayloadSig := "x." + parts[1] + "." + parts[2]

	cases := []struct {
		name string
		tok  string
		want error
	}{
		{"篡改签名", tampered, ErrInvalid},
		{"载荷与签名不匹配", badPayloadSig, ErrInvalid},
		{"非三段", "abc.def", ErrInvalid},
		{"空串", "", ErrInvalid},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := s.Parse(c.tok); err != c.want {
				t.Fatalf("err=%v want=%v", err, c.want)
			}
		})
	}
}

func TestParseExpired(t *testing.T) {
	s := newTestSigner()
	tok, _ := s.Sign(Claims{Subject: "u", JWTID: "j", ExpiresAt: 1760000000 - 1})
	if _, err := s.Parse(tok); err != ErrExpired {
		t.Fatalf("过期令牌应返回 ErrExpired, got %v", err)
	}
}

func TestSignRequiresInvariant(t *testing.T) {
	s := newTestSigner()
	if _, err := s.Sign(Claims{JWTID: "j", ExpiresAt: 1}); err == nil {
		t.Fatal("缺 sub 应拒绝签发")
	}
	if _, err := s.Sign(Claims{Subject: "u", ExpiresAt: 1}); err == nil {
		t.Fatal("缺 jti 应拒绝签发")
	}
	if _, err := s.Sign(Claims{Subject: "u", JWTID: "j"}); err == nil {
		t.Fatal("缺 exp 应拒绝签发")
	}
}

// 算法混淆：手拼 alg=none / HS512 头必须被拒
func TestParseAlgWhitelist(t *testing.T) {
	s := newTestSigner()
	for _, alg := range []string{"none", "HS512"} {
		hb, _ := json.Marshal(map[string]string{"alg": alg, "typ": "JWT"})
		pb, _ := json.Marshal(Claims{Subject: "u", JWTID: "j", ExpiresAt: 1999999999})
		tok := b64(hb) + "." + b64(pb) + "."
		if _, err := s.Parse(tok); err == nil {
			t.Fatalf("alg=%s 必须被拒绝", alg)
		}
	}
}
