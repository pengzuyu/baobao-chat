// Package config 配置装载：默认值 < 环境变量（D02 §8；配置文件/租户策略层阶段二接入）。
package config

import (
	"os"
	"strings"
	"time"
)

// Config 服务端配置（默认值 < 环境变量；Redis/S3 接入点见各 TODO）
type Config struct {
	HTTPAddr            string        // HTTP+WS 监听地址
	DBDSN               string        // PostgreSQL DSN（空 → 内存仓储回退，测试路径不变；阶段二存储接入）
	JWTSecret           string        // HS256 密钥（≥32 字节；生产经 KMS 注入，15 篇）
	AccessTTL           time.Duration // access token 有效期（03 篇 §2.2: 15min）
	OBOTTL              time.Duration // OBO token 上限（≤15min）
	RefreshTTL          time.Duration // refresh token 滑动有效期（30 天）
	SeedDemoData        bool          // 演示种子数据（开发用）
	WSHeartbeat         time.Duration // 无心跳判定半开时长（14 篇 §2.1: 60s+裕量）
	LoginMaxFails       int           // 口令错误锁定阈值（03 篇 §2.3: 5 次）
	LoginLockTTL        time.Duration // 锁定时长（10min）
	OIDCIssuer          string        // OIDC OP issuer（D28；空=按 HTTPAddr 推导本地默认）
	OIDCSigningKey      string        // ES256 私钥 PEM（D28 拍板⑩①手工轮换；空=临时密钥仅联调）
	BrandName           string        // 品牌显示名（D31 白标；OIDC 等待页等文案源）
	DeepLinkScheme      string        // 桌面端深链 scheme（D31；须与客户端 brand/brand.json 对齐）
	BootstrapMailDomain string        // 初始管理员邮箱后缀（D31；/setup 与 CLI bootstrap 建户用）
}

// DevJWTSecret 开发默认 HS256 密钥（≥32 字节仅为通过长度校验；生产必经
// BBW_JWT_SECRET/KMS 覆盖，15 篇。main 据此打"开发密钥在用"警告）。
const DevJWTSecret = "dev-only-secret-change-me-0123456789abcdef"

// Load 从环境变量装载（BBW_ 前缀）
func Load() *Config {
	c := &Config{
		HTTPAddr:      ":8080",
		JWTSecret:     DevJWTSecret,
		AccessTTL:     15 * time.Minute,
		OBOTTL:        15 * time.Minute,
		RefreshTTL:    30 * 24 * time.Hour,
		SeedDemoData:  true,
		WSHeartbeat:   90 * time.Second,
		LoginMaxFails: 5,
		LoginLockTTL:  10 * time.Minute,
	}
	if v := os.Getenv("BBW_HTTP_ADDR"); v != "" {
		c.HTTPAddr = v
	}
	if v := os.Getenv("BBW_JWT_SECRET"); v != "" {
		c.JWTSecret = v
	}
	if v := os.Getenv("BBW_DB_DSN"); v != "" {
		c.DBDSN = v
	}
	if v := os.Getenv("BBW_SEED_DEMO"); v == "0" || v == "false" {
		c.SeedDemoData = false
	}
	// OIDC（D28 批次 Q1）：issuer 缺省按 HTTPAddr 推导本地联调地址（:8090 →
	// http://127.0.0.1:8090/oauth2）；签名密钥未配走模块内临时密钥口径（仅联调）
	c.OIDCIssuer = os.Getenv("BBW_OIDC_ISSUER")
	if c.OIDCIssuer == "" {
		c.OIDCIssuer = "http://127.0.0.1" + strings.TrimPrefix(c.HTTPAddr, "") + "/oauth2"
	}
	c.OIDCSigningKey = os.Getenv("BBW_OIDC_SIGNING_KEY")
	// 品牌白标（D31）：默认值=上游身份，部署方按 brand/brand.json 对齐覆盖——
	// DeepLinkScheme 改动必须与客户端同步，否则 OIDC 深链确认登录静默失效
	c.BrandName = envOr("BBW_BRAND_NAME", "BaobaoChat")
	c.DeepLinkScheme = envOr("BBW_DEEP_LINK_SCHEME", "bbw")
	c.BootstrapMailDomain = envOr("BBW_BOOTSTRAP_MAIL_DOMAIN", "bbw.io")
	return c
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
