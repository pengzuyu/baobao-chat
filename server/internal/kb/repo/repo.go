// Package kbrepo 知识库域数据访问接口（D07 阶段一务实版；内存实现先行，
// 唯一允许写 SQL 的层——D02 §3）。
// 表见 migrations/0009_kb.sql（kb_space/kb_node/kb_doc/kb_chunk 四表；
// embedding 列 pgvector vector(1024) / float8[] 双轨）。
package kbrepo

import (
	"context"
	"errors"
	"time"
)

// sentinel 错误（service 层映射 7xxx 错误码）
var (
	// ErrNotFound 行不存在（空间 7001 / 节点 7005 / 文档 9002）
	ErrNotFound = errors.New("kbrepo: not found")
	// ErrDupNode 同父同名目录冲突（7014）
	ErrDupNode = errors.New("kbrepo: duplicate sibling node")
	// ErrDupPersonal 同租户同用户 personal 空间已存在（并发惰性创建兜底；
	// service 捕获后改走 GetPersonal 复用）
	ErrDupPersonal = errors.New("kbrepo: duplicate personal space")
)

// 空间类型（D24 两维度：公司知识库 company 全租户唯一 + personal 我的笔记每人一行；
// dept 已废除——0037 迁移存量并入 company，"空间"产品概念消失，本表退化为内部维度行）
const (
	SpacePersonal = "personal"
	SpaceCompany  = "company"
)

// 文档来源（v0.1 三态：粘贴文本 / 文件引用 / markdown 文本；im=消息转存）
const (
	SourceText     = "text"
	SourceFile     = "file"
	SourceIM       = "im" // IM 消息转存（E6）
	SourceMarkdown = "markdown"
)

// 摄入状态（同步版三态；pending/parsing/chunking/embedding 细分随阶段二 job 表）
const (
	DocProcessing = "processing"
	DocReady      = "ready"
	DocFailed     = "failed"
)

// Space 空间行（kb_space）
type Space struct {
	ID         int64
	TenantID   int64
	SpaceType  string // personal|dept|company
	Name       string
	OwnerID    int64
	DeptID     int64 // 部门挂靠（阶段二）
	QuotaBytes int64
	UsedBytes  int64
	Status     string
	CreatedAt  time.Time
}

// Node 目录行（kb_node；v0.1 仅 dir）
type Node struct {
	ID        int64
	TenantID  int64
	SpaceID   int64
	ParentID  int64 // 0=空间根
	NodeType  string
	Name      string
	Path      string
	Sort      int
	Status    string
	CreatedBy int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Doc 文档行（kb_doc；Content 为 text/markdown 来源的原文冗余——重摄入依据）
type Doc struct {
	ID         int64
	TenantID   int64
	SpaceID    int64
	NodeID     int64 // 0=空间根
	Title      string
	SourceType string // text|file|markdown|im（D24：doc 来源已废）
	SourceRef  string // file 来源=file_id / im 来源=msg_id
	Ext        string
	Size       int64
	Status     string
	ErrorMsg   string
	Version    int
	Content    string
	ViewCount  int64 // 浏览量冗余总计（kb_doc_view 日去重流水驱动，D24）
	CreatedBy  int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// RankDoc 榜单文章行（D24 §4.2；仅公共维度）
type RankDoc struct {
	Doc      Doc
	NodeName string // 专栏名（空间根=""）
	Hot      int64  // 窗口内浏览量（hot 榜 window=all 时=view_count 同值）
}

// AuthorRank 作者榜行（D24：公共维度文章聚合）
type AuthorRank struct {
	UserID     int64
	DocCount   int64
	TotalViews int64
}

// UserKBStats 个人概览聚合（D24 me/summary）
type UserKBStats struct {
	DocCount   int64 // ready 文章数（两维度）
	MonthNew   int64 // 本月新增（created_at ≥ monthStart）
	TotalViews int64 // 全部文章浏览量总计
	Views7d    int64 // 近 7 日新增浏览
	AuthorRank int   // 公司维度作者排名（按公共文章总浏览；0=未上榜）
}

// Chunk 分块行（kb_chunk；Embedding 1024 维）
type Chunk struct {
	ID          int64
	TenantID    int64
	DocID       int64
	SpaceID     int64
	Seq         int
	HeadingPath string
	Text        string
	TokenCount  int
	Embedding   []float32
	CreatedAt   time.Time
}

// ChunkHit 检索命中（chunk 精简字段 + 文档标题冗余 + 该路得分）
type ChunkHit struct {
	ChunkID     int64
	DocID       int64
	SpaceID     int64
	Seq         int
	HeadingPath string
	Text        string
	DocTitle    string
	Score       float64
	emb         []float32 // 降级轨内存余弦用（float8[] 取回后暂存，不透出）
}

// Repo 知识库域仓储接口
type Repo interface {
	// ── 空间 ──
	// EnsurePersonalSpace 个人空间惰性创建（幂等：已存在直接返回；并发创建由
	// uq_kb_space_personal 兜底 → 复用既有行）。quota 为默认配额（仅首次创建生效）
	EnsurePersonalSpace(ctx context.Context, tenantID, userID, quotaBytes int64) (Space, error)
	// EnsureCompanySpace 公司知识库维度行幂等种子（D24：全租户唯一，uq_kb_space_company
	// 兜底并发；quota 仅首次生效；owner_id=0 系统行）
	EnsureCompanySpace(ctx context.Context, tenantID, quotaBytes int64) (Space, error)
	// GetPersonal 同租户同用户 personal 空间；无命中返回 nil, nil
	GetPersonal(ctx context.Context, tenantID, userID int64) (*Space, error)
	GetSpace(ctx context.Context, id int64) (*Space, error)
	ListSpaces(ctx context.Context, tenantID int64) ([]Space, error)
	// SetSpaceStatus 治理停用/启用（status: active|archived；D8）
	SetSpaceStatus(ctx context.Context, tenantID, spaceID int64, status string) error
	// DeleteSpace 级联删除（chunk/doc/node/space 四表；D8——personal 由 service 拒 7010）
	DeleteSpace(ctx context.Context, tenantID, spaceID int64) error

	// ── 目录 ──
	// CreateNode 新建目录；同父同名冲突（uq_kb_node_sibling）→ ErrDupNode
	CreateNode(ctx context.Context, n Node) (Node, error)
	GetNode(ctx context.Context, id int64) (*Node, error)
	// ListChildNodes 直接子目录（parentID=0 → 空间根），name 升序
	ListChildNodes(ctx context.Context, tenantID, spaceID, parentID int64) ([]Node, error)

	// ── 文档 ──
	CreateDoc(ctx context.Context, d Doc) (Doc, error)
	// SetDocSource 回填来源标记（E6 外部通道：doc 同步/IM 转存）
	SetDocSource(ctx context.Context, tenantID, docID int64, sourceType, sourceRef string) error
	GetDoc(ctx context.Context, id int64) (*Doc, error)
	// FailDoc 摄入失败落状态（status=failed + error_msg；version 不动）
	FailDoc(ctx context.Context, docID int64, errMsg string, now time.Time) error
	// IngestCommit 摄入事务提交（检索无中间态，11 §4.2）：
	// 删旧 chunk → 批量插新 chunk → doc 置 ready（version+1、error 清空）
	// → space.used_bytes += usedDelta。返回提交后的 doc 行
	IngestCommit(ctx context.Context, docID int64, chunks []Chunk, usedDelta int64, now time.Time) (Doc, error)
	// ListDocsByNode 目录下文档（created_at 倒序；nodeID=0 → 空间根直挂）
	ListDocsByNode(ctx context.Context, tenantID, spaceID, nodeID int64) ([]Doc, error)
	// ListDocsBySpace 空间全量文档（jobs 简版列表 + 文档数统计，updated_at 倒序）
	ListDocsBySpace(ctx context.Context, tenantID, spaceID int64) ([]Doc, error)

	// ── 分块 ──
	ListChunks(ctx context.Context, tenantID, docID int64) ([]Chunk, error)
	// ListChunksAround seq 前后各 before/after 块（引用上下文展开，INT-KB-14）
	ListChunksAround(ctx context.Context, tenantID, docID int64, seq, before, after int) ([]Chunk, error)

	// ── 检索（权限前置过滤：spaceIDs 为调用方已按可见性裁剪的集合）──
	// SearchVector 向量路：pgvector 可用时 ORDER BY embedding <=> $vec（余弦近邻）；
	// float8[] 降级轨由实现取回候选后内存余弦。仅参与 status=ready 的文档
	SearchVector(ctx context.Context, tenantID int64, spaceIDs []int64, vec []float32, topK int) ([]ChunkHit, error)
	// SearchKeyword 关键词路：ILIKE 兜底（tokens 为空白切分的关键词；
	// 命中任意 token 即候选，得分为出现次数），仅参与 status=ready 的文档
	SearchKeyword(ctx context.Context, tenantID int64, spaceIDs []int64, tokens []string, topK int) ([]ChunkHit, error)

	// ── 浏览量/榜单/我的（D24 §4.2）──
	// RecordView 日去重浏览：INSERT kb_doc_view(doc,user,day) ON CONFLICT DO NOTHING；
	// 新插入才 view_count+1，返回最新计数（作者本人计不计由 service 短路——repo 不管）
	RecordView(ctx context.Context, tenantID, docID, userID int64, day time.Time) (int64, error)
	// ListCompanyDocsLatest 公共维度最新文章（ready，created_at 降序 LIMIT）
	ListCompanyDocsLatest(ctx context.Context, tenantID int64, limit int) ([]RankDoc, error)
	// ListCompanyDocsHot 公共维度最热文章：since 非零=窗口内 kb_doc_view 聚合降序；
	// since 零值=总榜按 view_count（window=all）
	ListCompanyDocsHot(ctx context.Context, tenantID int64, since time.Time, limit int) ([]RankDoc, error)
	// ListAuthorRanks 作者榜（公共维度 ready 文章按作者总浏览降序 LIMIT）
	ListAuthorRanks(ctx context.Context, tenantID int64, limit int) ([]AuthorRank, error)
	// ListDocsByUser 用户全部文章（两维度 ready，created_at 降序；before 非零=翻页锚）
	ListDocsByUser(ctx context.Context, tenantID, userID int64, before time.Time, limit int) ([]Doc, error)
	// UserStats 个人概览聚合（monthStart/weekStart 为统计窗起点，零值=该项 0）
	UserStats(ctx context.Context, tenantID, userID int64, monthStart, weekStart time.Time) (UserKBStats, error)
}

// DocStatsReader 管理端统计可选接口（D10 仪表盘跨域闭包；不进 Repo 主接口）
type DocStatsReader interface {
	// CountDocs KB 文档总数（全部空间，含 failed——治理口径按摄入尝试计数）
	CountDocs(ctx context.Context, tenantID int64) (int64, error)
}
