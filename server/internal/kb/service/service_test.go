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

// personalOf 取用户个人维度行 ID（D24 两维度：ListSpaces=[company, personal]）
func personalOf(t *testing.T, svc *Service, uid int64) string {
	t.Helper()
	spaces, err := svc.ListSpaces(context.Background(), tenantID, uid)
	if err != nil {
		t.Fatal(err)
	}
	for _, sp := range spaces {
		if sp.SpaceType == kbrepo.SpacePersonal {
			return sp.ID
		}
	}
	t.Fatalf("personal 维度行缺失: %+v", spaces)
	return ""
}

// companyOf 取公司知识库维度行 ID
func companyOf(t *testing.T, svc *Service) string {
	t.Helper()
	spaces, err := svc.ListSpaces(context.Background(), tenantID, alice)
	if err != nil {
		t.Fatal(err)
	}
	for _, sp := range spaces {
		if sp.SpaceType == kbrepo.SpaceCompany {
			return sp.ID
		}
	}
	t.Fatalf("company 维度行缺失: %+v", spaces)
	return ""
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
	if err != nil || len(spaces) != 2 { // D24 两维度：company（种子）+ personal（惰性）
		t.Fatalf("两维度行: %v %+v", err, spaces)
	}
	spaceID := personalOf(t, svc, alice)

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
	// 配额累计（清洗前字节；计入个人维度行）
	after, _ := svc.ListSpaces(ctx, tenantID, alice)
	var personalUsed int64
	for _, sp := range after {
		if sp.SpaceType == kbrepo.SpacePersonal {
			personalUsed = sp.UsedBytes
		}
	}
	if personalUsed != doc.Size {
		t.Fatalf("used_bytes 应等于 doc.size: %d vs %d", personalUsed, doc.Size)
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
	doc, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, personalOf(t, svc, alice)), 0, "", "text",
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
	var usedAfter int64
	for _, sp := range after {
		if sp.SpaceType == kbrepo.SpacePersonal {
			usedAfter = sp.UsedBytes
		}
	}
	if usedAfter != fixed.Size {
		t.Fatalf("重摄入不应重复计配额: %d", usedAfter)
	}
}

// TestQueryFusionAndRanking RRF 融合：两文档两主题，查询各自主题均排前 + 高亮
func TestQueryFusionAndRanking(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(map[string]int{"令牌": 0, "红烧肉": 1})})
	ctx := context.Background()
	sid := mustInt(t, personalOf(t, svc, alice))
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

// TestQueryPermissionIsolation D24 两维度权限：公司知识库全员可看可投、我的笔记仅
// 本人（他人 personal 不进可见宇宙）；指定无权空间 7002
func TestQueryPermissionIsolation(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(map[string]int{"令牌": 0, "红烧肉": 1})})
	ctx := context.Background()
	personalID := personalOf(t, svc, alice)
	companyID := companyOf(t, svc)
	if _, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, companyID), 0, "公司制度", "text", "令牌相关的公司制度公开内容", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, personalID), 0, "私密笔记", "text", "令牌相关私密内容记录", 0); err != nil {
		t.Fatal(err)
	}
	// bob：固定两维度行（company+自己的 personal）；alice personal 不可见
	bSpaces, _ := svc.ListSpaces(ctx, tenantID, bob)
	if len(bSpaces) != 2 {
		t.Fatalf("bob 应见 2 维度行: %+v", bSpaces)
	}
	for _, sp := range bSpaces {
		if sp.SpaceType == kbrepo.SpacePersonal && sp.ID == personalID {
			t.Fatalf("bob 不应见 alice personal: %+v", bSpaces)
		}
	}
	resp, err := svc.Query(ctx, tenantID, bob, nil, "令牌", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 1 || resp.Items[0].SpaceID != companyID {
		t.Fatalf("bob 只应命中 company 文档: %+v", resp.Items)
	}
	// 显式请求无权空间 → 7002
	_, err = svc.Query(ctx, tenantID, bob, []string{personalID}, "令牌", 10)
	if errx.From(err).Code != errx.CodeKBQueryDenied {
		t.Fatalf("应 7002: %v", err)
	}
	// company 全员可投（D24 拍板：公共维度全员可写）
	if _, err := svc.IngestDoc(ctx, tenantID, bob, mustInt(t, companyID), 0, "x", "text", "公司空间全员可投", 0); err != nil {
		t.Fatalf("company 应全员可投: %v", err)
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
	if _, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, personalOf(t, svc, alice)), 0, "", "text", "降级模式下的关键词检索测试", 0); err != nil {
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
	sid := mustInt(t, personalOf(t, svc, alice))
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
	_, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, personalOf(t, svc, alice)), 0, "", "text", "这段文本明显超过十个字节的配额上限", 0)
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
	sid := mustInt(t, personalOf(t, svc, alice))
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
	doc, err := svc.IngestDoc(ctx, tenantID, alice, mustInt(t, personalOf(t, svc, alice)), 0, "", "markdown", "# 会议纪要标题\n\n正文内容。", 0)
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
	sid := mustInt(t, personalOf(t, svc, alice))
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

// TestKBGovernance D8+D24：维度行停用即刻生效（检索/浏览挡）/启用恢复/级联删除/
// personal 7010/filtered_hint（OQ-D10：两维度下提示仅在维度行被治理停用时出现——
// 他人 personal 不属可见宇宙，不触发）
func TestKBGovernance(t *testing.T) {
	o := Options{Embedder: fakeTopical(map[string]int{"规范": 0})}
	svc := newTestService(t, o)
	ctx := context.Background()

	// bob 在公司知识库投稿；alice personal 存在但对 bob 不属可见宇宙
	spaceID := mustInt(t, companyOf(t, svc))
	if _, err := svc.IngestDoc(ctx, 1, bob, spaceID, 0, "安全规范", "md", "# 安全规范\n规范内容", 0); err != nil {
		t.Fatal(err)
	}
	_ = personalOf(t, svc, alice)

	// 两维度均在 → 无隐藏提示
	res, err := svc.Query(ctx, 1, bob, nil, "规范", 5)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if res.FilteredHint != "" {
		t.Fatalf("两维度可见不应提示: %q", res.FilteredHint)
	}

	// 停用 company：即刻生效（canRead 挡——浏览 7013；检索 targets 不含该维度；hint 触发）
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
	if res2.FilteredHint != "部分结果被策略隐藏" {
		t.Fatalf("维度停用应触发 filtered_hint: %q", res2.FilteredHint)
	}
	// 指定停用维度检索 → 7002（不可见语义一致）
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

	// 级联删除：维度行消失（下次 ListSpaces 幂等种子新行——治理清库语义）
	if err := svc.GovernDeleteSpace(ctx, 1, spaceID); err != nil {
		t.Fatalf("删除: %v", err)
	}
	if _, err := svc.ListNodes(ctx, 1, bob, spaceID, 0); errx.From(err).Code != errx.CodeKBSpaceNotFound {
		t.Fatalf("删除后应 7001: %v", err)
	}

	// personal 不可删 7010
	pid := mustInt(t, personalOf(t, svc, alice))
	if err := svc.GovernDeleteSpace(ctx, 1, pid); errx.From(err).Code != errx.CodeKBPersonalProtected {
		t.Fatalf("personal 删除应 7010: %v", err)
	}
}


// TestViewCountAndSummary D24：浏览量日去重（一人一天一篇计 1）+作者本人不计+概览联动
func TestViewCountAndSummary(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(nil)})
	ctx := context.Background()
	companyID := mustInt(t, companyOf(t, svc))
	doc, err := svc.IngestDoc(ctx, tenantID, alice, companyID, 0, "公开文", "text", "公开内容若干", 0)
	if err != nil {
		t.Fatal(err)
	}
	did := mustInt(t, doc.ID)
	// 作者本人浏览：不计
	v, err := svc.RecordDocView(ctx, tenantID, alice, did)
	if err != nil || v.ViewCount != 0 {
		t.Fatalf("作者浏览不应计数: %v %+v", err, v)
	}
	// bob 同日两次：只计 1
	if v, _ = svc.RecordDocView(ctx, tenantID, bob, did); v.ViewCount != 1 {
		t.Fatalf("首次他人浏览应 1: %+v", v)
	}
	if v, _ = svc.RecordDocView(ctx, tenantID, bob, did); v.ViewCount != 1 {
		t.Fatalf("同日重复浏览不涨: %+v", v)
	}
	// 第三人：2
	if v, _ = svc.RecordDocView(ctx, tenantID, 1003, did); v.ViewCount != 2 {
		t.Fatalf("第三人应 2: %+v", v)
	}
	// 概览联动：alice 总浏览 2/公司作者榜第 1；bob 无公司文章未上榜
	sum, err := svc.MySummary(ctx, tenantID, alice)
	if err != nil || sum.TotalViews != 2 || sum.DocCount != 1 || sum.AuthorRank != 1 {
		t.Fatalf("alice 概览: %v %+v", err, sum)
	}
	sumBob, _ := svc.MySummary(ctx, tenantID, bob)
	if sumBob.AuthorRank != 0 {
		t.Fatalf("bob 无公司文章应未上榜: %+v", sumBob)
	}
}

// TestRankingsCompanyOnly D24：榜单只收公共维度；latest 降序/hot 窗口聚合/authors 聚合
func TestRankingsCompanyOnly(t *testing.T) {
	svc := newTestService(t, Options{Embedder: fakeTopical(nil)})
	ctx := context.Background()
	companyID := mustInt(t, companyOf(t, svc))
	personalID := mustInt(t, personalOf(t, svc, bob))
	a, _ := svc.IngestDoc(ctx, tenantID, alice, companyID, 0, "公司文A", "text", "A 内容", 0)
	b, _ := svc.IngestDoc(ctx, tenantID, alice, companyID, 0, "公司文B", "text", "B 内容", 0)
	// bob 的个人维度文：不该进任何榜
	if _, err := svc.IngestDoc(ctx, tenantID, bob, personalID, 0, "私有文P", "text", "P 内容", 0); err != nil {
		t.Fatal(err)
	}
	// 制造浏览：A ×2（bob 两次同人同日=1 + 1003=1）
	_, _ = svc.RecordDocView(ctx, tenantID, bob, mustInt(t, a.ID))
	_, _ = svc.RecordDocView(ctx, tenantID, 1003, mustInt(t, a.ID))

	// latest：B 在前（created_at 降序），仅 2 条（P 不进榜）
	lat, err := svc.Rankings(ctx, tenantID, alice, "latest", "")
	if err != nil || len(lat.Docs) != 2 || lat.Docs[0].Title != "公司文B" {
		t.Fatalf("latest 榜: %v %+v", err, lat.Docs)
	}
	// hot 总榜：A hot=2 居首
	hotAll, err := svc.Rankings(ctx, tenantID, alice, "hot", "all")
	if err != nil || len(hotAll.Docs) != 2 || hotAll.Docs[0].Title != "公司文A" || hotAll.Docs[0].Hot != 2 {
		t.Fatalf("hot 总榜: %v %+v", err, hotAll.Docs)
	}
	// hot 7d 窗口（今日在内）：A 仍 2
	hot7, err := svc.Rankings(ctx, tenantID, alice, "hot", "7d")
	if err != nil || hot7.Docs[0].Title != "公司文A" || hot7.Docs[0].Hot != 2 {
		t.Fatalf("hot 7d 榜: %v %+v", err, hot7.Docs)
	}
	// authors：alice 第 1（2 文 2 浏览）；bob 个人文不计
	au, err := svc.Rankings(ctx, tenantID, alice, "authors", "")
	if err != nil || len(au.Authors) != 1 || au.Authors[0].Rank != 1 || au.Authors[0].DocCount != 2 || au.Authors[0].TotalViews != 2 {
		t.Fatalf("作者榜: %v %+v", err, au.Authors)
	}
	_ = b
}
