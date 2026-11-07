//go:build pg

// file 域 PG 仓储冒烟（build tag `pg`，默认 go test 不编译）。
//
//	本地：BBW_PG_TEST_DSN='postgres://bbw:...@127.0.0.1:5432/bbw?sslmode=disable' \
//	      go test -tags pg ./internal/file/repo/ -run TestPGFileSmoke -v
//
// 未设置 BBW_PG_TEST_DSN 即 skip。直接用库（不建临时表）：测试数据带纳秒后缀，结束清理。
package filerepo

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

func TestPGFileSmoke(t *testing.T) {
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
		t.Fatalf("迁移（应含 0008 file 表）: %v", err)
	}
	sfx := strconv.FormatInt(time.Now().UnixNano(), 10)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM file WHERE name LIKE 'pgsmoke-file-%'`)
	})

	r := NewPostgres(pool)
	now := time.Now()

	// ① Insert + Get 全字段回读
	f, err := r.Insert(ctx, File{
		TenantID: 1, OwnerID: 10001, Name: "pgsmoke-file-a-" + sfx + ".png", Ext: "png",
		Size: 42, ContentType: "image/png", SHA256: "aa" + sfx, Width: 7, Height: 5,
		Source: SourceUpload, ConvID: 0, ScanStatus: ScanClean, CreatedAt: now,
	})
	if err != nil || f.ID == 0 {
		t.Fatalf("Insert: %v %+v", err, f)
	}
	got, err := r.Get(ctx, f.ID)
	if err != nil || got.Name != f.Name || got.Width != 7 || got.Height != 5 ||
		got.Source != SourceUpload || got.ScanStatus != ScanClean || got.Deleted() {
		t.Fatalf("Get 回读不符: %v %+v", err, got)
	}
	// Get 不存在 → ErrNotFound
	if _, err := r.Get(ctx, -1); err != ErrNotFound {
		t.Fatalf("Get(不存在) 应 ErrNotFound, got %v", err)
	}

	// ② 同租户同 sha 唯一索引兜底 → ErrDuplicateFileSHA
	_, err = r.Insert(ctx, File{
		TenantID: 1, OwnerID: 10002, Name: "pgsmoke-file-dup-" + sfx, Ext: "png",
		Size: 42, ContentType: "image/png", SHA256: "aa" + sfx, Source: SourceUpload,
		ScanStatus: ScanClean, CreatedAt: now,
	})
	if err != ErrDuplicateFileSHA {
		t.Fatalf("并发同 sha 应 ErrDuplicateFileSHA, got %v", err)
	}
	// GetBySHA 命中未删行；跨租户不命中（隔离红线）
	if hit, _ := r.GetBySHA(ctx, 1, "aa"+sfx); hit == nil || hit.ID != f.ID {
		t.Fatalf("GetBySHA 应命中原行: %+v", hit)
	}
	if hit, _ := r.GetBySHA(ctx, 2, "aa"+sfx); hit != nil {
		t.Fatalf("跨租户 GetBySHA 不应命中: %+v", hit)
	}

	// ③ MarkSent + ListByConv
	if err := r.MarkSent(ctx, f.ID, 9); err != nil {
		t.Fatalf("MarkSent: %v", err)
	}
	if got, _ := r.Get(ctx, f.ID); got.Source != SourceMessage || got.ConvID != 9 {
		t.Fatalf("MarkSent 回读不符: %+v", got)
	}
	convFiles, _ := r.ListByConv(ctx, 1, 9)
	if len(convFiles) != 1 || convFiles[0].ID != f.ID {
		t.Fatalf("ListByConv 不符: %+v", convFiles)
	}

	// ④ ListByUser 排除软删 + 时间倒序
	f2, err := r.Insert(ctx, File{
		TenantID: 1, OwnerID: 10001, Name: "pgsmoke-file-b-" + sfx + ".txt", Ext: "txt",
		Size: 1, ContentType: "text/plain", SHA256: "bb" + sfx, Source: SourceUpload,
		ScanStatus: ScanClean, CreatedAt: now.Add(time.Second),
	})
	if err != nil {
		t.Fatalf("Insert2: %v", err)
	}
	mine, _ := r.ListByUser(ctx, 1, 10001)
	if len(mine) != 2 || mine[0].ID != f2.ID {
		t.Fatalf("ListByUser 应 2 行且新者在前: %+v", mine)
	}
	if err := r.SoftDelete(ctx, f2.ID, now); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	mine, _ = r.ListByUser(ctx, 1, 10001)
	if len(mine) != 1 || mine[0].ID != f.ID {
		t.Fatalf("软删后 ListByUser 应仅 1 行: %+v", mine)
	}
	// 软删行不参与去重：GetBySHA 不命中 → 可重新入库同 sha
	if hit, _ := r.GetBySHA(ctx, 1, "bb"+sfx); hit != nil {
		t.Fatalf("软删行不应参与去重: %+v", hit)
	}
	// 软删后 MarkSent → ErrNotFound（未删行限定）
	if err := r.MarkSent(ctx, f2.ID, 9); err != ErrNotFound {
		t.Fatalf("软删行 MarkSent 应 ErrNotFound, got %v", err)
	}
}
