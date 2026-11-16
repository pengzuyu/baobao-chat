package pgxpool

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/baobaochat/server/migrations"
)

// Migrate 幂等执行内嵌迁移（启动时调用）。
// schema_migrations 记录版本，流程与 deploy/compose/init/01-init.sh 同语义：
// 标记 dirty → 执行 → 清 dirty；已应用版本跳过，可重复执行。
// 兼容：外部通道直灌过 DDL 但无版本记录时，按 Migration.Probe 探测补登记（见 embed.go）。
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.schema_migrations (
		version BIGINT PRIMARY KEY,
		name    TEXT NOT NULL DEFAULT '',
		dirty   BOOLEAN NOT NULL DEFAULT FALSE)`); err != nil {
		return fmt.Errorf("migrate: 自举 schema_migrations: %w", err)
	}
	for _, m := range migrations.List {
		var dirty bool
		err := pool.QueryRow(ctx, `SELECT dirty FROM public.schema_migrations WHERE version=$1`, m.Version).Scan(&dirty)
		switch {
		case err == nil:
			if dirty {
				return fmt.Errorf("migrate: v%d(%s) 处于 dirty 状态，请人工修复后重试", m.Version, m.Name)
			}
			continue // 已应用，跳过（幂等）
		case !errors.Is(err, pgx.ErrNoRows):
			return fmt.Errorf("migrate: 查询 v%d: %w", m.Version, err)
		}
		// 外部已应用探测（compose init 直灌 0001 无版本记录的场景）
		if m.Probe != "" {
			var exists bool
			if err := pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, m.Probe).Scan(&exists); err != nil {
				return fmt.Errorf("migrate: 探测 %s: %w", m.Probe, err)
			}
			if exists {
				if _, err := pool.Exec(ctx,
					`INSERT INTO public.schema_migrations(version,name,dirty) VALUES($1,$2,FALSE)`, m.Version, m.Name); err != nil {
					return fmt.Errorf("migrate: 补登记 v%d: %w", m.Version, err)
				}
				continue
			}
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO public.schema_migrations(version,name,dirty) VALUES($1,$2,TRUE)`, m.Version, m.Name); err != nil {
			return fmt.Errorf("migrate: 标记 v%d: %w", m.Version, err)
		}
		// 0001 自带 BEGIN/COMMIT；无参数 Exec 走简单协议，支持多语句脚本（pgx conn.go：
		// "Always use simple protocol when there are no arguments"）
		if _, err := pool.Exec(ctx, m.SQL); err != nil {
			return fmt.Errorf("migrate: 执行 v%d(%s): %w", m.Version, m.Name, err)
		}
		if _, err := pool.Exec(ctx,
			`UPDATE public.schema_migrations SET dirty=FALSE WHERE version=$1`, m.Version); err != nil {
			return fmt.Errorf("migrate: 清 dirty v%d: %w", m.Version, err)
		}
	}
	return nil
}
