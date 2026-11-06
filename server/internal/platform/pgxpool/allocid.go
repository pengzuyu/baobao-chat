package pgxpool

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// AllocID 表级 ID 分配（自增占位，与内存版语义一致；阶段二换雪花，13 篇 §1）。
// advisory xact lock 串行化 + max(id)+1：锁随事务提交/回滚释放，
// 因此必须与业务 INSERT 同一事务调用，否则失去互斥意义。
// lockKey 需按表全局唯一；table 仅允许传入本包调用方的编译期常量（不拼接用户输入）。
func AllocID(ctx context.Context, tx pgx.Tx, lockKey int64, table string) (int64, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKey); err != nil {
		return 0, fmt.Errorf("pgxpool: advisory lock: %w", err)
	}
	var id int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(id),0)+1 FROM `+table).Scan(&id); err != nil {
		return 0, fmt.Errorf("pgxpool: alloc id(%s): %w", table, err)
	}
	return id, nil
}
