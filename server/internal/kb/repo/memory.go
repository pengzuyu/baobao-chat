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
	docViews map[docViewKey]bool // 日去重浏览流水（kb_doc_view 内存同构，D24）
	settings map[int64]*Settings // kb_settings 内存同构（D24 epoch）
}

var _ Repo = (*Memory)(nil)

// NewMemory 构造（ID 从 1 自增，与 PG advisory lock max+1 语义一致）
func NewMemory() *Memory {
	return &Memory{
		nextID: 0, spaces: map[int64]Space{}, nodes: map[int64]Node{},
		docs: map[int64]Doc{}, chunks: map[int64]Chunk{}, bySpace: map[int64][]int64{},
		docViews: map[docViewKey]bool{},
		settings: map[int64]*Settings{},
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
		if c.EmbedEpoch <= 0 { // 直写路径兜底
			c.EmbedEpoch = 1
		}
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
func (m *Memory) SearchVector(_ context.Context, tenantID int64, spaceIDs []int64, vec []float32, topK, epoch int) ([]ChunkHit, error) {
	m.mu.RLock()
	hits := m.candidatesLocked(tenantID, spaceIDs)
	if epoch > 0 { // D24：向量路只命中当前代（旧代靠关键词路兜底）
		kept := hits[:0]
		for _, h := range hits {
			if c, ok := m.chunks[h.ChunkID]; ok && c.EmbedEpoch == epoch {
				kept = append(kept, h)
			}
		}
		hits = kept
	}
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

// ── 浏览量/榜单/我的（D24 §4.2；内存轨）──

// docViewKey 日去重浏览键（kb_doc_view 三元组主键同构）
type docViewKey struct {
	docID, userID int64
	day           string // YYYY-MM-DD
}

func (m *Memory) RecordView(_ context.Context, tenantID, docID, userID int64, day time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.docs[docID]
	if !ok || d.TenantID != tenantID {
		return 0, ErrNotFound
	}
	k := docViewKey{docID: docID, userID: userID, day: day.Format("2006-01-02")}
	if !m.docViews[k] {
		m.docViews[k] = true
		d.ViewCount++
		m.docs[docID] = d
	}
	return d.ViewCount, nil
}

func (m *Memory) companyDocsLocked(tenantID int64) []Doc {
	cs := m.companyLocked(tenantID)
	if cs == nil || cs.Status != "active" {
		return nil // 治理停用即全员不可见（PG companyJoin 同口径）
	}
	out := make([]Doc, 0, 8)
	for _, d := range m.docs {
		if d.TenantID == tenantID && d.SpaceID == cs.ID && d.Status == DocReady {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

func (m *Memory) ListCompanyDocsLatest(_ context.Context, tenantID int64, limit int) ([]RankDoc, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	docs := m.companyDocsLocked(tenantID)
	if len(docs) > limit {
		docs = docs[:limit]
	}
	out := make([]RankDoc, 0, len(docs))
	for _, d := range docs {
		r := RankDoc{Doc: m.rankDocNoContent(d), NodeName: m.nodeNameLocked(d.NodeID)}
		out = append(out, r)
	}
	return out, nil
}

func (m *Memory) ListCompanyDocsHot(_ context.Context, tenantID int64, since time.Time, limit int) ([]RankDoc, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	docs := m.companyDocsLocked(tenantID)
	// 窗口热度（内存轨：全量键扫描；测试量级足够）
	hot := map[int64]int64{}
	if !since.IsZero() {
		sd := since.Format("2006-01-02")
		for k := range m.docViews {
			if k.day >= sd {
				if d, ok := m.docs[k.docID]; ok && d.TenantID == tenantID && d.Status == DocReady {
					hot[k.docID]++
				}
			}
		}
	}
	out := make([]RankDoc, 0, len(docs))
	for _, d := range docs {
		h := d.ViewCount
		if !since.IsZero() {
			var ok bool
			if h, ok = hot[d.ID]; !ok {
				continue // 窗口榜只收窗口内有浏览的文章（PG JOIN hot 同口径）
			}
		}
		out = append(out, RankDoc{Doc: m.rankDocNoContent(d), NodeName: m.nodeNameLocked(d.NodeID), Hot: h})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Hot != out[j].Hot {
			return out[i].Hot > out[j].Hot
		}
		return out[i].Doc.CreatedAt.After(out[j].Doc.CreatedAt)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// rankDocNoContent 榜单行不携带正文（PG rankDocCols 同口径）
func (m *Memory) rankDocNoContent(d Doc) Doc {
	d.Content = ""
	return d
}

// nodeNameLocked 专栏名（空间根=""）
func (m *Memory) nodeNameLocked(nodeID int64) string {
	if nodeID == 0 {
		return ""
	}
	return m.nodes[nodeID].Name
}

func (m *Memory) ListAuthorRanks(_ context.Context, tenantID int64, limit int) ([]AuthorRank, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	agg := map[int64]*AuthorRank{}
	for _, d := range m.companyDocsLocked(tenantID) {
		a, ok := agg[d.CreatedBy]
		if !ok {
			a = &AuthorRank{UserID: d.CreatedBy}
			agg[d.CreatedBy] = a
		}
		a.DocCount++
		a.TotalViews += d.ViewCount
	}
	out := make([]AuthorRank, 0, len(agg))
	for _, a := range agg {
		out = append(out, *a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].TotalViews != out[j].TotalViews {
			return out[i].TotalViews > out[j].TotalViews
		}
		return out[i].DocCount > out[j].DocCount
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Memory) ListDocsByUser(_ context.Context, tenantID, userID int64, before time.Time, limit int) ([]Doc, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Doc, 0, 16)
	for _, d := range m.docs {
		if d.TenantID != tenantID || d.CreatedBy != userID || d.Status != DocReady {
			continue
		}
		if !before.IsZero() && !d.CreatedAt.Before(before) {
			continue
		}
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Memory) UserStats(_ context.Context, tenantID, userID int64, monthStart, weekStart time.Time) (UserKBStats, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var st UserKBStats
	for _, d := range m.docs {
		if d.TenantID != tenantID || d.CreatedBy != userID || d.Status != DocReady {
			continue
		}
		st.DocCount++
		if !monthStart.IsZero() && !d.CreatedAt.Before(monthStart) {
			st.MonthNew++
		}
		st.TotalViews += d.ViewCount
	}
	if !weekStart.IsZero() {
		wd := weekStart.Format("2006-01-02")
		for k := range m.docViews {
			if k.userID == userID && k.day >= wd {
				if d, ok := m.docs[k.docID]; ok && d.TenantID == tenantID {
					st.Views7d++
				}
			}
		}
	}
	// 作者排名：公共维度作者总浏览超我者 +1（严格大于=并列同名次，与 PG 口径一致）；
	// 无公共文章 → 0（未上榜）
	var myViews int64
	hasCompany := false
	for _, d := range m.companyDocsLocked(tenantID) {
		if d.CreatedBy == userID {
			myViews += d.ViewCount
			hasCompany = true
		}
	}
	if hasCompany {
		above := 0
		agg := map[int64]int64{}
		for _, d := range m.companyDocsLocked(tenantID) {
			agg[d.CreatedBy] += d.ViewCount
		}
		for _, v := range agg {
			if v > myViews {
				above++
			}
		}
		st.AuthorRank = above + 1
	}
	return st, nil
}

// ── epoch 重建（D24 §5.3；内存轨）──

// GetSettings 单行读取（缺行=默认）
func (m *Memory) GetSettings(_ context.Context, tenantID int64) (Settings, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if st, ok := m.settings[tenantID]; ok {
		return *st, nil
	}
	return DefaultSettings(), nil
}

// SaveSettings 单行 upsert
func (m *Memory) SaveSettings(_ context.Context, tenantID int64, st Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := st
	m.settings[tenantID] = &cp
	return nil
}

// ListReadyDocIDs 全部 ready 文档 ID（id 升序）
func (m *Memory) ListReadyDocIDs(_ context.Context, tenantID int64) ([]int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]int64, 0, len(m.docs))
	for _, d := range m.docs {
		if d.TenantID == tenantID && d.Status == DocReady {
			ids = append(ids, d.ID)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

// UpdateChunkEmbeddings 按 seq 整批替换向量与代次（幂等）
func (m *Memory) UpdateChunkEmbeddings(_ context.Context, tenantID, docID int64, vecsBySeq map[int][]float32, epoch int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, c := range m.chunks {
		if c.TenantID == tenantID && c.DocID == docID {
			if vec, ok := vecsBySeq[c.Seq]; ok {
				c.Embedding = vec
				c.EmbedEpoch = epoch
				m.chunks[id] = c
			}
		}
	}
	return nil
}

// RebuildEmbeddingColumn 内存轨 no-op（无列类型概念）
func (m *Memory) RebuildEmbeddingColumn(_ context.Context, _ int64, _ int) error { return nil }
