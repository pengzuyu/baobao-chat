// Package messagerepo 消息域数据访问接口（内存实现先行；唯一允许写 SQL 的层——D02 §3）。
package messagerepo

import (
	"context"
	"errors"
	"time"

	"github.com/baobaowork/server/internal/message/api"
)

// ErrDuplicateClientMsgID UK(conv_id, client_msg_id) 冲突（幂等兜底）
var ErrDuplicateClientMsgID = errors.New("messagerepo: duplicate client_msg_id")

// Conversation 会话主表冗余字段（04 篇 §5.1）
type Conversation struct {
	ID          int64
	TenantID    int64
	Type        int // 1 单聊 2 群聊 3 广播群
	Name        string
	OwnerID     int64
	LatestSeq   int64
	MemberCount int
	Status      int // 1 active 2 dissolved
	LastMsgTS   int64
}

// Member 会话成员（04 篇 §5.1）
type Member struct {
	ConvID    int64
	UserID    int64
	Role      int // 1 owner 2 admin 3 member 4 publisher
	Status    int // 1 在群 2 已退 3 被移出
	MuteUntil time.Time
	JoinAt    time.Time
}

// Receipt 回执游标（O(成员数) 聚合，04 篇 §5.1 message_receipt）
type Receipt struct {
	ConvID       int64
	UserID       int64
	DeliveredSeq int64
	ReadSeq      int64
}

// Repo 消息域仓储接口
type Repo interface {
	CreateConversation(ctx context.Context, c Conversation) (Conversation, error)
	DissolveConversation(ctx context.Context, convID int64) error
	GetConversation(ctx context.Context, convID int64) (*Conversation, error)
	AddMember(ctx context.Context, m Member) error

	// AllocSeq 会话内 seq 单调分配（生产 Redis INCR + 启动时对齐 max(seq)+1，04 篇 §4.1）
	AllocSeq(ctx context.Context, convID int64) (int64, error)
	// InsertMessage 落库；client_msg_id 冲突返回 ErrDuplicateClientMsgID
	InsertMessage(ctx context.Context, m messageapi.Message) error
	// FindByClientMsgID 幂等查询：命中返回已落库消息
	FindByClientMsgID(ctx context.Context, convID int64, clientMsgID string) (*messageapi.Message, error)
	// GetMessageByID 按消息 ID 查（编辑/撤回/回应入口；不存在返回 ErrNotFound）
	GetMessageByID(ctx context.Context, msgID int64) (*messageapi.Message, error)
	// GetMessageBySeq 按会话内 seq 查（引用快照 reply_digest 构建，D03 §5.2）
	GetMessageBySeq(ctx context.Context, convID, seq int64) (*messageapi.Message, error)
	// UpdateMessage 全量行更新（body/status/ext/edited_at/edit_version；乐观并发不做——
	// 编辑窗口 5min 内同一消息并发编辑由 service 层窗口校验兜底）
	UpdateMessage(ctx context.Context, m messageapi.Message) error
	ListMessages(ctx context.Context, convID, after, before int64, limit int) ([]messageapi.Message, error)
	// ListMessagesLatest 最新 N 条（order=-seq 语义：倒序取 N 再升序返回，D03 API-IM-04）
	ListMessagesLatest(ctx context.Context, convID int64, limit int) ([]messageapi.Message, error)
	// MemberOf 成员查询（含角色/禁言/状态）
	MemberOf(ctx context.Context, convID, userID int64) (*Member, error)
	MembersOf(ctx context.Context, convID int64) ([]int64, error)
	// ListUserConversations 用户的会话列表（按成员身份，含已解散；排序由调用方定）
	ListUserConversations(ctx context.Context, userID int64) ([]Conversation, error)
	// LastMessage 会话最后一条消息（摘要生成用；空会话返回 nil,nil）
	LastMessage(ctx context.Context, convID int64) (*messageapi.Message, error)
	// TouchConversation 发送后冗余更新（latest_seq/last_msg_ts/member_count，04 篇 §4.1 ⑥）
	TouchConversation(ctx context.Context, convID int64, seq, ts int64) error

	GetReceipt(ctx context.Context, convID, userID int64) (Receipt, error)
	// SetReadSeq 已读游标（调用方保证只进不退）
	SetReadSeq(ctx context.Context, convID, userID, readSeq int64) error

	// UserConvState 用户会话态（置顶/免打扰/草稿，04 篇 §5.1；游标在 Receipt）
	UserConvState(ctx context.Context, userID, convID int64) (UserConvState, error)
	// SetUserConvState upsert（按字段覆盖由 service 层合并后全量写）
	SetUserConvState(ctx context.Context, userID, convID int64, s UserConvState) error

	// ── 群管理（D03 §3.5/§3.6/§4.1 INT-IM-15~19；§6.1 表）──

	// UpdateMemberRole 角色变更（转让/设管/取消；status 非 0 时一并覆盖；行不存在返回 ErrNotFound）
	UpdateMemberRole(ctx context.Context, convID, userID int64, role, status int) error
	// RemoveMember 移出（status=3；原在群才递减 member_count——S2 状态机）
	RemoveMember(ctx context.Context, convID, userID int64) error
	// QuitMember 退群（status=2）
	QuitMember(ctx context.Context, convID, userID int64) error
	// MuteMember 单人禁言（until 零值=解除，≤30 天/次由 service 校验）
	MuteMember(ctx context.Context, convID, userID int64, until time.Time) error
	// UpdateConversationMeta 群名/群主变更（转让；name 空串/ownerID 0 表示该字段不变）
	UpdateConversationMeta(ctx context.Context, convID int64, name string, ownerID int64) error
	// FindSingleConv 单聊去重：同为活跃成员的单聊复用（INT-IM-15；无匹配返回 nil）
	FindSingleConv(ctx context.Context, userA, userB int64) (*Conversation, error)
	// ListMembersDetailed 成员行明细（含 role/mute_until/status/join_at，全状态；供 API-IM-05）
	ListMembersDetailed(ctx context.Context, convID int64) ([]Member, error)

	// GetGroupSetting 群设置（无记录返回默认值；群/广播群才有行）
	GetGroupSetting(ctx context.Context, convID int64) (GroupSetting, error)
	// UpsertGroupSetting 整行覆盖（service 合并默认值后写）
	UpsertGroupSetting(ctx context.Context, s GroupSetting) error

	// CreateApply 入群申请（ID=0 时分配；uk_apply_pending 冲突由 service 前置查重规避）
	CreateApply(ctx context.Context, a Apply) (Apply, error)
	// GetApplyByID 查申请（不存在返回 ErrNotFound）
	GetApplyByID(ctx context.Context, id int64) (*Apply, error)
	// UpdateApplyStatus 申请状态机流转（approve→2/reject→3/过期→4；合法迁移由 service 保证）
	UpdateApplyStatus(ctx context.Context, id int64, status int, handledBy int64, handledAt time.Time) error
	// ListAppliesByConv 按状态列申请（status=0 表示全部）
	ListAppliesByConv(ctx context.Context, convID int64, status int) ([]Apply, error)

	// ── 搜索（D03 §3.7 PIM-07 服务端态；API-IM-12）──

	// SearchMessages 服务端态搜索：仅命中发起者可见的会话（在群成员），
	// 过滤器 AND 组合（keyword/from_uid/conv_id/type/from_ts/to_ts），
	// 按 msg_id 倒序分页（cursor=上一页最后一条 msg_id，0=首页）。
	// 实现：PG=ILIKE（zhparser 全文索引阶段二）；内存=遍历+子串匹配（大小写不敏感，对齐 ILIKE）
	SearchMessages(ctx context.Context, f SearchFilter) ([]messageapi.Message, error)

	// ── 收藏（D03 §3.8 PIM-08；§6.1 message_favorite）──
	FavoriteStore

	// ── 通知（D03 §3.9 PIM-09 通知中心；§6.1 user_notification，迁移 0007）──
	NotificationStore
}

// FavoriteStore 收藏存储（UK(user_id,msg_id) 幂等；上限 1000 由 service 应用层校验→3022）。
// 快照仅存 msg_id+conv_id——详情实时取（撤回消息可收藏，列表渲染占位语义）。
type FavoriteStore interface {
	// AddFavorite 收藏（已收藏幂等：created=false 并返回现值）
	AddFavorite(ctx context.Context, userID, msgID, convID int64) (f Favorite, created bool, err error)
	// RemoveFavorite 取消收藏（不存在 no-op，幂等）
	RemoveFavorite(ctx context.Context, userID, msgID int64) error
	// ListFavorites 收藏列表（created_at 倒序；msgType 空串=全部，按消息 type 过滤；
	// cursor=上一页最后一条收藏 id，0=首页；limit≤0 或 >100 取 20）
	ListFavorites(ctx context.Context, userID int64, msgType string, cursor int64, limit int) ([]Favorite, error)
	// CountFavorites 收藏总数（上限校验依据）
	CountFavorites(ctx context.Context, userID int64) (int64, error)
	// ExistsFavorite UK(user_id,msg_id) 探测（幂等前置：已收藏不占新额度）
	ExistsFavorite(ctx context.Context, userID, msgID int64) (bool, error)
}

// Favorite 收藏行（04 篇 §5.1 message_favorite）
type Favorite struct {
	ID        int64
	UserID    int64
	MsgID     int64
	ConvID    int64
	CreatedAt time.Time
}

// ── 通知（D03 §3.9 PIM-09；§6.1 user_notification，迁移 0007）──

// Notification 用户通知行（点击路由表依据 kind+conv_id+seq）
type Notification struct {
	ID        int64
	TenantID  int64
	UserID    int64
	Kind      string // mention|reply|apply|agent_done|announcement
	ConvID    int64  // 可空（agent_done 预留场景 0）
	MsgID     int64  // 可空（apply/announcement 关联系统消息，尽力携带）
	Seq       int64  // 可空（mention/reply 定位闪烁依据）
	Title     string
	Digest    string
	Count     int // 同 (user,kind,conv) 10s 窗口合并计数（首条=1，"×N"渲染依据）
	CreatedAt time.Time
	ReadAt    time.Time // 零值=未读
}

// NotificationFilter 列表过滤（分组 tab → kind；红点 unread；cursor=id 倒序翻页）
type NotificationFilter struct {
	UserID     int64
	Kind       string // 空=全部
	UnreadOnly bool
	Cursor     int64 // 上一页最后一条 id；0=首页
	Limit      int   // ≤0 或 >100 取 20
}

// NotificationStore 通知存储。
// 聚合窗口判定在 repo 内完成（InsertMergedNotification）：同 (user_id,kind,conv_id)
// 未读行且 CreatedAt 距其 created_at < window → 原行 count+1、digest 覆盖最新内容；
// 时钟由调用方经 n.CreatedAt 注入（Options.Now 可测）。
// 勿扰/mute 用户照常落库——「勿扰时段只入中心不发系统通知」是客户端投递策略（INT-IM-22），登记。
type NotificationStore interface {
	// InsertNotification 新增通知行（ID=0 时分配）
	InsertNotification(ctx context.Context, n Notification) (Notification, error)
	// InsertMergedNotification 聚合写入：命中窗口内可合并行 → 原行 count+1、digest 覆盖
	// （返回更新后行 + merged=true）；未命中 → 等价 Insert（merged=false）
	InsertMergedNotification(ctx context.Context, n Notification, window time.Duration) (Notification, bool, error)
	// ListNotifications 用户通知列表（id 倒序 + cursor 翻页；kind/unread 过滤）
	ListNotifications(ctx context.Context, f NotificationFilter) ([]Notification, error)
	// MarkNotificationsRead 已读：all=true 全部，否则按 ids（均限本人行；幂等：已读行跳过）
	MarkNotificationsRead(ctx context.Context, userID int64, ids []int64, all bool, readAt time.Time) (int64, error)
	// CountUnreadNotifications 未读计数（红点数据源）
	CountUnreadNotifications(ctx context.Context, userID int64) (int64, error)
}

// SearchFilter 服务端态搜索过滤器（D03 API-IM-12：AND 组合；零值=不限）
type SearchFilter struct {
	UserID  int64  // 发起者（可见性过滤：仅在群成员的会话）
	Keyword string // 已由 service 校验（非空白、≤64 字）
	FromUID int64
	ConvID  int64
	Type    string
	FromTS  int64 // ms 含边界
	ToTS    int64 // ms 含边界
	Cursor  int64 // 上一页最后一条 msg_id；0=首页
	Limit   int   // ≤0 或 >100 取 20
}

// GroupSetting 群设置（04 篇 §5.1 group_setting）
type GroupSetting struct {
	ConvID           int64
	JoinMode         int // 1 直接进 2 需审批 3 仅邀请
	InvitePolicy     int // 1 全员可邀 2 仅管理
	MentionAllPolicy int // 1 全员 2 仅管理 3 禁用
	MuteAllUntil     time.Time
	HistoryVisible   bool
	Announcement     string
	AnnouncementTS   time.Time
}

// 群设置默认值（表列 DEFAULT 对齐，04 篇 §4.5.4）
const (
	JoinModeDirect      = 1
	JoinModeApply       = 2
	JoinModeInviteOnly  = 3
	InvitePolicyAll     = 1
	InvitePolicyAdmin   = 2
	MentionAllPolicyAll = 1
	MentionAllPolicyAdm = 2
	MentionAllPolicyOff = 3
)

// DefaultGroupSetting 默认群设置（join_mode=直接进/invite=all/mention_all=仅管理）
func DefaultGroupSetting(convID int64) GroupSetting {
	return GroupSetting{
		ConvID:           convID,
		JoinMode:         JoinModeDirect,
		InvitePolicy:     InvitePolicyAll,
		MentionAllPolicy: MentionAllPolicyAdm,
		HistoryVisible:   true,
	}
}

// 申请状态（04 篇 §5.1 conversation_apply.status，D03 S2）
const (
	ApplyPending  = 1 // 待审
	ApplyApproved = 2
	ApplyRejected = 3
	ApplyExpired  = 4 // 7 天未处理自动过期
)

// Apply 入群申请（04 篇 §5.1 conversation_apply）
type Apply struct {
	ID        int64
	ConvID    int64
	UserID    int64
	Reason    string
	Status    int // 1 待审 2 通过 3 拒绝 4 过期
	HandledBy int64
	HandledAt time.Time
	CreatedAt time.Time
}

// UserConvState 置顶/免打扰/草稿（多端同步字段集，D03 API-IM-13）
type UserConvState struct {
	Pinned bool
	Mute   bool
	Draft  string // ≤2000 字（3020）
}

// PG 实现占位（阶段二，表见 migrations/0001_init.sql）：
//   type Postgres struct{ pool *pgxpool.Pool }  // 实现 Repo 接口
//   seq 分配改 Redis INCR t:{tid}:conv:{cid}:seq；服务重启以分区 max(seq)+1 对齐（04 篇 §4.1）
//   message 落库走按月分区表；跨域引用（file_id 等）只按 ID 不建外键（D02 §7）
