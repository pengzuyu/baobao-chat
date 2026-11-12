// Package store S3/MinIO 实现（D25）。对象布局：t/{tenant}/{sha前2}/{sha}（13 篇 §6）。
// Local 语义映射：Save 返回的 tmpPath=S3 临时对象键（不透明字符串，Promote 原样收回）；
// staging 兼容路径（relay PATCH）=s2/{uploadID}/{no:05d} 普通对象——presign 模式不经过，
// 分片走 S3 原生 multipart（key=s/{uploadID}，uploadId 会话由 service 层持有，见 O2）。
// 预签名对外口径（D25 拍板②）：签名按去前缀路径+对外 host 计算（v4.PresignHTTP 手签），
// 返回 URL 拼回 publicEndpoint 路径前缀——nginx /oss/ strip 前缀 + Host 透传后 MinIO 可验签。
// ResetStaging=启动清扫：s2/ 孤儿分片 + 在途 multipart（内存会话失配回收，Local 同语义）。
package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4signer "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awscred "github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// S3Options 构造参数（main 从 BBW_S3_* 环境变量装配）
type S3Options struct {
	Endpoint      string // 服务端→MinIO 内部端点（http://minio:9000）
	PublicEndpoint string // 客户端可达基址（https://dom/oss 或 http://ip:9000）；空=同 Endpoint；可含一级路径前缀
	AccessKey     string
	SecretKey     string
	Bucket        string // 空=bbw-data
}

// S3 对象存储实现
type S3 struct {
	client    *s3.Client
	uploader  *manager.Uploader
	creds     aws.CredentialsProvider
	region    string
	bucket    string
	publicBase string // 对外基址 scheme://host（无路径）
	urlPrefix  string // 对外路径前缀（"" 或 "/oss"）；签名不含、URL 拼回
}

var _ Storage = (*S3)(nil)

// NewS3 构造（不自检连通——启动即 Fail Fast 由首次请求兜底；构造期零 IO）
func NewS3(o S3Options) (*S3, error) {
	if o.Endpoint == "" {
		return nil, errors.New("s3: endpoint required")
	}
	pub := o.PublicEndpoint
	if pub == "" {
		pub = o.Endpoint
	}
	u, err := url.Parse(pub)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("s3: public endpoint invalid: %q", pub)
	}
	prefix := strings.TrimRight(u.Path, "/") // 一级前缀（/oss）；多级拒绝
	if prefix != "" && strings.Count(prefix, "/") != 1 {
		return nil, fmt.Errorf("s3: public endpoint path prefix must be single-level: %q", prefix)
	}
	if o.Bucket == "" {
		o.Bucket = "bbw-data"
	}
	region := "us-east-1" // MinIO 忽略 region；S3 兼容端点通用占位
	creds := aws.NewCredentialsCache(awscred.NewStaticCredentialsProvider(o.AccessKey, o.SecretKey, ""))
	client := s3.New(s3.Options{
		Credentials: creds,
		Region:      region,
		BaseEndpoint: aws.String(o.Endpoint),
		UsePathStyle: true, // MinIO 必须 path-style（bucket 在路径首段）
	})
	up := manager.NewUploader(client, func(u *manager.Uploader) {
		u.PartSize = 8 << 20 // 未知长度流式：8MB 分片缓冲（relay 中转 ≤20MB → 内存上限可控）
		u.Concurrency = 2
		u.LeavePartsOnError = false
	})
	return &S3{
		client: client, uploader: up, creds: creds, region: region,
		bucket: o.Bucket,
		publicBase: u.Scheme + "://" + u.Host,
		urlPrefix:  prefix,
	}, nil
}

// ── 键布局 ──

func s3BlobKey(tenantID int64, sha256 string) string {
	return fmt.Sprintf("t/%d/%s/%s", tenantID, sha256[:2], sha256)
}

func s3TmpKey() string { return "tmp/" + randomHex(16) }

func s3StagingKey(uploadID string, no int) string {
	return fmt.Sprintf("s2/%s/%05d", uploadID, no)
}

// MpKey 分片直传会话对象键（presign 模式 multipart 目标；s/{uploadID}）
func MpKey(uploadID string) string { return "s/" + uploadID }

// BlobKey 内容对象键（O2 service 层拼 variant 用）
func BlobKey(tenantID int64, sha256 string) string { return s3BlobKey(tenantID, sha256) }

// VariantKey 缩略变体键（service 层预签名直指变体用）
func VariantKey(tenantID int64, sha256, variant string) string {
	return s3VariantKey(tenantID, sha256, variant)
}

// isNotFound 404 归一（NoSuchKey/NotFound/HTTP 404 三形态）
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	var nk *s3types.NoSuchKey
	if errors.As(err, &nk) {
		return true
	}
	var nf *s3types.NotFound
	if errors.As(err, &nf) {
		return true
	}
	var re *smithyhttp.ResponseError
	if errors.As(err, &re) && re.HTTPStatusCode() == 404 {
		return true
	}
	return false
}

// countingReader 边流边算 sha/计数，超 maxBytes 即 ErrTooLarge（读端中止，不无界缓冲）
type countingReader struct {
	r        io.Reader
	max      int64
	n        int64
	sha      hash.Hash
	tooLarge bool
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.n += int64(n)
		if c.n > c.max {
			c.tooLarge = true
			return 0, ErrTooLarge
		}
		if c.sha != nil {
			_, _ = c.sha.Write(p[:n])
		}
	}
	return n, err
}

// ── Storage 接口实现 ──

// Save 流式上传临时对象（未知长度走 manager 分片；算 sha 返回 tmpKey）
func (s *S3) Save(ctx context.Context, tenantID int64, r io.Reader, maxBytes int64) (int64, string, string, error) {
	_ = tenantID // 内容寻址键在 Promote 落位，临时键与租户无关
	key := s3TmpKey()
	cr := &countingReader{r: r, max: maxBytes, sha: sha256.New()}
	_, err := s.uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), Body: cr,
	})
	if err != nil {
		_, _ = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
		if cr.tooLarge {
			return 0, "", "", ErrTooLarge
		}
		return 0, "", "", fmt.Errorf("s3: upload tmp: %w", err)
	}
	return cr.n, hex.EncodeToString(cr.sha.Sum(nil)), key, nil
}

// Promote 临时对象 copy 落位（relay 中转路径 ≤20MB，单 CopyObject 安全；
// presign 大对象走 O2 CopyTo>5GB 分段拷贝）+ 清理临时对象
func (s *S3) Promote(ctx context.Context, tenantID int64, sha256, tmpKey string) error {
	dst := s3BlobKey(tenantID, sha256)
	if ok, _ := s.StatExists(ctx, dst); ok {
		_, _ = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(tmpKey)})
		return nil // 同内容并发/历史遗留：直接复用既有对象
	}
	_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(dst),
		CopySource: aws.String(s.bucket + "/" + tmpKey),
	})
	if err != nil {
		return fmt.Errorf("s3: promote copy: %w", err)
	}
	_, _ = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(tmpKey)})
	return nil
}

// Open 内容对象只读流
func (s *S3) Open(ctx context.Context, tenantID int64, sha256 string) (io.ReadCloser, error) {
	return s.OpenKey(ctx, s3BlobKey(tenantID, sha256))
}

// Head 预读前 n 字节 + 从头完整流（MultiReader 重组；调用方负责 Close）
func (s *S3) Head(ctx context.Context, tenantID int64, sha256 string, n int) ([]byte, io.ReadCloser, error) {
	rc, err := s.OpenKey(ctx, s3BlobKey(tenantID, sha256))
	if err != nil {
		return nil, nil, err
	}
	head := make([]byte, n)
	got, err := io.ReadFull(rc, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		rc.Close()
		return nil, nil, err
	}
	return head[:got], &closerReader{io.MultiReader(bytes.NewReader(head[:got]), rc), rc.Close}, nil
}

// SaveStaging relay PATCH 兼容路径：分片落普通对象（presign 模式不经过；覆盖写=坏块重传）
func (s *S3) SaveStaging(ctx context.Context, uploadID string, no int, r io.Reader, maxBytes int64) error {
	key := s3StagingKey(uploadID, no)
	cr := &countingReader{r: r, max: maxBytes}
	_, err := s.uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), Body: cr,
	})
	if err != nil {
		if cr.tooLarge {
			return ErrTooLarge
		}
		return fmt.Errorf("s3: staging upload: %w", err)
	}
	return nil
}

// ListStaging relay 位图：s2/{uploadID}/ 前缀列表 → 分片号升序
func (s *S3) ListStaging(ctx context.Context, uploadID string) ([]int, error) {
	prefix := fmt.Sprintf("s2/%s/", uploadID)
	out := []int{}
	pag := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket), Prefix: aws.String(prefix),
	})
	for pag.HasMorePages() {
		page, err := pag.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("s3: staging list: %w", err)
		}
		for _, o := range page.Contents {
			if no, perr := strconv.Atoi(path.Base(*o.Key)); perr == nil {
				out = append(out, no)
			}
		}
	}
	sort.Ints(out)
	return out, nil
}

// OpenStaging relay 分片只读流
func (s *S3) OpenStaging(ctx context.Context, uploadID string, no int) (io.ReadCloser, error) {
	return s.OpenKey(ctx, s3StagingKey(uploadID, no))
}

// RemoveStaging 清会话暂存前缀（列表+批量删）
func (s *S3) RemoveStaging(ctx context.Context, uploadID string) error {
	return s.deletePrefix(ctx, fmt.Sprintf("s2/%s/", uploadID))
}

// ResetStaging 启动清扫：s2/ 孤儿分片 + 全部在途 multipart（内存会话失配即作废）
func (s *S3) ResetStaging() error {
	ctx := context.Background()
	if err := s.deletePrefix(ctx, "s2/"); err != nil {
		return err
	}
	mp, err := s.client.ListMultipartUploads(ctx, &s3.ListMultipartUploadsInput{Bucket: aws.String(s.bucket)})
	if err != nil {
		return fmt.Errorf("s3: list multipart: %w", err)
	}
	for _, u := range mp.Uploads {
		_, _ = s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
			Bucket: aws.String(s.bucket), Key: u.Key, UploadId: u.UploadId,
		})
	}
	return nil
}

// ── 通用对象操作（O2 编排用） ──

// OpenKey 按任意键开流（内容/缩略/staging 合并体通用）
func (s *S3) OpenKey(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("s3: get %s: %w", key, err)
	}
	return out.Body, nil
}

// PutBytes 小对象整写（缩略图）
func (s *S3) PutBytes(ctx context.Context, key, contentType string, data []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
		ContentType: aws.String(contentType), Body: bytes.NewReader(data),
	})
	if err != nil {
		return fmt.Errorf("s3: put %s: %w", key, err)
	}
	return nil
}

// StatExists 对象存在性
func (s *S3) StatExists(ctx context.Context, key string) (bool, error) {
	_, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err == nil {
		return true, nil
	}
	if isNotFound(err) {
		return false, nil
	}
	return false, fmt.Errorf("s3: head %s: %w", key, err)
}

// CopyTo staging 合并体 → 内容键落位：≤5GB 单 CopyObject；>5GB UploadPartCopy 分段环
func (s *S3) CopyTo(ctx context.Context, srcKey, dstKey string, size int64) error {
	const maxCopy = 5 << 30 // S3 CopyObject 单次上限
	if ok, _ := s.StatExists(ctx, dstKey); ok {
		return nil // 幂等：目标已存在直接复用
	}
	if size <= maxCopy {
		_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
			Bucket: aws.String(s.bucket), Key: aws.String(dstKey),
			CopySource: aws.String(s.bucket + "/" + srcKey),
		})
		if err != nil {
			return fmt.Errorf("s3: copy: %w", err)
		}
		return nil
	}
	// 分段拷贝：CreateMultipart(dst) → 逐段 UploadPartCopy → Complete
	cm, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(dstKey),
	})
	if err != nil {
		return fmt.Errorf("s3: copy create mp: %w", err)
	}
	parts := []s3types.CompletedPart{}
	const seg = maxCopy
	var off int64
	for no := int32(1); off < size; no++ {
		end := off + seg - 1
		if end >= size {
			end = size - 1
		}
		up, err := s.client.UploadPartCopy(ctx, &s3.UploadPartCopyInput{
			Bucket: aws.String(s.bucket), Key: aws.String(dstKey), UploadId: cm.UploadId,
			CopySource: aws.String(s.bucket + "/" + srcKey),
			CopySourceRange: aws.String(fmt.Sprintf("bytes=%d-%d", off, end)),
		})
		if err != nil {
			_, _ = s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
				Bucket: aws.String(s.bucket), Key: aws.String(dstKey), UploadId: cm.UploadId,
			})
			return fmt.Errorf("s3: copy part %d: %w", no, err)
		}
		parts = append(parts, s3types.CompletedPart{ETag: up.CopyPartResult.ETag, PartNumber: aws.Int32(no)})
		off = end + 1
	}
	_, err = s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(dstKey), UploadId: cm.UploadId,
		MultipartUpload: &s3types.CompletedMultipartUpload{Parts: parts},
	})
	if err != nil {
		return fmt.Errorf("s3: copy complete: %w", err)
	}
	return nil
}

// ── multipart 会话（presign 模式，O2 编排消费） ──

// CreateMultipart 建原生分片会话（key=s/{uploadID}）→ S3 UploadId（service 层持有映射）
func (s *S3) CreateMultipart(ctx context.Context, uploadID string) (string, error) {
	key := MpKey(uploadID)
	out, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
	})
	if err != nil {
		return "", fmt.Errorf("s3: create mp: %w", err)
	}
	return *out.UploadId, nil
}

// PresignPart 分片 PUT 预签名（query 携带 uploadId/partNumber；签名按去前缀路径+对外 host）
func (s *S3) PresignPart(ctx context.Context, uploadID, s3UploadID string, no int, ttl time.Duration) (string, error) {
	q := url.Values{}
	q.Set("partNumber", strconv.Itoa(no))
	q.Set("uploadId", s3UploadID)
	return s.presign(ctx, http.MethodPut, MpKey(uploadID), q, ttl)
}

// PresignGet 下载预签名 GET（variant/任意键；120s 语义由调用方控制）
func (s *S3) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	return s.presign(ctx, http.MethodGet, key, url.Values{}, ttl)
}

// presign 手签 v4 query（S3 presigned 语义：UNSIGNED-PAYLOAD）：
// 规范路径=/{bucket}/{key}（不含 /oss 前缀）+ 对外 host → 签后把前缀拼回最终 URL
func (s *S3) presign(ctx context.Context, method, key string, q url.Values, ttl time.Duration) (string, error) {
	creds, err := s.creds.Retrieve(ctx)
	if err != nil {
		return "", fmt.Errorf("s3: creds: %w", err)
	}
	q.Set("X-Amz-Expires", strconv.FormatInt(int64(ttl.Seconds()), 10))
	u := s.publicBase + "/" + s.bucket + "/" + key + "?" + q.Encode()
	req, err := http.NewRequest(method, u, nil)
	if err != nil {
		return "", err
	}
	signer := v4signer.NewSigner()
	signedURI, _, err := signer.PresignHTTP(ctx, creds, req, "UNSIGNED-PAYLOAD", "s3", s.region, time.Now())
	if err != nil {
		return "", fmt.Errorf("s3: presign: %w", err)
	}
	if s.urlPrefix == "" {
		return signedURI, nil
	}
	// 拼回对外前缀（签名按去前缀路径计算，nginx strip 后 MinIO 可验——D25 拍板②）
	final, err := url.Parse(signedURI)
	if err != nil {
		return "", fmt.Errorf("s3: presign parse: %w", err)
	}
	final.Path = s.urlPrefix + final.Path
	return final.String(), nil
}

// ListPartNumbers 已上传分片号（断点位图=ListParts 服务端真值）
func (s *S3) ListPartNumbers(ctx context.Context, uploadID, s3UploadID string) ([]int, error) {
	out := []int{}
	var cont *string
	for {
		lp, err := s.client.ListParts(ctx, &s3.ListPartsInput{
			Bucket: aws.String(s.bucket), Key: aws.String(MpKey(uploadID)), UploadId: aws.String(s3UploadID),
			PartNumberMarker: cont,
		})
		if err != nil {
			if isNotFound(err) {
				return nil, nil // 会话不存在（未建/已 complete）视作空
			}
			return nil, fmt.Errorf("s3: list parts: %w", err)
		}
		for _, p := range lp.Parts {
			if p.PartNumber != nil {
				out = append(out, int(*p.PartNumber))
			}
		}
		if lp.NextPartNumberMarker == nil || *lp.NextPartNumberMarker == "" {
			break
		}
		cont = lp.NextPartNumberMarker
	}
	sort.Ints(out)
	return out, nil
}

// CompleteMultipart 服务端收口：ListParts 真值排序 → Complete（不信任端侧分片清单）
func (s *S3) CompleteMultipart(ctx context.Context, uploadID, s3UploadID string) (int, error) {
	parts := []s3types.CompletedPart{}
	var cont *string
	for {
		lp, err := s.client.ListParts(ctx, &s3.ListPartsInput{
			Bucket: aws.String(s.bucket), Key: aws.String(MpKey(uploadID)), UploadId: aws.String(s3UploadID),
			PartNumberMarker: cont,
		})
		if err != nil {
			return 0, fmt.Errorf("s3: complete list parts: %w", err)
		}
		for _, p := range lp.Parts {
			parts = append(parts, s3types.CompletedPart{ETag: p.ETag, PartNumber: p.PartNumber})
		}
		if lp.NextPartNumberMarker == nil || *lp.NextPartNumberMarker == "" {
			break
		}
		cont = lp.NextPartNumberMarker
	}
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(MpKey(uploadID)), UploadId: aws.String(s3UploadID),
		MultipartUpload: &s3types.CompletedMultipartUpload{Parts: parts},
	})
	if err != nil {
		return 0, fmt.Errorf("s3: complete mp: %w", err)
	}
	return len(parts), nil
}

// AbortMultipart 作废会话（complete 校验失败/超时清理）
func (s *S3) AbortMultipart(ctx context.Context, uploadID, s3UploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(MpKey(uploadID)), UploadId: aws.String(s3UploadID),
	})
	if err != nil && !isNotFound(err) {
		return fmt.Errorf("s3: abort mp: %w", err)
	}
	return nil
}

// DeleteKey 删对象（缩略不生成时清理/staging 合并体回收）
func (s *S3) DeleteKey(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	return err
}

// ── 缩略图变体（D25 拍板⑥：t/{tenant}/{sha2}/{sha}_t{240|720}.jpg） ──

func s3VariantKey(tenantID int64, sha256, variant string) string {
	return s3BlobKey(tenantID, sha256) + "_t" + variant + ".jpg"
}

// PutVariant 写变体
func (s *S3) PutVariant(ctx context.Context, tenantID int64, sha256, variant, contentType string, data []byte) error {
	return s.PutBytes(ctx, s3VariantKey(tenantID, sha256, variant), contentType, data)
}

// HasVariant 变体存在性
func (s *S3) HasVariant(ctx context.Context, tenantID int64, sha256, variant string) bool {
	ok, err := s.StatExists(ctx, s3VariantKey(tenantID, sha256, variant))
	return err == nil && ok
}

// OpenVariant 开变体只读流（缺失 ErrNotFound）
func (s *S3) OpenVariant(ctx context.Context, tenantID int64, sha256, variant string) (io.ReadCloser, error) {
	rc, err := s.OpenKey(ctx, s3VariantKey(tenantID, sha256, variant))
	if err == ErrNotFound {
		return nil, ErrNotFound
	}
	return rc, err
}

// ── 内部 ──

// deletePrefix 前缀批量删（每页 ≤1000）
func (s *S3) deletePrefix(ctx context.Context, prefix string) error {
	pag := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket), Prefix: aws.String(prefix),
	})
	for pag.HasMorePages() {
		page, err := pag.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("s3: list %s: %w", prefix, err)
		}
		if len(page.Contents) == 0 {
			continue
		}
		objs := make([]s3types.ObjectIdentifier, 0, len(page.Contents))
		for _, o := range page.Contents {
			objs = append(objs, s3types.ObjectIdentifier{Key: o.Key})
		}
		if _, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(s.bucket),
			Delete: &s3types.Delete{Objects: objs, Quiet: aws.Bool(true)},
		}); err != nil {
			return fmt.Errorf("s3: delete %s: %w", prefix, err)
		}
	}
	return nil
}

// closerReader 流关闭透传（MultiReader 包装用）
type closerReader struct {
	io.Reader
	closeFn func() error
}

func (c *closerReader) Close() error { return c.closeFn() }
