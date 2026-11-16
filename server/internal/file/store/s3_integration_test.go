// S3 集成测试（D29 批次 R2）：对真实 S3 兼容后端（部署=RustFS）全链验证。
// 门控（D25 §10 预留名落地）：BBW_TEST_S3_ADDR 非空才跑，离线 CI 零负担。
// 本地冒烟（RustFS 临时容器）：
//   docker run -d --name rustfs-smoke -p 9100:9000 -p 9101:9001 \
//     -e RUSTFS_ACCESS_KEY=bbw_smoke_ak -e RUSTFS_SECRET_KEY=bbw_smoke_sk888888 rustfs/rustfs:1.0.5
//   # 建桶（或复用 compose rustfs-init 语义）：aws s3api create-bucket --bucket bbw-data
//   BBW_TEST_S3_ADDR=http://127.0.0.1:9100 \
//   BBW_TEST_S3_ACCESS_KEY=bbw_smoke_ak BBW_TEST_S3_SECRET_KEY=bbw_smoke_sk888888 \
//   go test ./internal/file/store -run Integration -v
// 覆盖面=D29 §6：Save/Promote/Open/Head、CopyTo、relay staging、multipart 预签名真链
// （UNSIGNED-PAYLOAD 验签/分片 PUT/ListParts/Complete/Abort）、预签名 GET（含变体
// Content-Type）、前缀批量删（DeleteObjects）。
package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

// itStore 构造被测实例（门控：BBW_TEST_S3_ADDR 空=跳过）
func itStore(t *testing.T) *S3 {
	t.Helper()
	addr := os.Getenv("BBW_TEST_S3_ADDR")
	if addr == "" {
		t.Skip("BBW_TEST_S3_ADDR 未配置，跳过 S3 集成链（D29 R2 门控）")
	}
	ak := os.Getenv("BBW_TEST_S3_ACCESS_KEY")
	if ak == "" {
		ak = "bbw_smoke_ak"
	}
	sk := os.Getenv("BBW_TEST_S3_SECRET_KEY")
	if sk == "" {
		sk = "bbw_smoke_sk888888"
	}
	bucket := os.Getenv("BBW_TEST_S3_BUCKET")
	if bucket == "" {
		bucket = "bbw-data"
	}
	s, err := NewS3(S3Options{
		Endpoint: addr, PublicEndpoint: addr, // 直连形态（无 /oss 前缀链——那是 nginx 层，归真机验收）
		AccessKey: ak, SecretKey: sk, Bucket: bucket,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	return s
}

// itRand 唯一后缀（隔离并发/重复跑）
func itRand() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func mustReadAll(t *testing.T, r io.Reader) []byte {
	t.Helper()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("读流失败: %v", err)
	}
	return b
}

// TestS3IntegrationSavePromoteOpen relay 中转路径：Save→Promote→Open/Head 往返
func TestS3IntegrationSavePromoteOpen(t *testing.T) {
	s := itStore(t)
	ctx := context.Background()
	tenant := int64(990000001)
	defer func() { _ = s.deletePrefix(ctx, fmt.Sprintf("t/%d/", tenant)) }()

	body := bytes.Repeat([]byte("baobao-integration-"), 64<<10) // 1.25MB
	n, sha, tmpKey, err := s.Save(ctx, tenant, bytes.NewReader(body), 10<<20)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if n != int64(len(body)) {
		t.Fatalf("size=%d want %d", n, len(body))
	}
	sum := sha256.Sum256(body)
	if sha != hex.EncodeToString(sum[:]) {
		t.Fatalf("sha 不匹配")
	}
	if err := s.Promote(ctx, tenant, sha, tmpKey); err != nil {
		t.Fatalf("Promote: %v", err)
	}
	got, err := s.Open(ctx, tenant, sha)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !bytes.Equal(mustReadAll(t, got), body) {
		t.Fatalf("内容不一致")
	}
	_ = got.Close()

	head, full, err := s.Head(ctx, tenant, sha, 16)
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	if !bytes.Equal(head, body[:16]) {
		t.Fatalf("Head 前 16 字节不一致")
	}
	if !bytes.Equal(mustReadAll(t, full), body) {
		t.Fatalf("Head 全量不一致")
	}
	_ = full.Close()

	// 幂等：同 sha 再 Promote（临时键已删，路径走既有对象复用——用新 tmpKey 模拟）
	_, sha2, tmp2, err := s.Save(ctx, tenant, bytes.NewReader(body), 10<<20)
	if err != nil || sha2 != sha {
		t.Fatalf("二次 Save: sha=%v err=%v", sha2, err)
	}
	if err := s.Promote(ctx, tenant, sha, tmp2); err != nil {
		t.Fatalf("二次 Promote（幂等）: %v", err)
	}
}

// TestS3IntegrationCopyTo staging 合并体落位 + 幂等
func TestS3IntegrationCopyTo(t *testing.T) {
	s := itStore(t)
	ctx := context.Background()
	rnd := itRand()
	src := "s2/it-" + rnd + "/merged"
	dst := "t/990000002/it/" + rnd
	defer func() {
		_ = s.DeleteKey(ctx, src)
		_ = s.DeleteKey(ctx, dst)
	}()

	body := bytes.Repeat([]byte("copy-src-"), 128<<10)
	if err := s.PutBytes(ctx, src, "application/octet-stream", body); err != nil {
		t.Fatalf("PutBytes(src): %v", err)
	}
	if err := s.CopyTo(ctx, src, dst, int64(len(body))); err != nil {
		t.Fatalf("CopyTo: %v", err)
	}
	if err := s.CopyTo(ctx, src, dst, int64(len(body))); err != nil { // 幂等（目标已存在）
		t.Fatalf("CopyTo 幂等: %v", err)
	}
	got, err := s.OpenKey(ctx, dst)
	if err != nil {
		t.Fatalf("OpenKey(dst): %v", err)
	}
	if !bytes.Equal(mustReadAll(t, got), body) {
		t.Fatalf("拷贝内容不一致")
	}
	_ = got.Close()
}

// TestS3IntegrationStaging relay 分片兼容路径：SaveStaging/ListStaging/OpenStaging/RemoveStaging
func TestS3IntegrationStaging(t *testing.T) {
	s := itStore(t)
	ctx := context.Background()
	uploadID := "it-" + itRand()
	part2 := bytes.Repeat([]byte{0xA5}, 33<<10)
	part7 := bytes.Repeat([]byte{0x5A}, 17<<10)
	if err := s.SaveStaging(ctx, uploadID, 7, bytes.NewReader(part7), 1<<20); err != nil {
		t.Fatalf("SaveStaging 7: %v", err)
	}
	if err := s.SaveStaging(ctx, uploadID, 2, bytes.NewReader(part2), 1<<20); err != nil {
		t.Fatalf("SaveStaging 2: %v", err)
	}
	got, err := s.ListStaging(ctx, uploadID)
	if err != nil {
		t.Fatalf("ListStaging: %v", err)
	}
	if len(got) != 2 || got[0] != 2 || got[1] != 7 {
		t.Fatalf("位图=%v want [2 7]", got)
	}
	rc, err := s.OpenStaging(ctx, uploadID, 7)
	if err != nil {
		t.Fatalf("OpenStaging: %v", err)
	}
	if !bytes.Equal(mustReadAll(t, rc), part7) {
		t.Fatalf("分片 7 内容不一致")
	}
	_ = rc.Close()
	if err := s.RemoveStaging(ctx, uploadID); err != nil {
		t.Fatalf("RemoveStaging: %v", err)
	}
	if got, _ := s.ListStaging(ctx, uploadID); len(got) != 0 {
		t.Fatalf("清理后位图=%v want 空", got)
	}
}

// TestS3IntegrationMultipartPresign presign 模式真链：Create→预签名 PUT（UNSIGNED-PAYLOAD
// 验签）→ListParts 位图→Complete 收口→合并体可读；Abort 会话作废
func TestS3IntegrationMultipartPresign(t *testing.T) {
	s := itStore(t)
	ctx := context.Background()
	uploadID := "it-" + itRand()
	hc := &http.Client{Timeout: 30 * time.Second}
	defer func() { _ = s.deletePrefix(ctx, "s/") }()

	s3UpID, err := s.CreateMultipart(ctx, uploadID)
	if err != nil {
		t.Fatalf("CreateMultipart: %v", err)
	}
	// S3 语义：非末片 ≥5MiB——片1 6MB/片2 1MB
	part1 := bytes.Repeat([]byte{0x11}, 6<<20)
	part2 := bytes.Repeat([]byte{0x22}, 1<<20)
	for no, data := range map[int][]byte{1: part1, 2: part2} {
		u, err := s.PresignPart(ctx, uploadID, s3UpID, no, 10*time.Minute)
		if err != nil {
			t.Fatalf("PresignPart %d: %v", no, err)
		}
		req, err := http.NewRequest(http.MethodPut, u, bytes.NewReader(data))
		if err != nil {
			t.Fatalf("构建 PUT: %v", err)
		}
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatalf("预签名 PUT %d（UNSIGNED-PAYLOAD 验签）: %v", no, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("预签名 PUT %d 状态=%d（RustFS 拒签或验签失败）", no, resp.StatusCode)
		}
	}
	bm, err := s.ListPartNumbers(ctx, uploadID, s3UpID)
	if err != nil {
		t.Fatalf("ListPartNumbers: %v", err)
	}
	if len(bm) != 2 || bm[0] != 1 || bm[1] != 2 {
		t.Fatalf("位图=%v want [1 2]", bm)
	}
	if _, err := s.CompleteMultipart(ctx, uploadID, s3UpID); err != nil {
		t.Fatalf("CompleteMultipart: %v", err)
	}
	merged, err := s.OpenKey(ctx, MpKey(uploadID))
	if err != nil {
		t.Fatalf("OpenKey(合并体): %v", err)
	}
	got := mustReadAll(t, merged)
	_ = merged.Close()
	if !bytes.Equal(got, append(append([]byte{}, part1...), part2...)) {
		t.Fatalf("合并体内容不一致（len=%d）", len(got))
	}
	if bm, _ := s.ListPartNumbers(ctx, uploadID, s3UpID); bm != nil { // complete 后会话消失
		t.Fatalf("complete 后位图=%v want nil", bm)
	}

	// Abort 路径：新会话建即作废
	abortID := "it-" + itRand()
	s3UpID2, err := s.CreateMultipart(ctx, abortID)
	if err != nil {
		t.Fatalf("CreateMultipart(abort): %v", err)
	}
	if err := s.AbortMultipart(ctx, abortID, s3UpID2); err != nil {
		t.Fatalf("AbortMultipart: %v", err)
	}
	if bm, _ := s.ListPartNumbers(ctx, abortID, s3UpID2); bm != nil {
		t.Fatalf("abort 后位图=%v want nil", bm)
	}
}

// TestS3IntegrationPresignGet 下载票据真链：GET 预签名取回内容；变体带 Content-Type
func TestS3IntegrationPresignGet(t *testing.T) {
	s := itStore(t)
	ctx := context.Background()
	tenant := int64(990000003)
	defer func() { _ = s.deletePrefix(ctx, fmt.Sprintf("t/%d/", tenant)) }()
	hc := &http.Client{Timeout: 30 * time.Second}

	body := []byte("presign-get-body-" + itRand())
	sha := hex.EncodeToString(func() []byte { h := sha256.Sum256(body); return h[:] }())
	if err := s.PutBytes(ctx, BlobKey(tenant, sha), "application/octet-stream", body); err != nil {
		t.Fatalf("PutBytes: %v", err)
	}
	u, err := s.PresignGet(ctx, BlobKey(tenant, sha), 2*time.Minute)
	if err != nil {
		t.Fatalf("PresignGet: %v", err)
	}
	resp, err := hc.Get(u)
	if err != nil {
		t.Fatalf("预签名 GET: %v", err)
	}
	gotBody := mustReadAll(t, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET 状态=%d", resp.StatusCode)
	}
	if !bytes.Equal(gotBody, body) {
		t.Fatalf("取回内容不一致")
	}

	// 变体：Content-Type 随对象元数据返回（缩略图直显依赖）
	if err := s.PutVariant(ctx, tenant, sha, "240", "image/jpeg", []byte("fake-jpg-bytes")); err != nil {
		t.Fatalf("PutVariant: %v", err)
	}
	if !s.HasVariant(ctx, tenant, sha, "240") {
		t.Fatalf("HasVariant=false")
	}
	vu, err := s.PresignGet(ctx, VariantKey(tenant, sha, "240"), 2*time.Minute)
	if err != nil {
		t.Fatalf("PresignGet(variant): %v", err)
	}
	vresp, err := hc.Get(vu)
	if err != nil {
		t.Fatalf("变体 GET: %v", err)
	}
	vb := mustReadAll(t, vresp.Body)
	_ = vresp.Body.Close()
	if vresp.StatusCode != http.StatusOK || !bytes.Equal(vb, []byte("fake-jpg-bytes")) {
		t.Fatalf("变体取回异常 status=%d", vresp.StatusCode)
	}
	if ct := vresp.Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("变体 Content-Type=%q want image/jpeg", ct)
	}

	// DeleteKey + 缺失语义
	if err := s.DeleteKey(ctx, VariantKey(tenant, sha, "240")); err != nil {
		t.Fatalf("DeleteKey: %v", err)
	}
	if ok, _ := s.StatExists(ctx, VariantKey(tenant, sha, "240")); ok {
		t.Fatalf("删除后仍存在")
	}
	if _, err := s.OpenVariant(ctx, tenant, sha, "240"); err != ErrNotFound {
		t.Fatalf("OpenVariant 缺失 err=%v want ErrNotFound", err)
	}
}
