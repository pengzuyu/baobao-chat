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
	SourceType string // text|file|markdown|doc|im（11 §3.1 五来源；doc=文档中心同步 im=消息转存 E6）
	SourceRef  string // file 来源=file_id
	Ext        string
	Size       int64
	Status     string
	ErrorMsg   string
	Version    int
	Content    string
	CreatedBy  int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
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
}

// DocStatsReader 管理端统计可选接口（D10 仪表盘跨域闭包；不进 Repo 主接口）
type DocStatsReader interface {
	// CountDocs KB 文档总数（全部空间，含 failed——治理口径按摄入尝试计数）
	CountDocs(ctx context.Context, tenantID int64) (int64, error)
}
