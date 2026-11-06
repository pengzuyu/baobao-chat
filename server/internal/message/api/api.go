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
	Status      int             `json:"status"`
	TS          int64           `json:"ts"` // 服务端时间（毫秒）
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
	Status      int             `json:"status"`
	TS          int64           `json:"ts"`
}

// ToMsgNew Message → msg.new 推送载荷
func (m Message) ToMsgNew() MsgNewPayload {
	return MsgNewPayload{
		MsgID: strconv.FormatInt(m.ID, 10), ConvID: strconv.FormatInt(m.ConvID, 10),
		Seq: m.Seq, ClientMsgID: m.ClientMsgID, SenderID: strconv.FormatInt(m.SenderID, 10),
		SenderName: m.SenderName, Type: m.Type, Body: m.Body, Mentions: m.Mentions,
		ReplyToSeq: m.ReplyToSeq, Status: m.Status, TS: m.TS,
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
	// ListMessages 历史翻页/补洞（after<seq<before，14 篇 §4.2）
	ListMessages(ctx context.Context, convID, after, before int64, limit int) ([]Message, error)
	// ListUserConversations 会话列表（API-IM-02：按成员身份聚合 + 我的态）
	ListUserConversations(ctx context.Context, userID int64) ([]ConversationDTO, error)
}
