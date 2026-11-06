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
	ListMessages(ctx context.Context, convID, after, before int64, limit int) ([]messageapi.Message, error)
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
}

// PG 实现占位（阶段二，表见 migrations/0001_init.sql）：
//   type Postgres struct{ pool *pgxpool.Pool }  // 实现 Repo 接口
//   seq 分配改 Redis INCR t:{tid}:conv:{cid}:seq；服务重启以分区 max(seq)+1 对齐（04 篇 §4.1）
//   message 落库走按月分区表；跨域引用（file_id 等）只按 ID 不建外键（D02 §7）
