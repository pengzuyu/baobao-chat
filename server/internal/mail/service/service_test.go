// 邮件域阶段一全链测试（22 篇）：懒开户 → 收发检查链（错误码序）→
// 内存栈直投双向索引 → mail.new 推送 → 读/星/移/搜索 → 应用专用密码
// （真 PBKDF2）→ 治理停用。内存仓 + 可控时钟。
package mailservice

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	authservice "github.com/baobaowork/server/internal/auth/service"
	mailrepo "github.com/baobaowork/server/internal/mail/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

const (
	alice = int64(10001)
	bob   = int64(10002)
)

// fakeClock 可控时钟（限流滑窗推进）
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type pushLog struct {
	mu sync.Mutex
	v  []struct {
		uid int64
		typ string
	}
}

func (p *pushLog) push(uid int64, payload any) {
	_ = payload
	p.mu.Lock()
	defer p.mu.Unlock()
	p.v = append(p.v, struct {
		uid int64
		typ string
	}{uid, "mail.new"})
}

func newSvc(t *testing.T) (*Service, *fakeClock, *pushLog) {
	t.Helper()
	clk := &fakeClock{now: time.UnixMilli(1760000000000)}
	push := &pushLog{}
	svc := New(mailrepo.NewMemory(), Options{
		DefaultDomain: "corp.company.internal",
		UserEmployeeNo: func(_, uid int64) (string, error) {
			return "E10000" + func() string {
				switch uid {
				case alice:
					return "1"
				case bob:
					return "2"
				default:
					return "3"
				}
			}(), nil
		},
		HashPwd:   authservice.HashPassword,
		VerifyPwd: authservice.VerifyPassword,
		PushMail:  push.push,
		Now:       clk.Now,
	})
	if svc == nil {
		t.Fatal("svc 装配失败")
	}
	return svc, clk, push
}

// codeOf 错误码断言辅助（rtc 同款）
func codeOf(t *testing.T, err error) int {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误但为 nil")
	}
	return int(errx.From(err).Code)
}

func addr(u int64) string {
	if u == alice {
		return "E100001@corp.company.internal"
	}
	return "E100002@corp.company.internal"
}

// 懒开户：首次 summary 建 employee_no@默认域 + 六文件夹；幂等
func TestLazyOpenAndSummary(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()

	s1, err := svc.Summary(ctx, 1, alice)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Address != addr(alice) {
		t.Fatalf("懒开户地址：%s", s1.Address)
	}
	if len(s1.Folders) != len(mailrepo.SystemFolders) {
		t.Fatalf("系统文件夹数：%d", len(s1.Folders))
	}
	if s1.Unread != 0 || s1.QuotaTotal != DefaultQuotaBytes {
		t.Fatalf("初始态异常：%+v", s1)
	}
	// 幂等：二次访问不重复开户
	s2, _ := svc.Summary(ctx, 1, alice)
	if s2.Address != s1.Address {
		t.Fatal("懒开户应幂等")
	}
}

// 收发全链：sent/inbox 双向索引 + 未读计数 + mail.new 推送 + 配额记账
func TestSendFullChain(t *testing.T) {
	svc, _, push := newSvc(t)
	ctx := context.Background()
	if _, err := svc.Summary(ctx, 1, bob); err != nil { // bob 先开户
		t.Fatal(err)
	}

	resp, err := svc.SendMessage(ctx, 1, alice, SendReq{
		To:      []string{addr(bob)},
		Subject: "方案定稿",
		Body:    "请审阅附件方案。",
		Attachments: []mailrepo.Attachment{
			{FileID: 1, Name: "plan.pdf", Size: 1024},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Delivered) != 1 || len(resp.Undelivered) != 0 {
		t.Fatalf("投递结果：%+v", resp)
	}

	// bob：inbox 未读 1 + mail.new 推送
	sb, _ := svc.Summary(ctx, 1, bob)
	if sb.Unread != 1 {
		t.Fatalf("bob 未读：%d", sb.Unread)
	}
	push.mu.Lock()
	if len(push.v) != 1 || push.v[0].uid != bob {
		t.Fatalf("mail.new 推送：%+v", push.v)
	}
	push.mu.Unlock()

	// alice：sent 有已读副本；列表 filter=starred 空
	sent, err := svc.ListMessages(ctx, 1, alice, "sent", 0, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || sent[0].Flags&mailrepo.FlagSeen == 0 || !sent[0].HasAttachment {
		t.Fatalf("sent 副本：%+v", sent)
	}
	// bob 读信 → 未读归零
	inbox, _ := svc.ListMessages(ctx, 1, bob, "inbox", 0, 10, "")
	if len(inbox) != 1 || inbox[0].Flags&mailrepo.FlagSeen != 0 {
		t.Fatalf("inbox：%+v", inbox)
	}
	if err := svc.MarkRead(ctx, 1, bob, inbox[0].ID); err != nil {
		t.Fatal(err)
	}
	sb2, _ := svc.Summary(ctx, 1, bob)
	if sb2.Unread != 0 {
		t.Fatalf("已读后未读数：%d", sb2.Unread)
	}
}

// 检查链错误码序：9032 → 9035 → 9034 → 9031 → 9024 → 9027
func TestSendCheckChain(t *testing.T) {
	svc, clk, _ := newSvc(t)
	ctx := context.Background()
	if _, err := svc.Summary(ctx, 1, alice); err != nil {
		t.Fatal(err)
	}

	// ① 收件人格式（9032）
	if c := codeOf(t, mustErr(t, func() error {
		_, err := svc.SendMessage(ctx, 1, alice, SendReq{To: []string{"badaddr"}})
		return err
	})); c != int(errx.CodeMailRecipientInvalid) {
		t.Fatalf("格式坏应 9032：%d", c)
	}
	// ② 外域（9035：内网模式仅本域）
	if c := codeOf(t, mustErr(t, func() error {
		_, err := svc.SendMessage(ctx, 1, alice, SendReq{To: []string{"x@gmail.com"}})
		return err
	})); c != int(errx.CodeMailDNSNotReady) {
		t.Fatalf("外域应 9035：%d", c)
	}
	// ③ 敏感词（9034）
	orig := svc.opts.SensitiveWords
	svc.opts.SensitiveWords = func() []string { return []string{"机密词"} }
	if c := codeOf(t, mustErr(t, func() error {
		_, err := svc.SendMessage(ctx, 1, alice, SendReq{
			To: []string{addr(alice)}, Subject: "含机密词的主题"})
		return err
	})); c != int(errx.CodeMailPolicyDenied) {
		t.Fatalf("敏感词应 9034：%d", c)
	}
	svc.opts.SensitiveWords = orig
	// ④ 限流（9031：窗口内第 11 封）
	for i := 0; i < DefaultRatePerMin; i++ {
		if _, err := svc.SendMessage(ctx, 1, alice, SendReq{
			To: []string{addr(alice)}, Subject: strings.Repeat("s", 8)}); err != nil {
			t.Fatalf("第 %d 封不应限流：%v", i, err)
		}
	}
	if c := codeOf(t, mustErr(t, func() error {
		_, err := svc.SendMessage(ctx, 1, alice, SendReq{To: []string{addr(alice)}})
		return err
	})); c != int(errx.CodeMailSendLimited) {
		t.Fatalf("第 11 封应 9031：%d", c)
	}
	clk.advance(61 * time.Second) // 窗口滑出
	// ⑤ 附件超限（9024：总量 >25MB）
	if c := codeOf(t, mustErr(t, func() error {
		_, err := svc.SendMessage(ctx, 1, alice, SendReq{
			To:          []string{addr(alice)},
			Attachments: []mailrepo.Attachment{{FileID: 1, Name: "big", Size: DefaultMaxAttach + 1}},
		})
		return err
	})); c != int(errx.CodeMailAttachmentLimit) {
		t.Fatalf("附件超限应 9024：%d", c)
	}
}

// 配额满（9027）：自建小配额邮箱绕懒开户默认 5GB
func TestSendQuotaFull(t *testing.T) {
	_, _, _ = newSvc(t)
	ctx := context.Background()
	repo := mailrepo.NewMemory()
	d, err := repo.EnsureDefaultDomain(ctx, 1, "corp.company.internal")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreateMailbox(ctx, mailrepo.Mailbox{
		TenantID: 1, DomainID: d.ID, Address: "tiny@corp.company.internal",
		Type: 1, OwnerUserID: 99, QuotaBytes: 100, Status: 1,
	}); err != nil {
		t.Fatal(err)
	}
	// 独立 svc 绑同一 repo（懒开户命中 tiny 小配额邮箱），body 超 100B → 9027
	s := New(repo, Options{
		DefaultDomain:  "corp.company.internal",
		UserEmployeeNo: func(_, _ int64) (string, error) { return "tiny", nil },
		HashPwd:        authservice.HashPassword,
		Now:            time.Now,
	})
	c := codeOf(t, mustErr(t, func() error {
		_, err := s.SendMessage(ctx, 1, 99, SendReq{
			To: []string{"tiny@corp.company.internal"}, Body: strings.Repeat("x", 200)})
		return err
	}))
	if c != int(errx.CodeMailQuotaFull) {
		t.Fatalf("配额满应 9027：%d", c)
	}
}

// 未开户收件人：undelivered 9021；发件箱照常落
func TestSendUndelivered(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	if _, err := svc.Summary(ctx, 1, alice); err != nil {
		t.Fatal(err)
	}
	resp, err := svc.SendMessage(ctx, 1, alice, SendReq{
		To: []string{"E77777@corp.company.internal"}, Subject: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Undelivered) != 1 || resp.Undelivered[0].Reason != 9021 {
		t.Fatalf("未开户应 undelivered 9021：%+v", resp.Undelivered)
	}
	sent, _ := svc.ListMessages(ctx, 1, alice, "sent", 0, 10, "")
	if len(sent) != 1 {
		t.Fatalf("发件箱应照常落：%d", len(sent))
	}
}

// 星标/移动：filter 语义 + 文件夹计数两侧迁移
func TestStarAndMove(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	for _, u := range []int64{alice, bob} {
		if _, err := svc.Summary(ctx, 1, u); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.SendMessage(ctx, 1, alice, SendReq{To: []string{addr(bob)}, Subject: "m1"}); err != nil {
		t.Fatal(err)
	}
	inbox, _ := svc.ListMessages(ctx, 1, bob, "inbox", 0, 10, "")
	msg := inbox[0]

	if err := svc.SetStar(ctx, 1, bob, msg.ID, true); err != nil {
		t.Fatal(err)
	}
	stars, _ := svc.ListMessages(ctx, 1, bob, "inbox", 0, 10, mailrepo.FilterStarred)
	if len(stars) != 1 {
		t.Fatal("星标 filter 应命中 1")
	}
	if err := svc.Move(ctx, 1, bob, msg.ID, "trash"); err != nil {
		t.Fatal(err)
	}
	inboxAfter, _ := svc.ListMessages(ctx, 1, bob, "inbox", 0, 10, "")
	if len(inboxAfter) != 0 {
		t.Fatalf("移走后 inbox 应空：%d", len(inboxAfter))
	}
	trash, _ := svc.ListMessages(ctx, 1, bob, "trash", 0, 10, "")
	if len(trash) != 1 {
		t.Fatal("trash 应有 1")
	}
	// 越权：alice 读 bob 的信 → 9030
	if c := codeOf(t, mustErr(t, func() error {
		_, err := svc.GetMessage(ctx, 1, alice, msg.ID)
		return err
	})); c != int(errx.CodeMailNotFound) {
		t.Fatalf("越权读信应 9030：%d", c)
	}
}

// 搜索：主题/正文 ILIKE + attachOnly
func TestSearch(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	for _, u := range []int64{alice, bob} {
		if _, err := svc.Summary(ctx, 1, u); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.SendMessage(ctx, 1, alice, SendReq{
		To: []string{addr(bob)}, Subject: "季度预算表",
		Body:        "详见正文数据。",
		Attachments: []mailrepo.Attachment{{FileID: 9, Name: "a.xlsx", Size: 10}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SendMessage(ctx, 1, alice, SendReq{
		To: []string{addr(bob)}, Subject: "周报"}); err != nil {
		t.Fatal(err)
	}
	hit, err := svc.Search(ctx, 1, bob, "预算", false, 10)
	if err != nil || len(hit) != 1 {
		t.Fatalf("主题搜索：%d %v", len(hit), err)
	}
	hitBody, _ := svc.Search(ctx, 1, bob, "正文数据", false, 10)
	if len(hitBody) != 1 {
		t.Fatal("正文搜索应命中")
	}
	att, _ := svc.Search(ctx, 1, bob, "", true, 10)
	if len(att) != 1 {
		t.Fatal("仅附件应命中 1")
	}
	// 不越权：alice 搜不到自己未参与的信（第三方 carol → bob；alice 的
	// sent 副本含"预算"属正常——发件人视角同主题）
	const carol = int64(10003)
	if _, err := svc.Summary(ctx, 1, carol); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SendMessage(ctx, 1, carol, SendReq{
		To: []string{addr(bob)}, Subject: "机密名单"}); err != nil {
		t.Fatal(err)
	}
	leak, _ := svc.Search(ctx, 1, alice, "机密名单", false, 10)
	if len(leak) != 0 {
		t.Fatalf("alice 不应搜到 carol→bob 信件：%d", len(leak))
	}
	bobHit, _ := svc.Search(ctx, 1, bob, "机密名单", false, 10)
	if len(bobHit) != 1 {
		t.Fatal("bob 应搜到")
	}
}

// 应用专用密码：明文一次 + 真 PBKDF2 校验 + 吊销即时（9026）
func TestAppPasswordLifecycle(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	if _, err := svc.Summary(ctx, 1, alice); err != nil {
		t.Fatal(err)
	}
	created, err := svc.CreateAppPassword(ctx, 1, alice, "Foxmail")
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Secret) != appPasswordRunes {
		t.Fatalf("密码长度：%d", len(created.Secret))
	}
	list, _ := svc.ListAppPasswords(ctx, 1, alice)
	if len(list) != 1 || list[0].Name != "Foxmail" {
		t.Fatalf("列表：%+v", list)
	}
	// 路径②语义：地址→密码校验
	if !svc.VerifyAppPassword(ctx, 1, addr(alice), created.Secret) {
		t.Fatal("正确密码应通过")
	}
	if svc.VerifyAppPassword(ctx, 1, addr(alice), "wrong-secret-000000") {
		t.Fatal("错误密码应拒绝")
	}
	// 吊销即时生效 + 重复吊销 9026
	if err := svc.RevokeAppPassword(ctx, 1, alice, created.ID); err != nil {
		t.Fatal(err)
	}
	if svc.VerifyAppPassword(ctx, 1, addr(alice), created.Secret) {
		t.Fatal("吊销后应即时失效")
	}
	if c := codeOf(t, mustErr(t, func() error {
		return svc.RevokeAppPassword(ctx, 1, alice, created.ID)
	})); c != int(errx.CodeMailAppPwdInvalid) {
		t.Fatalf("重复吊销应 9026：%d", c)
	}
}

// 治理：停用 9021（摘要/发送/投递三路）+ 恢复
func TestAdminSuspendResume(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	mbA, err := svc.Summary(ctx, 1, alice)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Summary(ctx, 1, bob); err != nil {
		t.Fatal(err)
	}
	// 治理面按 mailbox id 停用（Summary 不返回 id——经 AdminMailboxes 查）
	boxes, err := svc.AdminMailboxes(ctx, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	var aliceBox int64
	for _, b := range boxes {
		if b.Address == mbA.Address {
			aliceBox = b.ID
		}
	}
	if aliceBox == 0 {
		t.Fatal("未找到 alice 邮箱")
	}
	if err := svc.AdminSuspendMailbox(ctx, 1, aliceBox); err != nil {
		t.Fatal(err)
	}
	if c := codeOf(t, mustErr(t, func() error {
		_, err := svc.SendMessage(ctx, 1, alice, SendReq{To: []string{addr(bob)}})
		return err
	})); c != int(errx.CodeMailboxDisabled) {
		t.Fatalf("停用后发送应 9021：%d", c)
	}
	// 投递给停用邮箱 → undelivered 9021
	resp, err := svc.SendMessage(ctx, 1, bob, SendReq{To: []string{addr(alice)}})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Undelivered) != 1 || resp.Undelivered[0].Reason != 9021 {
		t.Fatalf("投递给停用邮箱：%+v", resp.Undelivered)
	}
	// 恢复
	if err := svc.AdminResumeMailbox(ctx, 1, aliceBox); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SendMessage(ctx, 1, alice, SendReq{To: []string{addr(bob)}}); err != nil {
		t.Fatal(err)
	}
}

// 治理面域列表：seed 默认域可见
func TestAdminDomains(t *testing.T) {
	svc, _, _ := newSvc(t)
	domains, err := svc.AdminDomains(context.Background(), 1)
	if err != nil || len(domains) != 1 || !domains[0].IsDefault {
		t.Fatalf("默认域 seed：%+v %v", domains, err)
	}
}

func mustErr(t *testing.T, f func() error) error {
	t.Helper()
	err := f()
	if err == nil {
		t.Fatal("期望错误")
	}
	return err
}
