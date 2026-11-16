// 邮件域服务（22 篇阶段一务实版）。
//
// 阶段一裁剪登记（对齐 22 §9/§13 未尽项）：
//
//	· 邮件栈=进程内直投（MailStack 内存语义内联；docker-mailserver/admin API
//	  对接、IMAP 同步引擎、auth-bridge 路径②接入随阶段二）
//	· 懒开户替代 org 生命周期事件（首次访问即开户——"登录即有邮箱"最小实现；
//	  user.offboarded 停用联动随 D02 消费方阶段二；收件方未开户=投递失败 9021）
//	· 共享邮箱/代发随 resource_acl（表未建）；定时发送/草稿/DSN/iCal/
//	  forward-im mail_card 随阶段二；搜索 ILIKE 降级（zhparser 随真实栈）
//	· mail.new 推送 kind=new（客户端角标数据源）；IM 横幅提醒（reminder）
//	  与 mail_rule 规则引擎随阶段二——不@不打扰原则
//	· 附件为 07 篇 file_id 引用（声明 size 计配额；file 域回链校验阶段二）
package mailservice

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	mailrepo "github.com/baobaochat/server/internal/mail/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// 发送检查链参数（22 §4.3；admin_policy domain=mail 热更随 D10 PAD-09 阶段二）
const (
	DefaultQuotaBytes   int64 = 5 << 30  // 5GB（22 §5 mailbox）
	DefaultMaxAttach    int64 = 25 << 20 // 25MB 附件总量
	DefaultMaxAttachCnt int   = 20       // 单邮件附件数上限
	DefaultRatePerMin   int   = 10       // 发送频率（反滥用，9031）
	DefaultListLimit    int   = 50
	MaxListLimit        int   = 200
	snippetRunes        int   = 200
	appPasswordRunes    int   = 24 // 应用专用密码长度（base62）
)

// Options 装配选项（跨域能力全闭包，D02 §4：不引 org/admin/auth 包）
type Options struct {
	DefaultDomain string // 默认内网域（22 §3.3 模式①：corp.company.internal）
	// UserEmployeeNo 懒开户寻址（org 域闭包；查无此人=无法开户）
	UserEmployeeNo func(tenantID, userID int64) (string, error)
	// SensitiveWords 外发敏感词（admin 域热更闭包，04 篇库复用；命中=9034 拦截）
	SensitiveWords func() []string
	// HashPwd 应用专用密码 hash（auth 域 PBKDF2 闭包）
	HashPwd func(string) (string, error)
	// VerifyPwd 应用专用密码校验（auth 域 VerifyPassword 闭包；路径②预留）
	VerifyPwd func(storedHash, secret string) bool
	// PushMail mail.new 直推（gateway 惯例：瞬态推送不经 eventbus）
	PushMail func(userID int64, payload any)
	// ACLPerm 共享邮箱资源权限（mail.shared，address 为资源键；0=无——
	// 共享邮箱纯 ACL 驱动 fail-closed，无基线回落；返回 1..4 同 org/acl）
	ACLPerm func(ctx context.Context, resourceType, resourceID string, userID int64) int
	Now     func() time.Time
}

// Service 邮件域服务
type Service struct {
	repo mailrepo.Repo
	opts Options

	rateMu sync.Mutex
	rate   map[int64][]time.Time // uid → 滑动分钟窗发送时间戳（9031）
}

// New 构造
func New(r mailrepo.Repo, opts Options) *Service {
	if opts.DefaultDomain == "" {
		opts.DefaultDomain = "corp.company.internal"
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.HashPwd == nil {
		return nil // 应用密码路径必需（装配期防呆）
	}
	return &Service{repo: r, opts: opts, rate: map[int64][]time.Time{}}
}

// ensureDomain seed 默认域（幂等；启动/首次访问）
func (s *Service) ensureDomain(ctx context.Context, tenantID int64) (mailrepo.Domain, error) {
	return s.repo.EnsureDefaultDomain(ctx, tenantID, s.opts.DefaultDomain)
}

// openMailbox 懒开户（"登录即有邮箱"）：无邮箱即建 employee_no@默认域，
// seed 六系统文件夹。suspended 不重建（9021 由调用方判）。
func (s *Service) openMailbox(ctx context.Context, tenantID, userID int64) (*mailrepo.Mailbox, error) {
	if mb, err := s.repo.GetMailboxByOwner(ctx, tenantID, userID); err == nil {
		return mb, nil
	}
	emp, err := s.opts.UserEmployeeNo(tenantID, userID)
	if err != nil || emp == "" {
		return nil, errx.New(errx.CodeMailNotReady, "邮箱开户失败（用户不存在或初始化中）")
	}
	domain, err := s.ensureDomain(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	created, err := s.repo.CreateMailbox(ctx, mailrepo.Mailbox{
		TenantID: tenantID, DomainID: domain.ID,
		Address: fmt.Sprintf("%s@%s", emp, domain.Domain),
		Type:    1, OwnerUserID: userID, QuotaBytes: DefaultQuotaBytes, Status: 1,
	})
	if err != nil {
		return nil, err
	}
	return &created, nil
}

// mustActiveMailbox 懒开户 + 活跃校验（9021）
func (s *Service) mustActiveMailbox(ctx context.Context, tenantID, userID int64) (*mailrepo.Mailbox, error) {
	mb, err := s.openMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	if mb.Status != 1 {
		return nil, errx.New(errx.CodeMailboxDisabled, "邮箱未开通或已停用")
	}
	return mb, nil
}

// ---------------------------------------------------------------------------
// 摘要与列表
// ---------------------------------------------------------------------------

// FolderStat 文件夹统计（角标数据源）
type FolderStat struct {
	Name        string `json:"name"`
	TotalCount  int    `json:"total_count"`
	UnreadCount int    `json:"unread_count"`
}

// Summary GET /mail/summary（懒开户触发点；导航角标与 MAI-03 数据源）
type Summary struct {
	Address    string       `json:"address"`
	Status     int          `json:"status"`
	Unread     int          `json:"unread"`
	QuotaUsed  int64        `json:"quota_used"`
	QuotaTotal int64        `json:"quota_total"`
	Folders    []FolderStat `json:"folders"`
}

// Summary 邮箱摘要
func (s *Service) Summary(ctx context.Context, tenantID, userID int64) (*Summary, error) {
	mb, err := s.openMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	folders, err := s.repo.ListFolders(ctx, mb.ID)
	if err != nil {
		return nil, err
	}
	out := &Summary{
		Address: mb.Address, Status: mb.Status,
		QuotaUsed: mb.UsedBytes, QuotaTotal: mb.QuotaBytes,
		Folders: []FolderStat{},
	}
	for _, f := range folders {
		out.Folders = append(out.Folders, FolderStat{
			Name: f.Name, TotalCount: f.TotalCount, UnreadCount: f.UnreadCount})
		if f.Name == "inbox" {
			out.Unread = f.UnreadCount
		}
	}
	return out, nil
}

// ListMessages GET /mail/messages（folder=inbox 默认；filter: unread/starred/attach）
func (s *Service) ListMessages(ctx context.Context, tenantID, userID int64,
	folder string, cursor int64, limit int, filter string) ([]mailrepo.Message, error) {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	if folder == "" {
		folder = "inbox"
	}
	folderID, err := s.folderID(ctx, mb.ID, folder)
	if err != nil {
		return nil, errx.New(errx.CodeMailFolderError, "文件夹不存在")
	}
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if limit > MaxListLimit {
		limit = MaxListLimit
	}
	return s.repo.ListMessages(ctx, mb.ID, folderID, cursor, limit, filter)
}

// GetMessage GET /mail/messages/{id}（正文；阶段一 body 恒 cached）
func (s *Service) GetMessage(ctx context.Context, tenantID, userID, msgID int64) (*mailrepo.Message, error) {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	msg, err := s.repo.GetMessage(ctx, tenantID, msgID)
	if err != nil || msg.MailboxID != mb.ID {
		return nil, errx.New(errx.CodeMailNotFound, "邮件不存在或已删除")
	}
	return msg, nil
}

// MarkRead POST /mail/messages/{id}/read（seen 置位；重复读幂等）
func (s *Service) MarkRead(ctx context.Context, tenantID, userID, msgID int64) error {
	return s.updateOwned(ctx, tenantID, userID, msgID,
		mailrepo.FlagSeen, mailrepo.FlagSeen)
}

// SetStar POST /mail/messages/{id}/star（star 翻转）
func (s *Service) SetStar(ctx context.Context, tenantID, userID, msgID int64, on bool) error {
	var val int16
	if on {
		val = mailrepo.FlagFlagged
	}
	return s.updateOwned(ctx, tenantID, userID, msgID, mailrepo.FlagFlagged, val)
}

// Move POST /mail/messages/{id}/move（folder 计数两侧同步）
func (s *Service) Move(ctx context.Context, tenantID, userID, msgID int64, folder string) error {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	msg, err := s.repo.GetMessage(ctx, tenantID, msgID)
	if err != nil || msg.MailboxID != mb.ID {
		return errx.New(errx.CodeMailNotFound, "邮件不存在或已删除")
	}
	folderID, err := s.folderID(ctx, mb.ID, folder)
	if err != nil {
		return errx.New(errx.CodeMailFolderError, "目标文件夹不存在")
	}
	return s.repo.MoveMessage(ctx, tenantID, msgID, folderID)
}

func (s *Service) updateOwned(ctx context.Context, tenantID, userID, msgID int64, mask, val int16) error {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	msg, err := s.repo.GetMessage(ctx, tenantID, msgID)
	if err != nil || msg.MailboxID != mb.ID {
		return errx.New(errx.CodeMailNotFound, "邮件不存在或已删除")
	}
	return s.repo.UpdateFlags(ctx, tenantID, msgID, mask, val)
}

// Search GET /mail/search（ILIKE 降级；ACL 前置过滤=本人邮箱，共享邮箱阶段二）
func (s *Service) Search(ctx context.Context, tenantID, userID int64,
	q string, attachOnly bool, limit int) ([]mailrepo.Message, error) {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = DefaultListLimit
	}
	return s.repo.SearchMessages(ctx, tenantID, []int64{mb.ID}, q, attachOnly, limit)
}

// ---------------------------------------------------------------------------
// 设置与应用专用密码
// ---------------------------------------------------------------------------

// GetSettings GET /mail/settings
func (s *Service) GetSettings(ctx context.Context, tenantID, userID int64) (*mailrepo.Settings, error) {
	mb, err := s.openMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	return &mb.Settings, nil
}

// UpdateSettings PUT /mail/settings（自动转发执行/多身份签名阶段二，先落配置）
func (s *Service) UpdateSettings(ctx context.Context, tenantID, userID int64, set mailrepo.Settings) error {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	if set.AutoForward != "" && !validAddress(set.AutoForward) {
		return errx.New(errx.CodeMailRecipientInvalid, "自动转发地址非法")
	}
	return s.repo.UpdateSettings(ctx, tenantID, mb.ID, set)
}

// AppPwdView 应用专用密码视图（不含 hash）
type AppPwdView struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

// AppPasswordPlain POST /mail/app-passwords 响应（明文仅此一次，22 §3.5 MAI-03）
type AppPasswordPlain struct {
	AppPwdView
	Secret string `json:"secret"`
}

// CreateAppPassword 生成（base62 随机 24 位；仅存 hash）
func (s *Service) CreateAppPassword(ctx context.Context, tenantID, userID int64, name string) (*AppPasswordPlain, error) {
	if strings.TrimSpace(name) == "" {
		return nil, errx.New(errx.CodeBadRequest, "name 必填")
	}
	if _, err := s.openMailbox(ctx, tenantID, userID); err != nil {
		return nil, err
	}
	secret, err := randomSecret(appPasswordRunes)
	if err != nil {
		return nil, err
	}
	hash, err := s.opts.HashPwd(secret)
	if err != nil {
		return nil, err
	}
	p, err := s.repo.CreateAppPassword(ctx, mailrepo.AppPassword{
		TenantID: tenantID, UserID: userID, Name: name, Hash: hash,
	})
	if err != nil {
		return nil, err
	}
	return &AppPasswordPlain{
		AppPwdView: AppPwdView{ID: p.ID, Name: p.Name, CreatedAt: p.CreatedAt},
		Secret:     secret,
	}, nil
}

// ListAppPasswords GET /mail/app-passwords（有效集）
func (s *Service) ListAppPasswords(ctx context.Context, tenantID, userID int64) ([]AppPwdView, error) {
	list, err := s.repo.ListAppPasswords(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	out := []AppPwdView{}
	for _, p := range list {
		out = append(out, AppPwdView{ID: p.ID, Name: p.Name, CreatedAt: p.CreatedAt})
	}
	return out, nil
}

// RevokeAppPassword DELETE /mail/app-passwords/{id}（即时生效——路径②在线校验阶段二）
func (s *Service) RevokeAppPassword(ctx context.Context, tenantID, userID, pwdID int64) error {
	if err := s.repo.RevokeAppPassword(ctx, tenantID, pwdID, userID); err != nil {
		return errx.New(errx.CodeMailAppPwdInvalid, "应用专用密码不存在或已吊销")
	}
	return nil
}

// VerifyAppPassword 路径② auth-bridge 校验入口（阶段二接线；阶段一供测试钉语义：
// 地址→owner→有效密码集逐个 PBKDF2 校验）
func (s *Service) VerifyAppPassword(ctx context.Context, tenantID int64, address, secret string) bool {
	if s.opts.VerifyPwd == nil {
		return false
	}
	mb, err := s.repo.GetMailboxByAddress(ctx, tenantID, address)
	if err != nil || mb.OwnerUserID == 0 {
		return false
	}
	list, err := s.repo.ListAppPasswords(ctx, tenantID, mb.OwnerUserID)
	if err != nil {
		return false
	}
	for _, p := range list {
		if s.opts.VerifyPwd(p.Hash, secret) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 发送（检查链 + 进程内直投，22 §4.3）
// ---------------------------------------------------------------------------

// SendReq POST /mail/messages
type SendReq struct {
	To          []string              `json:"to"`
	Cc          []string              `json:"cc"`
	Bcc         []string              `json:"bcc"`
	Subject     string                `json:"subject"`
	Body        string                `json:"body"`
	Attachments []mailrepo.Attachment `json:"attachments"`
	InReplyTo   string                `json:"in_reply_to"`
}

// Delivery 投递结果（undelivered 带原因码）
type Delivery struct {
	Address string `json:"address"`
	OK      bool   `json:"ok"`
	Reason  int    `json:"reason,omitempty"` // undelivered 原因（错误码值）
}

// SendResp 发送响应
type SendResp struct {
	MessageID   string     `json:"message_id"`
	Delivered   []string   `json:"delivered"`
	Undelivered []Delivery `json:"undelivered"`
}

// SendMessage 发送：检查链（9032→9035→9034→9031→9024→9027）→ 内存栈直投
// （sent + 各收件 inbox）→ mail.new 推送收件人。
func (s *Service) SendMessage(ctx context.Context, tenantID, userID int64, req SendReq) (*SendResp, error) {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	return s.internalSend(ctx, tenantID, userID, mb.Address, req)
}

// internalSend 发送共核（检查链以发起者本人身份执行；fromAddr 可覆写=
// 共享邮箱代发，22 §3.4）
func (s *Service) internalSend(ctx context.Context, tenantID, userID int64, fromAddr string, req SendReq) (*SendResp, error) {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	recipients := concat(req.To, req.Cc, req.Bcc)
	if len(recipients) == 0 {
		return nil, errx.New(errx.CodeMailRecipientInvalid, "收件人为空")
	}
	// ① 地址格式（9032）
	for _, addr := range recipients {
		if !validAddress(addr) {
			return nil, errx.New(errx.CodeMailRecipientInvalid, "收件人地址非法："+addr)
		}
	}
	// ② 内网模式外域拦截（9035；对外模式+DNS 检测阶段二）
	domain, err := s.ensureDomain(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if domain.Mode == 1 {
		for _, addr := range recipients {
			if !strings.HasSuffix(strings.ToLower(addr), "@"+strings.ToLower(domain.Domain)) {
				return nil, errx.New(errx.CodeMailDNSNotReady,
					"内网模式仅支持本域收件（对外收发未开通）："+addr)
			}
		}
	}
	// ③ 敏感词（9034；04 篇库复用，拦截模式）
	if hit := sensitiveHit(s.opts.SensitiveWords, req.Subject, req.Body); hit != "" {
		return nil, errx.New(errx.CodeMailPolicyDenied, "外发内容命中敏感词（拦截）")
	}
	// ④ 频率限制（9031；滑动分钟窗）
	if !s.allowRate(userID) {
		return nil, errx.New(errx.CodeMailSendLimited, "发送频率受限，请稍后再试")
	}
	// ⑤ 附件（9024：数量+总量）
	var attachBytes int64
	if len(req.Attachments) > DefaultMaxAttachCnt {
		return nil, errx.New(errx.CodeMailAttachmentLimit, "附件数量超限")
	}
	for _, a := range req.Attachments {
		if a.Size < 0 {
			return nil, errx.New(errx.CodeMailAttachmentLimit, "附件大小非法")
		}
		attachBytes += a.Size
	}
	if attachBytes > DefaultMaxAttach {
		return nil, errx.New(errx.CodeMailAttachmentLimit, "附件总量超过 25MB")
	}
	// ⑥ 配额（9027：正文+附件计入 used）
	size := int64(len(req.Body)) + attachBytes
	if mb.UsedBytes+size > mb.QuotaBytes {
		return nil, errx.New(errx.CodeMailQuotaFull, "邮箱配额已满")
	}

	// 投递（内存栈直投）：message_id 幂等键 per mailbox
	msgIDText := newMessageID(s.opts.Now())
	snippet := truncateRunes(req.Body, snippetRunes)
	resp := &SendResp{MessageID: msgIDText, Delivered: []string{}, Undelivered: []Delivery{}}

	sentFolder, err := s.folderID(ctx, mb.ID, "sent")
	if err != nil {
		return nil, errx.New(errx.CodeMailFolderError, "发件箱不可用")
	}
	if _, err := s.repo.InsertMessage(ctx, mailrepo.Message{
		TenantID: tenantID, MailboxID: mb.ID, FolderID: sentFolder,
		MessageID: msgIDText, InReplyTo: req.InReplyTo,
		FromAddr: fromAddr, ToAddrs: req.To, CcAddrs: req.Cc, BccAddrs: req.Bcc,
		Subject: req.Subject, Snippet: snippet, Body: req.Body,
		HasAttachment: len(req.Attachments) > 0, Attachments: req.Attachments,
		Flags: mailrepo.FlagSeen, Size: size, ReceivedAt: s.opts.Now(),
	}); err != nil {
		return nil, errx.New(errx.CodeMailSendFailed, "投递失败（发件箱写入）")
	}
	_ = s.repo.AddUsage(ctx, tenantID, mb.ID, size)

	delivered := map[string]bool{} // 地址去重（To+Cc+Bcc 重复投递收敛）
	for _, addr := range recipients {
		key := strings.ToLower(addr)
		if delivered[key] {
			continue
		}
		delivered[key] = true
		dst, derr := s.repo.GetMailboxByAddress(ctx, tenantID, addr)
		if derr != nil {
			resp.Undelivered = append(resp.Undelivered, Delivery{Address: addr, OK: false, Reason: 9021})
			continue
		}
		if dst.Status != 1 {
			resp.Undelivered = append(resp.Undelivered, Delivery{Address: addr, OK: false, Reason: 9021})
			continue
		}
		inbox, ferr := s.folderID(ctx, dst.ID, "inbox")
		if ferr != nil {
			resp.Undelivered = append(resp.Undelivered, Delivery{Address: addr, OK: false, Reason: 9028})
			continue
		}
		if _, ierr := s.repo.InsertMessage(ctx, mailrepo.Message{
			TenantID: tenantID, MailboxID: dst.ID, FolderID: inbox,
			MessageID: msgIDText, InReplyTo: req.InReplyTo,
			FromAddr: fromAddr, ToAddrs: req.To, CcAddrs: req.Cc,
			Subject: req.Subject, Snippet: snippet, Body: req.Body,
			HasAttachment: len(req.Attachments) > 0, Attachments: req.Attachments,
			Flags: 0, Size: size, ReceivedAt: s.opts.Now(),
		}); ierr != nil {
			if ierr == mailrepo.ErrDuplicateMessageID {
				continue // 幂等重试静默
			}
			resp.Undelivered = append(resp.Undelivered, Delivery{Address: addr, OK: false, Reason: 9023})
			continue
		}
		_ = s.repo.AddUsage(ctx, tenantID, dst.ID, size)
		resp.Delivered = append(resp.Delivered, addr)
		// 自动转发（D16/22 §3.6）：收件人 settings.auto_forward 非空 → 副本投递
		// 到转发地址邮箱。防环：InReplyTo 携 auto-fwd 标记的链路封顶一层；
		// 转发地址即本人/不可投邮箱 → 静默跳过（转发是增益不阻断主投递）
		if fwd := dst.Settings.AutoForward; fwd != "" && req.InReplyTo != autoFwdMarker {
			if fwdMB, ferr := s.repo.GetMailboxByAddress(ctx, tenantID, fwd); ferr == nil &&
				fwdMB.Status == 1 && fwdMB.ID != dst.ID {
				if fwdInbox, fiErr := s.folderID(ctx, fwdMB.ID, "inbox"); fiErr == nil {
					_, _ = s.repo.InsertMessage(ctx, mailrepo.Message{
						TenantID: tenantID, MailboxID: fwdMB.ID, FolderID: fwdInbox,
						MessageID: newMessageID(s.opts.Now()), InReplyTo: autoFwdMarker,
						FromAddr: fromAddr, ToAddrs: []string{fwd},
						Subject: "Fwd: " + req.Subject, Snippet: snippet, Body: req.Body,
						HasAttachment: len(req.Attachments) > 0, Attachments: req.Attachments,
						Flags: 0, Size: size, ReceivedAt: s.opts.Now(),
					})
				}
			}
		}
		// mail.new（kind=new：角标数据源；IM 横幅提醒随规则引擎阶段二）
		if s.opts.PushMail != nil {
			s.opts.PushMail(dst.OwnerUserID, map[string]any{
				"kind": "new", "folder": "inbox",
				"from": mb.Address, "subject": truncateRunes(req.Subject, 80),
				"has_attachment": len(req.Attachments) > 0,
			})
		}
	}
	return resp, nil
}

// ---------------------------------------------------------------------------
// 管理端（PAD-16 最小集：域列表/邮箱治理；别名与 DNS 检测阶段二）
// ---------------------------------------------------------------------------

// AdminDomains GET /admin/mail/domains
func (s *Service) AdminDomains(ctx context.Context, tenantID int64) ([]mailrepo.Domain, error) {
	if _, err := s.ensureDomain(ctx, tenantID); err != nil {
		return nil, err
	}
	return s.repo.ListDomains(ctx, tenantID)
}

// AdminMailboxes GET /admin/mail/mailboxes（status 0=全部）
func (s *Service) AdminMailboxes(ctx context.Context, tenantID int64, status int) ([]mailrepo.Mailbox, error) {
	return s.repo.ListMailboxes(ctx, tenantID, status)
}

// AdminOpenMailbox POST /admin/mail/mailboxes（手工开户=懒开户同路径）
func (s *Service) AdminOpenMailbox(ctx context.Context, tenantID, userID int64) (*mailrepo.Mailbox, error) {
	return s.mustActiveMailbox(ctx, tenantID, userID) // 已有 active 邮箱幂等返回
}

// AdminSuspendMailbox POST /admin/mail/mailboxes/{id}/suspend（拒收拒发）
func (s *Service) AdminSuspendMailbox(ctx context.Context, tenantID, mailboxID int64) error {
	return s.repo.UpdateMailboxStatus(ctx, tenantID, mailboxID, 2)
}

// AdminResumeMailbox POST /admin/mail/mailboxes/{id}/resume
func (s *Service) AdminResumeMailbox(ctx context.Context, tenantID, mailboxID int64) error {
	return s.repo.UpdateMailboxStatus(ctx, tenantID, mailboxID, 1)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

func (s *Service) folderID(ctx context.Context, mailboxID int64, name string) (int64, error) {
	folders, err := s.repo.ListFolders(ctx, mailboxID)
	if err != nil {
		return 0, err
	}
	for _, f := range folders {
		if f.Name == name {
			return f.ID, nil
		}
	}
	return 0, fmt.Errorf("folder %s not found", name)
}

// allowRate 滑动分钟窗（per user；窗口内计数 > 上限 → false）
func (s *Service) allowRate(uid int64) bool {
	now := s.opts.Now()
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	win := s.rate[uid][:0]
	for _, t := range s.rate[uid] {
		if now.Sub(t) < time.Minute {
			win = append(win, t)
		}
	}
	if len(win) >= DefaultRatePerMin {
		s.rate[uid] = win
		return false
	}
	s.rate[uid] = append(win, now)
	return true
}

// sensitiveHit 命中词（subject+body 拼接）
func sensitiveHit(words func() []string, subject, body string) string {
	if words == nil {
		return ""
	}
	hay := subject + "\n" + body
	for _, w := range words() {
		if w != "" && strings.Contains(hay, w) {
			return w
		}
	}
	return ""
}

func validAddress(addr string) bool {
	local, domain, ok := strings.Cut(addr, "@")
	if !ok || local == "" || domain == "" {
		return false
	}
	if strings.ContainsAny(addr, " \t\r\n<>,:") {
		return false
	}
	if !strings.Contains(domain, ".") && !strings.HasSuffix(domain, "internal") {
		// 内网短域（corp.internal 类）已含点；无点域仅放行显式 internal 后缀
		return strings.ToLower(domain) == "internal"
	}
	return true
}

// validAddress 简化 RFC 校验：local@domain，各段非空且无空白/非法字符

func newMessageID(now time.Time) string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return fmt.Sprintf("<%d.%s@bbw.mail>", now.UnixNano(), hex.EncodeToString(buf))
}

func randomSecret(n int) (string, error) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i, b := range buf {
		buf[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(buf), nil
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func concat(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}

// ---------------------------------------------------------------------------
// 共享邮箱（22 §3.4/§6.4：resource_acl mail 资源——ACL 链路收官消费方）
// ---------------------------------------------------------------------------

// SharedMailboxView 用户可见共享邮箱视图
type SharedMailboxView struct {
	ID      int64  `json:"id,string"`
	Address string `json:"address"`
	Unread  int    `json:"unread"`
	IsOwner bool   `json:"is_owner"` // owner 可代发（22 §3.4）
}

// AdminCreateSharedMailbox 建共享邮箱（PAD-16；type=2，治理部门挂靠，
// 资源键=address → resource_acl 授权经管理端 /admin/acl 下发）
func (s *Service) AdminCreateSharedMailbox(ctx context.Context, tenantID int64, localPart string, governDeptID int64) (*mailrepo.Mailbox, error) {
	localPart = strings.TrimSpace(localPart)
	if localPart == "" || strings.ContainsAny(localPart, "@ \t") {
		return nil, errx.New(errx.CodeBadRequest, "local_part 非法（无 @ 无空白）")
	}
	domain, err := s.ensureDomain(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	address := localPart + "@" + domain.Domain
	if _, err := s.repo.GetMailboxByAddress(ctx, tenantID, address); err == nil {
		return nil, errx.New(errx.CodeBadRequest, "地址已存在")
	}
	created, err := s.repo.CreateMailbox(ctx, mailrepo.Mailbox{
		TenantID: tenantID, DomainID: domain.ID, Address: address,
		Type: 2, GovernDeptID: governDeptID,
		QuotaBytes: DefaultQuotaBytes, Status: 1,
	})
	if err != nil {
		return nil, err
	}
	return &created, nil
}

// aclPermOf 资源权限（0=无；ACLPerm 闭包缺省=全员无授权——共享邮箱纯
// ACL 驱动，无基线回落，fail-closed）
func (s *Service) aclPermOf(ctx context.Context, address string, userID int64) int {
	if s.opts.ACLPerm == nil {
		return 0
	}
	return s.opts.ACLPerm(ctx, "mail.shared", address, userID)
}

// SharedMailboxes 用户可见共享邮箱（ACL ≥viewer；owner 标记=4）
func (s *Service) SharedMailboxes(ctx context.Context, tenantID, userID int64) ([]SharedMailboxView, error) {
	boxes, err := s.repo.ListMailboxes(ctx, tenantID, 0) // 全状态再自滤 type=2
	if err != nil {
		return nil, err
	}
	out := []SharedMailboxView{}
	for _, mb := range boxes {
		if mb.Type != 2 || mb.Status != 1 {
			continue
		}
		perm := s.aclPermOf(ctx, mb.Address, userID)
		if perm < 1 {
			continue
		}
		view := SharedMailboxView{ID: mb.ID, Address: mb.Address, IsOwner: perm == 4}
		if folders, ferr := s.repo.ListFolders(ctx, mb.ID); ferr == nil {
			for _, f := range folders {
				if f.Name == "inbox" {
					view.Unread = f.UnreadCount
				}
			}
		}
		out = append(out, view)
	}
	return out, nil
}

// sharedMailboxFor 共享邮箱访问校验（≥viewer；5021 语义）
func (s *Service) sharedMailboxFor(ctx context.Context, tenantID, userID, mailboxID int64, minPerm int) (*mailrepo.Mailbox, error) {
	mb, err := s.repo.GetMailboxByID(ctx, tenantID, mailboxID)
	if err != nil || mb.Type != 2 {
		return nil, errx.New(errx.CodeMailboxDisabled, "共享邮箱不存在")
	}
	if s.aclPermOf(ctx, mb.Address, userID) < minPerm {
		return nil, errx.New(errx.CodePermACLDenied, "无共享邮箱权限")
	}
	return mb, nil
}

// ListSharedMessages 共享邮箱列表（viewer+）
func (s *Service) ListSharedMessages(ctx context.Context, tenantID, userID, mailboxID int64,
	folder string, cursor int64, limit int, filter string) ([]mailrepo.Message, error) {
	mb, err := s.sharedMailboxFor(ctx, tenantID, userID, mailboxID, 1)
	if err != nil {
		return nil, err
	}
	if folder == "" {
		folder = "inbox"
	}
	folderID, ferr := s.folderID(ctx, mb.ID, folder)
	if ferr != nil {
		return nil, errx.New(errx.CodeMailFolderError, "文件夹不存在")
	}
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if limit > MaxListLimit {
		limit = MaxListLimit
	}
	return s.repo.ListMessages(ctx, mb.ID, folderID, cursor, limit, filter)
}

// SendAsShared 代发（owner；22 §3.4：From=共享地址，头域代发人标注——
// 外显"XX 代部门邮箱发送"，渲染在客户端，登记）：检查链同权（§7 人与
// Agent 不放宽）。
func (s *Service) SendAsShared(ctx context.Context, tenantID, userID, mailboxID int64, req SendReq) (*SendResp, error) {
	mb, err := s.sharedMailboxFor(ctx, tenantID, userID, mailboxID, 4) // owner
	if err != nil {
		return nil, err
	}
	if _, aerr := s.mustActiveMailbox(ctx, tenantID, userID); aerr != nil {
		return nil, aerr // 发起者本人邮箱须活跃（sent 副本归本人）
	}
	return s.internalSend(ctx, tenantID, userID, mb.Address, req)
}

// autoFwdMarker 自动转发链路标记（InReplyTo 携带=已转发一层，封顶防环；D16）
const autoFwdMarker = "bbw-auto-fwd"

// ── 草稿（D16/22 §3.5：drafts folder 存续写；发送时清理）──

// SaveDraft 存草稿（draftID>0=更新：旧行移 trash 再插新行；返回新草稿 ID）
func (s *Service) SaveDraft(ctx context.Context, tenantID, userID int64, req SendReq, draftID int64) (int64, error) {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return 0, err
	}
	drafts, err := s.folderID(ctx, mb.ID, "drafts")
	if err != nil {
		return 0, errx.New(errx.CodeMailFolderError, "草稿箱不可用")
	}
	if draftID > 0 {
		// 更新语义：旧行入垃圾箱（保留历史可追溯；物理清理随阶段二）
		_ = s.repo.MoveMessage(ctx, tenantID, draftID, func() int64 {
			if trash, terr := s.folderID(ctx, mb.ID, "trash"); terr == nil {
				return trash
			}
			return drafts
		}())
	}
	attachBytes := int64(0)
	for _, a := range req.Attachments {
		attachBytes += a.Size
	}
	msg, err := s.repo.InsertMessage(ctx, mailrepo.Message{
		TenantID: tenantID, MailboxID: mb.ID, FolderID: drafts,
		MessageID: newMessageID(s.opts.Now()),
		FromAddr: mb.Address, ToAddrs: req.To, CcAddrs: req.Cc,
		Subject: req.Subject, Snippet: truncateRunes(req.Body, snippetRunes), Body: req.Body,
		HasAttachment: len(req.Attachments) > 0, Attachments: req.Attachments,
		Flags: mailrepo.FlagDraft, Size: int64(len(req.Body)) + attachBytes, ReceivedAt: s.opts.Now(),
	})
	if err != nil {
		return 0, errx.New(errx.CodeMailSendFailed, "草稿保存失败")
	}
	return msg.ID, nil
}

// DiscardDraft 发送成功后清理草稿（旧行移 trash；不存在静默——草稿可能已另存新版）
func (s *Service) DiscardDraft(ctx context.Context, tenantID, userID, draftID int64) error {
	mb, err := s.mustActiveMailbox(ctx, tenantID, userID)
	if err != nil {
		return err
	}
	trash, err := s.folderID(ctx, mb.ID, "trash")
	if err != nil {
		return errx.New(errx.CodeMailFolderError, "垃圾箱不可用")
	}
	return s.repo.MoveMessage(ctx, tenantID, draftID, trash)
}
