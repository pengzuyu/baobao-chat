// fileservice 单元测试（内存仓 + 本地磁盘存储于 t.TempDir）。
// 覆盖：上传元数据/宽高解析、扩展名黑名单、超限、sha 去重复用、票据一次性（4014）、
// 成员可下载（IsConvMember 注入）、软删（4013）、我的文件、Send 校验路径（CheckSendable/MarkSent）。
package fileservice

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"

	fileapi "github.com/baobaowork/server/internal/file/api"
	filerepo "github.com/baobaowork/server/internal/file/repo"
	filestore "github.com/baobaowork/server/internal/file/store"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// pngBytes 生成 w×h 的 PNG 测试图
func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 0x88, A: 0xff})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png encode: %v", err)
	}
	return buf.Bytes()
}

// nowSeq 可拨时钟（票据过期路径可测）
type nowSeq struct{ t time.Time }

func (n *nowSeq) now() time.Time          { return n.t }
func (n *nowSeq) advance(d time.Duration) { n.t = n.t.Add(d) }

// newSvc 测试装配：内存仓 + 临时目录磁盘 + 可注入成员表
func newSvc(t *testing.T, mut func(*Options)) (*Service, *nowSeq, string) {
	t.Helper()
	clock := &nowSeq{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	dir := t.TempDir()
	opts := Options{
		DataDir:        dir,
		MaxUploadBytes: 1 << 20, // 1MB（超限路径用小上限）
		TicketTTL:      120 * time.Second,
		Now:            clock.now,
		IsConvMember: func(ctx context.Context, uid, convID int64) bool {
			return convID == 1 && uid == 10002 // bob 是会话 1 成员
		},
	}
	if mut != nil {
		mut(&opts)
	}
	svc := New(opts, filerepo.NewMemory(), filerepo.NewMemoryTransfers(), filestore.NewLocal(dir))
	return svc, clock, dir
}

func codeOf(t *testing.T, err error) errx.Code {
	t.Helper()
	if err == nil {
		t.Fatal("期望非 nil 错误")
	}
	e := errx.From(err)
	return e.Code
}

// mustI64 数字字符串转 int64（测试内 id 口径）
func mustI64(t *testing.T, s string) int64 {
	t.Helper()
	var n int64
	for _, c := range s {
		n = n*10 + int64(c-'0')
	}
	if n <= 0 {
		t.Fatalf("非法 id: %q", s)
	}
	return n
}

// ticketToken 从票据 URL 提取 token
func ticketToken(t *testing.T, url string) string {
	t.Helper()
	const prefix = "/api/v1/files/dl?t="
	if !strings.HasPrefix(url, prefix) {
		t.Fatalf("票据 URL 前缀不符: %q", url)
	}
	return strings.TrimPrefix(url, prefix)
}

// 上传元数据 + 图片宽高解析（image.DecodeConfig 仅头部解析）
func TestUploadMetadataAndImageDims(t *testing.T) {
	svc, _, _ := newSvc(t, nil)
	ctx := context.Background()

	res, err := svc.Upload(ctx, 1, 10001, "头像.PNG", "image/png", 0, bytes.NewReader(pngBytes(t, 7, 5)))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if res.ID == "" || res.Dedup {
		t.Fatalf("首传应有新 id 且非去重: %+v", res)
	}
	if res.Ext != "png" {
		t.Fatalf("扩展名应小写规范化: %q", res.Ext)
	}
	if res.Width != 7 || res.Height != 5 {
		t.Fatalf("宽高解析不符: %d×%d", res.Width, res.Height)
	}
	if res.ContentType != "image/png" {
		t.Fatalf("content type: %q", res.ContentType)
	}

	// 非图片：宽高恒 0；octet-stream 缺省经嗅探兜底
	res2, err := svc.Upload(ctx, 1, 10001, "笔记.txt", "", 0, strings.NewReader("hello 宝宝"))
	if err != nil {
		t.Fatalf("upload txt: %v", err)
	}
	if res2.Width != 0 || res2.Height != 0 {
		t.Fatalf("非图片宽高应 0: %+v", res2)
	}
	if !strings.HasPrefix(res2.ContentType, "text/plain") {
		t.Fatalf("嗅探兜底应为 text/plain: %q", res2.ContentType)
	}
}

// 扩展名黑名单：.exe/.sh → 4002
func TestUploadBlacklist(t *testing.T) {
	svc, _, _ := newSvc(t, nil)
	ctx := context.Background()
	for _, name := range []string{"危险.exe", "run.SH", "deploy.sh"} {
		_, err := svc.Upload(ctx, 1, 10001, name, "application/octet-stream", 0, strings.NewReader("x"))
		if code := codeOf(t, err); code != errx.CodeFileTypeForbidden {
			t.Fatalf("%s 应拒 4002, got %d", name, code)
		}
	}
}

// 超单文件上限 → 4009
func TestUploadTooLarge(t *testing.T) {
	svc, _, _ := newSvc(t, nil)
	ctx := context.Background()
	big := bytes.Repeat([]byte("a"), (1<<20)+1) // 上限 1MB
	_, err := svc.Upload(ctx, 1, 10001, "big.bin", "application/octet-stream", 0, bytes.NewReader(big))
	if code := codeOf(t, err); code != errx.CodeFileSizeLimit {
		t.Fatalf("超限应拒 4009, got %d", code)
	}
}

// sha 去重复用：同租户同内容复用原行返回原 id（name 为首传者口径，登记）
func TestUploadDedupReuse(t *testing.T) {
	svc, _, _ := newSvc(t, nil)
	ctx := context.Background()
	img := pngBytes(t, 4, 4)

	r1, err := svc.Upload(ctx, 1, 10001, "首传.png", "image/png", 0, bytes.NewReader(img))
	if err != nil {
		t.Fatalf("首传: %v", err)
	}
	r2, err := svc.Upload(ctx, 1, 10002, "重传.png", "image/png", 0, bytes.NewReader(img))
	if err != nil {
		t.Fatalf("重传: %v", err)
	}
	if r1.ID != r2.ID {
		t.Fatalf("同 sha 应复用原 id: %s vs %s", r1.ID, r2.ID)
	}
	if !r2.Dedup || r2.Name != "首传.png" {
		t.Fatalf("去重命中应 dedup=true 且返回原行元数据: %+v", r2)
	}
	// 跨租户绝不去重（07 篇隔离红线）
	r3, err := svc.Upload(ctx, 2, 10001, "跨租户.png", "image/png", 0, bytes.NewReader(img))
	if err != nil {
		t.Fatalf("跨租户上传: %v", err)
	}
	if r3.ID == r1.ID || r3.Dedup {
		t.Fatalf("跨租户不应去重: %+v", r3)
	}
	// 软删后重传：不复用软删行（新 id）
	if err := svc.SoftDelete(ctx, 1, 10001, mustI64(t, r1.ID)); err != nil {
		t.Fatalf("软删: %v", err)
	}
	r4, err := svc.Upload(ctx, 1, 10001, "复活.png", "image/png", 0, bytes.NewReader(img))
	if err != nil {
		t.Fatalf("软删后重传: %v", err)
	}
	if r4.ID == r1.ID || r4.Dedup {
		t.Fatalf("软删行不应参与去重: %+v", r4)
	}
}

// 票据：owner/会话成员可取；一次性（二次消费 4014）；过期 4014
func TestTicketOneTimeAndPermissions(t *testing.T) {
	svc, clock, _ := newSvc(t, nil)
	ctx := context.Background()
	// conv_id=1 随上传携带 → 会话成员 bob 具备资源级访问权（03 篇三层模型）
	res, err := svc.Upload(ctx, 1, 10001, "共享.png", "image/png", 1, bytes.NewReader(pngBytes(t, 3, 3)))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	fid := mustI64(t, res.ID)

	// 非成员非 owner → 2003
	if _, err := svc.IssueTicket(ctx, 1, 99999, fid); codeOf(t, err) != errx.CodePermACLDenied {
		t.Fatalf("无关用户应拒 2003, got %v", err)
	}
	// 会话成员（bob∈conv1）可取票据并下载
	tk, err := svc.IssueTicket(ctx, 1, 10002, fid)
	if err != nil {
		t.Fatalf("成员取票据: %v", err)
	}
	if tk.ExpiresIn != 120 {
		t.Fatalf("票据 TTL 应 120s: %+v", tk)
	}
	target, rc, err := svc.Download(ctx, ticketToken(t, tk.URL))
	if err != nil {
		t.Fatalf("首次下载: %v", err)
	}
	n, _ := io.Copy(io.Discard, rc)
	rc.Close()
	if target.Name != "共享.png" || n == 0 {
		t.Fatalf("下载目标不符: %+v bytes=%d", target, n)
	}
	// 一次性：二次消费 4014
	if _, _, err := svc.Download(ctx, ticketToken(t, tk.URL)); codeOf(t, err) != errx.CodeFileTicketInvalid {
		t.Fatalf("票据复用应拒 4014, got %v", err)
	}
	// 过期：拨时钟越 TTL → 4014
	tk2, err := svc.IssueTicket(ctx, 1, 10001, fid)
	if err != nil {
		t.Fatalf("owner 取票据: %v", err)
	}
	clock.advance(121 * time.Second)
	if _, _, err := svc.Download(ctx, ticketToken(t, tk2.URL)); codeOf(t, err) != errx.CodeFileTicketInvalid {
		t.Fatalf("票据过期应拒 4014, got %v", err)
	}
}

// 软删：票据 4013；我的文件排除；重复软删幂等
func TestSoftDeleteAndListMine(t *testing.T) {
	svc, _, _ := newSvc(t, nil)
	ctx := context.Background()
	r1, err := svc.Upload(ctx, 1, 10001, "a.png", "image/png", 0, bytes.NewReader(pngBytes(t, 2, 2)))
	if err != nil {
		t.Fatal(err)
	}
	r2, err := svc.Upload(ctx, 1, 10001, "b.txt", "text/plain", 0, strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	if r2.Ext != "txt" || r2.Size != 1 {
		t.Fatalf("txt 元数据不符: %+v", r2)
	}
	r3, err := svc.Upload(ctx, 1, 10002, "别人的.txt", "text/plain", 0, strings.NewReader("y"))
	if err != nil {
		t.Fatal(err)
	}

	// 我的文件：仅本人 + 未软删，时间倒序（r2 后传在前）
	items, err := svc.ListMine(ctx, 1, 10001)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Name != "b.txt" || items[1].Name != "a.png" {
		t.Fatalf("ListMine 不符: %+v", items)
	}
	// 非 owner 删 → 2003
	if err := svc.SoftDelete(ctx, 1, 10002, mustI64(t, r1.ID)); codeOf(t, err) != errx.CodePermACLDenied {
		t.Fatalf("非 owner 删除应拒 2003, got %v", err)
	}
	// owner 软删后：票据 4013、ListMine 排除
	if err := svc.SoftDelete(ctx, 1, 10001, mustI64(t, r1.ID)); err != nil {
		t.Fatal(err)
	}
	if err := svc.SoftDelete(ctx, 1, 10001, mustI64(t, r1.ID)); err != nil {
		t.Fatalf("重复软删应幂等: %v", err)
	}
	if _, err := svc.IssueTicket(ctx, 1, 10001, mustI64(t, r1.ID)); codeOf(t, err) != errx.CodeFileDeleted {
		t.Fatalf("软删后取票据应拒 4013, got %v", err)
	}
	items, _ = svc.ListMine(ctx, 1, 10001)
	if len(items) != 1 || items[0].Name != "b.txt" {
		t.Fatalf("软删后 ListMine 不符: %+v", items)
	}
	// 他人视角不受影响
	if _, err := svc.ListMine(ctx, 1, 10002); err != nil {
		t.Fatal(err)
	}
	_ = r3
}

// Send 校验路径：存在(4005)/未删(4013)/owner 或 source=message(2003)；MarkSent 回填
func TestCheckSendableAndMarkSent(t *testing.T) {
	svc, _, _ := newSvc(t, nil)
	ctx := context.Background()
	res, err := svc.Upload(ctx, 1, 10001, "mine.txt", "text/plain", 0, strings.NewReader("z"))
	if err != nil {
		t.Fatal(err)
	}
	fid := mustI64(t, res.ID)

	if err := svc.CheckSendable(ctx, 10001, fid); err != nil {
		t.Fatalf("owner 应可发送: %v", err)
	}
	// 非 owner 且 source=upload → 2003
	if err := svc.CheckSendable(ctx, 10002, fid); codeOf(t, err) != errx.CodePermACLDenied {
		t.Fatalf("非 owner 未随消息发送应拒 2003, got %v", err)
	}
	// 不存在 → 4005
	if err := svc.CheckSendable(ctx, 10001, 999999); codeOf(t, err) != errx.CodeFileNotFound {
		t.Fatalf("不存在应拒 4005, got %v", err)
	}
	// MarkSent 后 source=message：非 owner 亦可发（转发复用路径）
	if err := svc.MarkSent(ctx, fid, 1, 5); err != nil {
		t.Fatalf("MarkSent: %v", err)
	}
	if err := svc.CheckSendable(ctx, 10002, fid); err != nil {
		t.Fatalf("source=message 应允许转发复用: %v", err)
	}
	// 软删后 → 4013
	if err := svc.SoftDelete(ctx, 1, 10001, fid); err != nil {
		t.Fatal(err)
	}
	if err := svc.CheckSendable(ctx, 10001, fid); codeOf(t, err) != errx.CodeFileDeleted {
		t.Fatalf("软删后发送应拒 4013, got %v", err)
	}
	// 会话聚合（群文件页签预留路径）
	r2, err := svc.Upload(ctx, 1, 10001, "c.txt", "text/plain", 0, strings.NewReader("c"))
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.MarkSent(ctx, mustI64(t, r2.ID), 7, 42); err != nil {
		t.Fatal(err)
	}
	items, err := svc.repo.ListByConv(ctx, 1, 7)
	if err != nil || len(items) != 1 {
		t.Fatalf("ListByConv 不符: %v %+v", err, items)
	}
	if items[0].MsgSeq != 42 || items[0].Recalled {
		t.Fatalf("锚点回填不符: %+v", items[0])
	}
}

// TestMsgRecalledAnchor OQ-B24：锚点消息撤回——文件保留、recalled 置灰、下载不受限
func TestMsgRecalledAnchor(t *testing.T) {
	svc, _, _ := newSvc(t, nil)
	ctx := context.Background()
	res, err := svc.Upload(ctx, 1, 10001, "r.txt", "text/plain", 0, strings.NewReader("r"))
	if err != nil {
		t.Fatal(err)
	}
	fid := mustI64(t, res.ID)
	if err := svc.MarkSent(ctx, fid, 3, 11); err != nil {
		t.Fatal(err)
	}
	// 撤回联动（main 订阅 msg.recalled → OnMsgRecalled）
	if err := svc.OnMsgRecalled(ctx, 3, 11); err != nil {
		t.Fatalf("OnMsgRecalled: %v", err)
	}
	items, err := svc.repo.ListByConv(ctx, 1, 3)
	if err != nil || len(items) != 1 {
		t.Fatalf("撤回后文件应保留: %v %+v", err, items)
	}
	if !items[0].Recalled || items[0].MsgSeq != 11 {
		t.Fatalf("recalled 标记不符: %+v", items[0])
	}
	// 无匹配 (conv,seq) 幂等 no-op
	if err := svc.OnMsgRecalled(ctx, 3, 999); err != nil {
		t.Fatalf("无匹配应 no-op: %v", err)
	}
}

// 编译期断言接口实现
var _ fileapi.FileService = (*Service)(nil)
