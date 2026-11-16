// 技能包服务（0034 / E4 / 10 篇 §6：发布/catalog/安装/卸载/force 卸载拒）。
package ecoservice

import (
	"context"
	"strings"

	ecorepo "github.com/baobaochat/server/internal/eco/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// SkillPolicy 三档（10 篇 §4.5）
const (
	SkillPolicyForce     = 1
	SkillPolicyRecommend = 2
	SkillPolicyOptional  = 3
)

// SkillDTO 技能行
type SkillDTO struct {
	ID             string `json:"id,string"`
	SkillID        string `json:"skill_id"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	Policy         int    `json:"policy"` // 1 force 2 recommend 3 optional
	Status         string `json:"status"`
	CurrentVersion string `json:"current_version"`
	CreatedAt      int64  `json:"created_at"`
}

// SkillCatalogEntry 用户 catalog 条目（含安装态）
type SkillCatalogEntry struct {
	SkillDTO
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"` // 已装版本
	Manifest  string `json:"manifest,omitempty"`
}

// SkillSvcReq 发布/更新入参
type SkillSvcReq struct {
	SkillID     string `json:"skill_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Policy      int    `json:"policy"`
	Version     string `json:"version"`
	Manifest    string `json:"manifest"`
}

// PublishSkill 发布技能包（draft→published；admin:skill:publish 路由守卫）
func (s *Service) PublishSkill(ctx context.Context, tenantID, userID int64, req SkillSvcReq) (*SkillDTO, error) {
	skillID := strings.TrimSpace(req.SkillID)
	name := strings.TrimSpace(req.Name)
	if skillID == "" || len(skillID) > 64 || !validAppID(skillID) {
		return nil, errx.New(errx.CodeBadRequest, "skill_id 非法（小写字母数字与 . _ -，≤64）")
	}
	if name == "" || len([]rune(name)) > 50 {
		return nil, errx.New(errx.CodeBadRequest, "name 非空 ≤50 字")
	}
	if !validSemver(req.Version) {
		return nil, errx.New(errx.CodeBadRequest, "version 须语义化（x.y.z）")
	}
	if strings.TrimSpace(req.Manifest) == "" {
		return nil, errx.New(errx.CodeBadRequest, "manifest 必填（YAML 清单）")
	}
	policy := req.Policy
	if policy == 0 {
		policy = SkillPolicyOptional
	}
	if policy < SkillPolicyForce || policy > SkillPolicyOptional {
		return nil, errx.New(errx.CodeBadRequest, "policy 合法值：1(force) 2(recommend) 3(optional)")
	}
	sk, err := s.skills.InsertSkill(ctx, ecorepo.Skill{
		TenantID: tenantID, SkillID: skillID, Name: name,
		Description: strings.TrimSpace(req.Description), Policy: policy,
		CurrentVersion: strings.TrimSpace(req.Version), Manifest: req.Manifest, CreatedBy: userID,
	})
	if err != nil {
		if err == ecorepo.ErrSkillDup {
			return nil, errx.New(errx.CodeBadRequest, "skill_id 已存在")
		}
		return nil, errx.From(err)
	}
	if err := s.skills.SetSkillStatus(ctx, tenantID, sk.ID, "published"); err != nil {
		return nil, errx.From(err)
	}
	dto := toSkillDTO(sk)
	dto.Status = "published"
	return &dto, nil
}

// UpdateSkill 更新（manifest 覆盖+版本 bump；回滚=旧 manifest 重发，随 E3）
func (s *Service) UpdateSkill(ctx context.Context, tenantID, userID, id int64, req SkillSvcReq) (*SkillDTO, error) {
	if err := s.skills.UpdateSkill(ctx, tenantID, id, req.Name, req.Description, req.Manifest, req.Version, req.Policy); err != nil {
		return nil, errx.From(err)
	}
	sk, err := s.skills.GetSkill(ctx, tenantID, id)
	if err != nil {
		return nil, errx.From(err)
	}
	dto := toSkillDTO(*sk)
	return &dto, nil
}

// ListSkills 管理端全量
func (s *Service) ListSkills(ctx context.Context, tenantID int64) ([]SkillDTO, error) {
	sks, err := s.skills.ListSkills(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]SkillDTO, 0, len(sks))
	for _, sk := range sks {
		out = append(out, toSkillDTO(sk))
	}
	return out, nil
}

// DelistSkill 下架
func (s *Service) DelistSkill(ctx context.Context, tenantID, id int64) error {
	if err := s.skills.SetSkillStatus(ctx, tenantID, id, "delisted"); err != nil {
		return errx.From(err)
	}
	return nil
}

// SkillCatalog 用户 catalog（published 全集+安装态；manifest 随未装/升级下发）
func (s *Service) SkillCatalog(ctx context.Context, tenantID, userID int64) ([]SkillCatalogEntry, error) {
	pub, err := s.skills.ListPublishedSkills(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	insts, err := s.skills.ListSkillInstallsByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	instOf := map[int64]ecorepo.SkillInstall{}
	for _, i := range insts {
		instOf[i.SkillRowID] = i
	}
	out := make([]SkillCatalogEntry, 0, len(pub))
	for _, sk := range pub {
		e := SkillCatalogEntry{SkillDTO: toSkillDTO(sk)}
		if inst, ok := instOf[sk.ID]; ok {
			e.Installed = true
			e.Version = inst.Version
			if inst.Version != sk.CurrentVersion {
				e.Manifest = sk.Manifest // 升级路径下发新清单
			}
		} else {
			e.Manifest = sk.Manifest
		}
		out = append(out, e)
	}
	return out, nil
}

// InstallSkill 安装/升级（版本锚定当前发布版）
func (s *Service) InstallSkill(ctx context.Context, tenantID, userID, id int64) (*SkillDTO, error) {
	sk, err := s.skills.GetSkill(ctx, tenantID, id)
	if err != nil || sk.Status != "published" {
		return nil, errx.New(errx.CodeNotFound, "技能不存在或未发布")
	}
	if err := s.skills.UpsertSkillInstall(ctx, ecorepo.SkillInstall{
		TenantID: tenantID, SkillRowID: id, UserID: userID, Version: sk.CurrentVersion,
	}); err != nil {
		return nil, errx.From(err)
	}
	dto := toSkillDTO(*sk)
	return &dto, nil
}

// UninstallSkill 卸载（force 档拒——10 篇：强制技能不可自卸；recommend/optional 可卸）
func (s *Service) UninstallSkill(ctx context.Context, tenantID, userID, id int64) error {
	sk, err := s.skills.GetSkill(ctx, tenantID, id)
	if err != nil {
		return errx.New(errx.CodeNotFound, "技能不存在")
	}
	if sk.Policy == SkillPolicyForce {
		return errx.New(errx.CodeBadRequest, "强制技能（force）不可卸载——联系管理员调整策略")
	}
	if err := s.skills.DeleteSkillInstall(ctx, tenantID, id, userID); err != nil {
		return errx.From(err)
	}
	return nil
}

// MySkills 我的安装集
func (s *Service) MySkills(ctx context.Context, tenantID, userID int64) ([]SkillCatalogEntry, error) {
	insts, err := s.skills.ListSkillInstallsByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	all, _ := s.skills.ListSkills(ctx, tenantID)
	skOf := map[int64]ecorepo.Skill{}
	for _, sk := range all {
		skOf[sk.ID] = sk
	}
	out := make([]SkillCatalogEntry, 0, len(insts))
	for _, i := range insts {
		sk := skOf[i.SkillRowID]
		out = append(out, SkillCatalogEntry{SkillDTO: toSkillDTO(sk), Installed: true, Version: i.Version})
	}
	return out, nil
}

func toSkillDTO(sk ecorepo.Skill) SkillDTO {
	return SkillDTO{
		ID: i64s(sk.ID), SkillID: sk.SkillID, Name: sk.Name, Description: sk.Description,
		Policy: sk.Policy, Status: sk.Status, CurrentVersion: sk.CurrentVersion, CreatedAt: sk.CreatedAt.UnixMilli(),
	}
}
