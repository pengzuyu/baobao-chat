// 技能市场服务测试（E4）：发布校验/catalog 安装态/force 卸载拒/下架。
package ecoservice

import (
	"context"
	"strconv"
	"testing"

	ecorepo "github.com/baobaochat/server/internal/eco/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// mustRowID DTO string id → int64 行号（原定义在 app_test，应用子域退役后迁此）
func mustRowID(t *testing.T, id string) int64 {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || n <= 0 {
		t.Fatalf("非法 row id: %q", id)
	}
	return n
}

func TestSkillMarket(t *testing.T) {
	svc := New(ecorepo.NewMemory(), ecorepo.NewSkillMemory(), ecorepo.NewPluginMemory())
	ctx := context.Background()
	manifest := "skills:\n  - name: weekly-report\n    steps: [...]\n"

	// 发布：非法 policy/semver/skill_id 9001
	if _, err := svc.PublishSkill(ctx, 1, 42, SkillSvcReq{SkillID: "s.x", Name: "n", Version: "1.0.0", Manifest: "m", Policy: 4}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("policy 4 应 9001: %v", err)
	}
	if _, err := svc.PublishSkill(ctx, 1, 42, SkillSvcReq{SkillID: "s.x", Name: "n", Version: "v1", Manifest: "m"}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("非法 semver 应 9001: %v", err)
	}
	if _, err := svc.PublishSkill(ctx, 1, 42, SkillSvcReq{SkillID: "Bad ID", Name: "n", Version: "1.0.0", Manifest: "m"}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("非法 skill_id 应 9001: %v", err)
	}

	// 发布 force + optional 两个技能
	force, err := svc.PublishSkill(ctx, 1, 42, SkillSvcReq{SkillID: "corp.sec", Name: "安全基线", Version: "1.0.0", Manifest: manifest, Policy: SkillPolicyForce})
	if err != nil || force.Status != "published" {
		t.Fatalf("force 发布: %v %+v", err, force)
	}
	opt, err := svc.PublishSkill(ctx, 1, 42, SkillSvcReq{SkillID: "corp.weekly", Name: "周报助手", Version: "1.0.0", Manifest: manifest, Policy: SkillPolicyOptional})
	if err != nil {
		t.Fatal(err)
	}
	// 重复 skill_id 9001
	if _, err := svc.PublishSkill(ctx, 1, 42, SkillSvcReq{SkillID: "corp.sec", Name: "x", Version: "1.0.1", Manifest: "m"}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("重复应 9001: %v", err)
	}

	// catalog：未装（installed=false+manifest 下发）
	cat, err := svc.SkillCatalog(ctx, 1, 10001)
	if err != nil || len(cat) != 2 {
		t.Fatalf("catalog: %v %d", err, len(cat))
	}
	// 安装两个
	rowForce := mustRowID(t, force.ID)
	rowOpt := mustRowID(t, opt.ID)
	if _, err := svc.InstallSkill(ctx, 1, 10001, rowForce); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.InstallSkill(ctx, 1, 10001, rowOpt); err != nil {
		t.Fatal(err)
	}
	// force 卸载拒；optional 卸载成功
	if err := svc.UninstallSkill(ctx, 1, 10001, rowForce); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("force 卸载应 9001: %v", err)
	}
	if err := svc.UninstallSkill(ctx, 1, 10001, rowOpt); err != nil {
		t.Fatalf("optional 卸载: %v", err)
	}

	// 更新 optional 技能 v1.1.0 → 已重装用户 catalog 见升级 manifest
	if _, err := svc.InstallSkill(ctx, 1, 10002, rowOpt); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateSkill(ctx, 1, 42, rowOpt, SkillSvcReq{Name: "周报助手", Version: "1.1.0", Manifest: manifest + "# v2\n"}); err != nil {
		t.Fatal(err)
	}
	cat2, _ := svc.SkillCatalog(ctx, 1, 10002)
	var hit *SkillCatalogEntry
	for i := range cat2 {
		if cat2[i].ID == opt.ID {
			hit = &cat2[i]
		}
	}
	if hit == nil || !hit.Installed || hit.CurrentVersion != "1.1.0" || hit.Manifest == manifest {
		t.Fatalf("升级态不符: %+v", hit)
	}

	// 下架 → catalog 消失
	if err := svc.DelistSkill(ctx, 1, rowOpt); err != nil {
		t.Fatal(err)
	}
	cat3, _ := svc.SkillCatalog(ctx, 1, 10002)
	if len(cat3) != 1 || cat3[0].ID != force.ID {
		t.Fatalf("下架后应仅 force: %+v", cat3)
	}
	// 我的安装集
	mine, _ := svc.MySkills(ctx, 1, 10002)
	if len(mine) != 1 || !mine[0].Installed {
		t.Fatalf("我的技能不符: %+v", mine)
	}
}
