// kbservice 单元测试：分段/摄入管线（假嵌入）/权限隔离/RRF 融合/降级/配额/目录约束。
// 嵌入一律注入假 EmbedFn（内存模式不走网络，任务约束）。
package kbservice

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	kbapi "github.com/baobaowork/server/internal/kb/api"
	kbrepo "github.com/baobaowork/server/internal/kb/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// fakeTopical 主题词袋假嵌入：文本含哪些主题词 → 对应单位轴累加（4 维够区分）
func fakeTopical(topics map[string]int) EmbedFn {
	return func(_ context.Context, in []string) ([][]float32, error) {
		out := make([][]float32, len(in))
		for i, s := range in {
			vec := make([]float32, 8)
			for kw, dim := range topics {
				if strings.Contains(s, kw) {
					vec[dim] += 1
				}
			}
			out[i] = vec
		}
		return out, nil
	}
}

// errEmbed 恒失败嵌入（7008 场景）
func errEmbed(_ context.Context, _ []string) ([][]float32, error) {
	return nil, errors.New("gateway down")
}

const (
	tenantID = int64(1)
	alice    = int64(1001)
	bob      = int64(1002)
)

func newTestService(t *testing.T, o Options) *Service {
	t.Helper()
	return New(o, kbrepo.NewMemory())
}

// TestSplitIntoChunks 分段：标题链/空行分段/800 上限/超长硬切/清洗
func TestSplitIntoChunks(t *testing.T) {
	// 标题 + 多段落
	text := "# 登录安全规范\r\n\r\n总则内容第一段。\r\n\r\n第二段内容。\r\n\r\n## 令牌刷新\r\n\r\n刷新流程说明。\r\n\r\n\r\n\r\n尾部空行忽略。"
	parts := splitIntoChunks(text, 800)
	if len(parts) < 4 {
		t.Fatalf("应至少 4 块（标题×2 自成块+段落聚合）: %d", len(parts))
	}
	if parts[0].heading != "登录安全规范" || parts[0].text != "# 登录安全规范" {
		t.Fatalf("首块应为标题块: %+v", parts[0])
	}
	// 含正文的块应携带标题链（同标题下聚合）
	found := false
	for _, p := range parts {
		if p.heading == "令牌刷新" && strings.Contains(p.text, "刷新流程说明") {
			found = true
		}
	}
	if !found {
		t.Fatalf("二级标题正文块应携带 heading: %+v", parts)
	}
	// 控制字符剔除
	if pp := splitIntoChunks("a\x00b\x07c", 800); len(pp) != 1 || pp[0].text != "abc" {
		t.Fatalf("控制字符应剔除: %+v", pp)
	}
	// 空文档
	if pp := splitIntoChunks("  \n\n \t \n", 800); pp != nil {
		t.Fatalf("空文档应无块: %+v", pp)
	}
	// 超长段落硬切（800 上限，无重叠）
	long := strings.Repeat("长", 2001)
	pp := splitIntoChunks(long, 800)
	if len(pp) != 3 || len([]rune(pp[0].text)) != 800 || len([]rune(pp[2].text)) != 401 {
		t.Fatalf("硬切不符: %d 块 %d/%d 字", len(pp), len([]rune(pp[0].text)), len([]rune(pp[2].text)))
	}
	// 多段落聚合不超上限
	a := strings.Repeat("甲", 500)
	pp = splitIntoChunks(a+"\n\n"+a+"\n\n"+a, 800)
	if len(pp) != 3 { // 500+500 > 800 → 分开；第三段独立
		t.Fatalf("聚合上限不符: %d", len(pp))
	}
}

// TestIngestReady 摄入成功链路：ready + 分块入库 + 配额累计 + 版本
func TestIngestReady(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(map[string]int{"令牌": 0, "红烧肉": 1})})
	ctx := context.Background()
	spaces, err := svc.ListSpaces(ctx, tenantID, alice)
	if err != nil || len(spaces) != 1 || spaces[0].SpaceType != kbrepo.SpacePersonal {
		t.Fatalf("惰性个人空间: %v %+v", err, spaces)
	}
	spaceID := spaces[0].ID

	doc, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, spaceID), 0, "登录规范", "text",
		"# 登录规范\n\n当令牌过期时客户端应静默刷新并重试。\n\n连续失败则强制重新登录。", 0)
	if err != nil {
		t.Fatalf("摄入: %v", err)
	}
	if doc.Status != kbrepo.DocReady || doc.Version != 1 || doc.ErrorMsg != "" {
		t.Fatalf("应 ready v1: %+v", doc)
	}
	chunks, err := svc.ListChunks(ctx, tenantID, alice, mustInt(t, doc.ID))
	if err != nil || len(chunks) < 3 {
		t.Fatalf("分块应 ≥3: %v %+v", err, chunks)
	}
	if chunks[0].HeadingPath != "登录规范" {
		t.Fatalf("首块 heading: %+v", chunks[0])
	}
	// 配额累计（清洗前字节）
	after, _ := svc.ListSpaces(ctx, tenantID, alice)
	if after[0].UsedBytes != doc.Size {
		t.Fatalf("used_bytes 应等于 doc.size: %d vs %d", after[0].UsedBytes, doc.Size)
	}
	// 大纲
	outline, err := svc.GetOutline(ctx, tenantID, alice, mustInt(t, doc.ID))
	if err != nil || len(outline) != 1 || outline[0].HeadingPath != "登录规范" {
		t.Fatalf("大纲: %v %+v", err, outline)
	}
	// 上下文展开（seq=2 前后各 1）
	around, err := svc.ChunksAround(ctx, tenantID, alice, mustInt(t, doc.ID), 2)
	if err != nil || len(around) < 2 {
		t.Fatalf("around: %v %+v", err, around)
	}
}

// TestIngestFailureAndReingest 嵌入失败 → failed+error_msg；修复后重摄入 ready v2
func TestIngestFailureAndReingest(t *testing.T) {
	svc := newTestService(t, Options{Embedder: errEmbed})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	doc, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, spaces[0].ID), 0, "", "text",
		"红烧肉的传统做法与火候掌握", 0)
	if err != nil {
		t.Fatalf("同步版失败应返回文档而非请求错误: %v", err)
	}
	if doc.Status != kbrepo.DocFailed || doc.ErrorMsg == "" {
		t.Fatalf("应 failed+error_msg: %+v", doc)
	}
	// 查询不命中 failed 文档（仅 ready 参与）
	resp, err := svc.Query(ctx, tenantID, alice, nil, "红烧肉", 10)
	if err != nil || len(resp.Items) != 0 {
		t.Fatalf("failed 文档不应命中: %v %+v", err, resp)
	}
	// 换正常嵌入 → 重摄入成功（首次成功代次 v1；配额不重复累计）
	svc2 := New(Options{Embedder: fakeTopical(map[string]int{"红烧肉": 1})}, svc.repo)
	fixed, err := svc2.ReingestDoc(ctx, tenantID, alice, mustInt(t, doc.ID))
	if err != nil || fixed.Status != kbrepo.DocReady || fixed.Version != 1 {
		t.Fatalf("重摄入应 ready v1（首次成功代次）: %v %+v", err, fixed)
	}
	// 再次重摄入 → 代次递增 v2
	again, err := svc2.ReingestDoc(ctx, tenantID, alice, mustInt(t, doc.ID))
	if err != nil || again.Version != 2 {
		t.Fatalf("二次重摄入应 v2: %v %+v", err, again)
	}
	after, _ := svc2.ListSpaces(ctx, tenantID, alice)
	if after[0].UsedBytes != fixed.Size {
		t.Fatalf("重摄入不应重复计配额: %d", after[0].UsedBytes)
	}
}

// TestQueryFusionAndRanking RRF 融合：两文档两主题，查询各自主题均排前 + 高亮
func TestQueryFusionAndRanking(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(map[string]int{"令牌": 0, "红烧肉": 1})})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	sid := mustInt(t, spaces[0].ID)
	// 文档 A：令牌主题；文档 B：红烧肉主题（无字面"令牌过期"连续子串 → 关键词路不命中 A，向量路独证）
	docA, err := svc.IngestDoc(ctx, tenantID, alice, sid, 0, "登录安全", "text",
		"当令牌快要过期时，客户端应当静默刷新令牌并重试请求。", 0)
	if err != nil {
		t.Fatal(err)
	}
	docB, err := svc.IngestDoc(ctx, tenantID, alice, sid, 0, "家常菜谱", "text",
		"红烧肉的传统做法讲究小火慢炖，火候是关键。", 0)
	if err != nil {
		t.Fatal(err)
	}
	// ① 字面命中场景：查询"静默刷新"（两文档均有"静默刷新"？仅 A）→ A 命中且高亮
	resp, err := svc.Query(ctx, tenantID, alice, nil, "静默刷新", 10)
	if err != nil || len(resp.Items) == 0 {
		t.Fatalf("查询应命中: %v %+v", err, resp)
	}
	if resp.Items[0].DocID != docA.ID {
		t.Fatalf("应首条命中文档 A: %+v", resp.Items[0])
	}
	if len(resp.Items[0].Highlight) == 0 {
		t.Fatalf("字面命中应有高亮区间: %+v", resp.Items[0])
	}
	if resp.TookMs < 0 || len(resp.Degraded) != 0 {
		t.Fatalf("took_ms/degraded 异常: %+v", resp)
	}
	// ② 向量路独证场景：查询"令牌过期"——A 文本无该连续子串（关键词路 miss），
	// 但词袋向量共享"令牌"轴 → 向量路命中 A（降级轨/内存余弦同语义）
	resp2, err := svc.Query(ctx, tenantID, alice, nil, "令牌过期", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp2.Items) == 0 || resp2.Items[0].DocID != docA.ID {
		t.Fatalf("向量路应命中文档 A: %+v", resp2.Items)
	}
	// ③ 文档 B 主题命中
	resp3, _ := svc.Query(ctx, tenantID, alice, nil, "红烧肉 火候", 10)
	if len(resp3.Items) == 0 || resp3.Items[0].DocID != docB.ID {
		t.Fatalf("B 主题应命中 B 首: %+v", resp3.Items)
	}
}

// TestQueryPermissionIsolation 权限前置过滤：personal 只本人；company 全员；指定无权空间 7002
func TestQueryPermissionIsolation(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(map[string]int{"令牌": 0, "红烧肉": 1})})
	ctx := context.Background()
	aSpaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	personalID := aSpaces[0].ID
	if _, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, personalID), 0, "私密笔记", "text", "令牌相关私密内容记录", 0); err != nil {
		t.Fatal(err)
	}
	company, err := svc.CreateSpace(ctx, tenantID, alice, kbrepo.SpaceCompany, "全公司知识库", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, company.ID), 0, "公司制度", "text", "令牌相关的公司制度公开内容", 0); err != nil {
		t.Fatal(err)
	}
	// bob：可见 company，不可见 alice personal
	bSpaces, _ := svc.ListSpaces(ctx, tenantID, bob)
	if len(bSpaces) != 2 { // bob 自己的 personal + company
		t.Fatalf("bob 应见 2 空间: %+v", bSpaces)
	}
	resp, err := svc.Query(ctx, tenantID, bob, nil, "令牌", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 1 || resp.Items[0].SpaceID != company.ID {
		t.Fatalf("bob 只应命中 company 文档: %+v", resp.Items)
	}
	// 显式请求无权空间 → 7002
	_, err = svc.Query(ctx, tenantID, bob, []string{personalID}, "令牌", 10)
	if errx.From(err).Code != errx.CodeKBQueryDenied {
		t.Fatalf("应 7002: %v", err)
	}
	// company 全员可写（v0.1 登记：写入收敛到贡献者属阶段二 ACL）
	_, err = svc.IngestDoc(ctx, tenantID, bob, mustInt(t, company.ID), 0, "x", "text", "公司空间全员可写", 0)
	if err != nil {
		t.Fatalf("company 应全员可写（v0.1 登记）: %v", err)
	}
	_, err = svc.IngestDoc(ctx, tenantID, bob, mustInt(t, personalID), 0, "x", "text", "越权写入", 0)
	if errx.From(err).Code != errx.CodeKBQueryDenied {
		t.Fatalf("personal 越权写应拒: %v", err)
	}
}

// TestQueryVectorDegraded 嵌入服务故障 → degraded=vector，关键词路直出
func TestQueryVectorDegraded(t *testing.T) {
	// 先用正常嵌入灌一份 ready 文档
	svc := newTestService(t, Options{Embedder: fakeTopical(map[string]int{"关键词": 0})})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	if _, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, spaces[0].ID), 0, "", "text", "降级模式下的关键词检索测试", 0); err != nil {
		t.Fatal(err)
	}
	// 查询时嵌入服务故障（摄入不受影响——文档已 ready）
	svc2 := New(Options{Embedder: errEmbed}, svc.repo)
	resp, err := svc2.Query(ctx, tenantID, alice, nil, "关键词检索", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) == 0 || resp.Items[0].DocID == "" {
		t.Fatalf("关键词路应直出: %+v", resp)
	}
	if len(resp.Degraded) != 1 || resp.Degraded[0] != "vector" {
		t.Fatalf("应标记 degraded=vector: %+v", resp.Degraded)
	}
}

// TestCreateNodeConstraints 7014 同名 / >10 层 9001
func TestCreateNodeConstraints(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(nil), MaxDepth: 2})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	sid := mustInt(t, spaces[0].ID)
	n1, err := svc.CreateNode(ctx, tenantID, alice, sid, 0, "技术规范")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateNode(ctx, tenantID, alice, sid, 0, "技术规范"); errx.From(err).Code != errx.CodeKBDuplicateNode {
		t.Fatalf("同名应 7014: %v", err)
	}
	// MaxDepth=2：根(0)→n1(1)→n2(2) 合法；n2 下再建 = 3 层 → 拒
	n2, err := svc.CreateNode(ctx, tenantID, alice, sid, mustInt(t, n1.ID), "第二层")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateNode(ctx, tenantID, alice, sid, mustInt(t, n2.ID), "第三层"); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("层数超限应 9001: %v", err)
	}
	// nodes 懒加载：子目录 + 文档分组
	if _, err := svc.IngestDoc(ctx, tenantID, alice, sid, mustInt(t, n1.ID), "挂目录", "text", "目录下的文档", 0); err != nil {
		t.Fatal(err)
	}
	children, err := svc.ListNodes(ctx, tenantID, alice, sid, 0)
	if err != nil || len(children.Dirs) != 1 || len(children.Docs) != 0 {
		t.Fatalf("根下应 1 目录 0 文档: %v %+v", err, children)
	}
	sub, err := svc.ListNodes(ctx, tenantID, alice, sid, mustInt(t, n1.ID))
	if err != nil || len(sub.Docs) != 1 || sub.Docs[0].Title != "挂目录" {
		t.Fatalf("子目录文档: %v %+v", err, sub)
	}
}

// TestQuotaExceeded 配额预检 7004
func TestQuotaExceeded(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(nil), PersonalQuotaBytes: 10})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	_, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, spaces[0].ID), 0, "", "text", "这段文本明显超过十个字节的配额上限", 0)
	if errx.From(err).Code != errx.CodeKBQuotaExceeded {
		t.Fatalf("应 7004: %v", err)
	}
}

// TestFileIngest 文件来源：白名单 7007 / 正常 txt 摄入 / 空文本 9001
func TestFileIngest(t *testing.T) {
	svc := newTestService(t, Options{
		Embedder: fakeTopical(map[string]int{"令牌": 0}),
		OpenFile: func(_ context.Context, _, _, fileID int64) (FileSource, error) {
			if fileID == 404 {
				return FileSource{}, errx.New(errx.CodeFileNotFound, "文件不存在")
			}
			name, body := "notes.md", "# 笔记\n\n令牌刷新要点。"
			if fileID == 2 {
				name, body = "photo.png", "binary"
			}
			return FileSource{Name: name, Ext: extOf(name), ContentType: "text/plain",
				Size: int64(len(body)), Body: io.NopCloser(strings.NewReader(body))}, nil
		},
	})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	sid := mustInt(t, spaces[0].ID)
	doc, err := svc.IngestDoc(ctx, tenantID, alice, sid, 0, "", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if doc.SourceType != kbrepo.SourceFile || doc.SourceRef != "1" || doc.Ext != "md" || doc.Title != "notes.md" {
		t.Fatalf("file 来源字段: %+v", doc)
	}
	if doc.Status != kbrepo.DocReady {
		t.Fatalf("应 ready: %+v", doc)
	}
	// 非白名单 → 7007
	if _, err := svc.IngestDoc(ctx, tenantID, alice, sid, 0, "", "", "", 2); errx.From(err).Code != errx.CodeKBFormatUnsupported {
		t.Fatalf("应 7007: %v", err)
	}
	// 文件不存在 → 透传 4005
	if _, err := svc.IngestDoc(ctx, tenantID, alice, sid, 0, "", "", "", 404); errx.From(err).Code != errx.CodeFileNotFound {
		t.Fatalf("应 4005: %v", err)
	}
	// text 与 file_id 同给 → 9001
	if _, err := svc.IngestDoc(ctx, tenantID, alice, sid, 0, "", "", "两者同给", 1); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("应 9001: %v", err)
	}
}

// TestBuildSnippet 摘要窗口与高亮区间（rune 偏移）
func TestBuildSnippet(t *testing.T) {
	text := strings.Repeat("前缀铺垫内容。", 30) + "这里出现令牌过期关键词，随后继续正文。" + strings.Repeat("后缀内容。", 30)
	snippet, ranges := buildSnippet(text, []string{"令牌过期"}, 60)
	if !strings.Contains(snippet, "令牌过期") {
		t.Fatalf("snippet 应含关键词: %q", snippet)
	}
	r := []rune(snippet)
	for _, rg := range ranges {
		if string(r[rg[0]:rg[1]]) != "令牌过期" {
			t.Fatalf("高亮区间错位: %q", string(r[rg[0]:rg[1]]))
		}
	}
	// 无命中（纯向量路）：取块首，无区间
	s2, r2 := buildSnippet("没有任何命中词的文本", []string{"不存在"}, 20)
	if len(r2) != 0 || len([]rune(s2)) > 20 {
		t.Fatalf("无命中应取块首无区间: %q %+v", s2, r2)
	}
}

// TestMarkdownFormatAndTitle markdown 来源：ext=md + 首标题默认名
func TestMarkdownFormatAndTitle(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(nil)})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	doc, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, spaces[0].ID), 0, "", "markdown", "# 会议纪要标题\n\n正文内容。", 0)
	if err != nil {
		t.Fatal(err)
	}
	if doc.SourceType != kbrepo.SourceMarkdown || doc.Ext != "md" || doc.Title != "会议纪要标题" {
		t.Fatalf("markdown 来源: %+v", doc)
	}
}

// TestJobsSimpleList jobs 简版（docs 按 status 代）
func TestJobsSimpleList(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(nil)})
	ctx := context.Background()
	spaces, _ := svc.ListSpaces(ctx, tenantID, alice)
	sid := mustInt(t, spaces[0].ID)
	if _, err := svc.IngestDoc(ctx, tenantID, alice, sid, 0, "", "text", "就绪文档", 0); err != nil {
		t.Fatal(err)
	}
	all, err := svc.ListJobs(ctx, tenantID, alice, sid, "")
	if err != nil || len(all) != 1 {
		t.Fatalf("jobs 全量: %v %+v", err, all)
	}
	ready, _ := svc.ListJobs(ctx, tenantID, alice, sid, "ready")
	failed, _ := svc.ListJobs(ctx, tenantID, alice, sid, "failed")
	if len(ready) != 1 || len(failed) != 0 {
		t.Fatalf("status 过滤: ready=%d failed=%d", len(ready), len(failed))
	}
}

// ── 小工具 ──

func mustInt(t *testing.T, s string) int64 {
	t.Helper()
	var v int64
	for _, c := range s {
		if c < '0' || c > '9' {
			t.Fatalf("非法 ID: %q", s)
		}
		v = v*10 + int64(c-'0')
	}
	return v
}

// extOf 测试用：文件名 → 小写扩展名
func extOf(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return strings.ToLower(name[i+1:])
	}
	return ""
}

// ACL 接入（03 §4.4 → D07 阶段二）：ACL 显式授权超集——dept 空间授
// viewer 后部门成员可读；company 空间授 editor 后非 owner 可写；
// 无授权回落 v0.1 基线（既有用例零破坏）
func TestACLExplicitGrantWidens(t *testing.T) {
	rule := map[int64]map[int64]int{} // spaceID → uid → perm（测试桩）
	svc := newTestService(t, Options{
		Embedder: fakeTopical(map[string]int{"令牌": 0}),
		ACLPerm: func(_ context.Context, spaceID, userID int64) int {
			return rule[spaceID][userID]
		},
	})
	ctx := context.Background()
	// alice（治理者）建 dept 空间并摄入
	dept, err := svc.CreateSpace(ctx, tenantID, alice, kbrepo.SpaceDept, "研发部知识库", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, dept.ID), 0, "规范", "text", "令牌安全规范", 0); err != nil {
		t.Fatal(err)
	}
	// 基线：bob（非治理者）不可见 dept 空间
	bSpaces, _ := svc.ListSpaces(ctx, tenantID, bob)
	for _, sp := range bSpaces {
		if sp.ID == dept.ID {
			t.Fatal("基线下 bob 不应见 dept 空间")
		}
	}
	// ACL：授 bob viewer → 可见+可检索
	deptID := mustInt(t, dept.ID)
	setACL(rule, deptID, bob, 1)
	bSpaces, _ = svc.ListSpaces(ctx, tenantID, bob)
	hit := false
	for _, sp := range bSpaces {
		if sp.ID == dept.ID {
			hit = true
		}
	}
	if !hit {
		t.Fatal("ACL viewer 后 bob 应见 dept 空间")
	}
	resp, err := svc.Query(ctx, tenantID, bob, []string{dept.ID}, "令牌", 10)
	if err != nil || len(resp.Items) == 0 {
		t.Fatalf("ACL viewer 检索：%v %+v", err, resp)
	}
	// viewer 不可写（7003 语义）
	if _, werr := svc.IngestDoc(ctx, tenantID, bob, mustInt(t, dept.ID), 0, "x", "text", "令牌 y", 0); werr == nil {
		t.Fatal("viewer 不可写")
	}
	// ACL：升 editor → bob 可写
	setACL(rule, deptID, bob, 3)
	if _, werr := svc.IngestDoc(ctx, tenantID, bob, mustInt(t, dept.ID), 0, "补充", "text", "令牌补充说明", 0); werr != nil {
		t.Fatalf("editor 应可写：%v", werr)
	}
	// owner（4）全权
	setACL(rule, deptID, bob, 4)
	if _, werr := svc.IngestDoc(ctx, tenantID, bob, mustInt(t, dept.ID), 0, "再补", "text", "令牌再补", 0); werr != nil {
		t.Fatal(err)
	}
	// ACL 不影响他人基线（uid 1003 无授权仍不可见）
	cSpaces, _ := svc.ListSpaces(ctx, tenantID, 1003)
	for _, sp := range cSpaces {
		if sp.ID == dept.ID {
			t.Fatal("无授权者不应见")
		}
	}
}

func setACL(rule map[int64]map[int64]int, spaceID, uid int64, perm int) {
	if rule[spaceID] == nil {
		rule[spaceID] = map[int64]int{}
	}
	rule[spaceID][uid] = perm
}

// TestKBGrants D4：空间授权管理——治理者校验/添加/列表/撤销 + canRead 放宽生效
func TestKBGrants(t *testing.T) {
	// ACL 闭包 mock：内存授权表 + Resolve 按 grant_type 展开（user 直配/dept 简化为空）
	grants := map[int64]ACLGrantRow{} // grantID → 行
	nextID := int64(1)
	permOf := map[int64]int{} // userID → perm（AddGrant user 授权后回填，模拟 Resolve）
	o := Options{Now: func() time.Time { return time.Now() }}
	o.ACLPerm = func(_ context.Context, spaceID, userID int64) int {
		_ = spaceID
		return permOf[userID]
	}
	o.ACLGrant = func(_ context.Context, spaceID int64, gt int, target int64, perm int, grantedBy int64, expMs int64) (int64, int64, error) {
		id := nextID
		nextID++
		grants[id] = ACLGrantRow{
			GrantID: id, GrantType: gt, GrantTarget: target, Perm: perm,
			GrantedBy: grantedBy, ExpiresAtMs: expMs, CreatedAtMs: time.Now().UnixMilli(),
		}
		if gt == 1 { // user 授权回填 Resolve 视图（dept 展开属 org/acl 职责，此处不模拟）
			permOf[target] = perm
		}
		return id, time.Now().UnixMilli(), nil
	}
	o.ACLListGrants = func(_ context.Context, spaceID int64) ([]ACLGrantRow, error) {
		_ = spaceID
		out := make([]ACLGrantRow, 0, len(grants))
		for _, g := range grants {
			out = append(out, g)
		}
		return out, nil
	}
	o.ACLRevoke = func(_ context.Context, spaceID, grantID int64) error {
		if _, ok := grants[grantID]; !ok {
			return kbrepo.ErrNotFound
		}
		delete(grants, grantID)
		return nil
	}
	svc := newTestService(t, o)
	ctx := context.Background()

	// bob 建部门空间（owner=bob）；建一篇文档
	sp, err := svc.CreateSpace(ctx, 1, bob, "dept", "研发部知识库", 0)
	if err != nil {
		t.Fatalf("建空间: %v", err)
	}
	spaceID, _ := strconv.ParseInt(sp.ID, 10, 64)
	if _, err := svc.IngestDoc(ctx, 1, bob, spaceID, 0, "规范", "md", "# 规范\n内容", 0); err != nil {
		t.Fatalf("摄入: %v", err)
	}

	// 非治理者（alice）管理 → 7002 拒
	if _, err := svc.ListGrants(ctx, 1, alice, spaceID); errx.From(err).Code != errx.CodeKBQueryDenied {
		t.Fatalf("非治理者列表应 7002: %v", err)
	}
	// bob 授 alice contributor（perm 3）→ alice 可读可写（canRead/canWrite 放宽）
	row, err := svc.AddGrant(ctx, 1, bob, spaceID, kbapi.GrantReq{GrantType: 1, GrantTarget: "1001", Perm: 3})
	if err != nil {
		t.Fatalf("授权: %v", err)
	}
	if _, err := svc.ListNodes(ctx, 1, alice, spaceID, 0); err != nil {
		t.Fatalf("alice 授权后应可浏览: %v", err)
	}
	if _, err := svc.IngestDoc(ctx, 1, alice, spaceID, 0, "alice 的文档", "md", "# a", 0); err != nil {
		t.Fatalf("contributor 应可摄入: %v", err)
	}
	// perm 非法集 → 9001
	if _, err := svc.AddGrant(ctx, 1, bob, spaceID, kbapi.GrantReq{GrantType: 1, GrantTarget: "1001", Perm: 2}); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("perm=2 应 9001: %v", err)
	}
	// 列表含 alice 行；撤销后 alice 失去写权（permOf 回滚由 Resolve 视图模拟——
	// mock 不联动，改验证 ACLRevoke 路径 + 列表为空）
	rows, err := svc.ListGrants(ctx, 1, bob, spaceID)
	if err != nil || len(rows) != 1 || rows[0].GrantTarget != "1001" || rows[0].Perm != 3 {
		t.Fatalf("授权列表不符: %v %+v", err, rows)
	}
	gid, _ := strconv.ParseInt(row.ID, 10, 64)
	if err := svc.RemoveGrant(ctx, 1, bob, spaceID, gid); err != nil {
		t.Fatalf("撤销: %v", err)
	}
	rows, _ = svc.ListGrants(ctx, 1, bob, spaceID)
	if len(rows) != 0 {
		t.Fatalf("撤销后列表应空: %+v", rows)
	}
}

// TestKBGovernance D8：空间停用即刻生效（检索/浏览挡）/启用恢复/级联删除/personal 7010/
// filtered_hint（OQ-D10：他人不可见空间存在 → 检索提示"部分结果被策略隐藏"）
func TestKBGovernance(t *testing.T) {
	o := Options{Embedder: fakeTopical(map[string]int{"规范": 0})}
	svc := newTestService(t, o)
	ctx := context.Background()

	// bob 建公司空间 + 摄入；alice 建个人空间（对 bob 不可见）
	sp, err := svc.CreateSpace(ctx, 1, bob, "company", "治理空间", 0)
	if err != nil {
		t.Fatal(err)
	}
	spaceID, _ := strconv.ParseInt(sp.ID, 10, 64)
	if _, err := svc.IngestDoc(ctx, 1, bob, spaceID, 0, "安全规范", "md", "# 安全规范\n规范内容", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateSpace(ctx, 1, alice, "personal", "alice 私有", 0); err != nil {
		t.Fatal(err)
	}

	// filtered_hint：bob 检索时存在不可见空间（alice 个人空间）→ 提示
	res, err := svc.Query(ctx, 1, bob, nil, "规范", 5)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if res.FilteredHint != "部分结果被策略隐藏" {
		t.Fatalf("filtered_hint 应提示: %q", res.FilteredHint)
	}

	// 停用：即刻生效（canRead 挡——浏览 7002；检索 targets 不含该空间）
	if err := svc.GovernSetSpaceStatus(ctx, 1, spaceID, true); err != nil {
		t.Fatalf("停用: %v", err)
	}
	if _, err := svc.ListNodes(ctx, 1, bob, spaceID, 0); errx.From(err).Code != errx.CodeKBSpaceArchived {
		t.Fatalf("停用后浏览应 7013（归档专用码）: %v", err)
	}
	res2, err := svc.Query(ctx, 1, bob, nil, "规范", 5)
	if err != nil || len(res2.Items) != 0 {
		t.Fatalf("停用后检索不应命中: %v %+v", err, res2.Items)
	}
	// 指定停用空间检索 → 7002（不可见语义一致）
	sidStr := strconv.FormatInt(spaceID, 10)
	if _, err := svc.Query(ctx, 1, bob, []string{sidStr}, "规范", 5); errx.From(err).Code != errx.CodeKBQueryDenied {
		t.Fatalf("指定停用空间应 7002: %v", err)
	}

	// 启用恢复
	if err := svc.GovernSetSpaceStatus(ctx, 1, spaceID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ListNodes(ctx, 1, bob, spaceID, 0); err != nil {
		t.Fatalf("启用后应可浏览: %v", err)
	}

	// 级联删除：空间消失
	if err := svc.GovernDeleteSpace(ctx, 1, spaceID); err != nil {
		t.Fatalf("删除: %v", err)
	}
	if _, err := svc.ListNodes(ctx, 1, bob, spaceID, 0); errx.From(err).Code != errx.CodeKBSpaceNotFound {
		t.Fatalf("删除后应 7001: %v", err)
	}

	// personal 不可删 7010
	personal, err := svc.CreateSpace(ctx, 1, alice, "personal", "p2", 0)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.ParseInt(personal.ID, 10, 64)
	if err := svc.GovernDeleteSpace(ctx, 1, pid); errx.From(err).Code != errx.CodeKBPersonalProtected {
		t.Fatalf("personal 删除应 7010: %v", err)
	}
}

// TestDeptSpaceAncestorChainVisibility 三层知识检索 dept 可见性（2026-11 收口）：
// dept 空间挂靠部门 ∈ 用户祖先链并集 → 可见——父部门知识对子部门成员可见、
// 兄弟部门互不可见、多部门取并集、创建缺省挂主部门、显式越权拒 9001
func TestDeptSpaceAncestorChainVisibility(t *testing.T) {
	// 部门树：研发中心(10) → 后端部(11) → 基础架构组(12)；市场部(13)
	svc := newTestService(t, Options{
		UserDeptIDsOf: func(_ context.Context, _ int64, userID int64) (map[int64]bool, int64, error) {
			switch userID {
			case alice: // alice 挂 研发中心+市场部（主=研发中心）
				return map[int64]bool{10: true, 13: true}, 10, nil
			case bob: // bob 挂 基础架构组（深层，主部门）
				return map[int64]bool{12: true}, 12, nil
			}
			return map[int64]bool{}, 0, nil
		},
		UserDeptChainOf: func(_ context.Context, _ int64, userID int64) (map[int64]bool, error) {
			switch userID {
			case alice:
				return map[int64]bool{10: true, 13: true}, nil
			case bob: // 祖先链 12→11→10（深度无关）
				return map[int64]bool{12: true, 11: true, 10: true}, nil
			}
			return map[int64]bool{}, nil
		},
	})
	ctx := context.Background()

	rd, err := svc.CreateSpace(ctx, tenantID, alice, "dept", "研发中心知识库", 10)
	if err != nil {
		t.Fatal(err)
	}
	if rd.DeptID != "10" {
		t.Fatalf("显式挂靠: %s", rd.DeptID)
	}
	mkt, err := svc.CreateSpace(ctx, tenantID, alice, "dept", "市场部知识库", 13)
	if err != nil {
		t.Fatal(err)
	}
	bobSp, err := svc.CreateSpace(ctx, tenantID, bob, "dept", "基础架构组知识库", 0)
	if err != nil {
		t.Fatal(err)
	}
	if bobSp.DeptID != "12" {
		t.Fatalf("缺省应自动挂主部门: %s", bobSp.DeptID)
	}

	// bob（深层 12）可见：祖先 10 空间 ✓、自己 12 ✓、兄弟 13 ✗
	spaces, err := svc.ListSpaces(ctx, tenantID, bob)
	if err != nil {
		t.Fatal(err)
	}
	has := map[string]bool{}
	for _, sp := range spaces {
		has[sp.ID] = true
	}
	if !has[rd.ID] || !has[bobSp.ID] {
		t.Fatalf("bob 应见祖先+自身部门空间: %+v", has)
	}
	if has[mkt.ID] {
		t.Fatal("兄弟部门空间不应可见")
	}
	// alice 可见：10 ✓ 13 ✓；下级部门 12 的空间不可见（知识沿树向下流，不向上）
	spacesAlice, _ := svc.ListSpaces(ctx, tenantID, alice)
	hasA := map[string]bool{}
	for _, sp := range spacesAlice {
		hasA[sp.ID] = true
	}
	if !hasA[rd.ID] || !hasA[mkt.ID] || hasA[bobSp.ID] {
		t.Fatalf("alice 可见集不符（下级部门知识不向上流）: %+v", hasA)
	}

	// 显式挂靠非本人部门 → 9001
	if _, err := svc.CreateSpace(ctx, tenantID, bob, "dept", "越权空间", 13); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("越权挂靠应 9001: %v", err)
	}
	// 指定不可见空间检索 → 7002（防空间探测，既有语义回归）
	if _, err := svc.Query(ctx, tenantID, bob, []string{mkt.ID}, "x", 5); errx.From(err).Code != errx.CodeKBQueryDenied {
		t.Fatalf("不可见空间检索应 7002: %v", err)
	}
}

// TestDeptSpaceOwnerFallback 通道未装配/未挂部门：dept 空间回落 OwnerID（兼容旧口径）
func TestDeptSpaceOwnerFallback(t *testing.T) {
	svc := newTestService(t, Options{}) // 两个部门闭包均未装配
	ctx := context.Background()
	sp, err := svc.CreateSpace(ctx, tenantID, alice, "dept", "旧口径空间", 0)
	if err != nil {
		t.Fatal(err)
	}
	if sp.DeptID != "0" {
		t.Fatalf("未装配通道缺省不挂靠: %s", sp.DeptID)
	}
	spaces, _ := svc.ListSpaces(ctx, tenantID, bob)
	for _, s := range spaces {
		if s.ID == sp.ID {
			t.Fatal("他人不应可见未挂靠的 dept 空间")
		}
	}
	if _, err := svc.CreateSpace(ctx, tenantID, alice, "dept", "显式但无法校验", 9); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("通道未装配显式 dept_id 应 9001: %v", err)
	}
}
