// PG 实现：满足 Repo 接口（表见 migrations/0009_kb.sql）。
// RLS 依赖池会话级 app.tenant=1 兜底（internal/platform/pgxpool 包注释）；
// ID 分配 advisory lock 9110-9113 + max(id)+1（message 域 9102-9108、file 域 9109 已占）。
// embedding 双轨：构造时探测 pg_extension.vector → useVector：
//
//	true  → kb_chunk.embedding 为 vector(1024)，参数按 '[v1,v2,…]' 文本 + ::vector 强转，
//	        向量路 ORDER BY embedding <=> $vec（HNSW 余弦近邻，11 §4.3 A 路真实排序）；
//	false → float8[] 降级轨，向量路取回候选（最近 1000 块）内存余弦（登记于启动日志）。
package kbrepo

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

// advisory lock 键（表级 ID 分配互斥；9101-9109 已被 org/auth/message/file 占用）
const (
	lockKeyKBSpace int64 = 9110
	lockKeyKBNode  int64 = 9111
	lockKeyKBDoc   int64 = 9112
	lockKeyKBChunk int64 = 9113
)

// Postgres 知识库域 PG 仓储
type Postgres struct {
	pool      *pgxpool.Pool
	useVector bool // pgvector 扩展可用（kb_chunk.embedding 为 vector(1024)）
}

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo {
	p := &Postgres{pool: pool}
	var ver string
	if err := pool.QueryRow(context.Background(),
		`SELECT extversion FROM pg_extension WHERE extname='vector'`).Scan(&ver); err == nil {
		p.useVector = true
	}
	return p
}

// VectorMode pgvector 是否可用（main 启动日志登记检轨模式用）
func (p *Postgres) VectorMode() (ok bool, version string) {
	if !p.useVector {
		return false, ""
	}
	var ver string
	_ = p.pool.QueryRow(context.Background(),
		`SELECT extversion FROM pg_extension WHERE extname='vector'`).Scan(&ver)
	return true, ver
}

// ── 空间 ──

// EnsurePersonalSpace 惰性创建（幂等；并发创建由 uq_kb_space_personal 兜底 → 复用既有行）
func (p *Postgres) EnsurePersonalSpace(ctx context.Context, tenantID, userID, quotaBytes int64) (Space, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Space{}, err
	}
	defer tx.Rollback(ctx)
	if hit, err := p.personalIn(ctx, tx, tenantID, userID); err != nil {
		return Space{}, err
	} else if hit != nil {
		return *hit, tx.Commit(ctx)
	}
	id, err := bbwpg.AllocID(ctx, tx, lockKeyKBSpace, "kb_space")
	if err != nil {
		return Space{}, err
	}
	var s Space
	err = tx.QueryRow(ctx, `
		INSERT INTO kb_space (id, tenant_id, space_type, name, owner_id, quota_bytes, used_bytes, settings, status, created_at)
		VALUES ($1,$2,'personal',$3,$4,$5,0,'{}'::jsonb,'active',now())
		ON CONFLICT DO NOTHING
		RETURNING `+spaceCols,
		id, tenantID, "我的知识库", userID, quotaBytes).Scan(
		&s.ID, &s.TenantID, &s.SpaceType, &s.Name, &s.OwnerID, &s.DeptID,
		&s.QuotaBytes, &s.UsedBytes, &s.Status, &s.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) { // 并发命中唯一索引 → 复用
		hit, gerr := p.personalIn(ctx, tx, tenantID, userID)
		if gerr != nil || hit == nil {
			return Space{}, gerr
		}
		return *hit, tx.Commit(ctx)
	}
	if err != nil {
		return Space{}, err
	}
	return s, tx.Commit(ctx)
}

// CreateSpace 显式创建（历史路径：0009 时代 dept/company 手建；D24 后产品面
// CreateSpace API 已下线，company 维度行走 EnsureCompanySpace，本方法留作数据装配）
func (p *Postgres) CreateSpace(ctx context.Context, s Space) (Space, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Space{}, err
	}
	defer tx.Rollback(ctx)
	id, err := bbwpg.AllocID(ctx, tx, lockKeyKBSpace, "kb_space")
	if err != nil {
		return Space{}, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO kb_space (id, tenant_id, space_type, name, owner_id, dept_id, quota_bytes, used_bytes, settings, status, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,0,'{}'::jsonb,'active',now())
		RETURNING `+spaceCols,
		id, s.TenantID, s.SpaceType, s.Name, s.OwnerID, i64OrNull(s.DeptID), s.QuotaBytes).Scan(
		&s.ID, &s.TenantID, &s.SpaceType, &s.Name, &s.OwnerID, &s.DeptID,
		&s.QuotaBytes, &s.UsedBytes, &s.Status, &s.CreatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Space{}, ErrDupPersonal
		}
		return Space{}, err
	}
	return s, tx.Commit(ctx)
}

// EnsureCompanySpace 公司知识库维度行幂等种子（D24 两维度：uq_kb_space_company
// 部分唯一索引并发兜底；owner_id=0 系统行——canWrite 对 company 不看 owner）
func (p *Postgres) EnsureCompanySpace(ctx context.Context, tenantID, quotaBytes int64) (Space, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Space{}, err
	}
	defer tx.Rollback(ctx)
	if hit, err := p.companyIn(ctx, tx, tenantID); err != nil {
		return Space{}, err
	} else if hit != nil {
		return *hit, tx.Commit(ctx)
	}
	id, err := bbwpg.AllocID(ctx, tx, lockKeyKBSpace, "kb_space")
	if err != nil {
		return Space{}, err
	}
	var s Space
	err = tx.QueryRow(ctx, `
		INSERT INTO kb_space (id, tenant_id, space_type, name, owner_id, dept_id, quota_bytes, used_bytes, settings, status, created_at)
		VALUES ($1,$2,'company',$3,0,NULL,$4,0,'{}'::jsonb,'active',now())
		ON CONFLICT DO NOTHING
		RETURNING `+spaceCols,
		id, tenantID, "公司知识库", quotaBytes).Scan(
		&s.ID, &s.TenantID, &s.SpaceType, &s.Name, &s.OwnerID, &s.DeptID,
		&s.QuotaBytes, &s.UsedBytes, &s.Status, &s.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) { // 并发命中唯一索引 → 复用
		hit, gerr := p.companyIn(ctx, tx, tenantID)
		if gerr != nil || hit == nil {
			return Space{}, gerr
		}
		return *hit, tx.Commit(ctx)
	}
	if err != nil {
		return Space{}, err
	}
	return s, tx.Commit(ctx)
}

// companyIn 事务内取租户 company 维度行
func (p *Postgres) companyIn(ctx context.Context, tx pgx.Tx, tenantID int64) (*Space, error) {
	s, err := scanSpace(tx.QueryRow(ctx, `
		SELECT `+spaceCols+` FROM kb_space
		WHERE tenant_id=$1 AND space_type='company' LIMIT 1`, tenantID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return s, nil
}

// GetPersonal 同租户同用户 personal 空间；无命中 nil,nil
func (p *Postgres) GetPersonal(ctx context.Context, tenantID, userID int64) (*Space, error) {
	s, err := scanSpace(p.pool.QueryRow(ctx, `
		SELECT `+spaceCols+` FROM kb_space
		WHERE tenant_id=$1 AND space_type='personal' AND owner_id=$2`, tenantID, userID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return s, nil
}

func (p *Postgres) personalIn(ctx context.Context, tx pgx.Tx, tenantID, userID int64) (*Space, error) {
	s, err := scanSpace(tx.QueryRow(ctx, `
		SELECT `+spaceCols+` FROM kb_space
		WHERE tenant_id=$1 AND space_type='personal' AND owner_id=$2`, tenantID, userID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return s, nil
}

// GetSpace 按 ID 查
func (p *Postgres) GetSpace(ctx context.Context, id int64) (*Space, error) {
	s, err := scanSpace(p.pool.QueryRow(ctx, `SELECT `+spaceCols+` FROM kb_space WHERE id=$1`, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return s, nil
}

// ListSpaces 租户全量（可见性裁剪在 service）
func (p *Postgres) ListSpaces(ctx context.Context, tenantID int64) ([]Space, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+spaceCols+` FROM kb_space WHERE tenant_id=$1 ORDER BY id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Space, 0, 4)
	for rows.Next() {
		s, err := scanSpace(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// ── 目录 ──

// CreateNode 同父同名（uq_kb_node_sibling）→ ErrDupNode
func (p *Postgres) CreateNode(ctx context.Context, n Node) (Node, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Node{}, err
	}
	defer tx.Rollback(ctx)
	id, err := bbwpg.AllocID(ctx, tx, lockKeyKBNode, "kb_node")
	if err != nil {
		return Node{}, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO kb_node (id, tenant_id, space_id, parent_id, node_type, name, path, sort, status, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,'dir',$5,'',0,'active',$6,now(),now())
		RETURNING `+nodeCols,
		id, n.TenantID, n.SpaceID, i64OrNull(n.ParentID), n.Name, n.CreatedBy).Scan(
		&n.ID, &n.TenantID, &n.SpaceID, &n.ParentID, &n.NodeType, &n.Name, &n.Path, &n.Sort,
		&n.Status, &n.CreatedBy, &n.CreatedAt, &n.UpdatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Node{}, ErrDupNode
		}
		return Node{}, err
	}
	return n, tx.Commit(ctx)
}

// GetNode 按 ID 查
func (p *Postgres) GetNode(ctx context.Context, id int64) (*Node, error) {
	n, err := scanNode(p.pool.QueryRow(ctx, `SELECT `+nodeCols+` FROM kb_node WHERE id=$1`, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return n, nil
}

// ListChildNodes 直接子目录（name 升序；parentID=0 → 空间根）
func (p *Postgres) ListChildNodes(ctx context.Context, tenantID, spaceID, parentID int64) ([]Node, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+nodeCols+` FROM kb_node
		WHERE tenant_id=$1 AND space_id=$2 AND COALESCE(parent_id,0)=$3 AND status='active'
		ORDER BY name`, tenantID, spaceID, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Node, 0, 4)
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *n)
	}
	return out, rows.Err()
}

// ── 文档 ──

// CreateDoc 新增（status 由调用方置 processing）
func (p *Postgres) CreateDoc(ctx context.Context, d Doc) (Doc, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Doc{}, err
	}
	defer tx.Rollback(ctx)
	id, err := bbwpg.AllocID(ctx, tx, lockKeyKBDoc, "kb_doc")
	if err != nil {
		return Doc{}, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO kb_doc (id, tenant_id, space_id, node_id, title, source_type, source_ref, ext, size, status, version, content, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())
		RETURNING `+docCols,
		id, d.TenantID, d.SpaceID, i64OrNull(d.NodeID), d.Title, d.SourceType,
		strOrNull(d.SourceRef), d.Ext, d.Size, d.Status, d.Version, strOrNull(d.Content), d.CreatedBy).Scan(
		&d.ID, &d.TenantID, &d.SpaceID, &d.NodeID, &d.Title, &d.SourceType, &d.SourceRef, &d.Ext,
		&d.Size, &d.Status, &d.ErrorMsg, &d.Version, &d.Content, &d.ViewCount, &d.CreatedBy, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return Doc{}, err
	}
	return d, tx.Commit(ctx)
}

// GetDoc 按 ID 查
func (p *Postgres) GetDoc(ctx context.Context, id int64) (*Doc, error) {
	d, err := scanDoc(p.pool.QueryRow(ctx, `SELECT `+docCols+` FROM kb_doc WHERE id=$1`, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return d, nil
}

// FailDoc failed + error_msg
func (p *Postgres) FailDoc(ctx context.Context, docID int64, errMsg string, now time.Time) error {
	ct, err := p.pool.Exec(ctx,
		`UPDATE kb_doc SET status='failed', error_msg=$2, updated_at=$3 WHERE id=$1`, docID, errMsg, now)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// IngestCommit 单事务（检索无中间态，11 §4.2）：
// 删旧 chunk → 批量插新（ID 段一次锁分配）→ doc ready(version+1) → 配额增减
func (p *Postgres) IngestCommit(ctx context.Context, docID int64, chunks []Chunk, usedDelta int64, now time.Time) (Doc, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Doc{}, err
	}
	defer tx.Rollback(ctx)
	d, err := scanDoc(tx.QueryRow(ctx, `SELECT `+docCols+` FROM kb_doc WHERE id=$1 FOR UPDATE`, docID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Doc{}, ErrNotFound
		}
		return Doc{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM kb_chunk WHERE doc_id=$1`, docID); err != nil {
		return Doc{}, err
	}
	if len(chunks) > 0 {
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKeyKBChunk); err != nil {
			return Doc{}, err
		}
		var nextID int64
		if err = tx.QueryRow(ctx, `SELECT COALESCE(max(id),0)+1 FROM kb_chunk`).Scan(&nextID); err != nil {
			return Doc{}, err
		}
		for i := range chunks {
			c := chunks[i]
			c.ID = nextID + int64(i)
			c.TenantID, c.DocID, c.SpaceID = d.TenantID, d.ID, d.SpaceID
			if c.EmbedEpoch <= 0 { // 直写路径兜底（service 正常路径恒显式传当前代）
				c.EmbedEpoch = 1
			}
			var embArg any
			if p.useVector {
				embArg = vecToText(c.Embedding) // '[v1,v2,…]' 文本（vector 列隐式强转）
			} else {
				embArg = f32ToF64(c.Embedding) // float8[] 原生数组
			}
			if _, err = tx.Exec(ctx, `
				INSERT INTO kb_chunk (id, tenant_id, doc_id, space_id, seq, heading_path, text, token_count, embedding, embed_epoch, created_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
				c.ID, c.TenantID, c.DocID, c.SpaceID, c.Seq, strOrNull(c.HeadingPath), c.Text, c.TokenCount, embArg, c.EmbedEpoch, now); err != nil {
				return Doc{}, err
			}
		}
	}
	if err = tx.QueryRow(ctx, `
		UPDATE kb_doc SET status='ready', error_msg=NULL, version=version+1, updated_at=$2
		WHERE id=$1 RETURNING `+docCols, docID, now).Scan(
		&d.ID, &d.TenantID, &d.SpaceID, &d.NodeID, &d.Title, &d.SourceType, &d.SourceRef, &d.Ext,
		&d.Size, &d.Status, &d.ErrorMsg, &d.Version, &d.Content, &d.ViewCount, &d.CreatedBy, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return Doc{}, err
	}
	if usedDelta != 0 {
		if _, err = tx.Exec(ctx,
			`UPDATE kb_space SET used_bytes = GREATEST(0, used_bytes + $2) WHERE id=$1`, d.SpaceID, usedDelta); err != nil {
			return Doc{}, err
		}
	}
	return *d, tx.Commit(ctx)
}

// ListDocsByNode 目录下文档（created_at 倒序；nodeID=0 → 空间根直挂）
func (p *Postgres) ListDocsByNode(ctx context.Context, tenantID, spaceID, nodeID int64) ([]Doc, error) {
	return p.listDocs(ctx, `SELECT `+docCols+` FROM kb_doc
		WHERE tenant_id=$1 AND space_id=$2 AND COALESCE(node_id,0)=$3
		ORDER BY created_at DESC, id DESC LIMIT 500`, tenantID, spaceID, nodeID)
}

// ListDocsBySpace 空间全量文档（updated_at 倒序）
func (p *Postgres) ListDocsBySpace(ctx context.Context, tenantID, spaceID int64) ([]Doc, error) {
	return p.listDocs(ctx, `SELECT `+docCols+` FROM kb_doc
		WHERE tenant_id=$1 AND space_id=$2
		ORDER BY updated_at DESC, id DESC LIMIT 500`, tenantID, spaceID)
}

func (p *Postgres) listDocs(ctx context.Context, sql string, args ...any) ([]Doc, error) {
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Doc, 0, 8)
	for rows.Next() {
		d, err := scanDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// ── 分块 ──

// chunkSelect 分块列（向量列按轨取回：vector→文本 / float8[]→原生数组）
func (p *Postgres) chunkSelect() string {
	if p.useVector {
		return `id, tenant_id, doc_id, space_id, seq, COALESCE(heading_path,''), text, token_count, embedding::text, created_at`
	}
	return `id, tenant_id, doc_id, space_id, seq, COALESCE(heading_path,''), text, token_count, embedding, created_at`
}

// ListChunks seq 升序（v0.1 全量 ≤500 兜底；分页阶段二）
func (p *Postgres) ListChunks(ctx context.Context, tenantID, docID int64) ([]Chunk, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT `+p.chunkSelect()+` FROM kb_chunk WHERE tenant_id=$1 AND doc_id=$2 ORDER BY seq LIMIT 500`,
		tenantID, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Chunk, 0, 8)
	for rows.Next() {
		c, err := p.scanChunk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// ListChunksAround seq 前后各 before/after 块（引用上下文展开，INT-KB-14）
func (p *Postgres) ListChunksAround(ctx context.Context, tenantID, docID int64, seq, before, after int) ([]Chunk, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT `+p.chunkSelect()+` FROM kb_chunk
		WHERE tenant_id=$1 AND doc_id=$2 AND seq BETWEEN $3 AND $4 ORDER BY seq LIMIT 20`,
		tenantID, docID, seq-before, seq+after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Chunk, 0, before+after+1)
	for rows.Next() {
		c, err := p.scanChunk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 { // seq 越界兜底：返回文档首块
		return p.ListChunks(ctx, tenantID, docID)
	}
	return out, nil
}

func (p *Postgres) scanChunk(row pgx.Row) (*Chunk, error) {
	var (
		c   Chunk
		emb any
	)
	if err := row.Scan(&c.ID, &c.TenantID, &c.DocID, &c.SpaceID, &c.Seq, &c.HeadingPath,
		&c.Text, &c.TokenCount, &emb, &c.CreatedAt); err != nil {
		return nil, err
	}
	c.Embedding = embToFloats(emb)
	return &c, nil
}

// ── 检索 ──

// SearchVector 向量路：pgvector → ORDER BY embedding <=> $vec（余弦近邻，A 路）；
// float8[] 降级 → 取最近 1000 块内存余弦（候选规模 v0.1 可接受，登记）
func (p *Postgres) SearchVector(ctx context.Context, tenantID int64, spaceIDs []int64, vec []float32, topK, epoch int) ([]ChunkHit, error) {
	if p.useVector {
		rows, err := p.pool.Query(ctx, `
			SELECT c.id, c.doc_id, c.space_id, c.seq, COALESCE(c.heading_path,''), c.text, d.title,
				1 - (c.embedding <=> $2::vector) AS score
			FROM kb_chunk c JOIN kb_doc d ON d.id = c.doc_id AND d.status='ready'
			WHERE c.tenant_id=$1 AND c.space_id = ANY($3) AND c.embed_epoch = $5
			ORDER BY c.embedding <=> $2::vector
			LIMIT $4`, tenantID, vecToText(vec), spaceIDs, topK, epoch)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		hits, err := scanHits(rows)
		if err != nil {
			return nil, err
		}
		// 正交/负相关（余弦 ≤0.01）不参与召回——<=> 是排序不是过滤，
		// 零相似尾随行会挤占 RRF 融合名额
		return dropNonPositive(hits), nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT c.id, c.doc_id, c.space_id, c.seq, COALESCE(c.heading_path,''), c.text, d.title,
			NULL::float8 AS score, c.embedding
		FROM kb_chunk c JOIN kb_doc d ON d.id = c.doc_id AND d.status='ready'
		WHERE c.tenant_id=$1 AND c.space_id = ANY($2) AND c.embed_epoch = $3
		ORDER BY c.id DESC LIMIT 1000`, tenantID, spaceIDs, epoch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits, err := scanHitsWithEmb(rows)
	if err != nil {
		return nil, err
	}
	for i := range hits {
		hits[i].Score = cosine(vec, hits[i].emb)
	}
	hits = dropNonPositive(hits)
	cutTopK(hits, topK)
	return hits, nil
}

// dropNonPositive 余弦 ≤0.01（正交/负相关）剔除——零向量查询与异主题块的噪声
func dropNonPositive(hits []ChunkHit) []ChunkHit {
	out := hits[:0]
	for _, h := range hits {
		if h.Score > 0.01 {
			out = append(out, h)
		}
	}
	return out
}

// SearchKeyword 关键词路：ILIKE ANY 兜底（zhparser 未部署，11 §7.4 降级口径）；
// SQL 端仅做命中过滤（patterns 预拼 %kw%），精确得分（出现次数）Go 侧重算
func (p *Postgres) SearchKeyword(ctx context.Context, tenantID int64, spaceIDs []int64, tokens []string, topK int) ([]ChunkHit, error) {
	if len(tokens) == 0 {
		return nil, nil
	}
	patterns := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if t != "" {
			patterns = append(patterns, "%"+t+"%")
		}
	}
	if len(patterns) == 0 {
		return nil, nil
	}
	rows, err := p.pool.Query(ctx, `
		SELECT c.id, c.doc_id, c.space_id, c.seq, COALESCE(c.heading_path,''), c.text, d.title, 0::float8 AS score
		FROM kb_chunk c JOIN kb_doc d ON d.id = c.doc_id AND d.status='ready'
		WHERE c.tenant_id=$1 AND c.space_id = ANY($2) AND c.text ILIKE ANY($3)
		LIMIT 200`, tenantID, spaceIDs, patterns)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits, err := scanHits(rows)
	if err != nil {
		return nil, err
	}
	for i := range hits {
		low := strings.ToLower(hits[i].Text)
		score := 0.0
		for _, t := range tokens {
			score += float64(strings.Count(low, strings.ToLower(t)))
		}
		hits[i].Score = score
	}
	cutTopK(hits, topK)
	return hits, nil
}

// scanHits 扫描命中行（8 列，无向量）
func scanHits(rows pgx.Rows) ([]ChunkHit, error) {
	out := make([]ChunkHit, 0, 16)
	for rows.Next() {
		var h ChunkHit
		if err := rows.Scan(&h.ChunkID, &h.DocID, &h.SpaceID, &h.Seq, &h.HeadingPath,
			&h.Text, &h.DocTitle, &h.Score); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// scanHitsWithEmb 扫描命中行（含向量列，降级轨用）
func scanHitsWithEmb(rows pgx.Rows) ([]ChunkHit, error) {
	out := make([]ChunkHit, 0, 16)
	for rows.Next() {
		var (
			h   ChunkHit
			emb any
		)
		if err := rows.Scan(&h.ChunkID, &h.DocID, &h.SpaceID, &h.Seq, &h.HeadingPath,
			&h.Text, &h.DocTitle, &h.Score, &emb); err != nil {
			return nil, err
		}
		h.emb = embToFloats(emb)
		out = append(out, h)
	}
	return out, rows.Err()
}

// ── 列定义与扫描 ──

const spaceCols = `id, tenant_id, space_type, name, owner_id, COALESCE(dept_id,0), quota_bytes, used_bytes, status, created_at`

func scanSpace(row pgx.Row) (*Space, error) {
	var s Space
	if err := row.Scan(&s.ID, &s.TenantID, &s.SpaceType, &s.Name, &s.OwnerID, &s.DeptID,
		&s.QuotaBytes, &s.UsedBytes, &s.Status, &s.CreatedAt); err != nil {
		return nil, err
	}
	return &s, nil
}

const nodeCols = `id, tenant_id, space_id, COALESCE(parent_id,0), node_type, name, path, sort, status, created_by, created_at, updated_at`

func scanNode(row pgx.Row) (*Node, error) {
	var n Node
	if err := row.Scan(&n.ID, &n.TenantID, &n.SpaceID, &n.ParentID, &n.NodeType, &n.Name,
		&n.Path, &n.Sort, &n.Status, &n.CreatedBy, &n.CreatedAt, &n.UpdatedAt); err != nil {
		return nil, err
	}
	return &n, nil
}

const docCols = `id, tenant_id, space_id, COALESCE(node_id,0), title, source_type, COALESCE(source_ref,''), COALESCE(ext,''), size, status, COALESCE(error_msg,''), version, COALESCE(content,''), view_count, created_by, created_at, updated_at`

func scanDoc(row pgx.Row) (*Doc, error) {
	var d Doc
	if err := row.Scan(&d.ID, &d.TenantID, &d.SpaceID, &d.NodeID, &d.Title, &d.SourceType,
		&d.SourceRef, &d.Ext, &d.Size, &d.Status, &d.ErrorMsg, &d.Version, &d.Content,
		&d.ViewCount, &d.CreatedBy, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return nil, err
	}
	return &d, nil
}

// ── 小工具 ──

// vecToText []float32 → '[v1,v2,…]'（pgvector 文本输入形态；%.7g 足够余弦精度）
func vecToText(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%.7g", f)
	}
	b.WriteByte(']')
	return b.String()
}

// embToFloats PG 回读向量归一（vector::text → 解析；float8[] → 直转）
func embToFloats(v any) []float32 {
	switch val := v.(type) {
	case []float64:
		out := make([]float32, len(val))
		for i, f := range val {
			out[i] = float32(f)
		}
		return out
	case []byte:
		return embToFloats(string(val))
	case string: // '[v1,v2,…]'
		s := strings.Trim(val, "[]")
		if s == "" {
			return nil
		}
		parts := strings.Split(s, ",")
		out := make([]float32, 0, len(parts))
		for _, p := range parts {
			if f, err := strconv.ParseFloat(strings.TrimSpace(p), 32); err == nil {
				out = append(out, float32(f))
			}
		}
		return out
	default:
		return nil
	}
}

func f32ToF64(v []float32) []float64 {
	out := make([]float64, len(v))
	for i, f := range v {
		out[i] = float64(f)
	}
	return out
}

func i64OrNull(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func strOrNull(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// ── 管理端统计（D10 仪表盘跨域闭包；可选接口见 repo.go DocStatsReader）──

var _ DocStatsReader = (*Postgres)(nil)

// CountDocs KB 文档总数（全部空间，含 failed——治理口径按摄入尝试计数）
func (p *Postgres) CountDocs(ctx context.Context, tenantID int64) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM kb_doc WHERE tenant_id=$1`, tenantID).Scan(&n)
	return n, err
}

// SetSpaceStatus 治理停用/启用（D8）
func (p *Postgres) SetSpaceStatus(ctx context.Context, tenantID, spaceID int64, status string) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE kb_space SET status=$3 WHERE id=$1 AND tenant_id=$2`, spaceID, tenantID, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSpace 级联删除（D8：无外键则显式四表删——迁移 0009 无 FK 约束，保守显式）
func (p *Postgres) DeleteSpace(ctx context.Context, tenantID, spaceID int64) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, table := range []string{"kb_chunk", "kb_doc", "kb_node"} {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE space_id=$1 AND tenant_id=$2`, spaceID, tenantID); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM kb_space WHERE id=$1 AND tenant_id=$2`, spaceID, tenantID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// SetDocSource 回填来源标记（E6）
func (p *Postgres) SetDocSource(ctx context.Context, tenantID, docID int64, sourceType, sourceRef string) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE kb_doc SET source_type=$3, source_ref=$4 WHERE id=$1 AND tenant_id=$2`,
		docID, tenantID, sourceType, sourceRef)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ── 浏览量/榜单/我的（D24 §4.2）──

// RecordView 日去重浏览：新插入流水行才 +1（CTE 单语句原子；冲突=幂等返回现值）
func (p *Postgres) RecordView(ctx context.Context, tenantID, docID, userID int64, day time.Time) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO kb_doc_view (tenant_id, doc_id, user_id, view_date)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT DO NOTHING
			RETURNING 1
		)
		UPDATE kb_doc d SET view_count = d.view_count + (SELECT count(*) FROM ins)
		WHERE d.tenant_id=$1 AND d.id=$2
		RETURNING d.view_count`, tenantID, docID, userID, day).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return n, nil
}

// rankDocCols 榜单行精简列（content 置空——榜单不拉正文，最重 2MB/行）
const rankDocCols = `d.id, d.tenant_id, d.space_id, COALESCE(d.node_id,0), d.title, d.source_type, COALESCE(d.source_ref,''), COALESCE(d.ext,''), d.size, d.status, COALESCE(d.error_msg,''), d.version, '' AS content, d.view_count, d.created_by, d.created_at, d.updated_at`

func scanRankDoc(row pgx.Row) (RankDoc, error) {
	var r RankDoc
	if err := row.Scan(&r.Doc.ID, &r.Doc.TenantID, &r.Doc.SpaceID, &r.Doc.NodeID, &r.Doc.Title,
		&r.Doc.SourceType, &r.Doc.SourceRef, &r.Doc.Ext, &r.Doc.Size, &r.Doc.Status,
		&r.Doc.ErrorMsg, &r.Doc.Version, &r.Doc.Content, &r.Doc.ViewCount,
		&r.Doc.CreatedBy, &r.Doc.CreatedAt, &r.Doc.UpdatedAt, &r.NodeName); err != nil {
		return RankDoc{}, err
	}
	return r, nil
}

// companyJoin 公共维度行 JOIN 片段（active 才进榜单——治理停用即全员不可见）
const companyJoin = `JOIN kb_space s ON s.id=d.space_id AND s.tenant_id=d.tenant_id AND s.space_type='company' AND s.status='active'`

// ListCompanyDocsLatest 公共维度最新（created_at 降序）
func (p *Postgres) ListCompanyDocsLatest(ctx context.Context, tenantID int64, limit int) ([]RankDoc, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+rankDocCols+`, COALESCE(n.name,'')
		FROM kb_doc d `+companyJoin+`
		LEFT JOIN kb_node n ON n.id = d.node_id
		WHERE d.tenant_id=$1 AND d.status='ready'
		ORDER BY d.created_at DESC LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RankDoc, 0, limit)
	for rows.Next() {
		r, err := scanRankDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListCompanyDocsHot 公共维度最热：since 非零=窗口流水聚合；零值=总榜 view_count
func (p *Postgres) ListCompanyDocsHot(ctx context.Context, tenantID int64, since time.Time, limit int) ([]RankDoc, error) {
	if since.IsZero() {
		rows, err := p.pool.Query(ctx, `
			SELECT `+rankDocCols+`, COALESCE(n.name,''), d.view_count
			FROM kb_doc d `+companyJoin+`
			LEFT JOIN kb_node n ON n.id = d.node_id
			WHERE d.tenant_id=$1 AND d.status='ready'
			ORDER BY d.view_count DESC, d.created_at DESC LIMIT $2`, tenantID, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := make([]RankDoc, 0, limit)
		for rows.Next() {
			r, err := scanRankDocHot(rows)
			if err != nil {
				return nil, err
			}
			r.Hot = r.Doc.ViewCount
			out = append(out, r)
		}
		return out, rows.Err()
	}
	rows, err := p.pool.Query(ctx, `
		WITH hot AS (
			SELECT doc_id, count(*) AS cnt FROM kb_doc_view
			WHERE tenant_id=$1 AND view_date >= $2::date
			GROUP BY doc_id
		)
		SELECT `+rankDocCols+`, COALESCE(n.name,''), COALESCE(hot.cnt,0)
		FROM kb_doc d `+companyJoin+`
		JOIN hot ON hot.doc_id = d.id
		LEFT JOIN kb_node n ON n.id = d.node_id
		WHERE d.tenant_id=$1 AND d.status='ready'
		ORDER BY hot.cnt DESC, d.created_at DESC LIMIT $3`, tenantID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RankDoc, 0, limit)
	for rows.Next() {
		r, err := scanRankDocHot(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// scanRankDocHot 榜单行+窗口热度扫描（rankDocCols + node_name + hot）
func scanRankDocHot(row pgx.Row) (RankDoc, error) {
	var r RankDoc
	if err := row.Scan(&r.Doc.ID, &r.Doc.TenantID, &r.Doc.SpaceID, &r.Doc.NodeID,
		&r.Doc.Title, &r.Doc.SourceType, &r.Doc.SourceRef, &r.Doc.Ext,
		&r.Doc.Size, &r.Doc.Status, &r.Doc.ErrorMsg, &r.Doc.Version,
		&r.Doc.Content, &r.Doc.ViewCount, &r.Doc.CreatedBy, &r.Doc.CreatedAt,
		&r.Doc.UpdatedAt, &r.NodeName, &r.Hot); err != nil {
		return RankDoc{}, err
	}
	return r, nil
}

// ListAuthorRanks 作者榜（公共维度 ready 文章按作者总浏览降序）
func (p *Postgres) ListAuthorRanks(ctx context.Context, tenantID int64, limit int) ([]AuthorRank, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT d.created_by, count(*), COALESCE(SUM(d.view_count),0)
		FROM kb_doc d `+companyJoin+`
		WHERE d.tenant_id=$1 AND d.status='ready'
		GROUP BY d.created_by
		ORDER BY 3 DESC, 2 DESC LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AuthorRank, 0, limit)
	for rows.Next() {
		var a AuthorRank
		if err := rows.Scan(&a.UserID, &a.DocCount, &a.TotalViews); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListDocsByUser 用户全部文章（两维度 ready，created_at 降序；before 翻页锚）
func (p *Postgres) ListDocsByUser(ctx context.Context, tenantID, userID int64, before time.Time, limit int) ([]Doc, error) {
	q := `SELECT ` + docCols + ` FROM kb_doc
		WHERE tenant_id=$1 AND created_by=$2 AND status='ready'`
	args := []any{tenantID, userID}
	if !before.IsZero() {
		args = append(args, before)
		q += ` AND created_at < $3`
	}
	args = append(args, limit)
	q += ` ORDER BY created_at DESC LIMIT ` + strconv.Itoa(len(args))
	return p.listDocs(ctx, q, args...)
}

// UserStats 个人概览聚合（D24 me/summary 四数 + 作者排名）
func (p *Postgres) UserStats(ctx context.Context, tenantID, userID int64, monthStart, weekStart time.Time) (UserKBStats, error) {
	var st UserKBStats
	err := p.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE created_at >= $3),
		       COALESCE(SUM(view_count),0)
		FROM kb_doc
		WHERE tenant_id=$1 AND created_by=$2 AND status='ready'`,
		tenantID, userID, monthStart).Scan(&st.DocCount, &st.MonthNew, &st.TotalViews)
	if err != nil {
		return st, err
	}
	if !weekStart.IsZero() {
		if err := p.pool.QueryRow(ctx, `
			SELECT COALESCE(SUM(1),0)
			FROM kb_doc_view v JOIN kb_doc d ON d.id = v.doc_id
			WHERE v.tenant_id=$1 AND d.created_by=$2 AND v.view_date >= $3::date`,
			tenantID, userID, weekStart).Scan(&st.Views7d); err != nil {
			return st, err
		}
	}
	// 作者排名：公共维度作者总浏览超我者 +1；无公共文章 → 0（未上榜）
	err = p.pool.QueryRow(ctx, `
		WITH at AS (
			SELECT d.created_by, COALESCE(SUM(d.view_count),0) AS v
			FROM kb_doc d `+companyJoin+`
			WHERE d.tenant_id=$1 AND d.status='ready'
			GROUP BY d.created_by
		)
		SELECT CASE WHEN mine.v IS NULL THEN 0
		            ELSE (SELECT count(*)+1 FROM at WHERE at.v > mine.v) END
		FROM (SELECT (SELECT v FROM at WHERE created_by=$2) AS v) AS mine`,
		tenantID, userID).Scan(&st.AuthorRank)
	if err != nil {
		return st, err
	}
	return st, nil
}

// ── epoch 重建（D24 §5.3）──

// GetSettings 单行读取（缺行=默认）
func (p *Postgres) GetSettings(ctx context.Context, tenantID int64) (Settings, error) {
	var st Settings
	err := p.pool.QueryRow(ctx, `
		SELECT embed_epoch, COALESCE(embed_model,''), embed_dims, rebuild_status, rebuild_done, rebuild_total, updated_at
		FROM kb_settings WHERE tenant_id=$1`, tenantID).Scan(
		&st.EmbedEpoch, &st.EmbedModel, &st.EmbedDims, &st.RebuildStatus,
		&st.RebuildDone, &st.RebuildTotal, &st.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultSettings(), nil
	}
	if err != nil {
		return st, err
	}
	return st, nil
}

// SaveSettings 单行 upsert
func (p *Postgres) SaveSettings(ctx context.Context, tenantID int64, st Settings) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO kb_settings (tenant_id, embed_epoch, embed_model, embed_dims, rebuild_status, rebuild_done, rebuild_total, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,now())
		ON CONFLICT (tenant_id) DO UPDATE SET
			embed_epoch=EXCLUDED.embed_epoch, embed_model=EXCLUDED.embed_model,
			embed_dims=EXCLUDED.embed_dims, rebuild_status=EXCLUDED.rebuild_status,
			rebuild_done=EXCLUDED.rebuild_done, rebuild_total=EXCLUDED.rebuild_total,
			updated_at=now()`,
		tenantID, st.EmbedEpoch, st.EmbedModel, st.EmbedDims, st.RebuildStatus, st.RebuildDone, st.RebuildTotal)
	return err
}

// ListReadyDocIDs 全部 ready 文档 ID（重建遍历）
func (p *Postgres) ListReadyDocIDs(ctx context.Context, tenantID int64) ([]int64, error) {
	rows, err := p.pool.Query(ctx, `SELECT id FROM kb_doc WHERE tenant_id=$1 AND status='ready' ORDER BY id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]int64, 0, 64)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// UpdateChunkEmbeddings 按 seq 整批替换向量与代次（幂等）
func (p *Postgres) UpdateChunkEmbeddings(ctx context.Context, tenantID, docID int64, vecsBySeq map[int][]float32, epoch int) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for seq, vec := range vecsBySeq {
		var embArg any
		if p.useVector {
			embArg = vecToText(vec)
		} else {
			embArg = f32ToF64(vec)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE kb_chunk SET embedding=$4, embed_epoch=$5
			WHERE tenant_id=$1 AND doc_id=$2 AND seq=$3`,
			tenantID, docID, seq, embArg, epoch); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// RebuildEmbeddingColumn 跨维度重建 DDL：pgvector 轨改列维度+HNSW 重建；降级轨清空即可
func (p *Postgres) RebuildEmbeddingColumn(ctx context.Context, tenantID int64, dims int) error {
	if !p.useVector {
		_, err := p.pool.Exec(ctx, `UPDATE kb_chunk SET embedding=NULL`)
		return err
	}
	if _, err := p.pool.Exec(ctx, `DROP INDEX IF EXISTS idx_kb_chunk_hnsw`); err != nil {
		return err
	}
	if _, err := p.pool.Exec(ctx,
		`ALTER TABLE kb_chunk ALTER COLUMN embedding TYPE vector($1) USING NULL`, dims); err != nil {
		return err
	}
	_, err := p.pool.Exec(ctx,
		`CREATE INDEX idx_kb_chunk_hnsw ON kb_chunk USING hnsw (embedding vector_cosine_ops)`)
	return err
}
