// 插件仓储双实现（0036 / D22 / L1）。
package ecorepo

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

// ── memory ──

// PluginMemory 插件内存仓
type PluginMemory struct {
	mu       sync.Mutex
	plugins  map[int64]*Plugin
	versions map[int64]*PluginVersion // 主键
	insts    map[int64]*PluginInstall
	seq      int64
}

var _ PluginRepo = (*PluginMemory)(nil)

// NewPluginMemory 构造
func NewPluginMemory() *PluginMemory {
	return &PluginMemory{
		plugins: map[int64]*Plugin{}, versions: map[int64]*PluginVersion{}, insts: map[int64]*PluginInstall{},
	}
}

// InsertPlugin 建（UK 冲突→ErrPluginDup）
func (m *PluginMemory) InsertPlugin(_ context.Context, p Plugin) (Plugin, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.plugins {
		if ex.TenantID == p.TenantID && ex.PluginID == p.PluginID {
			return Plugin{}, ErrPluginDup
		}
	}
	m.seq++
	p.ID = m.seq
	if p.Status == "" {
		p.Status = "draft" // 对齐 PG 列缺省
	}
	now := time.Now()
	p.CreatedAt, p.UpdatedAt = now, now
	m.plugins[p.ID] = &p
	return p, nil
}

// GetPlugin 查
func (m *PluginMemory) GetPlugin(_ context.Context, tenantID, id int64) (*Plugin, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.plugins[id]; ok && p.TenantID == tenantID {
		cp := *p
		return &cp, nil
	}
	return nil, ErrPluginNotFound
}

// GetPluginByPluginID 按命名空间
func (m *PluginMemory) GetPluginByPluginID(_ context.Context, tenantID int64, pluginID string) (*Plugin, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.plugins {
		if p.TenantID == tenantID && p.PluginID == pluginID {
			cp := *p
			return &cp, nil
		}
	}
	return nil, ErrPluginNotFound
}

// ListPlugins 状态过滤（空=全量）
func (m *PluginMemory) ListPlugins(_ context.Context, tenantID int64, status string) ([]Plugin, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Plugin{}
	for _, p := range m.plugins {
		if p.TenantID == tenantID && (status == "" || p.Status == status) {
			out = append(out, *p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// UpdatePluginMeta 元数据（空串/越界 policy 不覆盖；readme 同语义——管理面不
// 改 readme，service 传空即不动）
func (m *PluginMemory) UpdatePluginMeta(_ context.Context, tenantID, id int64, name, description, category string, policy int, readme string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.plugins[id]
	if !ok || p.TenantID != tenantID {
		return ErrPluginNotFound
	}
	if name != "" {
		p.Name = name
	}
	if description != "" {
		p.Description = description
	}
	if category != "" {
		p.Category = category
	}
	if policy >= 1 && policy <= 3 {
		p.Policy = policy
	}
	if readme != "" {
		p.Readme = readme
	}
	p.UpdatedAt = time.Now()
	return nil
}

// SetPluginStatus 状态
func (m *PluginMemory) SetPluginStatus(_ context.Context, tenantID, id int64, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.plugins[id]
	if !ok || p.TenantID != tenantID {
		return ErrPluginNotFound
	}
	p.Status = status
	p.UpdatedAt = time.Now()
	return nil
}

// SetPluginCurrent 切当前版
func (m *PluginMemory) SetPluginCurrent(_ context.Context, tenantID, id int64, version, manifest string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.plugins[id]
	if !ok || p.TenantID != tenantID {
		return ErrPluginNotFound
	}
	p.CurrentVersion, p.Manifest = version, manifest
	p.UpdatedAt = time.Now()
	return nil
}

// DeletePlugin 彻底删除（版本线+安装记录一并清；不可恢复）
func (m *PluginMemory) DeletePlugin(_ context.Context, tenantID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.plugins[id]
	if !ok || p.TenantID != tenantID {
		return ErrPluginNotFound
	}
	delete(m.plugins, id)
	for vid, v := range m.versions {
		if v.TenantID == tenantID && v.PkgID == id {
			delete(m.versions, vid)
		}
	}
	for iid, i := range m.insts {
		if i.TenantID == tenantID && i.PkgID == id {
			delete(m.insts, iid)
		}
	}
	return nil
}

// InsertVersion 版本行（同版冲突→ErrPluginVersionDup）
func (m *PluginMemory) InsertVersion(_ context.Context, v PluginVersion) (PluginVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.versions {
		if ex.PkgID == v.PkgID && ex.Version == v.Version {
			return PluginVersion{}, ErrPluginVersionDup
		}
	}
	m.seq++
	v.ID = m.seq
	v.CreatedAt = time.Now()
	m.versions[v.ID] = &v
	return v, nil
}

// GetVersion 查版本（含包体——服务层 install 校验用）
func (m *PluginMemory) GetVersion(_ context.Context, tenantID, pkgID int64, version string) (*PluginVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, v := range m.versions {
		if v.TenantID == tenantID && v.PkgID == pkgID && v.Version == version {
			cp := *v
			return &cp, nil
		}
	}
	return nil, ErrPluginVersionMiss
}

// ListVersions 版本线（不含包体）
func (m *PluginMemory) ListVersions(_ context.Context, tenantID, pkgID int64) ([]PluginVersion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []PluginVersion{}
	for _, v := range m.versions {
		if v.TenantID == tenantID && v.PkgID == pkgID {
			cp := *v
			cp.Package = nil
			out = append(out, cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// GetVersionPackage 包体
func (m *PluginMemory) GetVersionPackage(_ context.Context, tenantID, pkgID int64, version string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, v := range m.versions {
		if v.TenantID == tenantID && v.PkgID == pkgID && v.Version == version {
			return append([]byte(nil), v.Package...), nil
		}
	}
	return nil, ErrPluginVersionMiss
}

// UpsertPluginInstall 安装/升级
func (m *PluginMemory) UpsertPluginInstall(_ context.Context, i PluginInstall) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.insts {
		if ex.TenantID == i.TenantID && ex.PkgID == i.PkgID && ex.UserID == i.UserID {
			ex.Version, ex.InstalledAt = i.Version, time.Now()
			return nil
		}
	}
	m.seq++
	i.ID = m.seq
	i.InstalledAt = time.Now()
	m.insts[i.ID] = &i
	return nil
}

// ListPluginsByOwner 个人插件全集
func (m *PluginMemory) ListPluginsByOwner(_ context.Context, tenantID, userID int64) ([]Plugin, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Plugin{}
	for _, p := range m.plugins {
		if p.TenantID == tenantID && p.OwnerUserID == userID {
			out = append(out, *p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// ListPluginInstallsByUser 用户安装集
func (m *PluginMemory) ListPluginInstallsByUser(_ context.Context, tenantID, userID int64) ([]PluginInstall, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []PluginInstall{}
	for _, i := range m.insts {
		if i.TenantID == tenantID && i.UserID == userID {
			out = append(out, *i)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].InstalledAt.After(out[j].InstalledAt) })
	return out, nil
}

// DeletePluginInstall 卸载（幂等）
func (m *PluginMemory) DeletePluginInstall(_ context.Context, tenantID, pkgID, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, ex := range m.insts {
		if ex.TenantID == tenantID && ex.PkgID == pkgID && ex.UserID == userID {
			delete(m.insts, id)
			return nil
		}
	}
	return nil
}

// CountPluginInstalls 装机数聚合（D39）
func (m *PluginMemory) CountPluginInstalls(_ context.Context, tenantID int64) (map[int64]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[int64]int64{}
	for _, i := range m.insts {
		if i.TenantID == tenantID {
			out[i.PkgID]++
		}
	}
	return out, nil
}

// GetPluginReadme 说明单查（D39：读列不含，专路径）
func (m *PluginMemory) GetPluginReadme(_ context.Context, tenantID, id int64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.plugins[id]
	if !ok || p.TenantID != tenantID {
		return "", ErrPluginNotFound
	}
	return p.Readme, nil
}

// ── PG（lock 9138/9139）──

// PluginPostgres 插件 PG 仓储
type PluginPostgres struct{ pool *pgxpool.Pool }

var _ PluginRepo = (*PluginPostgres)(nil)

// NewPostgresPlugins 构造
func NewPostgresPlugins(pool *pgxpool.Pool) PluginRepo { return &PluginPostgres{pool: pool} }

const (
	lockKeyEcoPlugin        int64 = 9138
	lockKeyEcoPluginVersion int64 = 9139
)

const pluginCols = `id, tenant_id, plugin_id, name, COALESCE(description,''), COALESCE(category,''),
	policy, status, COALESCE(current_version,''), COALESCE(manifest,''),
	COALESCE(owner_user_id,0), created_by, created_at, updated_at`

func scanPlugin(row pgx.Row) (*Plugin, error) {
	var p Plugin
	if err := row.Scan(&p.ID, &p.TenantID, &p.PluginID, &p.Name, &p.Description, &p.Category,
		&p.Policy, &p.Status, &p.CurrentVersion, &p.Manifest, &p.OwnerUserID, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrPluginNotFound
		}
		return nil, err
	}
	return &p, nil
}

// InsertPlugin 建
func (p *PluginPostgres) InsertPlugin(ctx context.Context, v Plugin) (Plugin, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Plugin{}, err
	}
	defer tx.Rollback(ctx)
	if v.ID == 0 {
		if v.ID, err = bbcpg.AllocID(ctx, tx, lockKeyEcoPlugin, "eco_plugin"); err != nil {
			return Plugin{}, err
		}
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO eco_plugin (id, tenant_id, plugin_id, name, description, category, policy, status, current_version, manifest, readme, owner_user_id, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'draft','','',$8,$9,$10)
		RETURNING created_at, updated_at`,
		v.ID, v.TenantID, v.PluginID, v.Name, v.Description, v.Category, v.Policy, v.Readme, v.OwnerUserID, v.CreatedBy).
		Scan(&v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		if isAppDup(err) {
			return Plugin{}, ErrPluginDup
		}
		return Plugin{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Plugin{}, err
	}
	return v, nil
}

// GetPlugin 查
func (p *PluginPostgres) GetPlugin(ctx context.Context, tenantID, id int64) (*Plugin, error) {
	return scanPlugin(p.pool.QueryRow(ctx, `SELECT `+pluginCols+` FROM eco_plugin WHERE tenant_id=$1 AND id=$2`, tenantID, id))
}

// GetPluginByPluginID 按命名空间
func (p *PluginPostgres) GetPluginByPluginID(ctx context.Context, tenantID int64, pluginID string) (*Plugin, error) {
	return scanPlugin(p.pool.QueryRow(ctx, `SELECT `+pluginCols+` FROM eco_plugin WHERE tenant_id=$1 AND plugin_id=$2`, tenantID, pluginID))
}

// ListPlugins 状态过滤
func (p *PluginPostgres) ListPlugins(ctx context.Context, tenantID int64, status string) ([]Plugin, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+pluginCols+` FROM eco_plugin
		WHERE tenant_id=$1 AND ($2='' OR status=$2) ORDER BY created_at DESC`, tenantID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plugin{}
	for rows.Next() {
		v, err := scanPlugin(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	return out, rows.Err()
}

// ListPluginsByOwner 个人插件全集（PG）
func (p *PluginPostgres) ListPluginsByOwner(ctx context.Context, tenantID, userID int64) ([]Plugin, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+pluginCols+` FROM eco_plugin
		WHERE tenant_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plugin{}
	for rows.Next() {
		v, serr := scanPlugin(rows)
		if serr != nil {
			return nil, serr
		}
		out = append(out, *v)
	}
	return out, rows.Err()
}

// UpdatePluginMeta 元数据（空串不覆盖；readme 同语义——管理面传空即不动）
func (p *PluginPostgres) UpdatePluginMeta(ctx context.Context, tenantID, id int64, name, description, category string, policy int, readme string) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE eco_plugin SET
			name=COALESCE(NULLIF($3,''), name),
			description=COALESCE(NULLIF($4,''), description),
			category=COALESCE(NULLIF($5,''), category),
			policy=CASE WHEN $6 BETWEEN 1 AND 3 THEN $6 ELSE policy END,
			readme=COALESCE(NULLIF($7,''), readme),
			updated_at=now()
		WHERE tenant_id=$1 AND id=$2`, tenantID, id, name, description, category, policy, readme)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrPluginNotFound
	}
	return nil
}

// GetPluginReadme 说明单查（D39：pluginCols 读列不含，detail 专路径）
func (p *PluginPostgres) GetPluginReadme(ctx context.Context, tenantID, id int64) (string, error) {
	var readme string
	err := p.pool.QueryRow(ctx,
		`SELECT COALESCE(readme,'') FROM eco_plugin WHERE tenant_id=$1 AND id=$2`, tenantID, id).
		Scan(&readme)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", ErrPluginNotFound
		}
		return "", err
	}
	return readme, nil
}

// SetPluginStatus 状态
func (p *PluginPostgres) SetPluginStatus(ctx context.Context, tenantID, id int64, status string) error {
	tag, err := p.pool.Exec(ctx, `UPDATE eco_plugin SET status=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, tenantID, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrPluginNotFound
	}
	return nil
}

// SetPluginCurrent 切当前版
func (p *PluginPostgres) SetPluginCurrent(ctx context.Context, tenantID, id int64, version, manifest string) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE eco_plugin SET current_version=$3, manifest=$4, updated_at=now()
		WHERE tenant_id=$1 AND id=$2`, tenantID, id, version, manifest)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrPluginNotFound
	}
	return nil
}

// DeletePlugin 彻底删除（版本线+安装记录一并清；不可恢复）
func (p *PluginPostgres) DeletePlugin(ctx context.Context, tenantID, id int64) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, tbl := range []string{"eco_plugin_version", "eco_plugin_install"} {
		if _, err := tx.Exec(ctx, `DELETE FROM `+tbl+` WHERE tenant_id=$1 AND pkg_id=$2`, tenantID, id); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM eco_plugin WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrPluginNotFound
	}
	return tx.Commit(ctx)
}

const pluginVersionCols = `id, tenant_id, pkg_id, version, COALESCE(notes,''), COALESCE(manifest,''), created_at`

// InsertVersion 版本行
func (p *PluginPostgres) InsertVersion(ctx context.Context, v PluginVersion) (PluginVersion, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return PluginVersion{}, err
	}
	defer tx.Rollback(ctx)
	if v.ID == 0 {
		if v.ID, err = bbcpg.AllocID(ctx, tx, lockKeyEcoPluginVersion, "eco_plugin_version"); err != nil {
			return PluginVersion{}, err
		}
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO eco_plugin_version (id, tenant_id, pkg_id, version, notes, manifest, package)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING created_at`,
		v.ID, v.TenantID, v.PkgID, v.Version, v.Notes, v.Manifest, v.Package).
		Scan(&v.CreatedAt)
	if err != nil {
		if isAppDup(err) {
			return PluginVersion{}, ErrPluginVersionDup
		}
		return PluginVersion{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PluginVersion{}, err
	}
	return v, nil
}

// GetVersion 查版本（含包体）
func (p *PluginPostgres) GetVersion(ctx context.Context, tenantID, pkgID int64, version string) (*PluginVersion, error) {
	var v PluginVersion
	err := p.pool.QueryRow(ctx, `
		SELECT id, tenant_id, pkg_id, version, COALESCE(notes,''), COALESCE(manifest,''), package, created_at
		FROM eco_plugin_version WHERE tenant_id=$1 AND pkg_id=$2 AND version=$3`,
		tenantID, pkgID, version).
		Scan(&v.ID, &v.TenantID, &v.PkgID, &v.Version, &v.Notes, &v.Manifest, &v.Package, &v.CreatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrPluginVersionMiss
		}
		return nil, err
	}
	return &v, nil
}

// ListVersions 版本线（不含包体）
func (p *PluginPostgres) ListVersions(ctx context.Context, tenantID, pkgID int64) ([]PluginVersion, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+pluginVersionCols+` FROM eco_plugin_version
		WHERE tenant_id=$1 AND pkg_id=$2 ORDER BY created_at DESC`, tenantID, pkgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PluginVersion{}
	for rows.Next() {
		var v PluginVersion
		if err := rows.Scan(&v.ID, &v.TenantID, &v.PkgID, &v.Version, &v.Notes, &v.Manifest, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetVersionPackage 包体
func (p *PluginPostgres) GetVersionPackage(ctx context.Context, tenantID, pkgID int64, version string) ([]byte, error) {
	var pkg []byte
	err := p.pool.QueryRow(ctx, `
		SELECT package FROM eco_plugin_version WHERE tenant_id=$1 AND pkg_id=$2 AND version=$3`,
		tenantID, pkgID, version).Scan(&pkg)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrPluginVersionMiss
		}
		return nil, err
	}
	return pkg, nil
}

// UpsertPluginInstall 安装（max+1 同 skill install 先例；ON CONFLICT 幂等）
func (p *PluginPostgres) UpsertPluginInstall(ctx context.Context, i PluginInstall) error {
	var id int64
	if err := p.pool.QueryRow(ctx, `SELECT COALESCE(max(id),0)+1 FROM eco_plugin_install`).Scan(&id); err != nil {
		return err
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO eco_plugin_install (id, tenant_id, pkg_id, user_id, version)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (tenant_id, pkg_id, user_id) DO UPDATE
			SET version=$5, installed_at=now()`,
		id, i.TenantID, i.PkgID, i.UserID, i.Version)
	return err
}

// ListPluginInstallsByUser 用户安装集
func (p *PluginPostgres) ListPluginInstallsByUser(ctx context.Context, tenantID, userID int64) ([]PluginInstall, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, pkg_id, user_id, version, installed_at
		FROM eco_plugin_install WHERE tenant_id=$1 AND user_id=$2 ORDER BY installed_at DESC`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PluginInstall{}
	for rows.Next() {
		var i PluginInstall
		if err := rows.Scan(&i.ID, &i.TenantID, &i.PkgID, &i.UserID, &i.Version, &i.InstalledAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// DeletePluginInstall 卸载
func (p *PluginPostgres) DeletePluginInstall(ctx context.Context, tenantID, pkgID, userID int64) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM eco_plugin_install WHERE tenant_id=$1 AND pkg_id=$2 AND user_id=$3`,
		tenantID, pkgID, userID)
	return err
}

// CountPluginInstalls 装机数聚合（D39：当前装机口径，GROUP BY 一次拉全量）
func (p *PluginPostgres) CountPluginInstalls(ctx context.Context, tenantID int64) (map[int64]int64, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT pkg_id, COUNT(*) FROM eco_plugin_install
		WHERE tenant_id=$1 GROUP BY pkg_id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var pkgID, n int64
		if err := rows.Scan(&pkgID, &n); err != nil {
			return nil, err
		}
		out[pkgID] = n
	}
	return out, rows.Err()
}
