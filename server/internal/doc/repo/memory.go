// 内存仓储（测试与无 DSN 回退；语义与 PG 实现一致——乐观锁/同名冲突/版本不可变）。
package docrepo

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// Memory 内存文档仓（files/versions 两表；行级一致性由单锁保证）
type Memory struct {
	mu        sync.Mutex
	nextID    int64
	files     map[int64]DocFile
	versions  map[int64]DocVersion
	nextVerID int64
}

var _ Repo = (*Memory)(nil)

// NewMemory 构造（ID 从 1 自增，与 PG advisory lock max+1 语义一致）
func NewMemory() *Memory {
	return &Memory{nextID: 0, files: map[int64]DocFile{}, versions: map[int64]DocVersion{}, nextVerID: 0}
}

func (m *Memory) alloc() int64 {
	m.nextID++
	return m.nextID
}

func (m *Memory) allocVerID() int64 {
	m.nextVerID++
	return m.nextVerID
}

// titleActiveLocked 同 owner 活跃同名判定（调用方持锁）
func (m *Memory) titleActiveLocked(tenantID, ownerID int64, title string, excludeID int64) bool {
	for _, f := range m.files {
		if f.TenantID == tenantID && f.OwnerID == ownerID && f.ID != excludeID &&
			f.Status == StatusActive && f.Title == title {
			return true
		}
	}
	return false
}

// CreateFile 新建 + v1 create 快照
func (m *Memory) CreateFile(_ context.Context, f DocFile) (DocFile, DocVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.titleActiveLocked(f.TenantID, f.OwnerID, f.Title, 0) {
		return DocFile{}, DocVersion{}, ErrDupTitle
	}
	now := time.Now()
	f.ID = m.alloc()
	f.Status = StatusActive
	f.CurrentVersion = 1
	if f.CreatedAt.IsZero() {
		f.CreatedAt = now
	}
	f.UpdatedAt = f.CreatedAt
	m.files[f.ID] = f
	v := DocVersion{
		ID: m.allocVerID(), TenantID: f.TenantID, DocID: f.ID, Version: 1,
		EditorID: f.OwnerID, SnapshotType: SnapCreate, ContentMD: f.ContentMD, CreatedAt: f.CreatedAt,
	}
	m.versions[v.ID] = v
	return f, v, nil
}

// GetFile 按 ID 查
func (m *Memory) GetFile(_ context.Context, id int64) (*DocFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[id]
	if !ok {
		return nil, ErrNotFound
	}
	sc := f
	return &sc, nil
}

// ListFiles owner 活跃列表（title 模糊 + updated_at 倒序键集翻页）
func (m *Memory) ListFiles(_ context.Context, tenantID, ownerID int64, q string, cursor PageCursor, limit int) ([]DocFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	kw := strings.ToLower(q)
	out := make([]DocFile, 0, 8)
	for _, f := range m.files {
		if f.TenantID != tenantID || f.OwnerID != ownerID || f.Status != StatusActive {
			continue
		}
		if kw != "" && !strings.Contains(strings.ToLower(f.Title), kw) {
			continue
		}
		// 键集条件：(updated_at, id) 字典序严格小于游标（倒序翻页；= 游标本行的并列行也要跳过）
		if cursor.Ms > 0 || cursor.ID > 0 {
			ms := f.UpdatedAt.UnixMilli()
			if ms > cursor.Ms || (ms == cursor.Ms && f.ID >= cursor.ID) {
				continue
			}
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i].UpdatedAt.UnixMilli(), out[j].UpdatedAt.UnixMilli()
		if a == b {
			return out[i].ID > out[j].ID
		}
		return a > b
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// RenameFile 改标题
func (m *Memory) RenameFile(_ context.Context, id int64, title string, now time.Time) (*DocFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[id]
	if !ok {
		return nil, ErrNotFound
	}
	if m.titleActiveLocked(f.TenantID, f.OwnerID, title, id) {
		return nil, ErrDupTitle
	}
	f.Title = title
	f.UpdatedAt = now
	m.files[id] = f
	sc := f
	return &sc, nil
}

// TrashFile 移入回收站
func (m *Memory) TrashFile(_ context.Context, id int64, purgeAt, now time.Time) (*DocFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[id]
	if !ok || f.Status != StatusActive {
		return nil, ErrNotFound
	}
	f.Status = StatusTrashed
	p := purgeAt
	f.PurgeAt = &p
	f.UpdatedAt = now
	m.files[id] = f
	sc := f
	return &sc, nil
}

// RestoreFile 恢复（newTitle 非空时改名——同名冲突由 service 预判加后缀）
func (m *Memory) RestoreFile(_ context.Context, id int64, newTitle string, now time.Time) (*DocFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[id]
	if !ok || f.Status != StatusTrashed {
		return nil, ErrNotFound
	}
	f.Status = StatusActive
	f.PurgeAt = nil
	if newTitle != "" {
		f.Title = newTitle
	}
	f.UpdatedAt = now
	m.files[id] = f
	sc := f
	return &sc, nil
}

// ListTrash owner 回收站列表（purge_at 升序键集翻页）
func (m *Memory) ListTrash(_ context.Context, tenantID, ownerID int64, cursor PageCursor, limit int) ([]DocFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]DocFile, 0, 4)
	for _, f := range m.files {
		if f.TenantID != tenantID || f.OwnerID != ownerID || f.Status != StatusTrashed {
			continue
		}
		if cursor.Ms > 0 || cursor.ID > 0 {
			ms := int64(1 << 62)
			if f.PurgeAt != nil {
				ms = f.PurgeAt.UnixMilli()
			}
			// 键集条件：(purge_at, id) 字典序严格大于游标（升序翻页）
			if ms < cursor.Ms || (ms == cursor.Ms && f.ID <= cursor.ID) {
				continue
			}
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		at, bt := int64(1<<62), int64(1<<62)
		if out[i].PurgeAt != nil {
			at = out[i].PurgeAt.UnixMilli()
		}
		if out[j].PurgeAt != nil {
			bt = out[j].PurgeAt.UnixMilli()
		}
		if at == bt {
			return out[i].ID < out[j].ID
		}
		return at < bt
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// TitleActive 活跃同名判定
func (m *Memory) TitleActive(_ context.Context, tenantID, ownerID int64, title string, excludeID int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.titleActiveLocked(tenantID, ownerID, title, excludeID), nil
}

// SaveContent 乐观锁保存（manual 快照）
func (m *Memory) SaveContent(_ context.Context, docID, editorID, baseVersion int64, contentMD string, now time.Time) (DocFile, DocVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[docID]
	if !ok {
		return DocFile{}, DocVersion{}, ErrNotFound
	}
	if int64(f.CurrentVersion) != baseVersion {
		return DocFile{}, DocVersion{}, ErrVersionConflict
	}
	newVer := f.CurrentVersion + 1
	v := DocVersion{
		ID: m.allocVerID(), TenantID: f.TenantID, DocID: f.ID, Version: newVer,
		EditorID: editorID, SnapshotType: SnapManual, ContentMD: contentMD, CreatedAt: now,
	}
	m.versions[v.ID] = v
	f.CurrentVersion = newVer
	f.ContentMD = contentMD
	f.UpdatedAt = now
	m.files[docID] = f
	return f, v, nil
}

// ListVersions 版本时间线（version 倒序 + cursor 翻页）
func (m *Memory) ListVersions(_ context.Context, tenantID, docID int64, cursor int64, limit int) ([]DocVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]DocVersion, 0, 8)
	for _, v := range m.versions {
		if v.TenantID != tenantID || v.DocID != docID {
			continue
		}
		if cursor > 0 && v.Version >= int(cursor) {
			continue
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version > out[j].Version })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// GetVersion 取单版本
func (m *Memory) GetVersion(_ context.Context, tenantID, docID int64, version int) (*DocVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, v := range m.versions {
		if v.TenantID == tenantID && v.DocID == docID && v.Version == version {
			sc := v
			return &sc, nil
		}
	}
	return nil, ErrNotFound
}

// RestoreVersion 恢复目标版本（restore 快照新版本）
func (m *Memory) RestoreVersion(_ context.Context, docID, editorID int64, targetVersion int, now time.Time) (DocFile, DocVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[docID]
	if !ok {
		return DocFile{}, DocVersion{}, ErrNotFound
	}
	var target *DocVersion
	for _, v := range m.versions {
		if v.DocID == docID && v.Version == targetVersion {
			sc := v
			target = &sc
			break
		}
	}
	if target == nil {
		return DocFile{}, DocVersion{}, ErrNotFound
	}
	newVer := f.CurrentVersion + 1
	v := DocVersion{
		ID: m.allocVerID(), TenantID: f.TenantID, DocID: f.ID, Version: newVer,
		EditorID: editorID, SnapshotType: SnapRestore, ContentMD: target.ContentMD, CreatedAt: now,
	}
	m.versions[v.ID] = v
	f.CurrentVersion = newVer
	f.ContentMD = target.ContentMD
	f.UpdatedAt = now
	m.files[docID] = f
	return f, v, nil
}
