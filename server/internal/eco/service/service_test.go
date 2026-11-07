// eco 专家分发全链测试（D14 §5 阶段一）：发布校验/个人命名空间/覆盖
// 权限/清单瘦身/下架下载拒/公司库通道。
package ecoservice

import (
	"context"
	"strings"
	"testing"

	ecorepo "github.com/baobaowork/server/internal/eco/repo"
)

const manifestTpl = `id: %s
type: local
version: 1.1.0
display: 评审专家
persona: |
  逐文件审查 diff，输出三段结构。
source: personal
`

func newSvc() *Service { return New(ecorepo.NewMemory()) }

// 发布→清单瘦身→下载原文
func TestPublishListDownload(t *testing.T) {
	svc := newSvc()
	ctx := context.Background()
	e, err := svc.Publish(ctx, 1, 10001, PublishReq{
		Manifest: strings.Replace(manifestTpl, "%s", "usr.10001.reviewer", 1)})
	if err != nil {
		t.Fatal(err)
	}
	if e.Source != ecorepo.SourcePersonal || e.OwnerUserID != 10001 || e.Version != "1.1.0" {
		t.Fatalf("落库元数据：%+v", e)
	}
	// 清单：published、manifest 瘦身、summary=persona 首行
	list, _ := svc.List(ctx, 1, 10001, "mine")
	if len(list) != 1 || list[0].Manifest != "" || !strings.Contains(list[0].Summary, "逐文件") {
		t.Fatalf("清单：%+v", list)
	}
	// 公开清单（scope=all 也可见）
	pub, _ := svc.List(ctx, 1, 0, "all")
	if len(pub) != 1 {
		t.Fatal("公开清单应含")
	}
	// 下载原文
	full, err := svc.Download(ctx, 1, e.ID)
	if err != nil || !strings.Contains(full.Manifest, "usr.10001.reviewer") {
		t.Fatalf("下载：%v", err)
	}
}

// 个人命名空间强制：他人前缀/公司前缀（非公司库通道）拒绝
func TestPersonalNamespaceGuard(t *testing.T) {
	svc := newSvc()
	ctx := context.Background()
	if _, err := svc.Publish(ctx, 1, 10001, PublishReq{
		Manifest: strings.Replace(manifestTpl, "%s", "usr.999.hijack", 1)}); err == nil {
		t.Fatal("冒充他人命名空间应拒")
	}
	if _, err := svc.Publish(ctx, 1, 10001, PublishReq{
		Manifest: strings.Replace(manifestTpl, "%s", "corp.free", 1)}); err == nil {
		t.Fatal("个人通道发公司前缀应拒")
	}
	// 公司库通道（AsCompany）可发 corp. 前缀
	e, err := svc.Publish(ctx, 1, 9, PublishReq{
		Manifest: strings.Replace(manifestTpl, "%s", "corp.reviewer", 1), AsCompany: true})
	if err != nil || e.Source != ecorepo.SourceCompany {
		t.Fatalf("公司库发布：%v", err)
	}
}

// 基础键校验：缺 display/坏前缀/超限
func TestBasicValidation(t *testing.T) {
	svc := newSvc()
	ctx := context.Background()
	bad := []string{
		"id: usr.10001.x\ntype: local\n",                         // 缺 display/persona
		"id: free.x\ntype: local\ndisplay: D\npersona: |\n  p\n", // 坏前缀
		strings.Repeat("id: usr.10001.x\n", 9000),                // >64KB
	}
	for i, m := range bad {
		if _, err := svc.Publish(ctx, 1, 10001, PublishReq{Manifest: m}); err == nil {
			t.Fatalf("坏 manifest #%d 应拒", i)
		}
	}
}

// 覆盖：本人更新版本；他人更新个人库拒；下架后下载拒；删除
func TestUpdateUnpublishDelete(t *testing.T) {
	svc := newSvc()
	ctx := context.Background()
	e, _ := svc.Publish(ctx, 1, 10001, PublishReq{
		Manifest: strings.Replace(manifestTpl, "%s", "usr.10001.helper", 1)})
	// 他人覆盖拒
	if _, err := svc.Publish(ctx, 1, 10002, PublishReq{
		Manifest: strings.Replace(manifestTpl, "%s", "usr.10001.helper", 1)}); err == nil {
		t.Fatal("他人覆盖应拒")
	}
	// 本人覆盖（版本更新）
	v2 := strings.Replace(strings.Replace(manifestTpl, "%s", "usr.10001.helper", 1), "1.1.0", "1.2.0", 1)
	upd, err := svc.Publish(ctx, 1, 10001, PublishReq{Manifest: v2})
	if err != nil || upd.Version != "1.2.0" {
		t.Fatalf("覆盖更新：%v %+v", err, upd)
	}
	// 他人下架/删除拒
	if err := svc.Unpublish(ctx, 1, 10002, e.ID); err == nil {
		t.Fatal("他人下架应拒")
	}
	if err := svc.Delete(ctx, 1, 10002, e.ID); err == nil {
		t.Fatal("他人删除应拒")
	}
	// 下架 → 清单/下载不可见
	if err := svc.Unpublish(ctx, 1, 10001, e.ID); err != nil {
		t.Fatal(err)
	}
	if l, _ := svc.List(ctx, 1, 10001, "mine"); len(l) != 0 {
		t.Fatal("下架后清单应空")
	}
	if _, err := svc.Download(ctx, 1, e.ID); err == nil {
		t.Fatal("下架后下载应拒")
	}
	// 删除
	if err := svc.Delete(ctx, 1, 10001, e.ID); err != nil {
		t.Fatal(err)
	}
}
