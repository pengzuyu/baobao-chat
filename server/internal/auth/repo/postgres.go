// PG 实现（阶段二）：refresh_token / device 满足对应接口，替换 NewMemory() 即可。
// LoginAttemptStore 保留内存实现——防爆破计数是短时态（锁定窗口分钟级），
// 生产亦归 Redis TTL（03 篇 §2.3），无持久化价值。
// RLS：refresh_token/device 行的 tenant_id 取自 users（表本身策略见 0001）；
// 会话级 app.tenant=1 兜底见 internal/platform/pgxpool 包注释。
package authrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

// advisory lock 键（表级 ID 分配互斥，见 AllocID）
const (
	lockKeyRefreshToken int64 = 9103
	lockKeyDevice       int64 = 9104
)

// ── 刷新令牌 ──

// PostgresTokens refresh_token 表仓储
type PostgresTokens struct{ pool *pgxpool.Pool }

// compile-time 接口断言
var _ RefreshTokenRepo = (*PostgresTokens)(nil)

// NewPostgresTokens 构造（返回接口类型）
func NewPostgresTokens(pool *pgxpool.Pool) RefreshTokenRepo { return &PostgresTokens{pool: pool} }

// Create 落库；ID=0 时表级分配（advisory lock + max+1，雪花占位）。
// tenant_id 取自 users 行（token 记录本身无租户字段，RLS 落行需要，0001）
func (t *PostgresTokens) Create(ctx context.Context, tk RefreshToken) (RefreshToken, error) {
	if tk.CreatedAt.IsZero() {
		tk.CreatedAt = time.Now()
	}
	tx, err := t.pool.Begin(ctx)
	if err != nil {
		return RefreshToken{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	if tk.ID == 0 {
		if tk.ID, err = bbwpg.AllocID(ctx, tx, lockKeyRefreshToken, "refresh_token"); err != nil {
			return RefreshToken{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO refresh_token (id, tenant_id, user_id, device_id, token_hash, expires_at, rotated_from, status, created_at)
		SELECT $1, u.tenant_id, u.id, $2, $3, $4, $5, $6, $7 FROM users u WHERE u.id = $8`,
		tk.ID, tk.DeviceID, tk.TokenHash, tk.ExpiresAt, ptrOrNil(tk.RotatedFrom), tk.Status, tk.CreatedAt, tk.UserID); err != nil {
		return RefreshToken{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RefreshToken{}, err
	}
	return tk, nil
}

// FindByTokenHash 哈希查令牌（未命中返回 nil,nil）
func (t *PostgresTokens) FindByTokenHash(ctx context.Context, hash string) (*RefreshToken, error) {
	var (
		tk  RefreshToken
		rot *int64
	)
	err := t.pool.QueryRow(ctx, `
		SELECT id, user_id, device_id, token_hash, expires_at, rotated_from, status, created_at
		FROM refresh_token WHERE token_hash=$1`, hash).
		Scan(&tk.ID, &tk.UserID, &tk.DeviceID, &tk.TokenHash, &tk.ExpiresAt, &rot, &tk.Status, &tk.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if rot != nil {
		r := *rot
		tk.RotatedFrom = &r
	}
	return &tk, nil
}

// UpdateStatus 变更状态（轮换/吊销）
func (t *PostgresTokens) UpdateStatus(ctx context.Context, id int64, status int) error {
	_, err := t.pool.Exec(ctx, `UPDATE refresh_token SET status=$2 WHERE id=$1`, id, status)
	return err
}

// RevokeForUser 批量吊销（登出/重放处置）：all=true 全设备，否则仅指定设备
func (t *PostgresTokens) RevokeForUser(ctx context.Context, userID, deviceID int64, all bool) error {
	_, err := t.pool.Exec(ctx,
		`UPDATE refresh_token SET status=$3 WHERE user_id=$1 AND ($4::boolean OR device_id=$2)`,
		userID, deviceID, RefreshRevoked, all)
	return err
}

// ── 设备 ──

// PostgresDevices device 表仓储
type PostgresDevices struct{ pool *pgxpool.Pool }

// compile-time 接口断言
var _ DeviceRepo = (*PostgresDevices)(nil)

// NewPostgresDevices 构造（返回接口类型）
func NewPostgresDevices(pool *pgxpool.Pool) DeviceRepo { return &PostgresDevices{pool: pool} }

// Upsert UK(user_id,did)：存在即更新激活信息；不存在时 advisory lock 串行化分配 ID 后落库。
// tenant_id 取自 users 行（RLS 落行需要）
func (d *PostgresDevices) Upsert(ctx context.Context, dv Device) (Device, error) {
	if dv.LastActiveAt.IsZero() {
		dv.LastActiveAt = time.Now()
	}
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return Device{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op

	var id int64
	err = tx.QueryRow(ctx, `SELECT id FROM device WHERE user_id=$1 AND did=$2`, dv.UserID, dv.DID).Scan(&id)
	switch {
	case err == nil: // 已注册：更新激活信息（UK 命中）
		if _, err = tx.Exec(ctx,
			`UPDATE device SET device_name=$2, os=$3, last_active_at=$4 WHERE id=$1`,
			id, dv.DeviceName, dv.OS, dv.LastActiveAt); err != nil {
			return Device{}, err
		}
		dv.ID = id
	case errors.Is(err, pgx.ErrNoRows): // 新设备：锁内分配 ID 插入
		if dv.ID == 0 {
			if dv.ID, err = bbwpg.AllocID(ctx, tx, lockKeyDevice, "device"); err != nil {
				return Device{}, err
			}
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO device (id, tenant_id, user_id, did, device_name, os, last_active_at)
			SELECT $1, u.tenant_id, u.id, $3, $4, $5, $6 FROM users u WHERE u.id = $2`,
			dv.ID, dv.UserID, dv.DID, dv.DeviceName, dv.OS, dv.LastActiveAt); err != nil {
			return Device{}, err
		}
	default:
		return Device{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Device{}, err
	}
	return dv, nil
}

// FindByDID 查设备（未命中返回 nil,nil）
func (d *PostgresDevices) FindByDID(ctx context.Context, userID int64, did string) (*Device, error) {
	var (
		dv   Device
		last *time.Time
	)
	err := d.pool.QueryRow(ctx, `
		SELECT id, user_id, did, COALESCE(device_name,''), COALESCE(os,''), last_active_at
		FROM device WHERE user_id=$1 AND did=$2`, userID, did).
		Scan(&dv.ID, &dv.UserID, &dv.DID, &dv.DeviceName, &dv.OS, &last)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if last != nil {
		dv.LastActiveAt = *last
	}
	return &dv, nil
}

// ptrOrNil 可空列编码（*int64 nil → SQL NULL）
func ptrOrNil(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
