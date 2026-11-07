// Package kbservice 知识库域业务逻辑（D07 阶段一务实版）。
// 核心链路：空间治理（惰性 personal/配额）→ 目录树（≤10 层/7014 同名）→
// 摄入管线同步版（清洗分段 ≤800 字 → 注入 EmbedFn 嵌入 → 落 kb_chunk → ready；
// 失败 failed+error_msg 可重试）→ 混合检索（权限前置过滤 → 向量余弦 + 关键词 ILIKE
// → RRF 融合 k=60 → 高亮区间）。
// v0.1 登记不做：异步队列/进度轮询（同步返回）、部门树授权（dept 空间仅治理者）、
// kb_query_log 审计、敏感标记、reranker 重排（RRF 序直出，11 §4.3 降级口径）。
package kbservice

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	kbapi "github.com/baobaowork/server/internal/kb/api"
	kbrepo "github.com/baobaowork/server/internal/kb/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// EmbedFn 嵌入函数注入（生产=HTTP 自调 AI 网关 bbw-embed 1024 维；测试=假嵌入不走网络）
type EmbedFn func(ctx context.Context, input []string) ([][]float32, error)

// FileSource D06 文件内容（IngestDoc file 来源经 OpenFile 取回）
type FileSource struct {
	Name        string
	Ext         string // 小写无点
	ContentType string
	Size        int64
	Body        io.Reader
}

// FileOpener 文件内容读取注入（main 经 file 域票据通道装配：IssueTicket→Download）
type FileOpener func(ctx context.Context, tenantID, userID, fileID int64) (FileSource, error)

// Options 策略参数
type Options struct {
	PersonalQuotaBytes int64 // 个人空间默认配额（缺省 5GB，11 §4.5）
	CompanyQuotaBytes  int64 // 公司空间默认配额（缺省 20GB）
	DeptQuotaBytes     int64 // 部门空间默认配额（缺省 10GB）
	MaxDocBytes        int64 // 原文上限（缺省 2MB → 7006；D07 32MB/2000 页属解析器场景）
	MaxChunkRunes      int   // 分块上限（缺省 800 字）
	MaxDepth           int   // 目录层数上限（缺省 10，11 §2.2）
	EmbedBatch         int   // 嵌入批量（缺省 64——网关 /v1/embeddings 单请求上限）
	Now                func() time.Time
	Embedder           EmbedFn
	OpenFile           FileOpener
	// ACLPerm 资源级 ACL 查询（03 §4.4；kb.space 资源键——nil 或返回 0=
	// 无显式授权，回落 v0.1 三级空间基线；ACL 命中=显式授权超集：可放宽
	// 如 dept 空间授部门 viewer）。返回值：0 none / 1 viewer / 2
	// commenter / 3 editor / 4 owner（org/acl Perm 语义，闭包传 int 解耦）
	ACLPerm func(ctx context.Context, spaceID, userID int64) int
}

func (o *Options) fillDefaults() {
	if o.PersonalQuotaBytes == 0 {
		o.PersonalQuotaBytes = 5 << 30 // 5GB
	}
	if o.CompanyQuotaBytes == 0 {
		o.CompanyQuotaBytes = 20 << 30
	}
	if o.DeptQuotaBytes == 0 {
		o.DeptQuotaBytes = 10 << 30
	}
	if o.MaxDocBytes == 0 {
		o.MaxDocBytes = 2 << 20 // 2MB（v0.1 无分卷上传，7006 提示拆分）
	}
	if o.MaxChunkRunes == 0 {
		o.MaxChunkRunes = 800
	}
	if o.MaxDepth == 0 {
		o.MaxDepth = 10
	}
	if o.EmbedBatch == 0 {
		o.EmbedBatch = 64
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// kbIngestExtWhitelist 文件来源扩展名白名单（v0.1 纯文本可解析；7007 格式不支持）
var kbIngestExtWhitelist = map[string]bool{"txt": true, "md": true, "markdown": true}

// Service 实现 kbapi.KBService
type Service struct {
	repo kbrepo.Repo
	opts Options
}

// New 构造
func New(opts Options, r kbrepo.Repo) *Service {
	opts.fillDefaults()
	return &Service{repo: r, opts: opts}
}

var _ kbapi.KBService = (*Service)(nil)

// ── 空间 ──

// ListSpaces 可见空间（个人空间惰性创建）
func (s *Service) ListSpaces(ctx context.Context, tenantID, userID int64) ([]kbapi.SpaceDTO, error) {
	if _, err := s.repo.EnsurePersonalSpace(ctx, tenantID, userID, s.opts.PersonalQuotaBytes); err != nil {
		return nil, errx.From(err)
	}
	all, err := s.repo.ListSpaces(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]kbapi.SpaceDTO, 0, len(all))
	for _, sp := range all {
		if !s.canRead(ctx, sp, userID) {
			continue
		}
		docs, err := s.repo.ListDocsBySpace(ctx, tenantID, sp.ID)
		if err != nil {
			return nil, errx.From(err)
		}
		dto := toSpaceDTO(sp)
		dto.DocCount = int64(len(docs))
		out = append(out, dto)
	}
	return out, nil
}

// CreateSpace 新建（dept|company；personal 惰性创建幂等返回既有）
func (s *Service) CreateSpace(ctx context.Context, tenantID, userID int64, spaceType, name string) (*kbapi.SpaceDTO, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 64 {
		return nil, errx.New(errx.CodeBadRequest, "空间名非法（非空 ≤64 字）")
	}
	switch spaceType {
	case kbrepo.SpacePersonal: // 惰性创建语义：幂等返回既有个人空间
		sp, err := s.repo.EnsurePersonalSpace(ctx, tenantID, userID, s.opts.PersonalQuotaBytes)
		if err != nil {
			return nil, errx.From(err)
		}
		dto := toSpaceDTO(sp)
		return &dto, nil
	case kbrepo.SpaceDept, kbrepo.SpaceCompany:
		// v0.1 不校验 kb:space:create 权限点（阶段二接权限点字典，登记）
	default:
		return nil, errx.New(errx.CodeBadRequest, "空间类型非法（personal|dept|company）")
	}
	quota := s.opts.CompanyQuotaBytes
	if spaceType == kbrepo.SpaceDept {
		quota = s.opts.DeptQuotaBytes
	}
	sp, err := s.repo.CreateSpace(ctx, kbrepo.Space{
		TenantID: tenantID, SpaceType: spaceType, Name: name, OwnerID: userID,
		QuotaBytes: quota, Status: "active",
	})
	if err != nil {
		return nil, errx.From(err)
	}
	dto := toSpaceDTO(sp)
	return &dto, nil
}

// ── 目录 ──

// ListNodes 懒加载（子目录 + 目录下文档）
func (s *Service) ListNodes(ctx context.Context, tenantID, userID, spaceID, parentID int64) (*kbapi.NodeChildren, error) {
	sp, err := s.getSpaceFor(ctx, userID, spaceID, false)
	if err != nil {
		return nil, err
	}
	if parentID != 0 { // 父目录须在本空间且未删（7005）
		n, err := s.repo.GetNode(ctx, parentID)
		if err != nil || n.SpaceID != sp.ID {
			return nil, errx.New(errx.CodeKBNodeNotFound, "父目录不存在")
		}
	}
	dirs, err := s.repo.ListChildNodes(ctx, tenantID, spaceID, parentID)
	if err != nil {
		return nil, errx.From(err)
	}
	docs, err := s.repo.ListDocsByNode(ctx, tenantID, spaceID, parentID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := &kbapi.NodeChildren{Dirs: make([]kbapi.NodeDTO, 0, len(dirs)), Docs: make([]kbapi.DocDTO, 0, len(docs))}
	for _, n := range dirs {
		out.Dirs = append(out.Dirs, toNodeDTO(n))
	}
	for _, d := range docs {
		out.Docs = append(out.Docs, toDocDTO(d))
	}
	return out, nil
}

// CreateNode 新建目录（7014 同名；>10 层 9001）
func (s *Service) CreateNode(ctx context.Context, tenantID, userID, spaceID, parentID int64, name string) (*kbapi.NodeDTO, error) {
	_, err := s.getSpaceFor(ctx, userID, spaceID, true)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 128 {
		return nil, errx.New(errx.CodeBadRequest, "目录名非法（非空 ≤128 字）")
	}
	// 层数校验：沿父链上溯计数（v0.1 无物化路径，逐跳；深度 ≤10）
	depth := 1
	for p := parentID; p != 0; {
		n, err := s.repo.GetNode(ctx, p)
		if err != nil || n.SpaceID != spaceID {
			return nil, errx.New(errx.CodeKBNodeNotFound, "父目录不存在")
		}
		depth++
		p = n.ParentID
		if depth > s.opts.MaxDepth {
			return nil, errx.New(errx.CodeBadRequest, "目录层数超上限（10 层）")
		}
	}
	n, err := s.repo.CreateNode(ctx, kbrepo.Node{
		TenantID: tenantID, SpaceID: spaceID, ParentID: parentID,
		NodeType: "dir", Name: name, Status: "active", CreatedBy: userID,
	})
	if err != nil {
		if err == kbrepo.ErrDupNode {
			return nil, errx.New(errx.CodeKBDuplicateNode, "同级已有同名目录")
		}
		return nil, errx.From(err)
	}
	dto := toNodeDTO(n)
	return &dto, nil
}

// ── 摄入（同步版 v0.1）──

// IngestDoc 摄入主链路：来源解析 → 配额预检 → 建行(processing) → 管线 → 终态
func (s *Service) IngestDoc(ctx context.Context, tenantID, userID, spaceID, nodeID int64, title, format, text string, fileID int64) (*kbapi.DocDTO, error) {
	sp, err := s.getSpaceFor(ctx, userID, spaceID, true)
	if err != nil {
		return nil, err
	}
	if nodeID != 0 {
		n, err := s.repo.GetNode(ctx, nodeID)
		if err != nil || n.SpaceID != spaceID {
			return nil, errx.New(errx.CodeKBNodeNotFound, "目录不存在")
		}
	}

	var (
		content    string
		sourceType string
		sourceRef  string
		ext        string
	)
	if fileID != 0 {
		// 文件来源：经注入的 OpenFile 读 D06 文件内容（票据通道；owner/成员校验在 file 域）
		if fileID < 0 {
			return nil, errx.New(errx.CodeBadRequest, "file_id 非法")
		}
		if strings.TrimSpace(text) != "" {
			return nil, errx.New(errx.CodeBadRequest, "text 与 file_id 二选一")
		}
		src, err := s.openFileSafe(ctx, tenantID, userID, fileID)
		if err != nil {
			return nil, err
		}
		if !kbIngestExtWhitelist[src.Ext] {
			return nil, errx.New(errx.CodeKBFormatUnsupported, "该格式暂不支持摄入（支持 txt/md/markdown）")
		}
		body, rerr := readAllWithLimit(src.Body, s.opts.MaxDocBytes)
		if rerr != nil {
			if errors.Is(rerr, errTooLarge) {
				return nil, errx.New(errx.CodeKBDocTooLarge, "文档超大拒入，请拆分后上传")
			}
			return nil, errx.New(errx.CodeInternal, "文件读取失败")
		}
		content = body
		sourceType = kbrepo.SourceFile
		sourceRef = strconv.FormatInt(fileID, 10)
		ext = src.Ext
		if title == "" {
			title = src.Name
		}
	} else {
		// 文本来源：format 缺省 text；markdown 保留标题结构供分段
		switch format {
		case "", "text":
			format = "text"
			ext = "txt"
		case "markdown", "md":
			format = "markdown"
			ext = "md"
		default:
			return nil, errx.New(errx.CodeBadRequest, "format 非法（text|markdown）")
		}
		if strings.TrimSpace(text) == "" {
			return nil, errx.New(errx.CodeBadRequest, "text 不能为空")
		}
		if int64(len(text)) > s.opts.MaxDocBytes {
			return nil, errx.New(errx.CodeKBDocTooLarge, "文档超大拒入，请拆分后上传")
		}
		content = text
		sourceType = format
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = defaultTitle(content)
	}
	if utf8.RuneCountInString(title) > 128 {
		title = string([]rune(title)[:128])
	}
	docSize := int64(len(content)) // 配额按清洗前原文字节数计（11 §4.5）
	// 配额预检（上传前预检 → 7004）
	if sp.UsedBytes+docSize > sp.QuotaBytes {
		return nil, errx.New(errx.CodeKBQuotaExceeded, "空间配额超限")
	}

	doc, err := s.repo.CreateDoc(ctx, kbrepo.Doc{
		TenantID: tenantID, SpaceID: spaceID, NodeID: nodeID,
		Title: title, SourceType: sourceType, SourceRef: sourceRef, Ext: ext,
		Size: docSize, Status: kbrepo.DocProcessing, Version: 0,
		Content: content, CreatedBy: userID,
	})
	if err != nil {
		return nil, errx.From(err)
	}
	return s.runPipeline(ctx, doc, content)
}

// ReingestDoc 重摄入（version+1；file 来源重读文件）
func (s *Service) ReingestDoc(ctx context.Context, tenantID, userID, docID int64) (*kbapi.DocDTO, error) {
	d, err := s.repo.GetDoc(ctx, docID)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "文档不存在")
	}
	if _, err := s.getSpaceFor(ctx, userID, d.SpaceID, true); err != nil {
		return nil, err
	}
	content := d.Content
	if d.SourceType == kbrepo.SourceFile { // 文件来源：重读（源失效 → failed 终态）
		fileID, _ := strconv.ParseInt(d.SourceRef, 10, 64)
		src, err := s.openFileSafe(ctx, tenantID, userID, fileID)
		if err != nil {
			_ = s.repo.FailDoc(ctx, docID, "源文件读取失败: "+err.Error(), s.opts.Now())
			if d2, gerr := s.repo.GetDoc(ctx, docID); gerr == nil {
				dto := toDocDTO(*d2)
				return &dto, nil
			}
			return nil, err
		}
		body, rerr := readAllWithLimit(src.Body, s.opts.MaxDocBytes)
		if rerr != nil {
			if !errors.Is(rerr, errTooLarge) {
				_ = s.repo.FailDoc(ctx, docID, "源文件读取失败: "+rerr.Error(), s.opts.Now())
			} else {
				_ = s.repo.FailDoc(ctx, docID, "源文件超大（7006）", s.opts.Now())
			}
			if d2, gerr := s.repo.GetDoc(ctx, docID); gerr == nil {
				dto := toDocDTO(*d2)
				return &dto, nil
			}
			return nil, errx.New(errx.CodeKBDocTooLarge, "文档超大拒入")
		}
		content = body
	}
	return s.runPipeline(ctx, *d, content)
}

// runPipeline 摄入管线（同步）：清洗分段 → 批量嵌入 → IngestCommit(ready)；
// 任一失败 → FailDoc(7003 语义内化，终态返回) —— 摄入失败是数据状态而非请求失败，
// 返回 200 + failed 文档（重试走 ReingestDoc；登记）
func (s *Service) runPipeline(ctx context.Context, d kbrepo.Doc, content string) (*kbapi.DocDTO, error) {
	parts := splitIntoChunks(content, s.opts.MaxChunkRunes)
	if len(parts) == 0 {
		_ = s.repo.FailDoc(ctx, d.ID, "文档内容为空（清洗后无可摄入文本）", s.opts.Now())
		if d2, err := s.repo.GetDoc(ctx, d.ID); err == nil {
			dto := toDocDTO(*d2)
			return &dto, nil
		}
		dto := toDocDTO(d)
		dto.Status = kbrepo.DocFailed
		dto.ErrorMsg = "文档内容为空"
		return &dto, nil
	}
	texts := make([]string, len(parts))
	for i, p := range parts {
		texts[i] = p.text
	}
	embeds, err := s.embedBatched(ctx, texts)
	if err != nil { // 7008 语义：嵌入服务不可用 → failed 挂起（同步版即终态，重试入口）
		_ = s.repo.FailDoc(ctx, d.ID, "嵌入服务不可用: "+err.Error(), s.opts.Now())
		if d2, gerr := s.repo.GetDoc(ctx, d.ID); gerr == nil {
			dto := toDocDTO(*d2)
			return &dto, nil
		}
		dto := toDocDTO(d)
		dto.Status = kbrepo.DocFailed
		dto.ErrorMsg = "嵌入服务不可用"
		return &dto, nil
	}
	chunks := make([]kbrepo.Chunk, len(parts))
	for i, p := range parts {
		emb := []float32(nil)
		if i < len(embeds) {
			emb = embeds[i]
		}
		chunks[i] = kbrepo.Chunk{
			Seq: i + 1, HeadingPath: p.heading, Text: p.text,
			TokenCount: utf8.RuneCountInString(p.text), Embedding: emb,
		}
	}
	// 配额增量：仅首次转 ready 计入（重摄入替换不重复计数）
	usedDelta := int64(0)
	if d.Status != kbrepo.DocReady {
		usedDelta = d.Size
	}
	committed, err := s.repo.IngestCommit(ctx, d.ID, chunks, usedDelta, s.opts.Now())
	if err != nil {
		_ = s.repo.FailDoc(ctx, d.ID, "索引提交失败: "+err.Error(), s.opts.Now())
		if d2, gerr := s.repo.GetDoc(ctx, d.ID); gerr == nil {
			dto := toDocDTO(*d2)
			return &dto, nil
		}
		return nil, errx.From(err)
	}
	dto := toDocDTO(committed)
	return &dto, nil
}

// embedBatched 分批嵌入（网关单请求 1-64 条上限）
func (s *Service) embedBatched(ctx context.Context, texts []string) ([][]float32, error) {
	if s.opts.Embedder == nil {
		return nil, errx.New(errx.CodeKBEmbeddingDown, "未装配嵌入服务")
	}
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += s.opts.EmbedBatch {
		end := start + s.opts.EmbedBatch
		if end > len(texts) {
			end = len(texts)
		}
		vecs, err := s.opts.Embedder(ctx, texts[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, vecs...)
	}
	return out, nil
}

// openFileSafe 经注入通道读文件（file 域 4005/4013 语义透传）
func (s *Service) openFileSafe(ctx context.Context, tenantID, userID, fileID int64) (FileSource, error) {
	if s.opts.OpenFile == nil {
		return FileSource{}, errx.New(errx.CodeInternal, "未装配文件读取通道")
	}
	src, err := s.opts.OpenFile(ctx, tenantID, userID, fileID)
	if err != nil {
		return FileSource{}, err
	}
	if src.Ext == "" { // 扩展名兜底：从文件名截
		if i := strings.LastIndex(src.Name, "."); i >= 0 {
			src.Ext = strings.ToLower(src.Name[i+1:])
		}
	}
	return src, nil
}

// ── 文档/分块 ──

// GetDoc 详情
func (s *Service) GetDoc(ctx context.Context, tenantID, userID, docID int64) (*kbapi.DocDTO, error) {
	d, err := s.repo.GetDoc(ctx, docID)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "文档不存在")
	}
	if _, err := s.getSpaceFor(ctx, userID, d.SpaceID, false); err != nil {
		return nil, err
	}
	dto := toDocDTO(*d)
	return &dto, nil
}

// ListChunks 分块全量
func (s *Service) ListChunks(ctx context.Context, tenantID, userID, docID int64) ([]kbapi.ChunkDTO, error) {
	if _, err := s.docOfReadable(ctx, tenantID, userID, docID); err != nil {
		return nil, err
	}
	chunks, err := s.repo.ListChunks(ctx, tenantID, docID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]kbapi.ChunkDTO, 0, len(chunks))
	for _, c := range chunks {
		out = append(out, kbapi.ChunkDTO{
			Seq: c.Seq, HeadingPath: c.HeadingPath, Content: c.Text, TokenCount: c.TokenCount,
		})
	}
	return out, nil
}

// GetOutline 大纲（heading_path 去重 + 首块锚点）
func (s *Service) GetOutline(ctx context.Context, tenantID, userID, docID int64) ([]kbapi.OutlineItem, error) {
	if _, err := s.docOfReadable(ctx, tenantID, userID, docID); err != nil {
		return nil, err
	}
	chunks, err := s.repo.ListChunks(ctx, tenantID, docID)
	if err != nil {
		return nil, errx.From(err)
	}
	seen := map[string]bool{}
	out := make([]kbapi.OutlineItem, 0, 8)
	for _, c := range chunks {
		if c.HeadingPath == "" || seen[c.HeadingPath] {
			continue
		}
		seen[c.HeadingPath] = true
		out = append(out, kbapi.OutlineItem{HeadingPath: c.HeadingPath, Seq: c.Seq})
	}
	return out, nil
}

// ChunksAround 上下文展开（seq 前后各 1 块）
func (s *Service) ChunksAround(ctx context.Context, tenantID, userID, docID int64, seq int) ([]kbapi.ChunkDTO, error) {
	if _, err := s.docOfReadable(ctx, tenantID, userID, docID); err != nil {
		return nil, err
	}
	chunks, err := s.repo.ListChunksAround(ctx, tenantID, docID, seq, 1, 1)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]kbapi.ChunkDTO, 0, len(chunks))
	for _, c := range chunks {
		out = append(out, kbapi.ChunkDTO{
			Seq: c.Seq, HeadingPath: c.HeadingPath, Content: c.Text, TokenCount: c.TokenCount,
		})
	}
	return out, nil
}

// ListJobs jobs 简版（docs 按 status 列表代；status 空=全量）
func (s *Service) ListJobs(ctx context.Context, tenantID, userID, spaceID int64, status string) ([]kbapi.DocDTO, error) {
	if _, err := s.getSpaceFor(ctx, userID, spaceID, false); err != nil {
		return nil, err
	}
	docs, err := s.repo.ListDocsBySpace(ctx, tenantID, spaceID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]kbapi.DocDTO, 0, len(docs))
	for _, d := range docs {
		if status != "" && d.Status != status {
			continue
		}
		out = append(out, toDocDTO(d))
	}
	return out, nil
}

// ── 检索 ──

// rrfK RRF 常数（11 §4.3：两路排名融合；k=60 通用值）
const rrfK = 60

// fused 检索融合中间态（RRF 分 + 两路原始分/名次，供并列排序）
type fused struct {
	hit      kbrepo.ChunkHit
	vecScore float64
	kwScore  float64
	vecRank  int
	kwRank   int
	rrf      float64
}

// Query 混合检索：可见空间集（权限前置过滤，绝不做检索后过滤）→
// A 路向量余弦（Embedder 嵌入查询词）+ B 路关键词 ILIKE → RRF 融合 → snippet/高亮
func (s *Service) Query(ctx context.Context, tenantID, userID int64, spaceIDs []string, keyword string, topK int) (*kbapi.QueryResp, error) {
	start := s.opts.Now()
	keyword = strings.TrimSpace(keyword)
	if keyword == "" {
		return nil, errx.New(errx.CodeBadRequest, "keyword 必填")
	}
	if utf8.RuneCountInString(keyword) > 512 {
		return nil, errx.New(errx.CodeBadRequest, "keyword ≤512 字")
	}
	if topK <= 0 {
		topK = 10
	}
	if topK > 20 {
		topK = 20 // D07 §5.2 top_k ≤20
	}
	// 可见空间集（含 personal 惰性创建 → 新用户至少可检索个人空间）
	if _, err := s.repo.EnsurePersonalSpace(ctx, tenantID, userID, s.opts.PersonalQuotaBytes); err != nil {
		return nil, errx.From(err)
	}
	all, err := s.repo.ListSpaces(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	visible := make([]kbrepo.Space, 0, len(all))
	for _, sp := range all {
		if s.canRead(ctx, sp, userID) {
			visible = append(visible, sp)
		}
	}
	// 请求指定空间 → 交集；指定空间不可见 → 7002（不做静默剔除，防空间名探测歧义）
	targets := visible
	if len(spaceIDs) > 0 {
		want := make(map[int64]bool, len(spaceIDs))
		for _, sid := range spaceIDs {
			id, err := strconv.ParseInt(sid, 10, 64)
			if err != nil {
				return nil, errx.New(errx.CodeBadRequest, "space_ids 含非法 ID")
			}
			want[id] = true
		}
		filtered := make([]kbrepo.Space, 0, len(want))
		for _, sp := range visible {
			if want[sp.ID] {
				filtered = append(filtered, sp)
			}
		}
		if len(filtered) != len(want) {
			return nil, errx.New(errx.CodeKBQueryDenied, "无其中一个空间的检索权限")
		}
		targets = filtered
	}
	targetIDs := make([]int64, 0, len(targets))
	spaceTypeOf := map[int64]string{}
	for _, sp := range targets {
		targetIDs = append(targetIDs, sp.ID)
		spaceTypeOf[sp.ID] = sp.SpaceType
	}

	resp := &kbapi.QueryResp{Items: []kbapi.QueryHit{}, Degraded: []string{}}
	if len(targetIDs) == 0 {
		resp.TookMs = msSince(start, s.opts.Now())
		return resp, nil
	}

	// B 路：关键词 ILIKE（tokens=空白切分；整串也参与——中文关键词无空格场景）
	tokens := splitKeywordTokens(keyword)
	kwHits, err := s.repo.SearchKeyword(ctx, tenantID, targetIDs, tokens, topK)
	if err != nil {
		return nil, errx.From(err)
	}
	// A 路：查询词嵌入 → 向量余弦（嵌入失败 → degraded=vector，B 路直出，11 §7.2）
	var vecHits []kbrepo.ChunkHit
	if s.opts.Embedder != nil {
		vecs, eerr := s.embedBatched(ctx, []string{keyword})
		if eerr != nil || len(vecs) == 0 {
			resp.Degraded = append(resp.Degraded, "vector")
		} else if vhits, verr := s.repo.SearchVector(ctx, tenantID, targetIDs, vecs[0], topK); verr != nil {
			resp.Degraded = append(resp.Degraded, "vector")
		} else {
			vecHits = vhits
		}
	} else {
		resp.Degraded = append(resp.Degraded, "vector")
	}

	// RRF 融合：score = Σ 1/(k + rank)；同 chunk 双路命中自然领先
	order := map[int64]*fused{}
	for rank, h := range vecHits {
		order[h.ChunkID] = &fused{hit: h, vecScore: h.Score, vecRank: rank + 1, rrf: 1.0 / float64(rrfK+rank+1)}
	}
	for rank, h := range kwHits {
		if f, ok := order[h.ChunkID]; ok {
			f.kwScore, f.kwRank = h.Score, rank+1
			f.rrf += 1.0 / float64(rrfK+rank+1)
		} else {
			order[h.ChunkID] = &fused{hit: h, kwScore: h.Score, kwRank: rank + 1, rrf: 1.0 / float64(rrfK+rank+1)}
		}
	}
	all2 := make([]*fused, 0, len(order))
	for _, f := range order {
		all2 = append(all2, f)
	}
	// 排序：RRF 降序 → 向量分 → 词命中（稳定并列语义）
	for i := 1; i < len(all2); i++ {
		for j := i; j > 0 && fusedLess(all2[j], all2[j-1]); j-- {
			all2[j], all2[j-1] = all2[j-1], all2[j]
		}
	}
	if len(all2) > topK {
		all2 = all2[:topK]
	}
	for _, f := range all2 {
		snippet, ranges := buildSnippet(f.hit.Text, tokens, 200)
		resp.Items = append(resp.Items, kbapi.QueryHit{
			DocID:       strconv.FormatInt(f.hit.DocID, 10),
			Title:       f.hit.DocTitle,
			SpaceID:     strconv.FormatInt(f.hit.SpaceID, 10),
			SpaceType:   spaceTypeOf[f.hit.SpaceID],
			ChunkSeq:    f.hit.Seq,
			HeadingPath: f.hit.HeadingPath,
			Snippet:     snippet,
			Highlight:   ranges,
			Score:       f.rrf,
		})
	}
	resp.TookMs = msSince(start, s.opts.Now())
	return resp, nil
}

// fusedLess 融合序比较（RRF → 向量分 → 词命中数）
func fusedLess(a, b *fused) bool {
	if a.rrf != b.rrf {
		return a.rrf > b.rrf
	}
	if a.vecScore != b.vecScore {
		return a.vecScore > b.vecScore
	}
	return a.kwScore > b.kwScore
}

// splitKeywordTokens 关键词切分：空白分词 + 原整串（中文无空格场景整串 ILIKE）
func splitKeywordTokens(keyword string) []string {
	tokens := []string{}
	for _, f := range strings.Fields(keyword) {
		if !containsStr(tokens, f) {
			tokens = append(tokens, f)
		}
	}
	if !containsStr(tokens, keyword) {
		tokens = append(tokens, keyword)
	}
	return tokens
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// buildSnippet 摘要 + 高亮区间（rune 偏移，客户端按码点渲染 <mark>）：
// 首命中前后各留窗口；无命中（纯向量路）取块首。区间数封顶 5
func buildSnippet(text string, tokens []string, maxRunes int) (string, [][2]int) {
	runes := []rune(text)
	first := -1
	for _, t := range tokens {
		if t == "" {
			continue
		}
		if idx := indexOfFold(runes, []rune(t)); idx >= 0 && (first < 0 || idx < first) {
			first = idx
		}
	}
	// 窗口定位：首命中前置 2/5 窗宽的上下文（命中可靠入窗；纯向量路取块首）
	start := 0
	if first > maxRunes*2/5 {
		start = first - maxRunes*2/5
	}
	end := start + maxRunes
	if end > len(runes) {
		end = len(runes)
	}
	snippet := runes[start:end]
	ranges := [][2]int{}
	for _, t := range tokens {
		if t == "" {
			continue
		}
		tr := []rune(t)
		for i := 0; i+len(tr) <= len(snippet); i++ {
			if runesEqualFold(snippet[i:i+len(tr)], tr) {
				ranges = append(ranges, [2]int{i, i + len(tr)})
				i += len(tr) - 1
			}
		}
	}
	if len(ranges) > 5 {
		ranges = ranges[:5]
	}
	return string(snippet), ranges
}

// indexOfFold 大小写不敏感子串定位（rune 级）
func indexOfFold(hay, needle []rune) int {
	if len(needle) == 0 || len(needle) > len(hay) {
		return -1
	}
	for i := 0; i+len(needle) <= len(hay); i++ {
		if runesEqualFold(hay[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

func runesEqualFold(a, b []rune) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if lowerRune(a[i]) != lowerRune(b[i]) {
			return false
		}
	}
	return true
}

func lowerRune(r rune) rune {
	if r >= 'A' && r <= 'Z' {
		return r + 32
	}
	return r
}

// ── 分段（清洗 → 标题感知 → 块 ≤maxRunes）──

type chunkPart struct {
	heading string
	text    string
}

// splitIntoChunks 清洗（\r\n 归一/控制字符剔除/连续空行压缩）→
// 空行分段（标题行留在段内供检索，# 前缀同步更新 heading_path 标题链）→
// 每段一块（≤maxRunes 字；超长段硬切无重叠——D07 512/重叠 64 属 token 级
// 结构感知分块，阶段二，登记）
func splitIntoChunks(text string, maxRunes int) []chunkPart {
	cleaned := cleanText(text)
	if strings.TrimSpace(cleaned) == "" {
		return nil
	}
	lines := strings.Split(cleaned, "\n")
	var out []chunkPart
	curHeading := ""
	var buf []string
	flush := func() {
		body := strings.Join(buf, "\n")
		buf = nil
		if strings.TrimSpace(body) == "" {
			return
		}
		r := []rune(body)
		for start := 0; start < len(r); start += maxRunes {
			end := start + maxRunes
			if end > len(r) {
				end = len(r)
			}
			out = append(out, chunkPart{heading: curHeading, text: string(r[start:end])})
		}
	}
	for _, ln := range lines {
		if strings.TrimSpace(ln) == "" {
			flush()
			continue
		}
		if h, ok := headingOf(strings.TrimSpace(ln)); ok {
			curHeading = h // 标题链更新（标题文本仍在段内可检索）
		}
		buf = append(buf, ln)
	}
	flush()
	return out
}

// headingOf markdown 标题行（#{1,6} 前缀）→ 标题链（父级保持，' > ' 连接）
func headingOf(line string) (string, bool) {
	if len(line) < 2 || line[0] != '#' {
		return "", false
	}
	level := 0
	for level < len(line) && line[level] == '#' {
		level++
	}
	if level > 6 || level >= len(line) || line[level] != ' ' {
		return "", false
	}
	return strings.TrimSpace(line[level+1:]), true
}

// cleanText \r\n 归一 + 控制字符剔除（保留 \n/\t）+ 连续空行压缩为单个空行
// （单个空行是分段边界——splitIntoChunks 依赖，不可全删）
func cleanText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	var b strings.Builder
	b.Grow(len(text))
	newlines := 0
	for _, r := range text {
		if r != '\n' && r != '\t' && (r < 0x20 || r == 0x7f) {
			continue // 控制字符剔除（清洗，11 §4.2）
		}
		if r == '\n' {
			newlines++
			if newlines > 2 { // 2+ 空行（3+ 连续 \n）压缩为 1 空行
				continue
			}
		} else {
			newlines = 0
		}
		b.WriteRune(r)
	}
	return strings.Trim(b.String(), "\n")
}

// defaultTitle 默认标题：首个 markdown 标题 → 首个非空行（≤32 字）
func defaultTitle(content string) string {
	for _, ln := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(ln)
		if trimmed == "" {
			continue
		}
		if h, ok := headingOf(trimmed); ok {
			trimmed = h
		}
		r := []rune(trimmed)
		if len(r) > 32 {
			r = r[:32]
		}
		return strings.TrimPrefix(string(r), "# ")
	}
	return "未命名文档"
}

// ── 权限（v0.1：personal 只本人 + company 全员可读；dept 仅治理者，部门树阶段二）──

// canRead 读权限（检索/浏览/详情）：ACL 显式授权（≥viewer）优先——
// 可放宽基线（如 dept 空间授部门 viewer，11 §2.1）；无授权回落
// v0.1 基线（personal 本人/company 全员/dept 治理者）
func (s *Service) canRead(ctx context.Context, sp kbrepo.Space, userID int64) bool {
	if s.opts.ACLPerm != nil && s.opts.ACLPerm(ctx, sp.ID, userID) >= 1 { // viewer
		return true
	}
	switch sp.SpaceType {
	case kbrepo.SpacePersonal:
		return sp.OwnerID == userID
	case kbrepo.SpaceCompany:
		return true // 全员 reader（11 §2.1）
	case kbrepo.SpaceDept:
		return sp.OwnerID == userID
	}
	return false
}

// canWrite 写权限（摄入/建目录/重摄入）：ACL ≥editor 优先（D07"写入
// 收敛到贡献者"=公司空间显式授权 editor 者可写，收紧基线）；无授权回落
// v0.1 基线（personal/dept=治理者；company=全员）
func (s *Service) canWrite(ctx context.Context, sp kbrepo.Space, userID int64) bool {
	if s.opts.ACLPerm != nil && s.opts.ACLPerm(ctx, sp.ID, userID) >= 3 { // editor
		return true
	}
	if sp.SpaceType == kbrepo.SpaceCompany {
		return true
	}
	return sp.OwnerID == userID
}

// getSpaceFor 空间存在性 + 权限校验（写路径 requireWrite）
func (s *Service) getSpaceFor(ctx context.Context, userID, spaceID int64, requireWrite bool) (*kbrepo.Space, error) {
	sp, err := s.repo.GetSpace(ctx, spaceID)
	if err != nil {
		return nil, errx.New(errx.CodeKBSpaceNotFound, "空间不存在")
	}
	if sp.Status != "active" {
		return nil, errx.New(errx.CodeKBSpaceArchived, "空间已归档停用")
	}
	allowed := s.canRead(ctx, *sp, userID)
	if requireWrite {
		allowed = s.canWrite(ctx, *sp, userID)
	}
	if !allowed {
		return nil, errx.New(errx.CodeKBQueryDenied, "无该空间的访问权限")
	}
	return sp, nil
}

// docOfReadable 可读文档定位（7002 语义：无权不暴露存在性）
func (s *Service) docOfReadable(ctx context.Context, tenantID, userID, docID int64) (*kbrepo.Doc, error) {
	d, err := s.repo.GetDoc(ctx, docID)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "文档不存在")
	}
	if _, err := s.getSpaceFor(ctx, userID, d.SpaceID, false); err != nil {
		return nil, err
	}
	return d, nil
}

// ── DTO 映射 ──

func toSpaceDTO(s kbrepo.Space) kbapi.SpaceDTO {
	return kbapi.SpaceDTO{
		ID: strconv.FormatInt(s.ID, 10), SpaceType: s.SpaceType, Name: s.Name,
		OwnerID: strconv.FormatInt(s.OwnerID, 10), QuotaBytes: s.QuotaBytes,
		UsedBytes: s.UsedBytes, CreatedAt: s.CreatedAt.UnixMilli(),
	}
}

func toNodeDTO(n kbrepo.Node) kbapi.NodeDTO {
	parent := ""
	if n.ParentID != 0 {
		parent = strconv.FormatInt(n.ParentID, 10)
	}
	return kbapi.NodeDTO{
		ID: strconv.FormatInt(n.ID, 10), SpaceID: strconv.FormatInt(n.SpaceID, 10),
		ParentID: parent, Name: n.Name, CreatedAt: n.CreatedAt.UnixMilli(),
	}
}

func toDocDTO(d kbrepo.Doc) kbapi.DocDTO {
	node := ""
	if d.NodeID != 0 {
		node = strconv.FormatInt(d.NodeID, 10)
	}
	return kbapi.DocDTO{
		ID: strconv.FormatInt(d.ID, 10), SpaceID: strconv.FormatInt(d.SpaceID, 10),
		NodeID: node, Title: d.Title, SourceType: d.SourceType, SourceRef: d.SourceRef,
		Ext: d.Ext, Size: d.Size, Status: d.Status, ErrorMsg: d.ErrorMsg,
		Version: d.Version, CreatedBy: strconv.FormatInt(d.CreatedBy, 10),
		CreatedAt: d.CreatedAt.UnixMilli(), UpdatedAt: d.UpdatedAt.UnixMilli(),
	}
}

// readAllWithLimit 带上限读取（超限报错；调用方关 Body）
func readAllWithLimit(r io.Reader, limit int64) (string, error) {
	buf, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(buf)) > limit {
		return "", errTooLarge
	}
	if c, ok := r.(io.Closer); ok {
		_ = c.Close()
	}
	return string(buf), nil
}

var errTooLarge = errx.New(errx.CodeKBDocTooLarge, "too large")

func msSince(start, end time.Time) int64 {
	ms := end.Sub(start).Milliseconds()
	if ms < 0 {
		return 0
	}
	return ms
}
