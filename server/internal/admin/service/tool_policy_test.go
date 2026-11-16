// Agent 工具策略测试（D7）：upsert 行覆盖合成/回落默认/subject 校验。
package adminservice

import (
	"context"
	"testing"

	adminapi "github.com/baobaochat/server/internal/admin/api"
	adminrepo "github.com/baobaochat/server/internal/admin/repo"
	orgrepo "github.com/baobaochat/server/internal/org/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

func TestAgentToolPolicy(t *testing.T) {
	ctx := context.Background()
	tp := adminrepo.NewToolPolicyMemory()
	// 复用主 fixture 的 org repo 形态（users reader 最小可用）
	orgRepo := orgrepo.NewMemory()
	svc := New(orgRepo, orgRepo, adminrepo.NewMemory(), nil, adminrepo.NewMemoryNotices(), tp, Options{})

	// 初始：默认快照（source=default，无 rows）
	snap, err := svc.AgentPolicy(ctx, 1)
	if err != nil || snap.Source != "default" || snap.Rows != nil {
		t.Fatalf("初始应 default: %v %+v", err, snap)
	}

	// upsert：禁 shell_exec → source=table，builtin_tools.shell_exec=false
	off := false
	snap, err = svc.UpdateAgentToolPolicy(ctx, 1, 42, adminapi.AgentToolPolicyReq{
		Subject: "shell_exec", Allowed: &off,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if snap.Source != "table" || len(snap.Rows) != 1 {
		t.Fatalf("快照应切 table: %+v", snap)
	}
	builtin, _ := snap.Policy["builtin_tools"].(map[string]bool)
	if builtin["shell_exec"] || builtin["fs_read"] != true {
		t.Fatalf("覆盖不符（shell_exec 应 false，fs_read 保持 true）: %v", builtin)
	}

	// risk_override 合成：{"git_push":"auto"} 进 policy.risk_override
	on := true
	snap, err = svc.UpdateAgentToolPolicy(ctx, 1, 42, adminapi.AgentToolPolicyReq{
		Subject: "git_push", Allowed: &on, RiskOverride: `{"git_push":"auto"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	risk, _ := snap.Policy["risk_override"].(map[string]any)
	if risk["git_push"] != "auto" {
		t.Fatalf("risk_override 合成不符: %v", risk)
	}

	// app 命名空间行进 app_namespace_tools
	snap, err = svc.UpdateAgentToolPolicy(ctx, 1, 42, adminapi.AgentToolPolicyReq{
		Subject: "app:crm:*", Allowed: &on,
	})
	if err != nil {
		t.Fatal(err)
	}
	appNS, _ := snap.Policy["app_namespace_tools"].(map[string]bool)
	if appNS["app:crm:*"] != true {
		t.Fatalf("app 命名空间行不符: %v", appNS)
	}

	// subject 非法字符 → 9001
	snap, err = svc.UpdateAgentToolPolicy(ctx, 1, 42, adminapi.AgentToolPolicyReq{Subject: "bad subject!", Allowed: &on})
	if errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("非法 subject 应 9001: %v", err)
	}
	// risk_override 非 JSON → 9001
	snap, err = svc.UpdateAgentToolPolicy(ctx, 1, 42, adminapi.AgentToolPolicyReq{Subject: "fs_read", Allowed: &on, RiskOverride: "not-json"})
	if errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("非法 risk_override 应 9001: %v", err)
	}

	// 删行：回落默认（shell_exec 行删除后该键回默认 false；全删尽 source=default）
	snap, err = svc.DeleteAgentToolPolicy(ctx, 1, "shell_exec")
	if err != nil || snap.Source != "table" {
		t.Fatalf("删一行后仍应 table（余两行）: %v %+v", err, snap)
	}
	for _, s := range []string{"git_push", "app:crm:*"} {
		if _, err := svc.DeleteAgentToolPolicy(ctx, 1, s); err != nil {
			t.Fatalf("删 %s: %v", s, err)
		}
	}
	snap, err = svc.AgentPolicy(ctx, 1)
	if err != nil || snap.Source != "default" {
		t.Fatalf("全删尽应回 default: %v %+v", err, snap)
	}
	// 删不存在 → 9002
	if _, err := svc.DeleteAgentToolPolicy(ctx, 1, "ghost"); errx.From(err).Code != errx.CodeNotFound {
		t.Fatalf("删不存在应 9002: %v", err)
	}
}
