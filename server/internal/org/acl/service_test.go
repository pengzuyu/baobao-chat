// 判定链测试（03 §4.4）：逐层取最大/过期失效/层级展开闭包/护栏。
package acl

import (
	"context"
	"testing"
	"time"
)

func newSvc(t *testing.T, opts ResolveOptions) *Service {
	t.Helper()
	return New(NewMemory(), opts)
}

func fixedNow() time.Time { return time.UnixMilli(1760000000000) }

// 逐层取最大：user owner > tenant viewer → owner；dept/role 层经闭包
func TestResolveTakesMaxAcrossLayers(t *testing.T) {
	svc := newSvc(t, ResolveOptions{
		DeptIDsOf: func(_, uid int64) []int64 {
			if uid == 2002 {
				return []int64{31} // bob 在部门 31
			}
			return nil
		},
		RoleIDsOf: func(_, uid int64) []int64 {
			if uid == 2003 {
				return []int64{7} // carol 持角色 7
			}
			return nil
		},
		Now: fixedNow,
	})
	ctx := context.Background()
	mustGrant(t, svc, Entry{ResourceType: "kb.space", ResourceID: "sp-1", GrantType: GrantTenant, Perm: PermViewer})
	mustGrant(t, svc, Entry{ResourceType: "kb.space", ResourceID: "sp-1", GrantType: GrantUser, GrantTarget: 2001, Perm: PermOwner})
	mustGrant(t, svc, Entry{ResourceType: "kb.space", ResourceID: "sp-1", GrantType: GrantDept, GrantTarget: 31, Perm: PermEditor})
	mustGrant(t, svc, Entry{ResourceType: "kb.space", ResourceID: "sp-1", GrantType: GrantRole, GrantTarget: 7, Perm: PermCommenter})

	// user 直授 owner（2001）
	if p := svc.Resolve(ctx, 1, "kb.space", "sp-1", 2001); p != PermOwner {
		t.Fatalf("user 直授应 owner：%d", p)
	}
	// 部门 editor（2002 经 dept 31）
	if p := svc.Resolve(ctx, 1, "kb.space", "sp-1", 2002); p != PermEditor {
		t.Fatalf("部门授权应 editor：%d", p)
	}
	// 角色 commenter（2003 经 role 7）
	if p := svc.Resolve(ctx, 1, "kb.space", "sp-1", 2003); p != PermCommenter {
		t.Fatalf("角色授权应 commenter：%d", p)
	}
	// 陌生人吃 tenant 公开 viewer
	if p := svc.Resolve(ctx, 1, "kb.space", "sp-1", 9999); p != PermViewer {
		t.Fatalf("tenant 公开应 viewer：%d", p)
	}
	// 谓词便捷
	if !svc.IsOwner(ctx, 1, "kb.space", "sp-1", 2001) || !svc.CanEdit(ctx, 1, "kb.space", "sp-1", 2002) ||
		!svc.CanView(ctx, 1, "kb.space", "sp-1", 9999) {
		t.Fatal("谓词判定错位")
	}
	// 无关资源=none
	if p := svc.Resolve(ctx, 1, "kb.space", "sp-2", 2001); p != PermNone {
		t.Fatalf("无关资源应 none：%d", p)
	}
}

// 过期授权不参与；未过期参与（过期行直写 repo——svc.Grant 护栏会拒；
// 真实时钟——memory/PG 的 EffectiveForUser 过期滤除按库时钟）
func TestResolveExpiresAt(t *testing.T) {
	now := time.Now()
	repo := NewMemory()
	svc := New(repo, ResolveOptions{})
	ctx := context.Background()
	if _, err := repo.Grant(ctx, Entry{
		ResourceType: "mail.shared", ResourceID: "mb-9", GrantType: GrantUser, GrantTarget: 3001,
		Perm: PermEditor, ExpiresAt: now.Add(-time.Hour), // 已过期
	}); err != nil {
		t.Fatal(err)
	}
	mustGrant(t, svc, Entry{
		ResourceType: "mail.shared", ResourceID: "mb-9", GrantType: GrantUser, GrantTarget: 3002,
		Perm: PermViewer, ExpiresAt: now.Add(time.Hour), // 未过期
	})
	if p := svc.Resolve(ctx, 1, "mail.shared", "mb-9", 3001); p != PermNone {
		t.Fatalf("过期授权应 none：%d", p)
	}
	if p := svc.Resolve(ctx, 1, "mail.shared", "mb-9", 3002); p != PermViewer {
		t.Fatalf("未过期应 viewer：%d", p)
	}
}

// 护栏：tenant 公开不可 owner；参数越界拒绝；过期时间须晚于当前
func TestGrantGuards(t *testing.T) {
	svc := newSvc(t, ResolveOptions{Now: fixedNow})
	if _, err := svc.Grant(context.Background(), Entry{
		ResourceType: "x", ResourceID: "1", GrantType: GrantTenant, Perm: PermOwner,
	}); !IsInvalid(err) {
		t.Fatalf("tenant 公开 owner 应拒绝：%v", err)
	}
	if _, err := svc.Grant(context.Background(), Entry{
		ResourceType: "x", ResourceID: "1", GrantType: GrantUser, GrantTarget: 1, Perm: 9,
	}); !IsInvalid(err) {
		t.Fatal("perm 越界应拒绝")
	}
	if _, err := svc.Grant(context.Background(), Entry{
		ResourceType: "x", ResourceID: "1", GrantType: GrantUser, GrantTarget: 0, Perm: PermViewer,
	}); !IsInvalid(err) {
		t.Fatal("user 授权缺 target 应拒绝")
	}
	if _, err := svc.Grant(context.Background(), Entry{
		ResourceType: "x", ResourceID: "1", GrantType: GrantUser, GrantTarget: 1,
		Perm: PermViewer, ExpiresAt: fixedNow().Add(-time.Minute),
	}); !IsInvalid(err) {
		t.Fatal("过去过期时间应拒绝")
	}
}

// 幂等覆盖：同 resource+grant 重复授权=更新 perm（uk 语义）
func TestGrantIdempotentOverwrite(t *testing.T) {
	svc := newSvc(t, ResolveOptions{Now: fixedNow})
	ctx := context.Background()
	mustGrant(t, svc, Entry{ResourceType: "f", ResourceID: "s1", GrantType: GrantUser, GrantTarget: 1, Perm: PermViewer})
	mustGrant(t, svc, Entry{ResourceType: "f", ResourceID: "s1", GrantType: GrantUser, GrantTarget: 1, Perm: PermEditor})
	if p := svc.Resolve(ctx, 1, "f", "s1", 1); p != PermEditor {
		t.Fatalf("重复授权应覆盖为 editor：%d", p)
	}
	list, _ := svc.ListGrants(ctx, 1, EntryFilter{ResourceType: "f"})
	if len(list) != 1 {
		t.Fatalf("uk 幂等应单条：%d", len(list))
	}
	// 撤销后 none；重复撤销 NotFound
	if err := svc.Revoke(ctx, 1, list[0].ID); err != nil {
		t.Fatal(err)
	}
	if p := svc.Resolve(ctx, 1, "f", "s1", 1); p != PermNone {
		t.Fatalf("撤销后应 none：%d", p)
	}
	if err := svc.Revoke(ctx, 1, list[0].ID); err != ErrNotFound {
		t.Fatalf("重复撤销应 NotFound：%v", err)
	}
}

// fail-closed：仓储故障=none（判定失败不放大权限）
func TestResolveFailClosed(t *testing.T) {
	svc := New(&failingRepo{}, ResolveOptions{Now: fixedNow})
	if p := svc.Resolve(context.Background(), 1, "x", "1", 1); p != PermNone {
		t.Fatalf("判定失败应 none：%d", p)
	}
}

type failingRepo struct{}

func (f *failingRepo) Grant(context.Context, Entry) (Entry, error) { return Entry{}, nil }
func (f *failingRepo) Revoke(context.Context, int64, int64) error  { return nil }
func (f *failingRepo) ListGrants(context.Context, int64, EntryFilter) ([]Entry, error) {
	return nil, nil
}
func (f *failingRepo) EffectiveForUser(context.Context, int64, string, string, int64, []int64, []int64) ([]Entry, error) {
	return nil, context.DeadlineExceeded
}

func mustGrant(t *testing.T, svc *Service, e Entry) {
	t.Helper()
	if _, err := svc.Grant(context.Background(), e); err != nil {
		t.Fatalf("Grant %+v: %v", e, err)
	}
}
