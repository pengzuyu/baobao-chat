package stickerservice

import (
	"context"
	"fmt"
	"testing"

	stickerrepo "github.com/baobaowork/server/internal/sticker/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

func newSvc(maxSets int) *Service {
	return New(Options{MaxPersonalSets: maxSets}, stickerrepo.NewMemory())
}

func TestPersonalSetLifecycle(t *testing.T) {
	svc := newSvc(10)
	ctx := context.Background()

	set, err := svc.CreateSet(ctx, 10001, "我的表情")
	if err != nil {
		t.Fatalf("建集: %v", err)
	}
	// 加图（file_id 由 file 域校验——Options.FileCheck 未注入=跳过）
	if _, err := svc.AddItem(ctx, 10001, idOf(t, set.ID), 88, "得意", false); err != nil {
		t.Fatalf("加图: %v", err)
	}
	// 他人加图 → 2003
	if _, err := svc.AddItem(ctx, 10002, idOf(t, set.ID), 99, "x", false); errx.From(err).Code != errx.CodePermPointDenied {
		t.Fatalf("他人加图应拒 2003: %v", err)
	}
	// Library：本人可见，他人不可见
	lib, _ := svc.Library(ctx, 10001)
	if len(lib.Mine) != 1 || len(lib.Mine[0].Items) != 1 {
		t.Fatalf("本人应见 1 集 1 图: %+v", lib.Mine)
	}
	lib2, _ := svc.Library(ctx, 10002)
	if len(lib2.Mine) != 0 {
		t.Fatalf("他人 mine 应空: %+v", lib2.Mine)
	}
	// 发送校验：owner 可用（返回 file_id），他人 2003
	fid, err := svc.CheckUsable(ctx, 10001, 1)
	if err != nil || fid != 88 {
		t.Fatalf("owner CheckUsable: fid=%d err=%v", fid, err)
	}
	if _, err := svc.CheckUsable(ctx, 10002, 1); errx.From(err).Code != errx.CodePermACLDenied {
		t.Fatalf("他人发送应拒 2003: %v", err)
	}
}

func TestPublicSetGovernance(t *testing.T) {
	svc := newSvc(10)
	ctx := context.Background()

	pub, err := svc.CreatePublicSet(ctx, 999, "租户官方")
	if err != nil {
		t.Fatalf("建公共集: %v", err)
	}
	// 普通用户向公共集加图 → 2001（提示走管理端）
	if _, err := svc.AddItem(ctx, 10001, idOf(t, pub.ID), 88, "x", false); errx.From(err).Code != errx.CodePermPointDenied {
		t.Fatalf("普通用户加公共集应拒: %v", err)
	}
	// 管理端加图放行
	if _, err := svc.AddItem(ctx, 999, idOf(t, pub.ID), 88, "官方表情", true); err != nil {
		t.Fatalf("管理端加图: %v", err)
	}
	// 同图重复 → 9001
	if _, err := svc.AddItem(ctx, 999, idOf(t, pub.ID), 88, "again", true); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("重复图应拒 9001: %v", err)
	}
	// 全员可用（个人用户 CheckUsable 公共集启用）
	if fid, err := svc.CheckUsable(ctx, 10002, 1); err != nil || fid != 88 {
		t.Fatalf("公共集全员可用: fid=%d err=%v", fid, err)
	}
	// 下架后：Library 不再透出；CheckUsable 拒
	if err := svc.SetPublicStatus(ctx, idOf(t, pub.ID), 2); err != nil {
		t.Fatalf("下架: %v", err)
	}
	lib, _ := svc.Library(ctx, 10001)
	if len(lib.Public) != 0 {
		t.Fatalf("下架后不应透出: %+v", lib.Public)
	}
	if _, err := svc.CheckUsable(ctx, 10001, 1); errx.From(err).Code != errx.CodeNotFound {
		t.Fatalf("下架后发送应拒 404 语义: %v", err)
	}
	// 管理端列表仍可见（含下架）
	admin, _ := svc.AdminLibrary(ctx)
	if len(admin) != 1 || admin[0].Status != 2 {
		t.Fatalf("管理端应见下架集: %+v", admin)
	}
}

func TestPersonalSetLimit(t *testing.T) {
	svc := newSvc(2)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := svc.CreateSet(ctx, 10001, "s"); err != nil {
			t.Fatalf("建集 %d: %v", i, err)
		}
	}
	if _, err := svc.CreateSet(ctx, 10001, "s3"); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("超上限应拒 9001: %v", err)
	}
	// 上限按人隔离
	if _, err := svc.CreateSet(ctx, 10002, "other"); err != nil {
		t.Fatalf("他人不受影响: %v", err)
	}
}

// idOf string → int64（DTO 对外字符串透出，repo 层 int64）
func idOf(t *testing.T, s string) int64 {
	t.Helper()
	var v int64
	if _, err := fmt.Sscanf(s, "%d", &v); err != nil {
		t.Fatalf("解析 %q: %v", s, err)
	}
	return v
}
