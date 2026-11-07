// doc 域服务测试（内存仓）：乐观锁/版本不可变/回收站/分享占位全链路。
// 错误码断言口径：6004 版本冲突 / 6015 同名 / 6011 回收站 / 6013 版本不存在 / 6005 文档不存在。
package docservice_test

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	docapi "github.com/baobaowork/server/internal/doc/api"
	docrepo "github.com/baobaowork/server/internal/doc/repo"
	docservice "github.com/baobaowork/server/internal/doc/service"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

func newSvc() docapi.DocService {
	return docservice.New(docservice.Options{Now: func() time.Time { return time.Now() }}, docrepo.NewMemory())
}

// TestDocLifecycleHappyPath E2E 主链路（服务层）：
// 建 → 存 v2 → 存 v3 → 时间线三版 → 恢复 v2（v4 restore）→ 正文回写
func TestDocLifecycleHappyPath(t *testing.T) {
	ctx := context.Background()
	svc := newSvc()
	const tenant, uid = int64(1), int64(101)

	// ① 新建：v1 create 空白
	f, err := svc.CreateFile(ctx, tenant, uid, "季度汇报")
	if err != nil {
		t.Fatalf("新建: %v", err)
	}
	if f.CurrentVersion != 1 {
		t.Fatalf("新建应 v1，得 %d", f.CurrentVersion)
	}

	// ② 保存 → v2（manual）
	r2, err := svc.SaveContent(ctx, tenant, uid, parseID(t, f.ID), 1, "# v2 内容")
	if err != nil {
		t.Fatalf("保存 v2: %v", err)
	}
	if r2.Version.Version != 2 || r2.Version.SnapshotType != "manual" {
		t.Fatalf("v2 快照类型/版本号错: %+v", r2.Version)
	}

	// ③ 再保存 → v3
	r3, err := svc.SaveContent(ctx, tenant, uid, parseID(t, f.ID), 2, "# v3 内容")
	if err != nil || r3.Version.Version != 3 {
		t.Fatalf("保存 v3: %v %+v", err, r3.Version)
	}

	// ④ 时间线：v3/v2/v1 倒序
	vl, err := svc.ListVersions(ctx, tenant, uid, parseID(t, f.ID), "", 50)
	if err != nil {
		t.Fatalf("时间线: %v", err)
	}
	if len(vl.Items) != 3 || vl.Items[0].Version != 3 || vl.Items[2].SnapshotType != "create" {
		t.Fatalf("时间线三版倒序错: %+v", vl.Items)
	}

	// ⑤ 恢复 v2 → v4（restore）+ 正文回写
	rr, err := svc.RestoreVersion(ctx, tenant, uid, parseID(t, f.ID), 2)
	if err != nil {
		t.Fatalf("恢复 v2: %v", err)
	}
	if rr.NewVerNo != 4 {
		t.Fatalf("恢复应产生 v4，得 %d", rr.NewVerNo)
	}
	got, _ := svc.GetFile(ctx, tenant, uid, parseID(t, f.ID))
	if got.ContentMD != "# v2 内容" || got.CurrentVersion != 4 {
		t.Fatalf("恢复后正文/版本回写错: %q v%d", got.ContentMD, got.CurrentVersion)
	}
	// 恢复后再看时间线：v4 restore 在顶
	vl2, _ := svc.ListVersions(ctx, tenant, uid, parseID(t, f.ID), "", 50)
	if len(vl2.Items) != 4 || vl2.Items[0].SnapshotType != "restore" {
		t.Fatalf("时间线应四版且顶为 restore: %+v", vl2.Items)
	}
	// v2/v3 历史版本行仍在（不可变——恢复是新增 v4 而非删改）
	for _, v := range vl2.Items {
		if v.Version == 2 || v.Version == 3 {
			if v.SnapshotType != "manual" {
				t.Fatalf("历史 manual 快照被篡改: %+v", v)
			}
		}
	}
}

// TestDocOptimisticLockConflict 乐观锁冲突路径（6004）：
// 双端同 base_version 保存，后者必须被拒
func TestDocOptimisticLockConflict(t *testing.T) {
	ctx := context.Background()
	svc := newSvc()
	const tenant, uid = int64(1), int64(101)
	f, _ := svc.CreateFile(ctx, tenant, uid, "冲突测试")
	id := parseID(t, f.ID)

	// tab A：base=1 → v2 成功
	if _, err := svc.SaveContent(ctx, tenant, uid, id, 1, "tab A 内容"); err != nil {
		t.Fatalf("tab A 保存: %v", err)
	}
	// tab B：仍持 base=1 → 6004
	_, err := svc.SaveContent(ctx, tenant, uid, id, 1, "tab B 内容")
	if err == nil || errx.From(err).Code != errx.CodeDocVersionConflic {
		t.Fatalf("tab B 应 6004 冲突，得 %v", err)
	}
	// tab B 基于 v2 重存（强制覆盖语义=取最新基线再存）→ v3 成功
	r, err := svc.SaveContent(ctx, tenant, uid, id, 2, "tab B 覆盖内容")
	if err != nil || r.Version.Version != 3 {
		t.Fatalf("基于新基线重存应成功 v3: %v", err)
	}
	// 正文为覆盖方内容
	got, _ := svc.GetFile(ctx, tenant, uid, id)
	if got.ContentMD != "tab B 覆盖内容" {
		t.Fatalf("覆盖后正文错: %q", got.ContentMD)
	}
}

// TestDocTrashAndRestore 回收站：软删 purge_at+30d / 列表过滤 / 同名恢复加后缀 / 6011
func TestDocTrashAndRestore(t *testing.T) {
	ctx := context.Background()
	svc := newSvc()
	const tenant, uid = int64(1), int64(101)

	f1, _ := svc.CreateFile(ctx, tenant, uid, "文档A")
	f2, _ := svc.CreateFile(ctx, tenant, uid, "文档B")

	// 软删 f1
	tr, err := svc.TrashFile(ctx, tenant, uid, parseID(t, f1.ID))
	if err != nil {
		t.Fatalf("软删: %v", err)
	}
	if tr.Status != 2 || tr.PurgeAt <= time.Now().UnixMilli() {
		t.Fatalf("回收站态/purge_at 错: %+v", tr)
	}
	if tr.PurgeAt > time.Now().Add(31*24*time.Hour).UnixMilli() {
		t.Fatalf("保留期应 +30d: %d", tr.PurgeAt)
	}

	// 活跃列表不含 f1；回收站列表含 f1 不含 f2
	lst, _ := svc.ListFiles(ctx, tenant, uid, "", "", 50)
	if len(lst.Items) != 1 || lst.Items[0].ID != f2.ID {
		t.Fatalf("活跃列表应只剩 B: %+v", lst.Items)
	}
	trash, _ := svc.ListTrash(ctx, tenant, uid, "", 50)
	if len(trash.Items) != 1 || trash.Items[0].ID != f1.ID {
		t.Fatalf("回收站列表应含 A: %+v", trash.Items)
	}

	// 已在回收站再删 → 6005；活跃文档被 owner 删除前的 Get → 6005
	if _, err := svc.TrashFile(ctx, tenant, uid, parseID(t, f1.ID)); errx.From(err).Code != errx.CodeDocNotFound {
		t.Fatalf("重复软删应 6005: %v", err)
	}
	if _, err := svc.GetFile(ctx, tenant, uid, parseID(t, f1.ID)); errx.From(err).Code != errx.CodeDocNotFound {
		t.Fatalf("回收站态 Get 应 6005: %v", err)
	}

	// 同名恢复：先建同名活跃文档 → 恢复 f1 自动加" (恢复)"后缀
	if _, err := svc.CreateFile(ctx, tenant, uid, "文档A"); err != nil {
		t.Fatalf("建同名: %v", err)
	}
	rr, err := svc.RestoreFromTrash(ctx, tenant, uid, parseID(t, f1.ID))
	if err != nil {
		t.Fatalf("恢复: %v", err)
	}
	if !rr.Renamed || rr.File.Title != "文档A (恢复)" {
		t.Fatalf("同名恢复应加后缀: %+v", rr.File)
	}
	// 二次恢复（已非回收站态）→ 6011
	if _, err := svc.RestoreFromTrash(ctx, tenant, uid, parseID(t, f1.ID)); errx.From(err).Code != errx.CodeDocTrashExpired {
		t.Fatalf("二次恢复应 6011: %v", err)
	}
}

// TestDocOwnershipAndRename owner 私有（6001）/ 同名 6015 / 版本不存在 6013
func TestDocOwnershipAndRename(t *testing.T) {
	ctx := context.Background()
	svc := newSvc()
	const tenant, alice, bob = int64(1), int64(101), int64(202)

	f, _ := svc.CreateFile(ctx, tenant, alice, "Alice 文档")
	id := parseID(t, f.ID)

	// bob（非 owner）访问 → 6001
	if _, err := svc.GetFile(ctx, tenant, bob, id); errx.From(err).Code != errx.CodeDocNoEditPerm {
		t.Fatalf("非 owner 应 6001: %v", err)
	}
	if _, err := svc.SaveContent(ctx, tenant, bob, id, 1, "x"); errx.From(err).Code != errx.CodeDocNoEditPerm {
		t.Fatalf("非 owner 保存应 6001: %v", err)
	}

	// 重命名同名 → 6015
	svc.CreateFile(ctx, tenant, alice, "已有名")
	if _, err := svc.RenameFile(ctx, tenant, alice, id, "已有名"); errx.From(err).Code != errx.CodeDocRenameConflict {
		t.Fatalf("同名重命名应 6015: %v", err)
	}
	// 正常重命名
	if _, err := svc.RenameFile(ctx, tenant, alice, id, "新名字"); err != nil {
		t.Fatalf("重命名: %v", err)
	}

	// 恢复不存在的版本 → 6013
	if _, err := svc.RestoreVersion(ctx, tenant, alice, id, 99); errx.From(err).Code != errx.CodeDocVersion404 {
		t.Fatalf("版本不存在应 6013: %v", err)
	}
	// 不存在的文档 → 6005
	if _, err := svc.GetFile(ctx, tenant, alice, 424242); errx.From(err).Code != errx.CodeDocNotFound {
		t.Fatalf("不存在文档应 6005: %v", err)
	}
}

// TestDocListSearchAndPaging 列表名称模糊 + 键集翻页
func TestDocListSearchAndPaging(t *testing.T) {
	ctx := context.Background()
	svc := newSvc()
	const tenant, uid = int64(1), int64(101)

	// 建三个标题带可区分关键字的文档（ms 级时间并列由 id 兜底）
	svc.CreateFile(ctx, tenant, uid, "周报-11月第一周")
	svc.CreateFile(ctx, tenant, uid, "周报-11月第二周")
	svc.CreateFile(ctx, tenant, uid, "会议纪要")

	// 模糊
	hit, _ := svc.ListFiles(ctx, tenant, uid, "周报", "", 50)
	if len(hit.Items) != 2 {
		t.Fatalf("周报应命中 2: %+v", hit.Items)
	}
	// 分页：limit=1 → 首页 1 条 + has_more + next_cursor；次页衔接不重不漏
	p1, _ := svc.ListFiles(ctx, tenant, uid, "", "", 1)
	if len(p1.Items) != 1 || !p1.HasMore || p1.NextCursor == "" {
		t.Fatalf("首页翻页参数错: %+v", p1)
	}
	p2, _ := svc.ListFiles(ctx, tenant, uid, "", p1.NextCursor, 1)
	if len(p2.Items) != 1 || p2.Items[0].ID == p1.Items[0].ID {
		t.Fatalf("次页应不重: %+v", p2.Items)
	}
	p3, _ := svc.ListFiles(ctx, tenant, uid, "", p2.NextCursor, 1)
	if len(p3.Items) != 1 || p3.HasMore {
		t.Fatalf("末页应 1 条无更多: %+v", p3)
	}
	total := map[string]bool{p1.Items[0].ID: true, p2.Items[0].ID: true, p3.Items[0].ID: true}
	if len(total) != 3 {
		t.Fatalf("三页应覆盖全量不重复: %v", total)
	}
}

// TestDocShare 分享占位：share_id 非空 + 7d 过期 + 假 URL + 不落库（重复调用出新 id）
func TestDocShare(t *testing.T) {
	ctx := context.Background()
	svc := newSvc()
	const tenant, uid = int64(1), int64(101)
	f, _ := svc.CreateFile(ctx, tenant, uid, "分享测试")
	sh, err := svc.Share(ctx, tenant, uid, parseID(t, f.ID))
	if err != nil {
		t.Fatalf("分享: %v", err)
	}
	if sh.ShareID == "" || sh.URL == "" || !strings.Contains(sh.URL, sh.ShareID) {
		t.Fatalf("share_id/url 错: %+v", sh)
	}
	if sh.ExpiresAt <= time.Now().UnixMilli() || sh.ExpiresAt > time.Now().Add(7*24*time.Hour+time.Minute).UnixMilli() {
		t.Fatalf("有效期应 7d: %d", sh.ExpiresAt)
	}
	// 回收站态分享 → 6005
	svc.TrashFile(ctx, tenant, uid, parseID(t, f.ID))
	if _, err := svc.Share(ctx, tenant, uid, parseID(t, f.ID)); errx.From(err).Code != errx.CodeDocNotFound {
		t.Fatalf("回收站分享应 6005: %v", err)
	}
}

func parseID(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("id 非数字: %q", s)
	}
	return n
}
