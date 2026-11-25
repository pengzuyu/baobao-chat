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
	// Readme 插件说明（D39：插件级元数据随最新上传对齐）。仅写路径使用
	// （InsertPlugin/UpdatePluginMeta 带入）；pluginCols 读列不含——读路径
	// 恒空，detail 走 GetPluginReadme 单查（列表不背长文）。
	Readme string
	/// 0=公共（管理员发布）；>0=个人插件归属（0037/方案 A：draft 仅 owner 可见可装）
	OwnerUserID int64
	CreatedBy   int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
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
	// ListPluginsByOwner 个人插件全集（方案 A：owner 的 draft+published；管理端审计）
	ListPluginsByOwner(ctx context.Context, tenantID, userID int64) ([]Plugin, error)
	UpdatePluginMeta(ctx context.Context, tenantID, id int64, name, description, category string, policy int, readme string) error
	SetPluginStatus(ctx context.Context, tenantID, id int64, status string) error
	// SetPluginCurrent publish 切当前版（manifest=该版快照）
	SetPluginCurrent(ctx context.Context, tenantID, id int64, version, manifest string) error
	// GetPluginReadme 说明专路径（D39：pluginCols 读列不含 readme，detail 单查）
	GetPluginReadme(ctx context.Context, tenantID, id int64) (string, error)

	InsertVersion(ctx context.Context, v PluginVersion) (PluginVersion, error) // (pkg,version) 冲突→ErrPluginVersionDup
	GetVersion(ctx context.Context, tenantID, pkgID int64, version string) (*PluginVersion, error)
	// ListVersions 版本线（恒不含 Package）
	ListVersions(ctx context.Context, tenantID, pkgID int64) ([]PluginVersion, error)
	// GetVersionPackage 包体专路径（download）
	GetVersionPackage(ctx context.Context, tenantID, pkgID int64, version string) ([]byte, error)

	UpsertPluginInstall(ctx context.Context, i PluginInstall) error
	ListPluginInstallsByUser(ctx context.Context, tenantID, userID int64) ([]PluginInstall, error)
	DeletePluginInstall(ctx context.Context, tenantID, pkgID, userID int64) error
	// CountPluginInstalls 装机数聚合（D39：当前装机口径——每用户一行天然去重、
	// 卸载即减；pkg_id→人数，tenant 内全量一次拉、内存拼装）
	CountPluginInstalls(ctx context.Context, tenantID int64) (map[int64]int64, error)
}
