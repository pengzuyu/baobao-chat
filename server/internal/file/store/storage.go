// Package store 文件内容存储层（v0.1 务实口径：单机本地磁盘）。
// 布局：{DataDir}/files/{tenant}/{sha前2}/{sha256}（内容寻址，07 篇 §5.5 的本地盘形态）。
// 写入路径：临时名 → 全量流式落盘并计算 sha256 → rename 原子落位（v0.1 无分片/断点续传，
// 客户端单请求 multipart 直传 ≤20MB，登记）。对象存储/预签名 URL 阶段二替换本实现。
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
)

// ErrTooLarge 超单文件大小上限（service 映射 4009）
var ErrTooLarge = errors.New("storage: exceed max upload size")

// ErrNotFound 内容对象不存在（物理文件缺失；service 映射 4005）
var ErrNotFound = errors.New("storage: blob not found")

// Storage 内容存储接口（Local/S3 双实现，D25；S3 后端=RustFS，D29）
type Storage interface {
	// Save 流式写入临时文件并计算 sha256，返回 (字节数, sha256, 临时路径)。
	// 超过 maxBytes 立刻中止并清理临时文件返回 ErrTooLarge。
	Save(ctx context.Context, tenantID int64, r io.Reader, maxBytes int64) (size int64, sha256, tmpPath string, err error)
	// Promote 临时文件 rename 原子落位到内容寻址路径；目标已存在（同内容并发/历史遗留）
	// 则删除临时文件直接复用既有对象（幂等）
	Promote(ctx context.Context, tenantID int64, sha256, tmpPath string) error
	// Open 打开内容对象（只读流；调用方负责 Close）
	Open(ctx context.Context, tenantID int64, sha256 string) (io.ReadCloser, error)
	// Head 打开内容对象并返回前 n 字节（image.DecodeConfig 宽高解析用）
	Head(ctx context.Context, tenantID int64, sha256 string, n int) ([]byte, io.ReadCloser, error)

	// ── 分片暂存（07 §4.1 ④⑥⑦ 本地盘形态；对象存储实现走 staging 前缀） ──
	// SaveStaging 写入/覆盖分片：staging/{uploadID}/{no:05d}（覆盖写支持坏块重传）
	SaveStaging(ctx context.Context, uploadID string, no int, r io.Reader, maxBytes int64) error
	// ListStaging 已落盘分片号（断点续传位图；无目录返回空）
	ListStaging(ctx context.Context, uploadID string) ([]int, error)
	// OpenStaging 打开指定分片（complete 顺序合并用；只读流）
	OpenStaging(ctx context.Context, uploadID string, no int) (io.ReadCloser, error)
	// RemoveStaging 清除整个会话暂存目录（complete 成功/作废后调用）
	RemoveStaging(ctx context.Context, uploadID string) error
	// ResetStaging 清空全部暂存（启动期孤儿回收——会话元数据内存态，重启即失配）
	ResetStaging() error

	// ── 缩略图变体（D25 拍板⑥：内容对象旁挂 {sha}_t{240|720}.jpg） ──
	// PutVariant 写变体字节（惰性生成落位；variant ∈ {240,720}）
	PutVariant(ctx context.Context, tenantID int64, sha256, variant string, contentType string, data []byte) error
	// HasVariant 变体存在性（存在则票据直指变体；不存在触发惰性生成/回退原图）
	HasVariant(ctx context.Context, tenantID int64, sha256, variant string) bool
	// OpenVariant 开变体只读流（缺失返回 ErrNotFound——调用方回退原图）
	OpenVariant(ctx context.Context, tenantID int64, sha256, variant string) (io.ReadCloser, error)
}

// Local 本地磁盘实现
type Local struct{ dataDir string }

var _ Storage = (*Local)(nil)

// NewLocal 构造（dataDir 不存在时按需创建）
func NewLocal(dataDir string) *Local { return &Local{dataDir: dataDir} }

// blobPath 内容寻址路径：{dataDir}/files/{tenant}/{sha前2}/{sha256}
func (l *Local) blobPath(tenantID int64, sha256 string) string {
	return filepath.Join(l.dataDir, "files", fmt.Sprint(tenantID), sha256[:2], sha256)
}

// Save 流式写入：临时名（{dataDir}/tmp/{随机}）→ 计算 sha → 由调用方 Promote 落位
func (l *Local) Save(ctx context.Context, tenantID int64, r io.Reader, maxBytes int64) (int64, string, string, error) {
	tmpDir := filepath.Join(l.dataDir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return 0, "", "", fmt.Errorf("storage: mkdir tmp: %w", err)
	}
	tmp, err := os.CreateTemp(tmpDir, "up-*")
	if err != nil {
		return 0, "", "", fmt.Errorf("storage: create tmp: %w", err)
	}
	tmpPath := tmp.Name()

	var size int64
	hash := sha256.New()
	// maxBytes+1 探测：读到上限即判超限（4009），不做无界缓冲
	buf := make([]byte, 64<<10)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			size += int64(n)
			if size > maxBytes {
				tmp.Close()
				os.Remove(tmpPath)
				return 0, "", "", ErrTooLarge
			}
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				tmp.Close()
				os.Remove(tmpPath)
				return 0, "", "", fmt.Errorf("storage: write tmp: %w", werr)
			}
			hash.Write(buf[:n])
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			tmp.Close()
			os.Remove(tmpPath)
			return 0, "", "", fmt.Errorf("storage: read upload: %w", rerr)
		}
		if ctx.Err() != nil {
			tmp.Close()
			os.Remove(tmpPath)
			return 0, "", "", ctx.Err()
		}
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return 0, "", "", fmt.Errorf("storage: close tmp: %w", err)
	}
	return size, hex.EncodeToString(hash.Sum(nil)), tmpPath, nil
}

// Promote 原子落位：目标已存在直接复用（内容寻址天然幂等）
func (l *Local) Promote(ctx context.Context, tenantID int64, sha256, tmpPath string) error {
	dst := l.blobPath(tenantID, sha256)
	if _, err := os.Stat(dst); err == nil {
		return os.Remove(tmpPath) // 同内容并发/历史遗留：直接复用既有对象
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("storage: stat blob: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("storage: mkdir blob: %w", err)
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return fmt.Errorf("storage: promote rename: %w", err)
	}
	return nil
}

// Open 只读流
func (l *Local) Open(ctx context.Context, tenantID int64, sha256 string) (io.ReadCloser, error) {
	f, err := os.Open(l.blobPath(tenantID, sha256))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return f, nil
}

// Head 打开并预读前 n 字节（宽高解析用；调用方负责关闭返回的句柄）
func (l *Local) Head(ctx context.Context, tenantID int64, sha256 string, n int) ([]byte, io.ReadCloser, error) {
	f, err := os.Open(l.blobPath(tenantID, sha256))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	head := make([]byte, n)
	got, err := io.ReadFull(f, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		f.Close()
		return nil, nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil { // 句柄复用：回到文件头
		f.Close()
		return nil, nil, err
	}
	return head[:got], f, nil
}

// randomHex 随机 hex（临时文件名由 os.CreateTemp 生成，此处留工具供阶段二去重键复用）
func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ── 分片暂存实现（staging/{uploadID}/{no:05d}；07 §5.5 布局本地盘形态） ──

// stagingDir 会话暂存目录
func (l *Local) stagingDir(uploadID string) string {
	return filepath.Join(l.dataDir, "staging", uploadID)
}

// stagingPath 分片文件路径（05d 定宽保序）
func (l *Local) stagingPath(uploadID string, no int) string {
	return filepath.Join(l.stagingDir(uploadID), fmt.Sprintf("%05d", no))
}

// SaveStaging 写入/覆盖分片（原子性：临时文件写满后 rename——读端只见完整分片）
func (l *Local) SaveStaging(ctx context.Context, uploadID string, no int, r io.Reader, maxBytes int64) error {
	dir := l.stagingDir(uploadID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("storage: mkdir staging: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "part-*")
	if err != nil {
		return fmt.Errorf("storage: create staging tmp: %w", err)
	}
	tmpPath := tmp.Name()
	var size int64
	buf := make([]byte, 64<<10)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			size += int64(n)
			if size > maxBytes {
				tmp.Close()
				os.Remove(tmpPath)
				return ErrTooLarge
			}
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				tmp.Close()
				os.Remove(tmpPath)
				return fmt.Errorf("storage: write staging: %w", werr)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			tmp.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("storage: read staging: %w", rerr)
		}
		if ctx.Err() != nil {
			tmp.Close()
			os.Remove(tmpPath)
			return ctx.Err()
		}
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("storage: close staging: %w", err)
	}
	return os.Rename(tmpPath, l.stagingPath(uploadID, no))
}

// ListStaging 已落盘分片号升序
func (l *Local) ListStaging(_ context.Context, uploadID string) ([]int, error) {
	entries, err := os.ReadDir(l.stagingDir(uploadID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := []int{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if no, perr := strconv.Atoi(e.Name()); perr == nil {
			out = append(out, no)
		}
	}
	sort.Ints(out)
	return out, nil
}

// OpenStaging 打开分片只读流
func (l *Local) OpenStaging(_ context.Context, uploadID string, no int) (io.ReadCloser, error) {
	f, err := os.Open(l.stagingPath(uploadID, no))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return f, nil
}

// RemoveStaging 清除会话暂存目录（不存在容忍）
func (l *Local) RemoveStaging(_ context.Context, uploadID string) error {
	if err := os.RemoveAll(l.stagingDir(uploadID)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ResetStaging 清空全部暂存（启动孤儿回收）
func (l *Local) ResetStaging() error {
	if err := os.RemoveAll(filepath.Join(l.dataDir, "staging")); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ── 缩略图变体（D25：内容对象同目录 {sha}_t{240|720}.jpg） ──

// variantPath 变体文件路径（与内容对象同目录旁挂）
func (l *Local) variantPath(tenantID int64, sha256, variant string) string {
	return l.blobPath(tenantID, sha256) + "_t" + variant + ".jpg"
}

// PutVariant 写变体（0644 常规文件；目录已存在——内容对象落位时建过）
func (l *Local) PutVariant(_ context.Context, tenantID int64, sha256, variant, contentType string, data []byte) error {
	_ = contentType // 恒 image/jpeg（后缀已表达）
	return os.WriteFile(l.variantPath(tenantID, sha256, variant), data, 0o644)
}

// HasVariant 变体存在性
func (l *Local) HasVariant(_ context.Context, tenantID int64, sha256, variant string) bool {
	_, err := os.Stat(l.variantPath(tenantID, sha256, variant))
	return err == nil
}

// OpenVariant 开变体只读流（缺失 ErrNotFound）
func (l *Local) OpenVariant(_ context.Context, tenantID int64, sha256, variant string) (io.ReadCloser, error) {
	f, err := os.Open(l.variantPath(tenantID, sha256, variant))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return f, nil
}
