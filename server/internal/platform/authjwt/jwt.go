// Package authjwt 自实现 HS256 JWT（零第三方依赖）。
// 令牌模型见 docs/03-身份认证与权限体系.md §2.2：access(15min)/OBO(≤15min)。
// TODO(阶段二)：切换 ES256（03 篇 §2.2 目标算法），对暴露 /.well-known/jwks.json。
package authjwt

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 校验失败原因（httpx auth 中间件据此映射 1003/1004）
var (
	ErrExpired = errors.New("authjwt: token expired")
	ErrInvalid = errors.New("authjwt: token invalid")
	ErrBadAlg  = errors.New("authjwt: algorithm mismatch")
)

// Actor OBO act 声明：Agent 会话标识（03 篇 §6.2，动作可归因）
type Actor struct {
	AgentSessionID string `json:"agent_session"`
}

// Claims 载荷：sub(用户)/tenant/scope(权限摘要)/did(设备)/jti/act(OBO)
type Claims struct {
	Subject   string   `json:"sub"`
	TenantID  int64    `json:"tenant,omitempty"`
	Scope     []string `json:"scope,omitempty"`
	DeviceID  string   `json:"did,omitempty"`
	JWTID     string   `json:"jti"`
	Actor     *Actor   `json:"act,omitempty"`
	IssuedAt  int64    `json:"iat"`
	ExpiresAt int64    `json:"exp"`
}

// IsOBO 是否 Agent 代理令牌
func (c *Claims) IsOBO() bool { return c.Actor != nil }

type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

// Signer HS256 签发/校验器；secret 仅进程内持有
type Signer struct {
	secret []byte
	now    func() time.Time
}

// NewSigner 构造；secret 长度 ≥32 字节（启动装配处校验）
func NewSigner(secret []byte) *Signer {
	return &Signer{secret: secret, now: time.Now}
}

// SetClock 注入时钟（测试用）；非并发安全，仅装配/测试期调用
func (s *Signer) SetClock(now func() time.Time) { s.now = now }

// NewJTI 随机 jti（hex）
func NewJTI() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败不可恢复，直接 panic（启动期问题早暴露）
		panic(fmt.Sprintf("authjwt: rand: %v", err))
	}
	return fmt.Sprintf("%x", b)
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// Sign 签发 compact JWT；exp/jti/sub 为必填不变量
func (s *Signer) Sign(c Claims) (string, error) {
	if c.Subject == "" || c.JWTID == "" || c.ExpiresAt == 0 {
		return "", ErrInvalid
	}
	if c.IssuedAt == 0 {
		c.IssuedAt = s.now().Unix()
	}
	hb, err := json.Marshal(header{Alg: "HS256", Typ: "JWT"})
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signingInput := b64(hb) + "." + b64(pb)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(signingInput))
	return signingInput + "." + b64(mac.Sum(nil)), nil
}

// Parse 校验签名与有效期；过期返回 ErrExpired（1003），其余一律 ErrInvalid（1004）
func (s *Signer) Parse(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrInvalid
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalid
	}
	var h header
	if err := json.Unmarshal(hb, &h); err != nil || h.Alg != "HS256" {
		// 不变量：算法白名单，防 alg=none/算法混淆攻击
		return nil, ErrBadAlg
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, ErrInvalid
	}
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) { // 常数时间比较，防时序侧信道
		return nil, ErrInvalid
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalid
	}
	var c Claims
	if err := json.Unmarshal(pb, &c); err != nil {
		return nil, ErrInvalid
	}
	if c.ExpiresAt <= s.now().Unix() {
		return nil, ErrExpired
	}
	return &c, nil
}
