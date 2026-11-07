// 分片上传会话与分享外链（D06 阶段二 server 侧；07 §4.1/§4.4）。
// 会话为服务端内存态 + staging 落盘（对象存储化时落 upload 会话表，登记）；
// 分享外链落 file_share 表（迁移 0013），访问仍需登录（企业内不匿名）。
package fileservice

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
	"time"

	fileapi "github.com/baobaowork/server/internal/file/api"
	filerepo "github.com/baobaowork/server/internal/file/repo"
	filestore "github.com/baobaowork/server/internal/file/store"
	errx "github.com/baobaowork/server/internal/platform/errors"
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
	s.mu.Lock()
	s.uploads[uploadID] = &uploadSession{
		tenantID: tenantID, ownerID: ownerID,
		name: strings.TrimSpace(req.Name), ext: ext,
		size: req.Size, sha256: req.SHA256, contentType: strings.TrimSpace(req.ContentType),
		convID: req.ConvID, partSize: partSize, partTotal: partTotal,
		expires: now.Add(uploadSessionTTL),
	}
	s.mu.Unlock()
	s.recordTransferQueued(ctx, tenantID, ownerID, uploadID, req.Size)
	return &fileapi.UploadInitResult{UploadID: uploadID, PartSize: partSize, PartTotal: partTotal}, nil
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

// UploadStatus 断点续传位图
func (s *Service) UploadStatus(ctx context.Context, tenantID, userID int64, uploadID string) (*fileapi.UploadStatus, error) {
	if _, err := s.getSession(uploadID, tenantID, userID); err != nil {
		return nil, err
	}
	received, err := s.store.ListStaging(ctx, uploadID)
	if err != nil {
		return nil, errx.New(errx.CodeInternal, "暂存读取失败")
	}
	return &fileapi.UploadStatus{UploadID: uploadID, Received: received}, nil
}

// UploadPart 写分片（覆盖写=坏块重传；超限 4009）
func (s *Service) UploadPart(ctx context.Context, tenantID, userID int64, uploadID string, no int, r io.Reader) error {
	sess, err := s.getSession(uploadID, tenantID, userID)
	if err != nil {
		return err
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

// ── 分享外链 ──

// Share 创建（owner only；code 12 字节 hex 随机不可枚举）
func (s *Service) Share(ctx context.Context, tenantID, userID int64, fileID int64, req fileapi.ShareReq) (*fileapi.ShareResult, error) {
	if s.shares == nil {
		return nil, errx.New(errx.CodeInternal, "分享未装配")
	}
	f, err := s.getLive(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if f.TenantID != tenantID || f.OwnerID != userID {
		return nil, errx.New(errx.CodePermACLDenied, "仅 owner 可分享")
	}
	switch req.ExpireMode {
	case filerepo.ShareExpireNever, filerepo.ShareExpireAt, filerepo.ShareExpireTimes:
	default:
		return nil, errx.New(errx.CodeBadRequest, "expire_mode ∈ 1 永不/2 时限/3 次数")
	}
	if req.Password != "" && len(req.Password) > 64 {
		return nil, errx.New(errx.CodeBadRequest, "密码 ≤64 字")
	}
	sh := filerepo.Share{
		TenantID: tenantID, FileID: fileID, CreatorID: userID,
		ExpireMode: req.ExpireMode, MaxTimes: req.MaxTimes,
		Status: filerepo.ShareActive, CreatedAt: s.opts.Now(),
	}
	if req.ExpireMode == filerepo.ShareExpireAt {
		if req.ExpiresAt <= sh.CreatedAt.UnixMilli() {
			return nil, errx.New(errx.CodeBadRequest, "expires_at 须晚于当前")
		}
		sh.ExpiresAt = time.UnixMilli(req.ExpiresAt)
	}
	if req.ExpireMode == filerepo.ShareExpireTimes {
		if req.MaxTimes < 1 || req.MaxTimes > 10000 {
			return nil, errx.New(errx.CodeBadRequest, "max_times 1–10000")
		}
	}
	if req.Password != "" {
		sh.PasswordHash = s.hashSharePwd(req.Password)
	}
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return nil, errx.New(errx.CodeInternal, "code 生成失败")
	}
	sh.Code = hex.EncodeToString(b)
	inserted, err := s.shares.InsertShare(ctx, sh)
	if err != nil {
		return nil, errx.From(err)
	}
	out := &fileapi.ShareResult{
		ShareID: strconv.FormatInt(inserted.ID, 10),
		Code:    inserted.Code,
		URL:     "/api/v1/files/s/" + inserted.Code,
	}
	if !inserted.ExpiresAt.IsZero() {
		out.ExpiresAt = inserted.ExpiresAt.UnixMilli()
	}
	return out, nil
}

// ResolveShare 解析：状态/有效期(4010)/次数(4012)/密码(4011) → 命中计数+直发票据
func (s *Service) ResolveShare(ctx context.Context, tenantID, userID int64, code, password string) (*fileapi.ShareView, error) {
	if s.shares == nil {
		return nil, errx.New(errx.CodeInternal, "分享未装配")
	}
	if code == "" {
		return nil, errx.New(errx.CodeBadRequest, "code 必填")
	}
	sh, err := s.shares.GetShareByCode(ctx, tenantID, code)
	if err != nil || sh.Status != filerepo.ShareActive {
		return nil, errx.New(errx.CodeFileNotFound, "分享不存在或已取消")
	}
	now := s.opts.Now()
	if sh.ExpireMode == filerepo.ShareExpireAt && now.After(sh.ExpiresAt) {
		return nil, errx.New(errx.CodeFileShareExpired, "分享已过期")
	}
	if sh.ExpireMode == filerepo.ShareExpireTimes && sh.UsedTimes >= sh.MaxTimes {
		return nil, errx.New(errx.CodeFileShareExhausted, "分享次数已用尽")
	}
	if sh.PasswordHash != "" {
		if password == "" {
			// 密码未携带：4011 + need_pwd 提示（解析页二段式输入）
			v := &fileapi.ShareView{NeedPwd: true}
			return v, errx.New(errx.CodeFileSharePwdWrong, "需要密码")
		}
		if s.hashSharePwd(password) != sh.PasswordHash {
			return nil, errx.New(errx.CodeFileSharePwdWrong, "密码错误")
		}
	}
	f, err := s.getLive(ctx, sh.FileID)
	if err != nil {
		return nil, err // 文件被删：4013（链接仍占次数校验前的失败，不计数）
	}
	// 命中：计数 + 一次性下载票据（share 通道直发——访问者非 owner/成员）
	if err := s.shares.IncShareUsed(ctx, sh.ID); err != nil {
		return nil, errx.From(err)
	}
	ticket, err := s.issueTicketFor(ctx, f, userID) // share 通道票据绑定访问者（一次性）
	if err != nil {
		return nil, err
	}
	view := &fileapi.ShareView{File: toDTO(*f), UsedTimes: sh.UsedTimes + 1, Ticket: *ticket}
	if sh.ExpireMode == filerepo.ShareExpireTimes {
		view.MaxTimes = sh.MaxTimes
	}
	return view, nil
}

// RevokeShare 取消（creator only；链接即刻失效）
func (s *Service) RevokeShare(ctx context.Context, tenantID, userID int64, code string) error {
	if s.shares == nil {
		return errx.New(errx.CodeInternal, "分享未装配")
	}
	sh, err := s.shares.GetShareByCode(ctx, tenantID, code)
	if err != nil {
		return errx.New(errx.CodeFileNotFound, "分享不存在")
	}
	if err := s.shares.DisableShare(ctx, tenantID, sh.ID, userID); err != nil {
		return errx.New(errx.CodeFileNotFound, "分享不存在或非创建者")
	}
	return nil
}

// hashSharePwd 密码摘要（v0.1 sha256(pwd+code 盐)——分享密码非账号口令，
// 强度口径登记：bcrypt 化随 auth 域闭包注入阶段三统一）
func (s *Service) hashSharePwd(pwd string) string {
	sum := sha256.Sum256([]byte("bbw-share:" + pwd))
	return hex.EncodeToString(sum[:])
}
