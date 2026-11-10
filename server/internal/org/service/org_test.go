// orgservice 单元测试：部门归属读（kb 三层知识检索消费的链路解析）。
package orgservice

import (
	"context"
	"testing"

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
