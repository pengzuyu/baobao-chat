// 预签名直传编排（D25 O2；07 §4.1 对象存储形态）。
// presign 模式判定=store 具体类型（*filestore.S3）——Local 回落无此形态；
// 分片字节客户端直连对象存储（大流量不经 app；后端 RustFS，D29），服务端只管建会话/发批/位图/complete 收口。
package fileservice

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/jpeg"
	"io"
	"strconv"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"

	fileapi "github.com/baobaochat/server/internal/file/api"
	filerepo "github.com/baobaochat/server/internal/file/repo"
	filestore "github.com/baobaochat/server/internal/file/store"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// D25 拍板⑤：presign part_size 强制 8MB（S3 multipart 非末片 ≥5MiB 硬限，忽略端侧声明）
const (
	presignPartSize  int64 = 8 << 20
	presignBatchMax        = 32        // 首批/续批 ≤32 张（07 §4.1 ④）
	presignURLTTL          = time.Hour // 1h 时效；到期前 10min 客户端主动续签
)

// presignStore 能力判定（nil-safe：Local 回落恒 false）
func (s *Service) presignStore() (*filestore.S3, bool) {
	st, ok := s.store.(*filestore.S3)
	return st, ok
}

// presignBatch 发一批预签名（from 起、跳过已收、≤32 张）
func (s *Service) presignBatch(ctx context.Context, st *filestore.S3, uploadID string,
	sess *uploadSession, from int, received map[int]bool) ([]fileapi.UploadPartURL, error) {
	out := make([]fileapi.UploadPartURL, 0, presignBatchMax)
	for no := from; no <= sess.partTotal && len(out) < presignBatchMax; no++ {
		if received != nil && received[no] {
			continue
		}
		u, err := st.PresignPart(ctx, uploadID, sess.s3UploadID, no, presignURLTTL)
		if err != nil {
			return nil, errx.New(errx.CodeInternal, "预签名签发失败")
		}
		out = append(out, fileapi.UploadPartURL{
			No: no, URL: u, Method: "PUT",
			ExpiresAt: s.opts.Now().Add(presignURLTTL).UnixMilli(),
		})
	}
	return out, nil
}

// initPresignSession presign 会话建立（InitUpload 内嵌）：建 S3 multipart + 首批 URL
func (s *Service) initPresignSession(ctx context.Context, uploadID string, sess *uploadSession) ([]fileapi.UploadPartURL, error) {
	st, _ := s.presignStore()
	s3Up, err := st.CreateMultipart(ctx, uploadID)
	if err != nil {
		return nil, errx.New(errx.CodeInternal, "上传会话创建失败")
	}
	sess.s3UploadID = s3Up
	parts, err := s.presignBatch(ctx, st, uploadID, sess, 1, nil)
	if err != nil {
		st.AbortMultipart(context.Background(), uploadID, s3Up)
		return nil, err
	}
	return parts, nil
}

// statusPresign presign 位图（ListParts 服务端真值）+ 可选续批
func (s *Service) statusPresign(ctx context.Context, uploadID string, sess *uploadSession, fromPart int) (*fileapi.UploadStatus, error) {
	st, _ := s.presignStore()
	nums, err := st.ListPartNumbers(ctx, uploadID, sess.s3UploadID)
	if err != nil {
		return nil, errx.New(errx.CodeInternal, "分片位图读取失败")
	}
	res := &fileapi.UploadStatus{UploadID: uploadID, Received: nums}
	if fromPart > 0 {
		received := make(map[int]bool, len(nums))
		for _, n := range nums {
			received[n] = true
		}
		if parts, perr := s.presignBatch(ctx, st, uploadID, sess, fromPart, received); perr == nil && len(parts) > 0 {
			res.Parts = parts
		}
	}
	return res, nil
}

// completePresign presign 收口：位图齐全 → S3 合并 → 流式 sha 校验 → Copy 落位 → 建行
func (s *Service) completePresign(ctx context.Context, tenantID int64, uploadID string,
	sess *uploadSession) (*fileapi.CompleteResult, error) {
	st, _ := s.presignStore()
	// ① 分片齐全（缺 4007；位图=ListParts 真值）
	nums, err := st.ListPartNumbers(ctx, uploadID, sess.s3UploadID)
	if err != nil {
		return nil, errx.New(errx.CodeInternal, "分片位图读取失败")
	}
	if len(nums) != sess.partTotal {
		return nil, errx.New(errx.CodeFilePartMissing,
			"分片缺失（"+strconv.Itoa(len(nums))+"/"+strconv.Itoa(sess.partTotal)+"）")
	}
	// ② 服务端收口合并（CompleteMultipart 内部 ListParts 真值排序，不信任端侧清单）
	if _, err := st.CompleteMultipart(ctx, uploadID, sess.s3UploadID); err != nil {
		return nil, errx.New(errx.CodeInternal, "分片合并失败")
	}
	// ③ 合并体流式 sha256 校验（不符 4006 整档作废，07 §4.1 ⑦）
	rc, err := st.OpenKey(ctx, filestore.MpKey(uploadID))
	if err != nil {
		return nil, errx.New(errx.CodeInternal, "合并体读取失败")
	}
	h := sha256.New()
	n, cerr := io.Copy(h, rc)
	_ = rc.Close()
	if cerr != nil {
		st.DeleteKey(context.Background(), filestore.MpKey(uploadID))
		return nil, errx.New(errx.CodeInternal, "合并体读取失败")
	}
	if n != sess.size || hex.EncodeToString(h.Sum(nil)) != sess.sha256 {
		st.DeleteKey(context.Background(), filestore.MpKey(uploadID))
		s.recordTransferComplete(ctx, tenantID, uploadID, 0, 0, int(errx.CodeFileSHA256Mismatch))
		return nil, errx.New(errx.CodeFileSHA256Mismatch, "整体 sha256 与声明不一致")
	}
	// ④ 落位（CopyTo 内部 >5GB 分段；幂等——目标已存在直接复用）
	if err := st.CopyTo(ctx, filestore.MpKey(uploadID), filestore.BlobKey(tenantID, sess.sha256), sess.size); err != nil {
		return nil, errx.New(errx.CodeInternal, "存储落位失败")
	}
	_ = st.DeleteKey(context.Background(), filestore.MpKey(uploadID))
	// ⑤ 元数据（与 relay complete 共用口径：嗅探/宽高/去重/入库）
	res, uerr := s.persistUploaded(ctx, tenantID, sess.ownerID, sess.name, sess.ext,
		sess.size, sess.sha256, sess.contentType, sess.convID)
	if uerr != nil {
		return nil, uerr
	}
	if fid, perr := strconv.ParseInt(res.ID, 10, 64); perr == nil {
		s.recordTransferComplete(ctx, tenantID, uploadID, fid, sess.size, 0)
	}
	done := &fileapi.CompleteResult{FileID: res.ID, Dedup: res.Dedup}
	s.mu.Lock()
	sess.done = done
	s.mu.Unlock()
	return done, nil
}

// ── 客户端票据（D25：S3=预签名 GET；Local=token dl）+ 缩略惰性生成 ──

// normalizeVariant 归一（""/origin/240/720；非法回落 origin）
func normalizeVariant(v string) string {
	switch v {
	case "240", "720":
		return v
	}
	return "origin"
}

// IssueClientTicket 客户端形态票据：S3=120s 预签名绝对地址（缩略变体惰性生成、
// 生成失败回退原图键）；Local=token dl 相对路径（variant 进票据条目，Download 分流）
func (s *Service) IssueClientTicket(ctx context.Context, tenantID, userID int64, fileID int64, variant string) (*fileapi.TicketResult, error) {
	f, err := s.getLive(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if f.TenantID != tenantID {
		return nil, errx.New(errx.CodeFileNotFound, "文件不存在")
	}
	if !s.canAccess(ctx, f, userID) {
		return nil, errx.New(errx.CodePermACLDenied, "无权访问该文件")
	}
	variant = normalizeVariant(variant)
	// 惰性生成双模式通用（Local/S3 同一 Storage 接口；失败静默回退原图）
	if variant != "origin" && strings.HasPrefix(f.ContentType, "image/") {
		s.ensureThumb(ctx, f, variant)
	}
	if st, ok := s.presignStore(); ok {
		key := filestore.BlobKey(tenantID, f.SHA256)
		if variant != "origin" && st.HasVariant(ctx, tenantID, f.SHA256, variant) {
			key = filestore.VariantKey(tenantID, f.SHA256, variant)
		}
		url, err := st.PresignGet(ctx, key, s.opts.TicketTTL)
		if err != nil {
			return nil, errx.New(errx.CodeInternal, "票据签发失败")
		}
		return &fileapi.TicketResult{URL: url, ExpiresIn: int(s.opts.TicketTTL.Seconds())}, nil
	}
	return s.issueTicketFor(f, userID, variant) // Local：token 形态
}

// ensureThumb 惰性缩略（240/720 长边等比 JPEG q80；解码失败/webp 等未注册格式静默放弃）。
// 迁移文件免批量重处理：首次取缩略票据时按需生成（D25 §5 落地修订）
func (s *Service) ensureThumb(ctx context.Context, f *filerepo.File, variant string) {
	target, err := strconv.Atoi(variant)
	if err != nil || target <= 0 {
		return
	}
	rc, err := s.store.Open(ctx, f.TenantID, f.SHA256)
	if err != nil {
		return
	}
	img, _, derr := image.Decode(rc)
	_ = rc.Close()
	if derr != nil {
		return // webp 等未注册解码器/坏图：回退原图（票期不阻塞）
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= target && h <= target {
		return // 不放大
	}
	scale := float64(target) / float64(max(w, h))
	nw, nh := max(1, int(float64(w)*scale+0.5)), max(1, int(float64(h)*scale+0.5))
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, xdraw.Src, nil)
	var buf bytes.Buffer
	if jerr := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 80}); jerr != nil {
		return
	}
	_ = s.store.PutVariant(ctx, f.TenantID, f.SHA256, variant, "image/jpeg", buf.Bytes())
}
