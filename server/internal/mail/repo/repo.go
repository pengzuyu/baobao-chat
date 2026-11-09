// 仓储接口（memory/postgres 双模装配，D02 §7）。
package mailrepo

import (
	"context"
	"errors"
	"time"
)

// 哨兵错误（service 翻译为错误码）
var (
	ErrNotFound = errors.New("mail: not found")
	// ErrDuplicateMessageID message_id 幂等命中（重投递静默吞并）
	ErrDuplicateMessageID = errors.New("mail: duplicate message_id")
)

// 消息 flags 位标志（22 §5 mail_message.flags）
const (
	FlagSeen    int16 = 1 << 0 // seen
	FlagFlagged int16 = 1 << 1 // 星标
	FlagDraft  int16 = 1 << 2 // 草稿（D16：drafts folder 行标记）
)

// 系统文件夹（开户即 seed；22 §5 mail_folder_meta.type）
var SystemFolders = []string{"inbox", "sent", "drafts", "trash", "junk", "archive"}

// Domain 邮件域（22 §5 mail_domain；DNS 检测阶段二，dns_status 恒空）
type Domain struct {
	ID        int64
	TenantID  int64
	Domain    string
	Mode      int // 1 内网 2 对外（阶段一仅内网语义生效）
	IsDefault bool
	CreatedAt time.Time
}

// Attachment 附件引用（07 篇 file_id；file 域回链校验随阶段二）
type Attachment struct {
	FileID int64  `json:"file_id,string"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
}

// Settings 用户邮箱设置（mailbox.settings JSONB；签名/自动转发/远程图片）
type Settings struct {
	Signature    string `json:"signature"`     // 签名（多身份随共享邮箱阶段二）
	AutoForward  string `json:"auto_forward"`  // 自动转发地址（空=关；执行随阶段二）
	KeepCopy     bool   `json:"keep_copy"`     // 转发保留副本
	RemoteImages bool   `json:"remote_images"` // 远程图片自动加载（默认 false，22 §7）
}

// Mailbox 邮箱（22 §5 mailbox；shared/代发随 resource_acl 阶段二）
type Mailbox struct {
	ID           int64     `json:"id,string"`
	TenantID     int64     `json:"tenant_id"`
	DomainID     int64     `json:"domain_id"`
	Address      string    `json:"address"`
	Type         int       `json:"type"` // 1 personal 2 shared
	OwnerUserID  int64     `json:"owner_user_id,string,omitempty"`
	GovernDeptID int64     `json:"govern_dept_id,string,omitempty"` // shared 治理部门
	QuotaBytes   int64     `json:"quota_bytes"`
	UsedBytes    int64     `json:"used_bytes"`
	Status       int       `json:"status"`
	Settings     Settings  `json:"settings"`
	CreatedAt    time.Time `json:"created_at"`
	SuspendedAt  time.Time `json:"suspended_at,omitempty"` // 零值省略
}

// Folder 文件夹元数据（未读计数查询源；同步游标阶段二）
type Folder struct {
	ID          int64  `json:"id,string"`
	TenantID    int64  `json:"tenant_id"`
	MailboxID   int64  `json:"mailbox_id,string"`
	Name        string `json:"name"`
	TotalCount  int    `json:"total_count"`
	UnreadCount int    `json:"unread_count"`
}

// Message 邮件（22 §5 mail_message；阶段一正文直存 body）
type Message struct {
	ID            int64        `json:"id,string"`
	TenantID      int64        `json:"tenant_id"`
	MailboxID     int64        `json:"mailbox_id,string"`
	FolderID      int64        `json:"folder_id,string"`
	MessageID     string       `json:"message_id"` // RFC822
	InReplyTo     string       `json:"in_reply_to,omitempty"`
	FromAddr      string       `json:"from_addr"`
	ToAddrs       []string     `json:"to_addrs"`
	CcAddrs       []string     `json:"cc_addrs"`
	BccAddrs      []string     `json:"bcc_addrs"`
	Subject       string       `json:"subject"`
	Snippet       string       `json:"snippet"`
	Body          string       `json:"body,omitempty"` // 详情返回
	HasAttachment bool         `json:"has_attachment"`
	Attachments   []Attachment `json:"attachments"`
	Flags         int16        `json:"flags"` // bit0 seen bit1 flagged
	Size          int64        `json:"size"`
	ReceivedAt    time.Time    `json:"received_at"`
}

// AppPassword 应用专用密码（22 §5；仅存 hash，吊销即时生效）
type AppPassword struct {
	ID         int64     `json:"id,string"`
	TenantID   int64     `json:"tenant_id"`
	UserID     int64     `json:"user_id,string"`
	Name       string    `json:"name"`
	Hash       string    `json:"-"` // 绝不下发
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at,omitempty"`
	RevokedAt  time.Time `json:"revoked_at,omitempty"`
}

// 列表过滤（GET /mail/messages 过滤器）
const (
	FilterAll     = "" // 全部
	FilterUnread  = "unread"
	FilterStarred = "starred"
	FilterAttach  = "attach"
)

// Repo 邮件域仓储
type Repo interface {
	// 域
	// EnsureDefaultDomain seed 默认内网域（幂等；启动/首次访问调用）
	EnsureDefaultDomain(ctx context.Context, tenantID int64, domain string) (Domain, error)
	ListDomains(ctx context.Context, tenantID int64) ([]Domain, error)

	// 邮箱
	GetMailboxByOwner(ctx context.Context, tenantID, userID int64) (*Mailbox, error)
	// GetMailboxByAddress 投递寻址（含停用态——service 判 9021）
	GetMailboxByAddress(ctx context.Context, tenantID int64, address string) (*Mailbox, error)
	// GetMailboxByID 主键查（共享邮箱访问校验）
	GetMailboxByID(ctx context.Context, tenantID, id int64) (*Mailbox, error)
	// CreateMailbox 开户（事务内 seed 六系统文件夹）
	CreateMailbox(ctx context.Context, mb Mailbox) (Mailbox, error)
	ListMailboxes(ctx context.Context, tenantID int64, status int) ([]Mailbox, error) // status 0=全部
	UpdateMailboxStatus(ctx context.Context, tenantID, mailboxID int64, status int) error
	// AddUsage used_bytes 累计（配额记账）
	AddUsage(ctx context.Context, tenantID, mailboxID, delta int64) error
	UpdateSettings(ctx context.Context, tenantID, mailboxID int64, s Settings) error

	// 文件夹
	ListFolders(ctx context.Context, mailboxID int64) ([]Folder, error)

	// 消息
	// InsertMessage 幂等（message_id UK per mailbox；重投递返回 ErrDuplicateMessageID）
	InsertMessage(ctx context.Context, m Message) (Message, error)
	GetMessage(ctx context.Context, tenantID, msgID int64) (*Message, error)
	// ListMessages folder 0=全部；cursor=0 起始（received_at DESC，id DESC tiebreak）
	ListMessages(ctx context.Context, mailboxID, folderID, cursor int64, limit int, filter string) ([]Message, error)
	// UpdateFlags 置/清位（mask 命中位，val 目标值；folder 未读计数同步）
	UpdateFlags(ctx context.Context, tenantID, msgID int64, mask, val int16) error
	// MoveMessage 移动文件夹（folder 计数两侧同步；目标文件夹校验归属由 service）
	MoveMessage(ctx context.Context, tenantID, msgID, folderID int64) error
	// SearchMessages ILIKE 降级（zhparser 阶段二）；mailboxIDs=ACL 前置过滤集
	SearchMessages(ctx context.Context, tenantID int64, mailboxIDs []int64, q string, attachOnly bool, limit int) ([]Message, error)

	// 应用专用密码
	CreateAppPassword(ctx context.Context, p AppPassword) (AppPassword, error)
	ListAppPasswords(ctx context.Context, tenantID, userID int64) ([]AppPassword, error)
	RevokeAppPassword(ctx context.Context, tenantID, id, userID int64) error
}
