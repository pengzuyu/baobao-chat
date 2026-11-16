// 应用仓储 PG 实现（0031 / E1；lock 9135——eco 9131、admin 9133、agentbackup 9132、notify 9134 已占）。
package ecorepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

const lockKeyEcoApp int64 = 9135

// AppPostgres 应用 PG 仓储
type AppPostgres struct{ pool *pgxpool.Pool }

var _ AppRepo = (*AppPostgres)(nil)

// NewPostgresApps 构造
func NewPostgresApps(pool *pgxpool.Pool) AppRepo { return &AppPostgres{pool: pool} }

const appCols = `id, tenant_id, app_id, name, COALESCE(description,''), status,
	COALESCE(current_version,''), created_by, created_at, updated_at`

func scanApp(row pgx.Row) (*App, error) {
	var a App
	if err := row.Scan(&a.ID, &a.TenantID, &a.AppID, &a.Name, &a.Description, &a.Status,
		&a.CurrentVersion, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAppNotFound
		}
		return nil, err
	}
	return &a, nil
}

func isAppDup(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// InsertApp 登记
func (p *AppPostgres) InsertApp(ctx context.Context, a App) (App, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return App{}, err
	}
	defer tx.Rollback(ctx)
	if a.ID == 0 {
		if a.ID, err = bbwpg.AllocID(ctx, tx, lockKeyEcoApp, "eco_app"); err != nil {
			return App{}, err
		}
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO eco_app (id, tenant_id, app_id, name, description, status, created_by)
		VALUES ($1,$2,$3,$4,$5,'draft',$6)
		RETURNING created_at, updated_at`,
		a.ID, a.TenantID, a.AppID, a.Name, a.Description, a.CreatedBy).
		Scan(&a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		if isAppDup(err) {
			return App{}, ErrAppDup
		}
		return App{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return App{}, err
	}
	return a, nil
}

// GetAppByAppID 查
func (p *AppPostgres) GetAppByAppID(ctx context.Context, tenantID int64, appID string) (*App, error) {
	return scanApp(p.pool.QueryRow(ctx, `SELECT `+appCols+` FROM eco_app WHERE tenant_id=$1 AND app_id=$2`, tenantID, appID))
}

// ListApps 全量
func (p *AppPostgres) ListApps(ctx context.Context, tenantID int64) ([]App, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+appCols+` FROM eco_app WHERE tenant_id=$1 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []App{}
	for rows.Next() {
		var a App
		if err := rows.Scan(&a.ID, &a.TenantID, &a.AppID, &a.Name, &a.Description, &a.Status,
			&a.CurrentVersion, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListPublishedApps published
func (p *AppPostgres) ListPublishedApps(ctx context.Context, tenantID int64) ([]App, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+appCols+` FROM eco_app
		WHERE tenant_id=$1 AND status='published' ORDER BY name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []App{}
	for rows.Next() {
		var a App
		if err := rows.Scan(&a.ID, &a.TenantID, &a.AppID, &a.Name, &a.Description, &a.Status,
			&a.CurrentVersion, &a.CreatedBy, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SetAppStatus 状态
func (p *AppPostgres) SetAppStatus(ctx context.Context, tenantID, id int64, status, currentVersion string) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE eco_app SET status=$3, current_version=COALESCE(NULLIF($4,''), current_version), updated_at=now()
		WHERE tenant_id=$1 AND id=$2`, tenantID, id, status, currentVersion)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAppNotFound
	}
	return nil
}

const appVerCols = `id, tenant_id, app_row_id, version, manifest, high_risk, status,
	COALESCE(published_by,0), COALESCE(published_at, to_timestamp(0)), created_at`

func scanAppVersion(row pgx.Row) (*AppVersion, error) {
	var v AppVersion
	if err := row.Scan(&v.ID, &v.TenantID, &v.AppRowID, &v.Version, &v.Manifest, &v.HighRisk, &v.Status,
		&v.PublishedBy, &v.PublishedAt, &v.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAppVersionNotFound
		}
		return nil, err
	}
	return &v, nil
}

// InsertAppVersion 版本登记（lock 9135 同段复用——表级互斥）
func (p *AppPostgres) InsertAppVersion(ctx context.Context, v AppVersion) (AppVersion, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return AppVersion{}, err
	}
	defer tx.Rollback(ctx)
	if v.ID == 0 {
		if v.ID, err = bbwpg.AllocID(ctx, tx, lockKeyEcoApp, "eco_app_version"); err != nil {
			return AppVersion{}, err
		}
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO eco_app_version (id, tenant_id, app_row_id, version, manifest, high_risk)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING created_at`,
		v.ID, v.TenantID, v.AppRowID, v.Version, v.Manifest, v.HighRisk).
		Scan(&v.CreatedAt)
	if err != nil {
		if isAppDup(err) {
			return AppVersion{}, ErrAppDup
		}
		return AppVersion{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AppVersion{}, err
	}
	return v, nil
}

// ListAppVersions 版本线
func (p *AppPostgres) ListAppVersions(ctx context.Context, tenantID, appRowID int64) ([]AppVersion, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+appVerCols+` FROM eco_app_version
		WHERE tenant_id=$1 AND app_row_id=$2 ORDER BY created_at DESC`, tenantID, appRowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AppVersion{}
	for rows.Next() {
		var v AppVersion
		if err := rows.Scan(&v.ID, &v.TenantID, &v.AppRowID, &v.Version, &v.Manifest, &v.HighRisk, &v.Status,
			&v.PublishedBy, &v.PublishedAt, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetPublishedVersion 当前发布版
func (p *AppPostgres) GetPublishedVersion(ctx context.Context, tenantID, appRowID int64) (*AppVersion, error) {
	return scanAppVersion(p.pool.QueryRow(ctx, `SELECT `+appVerCols+` FROM eco_app_version
		WHERE tenant_id=$1 AND app_row_id=$2 AND status='published'
		ORDER BY published_at DESC LIMIT 1`, tenantID, appRowID))
}

// SetVersionStatus 版本状态
func (p *AppPostgres) SetVersionStatus(ctx context.Context, tenantID, id int64, status string, by int64, now time.Time) error {
	var pubAt any
	if status == "published" {
		pubAt = now
	}
	tag, err := p.pool.Exec(ctx, `
		UPDATE eco_app_version SET status=$3,
			published_by=COALESCE($4, published_by), published_at=COALESCE($5, published_at)
		WHERE tenant_id=$1 AND id=$2`, tenantID, id, status, by, pubAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAppVersionNotFound
	}
	return nil
}

// UpsertInstall 安装/升级
func (p *AppPostgres) UpsertInstall(ctx context.Context, i AppInstall) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO eco_app_install (id, tenant_id, app_row_id, user_id, version)
		VALUES (COALESCE((SELECT max(id)+1 FROM eco_app_install), 1), $1,$2,$3,$4)
		ON CONFLICT (tenant_id, app_row_id, user_id) DO UPDATE
			SET version=$4, installed_at=now()`,
		i.TenantID, i.AppRowID, i.UserID, i.Version)
	return err
}

// ListInstallsByUser 用户安装集
func (p *AppPostgres) ListInstallsByUser(ctx context.Context, tenantID, userID int64) ([]AppInstall, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, app_row_id, user_id, version, installed_at
		FROM eco_app_install WHERE tenant_id=$1 AND user_id=$2 ORDER BY installed_at DESC`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AppInstall{}
	for rows.Next() {
		var i AppInstall
		if err := rows.Scan(&i.ID, &i.TenantID, &i.AppRowID, &i.UserID, &i.Version, &i.InstalledAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// DeleteInstall 卸载
func (p *AppPostgres) DeleteInstall(ctx context.Context, tenantID, appRowID, userID int64) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM eco_app_install WHERE tenant_id=$1 AND app_row_id=$2 AND user_id=$3`,
		tenantID, appRowID, userID)
	return err
}
