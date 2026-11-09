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
	COALESCE(msg_seq,0), COALESCE(recalled,false), created_at, deleted_at`

func scanFile(row pgx.Row) (*File, error) {
	var (
		f       File
		deleted *time.Time // deleted_at 可空（NULL=未删）
	)
	if err := row.Scan(&f.ID, &f.TenantID, &f.OwnerID, &f.Name, &f.Ext, &f.Size,
		&f.ContentType, &f.SHA256, &f.Width, &f.Height, &f.Source, &f.ConvID, &f.ScanStatus,
		&f.MsgSeq, &f.Recalled, &f.CreatedAt, &deleted); err != nil {
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

// MarkSent source→message + conv_id/msg_seq 回填（未软删行；行不存在返回 ErrNotFound）
func (p *Postgres) MarkSent(ctx context.Context, id int64, convID int64, msgSeq int64) error {
	ct, err := p.pool.Exec(ctx,
		`UPDATE file SET source = $2, conv_id = $3, msg_seq = $4 WHERE id = $1 AND deleted_at IS NULL`,
		id, SourceMessage, convID, msgSeq)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// MarkRecalledByMsg 锚点消息撤回联动（OQ-B24：文件保留、recalled=true；无匹配行=no-op）
func (p *Postgres) MarkRecalledByMsg(ctx context.Context, convID int64, msgSeq int64) error {
	_, err := p.pool.Exec(ctx,
		`UPDATE file SET recalled = true WHERE conv_id = $1 AND msg_seq = $2 AND deleted_at IS NULL`,
		convID, msgSeq)
	return err
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

// ── 管理端统计（D10 仪表盘跨域闭包；可选接口见 repo.go FileStatsReader）──

var _ FileStatsReader = (*Postgres)(nil)

// SumStorageBytes 文件存储量（未软删行 size 求和；软删回收站占用阶段二清理任务口径）
func (p *Postgres) SumStorageBytes(ctx context.Context, tenantID int64) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx,
		`SELECT COALESCE(sum(size),0) FROM file WHERE tenant_id=$1 AND deleted_at IS NULL`,
		tenantID).Scan(&n)
	return n, err
}

// ── ShareRepo PG 实现（迁移 0013 file_share） ──

// PostgresShares 分享外链 PG 仓储（advisory lock 9120）
type PostgresShares struct{ pool *pgxpool.Pool }

var _ ShareRepo = (*PostgresShares)(nil)

const lockKeyFileShare int64 = 9120

// NewPostgresShares 构造
func NewPostgresShares(pool *pgxpool.Pool) ShareRepo { return &PostgresShares{pool: pool} }

const shareCols = `id, tenant_id, file_id, creator_id, code, expire_mode,
	COALESCE(expires_at, to_timestamp(0)), COALESCE(max_times,0), used_times,
	COALESCE(password_hash,''), status, created_at`

func scanShare(row pgx.Row) (*Share, error) {
	var s Share
	if err := row.Scan(&s.ID, &s.TenantID, &s.FileID, &s.CreatorID, &s.Code, &s.ExpireMode,
		&s.ExpiresAt, &s.MaxTimes, &s.UsedTimes, &s.PasswordHash, &s.Status, &s.CreatedAt); err != nil {
		return nil, err
	}
	return &s, nil
}

func (p *PostgresShares) InsertShare(ctx context.Context, s Share) (Share, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Share{}, err
	}
	defer tx.Rollback(ctx)
	if s.ID == 0 {
		if s.ID, err = bbwpg.AllocID(ctx, tx, lockKeyFileShare, "file_share"); err != nil {
			return Share{}, err
		}
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	var expiresAt *time.Time // 零值 → NULL（expire_mode=1/3 无时限）
	if !s.ExpiresAt.IsZero() {
		expiresAt = &s.ExpiresAt
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO file_share (id, tenant_id, file_id, creator_id, code, expire_mode,
			expires_at, max_times, used_times, password_hash, status, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,0),$9,$10,$11,$12)
		RETURNING created_at`,
		s.ID, s.TenantID, s.FileID, s.CreatorID, s.Code, s.ExpireMode,
		expiresAt, s.MaxTimes, s.UsedTimes, s.PasswordHash, s.Status, s.CreatedAt).
		Scan(&s.CreatedAt); err != nil {
		return Share{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Share{}, err
	}
	return s, nil
}

func (p *PostgresShares) GetShareByCode(ctx context.Context, tenantID int64, code string) (*Share, error) {
	s, err := scanShare(p.pool.QueryRow(ctx,
		`SELECT `+shareCols+` FROM file_share WHERE tenant_id=$1 AND code=$2`, tenantID, code))
	if err != nil {
		return nil, ErrNotFound
	}
	return s, nil
}

func (p *PostgresShares) IncShareUsed(ctx context.Context, id int64) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE file_share SET used_times=used_times+1 WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresShares) DisableShare(ctx context.Context, tenantID, id, creatorID int64) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE file_share SET status=$1, updated_at=now()
		 WHERE tenant_id=$2 AND id=$3 AND creator_id=$4`, ShareDisabled, tenantID, id, creatorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ── TransferRepo PG 实现（迁移 0014） ──

// PostgresTransfers 传输记录 PG 仓储（advisory lock 9121）
type PostgresTransfers struct{ pool *pgxpool.Pool }

var _ TransferRepo = (*PostgresTransfers)(nil)

const lockKeyTransfer int64 = 9121

// NewPostgresTransfers 构造
func NewPostgresTransfers(pool *pgxpool.Pool) TransferRepo { return &PostgresTransfers{pool: pool} }

func (p *PostgresTransfers) Insert(ctx context.Context, t TransferRecord) (TransferRecord, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return TransferRecord{}, err
	}
	defer tx.Rollback(ctx)
	if t.ID == 0 {
		if t.ID, err = bbwpg.AllocID(ctx, tx, lockKeyTransfer, "transfer_record"); err != nil {
			return TransferRecord{}, err
		}
	}
	if t.CreatedAt.IsZero() {
		t.CreatedAt = time.Now()
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO transfer_record (id, tenant_id, user_id, file_id, upload_id, direction, state,
			bytes_transferred, total_bytes, error_code, created_at, updated_at)
		VALUES ($1,$2,$3,NULLIF($4,0),NULLIF($5,''),$6,$7,$8,$9,NULLIF($10,0),$11,$11)
		RETURNING created_at, updated_at`,
		t.ID, t.TenantID, t.UserID, t.FileID, t.UploadID, t.Direction, t.State,
		t.BytesTransferred, t.TotalBytes, t.ErrorCode, t.CreatedAt).
		Scan(&t.CreatedAt, &t.UpdatedAt); err != nil {
		return TransferRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TransferRecord{}, err
	}
	return t, nil
}

func (p *PostgresTransfers) GetByUpload(ctx context.Context, _ int64, uploadID string) (*TransferRecord, error) {
	return scanTransfer(p.pool.QueryRow(ctx, `
		SELECT id, tenant_id, user_id, COALESCE(file_id,0), COALESCE(upload_id,''),
			direction, state, bytes_transferred, total_bytes, COALESCE(error_code,0), created_at, updated_at
		FROM transfer_record WHERE upload_id=$1 LIMIT 1`, uploadID))
}

func (p *PostgresTransfers) UpdateProgress(ctx context.Context, id int64, state string, bytes int64, fileID int64, errorCode int) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE transfer_record SET state=$1,
			bytes_transferred=CASE WHEN $2 >= 0 THEN $2 ELSE bytes_transferred END,
			file_id=CASE WHEN $3 > 0 THEN $3 ELSE file_id END,
			error_code=CASE WHEN $4 > 0 THEN $4 ELSE error_code END,
			updated_at=now()
		WHERE id=$5`, state, bytes, fileID, errorCode, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresTransfers) ListByUser(ctx context.Context, tenantID, userID int64, direction int, limit int) ([]TransferRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, user_id, COALESCE(file_id,0), COALESCE(upload_id,''),
			direction, state, bytes_transferred, total_bytes, COALESCE(error_code,0), created_at, updated_at
		FROM transfer_record WHERE tenant_id=$1 AND user_id=$2 AND ($3=0 OR direction=$3)
		ORDER BY created_at DESC LIMIT $4`, tenantID, userID, direction, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TransferRecord{}
	for rows.Next() {
		t, serr := scanTransfer(rows)
		if serr != nil {
			return nil, serr
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func scanTransfer(row pgx.Row) (*TransferRecord, error) {
	var t TransferRecord
	if err := row.Scan(&t.ID, &t.TenantID, &t.UserID, &t.FileID, &t.UploadID,
		&t.Direction, &t.State, &t.BytesTransferred, &t.TotalBytes, &t.ErrorCode,
		&t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	return &t, nil
}
