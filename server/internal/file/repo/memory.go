// 内存仓储（测试与无 DSN 回退；NewMemory() 即可整体替换为 PG 实现）。
package filerepo

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Memory 内存文件仓
type Memory struct {
	mu     sync.RWMutex
	nextID int64
	rows   map[int64]File
}

var _ Repo = (*Memory)(nil)

// NewMemory 构造（ID 从 1 自增，与 PG advisory lock max+1 语义一致）
func NewMemory() *Memory { return &Memory{nextID: 0, rows: map[int64]File{}} }

// Insert 新增；同租户同 sha256 未删行冲突 → ErrDuplicateFileSHA（并发去重兜底）
func (m *Memory) Insert(ctx context.Context, f File) (File, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if hit := scanBySHA(m.rows, f.TenantID, f.SHA256); hit != nil {
		return File{}, ErrDuplicateFileSHA
	}
	m.nextID++
	f.ID = m.nextID
	if f.CreatedAt.IsZero() {
		f.CreatedAt = time.Now()
	}
	m.rows[f.ID] = f
	return f, nil
}

// Get 按 ID 查（含已软删行）
func (m *Memory) Get(ctx context.Context, id int64) (*File, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	f, ok := m.rows[id]
	if !ok {
		return nil, ErrNotFound
	}
	fc := f
	return &fc, nil
}

// GetBySHA 同租户同 sha256 未软删行；无命中 nil,nil
func (m *Memory) GetBySHA(ctx context.Context, tenantID int64, sha256 string) (*File, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if hit := scanBySHA(m.rows, tenantID, sha256); hit != nil {
		fc := *hit
		return &fc, nil
	}
	return nil, nil
}

// SoftDelete 软删
func (m *Memory) SoftDelete(ctx context.Context, id int64, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.rows[id]
	if !ok {
		return ErrNotFound
	}
	f.DeletedAt = at
	m.rows[id] = f
	return nil
}

// MarkSent source→message + conv_id 回填
func (m *Memory) MarkSent(ctx context.Context, id int64, convID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.rows[id]
	if !ok {
		return ErrNotFound
	}
	f.Source = SourceMessage
	f.ConvID = convID
	m.rows[id] = f
	return nil
}

// ListByUser 我的文件（未软删，created_at 倒序）
func (m *Memory) ListByUser(ctx context.Context, tenantID, userID int64) ([]File, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]File, 0, 8)
	for _, f := range m.rows {
		if f.TenantID == tenantID && f.OwnerID == userID && !f.Deleted() {
			out = append(out, f)
		}
	}
	sortByCreatedDesc(out)
	return out, nil
}

// ListByConv 会话文件聚合（未软删，created_at 倒序）
func (m *Memory) ListByConv(ctx context.Context, tenantID, convID int64) ([]File, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]File, 0, 8)
	for _, f := range m.rows {
		if f.TenantID == tenantID && f.ConvID == convID && !f.Deleted() {
			out = append(out, f)
		}
	}
	sortByCreatedDesc(out)
	return out, nil
}

// scanBySHA 全表扫同租户同 sha 未删行（内存规模小，无需索引）
func scanBySHA(rows map[int64]File, tenantID int64, sha string) *File {
	for _, f := range rows {
		if f.TenantID == tenantID && f.SHA256 == sha && !f.Deleted() {
			fc := f
			return &fc
		}
	}
	return nil
}

func sortByCreatedDesc(list []File) {
	sort.SliceStable(list, func(i, j int) bool {
		ai, aj := list[i].CreatedAt, list[j].CreatedAt
		if ai.Equal(aj) {
			return list[i].ID > list[j].ID
		}
		return ai.After(aj)
	})
}

// ── 管理端统计（D10 仪表盘跨域闭包；可选接口见 repo.go FileStatsReader）──

var _ FileStatsReader = (*Memory)(nil)

// SumStorageBytes 文件存储量（未软删行 size 求和；软删回收站占用阶段二清理任务口径）
func (m *Memory) SumStorageBytes(_ context.Context, tenantID int64) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var n int64
	for _, f := range m.rows {
		if (tenantID == 0 || f.TenantID == tenantID) && !f.Deleted() {
			n += f.Size
		}
	}
	return n, nil
}

// ── ShareRepo 内存实现 ──

type shareStore struct {
	mu     sync.RWMutex
	nextID int64
	shares map[int64]Share
	byCode map[string]int64
}

// NewMemoryShares 分享外链内存仓储
func NewMemoryShares() ShareRepo {
	return &shareStore{nextID: 200, shares: map[int64]Share{}, byCode: map[string]int64{}}
}

func (s *shareStore) InsertShare(_ context.Context, sh Share) (Share, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	sh.ID = s.nextID
	if sh.CreatedAt.IsZero() {
		sh.CreatedAt = time.Now()
	}
	s.shares[sh.ID] = sh
	s.byCode[sh.Code] = sh.ID
	return sh, nil
}

func (s *shareStore) GetShareByCode(_ context.Context, tenantID int64, code string) (*Share, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byCode[code]
	if !ok {
		return nil, ErrNotFound
	}
	sh := s.shares[id]
	if sh.TenantID != tenantID {
		return nil, ErrNotFound // 跨租户不暴露存在性
	}
	return &sh, nil
}

func (s *shareStore) IncShareUsed(_ context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh, ok := s.shares[id]
	if !ok {
		return ErrNotFound
	}
	sh.UsedTimes++
	s.shares[id] = sh
	return nil
}

func (s *shareStore) DisableShare(_ context.Context, tenantID, id, creatorID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh, ok := s.shares[id]
	if !ok || sh.TenantID != tenantID || sh.CreatorID != creatorID {
		return ErrNotFound
	}
	sh.Status = ShareDisabled
	s.shares[id] = sh
	return nil
}
