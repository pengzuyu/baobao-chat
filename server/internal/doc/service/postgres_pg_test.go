//go:build pg

// doc 域 PG 仓储 + 服务冒烟（build tag `pg`，默认 go test 不编译）。
//
//	本地：BBW_PG_TEST_DSN='postgres://bbw:...@127.0.0.1:5432/bbw?sslmode=disable' \
//	      go test -tags pg ./internal/doc/... -run TestPGDoc -v
//
// 未设置 BBW_PG_TEST_DSN 即 skip。租户走池默认 app.tenant=1（RLS 口径与生产一致），
// 每轮分配唯一 owner，结束按 owner 级联清理。
// 覆盖：
//   - 迁移 0011（doc_file/doc_version 两表 + RLS + UK(doc,version)）
//   - 新建 v1 create 快照 / 乐观锁保存 manual 快照（FOR UPDATE + base_version）
//   - 6004 冲突真路径（并发基线落后）/ 恢复 restore 快照 / 回收站 purge_at
package docservice_test

import (
	"context"
	"os"
	"testing"
	"time"

	docrepo "github.com/baobaowork/server/internal/doc/repo"
	docservice "github.com/baobaowork/server/internal/doc/service"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

func TestPGDocSmoke(t *testing.T) {
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
		t.Fatalf("迁移（应含 0011 doc_*）: %v", err)
	}
	repo := docrepo.NewPostgres(pool)
	svc := docservice.New(docservice.Options{}, repo)

	const tenant = int64(1)
	owner := int64(990000000) + time.Now().UnixNano()%1_000_000 // 每轮唯一
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM doc_version WHERE doc_id IN (SELECT id FROM doc_file WHERE owner_id=$1)`, owner)
		_, _ = pool.Exec(context.Background(), `DELETE FROM doc_file WHERE owner_id=$1`, owner)
	})

	// ── ① 新建 + v1 create 快照 ──
	f1, v1, err := repo.CreateFile(ctx, docrepo.DocFile{
		TenantID: tenant, OwnerID: owner, Title: "pgsmoke-文档", Scope: "personal",
	})
	if err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	if f1.CurrentVersion != 1 || v1.Version != 1 || v1.SnapshotType != docrepo.SnapCreate {
		t.Fatalf("v1 create 快照错: %+v %+v", f1, v1)
	}

	// ── ② 乐观锁保存 v2 / 冲突真路径 ──
	if _, _, err := repo.SaveContent(ctx, f1.ID, owner, 1, "正文 v2", time.Now()); err != nil {
		t.Fatalf("SaveContent v2: %v", err)
	}
	if _, _, err := repo.SaveContent(ctx, f1.ID, owner, 1, "迟到写入", time.Now()); err != docrepo.ErrVersionConflict {
		t.Fatalf("落后基线应 ErrVersionConflict，得 %v", err)
	}

	// ── ③ 恢复 v2 → v3 restore + 正文回写 ──
	f1v3, v3, err := repo.RestoreVersion(ctx, f1.ID, owner, 2, time.Now())
	if err != nil {
		t.Fatalf("RestoreVersion: %v", err)
	}
	if v3.SnapshotType != docrepo.SnapRestore || f1v3.CurrentVersion != 3 || f1v3.ContentMD != "正文 v2" {
		t.Fatalf("restore 快照/回写错: %+v %+v", f1v3, v3)
	}
	// 目标版本不存在 → ErrNotFound
	if _, _, err := repo.RestoreVersion(ctx, f1.ID, owner, 99, time.Now()); err != docrepo.ErrNotFound {
		t.Fatalf("恢复不存在版本应 ErrNotFound，得 %v", err)
	}

	// ── ④ 版本时间线三版倒序 ──
	vers, err := repo.ListVersions(ctx, tenant, f1.ID, 0, 50)
	if err != nil || len(vers) != 3 {
		t.Fatalf("时间线应 3 版: %v %+v", err, vers)
	}

	// ── ⑤ 同名 6015 真路径（同 owner 活跃同名） ──
	if _, _, err := repo.CreateFile(ctx, docrepo.DocFile{
		TenantID: tenant, OwnerID: owner, Title: "pgsmoke-文档",
	}); err != docrepo.ErrDupTitle {
		t.Fatalf("同名应 ErrDupTitle，得 %v", err)
	}

	// ── ⑥ 回收站：purge_at 落库 / 列表 / 恢复（改名）──
	now := time.Now()
	trashed, err := repo.TrashFile(ctx, f1.ID, now.AddDate(0, 0, 30), now)
	if err != nil || trashed.Status != docrepo.StatusTrashed || trashed.PurgeAt == nil {
		t.Fatalf("TrashFile: %v %+v", err, trashed)
	}
	list, err := repo.ListTrash(ctx, tenant, owner, docrepo.PageCursor{}, 50)
	if err != nil || len(list) != 1 || list[0].ID != f1.ID {
		t.Fatalf("ListTrash: %v %+v", err, list)
	}
	restored, err := repo.RestoreFile(ctx, f1.ID, "pgsmoke-文档 (恢复)", now)
	if err != nil || restored.Title != "pgsmoke-文档 (恢复)" || restored.Status != docrepo.StatusActive {
		t.Fatalf("RestoreFile: %v %+v", err, restored)
	}

	// ── ⑦ 列表模糊 + 键集翻页（服务层直通） ──
	for i := 0; i < 3; i++ {
		if _, err := svc.CreateFile(ctx, tenant, owner, "pgsmoke-翻页-"+string(rune('A'+i))); err != nil {
			t.Fatalf("翻页种子 %d: %v", i, err)
		}
	}
	p1, err := svc.ListFiles(ctx, tenant, owner, "翻页", "", 2)
	if err != nil || len(p1.Items) != 2 || !p1.HasMore {
		t.Fatalf("翻页首页: %v %+v", err, p1)
	}
	p2, err := svc.ListFiles(ctx, tenant, owner, "翻页", p1.NextCursor, 2)
	if err != nil || len(p2.Items) != 1 || p2.HasMore {
		t.Fatalf("翻页末页: %v %+v", err, p2)
	}
}
