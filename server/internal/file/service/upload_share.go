// 分片上传会话（D06 阶段二 server 侧；07 §4.1）。
// 会话为服务端内存态 + staging 落盘（对象存储化时落 upload 会话表，登记）；
// 分享外链已随 2026-11 产品瘦身移除（file_share 表废弃由 0035 清理）。
package fileservice

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
	"time"

	fileapi "github.com/baobaochat/server/internal/file/api"
	filerepo "github.com/baobaochat/server/internal/file/repo"
	filestore "github.com/baobaochat/server/internal/file/store"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// 默认分片参数（07 §1.2：4MB/片；本地盘直传无预签名批次概念，登记）
const (
	defaultPartSize  int64 = 4 << 20
	uploadSessionTTL       = 7 * 24 * time.Hour // 会话 7 天有效（07 §4.1 ④）
	minPartSize      int64 = 1 << 20
	maxPartSize      int64 = 8 << 20
)

// uploadSession 分片会话（内存态；重启即失——staging 由 ResetStaging 启动回收）
type uploadSession struct {
	tenantID    int64
	ownerID     int64
	name        string
	ext         string
	size        int64
	sha256      string // 声明指纹（complete 整体校验）
	contentType string
	convID      int64
	partSize    int64
	partTotal   int
	s3UploadID  string // presign 模式：S3 multipart UploadId（D25；空=relay PATCH 形态）
	expires     time.Time
	done        *fileapi.CompleteResult // complete 后幂等回放（重复 complete 同结果）
}

// uploadPolicy 上传前置策略校验（check/init 共用：服务端再校验，不信任端侧）
func (s *Service) uploadPolicy(name string, size int64) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 255 {
		return "", errx.New(errx.CodeBadRequest, "文件名非法（非空 ≤255）")
	}
	ext := normalizeExt(path.Ext(name))
	if extBlacklist[ext] {
		return "", errx.New(errx.CodeFileTypeForbidden, "文件类型不允许上传（."+ext+"）")
	}
	if size <= 0 || size > s.opts.MaxUploadBytes {
		return "", errx.New(errx.CodeFileSizeLimit, "超过单文件大小上限")
	}
	return ext, nil
}

// Check 秒传预检：策略校验 + 同租户同 sha 命中（未软删行）
func (s *Service) Check(ctx context.Context, tenantID, _ int64, req fileapi.CheckReq) (*fileapi.CheckResult, error) {
	if req.SHA256 == "" || len(req.SHA256) != 64 {
		return nil, errx.New(errx.CodeBadRequest, "sha256 非法（64 位 hex）")
	}
	if _, err := s.uploadPolicy(req.Name, req.Size); err != nil {
		return nil, err
	}
	if hit, err := s.repo.GetBySHA(ctx, tenantID, req.SHA256); err != nil {
		return nil, errx.From(err)
	} else if hit != nil {
		return &fileapi.CheckResult{FileID: strconv.FormatInt(hit.ID, 10), Dedup: true}, nil
	}
	return &fileapi.CheckResult{}, nil
}

// InitUpload 建会话；声明 sha 已命中 → 秒传建行直接返回（07 §4.1 ③→④ 融合）
func (s *Service) InitUpload(ctx context.Context, tenantID, ownerID int64, req fileapi.UploadInitReq) (*fileapi.UploadInitResult, error) {
	if req.SHA256 == "" || len(req.SHA256) != 64 {
		return nil, errx.New(errx.CodeBadRequest, "sha256 非法（64 位 hex）")
	}
	ext, err := s.uploadPolicy(req.Name, req.Size)
	if err != nil {
		return nil, err
	}
	// 秒传命中：直接建行（07 §4.1 ③——check/init 两入口语义一致）
	if hit, err := s.repo.GetBySHA(ctx, tenantID, req.SHA256); err != nil {
		return nil, errx.From(err)
	} else if hit != nil {
		s.recordTransferDone(ctx, tenantID, ownerID, hit.ID, hit.Size) // init 入口秒传：直接终态
		return &fileapi.UploadInitResult{FileID: strconv.FormatInt(hit.ID, 10), Dedup: true}, nil
	}
	partSize := req.PartSize
	if _, presign := s.presignStore(); presign {
		partSize = presignPartSize // 拍板⑤：S3 非末片 ≥5MiB 硬限 → 定值 8MB（忽略端侧声明）
	}
	if partSize == 0 {
		partSize = defaultPartSize
	}
	if partSize < minPartSize || partSize > maxPartSize {
		return nil, errx.New(errx.CodeBadRequest, "part_size 1–8MB")
	}
	partTotal := int((req.Size + partSize - 1) / partSize)
	if partTotal < 1 || partTotal > 10000 {
		return nil, errx.New(errx.CodeBadRequest, "分片数 1–10000")
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, errx.New(errx.CodeInternal, "会话创建失败")
	}
	uploadID := hex.EncodeToString(id)
	now := s.opts.Now()
	sess := &uploadSession{
		tenantID: tenantID, ownerID: ownerID,
		name: strings.TrimSpace(req.Name), ext: ext,
		size: req.Size, sha256: req.SHA256, contentType: strings.TrimSpace(req.ContentType),
		convID: req.ConvID, partSize: partSize, partTotal: partTotal,
		expires: now.Add(uploadSessionTTL),
	}
	// presign 模式（D25）：建 S3 multipart + 首批 ≤32 张预签名（建败即弃会话）
	var parts []fileapi.UploadPartURL
	mode := ""
	if _, presign := s.presignStore(); presign {
		p, err := s.initPresignSession(ctx, uploadID, sess)
		if err != nil {
			return nil, err
		}
		parts, mode = p, "presign"
	}
	s.mu.Lock()
	s.uploads[uploadID] = sess
	s.mu.Unlock()
	s.recordTransferQueued(ctx, tenantID, ownerID, uploadID, req.Size)
	return &fileapi.UploadInitResult{
		UploadID: uploadID, PartSize: partSize, PartTotal: partTotal,
		Mode: mode, Parts: parts,
	}, nil
}

// getSession 取有效会话（过期 4008；非本人/跨租户不暴露——按 4008 口径拒绝）
func (s *Service) getSession(uploadID string, tenantID, userID int64) (*uploadSession, error) {
	s.mu.Lock()
	sess, ok := s.uploads[uploadID]
	s.mu.Unlock()
	if !ok || s.opts.Now().After(sess.expires) ||
		sess.tenantID != tenantID || sess.ownerID != userID {
		return nil, errx.New(errx.CodeFileUploadExpired, "上传会话无效或已过期")
	}
	return sess, nil
}

// UploadStatus 断点续传位图（presign=ListParts 真值；fromPart>0 附预签名续批，D25）
func (s *Service) UploadStatus(ctx context.Context, tenantID, userID int64, uploadID string, fromPart int) (*fileapi.UploadStatus, error) {
	sess, err := s.getSession(uploadID, tenantID, userID)
	if err != nil {
		return nil, err
	}
	if sess.s3UploadID != "" {
		return s.statusPresign(ctx, uploadID, sess, fromPart)
	}
	received, err := s.store.ListStaging(ctx, uploadID)
	if err != nil {
		return nil, errx.New(errx.CodeInternal, "暂存读取失败")
	}
	return &fileapi.UploadStatus{UploadID: uploadID, Received: received}, nil
}

// UploadPart 写分片（relay 形态；覆盖写=坏块重传；超限 4009。presign 会话拒——直传不经服务端）
func (s *Service) UploadPart(ctx context.Context, tenantID, userID int64, uploadID string, no int, r io.Reader) error {
	sess, err := s.getSession(uploadID, tenantID, userID)
	if err != nil {
		return err
	}
	if sess.s3UploadID != "" {
		return errx.New(errx.CodeBadRequest, "presign 会话不走服务端中转（PUT 预签名直传）")
	}
	if no < 1 || no > sess.partTotal {
		return errx.New(errx.CodeBadRequest, "分片号越界")
	}
	if err := s.store.SaveStaging(ctx, uploadID, no, r, sess.partSize); err != nil {
		if err == filestore.ErrTooLarge {
			return errx.New(errx.CodeFileSizeLimit, "分片超过 part_size")
		}
		return errx.New(errx.CodeBadRequest, "分片写入失败")
	}
	// 进度镜像：resuming=此前已有存量分片（位图语义），否则 transferring
	received, lerr := s.store.ListStaging(ctx, uploadID)
	if lerr == nil {
		s.recordTransferProgress(ctx, tenantID, uploadID, len(received) > 1, int64(len(received))*sess.partSize)
	}
	return nil
}

// CompleteUpload 合并 → 整体 sha 校验（4006 作废清 staging）→ 落位去重建行
func (s *Service) CompleteUpload(ctx context.Context, tenantID, userID int64, uploadID string) (*fileapi.CompleteResult, error) {
	sess, err := s.getSession(uploadID, tenantID, userID)
	if err != nil {
		return nil, err
	}
	// 幂等：已 complete 的会话重复调用回放同结果（客户端重试友好）
	if sess.done != nil {
		return sess.done, nil
	}
	// presign 形态（D25）：S3 合并收口（位图/校验/落位/建行独立链路）
	if sess.s3UploadID != "" {
		return s.completePresign(ctx, tenantID, uploadID, sess)
	}
	// ① 分片齐全（缺 4007——客户端按位图补传后再 complete）
	received, err := s.store.ListStaging(ctx, uploadID)
	if err != nil {
		return nil, errx.New(errx.CodeInternal, "暂存读取失败")
	}
	if len(received) != sess.partTotal {
		return nil, errx.New(errx.CodeFilePartMissing,
			fmt.Sprintf("分片缺失（%d/%d）", len(received), sess.partTotal))
	}
	// ② 顺序合并 → 流式 sha256 + 总量核对（内容寻址落临时）
	readers := make([]io.Reader, 0, sess.partTotal)
	closers := make([]io.Closer, 0, sess.partTotal)
	defer func() {
		for _, c := range closers {
			c.Close()
		}
	}()
	for no := 1; no <= sess.partTotal; no++ {
		rc, oerr := s.store.OpenStaging(ctx, uploadID, no)
		if oerr != nil {
			return nil, errx.New(errx.CodeFilePartCheckFailed, "分片读取失败")
		}
		readers = append(readers, rc)
		closers = append(closers, rc)
	}
	size, sha, tmpPath, serr := s.store.Save(ctx, tenantID, io.MultiReader(readers...), s.opts.MaxUploadBytes)
	if serr != nil {
		return nil, errx.New(errx.CodeFileSizeLimit, "合并超限")
	}
	if size != sess.size || sha != sess.sha256 {
		s.store.RemoveStaging(ctx, uploadID) // 不一致整档作废（07 §4.1 ⑦）
		s.recordTransferComplete(ctx, tenantID, uploadID, 0, 0, int(errx.CodeFileSHA256Mismatch))
		return nil, errx.New(errx.CodeFileSHA256Mismatch, "整体 sha256 与声明不一致")
	}
	if err := s.store.Promote(ctx, tenantID, sha, tmpPath); err != nil {
		return nil, errx.New(errx.CodeInternal, "存储落位失败")
	}
	// ③ 元数据（复用 Upload 的宽高/嗅探/去重/入库口径）
	res, uerr := s.persistUploaded(ctx, tenantID, sess.ownerID, sess.name, sess.ext,
		size, sha, sess.contentType, sess.convID)
	if uerr != nil {
		return nil, uerr
	}
	s.store.RemoveStaging(ctx, uploadID) // ⑦ 合并后即删 staging
	if fid, perr := strconv.ParseInt(res.ID, 10, 64); perr == nil {
		s.recordTransferComplete(ctx, tenantID, uploadID, fid, size, 0)
	}
	done := &fileapi.CompleteResult{FileID: res.ID, Dedup: res.Dedup}
	s.mu.Lock()
	sess.done = done
	s.mu.Unlock()
	return done, nil
}

// persistUploaded Upload/Complete 共用的元数据入库段（嗅探/宽高/去重/插入）
func (s *Service) persistUploaded(ctx context.Context, tenantID, ownerID int64,
	name, ext string, size int64, sha, contentType string, convID int64) (*fileapi.UploadResult, error) {
	contentType = strings.TrimSpace(contentType)
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = sniffContentType(ctx, s.store, tenantID, sha)
	}
	width, height := 0, 0
	if strings.HasPrefix(contentType, "image/") {
		if cfg, err := decodeConfig(ctx, s.store, tenantID, sha); err == nil {
			width, height = cfg.Width, cfg.Height
		}
	}
	if hit, err := s.repo.GetBySHA(ctx, tenantID, sha); err != nil {
		return nil, errx.From(err)
	} else if hit != nil {
		return toUploadResult(*hit, true), nil
	}
	f, err := s.repo.Insert(ctx, filerepo.File{
		TenantID: tenantID, OwnerID: ownerID, Name: name, Ext: ext,
		Size: size, ContentType: contentType, SHA256: sha,
		Width: width, Height: height, Source: filerepo.SourceUpload,
		ConvID: convID, ScanStatus: filerepo.ScanClean,
		CreatedAt: s.opts.Now(),
	})
	if err != nil {
		if err == filerepo.ErrDuplicateFileSHA {
			if hit, gerr := s.repo.GetBySHA(ctx, tenantID, sha); gerr == nil && hit != nil {
				return toUploadResult(*hit, true), nil
			}
		}
		return nil, errx.From(err)
	}
	return toUploadResult(f, false), nil
}
