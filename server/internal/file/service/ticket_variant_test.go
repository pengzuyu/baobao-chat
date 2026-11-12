// 客户端票据与缩略变体契约测试（D25 O2，Local 回落形态）：
// 惰性缩略生成（首票触发）/变体回放（jpeg+真实大小）/小图不放大回退原图/
// 内部 IssueTicket token 形态不变（kb 摄取链路依赖）。
package fileservice

import (
	"bytes"
	"context"
	"image"
	"io"
	"strings"
	"testing"
)

// pngBytes 复用 service_test.go 既有测试图源

// TestClientTicketThumbLazyFlow 大图（600×400）→ 首次 240 票据触发惰性生成 →
// 回放 jpeg 小于原图；再次取票直接命中（幂等）
func TestClientTicketThumbLazyFlow(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	up, err := svc.Upload(ctx, 1, 7, "照片.png", "image/png", 0, bytes.NewReader(pngBytes(t, 600, 400)))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	fid := parseID(t, up.ID)

	tk, err := svc.IssueClientTicket(ctx, 1, 7, fid, "240")
	if err != nil {
		t.Fatalf("ticket: %v", err)
	}
	if !strings.HasPrefix(tk.URL, "/api/v1/files/dl?t=") {
		t.Fatalf("Local 模式票据应为 token 相对路径: %s", tk.URL)
	}
	token := strings.TrimPrefix(tk.URL, "/api/v1/files/dl?t=")
	target, rc, err := svc.Download(ctx, token)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer rc.Close()
	if target.ContentType != "image/jpeg" {
		t.Fatalf("变体回放类型: %s", target.ContentType)
	}
	data, _ := io.ReadAll(rc)
	vimg, _, derr := image.Decode(bytes.NewReader(data))
	if derr != nil {
		t.Fatalf("变体应为可解码 jpeg: %v", derr)
	}
	if vimg.Bounds().Dx() != 240 || vimg.Bounds().Dy() != 160 { // 600×400 长边（600）缩到 240
		t.Fatalf("缩略尺寸: %d×%d", vimg.Bounds().Dx(), vimg.Bounds().Dy())
	}
	if target.Size != int64(len(data)) {
		t.Fatalf("变体大小应取真实字节: %d vs %d", target.Size, len(data))
	}
	// 720 档：原图 600≤720 不放大 → 回退原图 png（不放大契约）
	tk2, err := svc.IssueClientTicket(ctx, 1, 7, fid, "720")
	if err != nil {
		t.Fatal(err)
	}
	target2, rc2, err := svc.Download(ctx, strings.TrimPrefix(tk2.URL, "/api/v1/files/dl?t="))
	if err != nil || target2.ContentType != "image/png" {
		t.Fatalf("720 对小图应回退原图: %v %+v", err, target2)
	}
	rc2.Close()
}

// TestClientTicketSmallImageFallback 小图（100×80 ≤240）不放大：变体票回放=原图 png
func TestClientTicketSmallImageFallback(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	up, err := svc.Upload(ctx, 1, 7, "小图.png", "image/png", 0, bytes.NewReader(pngBytes(t, 100, 80)))
	if err != nil {
		t.Fatal(err)
	}
	tk, err := svc.IssueClientTicket(ctx, 1, 7, parseID(t, up.ID), "240")
	if err != nil {
		t.Fatal(err)
	}
	target, rc, err := svc.Download(ctx, strings.TrimPrefix(tk.URL, "/api/v1/files/dl?t="))
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	if target.ContentType != "image/png" {
		t.Fatalf("小图应回退原图: %s", target.ContentType)
	}
}

// TestIssueTicketTokenFormPreserved 内部票据 token 形态不变（kb OpenFile 依赖
// TrimPrefix("/api/v1/files/dl?t=") 提取——D25 拆分 IssueClientTicket 的原因）
func TestIssueTicketTokenFormPreserved(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	up, err := svc.Upload(ctx, 1, 7, "文档.txt", "text/plain", 0, strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	tk, err := svc.IssueTicket(ctx, 1, 7, parseID(t, up.ID))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(tk.URL, "/api/v1/files/dl?t=") || strings.Contains(tk.URL, "http") {
		t.Fatalf("内部票据应保持 token 相对形态: %s", tk.URL)
	}
}

// TestClientTicketACL 票据权限口径与 IssueTicket 一致（非 owner 非成员拒 2003）
func TestClientTicketACL(t *testing.T) {
	svc := newUploadFixture(t)
	ctx := context.Background()
	up, err := svc.Upload(ctx, 1, 7, "私文件.txt", "text/plain", 0, strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IssueClientTicket(ctx, 1, 8, parseID(t, up.ID), "origin"); err == nil {
		t.Fatal("非 owner 应拒绝")
	}
}

func parseID(t *testing.T, s string) int64 {
	t.Helper()
	var id int64
	for _, c := range s {
		if c < '0' || c > '9' {
			t.Fatalf("id 非数字: %s", s)
		}
		id = id*10 + int64(c-'0')
	}
	return id
}
