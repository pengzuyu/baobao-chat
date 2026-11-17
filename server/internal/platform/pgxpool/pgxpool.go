// Package pgxpool PG 连接池装配（存储接入点：BBC_DB_DSN 非空时启用）。
//
// RLS 兜底（最小侵入方案）：migrations/0001_init.sql 对全部业务表启用 RLS，
// 策略为 tenant_id = current_setting('app.tenant')，未设置即拒绝（03 篇 §3.2）。
// 阶段一单租户（种子租户 1），AfterConnect 在每个连接建立时统一 SET app.tenant='1'。
// 说明：当前部署以 bbc（建库 owner 且 SUPERUSER/BYPASSRLS）连接，0001 未执行
// FORCE ROW LEVEL SECURITY，RLS 实际被超级用户绕过；本 SET 是未来切换
// NOBYPASSRLS 应用账号（16 篇 §5 最小权限）后的行为保底，不依赖绕过路径。
// 多租户正确姿势（阶段二）：请求级 SET app.tenant（httpx.Tenant 注入 claims 租户）。
package pgxpool

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultTenantID 阶段一默认租户（seedDemo 种子租户，D12）
const DefaultTenantID = 1

// poolMaxConns 单实例连接上限（阶段一基线：10 足够，见 04 篇 §1.1）
const poolMaxConns = 10

// New 建池：MaxConns=10、连接超时兜底、AfterConnect 会话级 RLS 兜底 + UTC 时区。
// 建池即 Ping 探活（DSN 配置错误早失败，不拖到首个请求）。
func New(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool: 解析 DSN: %w", err)
	}
	cfg.MaxConns = poolMaxConns
	if cfg.ConnConfig.ConnectTimeout == 0 {
		cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		// RLS 会话兜底：见包注释（每连接生效，池内复用不丢失）
		if _, err := conn.Exec(ctx, fmt.Sprintf("SET app.tenant='%d'", DefaultTenantID)); err != nil {
			return fmt.Errorf("pgxpool: SET app.tenant: %w", err)
		}
		// 时区统一 UTC：timestamptz 扫描/写入语义稳定（毫秒换算不受会话时区影响）
		if _, err := conn.Exec(ctx, "SET TIME ZONE 'UTC'"); err != nil {
			return fmt.Errorf("pgxpool: SET timezone: %w", err)
		}
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pgxpool: 建池: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pgxpool: ping: %w", err)
	}
	return pool, nil
}
