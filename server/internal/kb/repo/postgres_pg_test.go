//go:build pg

// kb 域 PG 仓储 + 服务冒烟（build tag `pg`，默认 go test 不编译）。
//
//	本地：BBW_PG_TEST_DSN='postgres://bbw:...@127.0.0.1:5432/bbw?sslmode=disable' \
//	      go test -tags pg ./internal/kb/repo/ -run TestPGKB -v
//
// 未设置 BBW_PG_TEST_DSN 即 skip。租户走池默认 app.tenant=1（RLS 口径与生产一致），
// 每轮分配唯一 user（personal 空间幂等不受历史数据干扰），结束按 owner 级联清理。
// 覆盖：
//   - 迁移 0009（kb_* 四表 + RLS；pgvector 可用则 kb_chunk.embedding=vector(1024)）
//   - 惰性个人空间幂等 / 目录 7014 / 摄入事务（chunks 替换 + 版本 + 配额不重复计）
//   - SearchVector pgvector <=> 真实排序（两文档两主题、查询词无字面命中——
//     关键词路 0 命中，命中与排序只能来自向量余弦）
//   - SearchKeyword ILIKE 命中与得分 / 服务层 RRF 查询直通（注入假嵌入）
package kbrepo_test

import (
	"context"
	"os"
	"testing"
	"time"

	kbrepo "github.com/baobaowork/server/internal/kb/repo"
	kbservice "github.com/baobaowork/server/internal/kb/service"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

func TestPGKBSmoke(t *testing.T) {
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
		t.Fatalf("迁移（应含 0009 kb_*）: %v", err)
	}
	r := kbrepo.NewPostgres(pool)
	pg := r.(*kbrepo.Postgres)
	vecOK, vecVer := pg.VectorMode()
	t.Logf("pgvector: available=%v version=%s（false → kb_chunk.embedding 为 float8[] 降级轨）", vecOK, vecVer)
	// 列类型探针（双轨确认：迁移 DO 块按扩展可用性建列）
	var colType string
	if err := pool.QueryRow(ctx,
		`SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
		 JOIN pg_class c ON c.oid = a.attrelid
		 WHERE c.relname='kb_chunk' AND a.attname='embedding'`).Scan(&colType); err != nil {
		t.Fatalf("embedding 列探测: %v", err)
	}
	t.Logf("kb_chunk.embedding 列类型: %s", colType)

	const tenant = int64(1)
	user1 := int64(880000000) + time.Now().UnixNano()%1_000_000 // 每轮唯一，personal 幂等不受历史干扰
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM kb_chunk WHERE space_id IN (SELECT id FROM kb_space WHERE owner_id=$1)`, user1)
		_, _ = pool.Exec(context.Background(), `DELETE FROM kb_doc WHERE space_id IN (SELECT id FROM kb_space WHERE owner_id=$1)`, user1)
		_, _ = pool.Exec(context.Background(), `DELETE FROM kb_node WHERE space_id IN (SELECT id FROM kb_space WHERE owner_id=$1)`, user1)
		_, _ = pool.Exec(context.Background(), `DELETE FROM kb_space WHERE owner_id=$1`, user1)
	})

	// ── ① 惰性个人空间幂等 ──
	s1, err := r.EnsurePersonalSpace(ctx, tenant, user1, 5<<30)
	if err != nil {
		t.Fatalf("EnsurePersonalSpace: %v", err)
	}
	s2, err := r.EnsurePersonalSpace(ctx, tenant, user1, 5<<30)
	if err != nil || s2.ID != s1.ID {
		t.Fatalf("二次惰性创建应复用: %v %+v", err, s2)
	}

	// ── ② 目录 7014 ──
	n1, err := r.CreateNode(ctx, kbrepo.Node{TenantID: tenant, SpaceID: s1.ID, Name: "pgsmoke-dir", CreatedBy: user1})
	if err != nil {
		t.Fatalf("CreateNode: %v", err)
	}
	if _, err := r.CreateNode(ctx, kbrepo.Node{TenantID: tenant, SpaceID: s1.ID, Name: "pgsmoke-dir", CreatedBy: user1}); err != kbrepo.ErrDupNode {
		t.Fatalf("同名应 ErrDupNode: %v", err)
	}
	dirs, err := r.ListChildNodes(ctx, tenant, s1.ID, 0)
	if err != nil || len(dirs) != 1 || dirs[0].ID != n1.ID {
		t.Fatalf("ListChildNodes: %v %+v", err, dirs)
	}

	// ── ③ 摄入事务（chunks 落库 + 版本 + 配额不重复计）──
	d1, err := r.CreateDoc(ctx, kbrepo.Doc{
		TenantID: tenant, SpaceID: s1.ID, NodeID: n1.ID, Title: "pgsmoke-登录安全",
		SourceType: kbrepo.SourceText, Ext: "txt", Size: 100,
		Status: kbrepo.DocProcessing, Content: "令牌刷新机制", CreatedBy: user1,
	})
	if err != nil {
		t.Fatalf("CreateDoc: %v", err)
	}
	chunks := []kbrepo.Chunk{
		{Seq: 1, HeadingPath: "总则", Text: "当令牌快要过期时，客户端应当静默刷新令牌并重试请求。", TokenCount: 28,
			Embedding: testVec(1, 0)},
		{Seq: 2, HeadingPath: "总则", Text: "连续失败则强制重新登录。", TokenCount: 12,
			Embedding: testVec(0.9, 0.1)},
	}
	committed, err := r.IngestCommit(ctx, d1.ID, chunks, 100, time.Now())
	if err != nil || committed.Status != kbrepo.DocReady || committed.Version != 1 {
		t.Fatalf("IngestCommit: %v %+v", err, committed)
	}
	committed2, err := r.IngestCommit(ctx, d1.ID, chunks[:1], 0, time.Now())
	if err != nil || committed2.Version != 2 {
		t.Fatalf("重摄入应 v2: %v %+v", err, committed2)
	}
	got, _ := r.GetSpace(ctx, s1.ID)
	if got == nil || got.UsedBytes != 100 {
		t.Fatalf("配额应 100（重摄入不重复计）: %+v", got)
	}
	all, _ := r.ListChunks(ctx, tenant, d1.ID)
	if len(all) != 1 || len(all[0].Embedding) != 1024 {
		t.Fatalf("替换后应 1 块且 1024 维向量回读: %d 块 %d 维", len(all), len(all[0].Embedding))
	}
	if _, err := r.ListChunksAround(ctx, tenant, d1.ID, 1, 1, 1); err != nil {
		t.Fatalf("around: %v", err)
	}

	// ── ④ SearchVector 向量路真实排序 ──
	// 文档 B（红烧肉主题，正交轴）；failed 文档 d3 不参与——三者共同验证：
	// 向量查询（轴 0）只命中 d1 且得分 ~1
	d2, err := r.CreateDoc(ctx, kbrepo.Doc{
		TenantID: tenant, SpaceID: s1.ID, Title: "pgsmoke-家常菜谱",
		SourceType: kbrepo.SourceText, Ext: "txt", Size: 50,
		Status: kbrepo.DocProcessing, Content: "红烧肉", CreatedBy: user1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.IngestCommit(ctx, d2.ID, []kbrepo.Chunk{
		{Seq: 1, Text: "红烧肉的传统做法讲究小火慢炖。", TokenCount: 15, Embedding: testVec(0, 1)},
	}, 50, time.Now()); err != nil {
		t.Fatal(err)
	}
	d3, _ := r.CreateDoc(ctx, kbrepo.Doc{
		TenantID: tenant, SpaceID: s1.ID, Title: "pgsmoke-failed",
		SourceType: kbrepo.SourceText, Ext: "txt", Size: 10,
		Status: kbrepo.DocProcessing, Content: "x", CreatedBy: user1,
	})
	_ = r.FailDoc(ctx, d3.ID, "嵌入服务不可用", time.Now())

	vecHits, err := r.SearchVector(ctx, tenant, []int64{s1.ID}, testVec(1, 0), 10)
	if err != nil {
		t.Fatalf("SearchVector: %v", err)
	}
	if len(vecHits) != 1 || vecHits[0].DocID != d1.ID || vecHits[0].DocTitle != "pgsmoke-登录安全" {
		t.Fatalf("向量路应仅命中 d1（d2 正交、d3 failed）: %+v", vecHits)
	}
	if vecHits[0].Score < 0.9 {
		t.Fatalf("余弦得分应 ~1（<=> 真实排序）: %f", vecHits[0].Score)
	}

	// ── ⑤ SearchKeyword ILIKE ──
	kwHits, err := r.SearchKeyword(ctx, tenant, []int64{s1.ID}, []string{"令牌"}, 10)
	if err != nil || len(kwHits) != 1 || kwHits[0].DocID != d1.ID || kwHits[0].Score < 1 {
		t.Fatalf("关键词路: %v %+v", err, kwHits)
	}

	// ── ⑥ 服务层直通（同步摄入 + RRF 查询，注入假嵌入）──
	svc := kbservice.New(kbservice.Options{
		Embedder: func(_ context.Context, in []string) ([][]float32, error) {
			out := make([][]float32, len(in))
			for i := range out {
				out[i] = testVec(0.5, 0.5)
			}
			return out, nil
		},
	}, r)
	resp, err := svc.Query(ctx, tenant, user1, []string{itoa(s1.ID)}, "令牌", 10)
	if err != nil || len(resp.Items) == 0 || resp.Items[0].DocID != itoa(d1.ID) {
		t.Fatalf("Query RRF: %v %+v", err, resp)
	}
	if len(resp.Items[0].Highlight) == 0 {
		t.Fatalf("字面命中应有高亮区间: %+v", resp.Items[0])
	}
	// 空间限定查询的 docCount 口径（ListSpaces 含惰性 personal）
	spDTOs, err := svc.ListSpaces(ctx, tenant, user1)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, sp := range spDTOs {
		if sp.ID == itoa(s1.ID) && sp.DocCount == 3 { // d1/d2/d3(failed) 全量口径
			found = true
		}
	}
	if !found {
		t.Fatalf("ListSpaces 应含本空间且 doc_count=3（含 failed）: %+v", spDTOs)
	}
}

// testVec 1024 维测试向量（前两位有效；vector(1024)/float8[] 双轨兼容）
func testVec(a, b float32) []float32 {
	v := make([]float32, 1024)
	v[0], v[1] = a, b
	return v
}

func itoa(v int64) string {
	return fmtInt(v)
}

func fmtInt(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
