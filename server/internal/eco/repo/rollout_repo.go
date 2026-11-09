// 灰度仓储（eco_rollout；0032 / E2）。
package ecorepo

import (
	"context"
	"time"
)

// Rollout eco_rollout 行
type Rollout struct {
	ID           int64
	TenantID     int64
	AppRowID     int64
	VersionRowID int64
	CanaryPct    int
	Whitelist    string // JSON 数组 user_id 字符串
	UpdatedBy    int64
	UpdatedAt    time.Time
}

// RolloutRepo 灰度仓储
type RolloutRepo interface {
	// UpsertRollout 设置灰度（UK(tenant,app) 覆盖）
	UpsertRollout(ctx context.Context, r Rollout) error
	// GetRollout 应用当前灰度（无行 nil=全量）
	GetRollout(ctx context.Context, tenantID, appRowID int64) (*Rollout, error)
}
