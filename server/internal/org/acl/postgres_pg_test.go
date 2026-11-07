//go:build pg

// resource_acl PG 仓储冒烟（build tag `pg`，默认不编译；mail 域同款）。
//
//	BBW_PG_TEST_DSN='postgres://bbw:...@127.0.0.1:5432/bbw?sslmode=disable' \
//	  go test -tags pg ./internal/org/acl/ -run TestPGACLSmoke -v
package acl

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

func TestPGACLSmoke(t *testing.T) {
	dsn := os.Getenv("BBW_PG_TEST_DSN")
	if dsn == "" {
		t.Skip("BBW_PG_TEST_DSN 未设置，跳过 PG 集成测试")
	}
	ctx := context.Background()
	pool, err := bbwpg.New(ctx, dsn)
	if err != nil {
		t.Fatalf("建池: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := bbwpg.Migrate(ctx, pool); err != nil {
		t.Fatalf("迁移（应含 0017 resource_acl）: %v", err)
	}
	sfx := strconv.FormatInt(time.Now().UnixNano(), 10)
	resID := "pgsmoke-" + sfx
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM resource_acl WHERE resource_id=$1`, resID)
	})

	r := NewPostgres(pool)
	svc := New(r, ResolveOptions{
		RoleIDsOf: func(_, uid int64) []int64 {
			if uid == 61003 {
				return []int64{617}
			}
			return nil
		},
	})

	// 授权三条：user owner / role editor / tenant viewer
	if _, err := svc.Grant(ctx, Entry{
		TenantID: 1, ResourceType: "kb.space", ResourceID: resID,
		GrantType: GrantUser, GrantTarget: 61001, Perm: PermOwner,
	}); err != nil {
		t.Fatalf("user 授权: %v", err)
	}
	if _, err := svc.Grant(ctx, Entry{
		TenantID: 1, ResourceType: "kb.space", ResourceID: resID,
		GrantType: GrantRole, GrantTarget: 617, Perm: PermEditor,
	}); err != nil {
		t.Fatalf("role 授权: %v", err)
	}
	if _, err := svc.Grant(ctx, Entry{
		TenantID: 1, ResourceType: "kb.space", ResourceID: resID,
		GrantType: GrantTenant, Perm: PermViewer,
	}); err != nil {
		t.Fatalf("tenant 授权: %v", err)
	}
	// 幂等覆盖
	if _, err := svc.Grant(ctx, Entry{
		TenantID: 1, ResourceType: "kb.space", ResourceID: resID,
		GrantType: GrantUser, GrantTarget: 61001, Perm: PermCommenter,
	}); err != nil {
		t.Fatalf("覆盖授权: %v", err)
	}

	// 判定：owner 降档后 commenter / role editor / 公开 viewer
	if p := svc.Resolve(ctx, 1, "kb.space", resID, 61001); p != PermCommenter {
		t.Fatalf("覆盖后应 commenter：%d", p)
	}
	if p := svc.Resolve(ctx, 1, "kb.space", resID, 61003); p != PermEditor {
		t.Fatalf("role 授权应 editor：%d", p)
	}
	if p := svc.Resolve(ctx, 1, "kb.space", resID, 61999); p != PermViewer {
		t.Fatalf("公开应 viewer：%d", p)
	}

	// 过期授权
	future := time.Now().Add(time.Hour)
	if _, err := svc.Grant(ctx, Entry{
		TenantID: 1, ResourceType: "kb.space", ResourceID: resID,
		GrantType: GrantUser, GrantTarget: 61005, Perm: PermEditor, ExpiresAt: future,
	}); err != nil {
		t.Fatal(err)
	}
	if p := svc.Resolve(ctx, 1, "kb.space", resID, 61005); p != PermEditor {
		t.Fatalf("未过期应 editor：%d", p)
	}
	// 直接置过期再判：61005 过期后回落 tenant 公开 viewer（取最大语义）
	if _, err := pool.Exec(ctx,
		`UPDATE resource_acl SET expires_at=now()-interval '1 hour'
		 WHERE grant_type=1 AND grant_target=$1 AND resource_id=$2`, 61005, resID); err != nil {
		t.Fatal(err)
	}
	if p := svc.Resolve(ctx, 1, "kb.space", resID, 61005); p != PermViewer {
		t.Fatalf("过期应回落公开 viewer：%d", p)
	}
	// 无公开资源上过期=none（干净路径）
	resOnly := "pgsmoke-only-" + sfx
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM resource_acl WHERE resource_id=$1`, resOnly)
	})
	if _, err := svc.Grant(ctx, Entry{
		TenantID: 1, ResourceType: "kb.space", ResourceID: resOnly,
		GrantType: GrantUser, GrantTarget: 61006, Perm: PermEditor,
		ExpiresAt: time.Now().Add(-time.Minute),
	}); err == nil {
		t.Fatal("过去时间应被 Grant 拒绝（护栏）")
	}
	if _, err := r.Grant(ctx, Entry{ // 直写仓储绕护栏构造过期行
		TenantID: 1, ResourceType: "kb.space", ResourceID: resOnly,
		GrantType: GrantUser, GrantTarget: 61006, Perm: PermEditor,
		ExpiresAt: time.Now().Add(-time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if p := svc.Resolve(ctx, 1, "kb.space", resOnly, 61006); p != PermNone {
		t.Fatalf("无公开资源过期应 none：%d", p)
	}

	// 清单 + 撤销
	list, err := svc.ListGrants(ctx, 1, EntryFilter{ResourceType: "kb.space", ResourceID: resID})
	if err != nil || len(list) != 4 {
		t.Fatalf("清单：%v %d", err, len(list))
	}
	if err := svc.Revoke(ctx, 1, list[0].ID); err != nil {
		t.Fatalf("撤销: %v", err)
	}
	if err := svc.Revoke(ctx, 1, list[0].ID); err != ErrNotFound {
		t.Fatalf("重复撤销: %v", err)
	}
}
