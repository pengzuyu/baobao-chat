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
