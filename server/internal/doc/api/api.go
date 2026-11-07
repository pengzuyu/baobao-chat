// Package docapi 文档中心域对外接口与 DTO（D05 阶段一务实版）。
// v0.1 务实口径（相对 D05 §5.1 API-DOC 全表 32 项的裁剪，逐条登记）：
//   - 落地 11 项：files 列表/新建/详情/重命名/回收站删除、content 保存（乐观锁）、
//     versions 时间线/恢复、trash 列表/恢复、share 占位；
//   - 不做：WOPI session 三件套与心跳（纯 markdown 无 OnlyOffice）、preview 预览转换
//     （markdown 端内渲染）、move 移动（无 doc_folder）、import 聊天文件转协作文档
//     （依赖 file 复制管线）、permissions 授权四件套与申请审批（scope 恒 personal）、
//     templates 模板库、版本下载票据/对比视图、audit 审计、彻底删除/清空回收站
//     （doc:trash:purge 阶段二随保留期定时任务）；
//   - 全部端点 owner 私有（非 owner 一律 6001/6005，scope/ACL 阶段二）。
package docapi

import (
	"context"
)

// DocFileDTO 文档（列表项/详情/新建响应；content_md 仅详情与保存响应携带）
type DocFileDTO struct {
	ID             string `json:"id"`
	OwnerID        string `json:"owner_id"`
	Title          string `json:"title"`
	FolderID       string `json:"folder_id"`          // "0"=根
	Scope          string `json:"scope"`              // v0.1 恒 personal
	Status         int    `json:"status"`             // 1 正常 / 2 回收站
	PurgeAt        int64  `json:"purge_at,omitempty"` // ms；回收站态携带
	CurrentVersion int    `json:"current_version"`
	ContentMD      string `json:"content_md,omitempty"` // 当前正文冗余（详情携带；列表省略）
	CreatedAt      int64  `json:"created_at"`           // ms
	UpdatedAt      int64  `json:"updated_at"`           // ms
}

// DocVersionDTO 版本时间线条目（content_md 仅单版取回携带；时间线列表省略）
type DocVersionDTO struct {
	ID           string `json:"id"`
	DocID        string `json:"doc_id"`
	Version      int    `json:"version"`
	EditorID     string `json:"editor_id"`
	SnapshotType string `json:"snapshot_type"` // create|manual|restore
	Note         string `json:"note,omitempty"`
	ContentMD    string `json:"content_md,omitempty"` // 单版取回/恢复响应携带
	CreatedAt    int64  `json:"created_at"`           // ms
}

// DocListResp 列表响应（键集翻页：next_cursor = "<ms>-<id>"，空=末页）
type DocListResp struct {
	Items      []DocFileDTO `json:"items"`
	NextCursor string       `json:"next_cursor"`
	HasMore    bool         `json:"has_more"`
}

// VersionListResp 版本时间线响应（version 倒序；next_cursor=下一页起始 version，空=末页）
type VersionListResp struct {
	Items      []DocVersionDTO `json:"items"`
	NextCursor string          `json:"next_cursor"`
	HasMore    bool            `json:"has_more"`
}

// ShareResp 分享占位响应（v0.1：一次性 share_id + 7d 过期 + 假 URL；
// 不落库——doc_share 表与外链解析页阶段二，登记）
type ShareResp struct {
	ShareID   string `json:"share_id"`
	URL       string `json:"url"`        // 占位外链（阶段二落 doc_share + 解析页）
	ExpiresAt int64  `json:"expires_at"` // ms（now+7d）
	Note      string `json:"note"`       // 阶段一说明（外链页未上线）
}

// RestoreResp 恢复响应（回收站恢复/版本恢复共用骨架；版本恢复 renamed 恒 false）
type RestoreResp struct {
	File     DocFileDTO `json:"file"`
	NewVerNo int        `json:"new_version_no"` // 版本恢复=新版本号；回收站恢复=current_version
	Renamed  bool       `json:"renamed"`        // 同名冲突自动" (恢复)"后缀
}

// SaveContentResp PUT content 响应（保存成功返回新版本 + 冗余正文回执）
type SaveContentResp struct {
	File        DocFileDTO    `json:"file"`
	Version     DocVersionDTO `json:"version"`
	NextVersion int           `json:"next_version"` // = version.version（客户端重置 base_version）
}

// DocService 文档中心域服务接口（main REST 壳依赖）
type DocService interface {
	// ListFiles owner 活跃文档列表（q 名称模糊；cursor 键集翻页 "<ms>-<id>"）
	ListFiles(ctx context.Context, tenantID, userID int64, q, cursor string, limit int) (*DocListResp, error)
	// CreateFile 新建 markdown 文档（v1 空白 create 快照；同名 6015）
	CreateFile(ctx context.Context, tenantID, userID int64, title string) (*DocFileDTO, error)
	// GetFile 元数据+当前正文（非 owner/不存在/回收站态 6005；编辑态校验入口）
	GetFile(ctx context.Context, tenantID, userID, docID int64) (*DocFileDTO, error)
	// RenameFile 重命名（同名 6015；非 owner 6001）
	RenameFile(ctx context.Context, tenantID, userID, docID int64, title string) (*DocFileDTO, error)
	// TrashFile 移入回收站（purge_at=now+保留期；非 owner 6001；已在回收站 6005）
	TrashFile(ctx context.Context, tenantID, userID, docID int64) (*DocFileDTO, error)
	// SaveContent 乐观锁保存（base_version != current → 6004；成功 manual 快照 version+1）
	SaveContent(ctx context.Context, tenantID, userID, docID, baseVersion int64, contentMD string) (*SaveContentResp, error)
	// ListVersions 版本时间线（version 倒序 cursor 翻页）
	ListVersions(ctx context.Context, tenantID, userID, docID int64, cursor string, limit int) (*VersionListResp, error)
	// RestoreVersion 恢复目标版本（restore 快照新版本+正文回写；目标不存在 6013）
	RestoreVersion(ctx context.Context, tenantID, userID, docID int64, version int) (*RestoreResp, error)
	// ListTrash 回收站列表（purge_at 升序）
	ListTrash(ctx context.Context, tenantID, userID int64, cursor string, limit int) (*DocListResp, error)
	// RestoreFromTrash 回收站恢复（同名冲突自动" (恢复)"后缀；非回收站态 6011）
	RestoreFromTrash(ctx context.Context, tenantID, userID, docID int64) (*RestoreResp, error)
	// Share 分享占位（share_id+7d；假 URL——外链页/doc_share 表阶段二）
	Share(ctx context.Context, tenantID, userID, docID int64) (*ShareResp, error)
}
