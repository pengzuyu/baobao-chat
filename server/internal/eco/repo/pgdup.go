// pgdup.go：PG 唯一键冲突判定（skill/plugin 子域共用）。
// 原定义在 app_repo.go（D09 生态应用），应用子域 2026-11-25 整域退役后迁此。
package ecorepo

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// isAppDup pg 23505 唯一键冲突判定（沿用历史命名，skill/plugin 的 Insert/Upsert 均以此映射重复错误）
func isAppDup(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
