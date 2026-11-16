// 生态应用服务（0031 / E1：注册/版本/发布/catalog 同步/安装）。
// v0.1 裁剪：C 档审批链+灰度+签名链随 E2/E3（draft→published 直发，发布者
// 须 admin:app:publish 由路由守卫承担）；manifest 注册制（无包体下载）。
package ecoservice

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	ecorepo "github.com/baobaochat/server/internal/eco/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// AppSvcReq 登记入参
type AppSvcReq struct {
	AppID       string `json:"app_id"` // 命名空间（如 crm.sync；小写字母数字与 . _ -）
	Name        string `json:"name"`   // 显示名
	Description string `json:"description"`
	Manifest    string `json:"manifest"` // AppManifest JSON（工具/技能清单）
	Version     string `json:"version"`  // 首版版本号（语义化）
	HighRisk    bool   `json:"high_risk"`
}

// AppDTO 应用行（管理端/用户端共用）
type AppDTO struct {
	ID             string `json:"id,string"`
	AppID          string `json:"app_id"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	Status         string `json:"status"`
	CurrentVersion string `json:"current_version"`
	CreatedAt      int64  `json:"created_at"`
}

// AppVersionDTO 版本行
type AppVersionDTO struct {
	ID          string `json:"id,string"`
	Version     string `json:"version"`
	Manifest    string `json:"manifest"`
	HighRisk    bool   `json:"high_risk"`
	Status      string `json:"status"`
	PublishedAt int64  `json:"published_at"` // ms；0=未发布
	CreatedAt   int64  `json:"created_at"`
}

// CatalogEntry 用户端 catalog 差异条目（10 篇 §4.3：action=install|upgrade|revoke|noop）
type CatalogEntry struct {
	AppDTO
	Action     string `json:"action"`                // install|upgrade|revoke|noop
	Manifest   string `json:"manifest,omitempty"`    // install/upgrade 携带当前发布版清单
	InstalledV string `json:"installed_v,omitempty"` // revoke/noop 携带本地版本
}

// RegisterApp 登记+首版（draft 态；app_id 唯一）
func (s *Service) RegisterApp(ctx context.Context, tenantID, userID int64, req AppSvcReq) (*AppDTO, error) {
	appID := strings.TrimSpace(req.AppID)
	name := strings.TrimSpace(req.Name)
	if appID == "" || len(appID) > 64 || !validAppID(appID) {
		return nil, errx.New(errx.CodeBadRequest, "app_id 非法（小写字母数字与 . _ -，≤64）")
	}
	if name == "" || len([]rune(name)) > 50 {
		return nil, errx.New(errx.CodeBadRequest, "name 非空 ≤50 字")
	}
	if !validSemver(req.Version) {
		return nil, errx.New(errx.CodeBadRequest, "version 须语义化（x.y.z）")
	}
	if !json.Valid([]byte(req.Manifest)) {
		return nil, errx.New(errx.CodeBadRequest, "manifest 须为合法 JSON")
	}
	a, err := s.apps.InsertApp(ctx, ecorepo.App{
		TenantID: tenantID, AppID: appID, Name: name, Description: strings.TrimSpace(req.Description),
		CreatedBy: userID,
	})
	if err != nil {
		if err == ecorepo.ErrAppDup {
			return nil, errx.New(errx.CodeBadRequest, "app_id 已存在")
		}
		return nil, errx.From(err)
	}
	if _, err := s.apps.InsertAppVersion(ctx, ecorepo.AppVersion{
		TenantID: tenantID, AppRowID: a.ID, Version: strings.TrimSpace(req.Version),
		Manifest: req.Manifest, HighRisk: req.HighRisk,
	}); err != nil {
		return nil, errx.From(err)
	}
	dto := toAppDTO(a)
	return &dto, nil
}

// ListApps 管理端全量
func (s *Service) ListApps(ctx context.Context, tenantID int64) ([]AppDTO, error) {
	apps, err := s.apps.ListApps(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]AppDTO, 0, len(apps))
	for _, a := range apps {
		out = append(out, toAppDTO(a))
	}
	return out, nil
}

// ListAppVersions 版本线（管理端）
func (s *Service) ListAppVersions(ctx context.Context, tenantID, appRowID int64) ([]AppVersionDTO, error) {
	vs, err := s.apps.ListAppVersions(ctx, tenantID, appRowID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]AppVersionDTO, 0, len(vs))
	for _, v := range vs {
		dto := toAppVersionDTO(v)
		out = append(out, dto)
	}
	return out, nil
}

// AddAppVersion 追加版本（draft）
func (s *Service) AddAppVersion(ctx context.Context, tenantID, appRowID int64, version, manifest string, highRisk bool) (*AppVersionDTO, error) {
	if !validSemver(version) {
		return nil, errx.New(errx.CodeBadRequest, "version 须语义化（x.y.z）")
	}
	if !json.Valid([]byte(manifest)) {
		return nil, errx.New(errx.CodeBadRequest, "manifest 须为合法 JSON")
	}
	v, err := s.apps.InsertAppVersion(ctx, ecorepo.AppVersion{
		TenantID: tenantID, AppRowID: appRowID, Version: strings.TrimSpace(version),
		Manifest: manifest, HighRisk: highRisk,
	})
	if err != nil {
		if err == ecorepo.ErrAppDup {
			return nil, errx.New(errx.CodeBadRequest, "同版本号已存在")
		}
		return nil, errx.From(err)
	}
	dto := toAppVersionDTO(v)
	return &dto, nil
}

// PublishAppVersion 发布（v0.1 draft→published 直发；app.current_version 同步）。
// 回滚=发布旧版本（SetVersionStatus published + current_version 指回；E3 C 档随审批链）。
func (s *Service) PublishAppVersion(ctx context.Context, tenantID, userID, appRowID, versionRowID int64) error {
	vs, err := s.apps.ListAppVersions(ctx, tenantID, appRowID)
	if err != nil {
		return errx.From(err)
	}
	var target *ecorepo.AppVersion
	for i := range vs {
		if vs[i].ID == versionRowID {
			target = &vs[i]
			break
		}
	}
	if target == nil {
		return errx.New(errx.CodeNotFound, "版本不存在")
	}
	if err := s.apps.SetVersionStatus(ctx, tenantID, versionRowID, "published", userID, time.Now()); err != nil {
		return errx.From(err)
	}
	if err := s.apps.SetAppStatus(ctx, tenantID, appRowID, "published", target.Version); err != nil {
		return errx.From(err)
	}
	// app.updated 推送（客户端同步）随 WS 事件源接线（10 §4.3；阶段二 tools.reload 联动，登记）
	return nil
}

// DelistApp 下架（app.revoked 语义；安装用户 catalog 收 revoke）
func (s *Service) DelistApp(ctx context.Context, tenantID, appRowID int64) error {
	if err := s.apps.SetAppStatus(ctx, tenantID, appRowID, "delisted", ""); err != nil {
		return errx.From(err)
	}
	return nil
}

// Catalog 用户端同步（10 篇 §4.3 差异：本地安装集 vs published 全集）
func (s *Service) Catalog(ctx context.Context, tenantID, userID int64) ([]CatalogEntry, error) {
	pub, err := s.apps.ListPublishedApps(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	installs, err := s.apps.ListInstallsByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	instOf := map[int64]ecorepo.AppInstall{}
	for _, i := range installs {
		instOf[i.AppRowID] = i
	}
	out := make([]CatalogEntry, 0, len(pub))
	for _, a := range pub {
		e := CatalogEntry{AppDTO: toAppDTO(a)}
		inst, ok := instOf[a.ID]
		// 灰度收敛（E2）：未入灰度且未安装 → 不透出（防探测量）；未入灰度已安装
		// → 保持当前版不推升级（已装=已在放量集）；入灰度 → install/upgrade 照常
		if !s.inRollout(ctx, tenantID, a.ID, userID) {
			if !ok {
				continue
			}
			e.Action = "noop"
			e.InstalledV = inst.Version
			out = append(out, e)
			continue
		}
		if !ok {
			e.Action = "install"
		} else if inst.Version != a.CurrentVersion {
			e.Action = "upgrade"
		} else {
			e.Action = "noop"
		}
		if e.Action != "noop" {
			if v, verr := s.apps.GetPublishedVersion(ctx, tenantID, a.ID); verr == nil {
				e.Manifest = v.Manifest
			}
		} else {
			e.InstalledV = inst.Version
		}
		out = append(out, e)
	}
	// 已安装但被下架/删除的应用 → revoke
	all, _ := s.apps.ListApps(ctx, tenantID)
	for _, i := range installs {
		stillPub := false
		for _, a := range pub {
			if a.ID == i.AppRowID {
				stillPub = true
				break
			}
		}
		if !stillPub {
			for _, a := range all {
				if a.ID == i.AppRowID {
					out = append(out, CatalogEntry{AppDTO: toAppDTO(a), Action: "revoke", InstalledV: i.Version})
					break
				}
			}
		}
	}
	return out, nil
}

// InstallApp 安装/升级（agent:app:install；版本锚定当前发布版）
func (s *Service) InstallApp(ctx context.Context, tenantID, userID, appRowID int64) (*AppVersionDTO, error) {
	apps, aerr := s.apps.ListApps(ctx, tenantID)
	if aerr != nil {
		return nil, errx.From(aerr)
	}
	var target *ecorepo.App
	for i := range apps {
		if apps[i].ID == appRowID {
			target = &apps[i]
			break
		}
	}
	if target == nil || target.Status != "published" {
		return nil, errx.New(errx.CodeNotFound, "应用不存在或未发布")
	}
	// 灰度闸门（E2）：未入灰度 → 拒（catalog 已收敛，此处防直调绕过）
	if !s.inRollout(ctx, tenantID, appRowID, userID) {
		return nil, errx.New(errx.CodeNotFound, "应用不在你的可用范围（灰度中）")
	}
	v, err := s.apps.GetPublishedVersion(ctx, tenantID, appRowID)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "应用无发布版本")
	}
	if err := s.apps.UpsertInstall(ctx, ecorepo.AppInstall{
		TenantID: tenantID, AppRowID: appRowID, UserID: userID, Version: v.Version,
	}); err != nil {
		return nil, errx.From(err)
	}
	dto := toAppVersionDTO(*v)
	return &dto, nil
}

// UninstallApp 卸载（幂等）
func (s *Service) UninstallApp(ctx context.Context, tenantID, userID, appRowID int64) error {
	if err := s.apps.DeleteInstall(ctx, tenantID, appRowID, userID); err != nil {
		return errx.From(err)
	}
	return nil
}

// MyInstalls 我的安装集
func (s *Service) MyInstalls(ctx context.Context, tenantID, userID int64) ([]AppInstallDTO, error) {
	installs, err := s.apps.ListInstallsByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	apps, _ := s.apps.ListApps(ctx, tenantID)
	appOf := map[int64]ecorepo.App{}
	for _, a := range apps {
		appOf[a.ID] = a
	}
	out := make([]AppInstallDTO, 0, len(installs))
	for _, i := range installs {
		a := appOf[i.AppRowID]
		out = append(out, AppInstallDTO{
			AppDTO: toAppDTO(a), Version: i.Version, InstalledAt: i.InstalledAt.UnixMilli(),
		})
	}
	return out, nil
}

// AppInstallDTO 安装行（含应用投影）
type AppInstallDTO struct {
	AppDTO
	Version     string `json:"version"`
	InstalledAt int64  `json:"installed_at"`
}

// ── helpers ──

func validAppID(s string) bool {
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !ok {
			return false
		}
	}
	return true
}

func validSemver(v string) bool {
	parts := strings.Split(strings.TrimSpace(v), ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if p == "" || len(p) > 8 {
			return false
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func toAppDTO(a ecorepo.App) AppDTO {
	return AppDTO{
		ID: i64s(a.ID), AppID: a.AppID, Name: a.Name, Description: a.Description,
		Status: a.Status, CurrentVersion: a.CurrentVersion, CreatedAt: a.CreatedAt.UnixMilli(),
	}
}

func toAppVersionDTO(v ecorepo.AppVersion) AppVersionDTO {
	dto := AppVersionDTO{
		ID: i64s(v.ID), Version: v.Version, Manifest: v.Manifest, HighRisk: v.HighRisk,
		Status: v.Status, CreatedAt: v.CreatedAt.UnixMilli(),
	}
	if !v.PublishedAt.IsZero() && v.Status == "published" {
		dto.PublishedAt = v.PublishedAt.UnixMilli()
	}
	return dto
}

func i64s(n int64) string { return strconv.FormatInt(n, 10) }

// ── 灰度（0032 / E2 / OQ-B13）──

// RolloutReq 灰度设置入参
type RolloutReq struct {
	VersionRowID int64   `json:"version_row_id,string"`
	CanaryPct    int     `json:"canary_pct"` // 0-100；100=全量
	Whitelist    []int64 `json:"whitelist"`  // OQ-B13：白名单=100% 豁免
}

// RolloutDTO 灰度读出
type RolloutDTO struct {
	VersionRowID string  `json:"version_row_id,string"`
	CanaryPct    int     `json:"canary_pct"`
	Whitelist    []int64 `json:"whitelist"`
}

// SetRollout 设置灰度（admin:app:publish 路由守卫；version 须属于该应用）
func (s *Service) SetRollout(ctx context.Context, tenantID, operatorID, appRowID int64, req RolloutReq) (*RolloutDTO, error) {
	if req.CanaryPct < 0 || req.CanaryPct > 100 {
		return nil, errx.New(errx.CodeBadRequest, "canary_pct 0-100")
	}
	if len(req.Whitelist) > 1000 {
		return nil, errx.New(errx.CodeBadRequest, "白名单 ≤1000 用户")
	}
	// 版本归属校验（防跨应用版本号）
	vs, err := s.apps.ListAppVersions(ctx, tenantID, appRowID)
	if err != nil {
		return nil, errx.From(err)
	}
	belongs := false
	for _, v := range vs {
		if v.ID == req.VersionRowID {
			belongs = true
			break
		}
	}
	if !belongs {
		return nil, errx.New(errx.CodeBadRequest, "version_row_id 不属于该应用")
	}
	wl, _ := json.Marshal(req.Whitelist)
	if err := s.rollouts.UpsertRollout(ctx, ecorepo.Rollout{
		TenantID: tenantID, AppRowID: appRowID, VersionRowID: req.VersionRowID,
		CanaryPct: req.CanaryPct, Whitelist: string(wl), UpdatedBy: operatorID,
	}); err != nil {
		return nil, errx.From(err)
	}
	dto, err := s.GetRollout(ctx, tenantID, appRowID)
	if err != nil {
		return nil, err
	}
	return dto, nil
}

// GetRollout 读灰度（无行=全量默认）
func (s *Service) GetRollout(ctx context.Context, tenantID, appRowID int64) (*RolloutDTO, error) {
	r, err := s.rollouts.GetRollout(ctx, tenantID, appRowID)
	if err != nil {
		return nil, errx.From(err)
	}
	if r == nil {
		return &RolloutDTO{CanaryPct: 100, Whitelist: []int64{}}, nil
	}
	dto := &RolloutDTO{VersionRowID: i64s(r.VersionRowID), CanaryPct: r.CanaryPct, Whitelist: []int64{}}
	_ = json.Unmarshal([]byte(r.Whitelist), &dto.Whitelist)
	return dto, nil
}

// inRollout 灰度判定（确定性：白名单 100% 豁免；否则 uid%100 < pct）。
// rollouts 未装配 / 无行 / pct=100 → 恒真（全量）。
func (s *Service) inRollout(ctx context.Context, tenantID, appRowID, userID int64) bool {
	if s.rollouts == nil {
		return true
	}
	r, err := s.rollouts.GetRollout(ctx, tenantID, appRowID)
	if err != nil || r == nil || r.CanaryPct >= 100 {
		return true
	}
	var wl []int64
	_ = json.Unmarshal([]byte(r.Whitelist), &wl)
	for _, uid := range wl {
		if uid == userID {
			return true // OQ-B13：白名单豁免
		}
	}
	return userID%100 < int64(r.CanaryPct)
}
