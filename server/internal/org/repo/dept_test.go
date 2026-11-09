// 组织树契约测试（PAD-04）：建树/物化路径/改名/删保护（子部门拒）。
package orgrepo

import (
	"context"
	"testing"

	orgapi "github.com/baobaowork/server/internal/org/api"
)

func TestDeptTreeLifecycle(t *testing.T) {
	r := NewMemory()
	ctx := context.Background()
	// 根 → 子 → 孙：物化路径 /1/ /1/2/ /1/2/3/（按分配 id）
	root, err := r.CreateDept(ctx, 1, 0, "总公司", 0)
	if err != nil || root.ID == 0 {
		t.Fatalf("root: %v", err)
	}
	child, err := r.CreateDept(ctx, 1, root.ID, "研发部", 0)
	if err != nil {
		t.Fatalf("child: %v", err)
	}
	grand, err := r.CreateDept(ctx, 1, child.ID, "后端组", 0)
	if err != nil {
		t.Fatalf("grand: %v", err)
	}
	if root.Path == "" || len(child.Path) <= len(root.Path) || len(grand.Path) <= len(child.Path) {
		t.Fatalf("物化路径应逐级增长: %q %q %q", root.Path, child.Path, grand.Path)
	}
	// 树形：root → child → grand
	tree, err := r.ListTree(ctx, 1)
	if err != nil || len(tree) != 1 || len(tree[0].Children) != 1 || len(tree[0].Children[0].Children) != 1 {
		t.Fatalf("tree: %v %+v", err, tree)
	}
	// 校验：空名/超长
	if _, err := r.CreateDept(ctx, 1, 0, "", 0); err != orgapi.ErrDeptName {
		t.Fatal("空名应拒")
	}
	if _, err := r.CreateDept(ctx, 1, 999, "孤儿", 0); err != orgapi.ErrDeptNotFound {
		t.Fatal("父不存在应拒")
	}
	// 改名
	if err := r.RenameDept(ctx, 1, child.ID, "研发中心"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	// 删保护：有子拒 → 先删孙 → 删子 → 删根
	if err := r.DeleteDept(ctx, 1, child.ID); err != orgapi.ErrDeptNotEmpty {
		t.Fatal("有子部门应拒删")
	}
	for _, id := range []int64{grand.ID, child.ID, root.ID} {
		if err := r.DeleteDept(ctx, 1, id); err != nil {
			t.Fatalf("delete %d: %v", id, err)
		}
	}
	if tree, _ := r.ListTree(ctx, 1); len(tree) != 0 {
		t.Fatal("删空后应无树")
	}
}

// user_dept 最小读写：挂载幂等/首挂 primary/按用户列
func TestUserDeptAttachAndList(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	if err := m.AttachUser(ctx, 1, 1001, 31, false); err != nil {
		t.Fatal(err)
	}
	if err := m.AttachUser(ctx, 1, 1001, 32, true); err != nil {
		t.Fatal(err)
	}
	if err := m.AttachUser(ctx, 1, 1001, 32, true); err != nil {
		t.Fatal(err) // 幂等
	}
	rows, err := m.ListUserDepts(ctx, 1, 1001)
	if err != nil || len(rows) != 2 {
		t.Fatalf("两部门：%v %d", err, len(rows))
	}
	if rows[0].IsPrimary || !rows[1].IsPrimary {
		t.Fatalf("primary 应为 32：%+v", rows)
	}
	empty, _ := m.ListUserDepts(ctx, 1, 9999)
	if len(empty) != 0 {
		t.Fatal("无挂载=空集")
	}
}

// TestUserDeptDetachAndDeptUsers D10：卸挂 primary 重选/成员列表
func TestUserDeptDetachAndDeptUsers(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	d1, _ := m.CreateDept(ctx, 1, 0, "研发部", 0)
	d2, _ := m.CreateDept(ctx, 1, 0, "测试部", 0)

	// alice 挂两部门（研发 primary）
	if err := m.AttachUser(ctx, 1, 10001, d1.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := m.AttachUser(ctx, 1, 10001, d2.ID, false); err != nil {
		t.Fatal(err)
	}
	// bob 仅研发
	if err := m.AttachUser(ctx, 1, 10002, d1.ID, true); err != nil {
		t.Fatal(err)
	}

	// 成员列表：研发=[alice primary, bob primary]
	rows, err := m.ListDeptUsers(ctx, 1, d1.ID)
	if err != nil || len(rows) != 2 || !rows[0].IsPrimary || rows[0].UserID != 10001 {
		t.Fatalf("研发成员不符: %v %+v", err, rows)
	}

	// 卸 alice 研发（primary）→ 测试部接任 primary
	if err := m.DetachUser(ctx, 1, 10001, d1.ID); err != nil {
		t.Fatal(err)
	}
	depts, _ := m.ListUserDepts(ctx, 1, 10001)
	if len(depts) != 1 || depts[0].DeptID != d2.ID || !depts[0].IsPrimary {
		t.Fatalf("primary 应重选测试部: %+v", depts)
	}
	// 卸尽 → 无 primary 残留
	if err := m.DetachUser(ctx, 1, 10001, d2.ID); err != nil {
		t.Fatal(err)
	}
	depts, _ = m.ListUserDepts(ctx, 1, 10001)
	if len(depts) != 0 {
		t.Fatalf("卸尽应空: %+v", depts)
	}
	// 幂等：再卸不存在 no-op
	if err := m.DetachUser(ctx, 1, 10001, d1.ID); err != nil {
		t.Fatalf("幂等卸挂: %v", err)
	}
}
