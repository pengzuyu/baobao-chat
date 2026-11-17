//go:build pg

// mail 域 PG 仓储冒烟（build tag `pg`，默认 go test 不编译；file 域同款）。
//
//	本地：BBC_PG_TEST_DSN='postgres://bbc:...@127.0.0.1:5432/bbc?sslmode=disable' \
//	      go test -tags pg ./internal/mail/repo/ -run TestPGMailSmoke -v
//
// 未设置 BBC_PG_TEST_DSN 即 skip。直接用库：测试数据带纳秒后缀，结束清理。
package mailrepo

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

func TestPGMailSmoke(t *testing.T) {
	dsn := os.Getenv("BBC_PG_TEST_DSN")
	if dsn == "" {
		t.Skip("BBC_PG_TEST_DSN 未设置，跳过 PG 集成测试")
	}
	ctx := context.Background()
	pool, err := bbcpg.New(ctx, dsn)
	if err != nil {
		t.Fatalf("建池: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := bbcpg.Migrate(ctx, pool); err != nil {
		t.Fatalf("迁移（应含 0016 mail 表）: %v", err)
	}
	sfx := strconv.FormatInt(time.Now().UnixNano(), 10)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM mail_message WHERE subject LIKE 'pgsmoke-%'`)
		_, _ = pool.Exec(ctx, `DELETE FROM mail_folder_meta WHERE mailbox_id IN
			(SELECT id FROM mailbox WHERE address LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM mail_app_password WHERE name LIKE 'pgsmoke-%'`)
		_, _ = pool.Exec(ctx, `DELETE FROM mailbox WHERE address LIKE 'pgsmoke-%'`)
		_, _ = pool.Exec(ctx, `DELETE FROM mail_domain WHERE domain LIKE 'pgsmoke-%'`)
	})

	r := NewPostgres(pool)
	now := time.Now()

	// ① 域 seed 幂等
	d1, err := r.EnsureDefaultDomain(ctx, 1, "pgsmoke-mail-"+sfx+".internal")
	if err != nil {
		t.Fatalf("EnsureDefaultDomain: %v", err)
	}
	d2, err := r.EnsureDefaultDomain(ctx, 1, "pgsmoke-mail-"+sfx+".internal")
	if err != nil || d2.ID != d1.ID {
		t.Fatalf("seed 应幂等: %v %d/%d", err, d1.ID, d2.ID)
	}

	// ② 开户（seed 六文件夹）+ 寻址
	mb, err := r.CreateMailbox(ctx, Mailbox{
		TenantID: 1, DomainID: d1.ID, Address: "pgsmoke-a@" + d1.Domain,
		Type: 1, OwnerUserID: 991, QuotaBytes: 1 << 30, Status: 1,
	})
	if err != nil || mb.ID == 0 {
		t.Fatalf("CreateMailbox: %v %+v", err, mb)
	}
	folders, err := r.ListFolders(ctx, mb.ID)
	if err != nil || len(folders) != len(SystemFolders) {
		t.Fatalf("系统文件夹: %v %d", err, len(folders))
	}
	var inboxID int64
	for _, f := range folders {
		if f.Name == "inbox" {
			inboxID = f.ID
		}
	}
	got, err := r.GetMailboxByAddress(ctx, 1, strings.ToUpper(mb.Address))
	if err != nil || got.ID != mb.ID {
		t.Fatalf("按址寻址（大小写不敏感）: %v", err)
	}

	// ③ 收件 + 未读计数 + 幂等重投
	m1, err := r.InsertMessage(ctx, Message{
		TenantID: 1, MailboxID: mb.ID, FolderID: inboxID,
		MessageID: "pgsmoke-mid-1-" + sfx, FromAddr: "x@" + d1.Domain,
		ToAddrs: []string{mb.Address}, Subject: "pgsmoke-主题-" + sfx,
		Snippet: "pgsmoke-摘要", Body: "pgsmoke-正文内容", Size: 42, ReceivedAt: now,
	})
	if err != nil || m1.ID == 0 {
		t.Fatalf("InsertMessage: %v", err)
	}
	if _, err := r.InsertMessage(ctx, m1); err != ErrDuplicateMessageID {
		t.Fatalf("重投应幂等: %v", err)
	}
	folders, _ = r.ListFolders(ctx, mb.ID)
	for _, f := range folders {
		if f.Name == "inbox" && (f.TotalCount != 1 || f.UnreadCount != 1) {
			t.Fatalf("inbox 计数: %+v", f)
		}
	}

	// ④ 已读/搜索/移动
	if err := r.UpdateFlags(ctx, 1, m1.ID, FlagSeen, FlagSeen); err != nil {
		t.Fatalf("UpdateFlags: %v", err)
	}
	hit, err := r.SearchMessages(ctx, 1, []int64{mb.ID}, "pgsmoke-主题", false, 10)
	if err != nil || len(hit) != 1 {
		t.Fatalf("ILIKE 搜索: %v %d", err, len(hit))
	}
	trashID := folderID(t, folders, "trash")
	if err := r.MoveMessage(ctx, 1, m1.ID, trashID); err != nil {
		t.Fatalf("MoveMessage: %v", err)
	}
	list, _ := r.ListMessages(ctx, mb.ID, trashID, 0, 10, "")
	if len(list) != 1 {
		t.Fatalf("trash 应有 1: %d", len(list))
	}

	// ⑤ 应用密码
	pwd, err := r.CreateAppPassword(ctx, AppPassword{
		TenantID: 1, UserID: 991, Name: "pgsmoke-pwd-" + sfx, Hash: "h-" + sfx,
	})
	if err != nil || pwd.ID == 0 {
		t.Fatalf("CreateAppPassword: %v", err)
	}
	lst, _ := r.ListAppPasswords(ctx, 1, 991)
	found := false
	for _, p := range lst {
		if p.ID == pwd.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("应用密码列表缺失")
	}
	if err := r.RevokeAppPassword(ctx, 1, pwd.ID, 991); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := r.RevokeAppPassword(ctx, 1, pwd.ID, 991); err != ErrNotFound {
		t.Fatalf("重复吊销应 ErrNotFound: %v", err)
	}

	// ⑥ 治理
	if err := r.UpdateMailboxStatus(ctx, 1, mb.ID, 2); err != nil {
		t.Fatalf("Suspend: %v", err)
	}
	boxes, _ := r.ListMailboxes(ctx, 1, 2)
	suspended := false
	for _, b := range boxes {
		if b.ID == mb.ID {
			suspended = true
		}
	}
	if !suspended {
		t.Fatal("停用列表缺失")
	}
}

func folderID(t *testing.T, folders []Folder, name string) int64 {
	t.Helper()
	for _, f := range folders {
		if f.Name == name {
			return f.ID
		}
	}
	t.Fatalf("文件夹 %s 缺失", name)
	return 0
}
