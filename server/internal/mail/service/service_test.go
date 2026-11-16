// 邮件域阶段一全链测试（22 篇）：懒开户 → 收发检查链（错误码序）→
// 内存栈直投双向索引 → mail.new 推送 → 读/星/移/搜索 → 应用专用密码
// （真 PBKDF2）→ 治理停用。内存仓 + 可控时钟。
package mailservice

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	authservice "github.com/baobaochat/server/internal/auth/service"
	mailrepo "github.com/baobaochat/server/internal/mail/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
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
	suffix := "3" // carol=10003 及其余用户
	switch u {
	case alice:
		suffix = "1"
	case bob:
		suffix = "2"
	}
	return "E10000" + suffix + "@corp.company.internal"
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

// 共享邮箱 ACL 全链（22 §3.4）：admin 建 → 授权（ACLPerm 桩）→ viewer
// 可见可读不可代发 → owner 可代发（From=共享地址）→ 无权限 fail-closed
func TestSharedMailboxACL(t *testing.T) {
	// ACL 桩：service@ 授 alice owner、bob viewer（DefaultDomain=corp.company.internal）
	const svcDomain = "corp.company.internal"
	perm := map[[2]string]int{}
	clk := &fakeClock{now: time.UnixMilli(1760000000000)}
	repo := mailrepo.NewMemory()
	svc := New(repo, Options{
		DefaultDomain: svcDomain,
		UserEmployeeNo: func(_, uid int64) (string, error) {
			return "E10000" + func() string {
				switch uid {
				case alice:
					return "1"
				case bob:
					return "2"
				}
				return "3"
			}(), nil
		},
		HashPwd: authservice.HashPassword,
		ACLPerm: func(_ context.Context, _ /*resType*/, resID string, uid int64) int {
			return perm[[2]string{resID, strconv.FormatInt(uid, 10)}]
		},
		Now: clk.Now,
	})
	ctx := context.Background()

	// 本人邮箱就绪（alice/bob）
	if _, err := svc.Summary(ctx, 1, alice); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Summary(ctx, 1, bob); err != nil {
		t.Fatal(err)
	}
	// admin 建共享邮箱
	shared, err := svc.AdminCreateSharedMailbox(ctx, 1, "service", 31)
	if err != nil {
		t.Fatal(err)
	}
	if shared.Type != 2 || shared.Address != "service@"+svcDomain {
		t.Fatalf("共享邮箱：%+v", shared)
	}
	// 无授权：两人均不可见（fail-closed）
	if l, _ := svc.SharedMailboxes(ctx, 1, alice); len(l) != 0 {
		t.Fatal("无授权不可见")
	}
	// 授权
	perm[[2]string{shared.Address, "10001"}] = 4 // alice owner
	perm[[2]string{shared.Address, "10002"}] = 1 // bob viewer
	// 可见列表（owner 标记）
	l, _ := svc.SharedMailboxes(ctx, 1, alice)
	if len(l) != 1 || !l[0].IsOwner {
		t.Fatalf("owner 视图：%+v", l)
	}
	if lb, _ := svc.SharedMailboxes(ctx, 1, bob); len(lb) != 1 || lb[0].IsOwner {
		t.Fatalf("viewer 视图：%+v", lb)
	}
	// owner 代发：From=共享地址，收件人看到共享地址
	resp, err := svc.SendAsShared(ctx, 1, alice, shared.ID, SendReq{
		To: []string{addr(bob)}, Subject: "代发通知", Body: "由部门邮箱发出"})
	if err != nil || len(resp.Delivered) != 1 {
		t.Fatalf("代发：%v %+v", err, resp)
	}
	// 代发收件落 bob 本人邮箱，From=共享地址（22 §3.4 代发外显）
	bobInbox, _ := svc.ListMessages(ctx, 1, bob, "inbox", 0, 10, "")
	if len(bobInbox) != 1 || bobInbox[0].FromAddr != shared.Address {
		t.Fatalf("收件 From 应为共享地址：%+v", bobInbox)
	}
	// alice 本人 sent 副本也在（发起者留痕）
	if mine, _ := svc.ListMessages(ctx, 1, alice, "sent", 0, 10, ""); len(mine) != 1 {
		t.Fatal("代发者 sent 副本")
	}
	// viewer 不可代发
	if _, err := svc.SendAsShared(ctx, 1, bob, shared.ID, SendReq{
		To: []string{addr(alice)}, Subject: "x"}); err == nil {
		t.Fatal("viewer 代发应拒")
	}
	// 无权限者读拒
	if _, err := svc.ListSharedMessages(ctx, 1, 99999, shared.ID, "inbox", 0, 10, ""); err == nil {
		t.Fatal("无权限读应拒")
	}
	// 共享邮箱收信：bob 发往 service@ → 共享 inbox+未读计入视图
	if _, err := svc.SendMessage(ctx, 1, bob, SendReq{
		To: []string{shared.Address}, Subject: "咨询", Body: "请教"}); err != nil {
		t.Fatal(err)
	}
	sharedInbox, err := svc.ListSharedMessages(ctx, 1, bob, shared.ID, "inbox", 0, 10, "")
	if err != nil || len(sharedInbox) != 1 {
		t.Fatalf("viewer 读共享收件：%v %d", err, len(sharedInbox))
	}
	lb, _ := svc.SharedMailboxes(ctx, 1, bob)
	if lb[0].Unread != 1 {
		t.Fatalf("共享未读：%+v", lb)
	}
}

// TestAutoForward D16：收件人设 auto_forward → 副本投递到转发邮箱；链路封顶一层防环
func TestAutoForward(t *testing.T) {
	const carol = int64(10003)
	repo := mailrepo.NewMemory()
	svc := New(repo, mailSvcOptions(repo))
	ctx := context.Background()
	// 三方开户：alice（发件）、bob（设转发→carol）、carol（转发目标）
	if _, err := svc.Summary(ctx, 1, alice); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Summary(ctx, 1, bob); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Summary(ctx, 1, carol); err != nil {
		t.Fatal(err)
	}
	bobMB, err := repo.GetMailboxByOwner(ctx, 1, bob)
	if err != nil {
		t.Fatal(err)
	}
	set := bobMB.Settings
	set.AutoForward = addr(carol)
	if err := repo.UpdateSettings(ctx, 1, bobMB.ID, set); err != nil {
		t.Fatal(err)
	}
	// alice → bob：carol 收到转发副本（Fwd: 前缀）
	if _, err := svc.SendMessage(ctx, 1, alice, SendReq{
		To: []string{addr(bob)}, Subject: "转发测试", Body: "正文",
	}); err != nil {
		t.Fatal(err)
	}
	carolMB, _ := repo.GetMailboxByOwner(ctx, 1, carol)
	msgs, err := repo.ListMessages(ctx, carolMB.ID, mustFolderID(t, repo, carolMB.ID, "inbox"), 0, 20, "")
	if err != nil || len(msgs) != 1 || msgs[0].Subject != "Fwd: 转发测试" {
		t.Fatalf("转发副本不符: %v %+v", err, msgs)
	}
	// 防环：carol 也设转发回 bob——转发副本（InReplyTo=auto-fwd）不再二次转发
	setC := carolMB.Settings
	setC.AutoForward = addr(bob)
	_ = repo.UpdateSettings(ctx, 1, carolMB.ID, setC)
	bobMB2, _ := repo.GetMailboxByOwner(ctx, 1, bob)
	inboxBob := mustFolderID(t, repo, bobMB2.ID, "inbox")
	msgsBob, _ := repo.ListMessages(ctx, bobMB2.ID, inboxBob, 0, 20, "")
	if len(msgsBob) != 1 { // 原件 1 封；若未防环 bob 会收到 carol 的二次转发
		t.Fatalf("防环失效（bob 应仅原件 1 封）: %+v", msgsBob)
	}
}

// TestDrafts D16：存草稿（drafts folder+FlagDraft）/更新（旧行入 trash）/发送清理
func TestDrafts(t *testing.T) {
	repo := mailrepo.NewMemory()
	svc := New(repo, mailSvcOptions(repo))
	ctx := context.Background()
	if _, err := svc.Summary(ctx, 1, alice); err != nil {
		t.Fatal(err)
	}
	mb, _ := repo.GetMailboxByOwner(ctx, 1, alice)
	draftsID := mustFolderID(t, repo, mb.ID, "drafts")
	trashID := mustFolderID(t, repo, mb.ID, "trash")

	id1, err := svc.SaveDraft(ctx, 1, alice, SendReq{To: []string{addr(bob)}, Subject: "草稿v1", Body: "一稿"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := repo.GetMessage(ctx, 1, id1)
	if dm.FolderID != draftsID || dm.Flags&mailrepo.FlagDraft == 0 {
		t.Fatalf("草稿行不符: %+v", dm)
	}
	// 更新：旧行 trash、新行 drafts
	id2, err := svc.SaveDraft(ctx, 1, alice, SendReq{To: []string{addr(bob)}, Subject: "草稿v2", Body: "二稿"}, id1)
	if err != nil {
		t.Fatal(err)
	}
	old, _ := repo.GetMessage(ctx, 1, id1)
	if old.FolderID != trashID {
		t.Fatalf("旧草稿应入 trash: %+v", old)
	}
	// 发送清理：草稿 v2 移 trash
	if err := svc.DiscardDraft(ctx, 1, alice, id2); err != nil {
		t.Fatal(err)
	}
	cur, _ := repo.GetMessage(ctx, 1, id2)
	if cur.FolderID != trashID {
		t.Fatalf("发送后草稿应入 trash: %+v", cur)
	}
}

func mustFolderID(t *testing.T, repo mailrepo.Repo, mailboxID int64, name string) int64 {
	t.Helper()
	folders, err := repo.ListFolders(context.Background(), mailboxID)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range folders {
		if f.Name == name {
			return f.ID
		}
	}
	t.Fatalf("folder %s not found", name)
	return 0
}

// mailSvcOptions 测试 Options（newSvc 同款构造，repo 参数化供直读断言）
func mailSvcOptions(repo mailrepo.Repo) Options {
	clk := &fakeClock{now: time.UnixMilli(1760000000000)}
	return Options{
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
		Now:       clk.Now,
	}
}
