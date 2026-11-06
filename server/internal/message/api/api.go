// Package messageapi 消息域对外接口与 DTO。
// 文档：docs/04-IM即时通讯设计.md §4（生命周期）/§5（模型）/§6（事件）。
// wire 契约与客户端 D03 §6.3 对齐：REST/ack 走 camelCase、msg.new 推送走 snake_case、
// ID 一律字符串透出（雪花/自增在端内不参与算术），conv 入参收字符串（客户端 id 泛型为 string）。
package messageapi

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// ErrNotFound 资源不存在 sentinel（service 映射 3017/3019）
var ErrNotFound = errors.New("messageapi: not found")

// 会话类型（04 篇 §5.1 conversation.type）
const (
	ConvSingle    = 1
	ConvGroup     = 2
	ConvBroadcast = 3
)

// 会话状态
const (
	ConvActive    = 1
	ConvDissolved = 2
)

// 会话成员角色（04 篇 §5.1 conversation_member.role）
const (
	MemberOwner     = 1
	MemberAdmin     = 2
	MemberMember    = 3
	MemberPublisher = 4 // 广播群唯一可发言角色
)

// 消息状态（04 篇 §5.1 message.status）
const (
	MsgNormal   = 1
	MsgRecalled = 2
	MsgEdited   = 3
)

// Mention @提及（04 篇 §1.2 #4；uid 字符串化与客户端一致）
type Mention struct {
	UID   string `json:"uid"`
	All   bool   `json:"all,omitempty"`
	Range [2]int `json:"range,omitempty"` // 文本区间 [start,end)
}

// Message 消息（REST DTO；`,string` 标签把 int64 序列化为字符串）
type Message struct {
	ID          int64           `json:"msgId,string"`
	ConvID      int64           `json:"convId,string"`
	Seq         int64           `json:"seq"`         // 会话内单调，全序依据
	ClientMsgID string          `json:"clientMsgId"` // 幂等键（14 篇 §5.3）
	SenderID    int64           `json:"senderId,string"`
	SenderName  string          `json:"senderName"` // 冗余发送人名称（main 注入 NameOf 解析）
	Type        string          `json:"type"`       // text/image/file/... (04 篇 §1.2)
	Body        json.RawMessage `json:"body,omitempty"`
	Mentions    []Mention       `json:"mentions,omitempty"`
	ReplyToSeq  int64           `json:"replyToSeq,omitempty"`
	Ext         json.RawMessage `json:"ext,omitempty"` // reactions/reply_digest 扩展（D03 §5.3）
	Status      int             `json:"status"`
	EditedAt    int64           `json:"editedAt,omitempty"`
	EditVersion int             `json:"editVersion,omitempty"` // 首版 0（未编辑）；编辑后 ≥2
	TS          int64           `json:"ts"`                    // 服务端时间（毫秒）
}

// ReplyDigest 引用快照（服务端按源消息冗余入 ext，D03 §5.2 reply_to_seq 条目）
type ReplyDigest struct {
	SenderID   string `json:"sender_id"`
	SenderName string `json:"sender_name,omitempty"`
	Type       string `json:"type"`
	Digest     string `json:"digest"` // 30 字摘要；源消息已撤回 → 固定文案
	Seq        int64  `json:"seq"`
}

// MsgExt ext 列结构（reactions 全量快照 + reply_digest；服务端唯一写入方）
type MsgExt struct {
	Reactions   map[string][]string `json:"reactions,omitempty"` // emoji → uid[]（升序，幂等合并）
	ReplyDigest *ReplyDigest        `json:"reply_digest,omitempty"`
}

// ConvID 兼容型 conv_id：客户端传字符串（id 泛型 string），测试/旧端可能传数字——两者都收
type ConvID string

func (c *ConvID) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if len(s) >= 2 && s[0] == '"' {
		return json.Unmarshal(b, (*string)(c))
	}
	// 数字形态：格式化为字符串（int64 无精度损失）
	var n int64
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*c = ConvID(strconv.FormatInt(n, 10))
	return nil
}

// SendPayload WS msg.send / REST 发送负载（conv_id 客户端传字符串，service 内解析）
type SendPayload struct {
	ConvID      ConvID          `json:"conv_id"`
	ClientMsgID string          `json:"client_msg_id"`
	Type        string          `json:"type"`
	Body        json.RawMessage `json:"body,omitempty"`
	Mentions    []Mention       `json:"mentions,omitempty"`
	ReplyToSeq  int64           `json:"reply_to_seq,omitempty"`
}

// ReadPayload WS msg.read 负载：连续最大已读 seq
type ReadPayload struct {
	ConvID  ConvID `json:"conv_id"`
	ReadSeq int64  `json:"read_seq"`
}

// SendResult 发送结果（ack 载荷；Duplicate=幂等命中返回原 seq）
type SendResult struct {
	MsgID     int64 `json:"msgId,string"`
	Seq       int64 `json:"seq"`
	TS        int64 `json:"ts"`
	Duplicate bool  `json:"duplicate,omitempty"`
}

// ReadResult 已读上报结果（生效游标）
type ReadResult struct {
	ConvID  string `json:"convId"`
	UserID  string `json:"userId"`
	ReadSeq int64  `json:"readSeq"` // 生效值（只进不退）
}

// MsgNewPayload msg.new 推送载荷（snake，对齐客户端 D03 §5.3 mapMsgNew）
type MsgNewPayload struct {
	MsgID       string          `json:"msg_id"`
	ConvID      string          `json:"conv_id"`
	Seq         int64           `json:"seq"`
	ClientMsgID string          `json:"client_msg_id"`
	SenderID    string          `json:"sender_id"`
	SenderName  string          `json:"sender_name,omitempty"`
	Type        string          `json:"type"`
	Body        json.RawMessage `json:"body,omitempty"`
	Mentions    []Mention       `json:"mentions,omitempty"`
	ReplyToSeq  int64           `json:"reply_to_seq,omitempty"`
	Ext         json.RawMessage `json:"ext,omitempty"`
	Status      int             `json:"status"`
	TS          int64           `json:"ts"`
}

// ToMsgNew Message → msg.new 推送载荷
func (m Message) ToMsgNew() MsgNewPayload {
	return MsgNewPayload{
		MsgID: strconv.FormatInt(m.ID, 10), ConvID: strconv.FormatInt(m.ConvID, 10),
		Seq: m.Seq, ClientMsgID: m.ClientMsgID, SenderID: strconv.FormatInt(m.SenderID, 10),
		SenderName: m.SenderName, Type: m.Type, Body: m.Body, Mentions: m.Mentions,
		ReplyToSeq: m.ReplyToSeq, Ext: m.Ext, Status: m.Status, TS: m.TS,
	}
}

// MsgCreatedEvent topic=msg.created 事件负载（gateway 订阅后扇出 msg.new）
type MsgCreatedEvent struct {
	Message   Message `json:"message"`
	MemberIDs []int64 `json:"member_ids"`
}

// MsgReadEvent topic=msg.read.updated 事件负载（gateway 推 msg.receipt 给 OtherMemberIDs）
type MsgReadEvent struct {
	ConvID         int64   `json:"conv_id"`
	UserID         int64   `json:"user_id"`
	ReadSeq        int64   `json:"read_seq"`
	OtherMemberIDs []int64 `json:"other_member_ids"` // 除阅读者外的成员（接收回执方）
}

// MsgReceiptPayload msg.receipt 推送载荷（snake，对齐客户端 D03 §5.3）
type MsgReceiptPayload struct {
	ConvID  string `json:"conv_id"`
	UserID  string `json:"user_id"` // 谁已读
	ReadSeq int64  `json:"read_seq"`
}

// UserConvStateDTO 我的会话态（camel，对齐客户端 Conversation.my）
type UserConvStateDTO struct {
	Pinned        bool   `json:"pinned"`
	Mute          bool   `json:"mute"`
	Draft         string `json:"draft"`
	ReadSeq       int64  `json:"readSeq"`
	UnreadBadge   int64  `json:"unreadBadge"` // latest_seq - read_seq（差值，只进不退保证非负）
	MentionUnread bool   `json:"mentionUnread"`
}

// ConversationDTO 会话列表项（camel，对齐客户端 Conversation）
type ConversationDTO struct {
	ID            string           `json:"id"`
	Type          int              `json:"type"`
	Name          string           `json:"name"`
	LatestSeq     int64            `json:"latestSeq"`
	LastMsgDigest string           `json:"lastMsgDigest,omitempty"`
	LastMsgTS     int64            `json:"lastMsgTs,omitempty"`
	MemberCount   int              `json:"memberCount"`
	Status        int              `json:"status"`
	My            UserConvStateDTO `json:"my"`
}

// MessageService 消息服务接口（gateway 依赖本接口，D02 §4）
type MessageService interface {
	// Send 发送：校验→分配 seq→落库→发布 msg.created（04 篇 §4.1 时序）
	Send(ctx context.Context, senderID int64, p SendPayload) (*SendResult, error)
	// MarkRead 已读上报：read_seq 只进不退（04 篇 §4.2）
	MarkRead(ctx context.Context, userID int64, p ReadPayload) (*ReadResult, error)
	// Edit 编辑本人 text 消息（≤5min 窗口，D03 INT-IM-02/API-IM-08）→ msg.updated
	Edit(ctx context.Context, userID int64, msgID int64, text string) (*EditResult, error)
	// Recall 撤回（本人 ≤24h，D03 INT-IM-03/API-IM-07）→ msg.recall 全端
	Recall(ctx context.Context, userID int64, msgID int64, reason string) (*RecallResult, error)
	// ReactionSet 表情回应增删（幂等，D03 INT-IM-23）→ msg.reaction.new 全量快照
	ReactionSet(ctx context.Context, userID int64, p ReactionSetPayload) (*ReactionResult, error)
	// Typing 正在输入（瞬时：不落库不重试，D03 INT-IM-11）→ 推其他成员
	Typing(ctx context.Context, userID int64, p TypingPayload) error
	// UpdateConvState 置顶/免打扰/草稿（API-IM-13）→ conv.updated(kind=state) 推本人多端
	UpdateConvState(ctx context.Context, userID int64, convID int64, p ConvStatePatch) (*ConvStateResult, error)
	// Forward 转发（逐条/合并 ≤30，D03 API-IM-09）
	Forward(ctx context.Context, userID int64, p ForwardPayload) (*ForwardResult, error)
	// ListMessages 历史翻页/补洞（after<seq<before 升序，14 篇 §4.2）
	ListMessages(ctx context.Context, convID, after, before int64, limit int) ([]Message, error)
	// ListMessagesLatest 最新 N 条（order=-seq 首屏拉取，D03 API-IM-04）
	ListMessagesLatest(ctx context.Context, convID int64, limit int) ([]Message, error)
	// ListUserConversations 会话列表（API-IM-02：按成员身份聚合 + 我的态）
	ListUserConversations(ctx context.Context, userID int64) ([]ConversationDTO, error)
	// Sync 增量同步（API-IM-01：cursors convId→seq，登录/重连补投）
	Sync(ctx context.Context, userID int64, cursors map[string]int64, limit int) (*SyncResult, error)
}

// ── 增量同步（API-IM-01）──

// SyncConvItem 单会话增量项（gap=true 时端侧翻页补洞；广播群仅游标）
type SyncConvItem struct {
	ConvID    string    `json:"convId"`
	Type      int       `json:"type"`
	Name      string    `json:"name"`
	LatestSeq int64     `json:"latestSeq"`
	Unread    int64     `json:"unread"`
	Gap       bool      `json:"gap,omitempty"`
	Messages  []Message `json:"messages,omitempty"`
}

// SyncBadges 徽标汇总
type SyncBadges struct {
	TotalUnread int64 `json:"totalUnread"`
}

// SyncResult 增量同步响应（presences 阶段一恒空——presence 域未建，登记）
type SyncResult struct {
	Convs     []SyncConvItem   `json:"convs"`
	Presences []map[string]any `json:"presences"`
	Badges    SyncBadges       `json:"badges"`
	ServerTS  int64            `json:"serverTs"`
}

// ── 编辑/撤回/回应/正在输入/会话态/转发（D03 §5） ──

// EditResult 编辑结果（ack/REST 同构）
type EditResult struct {
	MsgID       int64           `json:"msgId,string"`
	ConvID      string          `json:"convId"`
	Seq         int64           `json:"seq"`
	Body        json.RawMessage `json:"body"`
	EditedAt    int64           `json:"editedAt"`
	EditVersion int             `json:"editVersion"`
}

// RecallResult 撤回结果（占位消息渲染依据：seq 不断裂）
type RecallResult struct {
	MsgID  int64  `json:"msgId,string"`
	ConvID string `json:"convId"`
	Seq    int64  `json:"seq"`
	Status int    `json:"status"`
	TS     int64  `json:"ts"`
}

// ReactionSetPayload WS msg.reaction.set（D03 §5.2；msg_id 字符串，ID 不参与端内算术）
type ReactionSetPayload struct {
	MsgID  string `json:"msg_id"`
	Emoji  string `json:"emoji"`  // unicode，≤8 字节白名单
	Action string `json:"action"` // add / remove
}

// ReactionResult ack 载荷：全量快照（幂等合并后）
type ReactionResult struct {
	MsgID     int64               `json:"msgId,string"`
	Reactions map[string][]string `json:"reactions"`
}

// TypingPayload WS msg.typing（conv_id 字符串入口同 Send）
type TypingPayload struct {
	ConvID ConvID `json:"conv_id"`
}

// ConvStatePatch PATCH /convs/{id}/state（API-IM-13：按字段覆盖，指针区分未传/传 false）
type ConvStatePatch struct {
	Pinned *bool   `json:"pinned,omitempty"`
	Mute   *bool   `json:"mute,omitempty"`
	Draft  *string `json:"draft,omitempty"`
}

// ConvStateResult 会话态生效值
type ConvStateResult struct {
	Pinned bool   `json:"pinned"`
	Mute   bool   `json:"mute"`
	Draft  string `json:"draft"`
}

// ForwardPayload POST /messages/forward（API-IM-09）
type ForwardPayload struct {
	TargetConvID ConvID   `json:"target_conv_id"`
	MsgIDs       []string `json:"msg_ids"` // ≤30（3021）
	Mode         string   `json:"mode"`    // merge / one_by_one
	Note         string   `json:"note,omitempty"`
}

// ForwardItem 逐条结果（失败明细）
type ForwardItem struct {
	MsgID string `json:"msg_id"`
	Code  int    `json:"code,omitempty"`
	OK    bool   `json:"ok"`
}

// ForwardResult 转发结果
type ForwardResult struct {
	SentCount int           `json:"sentCount"`
	Failed    []ForwardItem `json:"failed,omitempty"`
}

// ── 事件载荷（message → gateway 推送） ──

// MsgRecalledEvent topic=msg.recalled（推 msg.recall 给全成员）
type MsgRecalledEvent struct {
	Message    Message `json:"message"`
	OperatorID int64   `json:"operator_id"`
	MemberIDs  []int64 `json:"member_ids"`
}

// MsgRecallPayload msg.recall 推送（D03 §5.3）
type MsgRecallPayload struct {
	MsgID      string `json:"msg_id"`
	ConvID     string `json:"conv_id"`
	Seq        int64  `json:"seq"`
	OperatorID string `json:"operator_id"`
	TS         int64  `json:"ts"`
}

// MsgEditedEvent topic=msg.edited（推 msg.updated 给全成员原地更新）
type MsgEditedEvent struct {
	Message   Message `json:"message"`
	MemberIDs []int64 `json:"member_ids"`
}

// MsgUpdatedPayload msg.updated 推送（D03 §5.3）
type MsgUpdatedPayload struct {
	MsgID       string          `json:"msg_id"`
	ConvID      string          `json:"conv_id"`
	Seq         int64           `json:"seq"`
	Body        json.RawMessage `json:"body"`
	EditedAt    int64           `json:"edited_at"`
	EditVersion int             `json:"edit_version"`
}

// MsgReactionEvent topic=msg.reaction（推 msg.reaction.new 全量快照给全成员）
type MsgReactionEvent struct {
	MsgID     int64               `json:"msg_id"`
	ConvID    int64               `json:"conv_id"`
	Seq       int64               `json:"seq"`
	Reactions map[string][]string `json:"reactions"`
	MemberIDs []int64             `json:"member_ids"`
}

// MsgReactionNewPayload msg.reaction.new 推送（D03 §5.3）
type MsgReactionNewPayload struct {
	MsgID     string              `json:"msg_id"`
	ConvID    string              `json:"conv_id"`
	Seq       int64               `json:"seq"`
	Reactions map[string][]string `json:"reactions"`
}

// TypingEvent topic=msg.typing（gateway 转推给 OtherMemberIDs）
type TypingEvent struct {
	ConvID         int64   `json:"conv_id"`
	UserID         int64   `json:"user_id"`
	OtherMemberIDs []int64 `json:"other_member_ids"`
}

// TypingPushPayload msg.typing 推送（瞬时；客户端 TTL 5s 自过期）
type TypingPushPayload struct {
	ConvID string `json:"conv_id"`
	UserID string `json:"user_id"`
}

// ConvStateEvent topic=conv.updated(kind=state)：仅推本人多端（D03 §10-1）
type ConvStateEvent struct {
	ConvID  int64           `json:"conv_id"`
	UserID  int64           `json:"user_id"`
	State   ConvStatePatch  `json:"state"`
	Applied ConvStateResult `json:"applied"`
}
