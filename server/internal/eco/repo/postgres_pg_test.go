//go:build pg

// eco 域 PG 冒烟（build tag `pg`）。
//
//	BBW_PG_TEST_DSN='postgres://bbw:...' go test -tags pg ./internal/eco/repo/ -run TestPGEcoSmoke -v
package ecorepo

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

func TestPGEcoSmoke(t *testing.T) {
	dsn := os.Getenv("BBW_PG_TEST_DSN")
	if dsn == "" {
		t.Skip("BBW_PG_TEST_DSN 未设置")
	}
	ctx := context.Background()
	pool, err := bbwpg.New(ctx, dsn)
	if err != nil {
		t.Fatalf("建池: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := bbwpg.Migrate(ctx, pool); err != nil {
		t.Fatalf("迁移（应含 0020 eco_expert）: %v", err)
	}
	sfx := strconv.FormatInt(time.Now().UnixNano()%10000000, 10)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM eco_expert WHERE expert_id LIKE 'usr.9%'`)
	})
	r := NewPostgres(pool)
	e, err := r.Create(ctx, Expert{
		TenantID: 1, ExpertID: "usr.91001.reviewer-" + sfx, Version: "1.0.0",
		Display: "评审", Summary: "摘要", Source: SourcePersonal, OwnerUserID: 91001,
		Manifest: "id: x", Status: StatusPublished, CreatedBy: 91001,
	})
	if err != nil || e.ID == 0 {
		t.Fatalf("Create: %v", err)
	}
	// UK
	if _, err := r.Create(ctx, Expert{
		TenantID: 1, ExpertID: "usr.91001.reviewer-" + sfx, Source: SourcePersonal, OwnerUserID: 91001, Manifest: "x",
	}); err != ErrDupID {
		t.Fatalf("UK: %v", err)
	}
	// 按 expert_id 查/清单过滤/更新状态/删除
	if got, _ := r.GetByExpertID(ctx, 1, "usr.91001.reviewer-"+sfx); got == nil || got.Display != "评审" {
		t.Fatalf("GetByExpertID: %+v", got)
	}
	if l, _ := r.List(ctx, 1, ListFilter{Source: SourcePersonal, Status: StatusPublished, Owner: 91001}); len(l) != 1 {
		t.Fatalf("List: %d", len(l))
	}
	if err := r.UpdateStatus(ctx, 1, e.ID, StatusUnpublished); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateManifest(ctx, 1, e.ID, "1.1.0", "评审2", "s2", "id: y"); err != nil {
		t.Fatal(err)
	}
	if got, _ := r.Get(ctx, 1, e.ID); got.Version != "1.1.0" || got.Status != StatusUnpublished {
		t.Fatalf("更新回读: %+v", got)
	}
	if err := r.Delete(ctx, 1, e.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Get(ctx, 1, e.ID); err != ErrNotFound {
		t.Fatalf("删除后: %v", err)
	}
}
