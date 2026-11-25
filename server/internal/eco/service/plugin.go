// 插件市场服务（0036 / D22 §3 / L1：发布→版本线→catalog 检索→安装/下载/卸载）。
package ecoservice

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	ecorepo "github.com/baobaochat/server/internal/eco/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// PluginPolicy 三档（同 skill；10 篇 §4.5）
const (
	PluginPolicyForce     = 1
	PluginPolicyRecommend = 2
	PluginPolicyOptional  = 3
)

// PluginDTO 插件行（manifest 快照展开）
type PluginDTO struct {
	ID             string          `json:"id"`
	PluginID       string          `json:"plugin_id"`
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Category       string          `json:"category"`
	Policy         int             `json:"policy"`
	Status         string          `json:"status"`
	CurrentVersion string          `json:"current_version"`
	Manifest       *PluginManifest `json:"manifest,omitempty"`
	// Readme 说明全文（D39：仅 detail 口填充——列表不背长文，repo 单查）
	Readme string `json:"readme,omitempty"`
	// Installs 当前装机人数（D39：每用户一行天然去重、卸载即减；个人插件照填，
	// 前端按 owner 隐藏）
	Installs int `json:"installs"`
	// UpdatedAt 最近更新（列已有纯透出，市场「最近更新」）
	UpdatedAt int64 `json:"updated_at"`
	// >0=个人插件归属（方案 A：仅 owner 与管理员可见；0=公共）
	OwnerUserID int64 `json:"owner_user_id,omitempty"`
	CreatedAt   int64 `json:"created_at"`
}

// PluginCatalogEntry 用户 catalog 条目（含安装态）
type PluginCatalogEntry struct {
	PluginDTO
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"` // 已装版本
	HasUpdate bool   `json:"has_update"`
}

// PluginVersionDTO 版本行（不含包体）
type PluginVersionDTO struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	Notes     string `json:"notes,omitempty"`
	Manifest  string `json:"manifest,omitempty"`
	CreatedAt int64  `json:"created_at"`
}

// PluginInstallResp 安装响应（download_url 供客户端直接拉包）
type PluginInstallResp struct {
	PluginID    string `json:"plugin_id"`
	Version     string `json:"version"`
	DownloadURL string `json:"download_url"`
}

// pluginSvcOK 服务装配守卫（nil=插件面 9004，同 apps/skills 口径）
func (s *Service) plugins() (ecorepo.PluginRepo, error) {
	if s.pluginsRepo == nil {
		return nil, errx.New(errx.CodeNotFound, "插件市场未启用（9004）")
	}
	return s.pluginsRepo, nil
}

// UploadPlugin 管理面：上传 zip → 校验 → 公共插件入库（owner=0）+ 版本行
// （已存在则追加版本；name/description/category 以清单快照为准覆盖元数据）
func (s *Service) UploadPlugin(ctx context.Context, tenantID, userID int64, pkg []byte, notes string, policy int) (*PluginDTO, error) {
	return s.uploadPluginAs(ctx, tenantID, userID, pkg, notes, policy, 0)
}

// UploadPluginPrivate 个人上传（方案 A，2026-11-13 拍板）：zip → 校验 →
// 个人插件入库（owner=userID，policy 恒 optional）——**draft 即仅本人可见可装**
// （自用沙盒）；管理员 publish 审核后进公共市场。归属校验：
// 同名插件已存在时仅 owner 本人可追加版本（他人插件不可覆盖）
func (s *Service) UploadPluginPrivate(ctx context.Context, tenantID, userID int64, pkg []byte, notes string) (*PluginDTO, error) {
	return s.uploadPluginAs(ctx, tenantID, userID, pkg, notes, PluginPolicyOptional, userID)
}

func (s *Service) uploadPluginAs(ctx context.Context, tenantID, userID int64, pkg []byte, notes string, policy int, owner int64) (*PluginDTO, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, err
	}
	vr, err := validatePluginPackage(pkg)
	if err != nil {
		return nil, err
	}
	m := vr.Manifest
	if policy < PluginPolicyForce || policy > PluginPolicyOptional {
		policy = PluginPolicyOptional
	}
	manifestJSON, err := json.Marshal(m)
	if err != nil {
		return nil, errx.From(err)
	}

	existing, gerr := repo.GetPluginByPluginID(ctx, tenantID, m.Name)
	if gerr != nil {
		if !isRepoNotFound(gerr) {
			return nil, errx.From(gerr)
		}
		created, cerr := repo.InsertPlugin(ctx, ecorepo.Plugin{
			TenantID: tenantID, PluginID: m.Name, Name: m.Name,
			Description: m.Description, Category: m.Category, Policy: policy,
			Readme: vr.Readme, OwnerUserID: owner, CreatedBy: userID,
		})
		if cerr != nil {
			return nil, errx.From(cerr)
		}
		existing = &created
	} else if existing.Status == "delisted" {
		return nil, errx.New(errx.CodeBadRequest, "插件已下架，不可追加版本（重新发布请新 plugin_id）")
	} else if owner != 0 && existing.OwnerUserID != owner {
		return nil, errx.New(errx.CodePermACLDenied, "plugin_id 已被占用（个人插件不可覆盖他人）")
	} else {
		// 元数据随最新上传对齐（清单+README 为准）
		if uerr := repo.UpdatePluginMeta(ctx, tenantID, existing.ID, m.Name, m.Description, m.Category, 0, vr.Readme); uerr != nil {
			return nil, errx.From(uerr)
		}
	}

	if _, verr := repo.InsertVersion(ctx, ecorepo.PluginVersion{
		TenantID: tenantID, PkgID: existing.ID, Version: m.Version,
		Notes: notes, Manifest: string(manifestJSON), Package: pkg,
	}); verr != nil {
		if verr == ecorepo.ErrPluginVersionDup {
			return nil, errx.New(errx.CodeBadRequest, "该版本已存在（version 需递增）")
		}
		return nil, wrapErr(verr)
	}
	dto, derr := s.pluginDTOByID(ctx, repo, tenantID, existing.ID)
	if derr != nil {
		return nil, derr
	}
	// draft 态 pkg.manifest 尚未回填（publish 才切），DTO 直接带本版快照
	dto.Manifest = m
	return dto, nil
}

// PublishPluginVersion 管理面：版本发布（draft→published + current 切换）
func (s *Service) PublishPluginVersion(ctx context.Context, tenantID int64, pluginID, version string) error {
	repo, err := s.plugins()
	if err != nil {
		return err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil {
		return errx.New(errx.CodeNotFound, "插件不存在")
	}
	v, err := repo.GetVersion(ctx, tenantID, p.ID, version)
	if err != nil {
		return errx.New(errx.CodeNotFound, "版本不存在: "+version)
	}
	if err := repo.SetPluginCurrent(ctx, tenantID, p.ID, version, v.Manifest); err != nil {
		return wrapErr(err)
	}
	return wrapErr(repo.SetPluginStatus(ctx, tenantID, p.ID, "published"))
}

// PluginMetaReq 管理面元数据更新入参
type PluginMetaReq struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Policy      int    `json:"policy"`
}

// UpdatePluginMeta 管理面：policy/category 等元数据（readme 随包走——传空不动）
func (s *Service) UpdatePluginMeta(ctx context.Context, tenantID int64, pluginID string, req PluginMetaReq) error {
	repo, err := s.plugins()
	if err != nil {
		return err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil {
		return errx.New(errx.CodeNotFound, "插件不存在")
	}
	return wrapErr(repo.UpdatePluginMeta(ctx, tenantID, p.ID, req.Name, req.Description, req.Category, req.Policy, ""))
}

// DelistPlugin 管理面：下架
func (s *Service) DelistPlugin(ctx context.Context, tenantID int64, pluginID string) error {
	repo, err := s.plugins()
	if err != nil {
		return err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil {
		return errx.New(errx.CodeNotFound, "插件不存在")
	}
	return wrapErr(repo.SetPluginStatus(ctx, tenantID, p.ID, "delisted"))
}

// ListPluginsAdmin 管理面全量（D39：含装机数——治理视角哪些插件没人用）
func (s *Service) ListPluginsAdmin(ctx context.Context, tenantID int64) ([]PluginDTO, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, err
	}
	list, err := repo.ListPlugins(ctx, tenantID, "")
	if err != nil {
		return nil, errx.From(err)
	}
	insts, err := repo.CountPluginInstalls(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]PluginDTO, 0, len(list))
	for _, p := range list {
		dto := toPluginDTO(p)
		dto.Installs = int(insts[p.ID])
		out = append(out, dto)
	}
	return out, nil
}

// ListPluginVersionsAdmin 管理面版本线
func (s *Service) ListPluginVersionsAdmin(ctx context.Context, tenantID int64, pluginID string) ([]PluginVersionDTO, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "插件不存在")
	}
	vers, err := repo.ListVersions(ctx, tenantID, p.ID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]PluginVersionDTO, 0, len(vers))
	for _, v := range vers {
		out = append(out, PluginVersionDTO{
			ID: i64s(v.ID), Version: v.Version, Notes: v.Notes, Manifest: v.Manifest, CreatedAt: v.CreatedAt.UnixMilli(),
		})
	}
	return out, nil
}

// PluginCatalog 用户 catalog（published 全集 + 检索/过滤 + 安装态 + force 置顶）
//
//	q：name/description/plugin_id 模糊（不分大小写）；category：精确；
//	component：tool|skill|command|agent（manifest 组件统计 >0 过滤）。
func (s *Service) PluginCatalog(ctx context.Context, tenantID, userID int64, q, category, component string) ([]PluginCatalogEntry, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, err
	}
	switch component {
	case "", "tool", "skill", "command", "agent":
	default:
		return nil, errx.New(errx.CodeBadRequest, "component ∈ tool|skill|command|agent")
	}
	// 方案 A：公共 published ∪ 本人个人插件（draft+published）
	pub, err := repo.ListPlugins(ctx, tenantID, "published")
	if err != nil {
		return nil, errx.From(err)
	}
	mine, merr := repo.ListPluginsByOwner(ctx, tenantID, userID)
	if merr != nil {
		return nil, errx.From(merr)
	}
	insts, err := repo.ListPluginInstallsByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	instOf := map[int64]ecorepo.PluginInstall{}
	for _, i := range insts {
		instOf[i.PkgID] = i
	}
	// D39：装机数聚合（个人插件照填，前端按 owner 隐藏）
	counts, err := repo.CountPluginInstalls(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	q = strings.ToLower(strings.TrimSpace(q))
	seen := map[int64]bool{}
	all := append(pub, mine...)
	out := make([]PluginCatalogEntry, 0, len(all))
	for _, p := range all {
		if seen[p.ID] {
			continue // 个人插件 publish 后两源重叠去重
		}
		seen[p.ID] = true
		dto := toPluginDTO(p)
		dto.Installs = int(counts[p.ID])
		if q != "" && !strings.Contains(strings.ToLower(p.Name+p.Description+p.PluginID), q) {
			continue
		}
		if category != "" && p.Category != category {
			continue
		}
		if !matchComponent(dto.Manifest, component) {
			continue
		}
		e := PluginCatalogEntry{PluginDTO: dto}
		if inst, ok := instOf[p.ID]; ok {
			e.Installed = true
			e.Version = inst.Version
			e.HasUpdate = inst.Version != p.CurrentVersion
		}
		out = append(out, e)
	}
	// force 置顶，其余按名称稳定序
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Policy != out[j].Policy {
			return out[i].Policy < out[j].Policy
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// PluginDetail 用户详情（清单/组件/权限声明/版本线/安装态/readme/装机数）
func (s *Service) PluginDetail(ctx context.Context, tenantID, userID int64, pluginID string) (*PluginCatalogEntry, []PluginVersionDTO, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, nil, err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil || !visibleTo(p, userID) {
		return nil, nil, errx.New(errx.CodeNotFound, "插件不存在或未发布")
	}
	e := PluginCatalogEntry{PluginDTO: toPluginDTO(*p)}
	insts, _ := repo.ListPluginInstallsByUser(ctx, tenantID, userID)
	for _, i := range insts {
		if i.PkgID == p.ID {
			e.Installed, e.Version = true, i.Version
			e.HasUpdate = i.Version != p.CurrentVersion
		}
	}
	// D39：readme 单查（仅 detail 口——列表不背长文）+ 装机数
	if readme, rerr := repo.GetPluginReadme(ctx, tenantID, p.ID); rerr == nil {
		e.Readme = readme
	}
	if counts, cerr := repo.CountPluginInstalls(ctx, tenantID); cerr == nil {
		e.Installs = int(counts[p.ID])
	}
	vers, err := repo.ListVersions(ctx, tenantID, p.ID)
	if err != nil {
		return nil, nil, errx.From(err)
	}
	vd := make([]PluginVersionDTO, 0, len(vers))
	for _, v := range vers {
		vd = append(vd, PluginVersionDTO{
			ID: i64s(v.ID), Version: v.Version, Notes: v.Notes, CreatedAt: v.CreatedAt.UnixMilli(),
		})
	}
	return &e, vd, nil
}

// InstallPlugin 安装/升级（version 缺省=当前发布版；个人插件仅 owner 可装）
func (s *Service) InstallPlugin(ctx context.Context, tenantID, userID int64, pluginID, version string) (*PluginInstallResp, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil || !visibleTo(p, userID) {
		return nil, errx.New(errx.CodeNotFound, "插件不存在或未发布")
	}
	if version == "" {
		version = p.CurrentVersion
	}
	if version == "" {
		// draft（未 publish）无 current：回落最新版本行（方案 A 个人沙盒自装）
		if vers, verr := repo.ListVersions(ctx, tenantID, p.ID); verr == nil && len(vers) > 0 {
			version = vers[0].Version
		}
	}
	if _, verr := repo.GetVersion(ctx, tenantID, p.ID, version); verr != nil {
		return nil, errx.New(errx.CodeNotFound, "版本不存在: "+version)
	}
	if err := repo.UpsertPluginInstall(ctx, ecorepo.PluginInstall{
		TenantID: tenantID, PkgID: p.ID, UserID: userID, Version: version,
	}); err != nil {
		return nil, errx.From(err)
	}
	return &PluginInstallResp{
		PluginID:    p.PluginID,
		Version:     version,
		DownloadURL: "/api/v1/eco/plugins/" + p.PluginID + "/download?version=" + version,
	}, nil
}

// DownloadPlugin 包体（published only；客户端落盘前须复跑校验器——D22 §5.2）
func (s *Service) DownloadPlugin(ctx context.Context, tenantID, userID int64, pluginID, version string) ([]byte, string, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, "", err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil || !visibleTo(p, userID) {
		return nil, "", errx.New(errx.CodeNotFound, "插件不存在或未发布")
	}
	if version == "" {
		version = p.CurrentVersion
	}
	if version == "" {
		// draft 个人沙盒同款回落（方案 A）
		if vers, verr := repo.ListVersions(ctx, tenantID, p.ID); verr == nil && len(vers) > 0 {
			version = vers[0].Version
		}
	}
	pkg, err := repo.GetVersionPackage(ctx, tenantID, p.ID, version)
	if err != nil {
		return nil, "", errx.New(errx.CodeNotFound, "版本不存在: "+version)
	}
	return pkg, version, nil
}

// UninstallPlugin 卸载（force 拒——同 skill 口径）
func (s *Service) UninstallPlugin(ctx context.Context, tenantID, userID int64, pluginID string) error {
	repo, err := s.plugins()
	if err != nil {
		return err
	}
	p, err := repo.GetPluginByPluginID(ctx, tenantID, pluginID)
	if err != nil {
		return errx.New(errx.CodeNotFound, "插件不存在")
	}
	if p.Policy == PluginPolicyForce {
		return errx.New(errx.CodeBadRequest, "强制插件（force）不可卸载——联系管理员调整策略")
	}
	return wrapErr(repo.DeletePluginInstall(ctx, tenantID, p.ID, userID))
}

// MyPlugins 我的安装集
func (s *Service) MyPlugins(ctx context.Context, tenantID, userID int64) ([]PluginCatalogEntry, error) {
	repo, err := s.plugins()
	if err != nil {
		return nil, err
	}
	insts, err := repo.ListPluginInstallsByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	all, err := repo.ListPlugins(ctx, tenantID, "")
	if err != nil {
		return nil, errx.From(err)
	}
	counts, err := repo.CountPluginInstalls(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	pOf := map[int64]ecorepo.Plugin{}
	for _, p := range all {
		pOf[p.ID] = p
	}
	out := make([]PluginCatalogEntry, 0, len(insts))
	for _, i := range insts {
		p, ok := pOf[i.PkgID]
		if !ok {
			continue
		}
		dto := toPluginDTO(p)
		dto.Installs = int(counts[p.ID])
		out = append(out, PluginCatalogEntry{
			PluginDTO: dto, Installed: true, Version: i.Version,
			HasUpdate: p.Status == "published" && i.Version != p.CurrentVersion,
		})
	}
	return out, nil
}

func (s *Service) pluginDTOByID(ctx context.Context, repo ecorepo.PluginRepo, tenantID, id int64) (*PluginDTO, error) {
	p, err := repo.GetPlugin(ctx, tenantID, id)
	if err != nil {
		return nil, errx.From(err)
	}
	dto := toPluginDTO(*p)
	return &dto, nil
}

func toPluginDTO(p ecorepo.Plugin) PluginDTO {
	dto := PluginDTO{
		ID: i64s(p.ID), PluginID: p.PluginID, Name: p.Name, Description: p.Description,
		Category: p.Category, Policy: p.Policy, Status: p.Status,
		CurrentVersion: p.CurrentVersion, OwnerUserID: p.OwnerUserID,
		CreatedAt: p.CreatedAt.UnixMilli(), UpdatedAt: p.UpdatedAt.UnixMilli(),
	}
	if p.Manifest != "" {
		var m PluginManifest
		if json.Unmarshal([]byte(p.Manifest), &m) == nil {
			dto.Manifest = &m
		}
	}
	return dto
}

// visibleTo 方案 A 可见性：公共插件仅 published；个人插件（owner>0）对
// 本人恒可见（draft 自用沙盒 + published 已进公共市场）
func visibleTo(p *ecorepo.Plugin, userID int64) bool {
	if p.OwnerUserID == 0 {
		return p.Status == "published"
	}
	return p.OwnerUserID == userID
}

// matchComponent 组件类型过滤（tool=mcpServers）
func matchComponent(m *PluginManifest, component string) bool {
	if component == "" || m == nil {
		return true
	}
	switch component {
	case "tool":
		return m.Components.McpServers > 0
	case "skill":
		return m.Components.Skills > 0
	case "command":
		return m.Components.Commands > 0
	case "agent":
		return m.Components.Agents > 0
	}
	return true
}

// isRepoNotFound 哨兵归一（memory/PG 同 ErrPluginNotFound）
func isRepoNotFound(err error) bool { return err == ecorepo.ErrPluginNotFound }

// wrapErr nil 安全包装（errx.From(nil) 会产出非 nil 的 CodeOK 哨兵——直传式
// return 的坑，service 层统一走此包装）
func wrapErr(err error) error {
	if err == nil {
		return nil
	}
	return wrapErr(err)
}
