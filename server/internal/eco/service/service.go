// 专家定义包分发服务（D14 §5 复用 10 篇通道的阶段一务实版）。
//
// 公司库（source=1，管理发布）/个人库（source=2，用户自建）。v0.1 裁剪：
// 签名链/审批/灰度随 10 篇完整通道阶段二（内网单租户直发）；manifest
// 服务端仅基础键校验（id/type/display/persona 存在性）——深度校验由
// Agent 拉取侧 parse_manifest 兜底（失败静默跳过，ExpertIndex 同款降级）。
package ecoservice

import (
	"context"
	"regexp"
	"strings"

	ecorepo "github.com/baobaowork/server/internal/eco/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

var (
	reExpertID = regexp.MustCompile(`^(corp|dept)\.[a-z0-9-]+$|^usr\.\d+\.[a-z0-9-]+$`)
	reLineKey  = regexp.MustCompile(`(?m)^(id|type|display|persona):`)
)

// Service 生态域服务
type Service struct {
	repo        ecorepo.Repo
	apps        ecorepo.AppRepo     // 生态应用（0031/E1）；nil=应用面 9004
	rollouts    ecorepo.RolloutRepo // 灰度（0032/E2）；nil=全量（无灰度）
	skills      ecorepo.SkillRepo   // 技能包（0034/E4）；nil=技能面 9004
	pluginsRepo ecorepo.PluginRepo  // 插件市场（0036/D22/L1）；nil=插件面 9004
}

// New 构造（apps/rollouts/skills/plugins 可 nil——未装配时对应面降级，专家面不受影响）
func New(r ecorepo.Repo, apps ecorepo.AppRepo, rollouts ecorepo.RolloutRepo, skills ecorepo.SkillRepo, plugins ecorepo.PluginRepo) *Service {
	return &Service{repo: r, apps: apps, rollouts: rollouts, skills: skills, pluginsRepo: plugins}
}

// PublishReq 发布入参
type PublishReq struct {
	Manifest  string
	AsCompany bool // true=公司库（main 装配决定：管理端走 adminOnly 已隔离，用户端恒 false）
}

// Publish 发布/更新：基础键校验 → 个人前缀归属校验 → upsert（同
// expert_id 覆盖 manifest，版本随包）。个人库 expert_id 必须 usr.{本人uid}.
// 前缀（防越权发布他人命名空间，D14 §2）。
func (s *Service) Publish(ctx context.Context, tenantID, userID int64, req PublishReq) (*ecorepo.Expert, error) {
	expertID, version, display, summary, err := basicValidate(req.Manifest)
	if err != nil {
		return nil, err
	}
	source := ecorepo.SourcePersonal
	if req.AsCompany {
		source = ecorepo.SourceCompany
	} else {
		// 个人命名空间强制：usr.{uid}. 前缀
		if !strings.HasPrefix(expertID, "usr."+itoa(userID)+".") {
			return nil, errx.New(errx.CodeBadRequest, "个人专家 expert_id 须 usr.{你的uid}. 前缀")
		}
	}
	if existing, gerr := s.repo.GetByExpertID(ctx, tenantID, expertID); gerr == nil {
		// 覆盖：仅本人（个人库）或任意管理员（公司库经 adminOnly 端点隔离）
		if existing.Source == ecorepo.SourcePersonal && existing.OwnerUserID != userID {
			return nil, errx.New(errx.CodePermACLDenied, "仅作者可更新")
		}
		if uerr := s.repo.UpdateManifest(ctx, tenantID, existing.ID, version, display, summary, req.Manifest); uerr != nil {
			return nil, uerr
		}
		return s.repo.Get(ctx, tenantID, existing.ID)
	}
	created, cerr := s.repo.Create(ctx, ecorepo.Expert{
		TenantID: tenantID, ExpertID: expertID, Version: version, Display: display,
		Summary: summary, Source: source,
		OwnerUserID: ownerOf(source, userID),
		Manifest:    req.Manifest, Status: ecorepo.StatusPublished, CreatedBy: userID,
	})
	if cerr != nil {
		return nil, cerr
	}
	return &created, nil
}

// List 清单（scope=company|mine|all——published only；不含 manifest 正文）
func (s *Service) List(ctx context.Context, tenantID, userID int64, scope string) ([]ecorepo.Expert, error) {
	f := ecorepo.ListFilter{Status: ecorepo.StatusPublished}
	switch scope {
	case "company":
		f.Source = ecorepo.SourceCompany
	case "mine":
		f.Source = ecorepo.SourcePersonal
		f.Owner = userID
	case "", "all":
	default:
		return nil, errx.New(errx.CodeBadRequest, "scope ∈ company|mine|all")
	}
	list, err := s.repo.List(ctx, tenantID, f)
	if err != nil {
		return nil, err
	}
	for i := range list { // 清单瘦身（manifest 不下发——按需 download）
		list[i].Manifest = ""
	}
	return list, nil
}

// Download 定义包原文（Agent 拉取；published only）
func (s *Service) Download(ctx context.Context, tenantID, id int64) (*ecorepo.Expert, error) {
	e, err := s.repo.Get(ctx, tenantID, id)
	if err != nil || e.Status != ecorepo.StatusPublished {
		return nil, errx.New(errx.CodeNotFound, "专家不存在或未发布")
	}
	return e, nil
}

// Unpublish 下架（作者本人/公司库）
func (s *Service) Unpublish(ctx context.Context, tenantID, userID, id int64) error {
	e, err := s.repo.Get(ctx, tenantID, id)
	if err != nil {
		return errx.New(errx.CodeNotFound, "专家不存在")
	}
	if e.Source == ecorepo.SourcePersonal && e.OwnerUserID != userID {
		return errx.New(errx.CodePermACLDenied, "仅作者可下架")
	}
	return s.repo.UpdateStatus(ctx, tenantID, id, ecorepo.StatusUnpublished)
}

// Delete 删除（本人）
func (s *Service) Delete(ctx context.Context, tenantID, userID, id int64) error {
	e, err := s.repo.Get(ctx, tenantID, id)
	if err != nil {
		return errx.New(errx.CodeNotFound, "专家不存在")
	}
	if e.Source == ecorepo.SourcePersonal && e.OwnerUserID != userID {
		return errx.New(errx.CodePermACLDenied, "仅作者可删除")
	}
	return s.repo.Delete(ctx, tenantID, id)
}

// basicValidate 基础键校验+元数据提取（id/version/display/persona 首行摘要）
func basicValidate(manifest string) (expertID, version, display, summary string, err error) {
	if len(manifest) > 64<<10 {
		return "", "", "", "", errx.New(errx.CodeBadRequest, "manifest ≤64KB")
	}
	if len(reLineKey.FindAllString(manifest, -1)) < 3 {
		return "", "", "", "", errx.New(errx.CodeBadRequest, "manifest 缺基础键（id/type/display/persona）")
	}
	expertID = lineValue(manifest, "id")
	if !reExpertID.MatchString(expertID) {
		return "", "", "", "", errx.New(errx.CodeBadRequest, "expert_id 前缀须 corp./dept./usr.{uid}.")
	}
	version = lineValue(manifest, "version")
	if version == "" {
		version = "1.0.0"
	}
	display = lineValue(manifest, "display")
	if display == "" {
		return "", "", "", "", errx.New(errx.CodeBadRequest, "display 必填")
	}
	summary = personaSummary(manifest)
	if len([]rune(summary)) > 80 {
		summary = string([]rune(summary)[:80]) + "…"
	}
	return expertID, version, display, summary, nil
}

// lineValue 顶层键值提取（"key: value" 行；块标量键返回空——display 用足够）
func lineValue(manifest, key string) string {
	for _, ln := range strings.Split(manifest, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(t, key+":"))
		}
	}
	return ""
}

func ownerOf(source int, uid int64) int64 {
	if source == ecorepo.SourcePersonal {
		return uid
	}
	return 0
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// personaSummary 人设摘要：persona: | 块标量取块内首个非空行（清单展示口径）
func personaSummary(manifest string) string {
	lines := strings.Split(manifest, "\n")
	for i, ln := range lines {
		if strings.HasPrefix(strings.TrimSpace(ln), "persona:") {
			rest := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ln), "persona:"))
			if rest != "|" && rest != "" {
				return rest // 行值形态
			}
			for _, next := range lines[i+1:] { // 块标量：首个非空行
				t := strings.TrimSpace(next)
				if t != "" {
					return t
				}
			}
		}
	}
	return ""
}
