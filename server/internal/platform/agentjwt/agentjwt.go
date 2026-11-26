// Package agentjwt agent 票 ES256 签发/验签单源（D38 统一身份票据）。
//
// 终态口径（D38 拍板 1/2）：一种 agent 票（ES256 + iss/aud/act/scope），生态应用
// aud = 其 MCP 端点 URL，corp/aigw 以保留逻辑受众收编；内部 HS256 agent 票退役，
// authjwt 仅保留主 access（用户身份）。
//
// 本包职责与形状（D38 §4.1）：
//   - Issuer：签发（auth service 经 Options.AgentSigner 注入，逐受众一张）；
//   - Verifier：验签并映射回 authjwt.Claims 形状——验签方式换、claims 结构不变，
//     mcpgw/aigw 的 verify 闭包只换实现、业务（IsOBO/scope 防线/killswitch 闸）零改动；
//   - LoadKey/KidFor：密钥装载与公钥指纹 kid（拍板 7：轮换即换 kid，验证方按 kid
//     缓存公钥 miss 后重拉 jwks 自愈）。
//
// JWS compact 手写零新依赖（与 platform/authjwt 同风格）：ECDSA P-256，
// JOSE 签名 = r||s 各 32 字节（非 ASN.1）。
package agentjwt

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"

	"github.com/baobaochat/server/internal/platform/authjwt"
)

// 保留逻辑受众（D38 拍板 2）：内部端点收编为单票制的部署常量——签发格式闸白名单
// 与 mcpgw/aigw 验证端同源此处。不走 URL 受众的原因：客户端 gateway 地址与服务端
// PUBLIC_URL 在不同部署形态下不一致，URL 受众在内部端点上有对不齐的坑。
const (
	AudCorp = "bbc-corp"
	AudAigw = "bbc-aigw"
)

// MaxAudiences 单次换票受众上限（D38 §3.3：超出拒 1015，不静默截断）
const MaxAudiences = 32

// ClientID agent 票签发主体标识（票内固定声明——生态应用可据此区分票来自 bbc agent 面）
const ClientID = "bbc-agent"

// Leeway 验签时钟容差（D38 §2.1 契约：±60s）
const Leeway = 60 * time.Second

// Act act 声明：代行主体（RFC 8693 act；现口径 = desktop-{did} 设备级，D38 拍板 11）
type Act struct {
	Sub string `json:"sub,omitempty"`
}

// Claims agent 票载荷（D38 §2 契约；scope 数组形态）
type Claims struct {
	Issuer    string   `json:"iss"`
	Subject   string   `json:"sub"`
	Audience  []string `json:"aud,omitempty"`
	ClientID  string   `json:"client_id,omitempty"`
	TenantID  int64    `json:"tenant,omitempty"`
	Scope     []string `json:"scope,omitempty"`
	Actor     *Act     `json:"act,omitempty"`
	JWTID     string   `json:"jti"`
	IssuedAt  int64    `json:"iat"`
	NotBefore int64    `json:"nbf"`
	ExpiresAt int64    `json:"exp"`
}

// IsOBO 形状对齐 authjwt.Claims（act 非空即 agent 票——aigw 的 killswitch 闸语义不变）
func (c *Claims) IsOBO() bool { return c.Actor != nil }

// HasAudience aud 包含判定
func (c *Claims) HasAudience(aud string) bool {
	for _, a := range c.Audience {
		if a == aud {
			return true
		}
	}
	return false
}

// ValidAudience 签发格式闸（D38 §3.3）：合法 http(s) URL（生态应用，aud=目的地，
// 须带 host——空地址拒）或保留逻辑名（内部端点）。
// 2026-11-26 拍板修订：放开 http（原「http 拒签——票不可经明文传输出站」）。
// 缘起=内网部署目的地普遍明文（NodePort/服务地址），且更高价值的主 access token
// 本就经明文 http 传输，仅拦 agent 票属威胁模型错位；phebs 0.2.0 内网 http 目的
// 地触 1015 拒整批换票致对话全挂（连坐常驻 bbc-aigw）。暂不做私网限定（用户拍板：
// 未来需要时再加约束），公网明文目的地由发布清单纪律兜底。
func ValidAudience(aud string) bool {
	if aud == AudCorp || aud == AudAigw {
		return true
	}
	u, err := url.Parse(aud)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

// ── 密钥装载与指纹 ──────────────────────────────────────────────────────────

// LoadKey 解析 env 注入的 EC 私钥 PEM（EC PRIVATE KEY / PKCS8，P-256）。
// 空串返回 (nil, nil) 由调用方决定开发态兜底（main：临时密钥 + 警告，与
// OIDC 登录票单源同一把——D38 单票制后生态应用经 jwks 验 agent 票，两把密钥即验签失配）。
//
// 注入形态两种（2026-11-23 增补，部署便利；迁移自 oidc/keys.go）：
//   - 原始多行 PEM（K8s Secret / 文件注入场景）；
//   - base64 包裹的单行（compose .env 场景——.env 不支持多行值）。判据=不含
//     PEM 头 "-----BEGIN" 则尝试 base64 解码，解码失败仍按 PEM 原样尝试。
func LoadKey(pemStr string) (*ecdsa.PrivateKey, error) {
	if pemStr == "" {
		return nil, nil
	}
	if !strings.Contains(pemStr, "-----BEGIN") {
		if raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pemStr)); err == nil {
			pemStr = string(raw)
		}
	}
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("BBC_OIDC_SIGNING_KEY 不是合法 PEM（可传原始 PEM 或 base64 包裹单行）")
	}
	if k, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		if k.Curve != elliptic.P256() {
			return nil, errors.New("签名密钥须为 P-256（ES256）")
		}
		return k, nil
	}
	anyKey, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("签名密钥解析失败: %w", err)
	}
	k, ok := anyKey.(*ecdsa.PrivateKey)
	if !ok || k.Curve != elliptic.P256() {
		return nil, errors.New("签名密钥须为 P-256 EC 私钥（ES256）")
	}
	return k, nil
}

// GenDevKey 开发态临时密钥（P-256；main 未配 BBC_OIDC_SIGNING_KEY 时兜底）
func GenDevKey() (*ecdsa.PrivateKey, error) { return ecdsa.GenerateKey(elliptic.P256(), rand.Reader) }

// KidFor 公钥指纹 kid（D38 拍板 7）：SHA-256(PKIX 公钥) 前 16 hex。换签名密钥即
// 换 kid——旧固定串口径下轮换后验证方缓存失配且不自愈，本指纹口径 kid miss →
// 重拉 jwks → 恢复（无人工干预）。
func KidFor(pub *ecdsa.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		panic("agentjwt: 公钥序列化: " + err.Error())
	}
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:8]) // 16 hex
}

// ── 签发（auth service 经 Options.AgentSigner 注入）────────────────────────

// Issuer agent 票签发器（同进程单源：与 OIDC 登录票共用同一把私钥）
type Issuer struct {
	issuer string
	key    *ecdsa.PrivateKey
	kid    string
	now    func() time.Time
}

// NewIssuerWithKey 以既有私钥构造（main 单源装载后传入；测试直接给随机密钥）
func NewIssuerWithKey(issuer string, key *ecdsa.PrivateKey) *Issuer {
	return &Issuer{issuer: issuer, key: key, kid: KidFor(&key.PublicKey), now: time.Now}
}

// SetClock 注入时钟（测试用）；非并发安全，仅装配/测试期调用
func (i *Issuer) SetClock(now func() time.Time) { i.now = now }

// Kid 当前签名公钥指纹（诊断/对账用）
func (i *Issuer) Kid() string { return i.kid }

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// Sign 签发 compact JWS；sub/jti/exp/aud 为必填不变量；iss/client_id/nbf 未填时补默认
func (i *Issuer) Sign(c Claims) (string, error) {
	if c.Subject == "" || c.JWTID == "" || c.ExpiresAt == 0 || len(c.Audience) == 0 {
		return "", errors.New("agentjwt: sub/jti/exp/aud 必填")
	}
	if c.Issuer == "" {
		c.Issuer = i.issuer
	}
	if c.ClientID == "" {
		c.ClientID = ClientID
	}
	if c.IssuedAt == 0 {
		c.IssuedAt = i.now().Unix()
	}
	if c.NotBefore == 0 {
		c.NotBefore = c.IssuedAt
	}
	hb, err := json.Marshal(struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
		Kid string `json:"kid"`
	}{Alg: "ES256", Typ: "JWT", Kid: i.kid})
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signingInput := b64(hb) + "." + b64(pb)
	sum := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, i.key, sum[:])
	if err != nil {
		return "", err
	}
	// JOSE：r||s 各 32 字节定长（非 ASN.1 DER）
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signingInput + "." + b64(sig), nil
}

// ── 验签（mcpgw/aigw 的 verify 闭包换本实现——批 3 接线）────────────────────

// Verifier agent 票验签器（同进程单源：公钥来自同一把私钥，kid 不查表——
// jwks 对外由 oidc 模块暴露同一公钥，供生态应用本地验签）
type Verifier struct {
	issuer string
	key    *ecdsa.PublicKey
	now    func() time.Time
}

// NewVerifierWithKey 以既有私钥构造（验签用其公钥；测试直接给随机密钥）
func NewVerifierWithKey(issuer string, key *ecdsa.PrivateKey) *Verifier {
	return &Verifier{issuer: issuer, key: &key.PublicKey, now: time.Now}
}

// SetClock 注入时钟（测试用）
func (v *Verifier) SetClock(now func() time.Time) { v.now = now }

type jwsHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid"`
}

// Verify 验 ES256 agent 票并映射回 authjwt.Claims 形状（D38 §4.1——验签方式换、
// claims 结构不变，mcpgw/aigw 业务零改动：IsOBO=act 非空、act.sub→Actor.AgentSessionID）。
// expectAud 非空时要求 aud 包含之（corp/aigw 传保留名；生态应用验证端传其登记端点）。
// 错误口径与 authjwt.Parse 一致：过期 ErrExpired（1003）、其余 ErrInvalid（1004），
// httpx.Auth 映射链路无感。
func (v *Verifier) Verify(token, expectAud string) (*authjwt.Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, authjwt.ErrInvalid
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, authjwt.ErrInvalid
	}
	var h jwsHeader
	if err := json.Unmarshal(hb, &h); err != nil || h.Alg != "ES256" {
		// 不变量：算法白名单，防 alg=none / 算法混淆（authjwt HS256 同口径）
		return nil, authjwt.ErrBadAlg
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return nil, authjwt.ErrInvalid
	}
	mac := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(v.key, mac[:], r, s) { // 常数时间比较在 ecdsa 内部
		return nil, authjwt.ErrInvalid
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, authjwt.ErrInvalid
	}
	var c Claims
	if err := json.Unmarshal(pb, &c); err != nil {
		return nil, authjwt.ErrInvalid
	}
	now := v.now().Unix()
	// exp 容差 ±60s（D38 §2.1 契约）；nbf 未到同容差
	if c.ExpiresAt+int64(Leeway.Seconds()) <= now {
		return nil, authjwt.ErrExpired
	}
	if c.NotBefore > now+int64(Leeway.Seconds()) {
		return nil, authjwt.ErrInvalid
	}
	if c.Issuer != v.issuer {
		return nil, authjwt.ErrInvalid
	}
	if expectAud != "" && !c.HasAudience(expectAud) {
		return nil, authjwt.ErrInvalid
	}
	// → authjwt.Claims 形状映射（业务消费方零感知）
	out := &authjwt.Claims{
		Subject:   c.Subject,
		TenantID:  c.TenantID,
		Scope:     c.Scope,
		JWTID:     c.JWTID,
		IssuedAt:  c.IssuedAt,
		ExpiresAt: c.ExpiresAt,
	}
	if c.Actor != nil {
		out.Actor = &authjwt.Actor{AgentSessionID: c.Actor.Sub}
	}
	return out, nil
}
