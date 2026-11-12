// 插件市场仓储（eco_plugin/version/install；0036 / D22 §3 / L1）。
package ecorepo

import (
	"context"
	"errors"
	"time"
)

// ErrPluginNotFound / ErrPluginDup / ErrPluginVersionDup 插件域 sentinel
var (
	ErrPluginNotFound    = errors.New("ecorepo: plugin not found")
	ErrPluginDup         = errors.New("ecorepo: duplicate plugin_id")
	ErrPluginVersionDup  = errors.New("ecorepo: duplicate plugin version")
	ErrPluginVersionMiss = errors.New("ecorepo: plugin version not found")
)

// Plugin eco_plugin 行（manifest=校验器产出的 JSON 快照）
type Plugin struct {
	ID             int64
	TenantID       int64
	PluginID       string
	Name           string
	Description    string
	Category       string
	Policy         int // 1 force 2 recommend 3 optional
	Status         string
	CurrentVersion string
	Manifest       string
	CreatedBy      int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// PluginVersion eco_plugin_version 行（Package 仅在写入与专路径读取时携带）
type PluginVersion struct {
	ID        int64
	TenantID  int64
	PkgID     int64
	Version   string
	Notes     string
	Manifest  string
	Package   []byte
	CreatedAt time.Time
}

// PluginInstall 安装行
type PluginInstall struct {
	ID          int64
	TenantID    int64
	PkgID       int64
	UserID      int64
	Version     string
	InstalledAt time.Time
}

// PluginRepo 插件仓储（D22 §3）
type PluginRepo interface {
	InsertPlugin(ctx context.Context, p Plugin) (Plugin, error) // UK 冲突→ErrPluginDup
	GetPlugin(ctx context.Context, tenantID, id int64) (*Plugin, error)
	// GetPluginByPluginID 按命名空间（发布去重/详情）
	GetPluginByPluginID(ctx context.Context, tenantID int64, pluginID string) (*Plugin, error)
	// ListPlugins status 空=全量（管理端）；否则精确匹配（catalog 用 published）
	ListPlugins(ctx context.Context, tenantID int64, status string) ([]Plugin, error)
	UpdatePluginMeta(ctx context.Context, tenantID, id int64, name, description, category string, policy int) error
	SetPluginStatus(ctx context.Context, tenantID, id int64, status string) error
	// SetPluginCurrent publish 切当前版（manifest=该版快照）
	SetPluginCurrent(ctx context.Context, tenantID, id int64, version, manifest string) error

	InsertVersion(ctx context.Context, v PluginVersion) (PluginVersion, error) // (pkg,version) 冲突→ErrPluginVersionDup
	GetVersion(ctx context.Context, tenantID, pkgID int64, version string) (*PluginVersion, error)
	// ListVersions 版本线（恒不含 Package）
	ListVersions(ctx context.Context, tenantID, pkgID int64) ([]PluginVersion, error)
	// GetVersionPackage 包体专路径（download）
	GetVersionPackage(ctx context.Context, tenantID, pkgID int64, version string) ([]byte, error)

	UpsertPluginInstall(ctx context.Context, i PluginInstall) error
	ListPluginInstallsByUser(ctx context.Context, tenantID, userID int64) ([]PluginInstall, error)
	DeletePluginInstall(ctx context.Context, tenantID, pkgID, userID int64) error
}
