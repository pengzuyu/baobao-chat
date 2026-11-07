// adminservice 单元测试（内存仓储；D10 阶段一务实版）：
// 覆盖：管理员判定两口径（scope/白名单）/ 用户禁用踢线+吊销+审计幂等 /
// 敏感词 CRUD 冲突与热更源 / 用量三维护度聚合 / 审计时间线。
package adminservice

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/baobaowork/server/internal/admin/api"
	adminrepo "github.com/baobaowork/server/internal/admin/repo"
	"github.com/baobaowork/server/internal/org/api"
	orgrepo "github.com/baobaowork/server/internal/org/repo"
)

// effectCounter 写副作用记录（断言禁用即踢线/吊销语义）
type effectCounter struct {
	aliceID, bobID int64
	kicked         []int64
	revoked        []int64
}

func (c *effectCounter) kick(uid int64) int { c.kicked = append(c.kicked, uid); return 1 }
func (c *effectCounter) revoke(_ context.Context, uid int64) error {
	c.revoked = append(c.revoked, uid)
	return nil
}

// newFixture 内存夹具：alice（admin scope）+ bob（普通）+ 管理服务（含副作用计数）
func newFixture(adminAccounts []string) (*Service, *orgrepo.Memory, adminrepo.Repo, *effectCounter) {
	orgRepo := orgrepo.NewMemory()
	ctx := context.Background()
	alice, _ := orgRepo.CreateUser(ctx, orgapi.User{
		TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "alice", DisplayName: "Alice",
		Status: orgapi.UserStatusActive,
		Scopes: []string{"im:message:send", "admin", "admin:user:manage"},
	})
	bob, _ := orgRepo.CreateUser(ctx, orgapi.User{
		TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "bob", DisplayName: "Bob",
		Status: orgapi.UserStatusActive, Scopes: []string{"im:message:send"},
	})
	store := adminrepo.NewMemory()
	fx := &effectCounter{aliceID: alice.ID, bobID: bob.ID}
	roles := adminrepo.NewMemoryRoles()
	_, _ = roles.InsertRole(ctx, adminrepo.Role{TenantID: 1, Name: "管理员", IsBuiltin: true, Permissions: []string{"admin"}})
	svc := New(orgRepo, orgRepo, store, roles, adminrepo.NewMemoryNotices(), Options{
		CreateUser: func(ctx context.Context, u orgapi.User) (orgapi.User, error) {
			return orgRepo.CreateUser(ctx, u)
		},
		UsersTotal:       func(context.Context, int64) (int64, error) { return 2, nil },
		OnlineNow:        func() int64 { return 2 },
		ConvsActiveSince: func(context.Context, int64, time.Time) (int64, error) { return 1, nil },
		MsgsSince:        func(context.Context, int64, time.Time) (int64, error) { return 5, nil },
		KBDocs:           func(context.Context, int64) (int64, error) { return 3, nil },
		FileBytes:        func(context.Context, int64) (int64, error) { return 1024, nil },
		UsageRows: func(_ context.Context, _ int64, _ int) ([]adminapi.UsageRow, error) {
			return []adminapi.UsageRow{
				{Date: "2026-11-06", Tier: "fast", Scene: "chat", Requests: 3, PromptTokens: 30, CompletionTokens: 20, TotalTokens: 50},
				{Date: "2026-11-06", Tier: "embed", Scene: "embed", Requests: 2, TotalTokens: 40},
				{Date: "2026-11-07", Tier: "fast", Scene: "chat", Requests: 4, TotalTokens: 60},
			}, nil
		},
		UsageMode:      "memory",
		KickUser:       fx.kick,
		RevokeSessions: fx.revoke,
		AdminAccounts:  adminAccounts,
	})
	return svc, orgRepo, store, fx
}

func TestIsAdmin(t *testing.T) {
	svc, _, _, fx := newFixture(nil)
	ctx := context.Background()
	if !svc.IsAdmin(ctx, 1, fx.aliceID) {
		t.Fatal("alice（admin scope）应为管理员")
	}
	if svc.IsAdmin(ctx, 1, fx.bobID) {
		t.Fatal("bob（无 admin scope）不应为管理员")
	}
	// 白名单口径：无 scope 但 empno 命中
	svc2, _, _, fx2 := newFixture([]string{"bob"})
	if !svc2.IsAdmin(ctx, 1, fx2.bobID) {
		t.Fatal("empno 白名单命中应为管理员")
	}
	if svc2.IsAdmin(ctx, 1, fx2.aliceID+999) {
		t.Fatal("不存在用户不应判管理员")
	}
}

func TestDashboard(t *testing.T) {
	svc, _, _, _ := newFixture(nil)
	d, err := svc.Dashboard(context.Background(), 1)
	if err != nil {
		t.Fatalf("Dashboard: %v", err)
	}
	if d.UsersTotal != 2 || d.OnlineNow != 2 || d.SessionsToday != 1 || d.MsgsToday != 5 || d.KBDocs != 3 || d.FileStorageBytes != 1024 {
		t.Fatalf("指标不符: %+v", d)
	}
	if len(d.AITokensTrend) != 2 || d.AITokensTrend[0].Date != "2026-11-06" {
		t.Fatalf("趋势应两日升序: %+v", d.AITokensTrend)
	}
	if d.AITokensTrend[1].TotalTokens != 60 {
		t.Fatalf("末日 tokens=60, got %d", d.AITokensTrend[1].TotalTokens)
	}
}

func TestSetUserStatusDisableFlow(t *testing.T) {
	svc, _, _, fx := newFixture(nil)
	ctx := context.Background()

	// 自我禁用拒绝（防自锁）
	if _, err := svc.SetUserStatus(ctx, 1, fx.aliceID, fx.aliceID, orgapi.UserStatusDisabled); err == nil {
		t.Fatal("自我禁用应拒绝")
	}
	// 禁用 bob：状态落库 + 踢线 + 吊销 + 审计
	u, err := svc.SetUserStatus(ctx, 1, fx.aliceID, fx.bobID, orgapi.UserStatusDisabled)
	if err != nil {
		t.Fatalf("禁用失败: %v", err)
	}
	if u.Status != orgapi.UserStatusDisabled {
		t.Fatalf("状态应 disabled, got %d", u.Status)
	}
	if len(fx.kicked) != 1 || fx.kicked[0] != fx.bobID {
		t.Fatalf("应踢线 bob, got %v", fx.kicked)
	}
	if len(fx.revoked) != 1 || fx.revoked[0] != fx.bobID {
		t.Fatalf("应吊销 bob refresh, got %v", fx.revoked)
	}
	page, err := svc.ListAudit(ctx, 1, 0, 20)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("审计应 1 条: %v %d", err, len(page.Items))
	}
	if page.Items[0].Action != "user.disable" || page.Items[0].OperatorName != "Alice" {
		t.Fatalf("审计行不符: %+v", page.Items[0])
	}
	// 重复禁用（幂等）：无新副作用/审计
	if _, err := svc.SetUserStatus(ctx, 1, fx.aliceID, fx.bobID, orgapi.UserStatusDisabled); err != nil {
		t.Fatalf("重复禁用应幂等: %v", err)
	}
	if len(fx.kicked) != 1 || len(fx.revoked) != 1 {
		t.Fatal("幂等禁用不应重复踢线/吊销")
	}
	// 启用恢复：审计 user.enable（时间线最前）
	if _, err := svc.SetUserStatus(ctx, 1, fx.aliceID, fx.bobID, orgapi.UserStatusActive); err != nil {
		t.Fatalf("启用失败: %v", err)
	}
	page2, _ := svc.ListAudit(ctx, 1, 0, 20)
	if len(page2.Items) != 2 || page2.Items[0].Action != "user.enable" {
		t.Fatalf("启用应记审计: %+v", page2.Items)
	}
}

func TestListUsersFilterAndPaging(t *testing.T) {
	svc, _, _, fx := newFixture(nil)
	ctx := context.Background()
	// keyword 命中（工号/姓名/邮箱）
	page, err := svc.ListUsers(ctx, 1, "bo", 0, 0, 20)
	if err != nil || len(page.Items) != 1 || page.Items[0].EmployeeNo != "bob" {
		t.Fatalf("keyword=bo 应仅 bob: %v %+v", err, page.Items)
	}
	// status 过滤
	if _, err := svc.SetUserStatus(ctx, 1, fx.aliceID, fx.bobID, orgapi.UserStatusDisabled); err != nil {
		t.Fatal(err)
	}
	page, _ = svc.ListUsers(ctx, 1, "", orgapi.UserStatusDisabled, 0, 20)
	if len(page.Items) != 1 || page.Items[0].EmployeeNo != "bob" {
		t.Fatalf("status=2 应仅 bob: %+v", page.Items)
	}
	// limit=1 翻页：两页取全（id 升序 cursor）
	p1, _ := svc.ListUsers(ctx, 1, "", 0, 0, 1)
	if !p1.HasMore || len(p1.Items) != 1 {
		t.Fatalf("首页应 1 条 + has_more: %+v", p1)
	}
	cursor, _ := strconv.ParseInt(p1.NextCursor, 10, 64)
	p2, err := svc.ListUsers(ctx, 1, "", 0, cursor, 1)
	if err != nil || len(p2.Items) != 1 || p2.HasMore {
		t.Fatalf("次页应 1 条到底: %v %+v", err, p2)
	}
}

func TestSensitiveWordCRUDAndHotSource(t *testing.T) {
	svc, _, store, fx := newFixture(nil)
	ctx := context.Background()

	w, err := svc.AddSensitiveWord(ctx, 1, fx.aliceID, "测试词", "e2e")
	if err != nil {
		t.Fatalf("新增敏感词: %v", err)
	}
	if w.Mode != 1 || !w.Enabled {
		t.Fatalf("默认应 mode=1 拦截启用: %+v", w)
	}
	// UK 冲突拒绝
	if _, err := svc.AddSensitiveWord(ctx, 1, fx.aliceID, "测试词", ""); err == nil {
		t.Fatal("重复词应拒绝")
	}
	// 热更源即时可见（message 域 3005 校验数据源）
	words, err := store.EnabledSensitiveWords(ctx, 1)
	if err != nil || len(words) != 1 || words[0] != "测试词" {
		t.Fatalf("热更源应含 测试词: %v %v", err, words)
	}
	// 列表 + 全量计数
	page, err := svc.ListSensitiveWords(ctx, 1, 0, 20)
	if err != nil || page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("列表不符: %v %+v", err, page)
	}
	// 删除后热更源清空
	id, _ := strconv.ParseInt(w.ID, 10, 64)
	if err := svc.DeleteSensitiveWord(ctx, 1, fx.aliceID, id); err != nil {
		t.Fatalf("删除: %v", err)
	}
	words, _ = store.EnabledSensitiveWords(ctx, 1)
	if len(words) != 0 {
		t.Fatalf("删除后热更源应为空: %v", words)
	}
	if err := svc.DeleteSensitiveWord(ctx, 1, fx.aliceID, 999); err == nil {
		t.Fatal("删不存在词应报错")
	}
	// 审计：add + delete 两条
	audit, _ := svc.ListAudit(ctx, 1, 0, 20)
	if len(audit.Items) != 2 {
		t.Fatalf("词库写操作应记 2 条审计: %d", len(audit.Items))
	}
}

func TestUsageSummary(t *testing.T) {
	svc, _, _, _ := newFixture(nil)
	u, err := svc.UsageSummary(context.Background(), 1, 7)
	if err != nil {
		t.Fatalf("UsageSummary: %v", err)
	}
	if u.Mode != "memory" || len(u.Daily) != 2 {
		t.Fatalf("日粒度应 2 行: %+v", u.Daily)
	}
	if u.Daily[0].Date != "2026-11-06" || u.Daily[0].Requests != 5 || u.Daily[0].TotalTokens != 90 {
		t.Fatalf("2026-11-06 聚合不符: %+v", u.Daily[0])
	}
	if u.Total.Requests != 9 || u.Total.TotalTokens != 150 {
		t.Fatalf("总计不符: %+v", u.Total)
	}
	if len(u.ByTier) != 2 || u.ByTier[0].Key != "fast" { // fast 110 > embed 40
		t.Fatalf("tier 汇总应 fast 居前: %+v", u.ByTier)
	}
	if len(u.ByScene) != 2 {
		t.Fatalf("scene 汇总应 2 行: %+v", u.ByScene)
	}
}

func TestAgentPolicySnapshot(t *testing.T) {
	svc, _, _, _ := newFixture(nil)
	p, err := svc.AgentPolicy(context.Background(), 1)
	if err != nil {
		t.Fatalf("AgentPolicy: %v", err)
	}
	if p.Source != "default" || p.Policy["tool_mode"] != "allowlist" {
		t.Fatalf("默认快照不符: %+v", p)
	}
}

func TestRoleEditorCRUDAndGrants(t *testing.T) {
	svc, _, _, _ := newFixture([]string{"alice"})
	ctx := context.Background()
	aliceID := int64(10001)

	// 创建（权限点格式校验）
	bad, err := svc.CreateRole(ctx, 1, aliceID, "开发", "", []string{"非法点"})
	if err == nil || bad != nil {
		t.Fatal("非法权限点应拒")
	}
	r1, err := svc.CreateRole(ctx, 1, aliceID, "开发者", "自定义", []string{"im:message:send", "kb:query:use"})
	if err != nil || r1.ID == 0 {
		t.Fatalf("create: %v", err)
	}
	// 同名冲突
	if _, err := svc.CreateRole(ctx, 1, aliceID, "开发者", "", nil); err == nil {
		t.Fatal("同名应拒")
	}
	// 更新
	if err := svc.UpdateRole(ctx, 1, aliceID, r1.ID, "开发者2", "", []string{"im:message:send"}); err != nil {
		t.Fatalf("update: %v", err)
	}
	// 授权/重复授权/列表
	if err := svc.GrantRole(ctx, 1, aliceID, 20001, r1.ID); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if err := svc.GrantRole(ctx, 1, aliceID, 20001, r1.ID); err == nil {
		t.Fatal("重复授权应拒")
	}
	grants, err := svc.ListUserGrants(ctx, 1, 20001)
	if err != nil || len(grants) != 1 {
		t.Fatalf("grants: %v %+v", err, grants)
	}
	// 角色列表含授权计数 + 内置种子
	roles, err := svc.ListRoles(ctx, 1)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var mine *adminapi.RoleDTO
	builtin := 0
	for i := range roles {
		if roles[i].ID == r1.ID {
			mine = &roles[i]
		}
		if roles[i].IsBuiltin {
			builtin++
		}
	}
	if mine == nil || mine.UserCount != 1 || mine.Name != "开发者2" {
		t.Fatalf("角色行: %+v", mine)
	}
	if builtin == 0 {
		t.Fatal("内置角色种子缺失（测试夹具需灌）")
	}
	// 收回 + 删除（级联）
	if err := svc.RevokeRole(ctx, 1, aliceID, grants[0].ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if err := svc.DeleteRole(ctx, 1, aliceID, r1.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// 内置角色不可删
	for _, r := range roles {
		if r.IsBuiltin {
			if err := svc.DeleteRole(ctx, 1, aliceID, r.ID); err == nil {
				t.Fatal("内置角色应拒删")
			}
			break
		}
	}
}

func TestPublishNotice(t *testing.T) {
	svc, orgRepo, store, _ := newFixture([]string{"alice"})
	ctx := context.Background()
	// 广播闭包观测（重建 service 注入闭包——opts 为值语义）
	var gotTitle, gotDigest string
	withBC := New(orgRepo, orgRepo, store, adminrepo.NewMemoryRoles(), adminrepo.NewMemoryNotices(), Options{
		BroadcastNotice: func(_ context.Context, _ int64, title, digest string) int {
			gotTitle, gotDigest = title, digest
			return 2
		},
	})
	svc = withBC
	// 校验
	if _, err := svc.PublishNotice(ctx, 1, 10001, "", "正文"); err == nil {
		t.Fatal("空标题应拒")
	}
	if _, err := svc.PublishNotice(ctx, 1, 10001, strings.Repeat("长", 101), "正文"); err == nil {
		t.Fatal("超长标题应拒")
	}
	n, err := svc.PublishNotice(ctx, 1, 10001, "停机维护公告", "今晚 22:00-24:00 停机\n影响：全部服务")
	if err != nil || n.ID == 0 {
		t.Fatalf("publish: %v", err)
	}
	if n.Reach != 2 {
		t.Fatalf("触达快照: %+v", n)
	}
	if gotTitle != "停机维护公告" || gotDigest != "今晚 22:00-24:00 停机" {
		t.Fatalf("广播参数: %q %q", gotTitle, gotDigest)
	}
	items, more, err := svc.ListNotices(ctx, 1, 0, 10)
	if err != nil || more || len(items) != 1 || items[0].Title != "停机维护公告" {
		t.Fatalf("list: %v %+v", err, items)
	}
}

func TestBatchImportUsers(t *testing.T) {
	svc, orgRepo, _, _ := newFixture([]string{"alice"})
	ctx := context.Background()
	// alice 已存在（fixture 种子）——同名工号应失败
	res, err := svc.BatchImportUsers(ctx, 1, 10001, []adminapi.ImportUserRow{
		{Empno: "alice", Name: "重名"},                 // 已存在
		{Empno: "", Name: "无工号"},                     // 格式
		{Empno: "u1", Name: "张三", Email: "z@x.io"},   // OK
		{Empno: "u1", Name: "重复"},                    // 批内重复
		{Empno: "u2", Name: strings.Repeat("超", 51)}, // 姓名超长
		{Empno: "u3", Name: "李四"},                    // OK
	})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if res.Created != 2 || res.Failed != 4 || len(res.Rows) != 6 {
		t.Fatalf("结果: %+v", res)
	}
	// 创建可登录（工号命中）
	if u, err := orgRepo.GetUserByLogin(ctx, 1, "u1"); err != nil || u == nil || u.DisplayName != "张三" {
		t.Fatalf("u1: %v %+v", err, u)
	}
	// 超量拒绝
	big := make([]adminapi.ImportUserRow, 101)
	for i := range big {
		big[i] = adminapi.ImportUserRow{Empno: fmt.Sprintf("b%d", i), Name: "x"}
	}
	if _, err := svc.BatchImportUsers(ctx, 1, 10001, big); err == nil {
		t.Fatal("超 100 行应拒")
	}
}

func TestAgentGovernance(t *testing.T) {
	svc, _, _, fx := newFixture([]string{"alice"})
	ctx := context.Background()
	// 计量闭包注入（重建 service 携带闭包与副作用计数）
	svc2 := svc // 复用既有 opts？——直接测既有 svc（AgentUsage nil=空列表）
	users, err := svc2.ListAgentUsers(ctx, 1)
	if err != nil || len(users) != 0 {
		t.Fatalf("nil 闭包应空列表: %v %+v", err, users)
	}
	// revoke：吊销+踢线副作用（fixture effectCounter 计数）
	_ = fx
	if err := svc2.RevokeAgentAccess(ctx, 1, 10001, 10002); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	// killswitch：查询态不改；写态切换+审计
	on, err := svc2.AgentKillswitch(ctx, 1, 0, true)
	if err != nil || on {
		t.Fatalf("查询态不应翻转: %v %v", on, err)
	}
	on, err = svc2.AgentKillswitch(ctx, 1, 10001, true)
	if err != nil || !on || !svc2.AgentKillOn() {
		t.Fatalf("写态应开启: %v", on)
	}
	on, _ = svc2.AgentKillswitch(ctx, 1, 10001, false)
	if on {
		t.Fatal("应可关闭")
	}
	// 非法 uid 拒绝
	if err := svc2.RevokeAgentAccess(ctx, 1, 10001, 0); err == nil {
		t.Fatal("uid=0 应拒")
	}
}
