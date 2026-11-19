// Package workdayrepo 工作日日历仓储（memory/postgres 双实现）。
// 只存默认规则之外的例外行；日期统一用 UTC 零点 time.Time 表达（PG date 列）。
package workdayrepo

import (
	"context"
	"time"
)

// Override 例外行（day_type: 1=工作日(含调休) 2=周末 3=节假日）
type Override struct {
	TenantID  int64
	Day       time.Time
	DayType   int16
	Name      string
	Source    string
	UpdatedBy int64
	UpdatedAt time.Time
}

// Repo 仓储接口
type Repo interface {
	// ListYear 取 [from, to) 区间内的例外行
	ListYear(ctx context.Context, tenantID int64, from, to time.Time) ([]Override, error)
	// UpsertMany 批量 upsert（同租户同日覆盖）
	UpsertMany(ctx context.Context, rows []Override) error
	// DeleteMany 删指定日期例外
	DeleteMany(ctx context.Context, tenantID int64, days []time.Time) error
	// DeleteRange 删区间例外（整年重置/导入替换用）
	DeleteRange(ctx context.Context, tenantID int64, from, to time.Time) error
}
