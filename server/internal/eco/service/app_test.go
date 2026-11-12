// 生态应用服务测试（E1）：注册/版本/发布/catalog 差异/安装/下架 revoke。
package ecoservice

import (
	"context"
	"testing"

	ecorepo "github.com/baobaowork/server/internal/eco/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

func newAppSvc() *Service {
	return New(ecorepo.NewMemory(), ecorepo.NewAppMemory(), ecorepo.NewRolloutMemory(), ecorepo.NewSkillMemory(), ecorepo.NewPluginMemory())
}

func TestEcoAppLifecycle(t *testing.T) {
	svc := newAppSvc()
	ctx := context.Background()
	manifest := `{"tools":[{"name":"crm.sync","risk":"low"}]}`

	// 登记+首版 draft
	app, err := svc.RegisterApp(ctx, 1, 42, AppSvcReq{
		AppID: "crm.sync", Name: "CRM 连接器", Version: "1.0.0", Manifest: manifest,
	})
	if err != nil || app.Status != "draft" {
		t.Fatalf("注册: %v %+v", err, app)
	}
	// app_id 重复 → 9001
	if _, err := svc.RegisterApp(ctx, 1, 42, AppSvcReq{AppID: "crm.sync", Name: "x", Version: "1.0.0", Manifest: "{}"}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("重复 app_id 应 9001: %v", err)
	}
	// 非法 semver → 9001
	if _, err := svc.RegisterApp(ctx, 1, 42, AppSvcReq{AppID: "x.y", Name: "x", Version: "v1", Manifest: "{}"}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("非法版本应 9001: %v", err)
	}

	// 版本线 + 追加 1.1.0
	vers, _ := svc.ListAppVersions(ctx, 1, mustRowID(t, app.ID))
	if len(vers) != 1 || vers[0].Status != "draft" {
		t.Fatalf("首版应 draft: %+v", vers)
	}
	v2, err := svc.AddAppVersion(ctx, 1, mustRowID(t, app.ID), "1.1.0", manifest, false)
	if err != nil {
		t.Fatal(err)
	}

	// 发布 1.1.0 → app published + current_version
	rowID := mustRowID(t, app.ID)
	if err := svc.PublishAppVersion(ctx, 1, 42, rowID, mustRowID(t, v2.ID)); err != nil {
		t.Fatalf("发布: %v", err)
	}
	apps, _ := svc.ListApps(ctx, 1)
	if apps[0].Status != "published" || apps[0].CurrentVersion != "1.1.0" {
		t.Fatalf("发布态不符: %+v", apps[0])
	}

	// catalog（未安装）→ install 动作带 manifest
	cat, err := svc.Catalog(ctx, 1, 10001)
	if err != nil || len(cat) != 1 || cat[0].Action != "install" || cat[0].Manifest != manifest {
		t.Fatalf("catalog install 不符: %v %+v", err, cat)
	}
	// 安装 → catalog 转 noop（版本对齐）
	if _, err := svc.InstallApp(ctx, 1, 10001, rowID); err != nil {
		t.Fatal(err)
	}
	cat, _ = svc.Catalog(ctx, 1, 10001)
	if cat[0].Action != "noop" || cat[0].InstalledV != "1.1.0" {
		t.Fatalf("安装后应 noop: %+v", cat[0])
	}
	// 追加并发布 1.2.0 → catalog upgrade
	v3, _ := svc.AddAppVersion(ctx, 1, rowID, "1.2.0", manifest, false)
	_ = svc.PublishAppVersion(ctx, 1, 42, rowID, mustRowID(t, v3.ID))
	cat, _ = svc.Catalog(ctx, 1, 10001)
	if cat[0].Action != "upgrade" {
		t.Fatalf("新版应 upgrade: %+v", cat[0])
	}
	// 我的安装集
	inst, _ := svc.MyInstalls(ctx, 1, 10001)
	if len(inst) != 1 || inst[0].Version != "1.1.0" {
		t.Fatalf("安装集不符: %+v", inst)
	}

	// 下架 → catalog revoke（10 §4.4 撤销语义）
	if err := svc.DelistApp(ctx, 1, rowID); err != nil {
		t.Fatal(err)
	}
	cat, _ = svc.Catalog(ctx, 1, 10001)
	if len(cat) != 1 || cat[0].Action != "revoke" {
		t.Fatalf("下架应 revoke: %+v", cat)
	}
	// 卸载幂等
	if err := svc.UninstallApp(ctx, 1, 10001, rowID); err != nil {
		t.Fatal(err)
	}
}

func mustRowID(t *testing.T, s string) int64 {
	t.Helper()
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			t.Fatalf("非法行 ID: %s", s)
		}
		n = n*10 + int64(c-'0')
	}
	if n == 0 {
		t.Fatal("行 ID 为 0")
	}
	return n
}

// TestEcoRollout E2：canary 收敛/白名单 100% 豁免（OQ-B13）/install 闸门/已装保持
func TestEcoRollout(t *testing.T) {
	svc := newAppSvc()
	ctx := context.Background()
	manifest := `{"tools":[]}`

	app, err := svc.RegisterApp(ctx, 1, 42, AppSvcReq{AppID: "grey.app", Name: "灰度应用", Version: "1.0.0", Manifest: manifest})
	if err != nil {
		t.Fatal(err)
	}
	rowID := mustRowID(t, app.ID)
	vers, _ := svc.ListAppVersions(ctx, 1, rowID)
	if err := svc.PublishAppVersion(ctx, 1, 42, rowID, mustRowID(t, vers[0].ID)); err != nil {
		t.Fatal(err)
	}

	// pct 非法 → 9001
	if _, err := svc.SetRollout(ctx, 1, 42, rowID, RolloutReq{VersionRowID: mustRowID(t, vers[0].ID), CanaryPct: 101}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("pct 101 应 9001: %v", err)
	}
	// 跨应用版本 → 9001
	if _, err := svc.SetRollout(ctx, 1, 42, rowID, RolloutReq{VersionRowID: 999999, CanaryPct: 50}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("跨应用版本应 9001: %v", err)
	}

	// 30% 灰度 + 白名单 [10001]（10001%100=1 <30 本就在灰度内——换 10001 豁免与 10081（81≥30 拒）验证百分比；10081 加白豁免）
	if _, err := svc.SetRollout(ctx, 1, 42, rowID, RolloutReq{
		VersionRowID: mustRowID(t, vers[0].ID), CanaryPct: 30, Whitelist: []int64{10081},
	}); err != nil {
		t.Fatal(err)
	}

	// uid=10001（1%100=1<30）：灰度内 → catalog install
	cat, _ := svc.Catalog(ctx, 1, 10001)
	if len(cat) != 1 || cat[0].Action != "install" {
		t.Fatalf("灰度内用户应见 install: %+v", cat)
	}
	// uid=10051（51≥30）：灰度外 → 不透出；直调 install 被拒
	cat, _ = svc.Catalog(ctx, 1, 10051)
	if len(cat) != 0 {
		t.Fatalf("灰度外用户不应透出: %+v", cat)
	}
	if _, err := svc.InstallApp(ctx, 1, 10051, rowID); errx.From(err).Code != errx.CodeNotFound {
		t.Fatalf("灰度外 install 应拒: %v", err)
	}
	// uid=10081：白名单豁免 → install 成功
	if _, err := svc.InstallApp(ctx, 1, 10081, rowID); err != nil {
		t.Fatalf("白名单豁免 install: %v", err)
	}

	// 已装用户在灰度收紧后保持：10081 已装 v1.0.0 → 升版 v1.1.0 并 0% 灰度 → 10081 保持 noop（不推升级）
	v2, _ := svc.AddAppVersion(ctx, 1, rowID, "1.1.0", manifest, false)
	_ = svc.PublishAppVersion(ctx, 1, 42, rowID, mustRowID(t, v2.ID))
	_, _ = svc.SetRollout(ctx, 1, 42, rowID, RolloutReq{VersionRowID: mustRowID(t, v2.ID), CanaryPct: 0, Whitelist: []int64{}})
	cat, _ = svc.Catalog(ctx, 1, 10081)
	if len(cat) != 1 || cat[0].Action != "noop" || cat[0].InstalledV != "1.0.0" {
		t.Fatalf("已装用户 0%% 灰度应保持 noop 不推升级: %+v", cat)
	}
	// 白名单移除后（0% 无白名单）→ 已装仍 noop；新用户全隐
	cat2, _ := svc.Catalog(ctx, 1, 10001)
	if len(cat2) != 0 {
		t.Fatalf("0%% 灰度新用户应全隐: %+v", cat2)
	}
	// 回全量（pct 100）→ 恢复 upgrade 可见
	_, _ = svc.SetRollout(ctx, 1, 42, rowID, RolloutReq{VersionRowID: mustRowID(t, v2.ID), CanaryPct: 100})
	cat3, _ := svc.Catalog(ctx, 1, 10001)
	if len(cat3) != 1 || cat3[0].Action != "install" {
		t.Fatalf("全量应恢复可见: %+v", cat3)
	}
}
