// PG 实现（表见 migrations/0020_eco_expert.sql；lock 9131）。
package ecorepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

const lockKeyEco int64 = 9131

// Postgres 生态域 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

const cols = `id, tenant_id, expert_id, version, display, COALESCE(summary,''),
	source, COALESCE(owner_user_id,0), manifest, status, created_by, created_at, updated_at`

func scan(row pgx.Row) (*Expert, error) {
	var e Expert
	if err := row.Scan(&e.ID, &e.TenantID, &e.ExpertID, &e.Version, &e.Display, &e.Summary,
		&e.Source, &e.OwnerUserID, &e.Manifest, &e.Status, &e.CreatedBy, &e.CreatedAt, &e.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &e, nil
}

func (p *Postgres) Create(ctx context.Context, e Expert) (Expert, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Expert{}, err
	}
	defer tx.Rollback(ctx)
	if e.ID == 0 {
		if e.ID, err = bbwpg.AllocID(ctx, tx, lockKeyEco, "eco_expert"); err != nil {
			return Expert{}, err
		}
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO eco_expert (id, tenant_id, expert_id, version, display, summary,
			source, owner_user_id, manifest, status, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,0),$9,$10,$11)
		RETURNING created_at, updated_at`,
		e.ID, e.TenantID, e.ExpertID, e.Version, e.Display, e.Summary,
		e.Source, e.OwnerUserID, e.Manifest, e.Status, e.CreatedBy).
		Scan(&e.CreatedAt, &e.UpdatedAt); err != nil {
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
			return Expert{}, ErrDupID
		}
		return Expert{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Expert{}, err
	}
	return e, nil
}

func (p *Postgres) Get(ctx context.Context, tenantID, id int64) (*Expert, error) {
	return scan(p.pool.QueryRow(ctx,
		`SELECT `+cols+` FROM eco_expert WHERE tenant_id=$1 AND id=$2`, tenantID, id))
}

func (p *Postgres) GetByExpertID(ctx context.Context, tenantID int64, expertID string) (*Expert, error) {
	return scan(p.pool.QueryRow(ctx,
		`SELECT `+cols+` FROM eco_expert WHERE tenant_id=$1 AND expert_id=$2`, tenantID, expertID))
}

func (p *Postgres) List(ctx context.Context, tenantID int64, f ListFilter) ([]Expert, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+cols+` FROM eco_expert
		WHERE tenant_id=$1 AND ($2=0 OR source=$2) AND ($3=0 OR status=$3)
		  AND ($4=0 OR owner_user_id=$4)
		ORDER BY id`, tenantID, f.Source, f.Status, f.Owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Expert{}
	for rows.Next() {
		e, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateStatus(ctx context.Context, tenantID, id int64, status int) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE eco_expert SET status=$1, updated_at=now() WHERE tenant_id=$2 AND id=$3`,
		status, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) UpdateManifest(ctx context.Context, tenantID, id int64, version, display, summary, manifest string) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE eco_expert SET version=$1, display=$2, summary=$3, manifest=$4, updated_at=now()
		WHERE tenant_id=$5 AND id=$6`, version, display, summary, manifest, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) Delete(ctx context.Context, tenantID, id int64) error {
	tag, err := p.pool.Exec(ctx,
		`DELETE FROM eco_expert WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
