// 生态应用仓储（eco_app/version/install；0031 / E1）。
package ecorepo

import (
	"context"
	"errors"
	"time"
)

// ErrAppNotFound / ErrAppDup / ErrAppVersionNotFound 应用域 sentinel
var (
	ErrAppNotFound        = errors.New("ecorepo: app not found")
	ErrAppDup             = errors.New("ecorepo: duplicate app_id")
	ErrAppVersionNotFound = errors.New("ecorepo: app version not found")
)

// App eco_app 行
type App struct {
	ID             int64
	TenantID       int64
	AppID          string // 命名空间（crm.sync）
	Name           string
	Description    string
	Status         string // draft|published|delisted
	CurrentVersion string
	CreatedBy      int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// AppVersion eco_app_version 行
type AppVersion struct {
	ID          int64
	TenantID    int64
	AppRowID    int64
	Version     string
	Manifest    string // AppManifest JSON
	HighRisk    bool
	Status      string // draft|published|rolled_back
	PublishedBy int64
	PublishedAt time.Time // 零值=未发布
	CreatedAt   time.Time
}

// AppInstall eco_app_install 行
type AppInstall struct {
	ID          int64
	TenantID    int64
	AppRowID    int64
	UserID      int64
	Version     string
	InstalledAt time.Time
}

// AppRepo 应用仓储接口（E1：注册/版本/发布/清单/安装）
type AppRepo interface {
	// InsertApp 登记（UK(tenant,app_id) 冲突→ErrAppDup）
	InsertApp(ctx context.Context, a App) (App, error)
	// GetAppByAppID 按 app_id 查
	GetAppByAppID(ctx context.Context, tenantID int64, appID string) (*App, error)
	// ListApps 全量（管理端；created_at 倒序）
	ListApps(ctx context.Context, tenantID int64) ([]App, error)
	// ListPublishedApps published 态（用户端 catalog；name 序）
	ListPublishedApps(ctx context.Context, tenantID int64) ([]App, error)
	// SetAppStatus 状态变更（publish 时带 currentVersion 一并更新）
	SetAppStatus(ctx context.Context, tenantID, id int64, status, currentVersion string) error

	// InsertAppVersion 版本登记（UK(tenant,app_row,version) 冲突→ErrAppDup）
	InsertAppVersion(ctx context.Context, v AppVersion) (AppVersion, error)
	// ListAppVersions 版本线（created_at 倒序）
	ListAppVersions(ctx context.Context, tenantID, appRowID int64) ([]AppVersion, error)
	// GetPublishedVersion 当前发布版（无→ErrAppVersionNotFound）
	GetPublishedVersion(ctx context.Context, tenantID, appRowID int64) (*AppVersion, error)
	// SetVersionStatus 版本状态（published 时戳 published_at/by）
	SetVersionStatus(ctx context.Context, tenantID, id int64, status string, by int64, now time.Time) error

	// UpsertInstall 安装/升级（UK(tenant,app,user) 覆盖 version）
	UpsertInstall(ctx context.Context, i AppInstall) error
	// ListInstallsByUser 用户安装集（installed_at 倒序）
	ListInstallsByUser(ctx context.Context, tenantID, userID int64) ([]AppInstall, error)
	// DeleteInstall 卸载
	DeleteInstall(ctx context.Context, tenantID, appRowID, userID int64) error
}
