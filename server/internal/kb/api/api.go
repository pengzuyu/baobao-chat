// Package kbapi 知识库域对外接口与 DTO（D07 阶段一务实版）。
// v0.1 务实口径（相对 D07 §5.1 API-KB 全表 23 项的裁剪，逐条登记）：
//   - 落地 10 项：spaces 创建/列表、nodes 列表/新建、docs 摄入/详情/分块/重摄入、
//     query 检索、jobs 简版（docs 按 status 列表代）；
//   - 不做：space PATCH/DELETE（归档策略/转让阶段二）、from-im/from-doccenter/from-agent
//     三来源（阶段二）、nodes PATCH/DELETE（移动/重命名/敏感标记/归档阶段二）、
//     grants 授权三件套（部门树 ACL 阶段二）、audit 审计（kb_query_log 未建）；
//   - 摄入为同步版（POST docs 返回即终态 ready/failed；>5s 场景阶段二换 job 表+轮询）。
package kbapi

import (
	"context"
)

// SpaceDTO 空间（GET /kb/spaces 列表项 / POST 响应）
type SpaceDTO struct {
	ID         string `json:"id"`
	SpaceType  string `json:"space_type"` // personal|dept|company
	Name       string `json:"name"`
	OwnerID    string `json:"owner_id"`
	QuotaBytes int64  `json:"quota_bytes"`
	UsedBytes  int64  `json:"used_bytes"`
	DocCount   int64  `json:"doc_count"`
	CreatedAt  int64  `json:"created_at"` // ms
}

// NodeDTO 目录（nodes 列表/新建）
type NodeDTO struct {
	ID        string `json:"id"`
	SpaceID   string `json:"space_id"`
	ParentID  string `json:"parent_id"` // 空=空间根
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"` // ms
}

// DocDTO 文档（摄入响应/列表项/详情）
type DocDTO struct {
	ID         string `json:"id"`
	SpaceID    string `json:"space_id"`
	NodeID     string `json:"node_id"` // 空=空间根
	Title      string `json:"title"`
	SourceType string `json:"source_type"` // text|file|markdown
	SourceRef  string `json:"source_ref"`  // file 来源=file_id
	Ext        string `json:"ext"`
	Size       int64  `json:"size"`
	Status     string `json:"status"` // processing|ready|failed
	ErrorMsg   string `json:"error_msg,omitempty"`
	Version    int    `json:"version"`
	CreatedBy  string `json:"created_by"`
	CreatedAt  int64  `json:"created_at"` // ms
	UpdatedAt  int64  `json:"updated_at"` // ms
}

// NodeChildren nodes 懒加载响应（子目录 + 目录下文档，D07 API-KB-05 语义）
type NodeChildren struct {
	Dirs []NodeDTO `json:"dirs"`
	Docs []DocDTO  `json:"docs"`
}

// ChunkDTO 分块（chunks 列表/上下文展开）
type ChunkDTO struct {
	Seq         int    `json:"seq"`
	HeadingPath string `json:"heading_path"`
	Content     string `json:"content"`
	TokenCount  int    `json:"token_count"`
}

// OutlineItem 大纲锚点（chunks?outline=1：heading_path 去重 + 首块 seq）
type OutlineItem struct {
	HeadingPath string `json:"heading_path"`
	Seq         int    `json:"seq"`
}

// QueryReq POST /kb/query 请求（v0.1 字段：keyword 必填；RRF 融合两路）
type QueryReq struct {
	SpaceIDs []string `json:"space_ids"` // 空=全部可见空间
	Keyword  string   `json:"keyword"`   // 必填（≤512 字）
	TopK     int      `json:"top_k"`     // 默认 10，≤20
}

// QueryHit 检索命中项（highlight 为 snippet 内的 rune 偏移区间，客户端按码点渲染 mark）
type QueryHit struct {
	DocID       string   `json:"doc_id"`
	Title       string   `json:"title"`
	SpaceID     string   `json:"space_id"`
	SpaceType   string   `json:"space_type"` // 来源空间徽章（personal/dept/company）
	ChunkSeq    int      `json:"chunk_seq"`
	HeadingPath string   `json:"heading_path"`
	Snippet     string   `json:"snippet"`
	Highlight   [][2]int `json:"highlight,omitempty"`
	Score       float64  `json:"score"` // RRF 融合分
}

// QueryResp POST /kb/query 响应
type QueryResp struct {
	Items    []QueryHit `json:"items"`
	TookMs   int64      `json:"took_ms"`
	Degraded []string   `json:"degraded,omitempty"` // vector=向量路降级（仅关键词）
}

// KBService 知识库域服务接口（main REST 壳依赖）
type KBService interface {
	// ListSpaces 可见空间列表（个人空间惰性创建；personal 只本人 + company 全员 +
	// dept 仅治理者——部门树授权阶段二，登记）
	ListSpaces(ctx context.Context, tenantID, userID int64) ([]SpaceDTO, error)
	// CreateSpace 新建空间（dept|company；personal 走惰性创建；v0.1 不校验权限点，登记）
	CreateSpace(ctx context.Context, tenantID, userID int64, spaceType, name string) (*SpaceDTO, error)
	// ListNodes 目录懒加载（子目录 + 目录下文档）
	ListNodes(ctx context.Context, tenantID, userID, spaceID, parentID int64) (*NodeChildren, error)
	// CreateNode 新建目录（同父同名 7014；>10 层 9001）
	CreateNode(ctx context.Context, tenantID, userID, spaceID, parentID int64, name string) (*NodeDTO, error)
	// IngestDoc 摄入（同步版 v0.1）：text 粘贴 / file_id 引用 D06 文件 →
	// 清洗分段（≤800 字/块）→ 嵌入（注入 EmbedFn）→ 落 kb_chunk → ready；
	// 失败 → failed+error_msg（返回 200 + 终态文档，重试走 ReingestDoc，登记）
	IngestDoc(ctx context.Context, tenantID, userID, spaceID, nodeID int64, title, format, text string, fileID int64) (*DocDTO, error)
	// ReingestDoc 重摄入（version+1；file 来源重读文件，源失效 → failed）
	ReingestDoc(ctx context.Context, tenantID, userID, docID int64) (*DocDTO, error)
	// GetDoc 文档详情（含状态/版本/错误）
	GetDoc(ctx context.Context, tenantID, userID, docID int64) (*DocDTO, error)
	// ListChunks 分块原文（seq 升序全量）
	ListChunks(ctx context.Context, tenantID, userID, docID int64) ([]ChunkDTO, error)
	// GetOutline 大纲（heading_path 去重 + 锚点 seq）
	GetOutline(ctx context.Context, tenantID, userID, docID int64) ([]OutlineItem, error)
	// ChunksAround 上下文展开（seq 前后各 1 块，INT-KB-14）
	ChunksAround(ctx context.Context, tenantID, userID, docID int64, seq int) ([]ChunkDTO, error)
	// ListJobs jobs 简版（docs 按 status 列表代，API-KB-15 降级形态）
	ListJobs(ctx context.Context, tenantID, userID, spaceID int64, status string) ([]DocDTO, error)
	// Query 检索：权限前置过滤（可见空间集注入两路 WHERE）→ 向量余弦 + 关键词 ILIKE
	// → RRF 融合（k=60）→ 高亮区间
	Query(ctx context.Context, tenantID, userID int64, spaceIDs []string, keyword string, topK int) (*QueryResp, error)
}
