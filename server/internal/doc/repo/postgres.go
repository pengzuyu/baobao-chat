// PG 实现：满足 Repo 接口（表见 migrations/0011_doc.sql）。
// RLS 依赖池会话级 app.tenant=1 兜底（internal/platform/pgxpool 包注释）；
// ID 分配 advisory lock 9116/9117 + max(id)+1（org 9101 · message 9102-9108 ·
// file 9109 · kb 9110-9113 · admin 9114-9115 已占）。
// 并发写（SaveContent 乐观锁 / RestoreVersion）走 SELECT … FOR UPDATE 行锁 + 键校验。
package docrepo

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

// advisory lock 键（表级 ID 分配互斥）
const (
	lockKeyDocFile    int64 = 9116
	lockKeyDocVersion int64 = 9117
)

// Postgres 文档中心域 PG 仓储
type Postgres struct {
	pool *pgxpool.Pool
}

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回具体类型，main 按需断言可选项）
func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

// fileCols doc_file 全列（INSERT … RETURNING / SELECT 共用；顺序固定）
const fileCols = `id, tenant_id, owner_id, title, folder_id, scope, status, purge_at, current_version, content_md, created_at, updated_at`

// scanFile 行扫描（pgx.Row/Rows 通用）
func scanFile(row pgx.Row, f *DocFile) error {
	return row.Scan(&f.ID, &f.TenantID, &f.OwnerID, &f.Title, &f.FolderID, &f.Scope,
		&f.Status, &f.PurgeAt, &f.CurrentVersion, &f.ContentMD, &f.CreatedAt, &f.UpdatedAt)
}

// verCols doc_version 全列
const verCols = `id, tenant_id, doc_id, version, editor_id, snapshot_type, content_md, created_at`

// allocID 行 ID 分配（advisory lock + max+1）
func allocID(ctx context.Context, tx pgx.Tx, lockKey int64, table string) (int64, error) {
	return bbwpg.AllocID(ctx, tx, lockKey, table)
}

// ── 文档 ──

// CreateFile 新建 + v1 create 快照（单事务）
func (p *Postgres) CreateFile(ctx context.Context, f DocFile) (DocFile, DocVersion, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return DocFile{}, DocVersion{}, err
	}
	defer tx.Rollback(ctx)
	// 同 owner 活跃同名前置判定（6015；无唯一索引兜底——软删同名行不挡路，见迁移注释）
	var dup int
	if err = tx.QueryRow(ctx,
		`SELECT 1 FROM doc_file WHERE tenant_id=$1 AND owner_id=$2 AND title=$3 AND status=1 LIMIT 1`,
		f.TenantID, f.OwnerID, f.Title).Scan(&dup); err == nil {
		return DocFile{}, DocVersion{}, ErrDupTitle
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return DocFile{}, DocVersion{}, err
	}
	id, err := allocID(ctx, tx, lockKeyDocFile, "doc_file")
	if err != nil {
		return DocFile{}, DocVersion{}, err
	}
	if err = tx.QueryRow(ctx, `
		INSERT INTO doc_file (id, tenant_id, owner_id, title, folder_id, scope, status, purge_at, current_version, content_md, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,'personal',1,NULL,1,$6,now(),now())
		RETURNING `+fileCols,
		id, f.TenantID, f.OwnerID, f.Title, f.FolderID, f.ContentMD).Scan(
		&f.ID, &f.TenantID, &f.OwnerID, &f.Title, &f.FolderID, &f.Scope,
		&f.Status, &f.PurgeAt, &f.CurrentVersion, &f.ContentMD, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return DocFile{}, DocVersion{}, err
	}
	vid, err := allocID(ctx, tx, lockKeyDocVersion, "doc_version")
	if err != nil {
		return DocFile{}, DocVersion{}, err
	}
	v := DocVersion{
		TenantID: f.TenantID, DocID: f.ID, Version: 1,
		EditorID: f.OwnerID, SnapshotType: SnapCreate, ContentMD: f.ContentMD, CreatedAt: f.CreatedAt,
	}
	if err = tx.QueryRow(ctx, `
		INSERT INTO doc_version (id, tenant_id, doc_id, version, editor_id, snapshot_type, content_md, created_at)
		VALUES ($1,$2,$3,1,$4,'create',$5,$6)
		RETURNING `+verCols,
		vid, v.TenantID, v.DocID, v.EditorID, v.ContentMD, v.CreatedAt).Scan(
		&v.ID, &v.TenantID, &v.DocID, &v.Version, &v.EditorID, &v.SnapshotType, &v.ContentMD, &v.CreatedAt); err != nil {
		return DocFile{}, DocVersion{}, err
	}
	return f, v, tx.Commit(ctx)
}

// GetFile 按 ID 查
func (p *Postgres) GetFile(ctx context.Context, id int64) (*DocFile, error) {
	var f DocFile
	if err := scanFile(p.pool.QueryRow(ctx, `SELECT `+fileCols+` FROM doc_file WHERE id=$1`, id), &f); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &f, nil
}

// ListFiles owner 活跃列表（title ILIKE 模糊 + updated_at 倒序键集翻页）
func (p *Postgres) ListFiles(ctx context.Context, tenantID, ownerID int64, q string, cursor PageCursor, limit int) ([]DocFile, error) {
	sql := `SELECT ` + fileCols + ` FROM doc_file
		WHERE tenant_id=$1 AND owner_id=$2 AND status=1`
	args := []any{tenantID, ownerID}
	if q != "" {
		args = append(args, "%"+escapeLike(q)+"%")
		sql += ` AND title ILIKE $` + strconv.Itoa(len(args))
	}
	if cursor.Ms > 0 || cursor.ID > 0 {
		args = append(args, time.UnixMilli(cursor.Ms).UTC(), cursor.ID)
		sql += ` AND (updated_at, id) < ($` + strconv.Itoa(len(args)-1) + `, $` + strconv.Itoa(len(args)) + `)`
	}
	args = append(args, limit)
	sql += ` ORDER BY updated_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args))
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DocFile, 0, 8)
	for rows.Next() {
		var f DocFile
		if err := rows.Scan(&f.ID, &f.TenantID, &f.OwnerID, &f.Title, &f.FolderID, &f.Scope,
			&f.Status, &f.PurgeAt, &f.CurrentVersion, &f.ContentMD, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// escapeLike ILIKE 通配符转义（%/_ 按字面匹配）
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// RenameFile 改标题（活跃同名 → ErrDupTitle）
func (p *Postgres) RenameFile(ctx context.Context, id int64, title string, now time.Time) (*DocFile, error) {
	var f DocFile
	err := p.pool.QueryRow(ctx, `
		UPDATE doc_file SET title=$2, updated_at=$3
		WHERE id=$1 AND NOT EXISTS (
			SELECT 1 FROM doc_file d WHERE d.tenant_id=doc_file.tenant_id
			  AND d.owner_id=doc_file.owner_id AND d.title=$2 AND d.status=1 AND d.id<>$1)
		RETURNING `+fileCols, id, title, now).Scan(
		&f.ID, &f.TenantID, &f.OwnerID, &f.Title, &f.FolderID, &f.Scope,
		&f.Status, &f.PurgeAt, &f.CurrentVersion, &f.ContentMD, &f.CreatedAt, &f.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// 区分：行不存在（6005） vs 同名冲突（6015）
		var exists int
		if perr := p.pool.QueryRow(ctx, `SELECT 1 FROM doc_file WHERE id=$1`, id).Scan(&exists); perr != nil {
			if errors.Is(perr, pgx.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, perr
		}
		return nil, ErrDupTitle
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// TrashFile 移入回收站
func (p *Postgres) TrashFile(ctx context.Context, id int64, purgeAt, now time.Time) (*DocFile, error) {
	var f DocFile
	err := p.pool.QueryRow(ctx, `
		UPDATE doc_file SET status=2, purge_at=$2, updated_at=$3
		WHERE id=$1 AND status=1
		RETURNING `+fileCols, id, purgeAt, now).Scan(
		&f.ID, &f.TenantID, &f.OwnerID, &f.Title, &f.FolderID, &f.Scope,
		&f.Status, &f.PurgeAt, &f.CurrentVersion, &f.ContentMD, &f.CreatedAt, &f.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// RestoreFile 恢复（newTitle 非空时改名）
func (p *Postgres) RestoreFile(ctx context.Context, id int64, newTitle string, now time.Time) (*DocFile, error) {
	var f DocFile
	err := p.pool.QueryRow(ctx, `
		UPDATE doc_file SET status=1, purge_at=NULL, title=COALESCE(NULLIF($2,''), title), updated_at=$3
		WHERE id=$1 AND status=2
		RETURNING `+fileCols, id, newTitle, now).Scan(
		&f.ID, &f.TenantID, &f.OwnerID, &f.Title, &f.FolderID, &f.Scope,
		&f.Status, &f.PurgeAt, &f.CurrentVersion, &f.ContentMD, &f.CreatedAt, &f.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// ListTrash owner 回收站列表（purge_at 升序键集翻页）
func (p *Postgres) ListTrash(ctx context.Context, tenantID, ownerID int64, cursor PageCursor, limit int) ([]DocFile, error) {
	sql := `SELECT ` + fileCols + ` FROM doc_file
		WHERE tenant_id=$1 AND owner_id=$2 AND status=2`
	args := []any{tenantID, ownerID}
	if cursor.Ms > 0 || cursor.ID > 0 {
		args = append(args, time.UnixMilli(cursor.Ms).UTC(), cursor.ID)
		sql += ` AND (purge_at, id) > ($` + strconv.Itoa(len(args)-1) + `, $` + strconv.Itoa(len(args)) + `)`
	}
	args = append(args, limit)
	sql += ` ORDER BY purge_at ASC, id ASC LIMIT $` + strconv.Itoa(len(args))
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DocFile, 0, 4)
	for rows.Next() {
		var f DocFile
		if err := rows.Scan(&f.ID, &f.TenantID, &f.OwnerID, &f.Title, &f.FolderID, &f.Scope,
			&f.Status, &f.PurgeAt, &f.CurrentVersion, &f.ContentMD, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// TitleActive 活跃同名判定
func (p *Postgres) TitleActive(ctx context.Context, tenantID, ownerID int64, title string, excludeID int64) (bool, error) {
	var one int
	err := p.pool.QueryRow(ctx,
		`SELECT 1 FROM doc_file WHERE tenant_id=$1 AND owner_id=$2 AND title=$3 AND status=1 AND id<>$4 LIMIT 1`,
		tenantID, ownerID, title, excludeID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ── 版本 ──

// SaveContent 乐观锁保存（FOR UPDATE 行锁 + base_version 校验 + manual 快照）
func (p *Postgres) SaveContent(ctx context.Context, docID, editorID, baseVersion int64, contentMD string, now time.Time) (DocFile, DocVersion, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return DocFile{}, DocVersion{}, err
	}
	defer tx.Rollback(ctx)
	var f DocFile
	if err = scanFile(tx.QueryRow(ctx, `SELECT `+fileCols+` FROM doc_file WHERE id=$1 FOR UPDATE`, docID), &f); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DocFile{}, DocVersion{}, ErrNotFound
		}
		return DocFile{}, DocVersion{}, err
	}
	if int64(f.CurrentVersion) != baseVersion {
		return DocFile{}, DocVersion{}, ErrVersionConflict
	}
	vid, err := allocID(ctx, tx, lockKeyDocVersion, "doc_version")
	if err != nil {
		return DocFile{}, DocVersion{}, err
	}
	var v DocVersion
	if err = tx.QueryRow(ctx, `
		INSERT INTO doc_version (id, tenant_id, doc_id, version, editor_id, snapshot_type, content_md, created_at)
		VALUES ($1,$2,$3,$4,$5,'manual',$6,$7)
		RETURNING `+verCols,
		vid, f.TenantID, f.ID, f.CurrentVersion+1, editorID, contentMD, now).Scan(
		&v.ID, &v.TenantID, &v.DocID, &v.Version, &v.EditorID, &v.SnapshotType, &v.ContentMD, &v.CreatedAt); err != nil {
		return DocFile{}, DocVersion{}, err
	}
	if err = scanFile(tx.QueryRow(ctx, `
		UPDATE doc_file SET current_version=$2, content_md=$3, updated_at=$4
		WHERE id=$1 RETURNING `+fileCols, docID, f.CurrentVersion+1, contentMD, now), &f); err != nil {
		return DocFile{}, DocVersion{}, err
	}
	return f, v, tx.Commit(ctx)
}

// ListVersions 版本时间线（version 倒序 + cursor 翻页）
func (p *Postgres) ListVersions(ctx context.Context, tenantID, docID int64, cursor int64, limit int) ([]DocVersion, error) {
	sql := `SELECT ` + verCols + ` FROM doc_version WHERE tenant_id=$1 AND doc_id=$2`
	args := []any{tenantID, docID}
	if cursor > 0 {
		args = append(args, cursor)
		sql += ` AND version < $` + strconv.Itoa(len(args))
	}
	args = append(args, limit)
	sql += ` ORDER BY version DESC LIMIT $` + strconv.Itoa(len(args))
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DocVersion, 0, 8)
	for rows.Next() {
		var v DocVersion
		if err := rows.Scan(&v.ID, &v.TenantID, &v.DocID, &v.Version, &v.EditorID, &v.SnapshotType, &v.ContentMD, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetVersion 取单版本
func (p *Postgres) GetVersion(ctx context.Context, tenantID, docID int64, version int) (*DocVersion, error) {
	var v DocVersion
	err := p.pool.QueryRow(ctx,
		`SELECT `+verCols+` FROM doc_version WHERE tenant_id=$1 AND doc_id=$2 AND version=$3`,
		tenantID, docID, version).Scan(
		&v.ID, &v.TenantID, &v.DocID, &v.Version, &v.EditorID, &v.SnapshotType, &v.ContentMD, &v.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// RestoreVersion 恢复目标版本（restore 快照新版本；绝不覆盖既有版本，06 §4.5）
func (p *Postgres) RestoreVersion(ctx context.Context, docID, editorID int64, targetVersion int, now time.Time) (DocFile, DocVersion, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return DocFile{}, DocVersion{}, err
	}
	defer tx.Rollback(ctx)
	var f DocFile
	if err = scanFile(tx.QueryRow(ctx, `SELECT `+fileCols+` FROM doc_file WHERE id=$1 FOR UPDATE`, docID), &f); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DocFile{}, DocVersion{}, ErrNotFound
		}
		return DocFile{}, DocVersion{}, err
	}
	var target DocVersion
	if err = tx.QueryRow(ctx,
		`SELECT `+verCols+` FROM doc_version WHERE doc_id=$1 AND version=$2`,
		docID, targetVersion).Scan(
		&target.ID, &target.TenantID, &target.DocID, &target.Version, &target.EditorID,
		&target.SnapshotType, &target.ContentMD, &target.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DocFile{}, DocVersion{}, ErrNotFound
		}
		return DocFile{}, DocVersion{}, err
	}
	vid, err := allocID(ctx, tx, lockKeyDocVersion, "doc_version")
	if err != nil {
		return DocFile{}, DocVersion{}, err
	}
	var v DocVersion
	if err = tx.QueryRow(ctx, `
		INSERT INTO doc_version (id, tenant_id, doc_id, version, editor_id, snapshot_type, content_md, created_at)
		VALUES ($1,$2,$3,$4,$5,'restore',$6,$7)
		RETURNING `+verCols,
		vid, f.TenantID, f.ID, f.CurrentVersion+1, editorID, target.ContentMD, now).Scan(
		&v.ID, &v.TenantID, &v.DocID, &v.Version, &v.EditorID, &v.SnapshotType, &v.ContentMD, &v.CreatedAt); err != nil {
		return DocFile{}, DocVersion{}, err
	}
	if err = scanFile(tx.QueryRow(ctx, `
		UPDATE doc_file SET current_version=$2, content_md=$3, updated_at=$4
		WHERE id=$1 RETURNING `+fileCols, docID, f.CurrentVersion+1, target.ContentMD, now), &f); err != nil {
		return DocFile{}, DocVersion{}, err
	}
	return f, v, tx.Commit(ctx)
}
