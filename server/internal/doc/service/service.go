// Package docservice 文档中心域业务逻辑（D05 阶段一务实版）。
// 核心链路：新建（v1 create 快照）→ 乐观锁保存（base_version 校验 6004 →
// manual 快照 version+1 → 冗余正文回写）→ 版本时间线（倒序翻页）→ 恢复
// （restore 快照新版本，绝不覆盖 06 §4.5）→ 回收站（软删 purge_at+30d /
// 恢复同名加" (恢复)"后缀）→ 分享占位（一次性 share_id+7d，不落库）。
// v0.1 登记：全 owner 私有（非 owner 6001/6005，scope/ACL 阶段二）；
// 保留期固定 30 天（租户策略 7-90 可配阶段二）；到期物理清除定时任务阶段二
// （ListTrash/ListFiles 过滤过期行——过期条目对客户端不可见即"已删除"口径）。
package docservice

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	docapi "github.com/baobaowork/server/internal/doc/api"
	docrepo "github.com/baobaowork/server/internal/doc/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// Options 策略参数（Now 时钟注入供测试）
type Options struct {
	RetainDays int           // 回收站保留期（默认 30 天，06 §4.7）
	ShareTTL   time.Duration // 分享有效期（默认 7d）
	PageSize   int           // 列表页大小上限（默认 50）
	MaxTitle   int           // 标题上限（rune，默认 120）
	MaxContent int           // 正文上限（rune，默认 512KB）
	Now        func() time.Time
}

func (o *Options) fillDefaults() {
	if o.RetainDays == 0 {
		o.RetainDays = 30
	}
	if o.ShareTTL == 0 {
		o.ShareTTL = 7 * 24 * time.Hour
	}
	if o.PageSize == 0 {
		o.PageSize = 50
	}
	if o.MaxTitle == 0 {
		o.MaxTitle = 120
	}
	if o.MaxContent == 0 {
		o.MaxContent = 512 << 10
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Service 实现 docapi.DocService
type Service struct {
	repo docrepo.Repo
	opts Options
}

// New 构造
func New(opts Options, r docrepo.Repo) *Service {
	opts.fillDefaults()
	return &Service{repo: r, opts: opts}
}

var _ docapi.DocService = (*Service)(nil)

// mustOwner 取活跃态文档并校验 owner（非 owner → 6001；不存在 → 6005；
// 回收站态 → 6005——"不存在或已在回收站"同码，06 §6.3）
func (s *Service) mustOwner(ctx context.Context, tenantID, userID, docID int64, wantStatus int) (*docrepo.DocFile, error) {
	f, err := s.repo.GetFile(ctx, docID)
	if err != nil {
		return nil, errx.New(errx.CodeDocNotFound, "文档不存在或已移入回收站")
	}
	if f.TenantID != tenantID {
		return nil, errx.New(errx.CodeDocNotFound, "文档不存在或已移入回收站") // 跨租户等同不存在（RLS 兜底之外的显式判定）
	}
	if f.OwnerID != userID {
		// v0.1 全 owner 私有：他人文档一律 6001 无编辑权限（scope/ACL 阶段二放开）
		return nil, errx.New(errx.CodeDocNoEditPerm, "无该文档的编辑权限")
	}
	if wantStatus > 0 && f.Status != wantStatus {
		return nil, errx.New(errx.CodeDocNotFound, "文档不存在或已移入回收站")
	}
	return f, nil
}

// validateTitle 标题校验（非空 ≤MaxTitle rune；去首尾空白）
func (s *Service) validateTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > s.opts.MaxTitle {
		return "", errx.New(errx.CodeBadRequest, "标题非法（非空 ≤120 字）")
	}
	return title, nil
}

// ── 文档 ──

// ListFiles owner 活跃文档列表（q 模糊 + 键集翻页）
func (s *Service) ListFiles(ctx context.Context, tenantID, userID int64, q, cursorStr string, limit int) (*docapi.DocListResp, error) {
	if limit <= 0 || limit > s.opts.PageSize {
		limit = s.opts.PageSize
	}
	cursor, err := parseCursor(cursorStr)
	if err != nil {
		return nil, err
	}
	files, err := s.repo.ListFiles(ctx, tenantID, userID, strings.TrimSpace(q), cursor, limit+1)
	if err != nil {
		return nil, errx.From(err)
	}
	hasMore := len(files) > limit
	if hasMore {
		files = files[:limit]
	}
	resp := &docapi.DocListResp{Items: make([]docapi.DocFileDTO, 0, len(files)), HasMore: hasMore}
	for _, f := range files {
		resp.Items = append(resp.Items, toFileDTO(f, false))
	}
	if hasMore && len(files) > 0 {
		last := files[len(files)-1]
		resp.NextCursor = buildCursor(last.UpdatedAt.UnixMilli(), last.ID)
	}
	return resp, nil
}

// CreateFile 新建 markdown 文档（v1 空白 create 快照）
func (s *Service) CreateFile(ctx context.Context, tenantID, userID int64, title string) (*docapi.DocFileDTO, error) {
	title, err := s.validateTitle(title)
	if err != nil {
		return nil, err
	}
	f, _, err := s.repo.CreateFile(ctx, docrepo.DocFile{
		TenantID: tenantID, OwnerID: userID, Title: title, FolderID: 0,
		Scope: "personal", ContentMD: "",
	})
	if err != nil {
		if errors.Is(err, docrepo.ErrDupTitle) {
			return nil, errx.New(errx.CodeDocRenameConflict, "同名文档已存在")
		}
		return nil, errx.From(err)
	}
	dto := toFileDTO(f, false)
	return &dto, nil
}

// GetFile 元数据+当前正文
func (s *Service) GetFile(ctx context.Context, tenantID, userID, docID int64) (*docapi.DocFileDTO, error) {
	f, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusActive)
	if err != nil {
		return nil, err
	}
	dto := toFileDTO(*f, true)
	return &dto, nil
}

// RenameFile 重命名（6015 同名）
func (s *Service) RenameFile(ctx context.Context, tenantID, userID, docID int64, title string) (*docapi.DocFileDTO, error) {
	if _, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusActive); err != nil {
		return nil, err
	}
	title, err := s.validateTitle(title)
	if err != nil {
		return nil, err
	}
	f, err := s.repo.RenameFile(ctx, docID, title, s.opts.Now())
	if err != nil {
		if errors.Is(err, docrepo.ErrDupTitle) {
			return nil, errx.New(errx.CodeDocRenameConflict, "同名文档已存在")
		}
		if errors.Is(err, docrepo.ErrNotFound) {
			return nil, errx.New(errx.CodeDocNotFound, "文档不存在或已移入回收站")
		}
		return nil, errx.From(err)
	}
	dto := toFileDTO(*f, false)
	return &dto, nil
}

// TrashFile 移入回收站（purge_at=now+保留期）
func (s *Service) TrashFile(ctx context.Context, tenantID, userID, docID int64) (*docapi.DocFileDTO, error) {
	if _, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusActive); err != nil {
		return nil, err
	}
	now := s.opts.Now()
	f, err := s.repo.TrashFile(ctx, docID, now.AddDate(0, 0, s.opts.RetainDays), now)
	if err != nil {
		if errors.Is(err, docrepo.ErrNotFound) {
			return nil, errx.New(errx.CodeDocNotFound, "文档不存在或已移入回收站")
		}
		return nil, errx.From(err)
	}
	dto := toFileDTO(*f, false)
	return &dto, nil
}

// SaveContent 乐观锁保存（6004 冲突 / manual 快照 version+1 / 冗余正文回写）
func (s *Service) SaveContent(ctx context.Context, tenantID, userID, docID, baseVersion int64, contentMD string) (*docapi.SaveContentResp, error) {
	if _, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusActive); err != nil {
		return nil, err
	}
	if utf8.RuneCountInString(contentMD) > s.opts.MaxContent {
		return nil, errx.New(errx.CodeDocTooLarge, "正文超过大小上限（512KB）")
	}
	if baseVersion <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "base_version 必填（乐观锁基线）")
	}
	f, v, err := s.repo.SaveContent(ctx, docID, userID, baseVersion, contentMD, s.opts.Now())
	if err != nil {
		if errors.Is(err, docrepo.ErrVersionConflict) {
			// 06 §7.1 语义：base_version 落后 → 拒绝并提示（客户端红条+强制覆盖选项）
			return nil, errx.New(errx.CodeDocVersionConflic, "版本冲突：文档已被他人修改，请基于最新版本重试或强制覆盖")
		}
		if errors.Is(err, docrepo.ErrNotFound) {
			return nil, errx.New(errx.CodeDocNotFound, "文档不存在或已移入回收站")
		}
		return nil, errx.From(err)
	}
	return &docapi.SaveContentResp{
		File:        toFileDTO(f, false),
		Version:     toVersionDTO(v, false),
		NextVersion: v.Version,
	}, nil
}

// ── 版本 ──

// ListVersions 版本时间线（version 倒序；cursor 为上一页末条 version 字符串）
func (s *Service) ListVersions(ctx context.Context, tenantID, userID, docID int64, cursorStr string, limit int) (*docapi.VersionListResp, error) {
	if _, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusActive); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > s.opts.PageSize {
		limit = s.opts.PageSize
	}
	cursor := int64(0)
	if cursorStr != "" {
		n, err := strconv.ParseInt(cursorStr, 10, 64)
		if err != nil || n <= 0 {
			return nil, errx.New(errx.CodeBadRequest, "cursor 非法")
		}
		cursor = n
	}
	items, err := s.repo.ListVersions(ctx, tenantID, docID, cursor, limit+1)
	if err != nil {
		return nil, errx.From(err)
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	resp := &docapi.VersionListResp{Items: make([]docapi.DocVersionDTO, 0, len(items)), HasMore: hasMore}
	for _, v := range items {
		dto := toVersionDTO(v, false)
		if v.SnapshotType == docrepo.SnapRestore {
			dto.Note = "恢复快照"
		}
		resp.Items = append(resp.Items, dto)
	}
	if hasMore && len(items) > 0 {
		resp.NextCursor = strconv.Itoa(items[len(items)-1].Version)
	}
	return resp, nil
}

// RestoreVersion 恢复目标版本（restore 快照新版本+正文回写；6013 目标不存在）
func (s *Service) RestoreVersion(ctx context.Context, tenantID, userID, docID int64, version int) (*docapi.RestoreResp, error) {
	if _, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusActive); err != nil {
		return nil, err
	}
	if version <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "目标版本号非法")
	}
	f, v, err := s.repo.RestoreVersion(ctx, docID, userID, version, s.opts.Now())
	if err != nil {
		if errors.Is(err, docrepo.ErrNotFound) {
			// 文档行缺失 → 6005；目标版本缺失 → 6013（两次探测区分）
			if _, gerr := s.repo.GetFile(ctx, docID); gerr != nil {
				return nil, errx.New(errx.CodeDocNotFound, "文档不存在或已移入回收站")
			}
			return nil, errx.New(errx.CodeDocVersion404, "目标版本不存在")
		}
		return nil, errx.From(err)
	}
	return &docapi.RestoreResp{File: toFileDTO(f, true), NewVerNo: v.Version}, nil
}

// ── 回收站 ──

// ListTrash owner 回收站列表（过期行过滤——到期即"已删除"口径；purge_at 升序）
func (s *Service) ListTrash(ctx context.Context, tenantID, userID int64, cursorStr string, limit int) (*docapi.DocListResp, error) {
	if limit <= 0 || limit > s.opts.PageSize {
		limit = s.opts.PageSize
	}
	cursor, err := parseCursor(cursorStr)
	if err != nil {
		return nil, err
	}
	now := s.opts.Now()
	files, err := s.repo.ListTrash(ctx, tenantID, userID, cursor, limit+1)
	if err != nil {
		return nil, errx.From(err)
	}
	// 过期行剔除（物理清除定时任务阶段二；列表可见性先行按到期裁剪）
	live := files[:0]
	for _, f := range files {
		if f.PurgeAt != nil && f.PurgeAt.Before(now) {
			continue
		}
		live = append(live, f)
	}
	hasMore := len(live) > limit
	if hasMore {
		live = live[:limit]
	}
	resp := &docapi.DocListResp{Items: make([]docapi.DocFileDTO, 0, len(live)), HasMore: hasMore}
	for _, f := range live {
		resp.Items = append(resp.Items, toFileDTO(f, false))
	}
	if hasMore && len(live) > 0 {
		last := live[len(live)-1]
		if last.PurgeAt != nil {
			resp.NextCursor = buildCursor(last.PurgeAt.UnixMilli(), last.ID)
		}
	}
	return resp, nil
}

// RestoreFromTrash 回收站恢复（同名冲突自动" (恢复)"后缀，D05 §3.7/API-DOC-28）
func (s *Service) RestoreFromTrash(ctx context.Context, tenantID, userID, docID int64) (*docapi.RestoreResp, error) {
	f, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusTrashed)
	if err != nil {
		// 回收站态不存在/已恢复 → 6011（回收站条目不存在或已过期）
		if e := errx.From(err); e.Code == errx.CodeDocNotFound {
			return nil, errx.New(errx.CodeDocTrashExpired, "回收站条目不存在或已过期")
		}
		return nil, err
	}
	// 到期判定（6011）
	if f.PurgeAt != nil && f.PurgeAt.Before(s.opts.Now()) {
		return nil, errx.New(errx.CodeDocTrashExpired, "回收站条目已过期")
	}
	// 同名冲突 → 追加" (恢复)"后缀（名称追加不阻塞操作，06 §7.1）
	newTitle := ""
	renamed := false
	if dup, derr := s.repo.TitleActive(ctx, tenantID, userID, f.Title, docID); derr == nil && dup {
		newTitle = f.Title + " (恢复)"
		renamed = true
	}
	restored, err := s.repo.RestoreFile(ctx, docID, newTitle, s.opts.Now())
	if err != nil {
		if errors.Is(err, docrepo.ErrNotFound) {
			return nil, errx.New(errx.CodeDocTrashExpired, "回收站条目不存在或已过期")
		}
		return nil, errx.From(err)
	}
	return &docapi.RestoreResp{File: toFileDTO(*restored, false), NewVerNo: restored.CurrentVersion, Renamed: renamed}, nil
}

// ── 分享占位 ──

// Share 生成 share_id+7d 过期+假 URL（不落库——doc_share 表/外链解析页阶段二）
func (s *Service) Share(ctx context.Context, tenantID, userID, docID int64) (*docapi.ShareResp, error) {
	f, err := s.mustOwner(ctx, tenantID, userID, docID, docrepo.StatusActive)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 12) // 96bit 随机 share_id（占位口径；阶段二换 token_hash 落库）
	if _, err := rand.Read(buf); err != nil {
		return nil, errx.New(errx.CodeInternal, "share_id 生成失败")
	}
	expires := s.opts.Now().Add(s.opts.ShareTTL)
	return &docapi.ShareResp{
		ShareID:   hex.EncodeToString(buf),
		URL:       "bbw://doc/s/" + hex.EncodeToString(buf), // 假 URL 占位（外链页阶段二）
		ExpiresAt: expires.UnixMilli(),
		Note:      "阶段一占位链接：外链解析页与 doc_share 落库阶段二（文档《" + f.Title + "》）",
	}, nil
}

// ── DTO 换算 ──

func toFileDTO(f docrepo.DocFile, withContent bool) docapi.DocFileDTO {
	dto := docapi.DocFileDTO{
		ID:             strconv.FormatInt(f.ID, 10),
		OwnerID:        strconv.FormatInt(f.OwnerID, 10),
		Title:          f.Title,
		FolderID:       strconv.FormatInt(f.FolderID, 10),
		Scope:          f.Scope,
		Status:         f.Status,
		CurrentVersion: f.CurrentVersion,
		CreatedAt:      f.CreatedAt.UnixMilli(),
		UpdatedAt:      f.UpdatedAt.UnixMilli(),
	}
	if f.PurgeAt != nil {
		dto.PurgeAt = f.PurgeAt.UnixMilli()
	}
	if withContent {
		dto.ContentMD = f.ContentMD
	}
	return dto
}

func toVersionDTO(v docrepo.DocVersion, withContent bool) docapi.DocVersionDTO {
	dto := docapi.DocVersionDTO{
		ID:           strconv.FormatInt(v.ID, 10),
		DocID:        strconv.FormatInt(v.DocID, 10),
		Version:      v.Version,
		EditorID:     strconv.FormatInt(v.EditorID, 10),
		SnapshotType: v.SnapshotType,
		CreatedAt:    v.CreatedAt.UnixMilli(),
	}
	if withContent {
		dto.ContentMD = v.ContentMD
	}
	return dto
}

// parseCursor 键集游标 "<ms>-<id>"（空=首页）
func parseCursor(s string) (docrepo.PageCursor, error) {
	if s == "" {
		return docrepo.PageCursor{}, nil
	}
	parts := strings.SplitN(s, "-", 2)
	if len(parts) != 2 {
		return docrepo.PageCursor{}, errx.New(errx.CodeBadRequest, "cursor 非法")
	}
	ms, err1 := strconv.ParseInt(parts[0], 10, 64)
	id, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || ms < 0 || id < 0 {
		return docrepo.PageCursor{}, errx.New(errx.CodeBadRequest, "cursor 非法")
	}
	return docrepo.PageCursor{Ms: ms, ID: id}, nil
}

func buildCursor(ms, id int64) string {
	return strconv.FormatInt(ms, 10) + "-" + strconv.FormatInt(id, 10)
}
