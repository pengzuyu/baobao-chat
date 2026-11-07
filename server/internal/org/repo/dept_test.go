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
