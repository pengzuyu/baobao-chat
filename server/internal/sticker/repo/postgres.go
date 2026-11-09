// Package stickerrepo PostgreSQL 实现（0022 迁移表；RLS 经连接池 app.tenant 兜底）。
package stickerrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

// NewPostgres 构造
func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

func (p *Postgres) InsertSet(ctx context.Context, s Set) (Set, error) {
	err := p.pool.QueryRow(ctx, `
		INSERT INTO sticker_set (id, tenant_id, name, owner_id, status)
		SELECT COALESCE(max(id),0)+1, $1, $2, $3, $4 FROM sticker_set
		RETURNING id, created_at`,
		s.TenantID, s.Name, nilIfZero(s.OwnerID), 1).Scan(&s.ID, &s.CreatedAt)
	return s, err
}

func (p *Postgres) GetSet(ctx context.Context, id int64) (*Set, error) {
	var s Set
	var owner *int64
	err := p.pool.QueryRow(ctx,
		`SELECT id, tenant_id, name, cover_file_id, owner_id, status FROM sticker_set WHERE id=$1`, id).
		Scan(&s.ID, &s.TenantID, &s.Name, &s.CoverFileID, &owner, &s.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if owner != nil {
		s.OwnerID = *owner
	}
	return &s, nil
}

func (p *Postgres) ListSets(ctx context.Context, tenantID int64) ([]Set, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT id, tenant_id, name, cover_file_id, owner_id, status FROM sticker_set WHERE tenant_id=$1 ORDER BY id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Set{}
	for rows.Next() {
		var s Set
		var owner *int64
		if err := rows.Scan(&s.ID, &s.TenantID, &s.Name, &s.CoverFileID, &owner, &s.Status); err != nil {
			return nil, err
		}
		if owner != nil {
			s.OwnerID = *owner
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateSetStatus(ctx context.Context, id int64, status int) error {
	tag, err := p.pool.Exec(ctx, `UPDATE sticker_set SET status=$2 WHERE id=$1`, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) UpdateSetCover(ctx context.Context, id, coverFileID int64) error {
	_, err := p.pool.Exec(ctx, `UPDATE sticker_set SET cover_file_id=$2 WHERE id=$1`, id, coverFileID)
	return err
}

func (p *Postgres) DeleteSet(ctx context.Context, id int64) error {
	tag, err := p.pool.Exec(ctx, `DELETE FROM sticker_set WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, _ = p.pool.Exec(ctx, `DELETE FROM sticker WHERE set_id=$1`, id) // 连带条目（无外键）
	return nil
}

func (p *Postgres) InsertItem(ctx context.Context, it Item) (Item, error) {
	err := p.pool.QueryRow(ctx, `
		INSERT INTO sticker (id, tenant_id, set_id, file_id, name, sort)
		SELECT COALESCE(max(id),0)+1, $1, $2, $3, $4, $5 FROM sticker
		RETURNING id, created_at`,
		it.TenantID, it.SetID, it.FileID, it.Name, it.Sort).Scan(&it.ID, &it.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // uk_sticker_set_file
			return Item{}, ErrDupItem
		}
		return Item{}, err
	}
	return it, nil
}

func (p *Postgres) GetItem(ctx context.Context, id int64) (*Item, error) {
	var it Item
	err := p.pool.QueryRow(ctx,
		`SELECT id, tenant_id, set_id, file_id, name, sort FROM sticker WHERE id=$1`, id).
		Scan(&it.ID, &it.TenantID, &it.SetID, &it.FileID, &it.Name, &it.Sort)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &it, nil
}

func (p *Postgres) ListItemsOfSets(ctx context.Context, setIDs []int64) ([]Item, error) {
	if len(setIDs) == 0 {
		return []Item{}, nil
	}
	rows, err := p.pool.Query(ctx,
		`SELECT id, tenant_id, set_id, file_id, name, sort FROM sticker WHERE set_id = ANY($1) ORDER BY set_id, sort, id`, setIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var it Item
		if err := rows.Scan(&it.ID, &it.TenantID, &it.SetID, &it.FileID, &it.Name, &it.Sort); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func (p *Postgres) DeleteItem(ctx context.Context, id int64) error {
	tag, err := p.pool.Exec(ctx, `DELETE FROM sticker WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// nilIfZero owner_id 0（公共集）→ NULL
func nilIfZero(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}
