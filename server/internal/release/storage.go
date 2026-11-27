// storage.go：client_release 表读写（pgxpool 直查；无独立 repo 层，同 oidc 风格）。
package release

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotEditable 已发布内容不可覆盖（制品不可变）
var ErrNotEditable = errors.New("release: 已发布版本不可修改，请发新版本或先撤回")

// Store client_release 存储
type Store struct {
	db *pgxpool.Pool
}

// NewStore 构造
func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

const recordCols = `id, version, channel, platform, filename, size, sha256, storage_key,
signature, notes, status, published_at, created_at`

func scanRecord(row pgx.Row) (Record, error) {
	var r Record
	var pubAt *time.Time
	err := row.Scan(&r.ID, &r.Version, &r.Channel, &r.Platform, &r.Filename, &r.Size,
		&r.SHA256, &r.StorageKey, &r.Signature, &r.Notes, &r.Status, &pubAt, &r.CreatedAt)
	if err != nil {
		return r, err
	}
	r.HasSig = r.Signature != ""
	if pubAt != nil {
		r.PublishedAt = *pubAt
	}
	return r, nil
}

// Upsert 登记制品（草稿态幂等覆盖；已发布/已撤回行拒绝覆盖=制品不可变）
func (s *Store) Upsert(ctx context.Context, tenantID int64, r *Record, createdBy int64) (*Record, error) {
	const q = `
INSERT INTO client_release (tenant_id, version, channel, platform, filename, size, sha256,
                            storage_key, signature, notes, status, created_by)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)
ON CONFLICT (tenant_id, channel, version, platform, filename) DO UPDATE
SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256, storage_key = EXCLUDED.storage_key,
    signature = EXCLUDED.signature, notes = EXCLUDED.notes, updated_at = now()
WHERE client_release.status = 'draft'
RETURNING ` + recordCols
	row := s.db.QueryRow(ctx, q, tenantID, r.Version, r.Channel, r.Platform, r.Filename,
		r.Size, r.SHA256, r.StorageKey, r.Signature, r.Notes, createdBy)
	out, err := scanRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotEditable // ON CONFLICT ... WHERE 未命中：该行已发布/已撤回
	}
	if err != nil {
		return nil, fmt.Errorf("release: upsert: %w", err)
	}
	return &out, nil
}

// ListByChannel 该通道全部记录（新→旧；管理页用）
func (s *Store) ListByChannel(ctx context.Context, tenantID int64, channel string) ([]Record, error) {
	const q = `SELECT ` + recordCols + ` FROM client_release
WHERE tenant_id = $1 AND channel = $2
ORDER BY created_at DESC, id DESC`
	rows, err := s.db.Query(ctx, q, tenantID, channel)
	if err != nil {
		return nil, fmt.Errorf("release: list: %w", err)
	}
	defer rows.Close()
	out := make([]Record, 0, 16)
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PublishedByChannel 该通道已发布记录（清单生成用）
func (s *Store) PublishedByChannel(ctx context.Context, tenantID int64, channel string) ([]Record, error) {
	const q = `SELECT ` + recordCols + ` FROM client_release
WHERE tenant_id = $1 AND channel = $2 AND status = 'published'
ORDER BY published_at DESC, id DESC`
	rows, err := s.db.Query(ctx, q, tenantID, channel)
	if err != nil {
		return nil, fmt.Errorf("release: published: %w", err)
	}
	defer rows.Close()
	out := make([]Record, 0, 16)
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PublishVersion 整版本发布：该版本全部 draft 行 → published（published_at=now）。
// 返回影响行数（0=无可发布草稿——要么不存在，要么已发布）。
func (s *Store) PublishVersion(ctx context.Context, tenantID int64, channel, version string) (int64, error) {
	// 撤回后可重新发布（0.1.6 修：revoked 也是「已登记未分发」的制品，重新发布=
	// 重新进入分发且 publish_at 提升为 now，立即成为线上版本；draft/revoked 一并捞起）
	const q = `UPDATE client_release SET status = 'published', published_at = now(), updated_at = now()
WHERE tenant_id = $1 AND channel = $2 AND version = $3 AND status IN ('draft', 'revoked')`
	tag, err := s.db.Exec(ctx, q, tenantID, channel, version)
	if err != nil {
		return 0, fmt.Errorf("release: publish: %w", err)
	}
	return tag.RowsAffected(), nil
}

// RevokeVersion 撤回整版本（published → revoked；从清单与历史移除，文件保留供审计）。
func (s *Store) RevokeVersion(ctx context.Context, tenantID int64, channel, version string) (int64, error) {
	const q = `UPDATE client_release SET status = 'revoked', updated_at = now()
WHERE tenant_id = $1 AND channel = $2 AND version = $3 AND status = 'published'`
	tag, err := s.db.Exec(ctx, q, tenantID, channel, version)
	if err != nil {
		return 0, fmt.Errorf("release: revoke: %w", err)
	}
	return tag.RowsAffected(), nil
}

// TouchVersion 回滚：把目标版本 published_at 提升为 now（清单指针语义，不挪文件）。
// status 需仍为 published（撤回过的版本不能回滚——先重新发布）。
func (s *Store) TouchVersion(ctx context.Context, tenantID int64, channel, version string) (int64, error) {
	const q = `UPDATE client_release SET published_at = now(), updated_at = now()
WHERE tenant_id = $1 AND channel = $2 AND version = $3 AND status = 'published'`
	tag, err := s.db.Exec(ctx, q, tenantID, channel, version)
	if err != nil {
		return 0, fmt.Errorf("release: rollback: %w", err)
	}
	return tag.RowsAffected(), nil
}

// DeleteDraft 删除单条记录（draft/revoked 可删——撤回版已不在分发，删记录即可；
// published 不可删，只能撤回后再删。制品文件保留在对象存储不动）
func (s *Store) DeleteDraft(ctx context.Context, tenantID, id int64) error {
	const q = `DELETE FROM client_release WHERE tenant_id = $1 AND id = $2 AND status IN ('draft', 'revoked')`
	tag, err := s.db.Exec(ctx, q, tenantID, id)
	if err != nil {
		return fmt.Errorf("release: delete: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotEditable
	}
	return nil
}