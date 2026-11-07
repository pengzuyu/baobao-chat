// Package fileservice 文件域业务逻辑（D06 阶段一务实版）。
// 核心链路：上传（黑名单/超限/宽高解析/sha 去重）→ 短期一次性票据 → 下载流式回放。
// v0.1 登记不做：分片/断点续传/秒传 sha 会话（07 §4.1）、服务端缩略图（端内 CSS 渲染原图）、
// 病毒扫描（scan_status 恒 clean）、配额（file_usage）、审计。
package fileservice

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/gif"  // DecodeConfig 注册（宽高解析支持 gif）
	_ "image/jpeg" // DecodeConfig 注册（宽高解析支持 jpeg）
	_ "image/png"  // DecodeConfig 注册（宽高解析支持 png）
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	fileapi "github.com/baobaowork/server/internal/file/api"
	filerepo "github.com/baobaowork/server/internal/file/repo"
	filestore "github.com/baobaowork/server/internal/file/store"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// Options 策略参数（Now 时钟注入供测试）
type Options struct {
	DataDir        string                                            // 本地磁盘根目录（BBW_DATA_DIR）
	MaxUploadBytes int64                                             // 单文件上限（默认 20MB，4009）
	TicketTTL      time.Duration                                     // 下载票据有效期（默认 120s，4014）
	Now            func() time.Time                                  // 时钟注入（票据过期可测）
	IsConvMember   func(ctx context.Context, uid, convID int64) bool // 会话成员判定（main 注入 msgRepo.MemberOf；nil 时仅 owner 可取票据）
}

func (o *Options) fillDefaults() {
	if o.MaxUploadBytes == 0 {
		o.MaxUploadBytes = 20 << 20
	}
	if o.TicketTTL == 0 {
		o.TicketTTL = 120 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// extBlacklist 扩展名黑名单（v0.1 固定集；租户策略黑白名单阶段二接 admin_policy）
var extBlacklist = map[string]bool{"exe": true, "sh": true}

// Service 实现 fileapi.FileService
type Service struct {
	repo      filerepo.Repo
	shares    filerepo.ShareRepo    // 分享外链仓储（nil=分享未装配，阶段一形态）
	transfers filerepo.TransferRepo // 传输记录镜像（nil=不记录，阶段一形态）
	store     filestore.Storage
	opts      Options
	mu        sync.Mutex
	tickets   map[string]ticketEntry    // 一次性下载票据（内存态；阶段二 Redis TTL）
	uploads   map[string]*uploadSession // 分片上传会话（内存态；重启由 ResetStaging 回收）
}

// ticketEntry 票据条目（绑定用户与文件，07 §4.3 ①）
type ticketEntry struct {
	fileID  int64
	userID  int64
	expires time.Time
}

// New 构造（shares/transfers 可为 nil——阶段一装配形态；启动回收 staging
// 孤儿分片：会话元数据内存态，重启即与磁盘失配）
func New(opts Options, r filerepo.Repo, shares filerepo.ShareRepo, transfers filerepo.TransferRepo, store filestore.Storage) *Service {
	opts.fillDefaults()
	_ = store.ResetStaging()
	return &Service{
		repo: r, shares: shares, transfers: transfers, store: store, opts: opts,
		tickets: map[string]ticketEntry{}, uploads: map[string]*uploadSession{},
	}
}

var _ fileapi.FileService = (*Service)(nil)

// Upload 上传落盘 + 元数据入库（去重命中复用原行返回原 id）
func (s *Service) Upload(ctx context.Context, tenantID, ownerID int64, name, contentType string, convID int64, r io.Reader) (*fileapi.UploadResult, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 255 {
		return nil, errx.New(errx.CodeBadRequest, "文件名非法（非空 ≤255）")
	}
	ext := normalizeExt(path.Ext(name))
	if extBlacklist[ext] {
		return nil, errx.New(errx.CodeFileTypeForbidden, "文件类型不允许上传（."+ext+"）")
	}

	// ① 流式落临时文件 + sha256（超限即中止 4009）
	size, sha, tmpPath, err := s.store.Save(ctx, tenantID, r, s.opts.MaxUploadBytes)
	if err != nil {
		if err == filestore.ErrTooLarge {
			return nil, errx.New(errx.CodeFileSizeLimit, "超过单文件大小上限")
		}
		return nil, errx.New(errx.CodeInternal, "存储写入失败")
	}
	// ② rename 原子落位（内容寻址幂等：目标已存在直接复用）
	if err := s.store.Promote(ctx, tenantID, sha, tmpPath); err != nil {
		return nil, errx.New(errx.CodeInternal, "存储落位失败")
	}

	// ③ 图片宽高解析（DecodeConfig 仅读头部；失败不阻塞上传，宽高留 0）
	width, height := 0, 0
	contentType = strings.TrimSpace(contentType)
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = sniffContentType(ctx, s.store, tenantID, sha)
	}
	if strings.HasPrefix(contentType, "image/") {
		if cfg, err := decodeConfig(ctx, s.store, tenantID, sha); err == nil {
			width, height = cfg.Width, cfg.Height
		}
	}

	// ④ 同租户同 sha 去重复用（未软删行；软删行不参与，重新入库新行）
	if hit, err := s.repo.GetBySHA(ctx, tenantID, sha); err != nil {
		return nil, errx.From(err)
	} else if hit != nil {
		return toUploadResult(*hit, true), nil
	}

	// ⑤ 入库（并发同 sha 由唯一索引兜底 → 复用原行）
	now := s.opts.Now()
	f, err := s.repo.Insert(ctx, filerepo.File{
		TenantID: tenantID, OwnerID: ownerID, Name: name, Ext: ext,
		Size: size, ContentType: contentType, SHA256: sha,
		Width: width, Height: height, Source: filerepo.SourceUpload,
		ConvID: convID, ScanStatus: filerepo.ScanClean, // v0.1 恒 clean（扫描服务阶段二）
		CreatedAt: now,
	})
	if err != nil {
		if err == filerepo.ErrDuplicateFileSHA {
			if hit, gerr := s.repo.GetBySHA(ctx, tenantID, sha); gerr == nil && hit != nil {
				s.recordTransferDone(ctx, tenantID, ownerID, hit.ID, hit.Size) // 秒传/并发去重也记 done
				return toUploadResult(*hit, true), nil
			}
		}
		return nil, errx.From(err)
	}
	s.recordTransferDone(ctx, tenantID, ownerID, f.ID, f.Size)
	return toUploadResult(f, false), nil
}

// IssueTicket 取下载票据（owner 或 conv 成员；一次性短时效）
func (s *Service) IssueTicket(ctx context.Context, tenantID, userID int64, fileID int64) (*fileapi.TicketResult, error) {
	f, err := s.getLive(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if f.TenantID != tenantID {
		return nil, errx.New(errx.CodeFileNotFound, "文件不存在") // 跨租户不暴露存在性
	}
	if !s.canAccess(ctx, f, userID) {
		return nil, errx.New(errx.CodePermACLDenied, "无权访问该文件")
	}

	return s.issueTicketFor(ctx, f, userID)
}

// issueTicketFor 票据签发（IssueTicket 与 share 解析通道共用；绑定用户一次性）
func (s *Service) issueTicketFor(_ context.Context, f *filerepo.File, userID int64) (*fileapi.TicketResult, error) {
	// 一次性票据：32 字节随机 hex；过期条目顺带清理（无定时器，惰性回收）
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, errx.New(errx.CodeInternal, "票据生成失败")
	}
	t := hex.EncodeToString(token)
	now := s.opts.Now()
	expires := now.Add(s.opts.TicketTTL)
	s.mu.Lock()
	for k, v := range s.tickets {
		if now.After(v.expires) {
			delete(s.tickets, k)
		}
	}
	s.tickets[t] = ticketEntry{fileID: f.ID, userID: userID, expires: expires}
	s.mu.Unlock()
	return &fileapi.TicketResult{
		URL:       "/api/v1/files/dl?t=" + t,
		ExpiresIn: int(s.opts.TicketTTL.Seconds()),
	}, nil
}

// Download 票据校验 → 目标 + 内容流（一次性：出队即失效；过期/未知票据 4014）
func (s *Service) Download(ctx context.Context, token string) (*fileapi.DownloadTarget, io.ReadCloser, error) {
	s.mu.Lock()
	ent, ok := s.tickets[token]
	delete(s.tickets, token) // 一次性：无论成败均消费
	s.mu.Unlock()
	if !ok || s.opts.Now().After(ent.expires) {
		return nil, nil, errx.New(errx.CodeFileTicketInvalid, "下载票据无效或已过期")
	}
	f, err := s.getLive(ctx, ent.fileID)
	if err != nil {
		return nil, nil, err
	}
	rc, err := s.store.Open(ctx, f.TenantID, f.SHA256)
	if err != nil {
		return nil, nil, errx.New(errx.CodeFileNotFound, "文件内容缺失")
	}
	s.recordTransferDownload(ctx, f.TenantID, ent.userID, f.ID, f.Size) // 07 §5 下载镜像
	return &fileapi.DownloadTarget{
		FileID: f.ID, TenantID: f.TenantID, Name: f.Name,
		ContentType: f.ContentType, SHA256: f.SHA256, Size: f.Size,
	}, rc, nil
}

// ListMine 我的文件（软删排除，created_at 倒序）
func (s *Service) ListMine(ctx context.Context, tenantID, userID int64) ([]fileapi.FileDTO, error) {
	files, err := s.repo.ListByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]fileapi.FileDTO, 0, len(files))
	for _, f := range files {
		out = append(out, toDTO(f))
	}
	return out, nil
}

// ListByConv 会话文件聚合（群文件页签；非成员拒 2003）
func (s *Service) ListByConv(ctx context.Context, tenantID, userID, convID int64) ([]fileapi.FileDTO, error) {
	if s.opts.IsConvMember == nil || !s.opts.IsConvMember(ctx, userID, convID) {
		return nil, errx.New(errx.CodePermACLDenied, "非会话成员")
	}
	files, err := s.repo.ListByConv(ctx, tenantID, convID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]fileapi.FileDTO, 0, len(files))
	for _, f := range files {
		out = append(out, toDTO(f))
	}
	return out, nil
}

// SoftDelete owner 软删（4013 语义：此后取票据/下载均拒）
func (s *Service) SoftDelete(ctx context.Context, tenantID, userID int64, fileID int64) error {
	f, err := s.repo.Get(ctx, fileID)
	if err != nil {
		return errx.New(errx.CodeFileNotFound, "文件不存在")
	}
	if f.TenantID != tenantID || f.OwnerID != userID {
		return errx.New(errx.CodePermACLDenied, "仅 owner 可删除")
	}
	if f.Deleted() {
		return nil // 幂等：重复软删 no-op
	}
	if err := s.repo.SoftDelete(ctx, fileID, s.opts.Now()); err != nil {
		return errx.From(err)
	}
	return nil
}

// CheckSendable msg.send type=file/image 校验（message 域注入调用）
func (s *Service) CheckSendable(ctx context.Context, senderID int64, fileID int64) error {
	f, err := s.getLive(ctx, fileID)
	if err != nil {
		return err
	}
	// sender 为 owner，或已随消息发送（source=message，转发复用路径）
	if f.OwnerID != senderID && f.Source != filerepo.SourceMessage {
		return errx.New(errx.CodePermACLDenied, "仅 owner 可发送该文件")
	}
	return nil
}

// MarkSent 随消息发送后回填 source='message'+conv_id（尽力而为：失败不影响消息发送）
func (s *Service) MarkSent(ctx context.Context, fileID int64, convID int64) error {
	return s.repo.MarkSent(ctx, fileID, convID)
}

// getLive 取未软删行（4005 不存在 / 4013 已删除）
func (s *Service) getLive(ctx context.Context, fileID int64) (*filerepo.File, error) {
	f, err := s.repo.Get(ctx, fileID)
	if err != nil {
		return nil, errx.New(errx.CodeFileNotFound, "文件不存在")
	}
	if f.Deleted() {
		return nil, errx.New(errx.CodeFileDeleted, "文件已删除")
	}
	return f, nil
}

// canAccess 资源级判定（03 篇三层模型：owner 或 来源会话成员）
func (s *Service) canAccess(ctx context.Context, f *filerepo.File, userID int64) bool {
	if f.OwnerID == userID {
		return true
	}
	if f.ConvID > 0 && s.opts.IsConvMember != nil {
		return s.opts.IsConvMember(ctx, userID, f.ConvID)
	}
	return false
}

// normalizeExt ".PNG " → "png"
func normalizeExt(ext string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(ext), "."))
}

// sniffContentType 头部 512 字节嗅探（multipart 未携带/通用类型时的兜底）
func sniffContentType(ctx context.Context, store filestore.Storage, tenantID int64, sha string) string {
	head, rc, err := store.Head(ctx, tenantID, sha, 512)
	if err != nil {
		return "application/octet-stream"
	}
	defer rc.Close()
	if ct := http.DetectContentType(head); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// decodeConfig 图片宽高解析（仅头部，不解码像素；v0.1 不做服务端缩略图，登记）
func decodeConfig(ctx context.Context, store filestore.Storage, tenantID int64, sha string) (*image.Config, error) {
	_, rc, err := store.Head(ctx, tenantID, sha, 1<<20)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	cfg, _, err := image.DecodeConfig(rc)
	if err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	return &cfg, nil
}

// toUploadResult 行 → 上传响应（去重命中返回原行元数据：name/ext 为首传者口径，登记）
func toUploadResult(f filerepo.File, dedup bool) *fileapi.UploadResult {
	return &fileapi.UploadResult{
		ID: strconv.FormatInt(f.ID, 10), Name: f.Name, Ext: f.Ext,
		Size: f.Size, ContentType: f.ContentType,
		Width: f.Width, Height: f.Height, Dedup: dedup,
	}
}

// toDTO 行 → 列表项
func toDTO(f filerepo.File) fileapi.FileDTO {
	dto := fileapi.FileDTO{
		ID: strconv.FormatInt(f.ID, 10), Name: f.Name, Ext: f.Ext,
		Size: f.Size, ContentType: f.ContentType,
		Width: f.Width, Height: f.Height, Source: f.Source,
		CreatedAt: f.CreatedAt.UnixMilli(),
	}
	if f.ConvID > 0 {
		dto.ConvID = strconv.FormatInt(f.ConvID, 10)
	}
	return dto
}
