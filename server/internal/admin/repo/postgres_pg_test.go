//go:build pg

// PG 集成冒烟（build tag `pg`，默认 go test 不编译）。
//
//	本地：BBW_PG_TEST_DSN='postgres://bbw:...@127.0.0.1:5432/bbw?sslmode=disable' \
//	      go test -tags pg ./internal/admin/repo/ -run TestPGAdmin -v
//
// 覆盖：迁移 0010 admin_audit_action 落库/分页、敏感词 CRUD（0006 表 + UK 冲突 +
// 热更源缓存失效）、UsageRows 聚合（ai_usage_hourly）。未设置 BBW_PG_TEST_DSN 即 skip。
package adminrepo

import (
	"context"
	"os"
	"testing"
	"time"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

func TestPGAdminSmoke(t *testing.T) {
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
		t.Fatalf("迁移（应含 0010 admin_audit_action）: %v", err)
	}
	r := NewPostgres(pool)
	ur := r.(UsageReader) // PG 实现附带 ai_usage_hourly 聚合（UsageReader 可选接口）

	// 数据隔离：每轮专用的 operator/词，结束清理（词 UK 带纳秒后缀防历史行干扰）
	op := int64(910000000) + time.Now().UnixNano()%1_000_000
	word := "测试词-" + time.Now().Format("150405.000000000")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM sensitive_word WHERE created_by=$1`, op)
		_, _ = pool.Exec(context.Background(), `DELETE FROM admin_audit_action WHERE operator_id=$1`, op)
	})

	// ── ① 审计：追加 + 倒序分页 ──
	a1, err := r.InsertAudit(ctx, AuditAction{
		TenantID: 1, OperatorID: op, Action: "user.disable", Target: "user:10002",
		Detail: []byte(`{"kicked_conns":1}`),
	})
	if err != nil {
		t.Fatalf("InsertAudit: %v", err)
	}
	a2, err := r.InsertAudit(ctx, AuditAction{
		TenantID: 1, OperatorID: op, Action: "policy.sensitive_word.add", Target: "sensitive_word:1",
	})
	if err != nil {
		t.Fatalf("InsertAudit 2: %v", err)
	}
	if a2.ID <= a1.ID {
		t.Fatalf("advisory lock 9114 分配应递增: %d %d", a1.ID, a2.ID)
	}
	items, hasMore, err := r.ListAudit(ctx, 1, 0, 1)
	if err != nil || len(items) != 1 || !hasMore {
		t.Fatalf("ListAudit 首页应 1 条+has_more: %v %d %v", err, len(items), hasMore)
	}
	if items[0].ID != a2.ID { // id 倒序：最新在前
		t.Fatalf("倒序不符: want %d got %d", a2.ID, items[0].ID)
	}
	page2, _, err := r.ListAudit(ctx, 1, items[0].ID, 10)
	if err != nil || len(page2) == 0 {
		t.Fatalf("cursor 次页应有历史行: %v %d", err, len(page2))
	}

	// ── ② 敏感词：新增 → UK 冲突 → 热更源 → 删除 ──
	w, err := r.InsertSensitiveWord(ctx, SensitiveWord{
		TenantID: 1, Word: word, Mode: 1, Enabled: true, CreatedBy: op,
	})
	if err != nil {
		t.Fatalf("InsertSensitiveWord: %v", err)
	}
	if _, err := r.InsertSensitiveWord(ctx, SensitiveWord{
		TenantID: 1, Word: word, Mode: 1, Enabled: true, CreatedBy: op,
	}); err != ErrDupWord {
		t.Fatalf("UK 冲突应 ErrDupWord: %v", err)
	}
	words, err := r.EnabledSensitiveWords(ctx, 1)
	if err != nil {
		t.Fatalf("EnabledSensitiveWords: %v", err)
	}
	found := false
	for _, x := range words {
		if x == word {
			found = true
		}
	}
	if !found {
		t.Fatalf("热更源缓存应含新词 %q: %v", word, words)
	}
	n, err := r.CountSensitiveWords(ctx, 1)
	if err != nil || n < 1 {
		t.Fatalf("CountSensitiveWords: %v %d", err, n)
	}
	if err := r.DeleteSensitiveWord(ctx, 1, w.ID); err != nil {
		t.Fatalf("DeleteSensitiveWord: %v", err)
	}
	if err := r.DeleteSensitiveWord(ctx, 1, w.ID); err != ErrWordNotFound {
		t.Fatalf("重复删除应 ErrWordNotFound: %v", err)
	}
	// 删除后缓存失效（热更源不再含词）
	words2, _ := r.EnabledSensitiveWords(ctx, 1)
	for _, x := range words2 {
		if x == word {
			t.Fatal("删除后热更源仍含旧词（缓存未失效）")
		}
	}

	// ── ③ 用量聚合（ai_usage_hourly；行不存在也应空结果而非报错）──
	rows, err := ur.UsageRows(ctx, 1, 7)
	if err != nil {
		t.Fatalf("UsageRows: %v", err)
	}
	t.Logf("ai_usage_hourly 近 7 日聚合行数=%d", len(rows))

	// ── ④ RLS：app.tenant 会话变量兜底下（bbwpg.AfterConnect SET app.tenant=1）
	// 跨租户行（tenant=2 手工插入）不可见 ──
	_, _ = pool.Exec(ctx, `INSERT INTO admin_audit_action (id, tenant_id, operator_id, action)
		VALUES ($1, 2, $2, 'cross.tenant.probe')`, time.Now().UnixNano(), op)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM admin_audit_action WHERE tenant_id=2 AND operator_id=$1`, op)
	})
	probe, _, err := r.ListAudit(ctx, 1, 0, 100)
	if err != nil {
		t.Fatalf("RLS 探测查询: %v", err)
	}
	for _, it := range probe {
		if it.TenantID != 1 {
			t.Fatalf("RLS 失效：查询到跨租户行 tenant=%d", it.TenantID)
		}
	}
}

// TestPGRolePermPoints RBAC 阶段二 PG 路径：role/user_role 落库 + 权限点聚合并集
func TestPGRolePermPoints(t *testing.T) {
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
		t.Fatalf("迁移: %v", err)
	}
	roles := NewPostgresRoles(pool)

	uid := int64(920000000) + time.Now().UnixNano()%1_000_000
	r1, err := roles.InsertRole(ctx, Role{TenantID: 1,
		Name:        "pg-test-hr-" + time.Now().Format("150405.000000000"),
		Permissions: []string{"admin:user:manage", "im:message:send"}})
	if err != nil {
		t.Fatalf("InsertRole: %v", err)
	}
	r2, err := roles.InsertRole(ctx, Role{TenantID: 1,
		Name:        "pg-test-audit-" + time.Now().Format("150405.000000000"),
		Permissions: []string{"admin:audit:read"}})
	if err != nil {
		t.Fatalf("InsertRole 2: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM user_role WHERE user_id=$1`, uid)
		_, _ = pool.Exec(context.Background(), `DELETE FROM role WHERE id IN ($1,$2)`, r1.ID, r2.ID)
	})

	if err := roles.InsertUserRole(ctx, UserRole{TenantID: 1, UserID: uid, RoleID: r1.ID}); err != nil {
		t.Fatalf("InsertUserRole: %v", err)
	}
	if err := roles.InsertUserRole(ctx, UserRole{TenantID: 1, UserID: uid, RoleID: r2.ID}); err != nil {
		t.Fatalf("InsertUserRole 2: %v", err)
	}
	if err := roles.InsertUserRole(ctx, UserRole{TenantID: 1, UserID: uid, RoleID: r1.ID}); err != ErrDupGrant {
		t.Fatalf("重复授权应 ErrDupGrant: %v", err)
	}

	pts, err := roles.PermissionPointsOf(ctx, 1, uid)
	if err != nil {
		t.Fatalf("PermissionPointsOf: %v", err)
	}
	got := map[string]bool{}
	for _, p := range pts {
		got[p] = true
	}
	for _, want := range []string{"admin:user:manage", "admin:audit:read", "im:message:send"} {
		if !got[want] {
			t.Fatalf("聚合缺 %q: %v", want, pts)
		}
	}

	// GetUserRole / UserIDsOfRole（推送定位路径）
	grants, err := roles.ListUserRoles(ctx, 1, uid)
	if err != nil || len(grants) != 2 {
		t.Fatalf("ListUserRoles: %v %d", err, len(grants))
	}
	g1, err := roles.GetUserRole(ctx, 1, grants[0].ID)
	if err != nil || g1.UserID != uid {
		t.Fatalf("GetUserRole: %v %+v", err, g1)
	}
	ids, err := roles.UserIDsOfRole(ctx, 1, r1.ID)
	if err != nil || len(ids) != 1 || ids[0] != uid {
		t.Fatalf("UserIDsOfRole: %v %v", err, ids)
	}

	// 收回后聚合即时收敛
	if err := roles.DeleteUserRole(ctx, 1, grants[0].ID); err != nil {
		t.Fatalf("DeleteUserRole: %v", err)
	}
	pts2, _ := roles.PermissionPointsOf(ctx, 1, uid)
	for _, p := range pts2 {
		if p == "admin:user:manage" && grants[0].RoleID == r1.ID {
			t.Fatalf("收回后不应再含该角色权限点: %v", pts2)
		}
	}
}
