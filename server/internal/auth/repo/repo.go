// Package authrepo 认证域数据访问接口（内存实现先行，PG 实现阶段二接入）。
package authrepo

import (
	"context"
	"time"
)

// refresh token 状态（03 篇 §2.2：一次性轮换）
const (
	RefreshActive  = 1
	RefreshRotated = 2 // 已被轮换：再次出现即视为重放
	RefreshRevoked = 3 // 登出/强制下线
)

// RefreshToken 刷新令牌记录（只存哈希；rotated_from 构成轮换链）
type RefreshToken struct {
	ID          int64
	UserID      int64
	DeviceID    int64
	TokenHash   string // sha256hex
	ExpiresAt   time.Time
	RotatedFrom *int64 // 前驱 token ID（首签为 nil）
	Status      int
	CreatedAt   time.Time
}

// Device 在线设备（03 篇 §8 device；UK(user_id, did)）
type Device struct {
	ID           int64
	UserID       int64
	DID          string
	DeviceName   string
	OS           string
	LastActiveAt time.Time
}

// RefreshTokenRepo 刷新令牌仓储
type RefreshTokenRepo interface {
	Create(ctx context.Context, t RefreshToken) (RefreshToken, error)
	FindByTokenHash(ctx context.Context, hash string) (*RefreshToken, error)
	UpdateStatus(ctx context.Context, id int64, status int) error
	// RevokeForUser 吊销：all=true 全设备；否则仅指定 deviceID
	RevokeForUser(ctx context.Context, userID, deviceID int64, all bool) error
}

// DeviceRepo 设备仓储
type DeviceRepo interface {
	Upsert(ctx context.Context, d Device) (Device, error)
	FindByDID(ctx context.Context, userID int64, did string) (*Device, error)
}

// LoginAttemptStore 防爆破计数（阶段一内存；生产 Redis TTL，03 篇 §2.3）
type LoginAttemptStore interface {
	IsLocked(ctx context.Context, key string) (bool, time.Duration)
	// RecordFailure 记录失败并返回累计次数；达到 maxFails 即锁定 lockTTL
	RecordFailure(ctx context.Context, key string, maxFails int, lockTTL time.Duration) int
	Reset(ctx context.Context, key string)
}

// PG 实现占位（阶段二）：
//   type Postgres struct{ pool *pgxpool.Pool }
//   分别实现上述三个接口；表见 migrations/0001_init.sql（refresh_token/device）。
//   注意 RLS：refresh_token 无 tenant_id，策略经 users 子查询关联租户（见迁移注释）。
// 替换 NewMemory() 即可，service 无感知（D02 §3 构造注入）。
