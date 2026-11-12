// 内存仓储（测试与无 DSN 回退；检索双路为内存余弦/包含匹配，与 PG 语义一致）。
package kbrepo

import (
	"context"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// Memory 内存知识库仓（spaces/nodes/docs/chunks 四表 + 空内索引）
type Memory struct {
	mu      sync.RWMutex
	nextID  int64
	spaces  map[int64]Space
	nodes   map[int64]Node
	docs    map[int64]Doc
	chunks  map[int64]Chunk
	bySpace map[int64][]int64 // space_id → doc ids（列表序维护省事：遍历时再过滤）
}

var _ Repo = (*Memory)(nil)

// NewMemory 构造（ID 从 1 自增，与 PG advisory lock max+1 语义一致）
func NewMemory() *Memory {
	return &Memory{
		nextID: 0, spaces: map[int64]Space{}, nodes: map[int64]Node{},
		docs: map[int64]Doc{}, chunks: map[int64]Chunk{}, bySpace: map[int64][]int64{},
	}
}

func (m *Memory) alloc() int64 {
	m.nextID++
	return m.nextID
}

// ── 空间 ──

// EnsurePersonalSpace 惰性创建（幂等）
func (m *Memory) EnsurePersonalSpace(_ context.Context, tenantID, userID, quotaBytes int64) (Space, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.personalLocked(tenantID, userID); s != nil {
		return *s, nil
	}
	now := time.Now()
	s := Space{
		ID: m.alloc(), TenantID: tenantID, SpaceType: SpacePersonal,
		Name: "我的知识库", OwnerID: userID,
		QuotaBytes: quotaBytes, UsedBytes: 0, Status: "active", CreatedAt: now,
	}
	m.spaces[s.ID] = s
	return s, nil
}

// CreateSpace 显式创建
func (m *Memory) CreateSpace(_ context.Context, s Space) (Space, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s.SpaceType == SpacePersonal {
		if hit := m.personalLocked(s.TenantID, s.OwnerID); hit != nil {
			return Space{}, ErrDupPersonal
		}
	}
	s.ID = m.alloc()
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	if s.Status == "" {
		s.Status = "active"
	}
	m.spaces[s.ID] = s
	return s, nil
}

// EnsureCompanySpace 公司知识库维度行幂等种子（D24 两维度）
func (m *Memory) EnsureCompanySpace(_ context.Context, tenantID, quotaBytes int64) (Space, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.companyLocked(tenantID); s != nil {
		return *s, nil
	}
	now := time.Now()
	s := Space{
		ID: m.alloc(), TenantID: tenantID, SpaceType: SpaceCompany,
		Name: "公司知识库", OwnerID: 0,
		QuotaBytes: quotaBytes, UsedBytes: 0, Status: "active", CreatedAt: now,
	}
	m.spaces[s.ID] = s
	return s, nil
}

func (m *Memory) companyLocked(tenantID int64) *Space {
	for _, s := range m.spaces {
		if s.TenantID == tenantID && s.SpaceType == SpaceCompany {
			sc := s
			return &sc
		}
	}
	return nil
}

// GetPersonal 同租户同用户 personal 空间
func (m *Memory) GetPersonal(_ context.Context, tenantID, userID int64) (*Space, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s := m.personalLocked(tenantID, userID); s != nil {
		sc := *s
		return &sc, nil
	}
	return nil, nil
}

func (m *Memory) personalLocked(tenantID, userID int64) *Space {
	for _, s := range m.spaces {
		if s.TenantID == tenantID && s.SpaceType == SpacePersonal && s.OwnerID == userID {
			sc := s
			return &sc
		}
	}
	return nil
}

// GetSpace 按 ID 查
func (m *Memory) GetSpace(_ context.Context, id int64) (*Space, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.spaces[id]
	if !ok {
		return nil, ErrNotFound
	}
	sc := s
	return &sc, nil
}

// ListSpaces 租户全量（可见性裁剪在 service）
func (m *Memory) ListSpaces(_ context.Context, tenantID int64) ([]Space, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Space, 0, 4)
	for _, s := range m.spaces {
		if s.TenantID == tenantID {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// ── 目录 ──

// CreateNode 同父同名 → ErrDupNode
func (m *Memory) CreateNode(_ context.Context, n Node) (Node, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.nodes {
		if ex.TenantID == n.TenantID && ex.SpaceID == n.SpaceID && ex.ParentID == n.ParentID &&
			ex.Name == n.Name && ex.Status == "active" {
			return Node{}, ErrDupNode
		}
	}
	n.ID = m.alloc()
	now := time.Now()
	if n.CreatedAt.IsZero() {
		n.CreatedAt = now
	}
	n.UpdatedAt = now
	if n.Status == "" {
		n.Status = "active"
	}
	m.nodes[n.ID] = n
	return n, nil
}

// GetNode 按 ID 查
func (m *Memory) GetNode(_ context.Context, id int64) (*Node, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	n, ok := m.nodes[id]
	if !ok {
		return nil, ErrNotFound
	}
	nc := n
	return &nc, nil
}

// ListChildNodes 直接子目录（name 升序）
func (m *Memory) ListChildNodes(_ context.Context, tenantID, spaceID, parentID int64) ([]Node, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Node, 0, 4)
	for _, n := range m.nodes {
		if n.TenantID == tenantID && n.SpaceID == spaceID && n.ParentID == parentID && n.Status == "active" {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// ── 文档 ──

// CreateDoc 新增（status 由调用方置 processing/ready）
func (m *Memory) CreateDoc(_ context.Context, d Doc) (Doc, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d.ID = m.alloc()
	now := time.Now()
	if d.CreatedAt.IsZero() {
		d.CreatedAt = now
	}
	d.UpdatedAt = now
	m.docs[d.ID] = d
	m.bySpace[d.SpaceID] = append(m.bySpace[d.SpaceID], d.ID)
	return d, nil
}

// GetDoc 按 ID 查
func (m *Memory) GetDoc(_ context.Context, id int64) (*Doc, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	d, ok := m.docs[id]
	if !ok {
		return nil, ErrNotFound
	}
	dc := d
	return &dc, nil
}

// FailDoc failed + error_msg
func (m *Memory) FailDoc(_ context.Context, docID int64, errMsg string, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.docs[docID]
	if !ok {
		return ErrNotFound
	}
	d.Status = DocFailed
	d.ErrorMsg = errMsg
	d.UpdatedAt = now
	m.docs[docID] = d
	return nil
}

// IngestCommit 删旧插新 + doc ready + 配额增减（单锁内原子）
func (m *Memory) IngestCommit(_ context.Context, docID int64, chunks []Chunk, usedDelta int64, now time.Time) (Doc, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.docs[docID]
	if !ok {
		return Doc{}, ErrNotFound
	}
	// 删旧 chunk（重摄入替换，检索无中间态）
	for id, c := range m.chunks {
		if c.DocID == docID {
			delete(m.chunks, id)
		}
	}
	for i := range chunks {
		c := chunks[i]
		c.ID = m.alloc()
		c.TenantID = d.TenantID
		c.DocID = d.ID
		c.SpaceID = d.SpaceID
		c.CreatedAt = now
		m.chunks[c.ID] = c
	}
	d.Status = DocReady
	d.Version++
	d.ErrorMsg = ""
	d.UpdatedAt = now
	m.docs[docID] = d
	if usedDelta != 0 {
		if s, ok := m.spaces[d.SpaceID]; ok {
			s.UsedBytes += usedDelta
			if s.UsedBytes < 0 {
				s.UsedBytes = 0
			}
			m.spaces[d.SpaceID] = s
		}
	}
	return d, nil
}

// ListDocsByNode 目录下文档（created_at 倒序）
func (m *Memory) ListDocsByNode(_ context.Context, tenantID, spaceID, nodeID int64) ([]Doc, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Doc, 0, 4)
	for _, id := range m.bySpace[spaceID] {
		d := m.docs[id]
		if d.TenantID == tenantID && d.SpaceID == spaceID && d.NodeID == nodeID {
			out = append(out, d)
		}
	}
	sortDocs(out)
	return out, nil
}

// ListDocsBySpace 空间全量文档（updated_at 倒序）
func (m *Memory) ListDocsBySpace(_ context.Context, tenantID, spaceID int64) ([]Doc, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Doc, 0, 4)
	for _, id := range m.bySpace[spaceID] {
		d := m.docs[id]
		if d.TenantID == tenantID && d.SpaceID == spaceID {
			out = append(out, d)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		ai, aj := out[i].UpdatedAt, out[j].UpdatedAt
		if ai.Equal(aj) {
			return out[i].ID > out[j].ID
		}
		return ai.After(aj)
	})
	return out, nil
}

func sortDocs(list []Doc) {
	sort.SliceStable(list, func(i, j int) bool {
		ai, aj := list[i].CreatedAt, list[j].CreatedAt
		if ai.Equal(aj) {
			return list[i].ID > list[j].ID
		}
		return ai.After(aj)
	})
}

// ── 分块 ──

// ListChunks seq 升序
func (m *Memory) ListChunks(_ context.Context, tenantID, docID int64) ([]Chunk, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Chunk, 0, 8)
	for _, c := range m.chunks {
		if c.TenantID == tenantID && c.DocID == docID {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out, nil
}

// ListChunksAround seq 前后各 before/after 块
func (m *Memory) ListChunksAround(ctx context.Context, tenantID, docID int64, seq, before, after int) ([]Chunk, error) {
	all, err := m.ListChunks(ctx, tenantID, docID)
	if err != nil {
		return nil, err
	}
	// seq 不存在时取最近的后续块（客户端展开上下文的宽容语义）
	lo, hi := seq-before, seq+after
	out := make([]Chunk, 0, before+after+1)
	for _, c := range all {
		if c.Seq >= lo && c.Seq <= hi {
			out = append(out, c)
		}
	}
	if len(out) == 0 && len(all) > 0 { // 兜底：返回首个块（文档至少一块）
		out = append(out, all[0])
	}
	return out, nil
}

// ── 检索 ──

// candidatesLocked 可见空间内 ready 文档的分块（join doc 标题 + 原始向量）
func (m *Memory) candidatesLocked(tenantID int64, spaceIDs []int64) []ChunkHit {
	set := map[int64]bool{}
	for _, id := range spaceIDs {
		set[id] = true
	}
	out := make([]ChunkHit, 0, 16)
	for _, c := range m.chunks {
		if c.TenantID != tenantID || !set[c.SpaceID] {
			continue
		}
		d, ok := m.docs[c.DocID]
		if !ok || d.Status != DocReady {
			continue
		}
		out = append(out, ChunkHit{
			ChunkID: c.ID, DocID: c.DocID, SpaceID: c.SpaceID, Seq: c.Seq,
			HeadingPath: c.HeadingPath, Text: c.Text, DocTitle: d.Title,
			emb: c.Embedding,
		})
	}
	return out
}

// SearchVector 内存余弦（与 pgvector <=> 同语义；正交/负相关剔除同 PG 轨）
func (m *Memory) SearchVector(_ context.Context, tenantID int64, spaceIDs []int64, vec []float32, topK int) ([]ChunkHit, error) {
	m.mu.RLock()
	hits := m.candidatesLocked(tenantID, spaceIDs)
	m.mu.RUnlock()
	for i := range hits {
		hits[i].Score = cosine(vec, hits[i].emb)
	}
	hits = dropNonPositive(hits)
	cutTopK(hits, topK)
	return hits, nil
}

// SearchKeyword ILIKE 语义（大小写不敏感包含）+ 出现次数得分
func (m *Memory) SearchKeyword(_ context.Context, tenantID int64, spaceIDs []int64, tokens []string, topK int) ([]ChunkHit, error) {
	m.mu.RLock()
	hits := m.candidatesLocked(tenantID, spaceIDs)
	m.mu.RUnlock()
	out := make([]ChunkHit, 0, len(hits))
	for _, h := range hits {
		score := 0.0
		low := strings.ToLower(h.Text)
		for _, t := range tokens {
			if t == "" {
				continue
			}
			score += float64(strings.Count(low, strings.ToLower(t)))
		}
		if score > 0 {
			h.Score = score
			out = append(out, h)
		}
	}
	cutTopK(out, topK)
	return out, nil
}

// cosine 余弦相似度（零向量安全：返回 0）
func cosine(a, b []float32) float64 {
	if len(a) == 0 || len(b) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

func cutTopK(hits []ChunkHit, topK int) {
	if topK <= 0 {
		topK = 10
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > topK {
		hits = hits[:topK]
	}
}

// ── 管理端统计（D10 仪表盘跨域闭包；可选接口见 repo.go DocStatsReader）──

var _ DocStatsReader = (*Memory)(nil)

// CountDocs KB 文档总数（全部空间，含 failed——治理口径按摄入尝试计数）
func (m *Memory) CountDocs(_ context.Context, tenantID int64) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var n int64
	for _, d := range m.docs {
		if tenantID == 0 || d.TenantID == tenantID {
			n++
		}
	}
	return n, nil
}

// SetSpaceStatus 治理停用/启用（内存版）
func (m *Memory) SetSpaceStatus(_ context.Context, tenantID, spaceID int64, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sp, ok := m.spaces[spaceID]
	if !ok || sp.TenantID != tenantID {
		return ErrNotFound
	}
	sp.Status = status
	m.spaces[spaceID] = sp
	return nil
}

// DeleteSpace 级联删除（内存版：chunk/doc/node/space + bySpace 索引）
func (m *Memory) DeleteSpace(_ context.Context, tenantID, spaceID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sp, ok := m.spaces[spaceID]
	if !ok || sp.TenantID != tenantID {
		return ErrNotFound
	}
	delete(m.spaces, spaceID)
	delete(m.bySpace, spaceID)
	for id, n := range m.nodes {
		if n.SpaceID == spaceID {
			delete(m.nodes, id)
		}
	}
	for id, d := range m.docs {
		if d.SpaceID == spaceID {
			delete(m.docs, id)
		}
	}
	for id, c := range m.chunks {
		if c.SpaceID == spaceID {
			delete(m.chunks, id)
		}
	}
	return nil
}

// SetDocSource 回填来源标记（E6）
func (m *Memory) SetDocSource(_ context.Context, _, docID int64, sourceType, sourceRef string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.docs[docID]
	if !ok {
		return ErrNotFound
	}
	d.SourceType = sourceType
	d.SourceRef = sourceRef
	m.docs[docID] = d
	return nil
}
