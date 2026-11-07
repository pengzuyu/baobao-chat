// PG 实现：满足 Repo 接口（表见 migrations/0008_file.sql）。
// RLS 依赖池会话级 app.tenant=1 兜底（internal/platform/pgxpool 包注释）；
// ID 分配 advisory lock 9109 + max(id)+1（雪花占位，13 篇 §1）；
// 并发同 sha 上传由部分唯一索引 uq_file_tenant_sha 兜底 → 23505 映射 ErrDuplicateFileSHA。
package filerepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

// advisory lock 键（表级 ID 分配互斥；message 域已占 9102-9108，本表 9109）
const lockKeyFile int64 = 9109

// Postgres 文件域 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

// fileCols 文件列（可空列 COALESCE 兜底；conv_id 0=未关联）
const fileCols = `id, tenant_id, owner_id, name, COALESCE(ext,''), size,
	COALESCE(content_type,'application/octet-stream'), sha256,
	COALESCE(width,0), COALESCE(height,0), source, COALESCE(conv_id,0), scan_status,
	created_at, deleted_at`

func scanFile(row pgx.Row) (*File, error) {
	var (
		f       File
		deleted *time.Time // deleted_at 可空（NULL=未删）
	)
	if err := row.Scan(&f.ID, &f.TenantID, &f.OwnerID, &f.Name, &f.Ext, &f.Size,
		&f.ContentType, &f.SHA256, &f.Width, &f.Height, &f.Source, &f.ConvID, &f.ScanStatus,
		&f.CreatedAt, &deleted); err != nil {
		return nil, err
	}
	if deleted != nil {
		f.DeletedAt = *deleted
	}
	return &f, nil
}

// Insert 新增；ID=0 时 advisory lock 9109 分配；同 sha 冲突 23505 → ErrDuplicateFileSHA
func (p *Postgres) Insert(ctx context.Context, f File) (File, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)
	if f.ID == 0 {
		if f.ID, err = bbwpg.AllocID(ctx, tx, lockKeyFile, "file"); err != nil {
			return File{}, err
		}
	}
	if f.CreatedAt.IsZero() {
		f.CreatedAt = time.Now()
	}
	if f.DeletedAt.IsZero() {
		err = tx.QueryRow(ctx, `
			INSERT INTO file (id, tenant_id, owner_id, name, ext, size, content_type, sha256,
				width, height, source, conv_id, scan_status, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			RETURNING created_at`,
			f.ID, f.TenantID, f.OwnerID, f.Name, f.Ext, f.Size, f.ContentType, f.SHA256,
			f.Width, f.Height, f.Source, i64OrNull(f.ConvID), f.ScanStatus, f.CreatedAt).
			Scan(&f.CreatedAt)
	} else {
		err = tx.QueryRow(ctx, `
			INSERT INTO file (id, tenant_id, owner_id, name, ext, size, content_type, sha256,
				width, height, source, conv_id, scan_status, created_at, deleted_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
			RETURNING created_at`,
			f.ID, f.TenantID, f.OwnerID, f.Name, f.Ext, f.Size, f.ContentType, f.SHA256,
			f.Width, f.Height, f.Source, i64OrNull(f.ConvID), f.ScanStatus, f.CreatedAt, f.DeletedAt).
			Scan(&f.CreatedAt)
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return File{}, ErrDuplicateFileSHA
		}
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	return f, nil
}

// Get 按 ID 查（含已软删行；软删判定在 service）
func (p *Postgres) Get(ctx context.Context, id int64) (*File, error) {
	f, err := scanFile(p.pool.QueryRow(ctx, `SELECT `+fileCols+` FROM file WHERE id = $1`, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return f, nil
}

// GetBySHA 同租户同 sha 未软删行；无命中 nil,nil
func (p *Postgres) GetBySHA(ctx context.Context, tenantID int64, sha256 string) (*File, error) {
	f, err := scanFile(p.pool.QueryRow(ctx,
		`SELECT `+fileCols+` FROM file WHERE tenant_id = $1 AND sha256 = $2 AND deleted_at IS NULL`,
		tenantID, sha256))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return f, nil
}

// SoftDelete 软删（行不存在返回 ErrNotFound；重复软删幂等覆盖）
func (p *Postgres) SoftDelete(ctx context.Context, id int64, at time.Time) error {
	ct, err := p.pool.Exec(ctx, `UPDATE file SET deleted_at = $2 WHERE id = $1`, id, at)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// MarkSent source→message + conv_id 回填（未软删行；行不存在返回 ErrNotFound）
func (p *Postgres) MarkSent(ctx context.Context, id int64, convID int64) error {
	ct, err := p.pool.Exec(ctx,
		`UPDATE file SET source = $2, conv_id = $3 WHERE id = $1 AND deleted_at IS NULL`,
		id, SourceMessage, convID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListByUser 我的文件（未软删，created_at 倒序；v0.1 全量 Top500 兜底，cursor 阶段二）
func (p *Postgres) ListByUser(ctx context.Context, tenantID, userID int64) ([]File, error) {
	return p.list(ctx, `SELECT `+fileCols+` FROM file
		WHERE tenant_id = $1 AND owner_id = $2 AND deleted_at IS NULL
		ORDER BY created_at DESC, id DESC LIMIT 500`, tenantID, userID)
}

// ListByConv 会话文件聚合（未软删，created_at 倒序）
func (p *Postgres) ListByConv(ctx context.Context, tenantID, convID int64) ([]File, error) {
	return p.list(ctx, `SELECT `+fileCols+` FROM file
		WHERE tenant_id = $1 AND conv_id = $2 AND deleted_at IS NULL
		ORDER BY created_at DESC, id DESC LIMIT 500`, tenantID, convID)
}

func (p *Postgres) list(ctx context.Context, sql string, args ...any) ([]File, error) {
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]File, 0, 16)
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// i64OrNull 零值落 NULL（conv_id 可空列）
func i64OrNull(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}
