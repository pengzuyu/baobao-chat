// Package config 配置装载：默认值 < 环境变量（D02 §8；配置文件/租户策略层阶段二接入）。
package config

import (
	"os"
	"time"
)

// Config 服务端配置（阶段一全部单机内存态；PG/Redis/MinIO 接入点见各 TODO）
type Config struct {
	HTTPAddr      string        // HTTP+WS 监听地址
	JWTSecret     string        // HS256 密钥（≥32 字节；生产经 KMS 注入，15 篇）
	AccessTTL     time.Duration // access token 有效期（03 篇 §2.2: 15min）
	OBOTTL        time.Duration // OBO token 上限（≤15min）
	RefreshTTL    time.Duration // refresh token 滑动有效期（30 天）
	SeedDemoData  bool          // 演示种子数据（开发用）
	WSHeartbeat   time.Duration // 无心跳判定半开时长（14 篇 §2.1: 60s+裕量）
	LoginMaxFails int           // 口令错误锁定阈值（03 篇 §2.3: 5 次）
	LoginLockTTL  time.Duration // 锁定时长（10min）
}

// Load 从环境变量装载（BBW_ 前缀）
func Load() *Config {
	c := &Config{
		HTTPAddr:      ":8080",
		JWTSecret:     "dev-only-secret-change-me-0123456789abcdef",
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
	if v := os.Getenv("BBW_SEED_DEMO"); v == "0" || v == "false" {
		c.SeedDemoData = false
	}
	return c
}
