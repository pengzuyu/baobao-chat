// Package docrepo 文档中心域数据访问接口（D05 阶段一务实版；内存实现先行，
// 唯一允许写 SQL 的层——D02 §3）。
// 表见 migrations/0011_doc.sql（doc_file/doc_version 两表；v0.1 全 owner 私有，
// 所有读写按 owner 过滤，scope/ACL 阶段二）。
package docrepo

import (
	"context"
	"errors"
	"time"
)

// sentinel 错误（service 层映射 6xxx 错误码）
var (
	// ErrNotFound 行不存在（文档 6005 / 版本 6013 / 回收站条目 6011）
	ErrNotFound = errors.New("docrepo: not found")
	// ErrVersionConflict 乐观锁冲突：base_version 落后于 current_version（6004，
	// 06 §7.1 PutFile base_version 校验语义的 markdown 版）
	ErrVersionConflict = errors.New("docrepo: version conflict")
	// ErrDupTitle 同 owner 活跃文档同名（6015）
	ErrDupTitle = errors.New("docrepo: duplicate title")
)

// 文档状态（doc_file.status）
const (
	StatusActive  int = 1 // 正常
	StatusTrashed int = 2 // 回收站
)

// 快照类型（doc_version.snapshot_type；auto/close/import 阶段二随 WOPI/导入补）
const (
	SnapCreate  = "create"
	SnapManual  = "manual"
	SnapRestore = "restore"
)

// PageCursor 键集翻页游标（排序列毫秒值 + 行 ID 并列兜底；零值=首页）。
// API 层字符串形态 "<ms>-<id>"，由 service 解析/拼装
type PageCursor struct {
	Ms int64
	ID int64
}

// DocFile 文档行（doc_file）
type DocFile struct {
	ID             int64
	TenantID       int64
	OwnerID        int64
	Title          string
	FolderID       int64 // 0=根
	Scope          string
	Status         int // 1 正常 / 2 回收站
	PurgeAt        *time.Time
	CurrentVersion int
	ContentMD      string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// DocVersion 版本行（doc_version；不可变——写入后仅读）
type DocVersion struct {
	ID           int64
	TenantID     int64
	DocID        int64
	Version      int
	EditorID     int64
	SnapshotType string
	ContentMD    string
	CreatedAt    time.Time
}

// Repo 文档中心域仓储接口
type Repo interface {
	// ── 文档 ──
	// CreateFile 新建文档 + v1 空白版本（snapshot_type=create）单事务落库；
	// 同 owner 活跃同名 → ErrDupTitle（6015）
	CreateFile(ctx context.Context, f DocFile) (DocFile, DocVersion, error)
	// GetFile 按 ID 查（含回收站态；不存在 → ErrNotFound）
	GetFile(ctx context.Context, id int64) (*DocFile, error)
	// ListFiles owner 活跃文档列表（q 非空按 title 模糊；updated_at 倒序键集翻页）
	ListFiles(ctx context.Context, tenantID, ownerID int64, q string, cursor PageCursor, limit int) ([]DocFile, error)
	// RenameFile 改标题（owner 内活跃同名冲突 → ErrDupTitle；行不存在 → ErrNotFound）
	RenameFile(ctx context.Context, id int64, title string, now time.Time) (*DocFile, error)
	// TrashFile 移入回收站（status=2 + purge_at；非活跃态 → ErrNotFound）
	TrashFile(ctx context.Context, id int64, purgeAt, now time.Time) (*DocFile, error)
	// RestoreFile 从回收站恢复（status=1 + 清 purge_at + 可选改名；非回收站态 → ErrNotFound）
	RestoreFile(ctx context.Context, id int64, newTitle string, now time.Time) (*DocFile, error)
	// ListTrash owner 回收站列表（purge_at 升序——先到期先展示；键集翻页）
	ListTrash(ctx context.Context, tenantID, ownerID int64, cursor PageCursor, limit int) ([]DocFile, error)
	// TitleActive 同 owner 活跃同名文档判定（6015/恢复改名依据；excludeID 排除自身）
	TitleActive(ctx context.Context, tenantID, ownerID int64, title string, excludeID int64) (bool, error)

	// ── 版本 ──
	// SaveContent 乐观锁保存正文（单事务）：FOR UPDATE 读行 →
	// baseVersion != current_version → ErrVersionConflict（6004）→
	// 落新版本（current+1，snapshot_type=manual）+ 回写 content_md/current_version/updated_at
	SaveContent(ctx context.Context, docID, editorID, baseVersion int64, contentMD string, now time.Time) (DocFile, DocVersion, error)
	// ListVersions 版本时间线（version 倒序；cursor 为上一页末条 version，0=首页）
	ListVersions(ctx context.Context, tenantID, docID int64, cursor int64, limit int) ([]DocVersion, error)
	// GetVersion 取单版本正文（恢复/预览依据；不存在 → ErrNotFound）
	GetVersion(ctx context.Context, tenantID, docID int64, version int) (*DocVersion, error)
	// RestoreVersion 恢复目标版本（单事务）：读 v 内容 → 落新版本（current+1，
	// snapshot_type=restore，正文=目标版正文）→ 回写 doc_file（06 §4.5：恢复产生
	// 新版本绝不覆盖；目标不存在 → ErrNotFound）
	RestoreVersion(ctx context.Context, docID, editorID int64, targetVersion int, now time.Time) (DocFile, DocVersion, error)
}
