// 灰度仓储双实现（0032 / E2）。
package ecorepo

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ── memory ──

// RolloutMemory 灰度内存仓
type RolloutMemory struct {
	mu   sync.Mutex
	rows map[int64]*Rollout // app_row_id → 行
}

var _ RolloutRepo = (*RolloutMemory)(nil)

// NewRolloutMemory 构造
func NewRolloutMemory() *RolloutMemory { return &RolloutMemory{rows: map[int64]*Rollout{}} }

// UpsertRollout 设置
func (m *RolloutMemory) UpsertRollout(_ context.Context, r Rollout) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.UpdatedAt = time.Now()
	m.rows[r.AppRowID] = &r
	return nil
}

// GetRollout 查（无行 nil）
func (m *RolloutMemory) GetRollout(_ context.Context, _, appRowID int64) (*Rollout, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rows[appRowID]; ok {
		cp := *r
		return &cp, nil
	}
	return nil, nil
}

// ── PG ──

// RolloutPostgres 灰度 PG 仓储（PK upsert 无需 ID 分配段）
type RolloutPostgres struct{ pool *pgxpool.Pool }

var _ RolloutRepo = (*RolloutPostgres)(nil)

// NewPostgresRollout 构造
func NewPostgresRollout(pool *pgxpool.Pool) RolloutRepo { return &RolloutPostgres{pool: pool} }

// UpsertRollout 设置
func (p *RolloutPostgres) UpsertRollout(ctx context.Context, r Rollout) error {
	// ID 缺省取 max+1（无并发竞争语义要求——UK 冲突走 UPDATE 分支）
	var id int64
	if err := p.pool.QueryRow(ctx, `SELECT COALESCE(max(id),0)+1 FROM eco_rollout`).Scan(&id); err != nil {
		return err
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO eco_rollout (id, tenant_id, app_row_id, version_row_id, canary_pct, whitelist, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (tenant_id, app_row_id) DO UPDATE
			SET version_row_id=$4, canary_pct=$5, whitelist=$6, updated_by=$7, updated_at=now()`,
		id, r.TenantID, r.AppRowID, r.VersionRowID, r.CanaryPct, r.Whitelist, r.UpdatedBy)
	return err
}

// GetRollout 查（无行 nil）
func (p *RolloutPostgres) GetRollout(ctx context.Context, tenantID, appRowID int64) (*Rollout, error) {
	var r Rollout
	err := p.pool.QueryRow(ctx, `
		SELECT id, tenant_id, app_row_id, version_row_id, canary_pct, whitelist, COALESCE(updated_by,0), updated_at
		FROM eco_rollout WHERE tenant_id=$1 AND app_row_id=$2`, tenantID, appRowID).
		Scan(&r.ID, &r.TenantID, &r.AppRowID, &r.VersionRowID, &r.CanaryPct, &r.Whitelist, &r.UpdatedBy, &r.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}
