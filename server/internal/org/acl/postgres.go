// PG 实现：满足 Repo 接口（表见 migrations/0017_resource_acl.sql）。
// RLS 依赖池会话级 app.tenant=1 兜底（internal/platform/pgxpool 包注释）；
// ID 分配 advisory lock 9127 + max(id)+1（雪花占位，13 篇 §1）。
package acl

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

const lockKeyACL int64 = 9127

// Postgres 资源授权 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

// Grant 落授权（uk ON CONFLICT 覆盖 perm/expires——幂等）
func (p *Postgres) Grant(ctx context.Context, e Entry) (Entry, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Entry{}, err
	}
	defer tx.Rollback(ctx)
	if e.ID == 0 {
		if e.ID, err = bbwpg.AllocID(ctx, tx, lockKeyACL, "resource_acl"); err != nil {
			return Entry{}, err
		}
	}
	var expires *time.Time
	if !e.ExpiresAt.IsZero() {
		expires = &e.ExpiresAt
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO resource_acl (id, tenant_id, resource_type, resource_id,
			grant_type, grant_target, perm, granted_by, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (tenant_id, resource_type, resource_id, grant_type, grant_target)
		DO UPDATE SET perm=EXCLUDED.perm, expires_at=EXCLUDED.expires_at, granted_by=EXCLUDED.granted_by
		RETURNING id, created_at`,
		e.ID, e.TenantID, e.ResourceType, e.ResourceID,
		e.GrantType, e.GrantTarget, e.Perm, e.GrantedBy, expires).
		Scan(&e.ID, &e.CreatedAt); err != nil {
		return Entry{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Entry{}, err
	}
	return e, nil
}

func (p *Postgres) Revoke(ctx context.Context, tenantID, id int64) error {
	tag, err := p.pool.Exec(ctx,
		`DELETE FROM resource_acl WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

const entryCols = `id, tenant_id, resource_type, resource_id, grant_type, grant_target,
	perm, granted_by, COALESCE(expires_at, 'epoch'), created_at`

func scanEntry(row pgx.Row) (*Entry, error) {
	var e Entry
	if err := row.Scan(&e.ID, &e.TenantID, &e.ResourceType, &e.ResourceID,
		&e.GrantType, &e.GrantTarget, &e.Perm, &e.GrantedBy,
		&e.ExpiresAt, &e.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	// 'epoch' 零值归一（永久授权）
	if e.ExpiresAt.Equal(time.Unix(0, 0).UTC()) {
		e.ExpiresAt = time.Time{}
	}
	return &e, nil
}

func (p *Postgres) ListGrants(ctx context.Context, tenantID int64, f EntryFilter) ([]Entry, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+entryCols+` FROM resource_acl
		WHERE tenant_id=$1 AND ($2='' OR resource_type=$2) AND ($3='' OR resource_id=$3)
		ORDER BY id`, tenantID, f.ResourceType, f.ResourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// EffectiveForUser 用户视角有效集：user 直授 ∪ dept 集 ∪ role 集 ∪ tenant 公开
// （过期滤除；dept/role 空集=该层自然不命中）
func (p *Postgres) EffectiveForUser(ctx context.Context, tenantID int64,
	resourceType, resourceID string, userID int64, deptIDs, roleIDs []int64) ([]Entry, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+entryCols+` FROM resource_acl
		WHERE tenant_id=$1 AND resource_type=$2 AND resource_id=$3
		  AND (expires_at IS NULL OR expires_at > now())
		  AND (
		    (grant_type=1 AND grant_target=$4)
		    OR (grant_type=2 AND grant_target = ANY($5))
		    OR (grant_type=3 AND grant_target = ANY($6))
		    OR grant_type=4
		  )`,
		tenantID, resourceType, resourceID, userID, deptIDs, roleIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}
