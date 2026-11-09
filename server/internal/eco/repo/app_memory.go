// 应用仓储内存实现（0031 / E1；语义与 PG 一致）。
package ecorepo

import (
	"context"
	"sort"
	"sync"
	"time"
)

// AppMemory 应用内存仓
type AppMemory struct {
	mu        sync.Mutex
	nextID    int64
	apps      map[int64]*App
	versions  map[int64]*AppVersion
	installed map[int64]*AppInstall // install 行 ID → 行
	appSeq    int64
	verSeq    int64
	insSeq    int64
}

var _ AppRepo = (*AppMemory)(nil)

// NewAppMemory 构造
func NewAppMemory() *AppMemory {
	return &AppMemory{apps: map[int64]*App{}, versions: map[int64]*AppVersion{}, installed: map[int64]*AppInstall{}}
}

// InsertApp 登记
func (m *AppMemory) InsertApp(_ context.Context, a App) (App, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.apps {
		if ex.TenantID == a.TenantID && ex.AppID == a.AppID {
			return App{}, ErrAppDup
		}
	}
	m.nextID++
	a.ID = m.nextID
	if a.Status == "" {
		a.Status = "draft" // 对齐 PG 默认值（0031：status DEFAULT 'draft'）
	}
	now := time.Now()
	a.CreatedAt, a.UpdatedAt = now, now
	m.apps[a.ID] = &a
	return a, nil
}

// GetAppByAppID 查
func (m *AppMemory) GetAppByAppID(_ context.Context, tenantID int64, appID string) (*App, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.apps {
		if a.TenantID == tenantID && a.AppID == appID {
			cp := *a
			return &cp, nil
		}
	}
	return nil, ErrAppNotFound
}

// ListApps 全量
func (m *AppMemory) ListApps(_ context.Context, tenantID int64) ([]App, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []App{}
	for _, a := range m.apps {
		if a.TenantID == tenantID {
			out = append(out, *a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// ListPublishedApps published
func (m *AppMemory) ListPublishedApps(_ context.Context, tenantID int64) ([]App, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []App{}
	for _, a := range m.apps {
		if a.TenantID == tenantID && a.Status == "published" {
			out = append(out, *a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// SetAppStatus 状态
func (m *AppMemory) SetAppStatus(_ context.Context, _, id int64, status, currentVersion string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.apps[id]
	if !ok {
		return ErrAppNotFound
	}
	a.Status = status
	if currentVersion != "" {
		a.CurrentVersion = currentVersion
	}
	a.UpdatedAt = time.Now()
	return nil
}

// InsertAppVersion 版本登记
func (m *AppMemory) InsertAppVersion(_ context.Context, v AppVersion) (AppVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.versions {
		if ex.TenantID == v.TenantID && ex.AppRowID == v.AppRowID && ex.Version == v.Version {
			return AppVersion{}, ErrAppDup
		}
	}
	m.verSeq++
	v.ID = m.verSeq
	if v.Status == "" {
		v.Status = "draft" // 对齐 PG 默认值（0031：version status DEFAULT 'draft'）
	}
	v.CreatedAt = time.Now()
	m.versions[v.ID] = &v
	return v, nil
}

// ListAppVersions 版本线
func (m *AppMemory) ListAppVersions(_ context.Context, _, appRowID int64) ([]AppVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []AppVersion{}
	for _, v := range m.versions {
		if v.AppRowID == appRowID {
			out = append(out, *v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// GetPublishedVersion 当前发布版
func (m *AppMemory) GetPublishedVersion(_ context.Context, _, appRowID int64) (*AppVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var hit *AppVersion
	for _, v := range m.versions {
		if v.AppRowID == appRowID && v.Status == "published" {
			if hit == nil || v.PublishedAt.After(hit.PublishedAt) {
				cp := *v
				hit = &cp
			}
		}
	}
	if hit == nil {
		return nil, ErrAppVersionNotFound
	}
	return hit, nil
}

// SetVersionStatus 版本状态
func (m *AppMemory) SetVersionStatus(_ context.Context, _, id int64, status string, by int64, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.versions[id]
	if !ok {
		return ErrAppVersionNotFound
	}
	v.Status = status
	if status == "published" {
		v.PublishedBy, v.PublishedAt = by, now
	}
	return nil
}

// UpsertInstall 安装/升级
func (m *AppMemory) UpsertInstall(_ context.Context, i AppInstall) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, ex := range m.installed {
		if ex.TenantID == i.TenantID && ex.AppRowID == i.AppRowID && ex.UserID == i.UserID {
			ex.Version, ex.InstalledAt = i.Version, time.Now()
			_ = id
			return nil
		}
	}
	m.insSeq++
	i.ID = m.insSeq
	i.InstalledAt = time.Now()
	m.installed[i.ID] = &i
	return nil
}

// ListInstallsByUser 用户安装集
func (m *AppMemory) ListInstallsByUser(_ context.Context, _, userID int64) ([]AppInstall, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []AppInstall{}
	for _, i := range m.installed {
		if i.UserID == userID {
			out = append(out, *i)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].InstalledAt.After(out[j].InstalledAt) })
	return out, nil
}

// DeleteInstall 卸载
func (m *AppMemory) DeleteInstall(_ context.Context, _, appRowID, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, ex := range m.installed {
		if ex.AppRowID == appRowID && ex.UserID == userID {
			delete(m.installed, id)
			return nil
		}
	}
	return nil // 幂等
}
