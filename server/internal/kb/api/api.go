// Package kbapi 知识库域对外接口与 DTO（D24 两维度博客版）。
// D24 口径（docs/detail/D24）：「空间」产品概念消失——GET /kb/spaces 固定返回两行
// （公司知识库 company 全员可看可投 + 我的笔记 personal 仅本人）；CreateSpace 与
// grants 授权三件套已下线（隔离需求随成员制后置项另立）；页面无写入 UI，摄入 API
// 保留为 AI/IM 通道（保存默认落个人维度）。相对 D07 §5.1 的其余裁剪沿用 v0.1 登记
// （space PATCH/DELETE、from-doccenter、nodes PATCH/DELETE、audit 均不做）。
package kbapi

import (
	"context"
)

// SpaceDTO 维度行（GET /kb/spaces 列表项；固定两行：company+personal）
type SpaceDTO struct {
	ID         string `json:"id"`
	SpaceType  string `json:"space_type"` // personal|company
	Name       string `json:"name"`
	OwnerID    string `json:"owner_id"`
	DeptID     string `json:"dept_id"` // 废弃恒 "0"（dept 概念已除，列留兼容）
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
	SpaceType  string `json:"space_type,omitempty"` // company|personal（榜单/我的文章卡维度标识）
	NodeID     string `json:"node_id"`              // 空=空间根
	Title      string `json:"title"`
	SourceType string `json:"source_type"` // text|file|markdown|im
	SourceRef  string `json:"source_ref"`  // file 来源=file_id / im 来源=msg_id
	Ext        string `json:"ext"`
	Size       int64  `json:"size"`
	Status     string `json:"status"` // processing|ready|failed
	ErrorMsg   string `json:"error_msg,omitempty"`
	Version    int    `json:"version"`
	ViewCount  int64  `json:"view_count"` // 浏览量（D24）
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
	// OQ-D10：可见集<全集时的合规提示（"部分结果被策略隐藏"；空=无隐藏）
	FilteredHint string `json:"filtered_hint,omitempty"`
}

// KBService 知识库域服务接口（main REST 壳依赖）
type KBService interface {
	// ListSpaces 固定两维度行（D24）：公司知识库（幂等种子）+ 我的笔记（惰性创建，
	// 仅本人）。他人 personal 行不进结果——两维度即全部可见宇宙
	ListSpaces(ctx context.Context, tenantID, userID int64) ([]SpaceDTO, error)
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
	// ── 治理写操作（D8；权限守卫在 admin:kb:govern 路由层）──
	GovernSetSpaceStatus(ctx context.Context, tenantID, spaceID int64, archived bool) error
	GovernDeleteSpace(ctx context.Context, tenantID, spaceID int64) error
	// Query 检索：权限前置过滤（可见空间集注入两路 WHERE）→ 向量余弦 + 关键词 ILIKE
	// → RRF 融合（k=60）→ 高亮区间
	Query(ctx context.Context, tenantID, userID int64, spaceIDs []string, keyword string, topK int) (*QueryResp, error)

	// ── 浏览量/榜单/我的（D24 §4.2）──
	// RecordDocView 浏览上报：作者本人短路返回现值；否则日去重（一人一天一篇计 1）
	// 后 view_count+1
	RecordDocView(ctx context.Context, tenantID, userID, docID int64) (*ViewResp, error)
	// MySummary 个人概览：文章数/本月新增/总浏览/7 日新增/公司作者排名（0=未上榜）/最近发表
	MySummary(ctx context.Context, tenantID, userID int64) (*MeSummaryDTO, error)
	// MyDocs 我的全部文章（两维度 ready，created_at 降序；cursor=上一页末条 created_at ms）
	MyDocs(ctx context.Context, tenantID, userID int64, cursor string, limit int) (*MyDocsResp, error)
	// Rankings 榜单（board=latest|hot|authors，window=7d|30d|all 仅 hot；仅公共维度）
	Rankings(ctx context.Context, tenantID, userID int64, board, window string) (*RankingsResp, error)
}

// ViewResp POST /kb/docs/{id}/view 响应
type ViewResp struct {
	ViewCount int64 `json:"view_count"`
}

// MeSummaryDTO GET /kb/me/summary（首页概览卡）
type MeSummaryDTO struct {
	DocCount   int64   `json:"doc_count"`
	MonthNew   int64   `json:"month_new"`
	TotalViews int64   `json:"total_views"`
	Views7d    int64   `json:"views_7d"`
	AuthorRank int     `json:"author_rank"` // 0=未上榜
	LastDoc    *DocDTO `json:"last_doc,omitempty"`
}

// MyDocsResp GET /kb/me/docs 响应
type MyDocsResp struct {
	Items      []DocDTO `json:"items"`
	NextCursor string   `json:"next_cursor,omitempty"` // 空=没有更多
}

// RankDocDTO 榜单文章行（latest/hot）
type RankDocDTO struct {
	DocID     string `json:"doc_id"`
	Title     string `json:"title"`
	UserID    string `json:"user_id"`
	UserName  string `json:"user_name"` // 通道未装配时为空
	DeptName  string `json:"dept_name,omitempty"`
	NodeName  string `json:"node_name"` // 专栏名（空=维度根）
	ViewCount int64  `json:"view_count"`
	Hot       int64  `json:"hot"` // 窗口内浏览量（latest 榜恒 0；all=总浏览同 view_count）
	CreatedAt int64  `json:"created_at"` // ms
}

// RankAuthorDTO 作者榜行
type RankAuthorDTO struct {
	Rank       int    `json:"rank"` // 1 起（总浏览相同并列）
	UserID     string `json:"user_id"`
	UserName   string `json:"user_name"`
	DeptName   string `json:"dept_name,omitempty"`
	DocCount   int64  `json:"doc_count"`
	TotalViews int64  `json:"total_views"`
}

// RankingsResp GET /kb/rankings 响应（board 对应数组填一个）
type RankingsResp struct {
	Board   string          `json:"board"`
	Window  string          `json:"window,omitempty"` // hot 榜回显
	Docs    []RankDocDTO    `json:"docs,omitempty"`
	Authors []RankAuthorDTO `json:"authors,omitempty"`
}
