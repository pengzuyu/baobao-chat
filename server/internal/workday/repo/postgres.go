// PG 实现（表见 migrations/0004_workday_calendar.sql；无 ID 自增——主键=租户+日期）。
package workdayrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres 工作日日历 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

const cols = `tenant_id, day, day_type, name, source, updated_by, updated_at`

func scan(row pgx.Row) (*Override, error) {
	var r Override
	if err := row.Scan(&r.TenantID, &r.Day, &r.DayType, &r.Name, &r.Source, &r.UpdatedBy, &r.UpdatedAt); err != nil {
		return nil, err
	}
	r.Day = r.Day.UTC()
	return &r, nil
}

// ListYear [from,to)
func (p *Postgres) ListYear(ctx context.Context, tenantID int64, from, to time.Time) ([]Override, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT `+cols+` FROM public.workday_calendar
		 WHERE tenant_id=$1 AND day >= $2 AND day < $3 ORDER BY day`,
		tenantID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Override{}
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// UpsertMany 批量 upsert（事务）
func (p *Postgres) UpsertMany(ctx context.Context, rows []Override) error {
	if len(rows) == 0 {
		return nil
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	for _, r := range rows {
		updatedAt := r.UpdatedAt
		if updatedAt.IsZero() {
			updatedAt = time.Now()
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.workday_calendar (tenant_id, day, day_type, name, source, updated_by, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (tenant_id, day) DO UPDATE SET
				day_type=EXCLUDED.day_type, name=EXCLUDED.name, source=EXCLUDED.source,
				updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
			r.TenantID, r.Day, r.DayType, r.Name, r.Source, r.UpdatedBy, updatedAt); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// DeleteMany 删指定日期
func (p *Postgres) DeleteMany(ctx context.Context, tenantID int64, days []time.Time) error {
	if len(days) == 0 {
		return nil
	}
	_, err := p.pool.Exec(ctx,
		`DELETE FROM public.workday_calendar WHERE tenant_id=$1 AND day = ANY($2::date[])`,
		tenantID, days)
	return err
}

// DeleteRange 删区间
func (p *Postgres) DeleteRange(ctx context.Context, tenantID int64, from, to time.Time) error {
	_, err := p.pool.Exec(ctx,
		`DELETE FROM public.workday_calendar WHERE tenant_id=$1 AND day >= $2 AND day < $3`,
		tenantID, from, to)
	return err
}
