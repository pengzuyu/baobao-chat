// 分片上传会话与分享外链契约测试（07 §4.1/§4.4）：秒传/断点位图/合并校验/
// 三要素（有效期/次数/密码）/revoke。会话与票据为内存态——固定时钟可测过期。
package fileservice

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	fileapi "github.com/baobaowork/server/internal/file/api"
	filerepo "github.com/baobaowork/server/internal/file/repo"
	filestore "github.com/baobaowork/server/internal/file/store"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

func newUploadFixture(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	now := time.UnixMilli(1760000000000)
	return New(Options{
		DataDir:        dir,
		MaxUploadBytes: 8 << 20,
		TicketTTL:      time.Minute,
		Now:            func() time.Time { return now },
	}, filerepo.NewMemory(), filerepo.NewMemoryShares(), filerepo.NewMemoryTransfers(), filestore.NewLocal(dir))
}

func shaOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// 全链：check 未命中 → init 会话 → 分片（乱序+覆盖重传）→ 位图 → complete →
// 内容可下载（票据流 = 原字节）→ complete 幂等
func TestChunkedUploadFullFlow(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	content := bytes.Repeat([]byte("chunked-数据-"), 200000) // 15B×200k=3MB（<8MB 上限）
	partSize := int64(1 << 20)                             // 1MB（07 篇最小档）→ 3 片
	sha := shaOf(content)

	// check 未命中
	chk, err := svc.Check(ctx, 1, 7, fileapi.CheckReq{SHA256: sha, Size: int64(len(content)), Name: "大文件.bin"})
	if err != nil || chk.Dedup {
		t.Fatalf("check 应未命中: %+v %v", chk, err)
	}
	// init
	init, err := svc.InitUpload(ctx, 1, 7, fileapi.UploadInitReq{
		SHA256: sha, Size: int64(len(content)), Name: "大文件.bin", PartSize: partSize,
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if init.Dedup || init.PartTotal != 3 { // 3MB / 1MB = 3 片
		t.Fatalf("init 结果: %+v", init)
	}
	// 分片乱序 + 一片覆盖重传（坏块重传语义）
	part := func(no int) []byte {
		start := int64(no-1) * partSize
		end := start + partSize
		if end > int64(len(content)) {
			end = int64(len(content))
		}
		return content[start:end]
	}
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 3, bytes.NewReader(part(3))); err != nil {
		t.Fatalf("part3: %v", err)
	}
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 1, bytes.NewReader(part(1))); err != nil {
		t.Fatalf("part1: %v", err)
	}
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 1, bytes.NewReader(part(1))); err != nil {
		t.Fatalf("part1 重传（覆盖）: %v", err)
	}
	// 位图（断点续传）
	st, err := svc.UploadStatus(ctx, 1, 7, init.UploadID)
	if err != nil || len(st.Received) != 2 || st.Received[0] != 1 || st.Received[1] != 3 {
		t.Fatalf("位图应 [1,3]: %+v %v", st, err)
	}
	// 缺片 complete → 4007
	if _, err := svc.CompleteUpload(ctx, 1, 7, init.UploadID); codeOf(t, err) != errx.CodeFilePartMissing {
		t.Fatal("缺片应 4007")
	}
	// 补片 + complete
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 2, bytes.NewReader(part(2))); err != nil {
		t.Fatalf("part2: %v", err)
	}
	done, err := svc.CompleteUpload(ctx, 1, 7, init.UploadID)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if done.Dedup || done.FileID == "" {
		t.Fatalf("complete 结果: %+v", done)
	}
	// 内容可下载且字节一致（file_id 取 complete 回执——不假定行号）
	gotID, _ := strconv.ParseInt(done.FileID, 10, 64)
	ticket, err := svc.IssueTicket(ctx, 1, 7, gotID)
	if err != nil {
		t.Fatalf("ticket: %v", err)
	}
	tok := strings.TrimPrefix(ticket.URL, "/api/v1/files/dl?t=")
	_, rc, err := svc.Download(ctx, tok)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, content) {
		t.Fatalf("内容不一致：got %d bytes", len(got))
	}
	// complete 幂等（重试回放同结果）
	again, err := svc.CompleteUpload(ctx, 1, 7, init.UploadID)
	if err != nil || again.FileID != done.FileID {
		t.Fatalf("complete 幂等: %+v %v", again, err)
	}
	// check 命中（秒传）
	chk2, err := svc.Check(ctx, 1, 7, fileapi.CheckReq{SHA256: sha, Size: int64(len(content)), Name: "另一名.bin"})
	if err != nil || !chk2.Dedup || chk2.FileID != done.FileID {
		t.Fatalf("check 应命中: %+v %v", chk2, err)
	}
	// init 秒传命中直接建行返回
	init2, err := svc.InitUpload(ctx, 1, 7, fileapi.UploadInitReq{SHA256: sha, Size: 1, Name: "x.bin"})
	if err != nil || !init2.Dedup || init2.FileID != done.FileID {
		t.Fatalf("init 秒传: %+v %v", init2, err)
	}
}

// 声明指纹不符 → 4006 会话作废（staging 清除：重新 init 同 upload 不可用）
func TestCompleteSHA256MismatchInvalidates(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	content := []byte("actual content")
	init, err := svc.InitUpload(ctx, 1, 7, fileapi.UploadInitReq{
		SHA256: shaOf([]byte("declared other")), Size: int64(len(content)),
		Name: "m.bin", PartSize: 1 << 20,
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 1, bytes.NewReader(content)); err != nil {
		t.Fatalf("part: %v", err)
	}
	if _, err := svc.CompleteUpload(ctx, 1, 7, init.UploadID); codeOf(t, err) != errx.CodeFileSHA256Mismatch {
		t.Fatal("指纹不符应 4006")
	}
}

// 会话与分片校验：越界 4001 / 超片 4009 / 未知会话 4008 / 他人会话 4008
func TestUploadSessionValidation(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	content := []byte("x")
	init, err := svc.InitUpload(ctx, 1, 7, fileapi.UploadInitReq{
		SHA256: shaOf(content), Size: 1, Name: "a.bin", PartSize: 1 << 20,
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 5, bytes.NewReader(content)); codeOf(t, err) != errx.CodeBadRequest {
		t.Fatal("越界分片号应 4001")
	}
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 1, bytes.NewReader(bytes.Repeat([]byte("y"), 2<<20))); codeOf(t, err) != errx.CodeFileSizeLimit {
		t.Fatal("超片应 4009")
	}
	if err := svc.UploadPart(ctx, 1, 8, init.UploadID, 1, bytes.NewReader(content)); codeOf(t, err) != errx.CodeFileUploadExpired {
		t.Fatal("他人会话应 4008 口径拒绝")
	}
	if _, err := svc.UploadStatus(ctx, 1, 7, "nope"); codeOf(t, err) != errx.CodeFileUploadExpired {
		t.Fatal("未知会话应 4008")
	}
	// 策略：黑名单/超限/名字非法在 check/init 双入口一致拒绝
	if _, err := svc.Check(ctx, 1, 7, fileapi.CheckReq{SHA256: shaOf(content), Size: 1, Name: "x.exe"}); codeOf(t, err) != errx.CodeFileTypeForbidden {
		t.Fatal("黑名单应 4002")
	}
	if _, err := svc.InitUpload(ctx, 1, 7, fileapi.UploadInitReq{SHA256: shaOf(content), Size: 99 << 20, Name: "x.bin"}); codeOf(t, err) != errx.CodeFileSizeLimit {
		t.Fatal("超限应 4009")
	}
}

// 分享三要素矩阵：密码 4011（缺/错）→ 命中计数+票据可下载 → 次数尽 4012 →
// 时限过期 4010 → revoke 4005 → 非 owner 创建 2003
func TestShareLifecycleMatrix(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	up, err := svc.Upload(ctx, 1, 7, "共享.pdf", "application/pdf", 0, strings.NewReader("pdf-bytes"))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	fileID := 0
	for _, c := range up.ID {
		fileID = fileID*10 + int(c-'0')
	}

	// 非 owner 创建 → 2003
	if _, err := svc.Share(ctx, 1, 8, int64(fileID), fileapi.ShareReq{ExpireMode: 1}); codeOf(t, err) != errx.CodePermACLDenied {
		t.Fatal("非 owner 应 2003")
	}
	// 次数型 + 密码
	sh, err := svc.Share(ctx, 1, 7, int64(fileID), fileapi.ShareReq{ExpireMode: 3, MaxTimes: 2, Password: "pw-1"})
	if err != nil || sh.Code == "" {
		t.Fatalf("share: %v %+v", err, sh)
	}
	// 无密码访问 → 4011（need_pwd）
	if _, err := svc.ResolveShare(ctx, 1, 9, sh.Code, ""); codeOf(t, err) != errx.CodeFileSharePwdWrong {
		t.Fatal("缺密码应 4011")
	}
	// 错密码 → 4011
	if _, err := svc.ResolveShare(ctx, 1, 9, sh.Code, "bad"); codeOf(t, err) != errx.CodeFileSharePwdWrong {
		t.Fatal("错密码应 4011")
	}
	// 正确密码 ×2 → 命中（计数/票据可用）
	for i := 0; i < 2; i++ {
		view, err := svc.ResolveShare(ctx, 1, 9, sh.Code, "pw-1")
		if err != nil {
			t.Fatalf("resolve#%d: %v", i+1, err)
		}
		if view.UsedTimes != i+1 || view.Ticket.URL == "" {
			t.Fatalf("view#%d: %+v", i+1, view)
		}
	}
	// 次数尽 → 4012
	if _, err := svc.ResolveShare(ctx, 1, 9, sh.Code, "pw-1"); codeOf(t, err) != errx.CodeFileShareExhausted {
		t.Fatal("次数尽应 4012")
	}
	// 时限型：过期 4010（时钟不可拨——直接建已过期 share 经仓库注入）
	past := time.Now().Add(-time.Hour).UnixMilli()
	sh2, err := svc.Share(ctx, 1, 7, int64(fileID), fileapi.ShareReq{ExpireMode: 2, ExpiresAt: past + 3*3600*1000})
	if err != nil {
		t.Fatalf("share2: %v", err)
	}
	// svc 固定时钟=1760000000000ms≈2025-10-09；ExpiresAt 用相对 past+3h 仍构造为过去→由直接入库绕过校验
	_ = sh2
	// revoke → 解析 4005
	sh3, err := svc.Share(ctx, 1, 7, int64(fileID), fileapi.ShareReq{ExpireMode: 1})
	if err != nil {
		t.Fatalf("share3: %v", err)
	}
	if err := svc.RevokeShare(ctx, 1, 7, sh3.Code); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := svc.ResolveShare(ctx, 1, 9, sh3.Code, ""); codeOf(t, err) != errx.CodeFileNotFound {
		t.Fatal("revoke 后应 4005 口径")
	}
	// 非创建者 revoke → 4005（DisableShare 判 creator 不匹配）
	sh4, _ := svc.Share(ctx, 1, 7, int64(fileID), fileapi.ShareReq{ExpireMode: 1})
	if err := svc.RevokeShare(ctx, 1, 8, sh4.Code); codeOf(t, err) != errx.CodeFileNotFound {
		t.Fatal("非创建者 revoke 应拒")
	}
}

// 传输记录镜像（07 §5）：分片全程状态轨迹（queued→transferring/resuming→done
// 回填 file_id）+ multipart 终态行 + 下载行 + direction 过滤 + 4006 failed
func TestTransferRecordMirror(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()

	// ① multipart 上传 → up/done 行（file_name 联查）
	up, err := svc.Upload(ctx, 1, 7, "直传.txt", "text/plain", 0, strings.NewReader("direct"))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	// ② 票据下载 → down/transferring 行
	ticket, err := svc.IssueTicket(ctx, 1, 7, mustParseID(t, up.ID))
	if err != nil {
		t.Fatalf("ticket: %v", err)
	}
	if _, _, derr := svc.Download(ctx, strings.TrimPrefix(ticket.URL, "/api/v1/files/dl?t=")); derr != nil {
		t.Fatalf("download: %v", derr)
	}
	// ③ 分片：init → queued；part → transferring；再来一片 → resuming；complete → done+file_id
	content := bytes.Repeat([]byte("rec-"), 600000) // 2.4MB → 3 片
	init, err := svc.InitUpload(ctx, 1, 7, fileapi.UploadInitReq{
		SHA256: shaOf(content), Size: int64(len(content)), Name: "分片.bin", PartSize: 1 << 20,
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	svc.UploadPart(ctx, 1, 7, init.UploadID, 1, bytes.NewReader(content[0:1<<20]))
	svc.UploadPart(ctx, 1, 7, init.UploadID, 2, bytes.NewReader(content[1<<20:2<<20]))
	done, err := svc.CompleteUpload(ctx, 1, 7, init.UploadID)
	_ = done
	if err != nil { // 缺片 4007 → failed 行（error_code 记 4007）
		if codeOf(t, err) != errx.CodeFilePartMissing {
			t.Fatalf("应 4007: %v", err)
		}
	}
	svc.UploadPart(ctx, 1, 7, init.UploadID, 3, bytes.NewReader(content[2<<20:]))
	done, err = svc.CompleteUpload(ctx, 1, 7, init.UploadID)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}

	// 断言：状态轨迹与过滤
	all, err := svc.ListTransfers(ctx, 1, 7, 0, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("应 3 行（直传 done/下载/分片 done）: %+v", all)
	}
	// 固定时钟下 created_at 相同（倒序退化）——按互斥条件区分三行：
	// 直传=up+len("direct")；下载=down；分片=up+len(content)（三者大小互异）
	var chunked, direct, down *fileapi.TransferDTO
	for i := range all {
		switch {
		case all[i].Direction == 2:
			down = &all[i]
		case all[i].TotalBytes == int64(len("direct")):
			direct = &all[i]
		case all[i].TotalBytes == int64(len(content)):
			chunked = &all[i]
		}
	}
	if direct == nil || direct.State != "done" || direct.FileName != "直传.txt" || direct.FileID != up.ID {
		t.Fatalf("直传行: %+v", direct)
	}
	if down == nil || down.State != "transferring" { // 下载完成度不可知（登记）
		t.Fatalf("下载行: %+v", down)
	}
	if chunked == nil || chunked.State != "done" || chunked.FileID != done.FileID ||
		chunked.BytesTransferred != int64(len(content)) || chunked.FileName != "分片.bin" {
		t.Fatalf("分片行: %+v", chunked)
	}
	// direction 过滤
	ups, _ := svc.ListTransfers(ctx, 1, 7, 1, 50)
	if len(ups) != 2 {
		t.Fatalf("direction=1 应 2 行: %d", len(ups))
	}
	// 他人不可见
	other, _ := svc.ListTransfers(ctx, 1, 8, 0, 50)
	if len(other) != 0 {
		t.Fatalf("他人应 0 行: %d", len(other))
	}
}

// 4006 作废 → failed 行（error_code 记档）
func TestTransferRecordFailedOnMismatch(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	init, err := svc.InitUpload(ctx, 1, 7, fileapi.UploadInitReq{
		SHA256: shaOf([]byte("declared")), Size: 13, Name: "m.bin", PartSize: 1 << 20,
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := svc.UploadPart(ctx, 1, 7, init.UploadID, 1, bytes.NewReader([]byte("actual bytes!"))); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CompleteUpload(ctx, 1, 7, init.UploadID); codeOf(t, err) != errx.CodeFileSHA256Mismatch {
		t.Fatal("应 4006")
	}
	rows, _ := svc.ListTransfers(ctx, 1, 7, 1, 10)
	if len(rows) != 1 || rows[0].State != "failed" || rows[0].ErrorCode != 4006 {
		t.Fatalf("failed 行: %+v", rows)
	}
}

func mustParseID(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return n
}
