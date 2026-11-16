// 插件市场单测（D22 §3.3 校验器规则 / §3.2 业务闭环）。
package ecoservice

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	ecorepo "github.com/baobaochat/server/internal/eco/repo"
)

// zipOf 现场构建 zip（map 名→内容）
func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// fullPlugin 四组件合法包（.mcp.json 引 BBW_USER_TOKEN + bbw.config）
func fullPlugin(manifestDir string) map[string]string {
	manifest := `{"name":"deploy-helper","version":"1.2.0","description":"发布助手",
		"skills":"./skills","commands":"./commands","agents":"./agents","mcpServers":"./.mcp.json",
		"bbw":{"risk":"medium","category":"devops","netAllow":["*.company.internal"],
			"config":[{"key":"gitlab_token","label":"GitLab Token","type":"secret","required":true}]}}`
	return map[string]string{
		manifestDir + "/plugin.json":  manifest,
		"skills/deploy/SKILL.md":      "---\nname: deploy\ndescription: 发版流程\n---\n正文",
		"commands/release.md":         "---\nname: release\n---\n发布清单：$ARGUMENTS",
		"agents/release-verify.md":    "---\nname: release-verify\ndescription: 验收\n---",
		".mcp.json": `{"mcpServers":{
			"deploy":{"command":"node","args":["${PLUGIN_ROOT}/server.js"],"env":{"BBW_USER_ID":"${BBW_USER_ID}"}},
			"bbw-kb":{"url":"https://bbw.company.internal/mcp/kb","headers":{"Authorization":"Bearer ${BBW_USER_TOKEN}"}}}}`,
		"server.js": "// stdio mcp server",
	}
}

func TestValidatePluginPackage_Full(t *testing.T) {
	m, files, err := validatePluginPackage(zipOf(t, fullPlugin(".bbw-plugin")))
	if err != nil {
		t.Fatalf("合法包被拒: %v", err)
	}
	if m.Name != "deploy-helper" || m.Version != "1.2.0" {
		t.Fatalf("快照元数据错: %+v", m)
	}
	if m.Components.Skills != 1 || m.Components.Commands != 1 || m.Components.Agents != 1 || m.Components.McpServers != 2 {
		t.Fatalf("组件统计错: %+v", m.Components)
	}
	if !m.UsesIdentity {
		t.Fatal("usesIdentity 应为 true（${BBW_USER_TOKEN} 在 .mcp.json）")
	}
	if len(m.ConfigKeys) != 1 || m.ConfigKeys[0] != "gitlab_token" {
		t.Fatalf("configKeys 错: %v", m.ConfigKeys)
	}
	if m.Category != "devops" || m.Risk != "medium" || len(m.NetAllow) != 1 {
		t.Fatalf("bbw 扩展块错: %+v", m)
	}
	if len(files) != 5 { // SKILL.md + release.md + agent.md + .mcp.json + plugin.json? 组件文件应含清单外四件
		t.Logf("组件文件清单: %v", files)
	}
}

func TestValidatePluginPackage_ManifestDirFallback(t *testing.T) {
	for _, dir := range []string{".claude-plugin", ".zcode-plugin"} {
		if _, _, err := validatePluginPackage(zipOf(t, fullPlugin(dir))); err != nil {
			t.Fatalf("清单目录 %s 应被识别: %v", dir, err)
		}
	}
}

func TestValidatePluginPackage_TopLevelDir(t *testing.T) {
	src := fullPlugin(".bbw-plugin")
	wrapped := map[string]string{}
	for k, v := range src {
		wrapped["deploy-helper/"+k] = v
	}
	if m, _, err := validatePluginPackage(zipOf(t, wrapped)); err != nil {
		t.Fatalf("顶层单目录形态应被识别: %v", err)
	} else if m.Components.Skills != 1 {
		t.Fatalf("顶层目录下组件统计错: %+v", m.Components)
	}
}

func TestValidatePluginPackage_Rejects(t *testing.T) {
	cases := []struct {
		name string
		pkg  map[string]string
		want string
	}{
		{"缺清单", map[string]string{"skills/deploy/SKILL.md": "x"}, "未找到插件清单"},
		{"坏JSON", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			m[".bbw-plugin/plugin.json"] = "{bad"
			return m
		}(), "plugin.json 解析失败"},
		{"name非法", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			m[".bbw-plugin/plugin.json"] = strings.Replace(m[".bbw-plugin/plugin.json"], "deploy-helper", "Deploy Helper", 1)
			return m
		}(), "name 非法"},
		{"semver非法", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			m[".bbw-plugin/plugin.json"] = strings.Replace(m[".bbw-plugin/plugin.json"], "1.2.0", "1.2", 1)
			return m
		}(), "语义化"},
		{"坏mcpJSON", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			m[".mcp.json"] = "{bad"
			return m
		}(), "MCP 定义解析失败"},
		{"server缺command与url", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			m[".mcp.json"] = `{"mcpServers":{"x":{"args":["a"]}}}`
			return m
		}(), "command（stdio）或 url（HTTP）"},
		{"server名非法", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			m[".mcp.json"] = `{"mcpServers":{"bad name":{"command":"x"}}}`
			return m
		}(), "server 名非法"},
		{"空插件", map[string]string{
			".bbw-plugin/plugin.json": `{"name":"empty-x","version":"0.0.1","description":"空"}`,
		}, "未携带任何组件"},
		{"声明目录缺失", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			delete(m, "skills/deploy/SKILL.md")
			return m
		}(), "skills 目录缺失"},
		{"hooks坏JSON", func() map[string]string {
			m := fullPlugin(".bbw-plugin")
			m["hooks/hooks.json"] = "{bad"
			return m
		}(), "hooks"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := validatePluginPackage(zipOf(t, c.pkg))
			if err == nil {
				t.Fatalf("应被拒绝")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("错误文案不符: want含 %q got %q", c.want, err.Error())
			}
		})
	}
}

func TestValidatePluginPackage_ZipSlip(t *testing.T) {
	// 手工构造含 ../ 条目的 zip（zipOf 正常写法 path.Clean 会保留 ../ 前缀字符串）
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("../evil.sh")
	_, _ = w.Write([]byte("x"))
	w2, _ := zw.Create("deploy/.bbw-plugin/plugin.json")
	_, _ = w2.Write([]byte(`{"name":"x-y","version":"1.0.0","description":"d"}`))
	w3, _ := zw.Create("skills/SKILL.md")
	_, _ = w3.Write([]byte("s"))
	_ = zw.Close()
	if _, _, err := validatePluginPackage(buf.Bytes()); err == nil || !strings.Contains(err.Error(), "zip slip") {
		t.Fatalf("zip slip 应被拒: %v", err)
	}
}

func TestValidatePluginPackage_InlineMcp(t *testing.T) {
	pkg := map[string]string{
		".claude-plugin/plugin.json": `{"name":"inline-mcp","version":"0.1.0","description":"内联",
			"mcpServers":{"api":{"url":"https://x.internal/mcp"}}}`,
	}
	m, _, err := validatePluginPackage(zipOf(t, pkg))
	if err != nil {
		t.Fatalf("内联 mcpServers 应支持: %v", err)
	}
	if m.Components.McpServers != 1 {
		t.Fatalf("内联 server 计数错: %+v", m.Components)
	}
}

// ── 业务闭环（memory repo）──

func newPluginSvc(t *testing.T) *Service {
	t.Helper()
	return New(ecorepo.NewMemory(), ecorepo.NewAppMemory(), ecorepo.NewRolloutMemory(),
		ecorepo.NewSkillMemory(), ecorepo.NewPluginMemory())
}

func TestPluginLifecycle(t *testing.T) {
	svc := newPluginSvc(t)
	ctx := context.Background()
	pkg := zipOf(t, fullPlugin(".bbw-plugin"))

	// 上传（draft）→ 发布
	dto, err := svc.UploadPlugin(ctx, 1, 9, pkg, "首版", PluginPolicyRecommend)
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if dto.Status != "draft" || dto.Manifest == nil || dto.Manifest.Components.McpServers != 2 {
		t.Fatalf("上传后 DTO 错: %+v", dto)
	}
	if err := svc.PublishPluginVersion(ctx, 1, "deploy-helper", "1.2.0"); err != nil {
		t.Fatalf("发布失败: %v", err)
	}

	// catalog：命中 + 组件徽章
	list, err := svc.PluginCatalog(ctx, 1, 7, "", "", "")
	if err != nil || len(list) != 1 {
		t.Fatalf("catalog 应 1 条: %v %d", err, len(list))
	}
	if list[0].CurrentVersion != "1.2.0" || list[0].Installed {
		t.Fatalf("catalog 状态错: %+v", list[0])
	}

	// 检索过滤：q / component
	if l, _ := svc.PluginCatalog(ctx, 1, 7, "发版", "", ""); len(l) != 0 {
		t.Fatal("q=发版 不应命中 deploy-helper")
	}
	if l, _ := svc.PluginCatalog(ctx, 1, 7, "deploy", "", ""); len(l) != 1 {
		t.Fatal("q=deploy 应命中")
	}
	if l, _ := svc.PluginCatalog(ctx, 1, 7, "", "", "agent"); len(l) != 1 {
		t.Fatal("component=agent 应命中（含 agents）")
	}
	if l, _ := svc.PluginCatalog(ctx, 1, 7, "", "", "command"); len(l) != 1 {
		t.Fatal("component=command 应命中")
	}

	// 详情（含版本线）
	e, vers, err := svc.PluginDetail(ctx, 1, 7, "deploy-helper")
	if err != nil || e == nil || len(vers) != 1 {
		t.Fatalf("详情错: %v", err)
	}
	if e.Manifest == nil || !e.Manifest.UsesIdentity {
		t.Fatal("详情应含权限声明（usesIdentity）")
	}

	// 安装 → mine
	ins, err := svc.InstallPlugin(ctx, 1, 7, "deploy-helper", "")
	if err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if ins.Version != "1.2.0" || !strings.Contains(ins.DownloadURL, "download?version=1.2.0") {
		t.Fatalf("安装响应错: %+v", ins)
	}
	mine, _ := svc.MyPlugins(ctx, 1, 7)
	if len(mine) != 1 || !mine[0].Installed || mine[0].HasUpdate {
		t.Fatalf("mine 错: %+v", mine)
	}
	// 他人不受影响
	if l, _ := svc.PluginCatalog(ctx, 1, 8, "", "", ""); l[0].Installed {
		t.Fatal("用户 8 不应有安装态")
	}

	// 下载闭环：包体一致
	got, ver, err := svc.DownloadPlugin(ctx, 1, 7, "deploy-helper", "")
	if err != nil || ver != "1.2.0" || !bytes.Equal(got, pkg) {
		t.Fatalf("下载闭环错: %v", err)
	}

	// 新版本 → hasUpdate
	pkg2 := zipOf(t, fullPlugin(".bbw-plugin")) // 同构造器，改版本号
	files := fullPlugin(".bbw-plugin")
	files[".bbw-plugin/plugin.json"] = strings.Replace(
		files[".bbw-plugin/plugin.json"], "1.2.0", "1.3.0", 1)
	pkg2 = zipOf(t, files)
	if _, err := svc.UploadPlugin(ctx, 1, 9, pkg2, "新版", 0); err != nil {
		t.Fatalf("二版上传失败: %v", err)
	}
	if err := svc.PublishPluginVersion(ctx, 1, "deploy-helper", "1.3.0"); err != nil {
		t.Fatalf("二版发布失败: %v", err)
	}
	mine2, _ := svc.MyPlugins(ctx, 1, 7)
	if !mine2[0].HasUpdate || mine2[0].Version != "1.2.0" {
		t.Fatalf("hasUpdate 应为 true: %+v", mine2[0])
	}

	// 卸载
	if err := svc.UninstallPlugin(ctx, 1, 7, "deploy-helper"); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	if mine3, _ := svc.MyPlugins(ctx, 1, 7); len(mine3) != 0 {
		t.Fatal("卸载后 mine 应空")
	}
}

func TestPluginForceCannotUninstall(t *testing.T) {
	svc := newPluginSvc(t)
	ctx := context.Background()
	if _, err := svc.UploadPlugin(ctx, 1, 9, zipOf(t, fullPlugin(".bbw-plugin")), "", PluginPolicyForce); err != nil {
		t.Fatal(err)
	}
	_ = svc.PublishPluginVersion(ctx, 1, "deploy-helper", "1.2.0")
	if _, err := svc.InstallPlugin(ctx, 1, 7, "deploy-helper", ""); err != nil {
		t.Fatal(err)
	}
	err := svc.UninstallPlugin(ctx, 1, 7, "deploy-helper")
	if err == nil || !strings.Contains(err.Error(), "force") {
		t.Fatalf("force 应拒卸: %v", err)
	}
	// force 置顶
	svc.UploadPlugin(ctx, 1, 9, func() []byte {
		m := map[string]string{
			".bbw-plugin/plugin.json": `{"name":"aaa-optional","version":"1.0.0","description":"x","bbw":{"category":"devops"}}`,
			"skills/x/SKILL.md":       "s",
		}
		return zipOf(t, m)
	}(), "", PluginPolicyOptional)
	_ = svc.PublishPluginVersion(ctx, 1, "aaa-optional", "1.0.0")
	l, _ := svc.PluginCatalog(ctx, 1, 7, "", "", "")
	if len(l) != 2 || l[0].PluginID != "deploy-helper" {
		t.Fatalf("force 应置顶: %+v", l)
	}
}

func TestPluginDelistAndDupVersion(t *testing.T) {
	svc := newPluginSvc(t)
	ctx := context.Background()
	pkg := zipOf(t, fullPlugin(".bbw-plugin"))
	svc.UploadPlugin(ctx, 1, 9, pkg, "", 0)
	_ = svc.PublishPluginVersion(ctx, 1, "deploy-helper", "1.2.0")
	// 同版本重传拒
	if _, err := svc.UploadPlugin(ctx, 1, 9, pkg, "", 0); err == nil || !strings.Contains(err.Error(), "版本已存在") {
		t.Fatalf("同版重传应拒: %v", err)
	}
	// 下架 → catalog 不可见 + 追加版本拒
	if err := svc.DelistPlugin(ctx, 1, "deploy-helper"); err != nil {
		t.Fatal(err)
	}
	if l, _ := svc.PluginCatalog(ctx, 1, 7, "", "", ""); len(l) != 0 {
		t.Fatal("下架后 catalog 应空")
	}
	files := fullPlugin(".bbw-plugin")
	files[".bbw-plugin/plugin.json"] = strings.Replace(files[".bbw-plugin/plugin.json"], "1.2.0", "1.4.0", 1)
	if _, err := svc.UploadPlugin(ctx, 1, 9, zipOf(t, files), "", 0); err == nil || !strings.Contains(err.Error(), "已下架") {
		t.Fatalf("下架后追加版本应拒: %v", err)
	}
}

// manifest 快照 JSON 可序列化（存表列；DTO 展开还原）
func TestPluginManifestJSONRoundtrip(t *testing.T) {
	m, _, err := validatePluginPackage(zipOf(t, fullPlugin(".bbw-plugin")))
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var back PluginManifest
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.Components != m.Components || back.UsesIdentity != m.UsesIdentity || len(back.ConfigKeys) != len(m.ConfigKeys) {
		t.Fatalf("快照往返不一致: %+v vs %+v", back, m)
	}
}

// 方案 A（2026-11-13 拍板）：个人插件可见性/归属/审核流转
func TestPluginPersonalSandbox(t *testing.T) {
	svc := newPluginSvc(t)
	ctx := context.Background()
	// alice(7) 个人上传（draft）
	if _, err := svc.UploadPluginPrivate(ctx, 1, 7, zipOf(t, fullPlugin(".bbw-plugin")), "我的自用"); err != nil {
		t.Fatalf("个人上传失败: %v", err)
	}
	// owner(7) 可见可装（draft 即自用沙盒）；他人(8) 不可见不可装
	l7, _ := svc.PluginCatalog(ctx, 1, 7, "", "", "")
	if len(l7) != 1 || l7[0].OwnerUserID != 7 {
		t.Fatalf("owner 应见个人插件: %+v", l7)
	}
	l8, _ := svc.PluginCatalog(ctx, 1, 8, "", "", "")
	if len(l8) != 0 {
		t.Fatal("他人不应见 draft 个人插件")
	}
	if _, err := svc.InstallPlugin(ctx, 1, 8, "deploy-helper", ""); err == nil {
		t.Fatal("他人装个人插件应拒")
	}
	if _, err := svc.InstallPlugin(ctx, 1, 7, "deploy-helper", ""); err != nil {
		t.Fatalf("owner 装 draft 应过: %v", err)
	}
	if _, _, err := svc.PluginDetail(ctx, 1, 8, "deploy-helper"); err == nil {
		t.Fatal("他人详情应 404")
	}
	// 他人(8) 同名上传 → 拒（plugin_id 占用）
	if _, err := svc.UploadPluginPrivate(ctx, 1, 8, zipOf(t, fullPlugin(".bbw-plugin")), ""); err == nil {
		t.Fatal("他人覆盖个人插件应拒")
	}
	// owner 追加版本 ✓；管理员 publish → 进公共（8 也可见）
	files := fullPlugin(".bbw-plugin")
	files[".bbw-plugin/plugin.json"] = strings.Replace(files[".bbw-plugin/plugin.json"], "1.2.0", "1.3.0", 1)
	if _, err := svc.UploadPluginPrivate(ctx, 1, 7, zipOf(t, files), "v2"); err != nil {
		t.Fatalf("owner 追加版本应过: %v", err)
	}
	if err := svc.PublishPluginVersion(ctx, 1, "deploy-helper", "1.2.0"); err != nil {
		t.Fatalf("审核发布失败: %v", err)
	}
	l8b, _ := svc.PluginCatalog(ctx, 1, 8, "", "", "")
	if len(l8b) != 1 {
		t.Fatalf("审核后他人应见: %+v", l8b)
	}
	// owner 视角不重复（两源去重）
	if l7b, _ := svc.PluginCatalog(ctx, 1, 7, "", "", ""); len(l7b) != 1 {
		t.Fatalf("owner 两源去重失败: %d", len(l7b))
	}
}
