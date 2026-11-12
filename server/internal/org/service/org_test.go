// orgservice 单元测试：部门归属读（kb 三层知识检索消费的链路解析）。
package orgservice

import (
	"context"
	"testing"

	"github.com/baobaowork/server/internal/org/api"
	orgrepo "github.com/baobaowork/server/internal/org/repo"
)

// TestUserDeptChainOf 祖先链解析：直接 ∪ 各部门祖先链（深度无关）、
// 多部门取并集、未挂用户空集
func TestUserDeptChainOf(t *testing.T) {
	r := orgrepo.NewMemory()
	svc := New(r)
	ctx := context.Background()

	root, err := r.CreateDept(ctx, 1, 0, "集团", 0)
	if err != nil {
		t.Fatal(err)
	}
	rd, err := r.CreateDept(ctx, 1, root.ID, "研发中心", 0)
	if err != nil {
		t.Fatal(err)
	}
	be, err := r.CreateDept(ctx, 1, rd.ID, "后端部", 0)
	if err != nil {
		t.Fatal(err)
	}
	inf, err := r.CreateDept(ctx, 1, be.ID, "基础架构组", 0)
	if err != nil {
		t.Fatal(err)
	}
	mkt, err := r.CreateDept(ctx, 1, root.ID, "市场部", 0)
	if err != nil {
		t.Fatal(err)
	}

	// 用户 10001：深层部门（主）+ 兄弟部门（次）——并集语义
	if err := r.AttachUser(ctx, 1, 10001, inf.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := r.AttachUser(ctx, 1, 10001, mkt.ID, false); err != nil {
		t.Fatal(err)
	}

	ids, primary, err := svc.UserDeptIDsOf(ctx, 1, 10001)
	if err != nil || !ids[inf.ID] || !ids[mkt.ID] || primary != inf.ID {
		t.Fatalf("直接部门集/主部门: ids=%v primary=%d err=%v", ids, primary, err)
	}

	chain, err := svc.UserDeptChainOf(ctx, 1, 10001)
	if err != nil {
		t.Fatal(err)
	}
	// 期望：基础架构组+后端部+研发中心+集团（深层向上全链）∪ 市场部
	want := map[int64]bool{inf.ID: true, be.ID: true, rd.ID: true, root.ID: true, mkt.ID: true}
	if len(chain) != len(want) {
		t.Fatalf("链集不符: %v（期望 %v）", chain, want)
	}
	for d := range want {
		if !chain[d] {
			t.Fatalf("链缺 %d: %v", d, chain)
		}
	}

	// 未挂部门用户：空集（kb 侧回落 OwnerID 兜底）
	chain2, err := svc.UserDeptChainOf(ctx, 1, 99999)
	if err != nil || len(chain2) != 0 {
		t.Fatalf("未挂用户应空集: %v %v", chain2, err)
	}
}

// TestUserDirectorySearch 登录页搜人：拼音/首字母/工号/姓名四路模糊 + 工号升序
// cursor 翻页（含搜索态翻页叠加）+ 组织路径（主部门链路名）+ 禁用账号排除
func TestUserDirectorySearch(t *testing.T) {
	r := orgrepo.NewMemory()
	ctx := context.Background()
	// 组织树：总公司/技术部/前端组
	root, _ := r.CreateDept(ctx, 1, 0, "总公司", 0)
	tech, _ := r.CreateDept(ctx, 1, root.ID, "技术部", 0)
	fe, _ := r.CreateDept(ctx, 1, tech.ID, "前端组", 0)
	// 用户：张三(前端组主)、李四(技术部)、王五(无部门)、赵六(禁用)
	zs, _ := r.CreateUser(ctx, orgapi.User{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "zhangsan", DisplayName: "张三", Status: 1})
	ls, _ := r.CreateUser(ctx, orgapi.User{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "lisi", DisplayName: "李四", Status: 1})
	_, _ = r.CreateUser(ctx, orgapi.User{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "wangwu", DisplayName: "王五", Status: 1})
	_, _ = r.CreateUser(ctx, orgapi.User{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "zhaoliu", DisplayName: "赵六", Status: 2})
	_ = r.AttachUser(ctx, 1, zs.ID, fe.ID, true)
	_ = r.AttachUser(ctx, 1, ls.ID, tech.ID, true)
	svc := New(r)

	// 全量：禁用排除 + 工号升序
	page, next, err := svc.UserDirectorySearch(ctx, 1, "", "", 2)
	if err != nil || len(page) != 2 || next != "wangwu" || page[0].EmployeeNo != "lisi" || page[1].EmployeeNo != "wangwu" {
		t.Fatalf("首页应 lisi/wangwu next=wangwu: %+v next=%q err=%v", page, next, err)
	}
	page2, next2, err := svc.UserDirectorySearch(ctx, 1, "", next, 2)
	if err != nil || len(page2) != 1 || next2 != "" || page2[0].EmployeeNo != "zhangsan" {
		t.Fatalf("次页应 zhangsan 到底: %+v next=%q err=%v", page2, next2, err)
	}

	// 拼音全拼/首字母/姓名/工号 四路模糊
	for _, q := range []string{"zhangsan", "zs", "张", "zhang"} {
		got, _, err := svc.UserDirectorySearch(ctx, 1, q, "", 20)
		if err != nil || len(got) != 1 || got[0].EmployeeNo != "zhangsan" {
			t.Fatalf("q=%q 应命中张三: %+v err=%v", q, got, err)
		}
	}

	// 组织路径：主部门链路（root→dept）；无部门=空
	got, _, _ := svc.UserDirectorySearch(ctx, 1, "zs", "", 20)
	if len(got) != 1 || got[0].OrgPath != "总公司/技术部/前端组" {
		t.Fatalf("张三组织路径应 总公司/技术部/前端组: %+v", got)
	}
	got, _, _ = svc.UserDirectorySearch(ctx, 1, "王五", "", 20)
	if len(got) != 1 || got[0].OrgPath != "" {
		t.Fatalf("王五无部门应空路径: %+v", got)
	}

	// 搜索态翻页叠加：制造 3 个同姓张（zhangsan 已有）
	_, _ = r.CreateUser(ctx, orgapi.User{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "zhangsan02", DisplayName: "张三2", Status: 1})
	_, _ = r.CreateUser(ctx, orgapi.User{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "zhangsan03", DisplayName: "张三3", Status: 1})
	p1, n1, _ := svc.UserDirectorySearch(ctx, 1, "zhang", "", 2)
	if len(p1) != 2 || n1 != "zhangsan02" {
		t.Fatalf("搜索首页应 2 条 next=zhangsan02: %+v n=%q", p1, n1)
	}
	p2, n2, _ := svc.UserDirectorySearch(ctx, 1, "zhang", n1, 2)
	if len(p2) != 1 || p2[0].EmployeeNo != "zhangsan03" || n2 != "" {
		t.Fatalf("搜索次页应 zhangsan03 到底: %+v n=%q", p2, n2)
	}
}
