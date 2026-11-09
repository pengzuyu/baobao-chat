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
	OwnerID       string           `json:"ownerId,omitempty"`
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

	// ── 群管理（D03 §3.5/§3.6/§4.1 INT-IM-15~19；§5.2 conv.* 事件全集）──

	// CreateConversation 建会话（单聊去重复用/建群校验/广播群 publisher）→ 系统消息+conv.updated(meta)
	CreateConversation(ctx context.Context, userID int64, p ConvCreatePayload) (*ConvDetailDTO, error)
	// QuitConversation 退群（owner 3016 拒绝）→ member.quit 系统消息 + conv.updated(member)
	QuitConversation(ctx context.Context, userID, convID int64) error
	// AddMembers 邀请入群（invite_policy/上限 3010/已在会话 3012）→ member.joined
	AddMembers(ctx context.Context, userID int64, p MemberAddPayload) error
	// RemoveMember 移出（矩阵校验：admin 仅 member 级）→ member.removed
	RemoveMember(ctx context.Context, userID int64, p MemberRemovePayload) error
	// SetMemberRole 角色（转让 owner/设管 admin/取消 member，仅 owner 可操作）→ member.role.changed/owner.transferred
	SetMemberRole(ctx context.Context, userID int64, p MemberRolePayload) error
	// UpdateConvSetting 群设置 patch（name/announcement/mute_all/mute_member/策略）→ 对应系统消息+conv.updated
	UpdateConvSetting(ctx context.Context, userID int64, p ConvSettingPayload) error
	// DissolveConversation 解散（仅 owner）→ conv.dissolved + conv.updated(status)
	DissolveConversation(ctx context.Context, userID, convID int64) error
	// ApplyJoin 入群申请（7 天过期；同群同人待审唯一幂等）→ apply.submitted 审批卡
	ApplyJoin(ctx context.Context, userID int64, p ApplyPayload) (*ApplyResult, error)
	// HandleApply 审批（approve 入群/reject；仅 owner/admin）→ member.joined(通过申请)
	HandleApply(ctx context.Context, userID int64, p ApplyHandlePayload) error
	// GetConvDetail 会话详情（API-IM-03：conversation+group_setting+my+成员概要）
	GetConvDetail(ctx context.Context, userID int64, convID int64) (*ConvDetailDTO, error)
	// ListMembers 成员列表（API-IM-05 简版：在群成员含 role/mute_until）
	ListMembers(ctx context.Context, userID int64, convID int64) ([]MemberDTO, error)
	// ListReceiptPanel 已读回执面板（API-IM-06：seq 的已读/未读成员分组；
	// read_seq≥seq 判已读；租户 im.read_receipt 策略联动阶段二接——当前成员即可查）
	ListReceiptPanel(ctx context.Context, userID int64, convID int64, seq int64) (*ReceiptPanelDTO, error)

	// ── 搜索与收藏（D03 §3.7 PIM-07 / §3.8 PIM-08）──

	// Favorite 收藏（API-IM-10：幂等 UK(user_id,msg_id)；上限 1000→3022；撤回消息可收藏）
	Favorite(ctx context.Context, userID int64, msgID int64) (*FavoriteResult, error)
	// Unfavorite 取消收藏（幂等：不存在 no-op）
	Unfavorite(ctx context.Context, userID int64, msgID int64) error
	// ListFavorites 收藏列表（API-IM-11：created_at 倒序 + type 过滤 + cursor 翻页）
	ListFavorites(ctx context.Context, userID int64, msgType string, cursor int64, limit int) (*FavoriteListResult, error)
	// SearchMessages 服务端态搜索（API-IM-12：keyword+过滤器 AND；仅本人可见会话）
	SearchMessages(ctx context.Context, userID int64, p SearchParams) (*SearchResult, error)

	// ── 通知中心（D03 §3.9 PIM-09；API-IM-14 列表/已读/未读数）──

	// ListNotifications 通知列表（分组 kind 过滤 + unread_only + cursor 翻页；仅本人）
	ListNotifications(ctx context.Context, userID int64, kind string, unreadOnly bool, cursor int64, limit int) (*NotificationListResult, error)
	// MarkNotificationsRead 已读（ids 单条/多条；all 全部；仅本人行，幂等）
	MarkNotificationsRead(ctx context.Context, userID int64, p NotificationReadPayload) error
	// UnreadNotificationCount 未读计数（红点数据源；端内 99+ 封顶）
	UnreadNotificationCount(ctx context.Context, userID int64) (*UnreadCountResult, error)
	// ReportAgentTask Agent 任务终态上报（宿主→notify 域，OQ-C32 事件源④）：
	// 幂等（run_id+status）→ 通知中心落卡（kind=agent_done）+ 发布 agent.task.completed
	ReportAgentTask(ctx context.Context, userID int64, p AgentTaskReportPayload) error

	// ── 通话卡片（D04 阶段一：rtc 域经注入调用；通话记录=消息流，服务端不建表）──

	// SendCallCard invite 时落 type=call_card 消息（sender=主叫；client_msg_id 幂等）→ 返回 msg_id 回链
	SendCallCard(ctx context.Context, senderID, convID int64, clientMsgID string, body json.RawMessage) (int64, error)
	// UpdateCallCard 结束时 PATCH body（status=ended{duration,reason}）→ 复用 msg.updated 扇出
	UpdateCallCard(ctx context.Context, msgID int64, body json.RawMessage) error
	// BroadcastNotice 平台公告广播（PAD-15；admin 域经 main 闭包调用——
	// kind=announcement 系统公告分组，通知中心全员可见；返回成功落行数）
	BroadcastNotice(ctx context.Context, tenantID int64, title, digest string, userIDs []int64) int
}

// ── 收藏（D03 §3.8 PIM-08；API-IM-10/11）──

// FavoriteResult POST /messages/{id}/favorite 响应（幂等命中 Duplicate=true 返回原行）
type FavoriteResult struct {
	FavoriteID int64 `json:"favoriteId,string"`
	CreatedAt  int64 `json:"createdAt"` // ms
	Duplicate  bool  `json:"duplicate,omitempty"`
}

// FavoriteConv 来源会话快照（收藏列表项内嵌）
type FavoriteConv struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type int    `json:"type"`
}

// FavoriteItem 收藏列表项（msg 实时快照：已撤回时 status=2，端内渲染占位——
// 快照只存 msg_id+conv_id，详情实时取，D03 INT-IM-06）
type FavoriteItem struct {
	ID        int64        `json:"id,string"`
	Msg       *Message     `json:"msg"`
	Conv      FavoriteConv `json:"conv"`
	CreatedAt int64        `json:"createdAt"` // ms
}

// FavoriteListResult GET /favorites 响应（cursor=收藏 id）
type FavoriteListResult struct {
	Items      []FavoriteItem `json:"items"`
	NextCursor string         `json:"nextCursor,omitempty"`
	HasMore    bool           `json:"hasMore"`
}

// ── 搜索（D03 §3.7 PIM-07 服务端态；API-IM-12）──

// SearchParams GET /messages/search 入参（过滤器 AND 组合；零值=不限）
type SearchParams struct {
	Keyword string // 必填：非空白、≤64 字（9001）
	FromUID int64
	ConvID  int64
	Type    string
	FromTS  int64 // ms 含边界
	ToTS    int64 // ms 含边界
	Cursor  int64 // 上一页最后一条 msg_id；0=首页
	Limit   int   // ≤0 或 >100 取 20
}

// SearchHighlight 命中片段（text 消息 body.text 内字节偏移，最多 3 处；
// 端内另按 keyword substring 高亮兜底——大小写不敏感口径一致）
type SearchHighlight struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// SearchItem 搜索结果项
type SearchItem struct {
	Msg        Message           `json:"msg"`
	ConvName   string            `json:"convName"`
	SenderName string            `json:"senderName"`
	Highlight  []SearchHighlight `json:"highlight,omitempty"`
}

// SearchResult GET /messages/search 响应（cursor=最后一条 msg_id）
type SearchResult struct {
	Items      []SearchItem `json:"items"`
	NextCursor string       `json:"nextCursor,omitempty"`
	HasMore    bool         `json:"hasMore"`
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

// ── 群管理（D03 §3.5 PIM-05 / §3.6 PIM-06 / §3.12 PIM-12 / §5.2 conv.* 事件）──

// 系统消息 kind 注册表（PIM-12 样式集；服务端下发占位消息，端内按模板渲染）
const (
	SysKindGroupCreated        = "group.created"        // {actor} 创建了群聊
	SysKindMemberJoined        = "member.joined"        // {actor} 邀请 {target} 加入 / {target} 通过申请加入
	SysKindMemberQuit          = "member.quit"          // {actor} 退出了群聊
	SysKindMemberRemoved       = "member.removed"       // {target} 被 {actor} 移出群聊
	SysKindMemberRoleChanged   = "member.role.changed"  // {target} 被 {actor} 设为/取消管理员（extra=admin/member）
	SysKindOwnerTransferred    = "owner.transferred"    // {actor} 将群主转让给 {target}
	SysKindMemberMuted         = "member.muted"         // {target} 被 {actor} 禁言至 {until}
	SysKindMemberUnmuted       = "member.unmuted"       // {target} 被 {actor} 解除禁言
	SysKindMuteAllOn           = "mute.all.on"          // 群主/管理员开启了全员禁言（至 {until}）
	SysKindMuteAllOff          = "mute.all.off"         // 解除全员禁言
	SysKindAnnouncementChanged = "announcement.changed" // {actor} 修改了群公告
	SysKindConvDissolved       = "conv.dissolved"       // {actor} 解散了该群聊
	SysKindMsgRecalled         = "msg.recalled"         // {actor} 撤回了一条消息（撤回占位沿用 msg.recall 通道）
	SysKindApplySubmitted      = "apply.submitted"      // {actor} 申请加入群聊：{extra}（附审批卡 PIM-06）
	SysKindBroadcastPublished  = "broadcast.published"  // {actor} 发布了新公告（仅广播群）
)

// SystemBody system 消息 body（PIM-12：参数集服务端下发，端内套中文模板）
type SystemBody struct {
	Kind        string `json:"kind"`
	Actor       string `json:"actor,omitempty"`      // 操作者 uid
	ActorName   string `json:"actor_name,omitempty"` // 操作者展示名
	Target      string `json:"target,omitempty"`     // 目标 uid
	TargetName  string `json:"target_name,omitempty"`
	Group       string `json:"group,omitempty"`         // 群名
	Extra       string `json:"extra,omitempty"`         // 申请理由 / 角色方向（admin|member）
	Until       int64  `json:"until,omitempty"`         // 禁言截止 ms（member.muted / mute.all.on）
	JoinByApply bool   `json:"join_by_apply,omitempty"` // member.joined：申请通过路径（无邀请者文案）
	ApplyID     string `json:"apply_id,omitempty"`      // apply.submitted：审批卡关联
}

// GroupSettingDTO 群设置（camel，对齐客户端 GroupSetting）
type GroupSettingDTO struct {
	ConvID           string `json:"convId"`
	JoinMode         int    `json:"joinMode"`               // 1 直接进 2 需审批 3 仅邀请
	InvitePolicy     int    `json:"invitePolicy"`           // 1 全员可邀 2 仅管理
	MentionAllPolicy int    `json:"mentionAllPolicy"`       // 1 全员 2 仅管理 3 禁用
	MuteAllUntil     int64  `json:"muteAllUntil,omitempty"` // ms；0=未开启
	HistoryVisible   bool   `json:"historyVisible"`
	Announcement     string `json:"announcement,omitempty"`
	AnnouncementTs   int64  `json:"announcementTs,omitempty"`
}

// MemberDTO 成员行（API-IM-05：uid/名称/角色/状态/禁言/入群时间）
type MemberDTO struct {
	UID         string `json:"uid"`
	DisplayName string `json:"displayName"`
	Role        int    `json:"role"`
	Status      int    `json:"status"`
	MuteUntil   int64  `json:"muteUntil,omitempty"` // ms
	JoinAt      int64  `json:"joinAt"`              // ms
}

// ReceiptMemberDTO 已读面板成员行（API-IM-06）
type ReceiptMemberDTO struct {
	UID         string `json:"uid"`
	DisplayName string `json:"displayName"`
}

// ReceiptPanelDTO 已读/未读分组（API-IM-06；seq=被查询消息 seq）
type ReceiptPanelDTO struct {
	Seq    int64              `json:"seq"`
	Read   []ReceiptMemberDTO `json:"read"`
	Unread []ReceiptMemberDTO `json:"unread"`
}

// ConvDetailDTO 会话详情（API-IM-03：conversation 全字段 + group_setting + my + 成员概要）
type ConvDetailDTO struct {
	ConversationDTO
	GroupSetting *GroupSettingDTO `json:"groupSetting,omitempty"`
	MyRole       int              `json:"myRole,omitempty"`
	MyMuteUntil  int64            `json:"myMuteUntil,omitempty"`
	Members      []MemberDTO      `json:"members"`
}

// ConvCreatePayload WS conv.create（D03 §5.2；member_ids ≤499，type=1 恰 1 人）
type ConvCreatePayload struct {
	Type         int      `json:"type"`
	Name         string   `json:"name,omitempty"`
	MemberIDs    []string `json:"member_ids"`
	AvatarFileID string   `json:"avatar_file_id,omitempty"`
}

// ConvIDPayload WS conv.quit / conv.dissolve
type ConvIDPayload struct {
	ConvID ConvID `json:"conv_id"`
}

// MemberAddPayload WS conv.member.add（uids ≤100/次，批量预检余量）
type MemberAddPayload struct {
	ConvID ConvID   `json:"conv_id"`
	UIDs   []string `json:"uids"`
}

// MemberRemovePayload WS conv.member.remove
type MemberRemovePayload struct {
	ConvID ConvID `json:"conv_id"`
	UID    string `json:"uid"`
}

// MemberRolePayload WS conv.member.role（role：1 owner 转让 / 2 admin / 3 member）
type MemberRolePayload struct {
	ConvID ConvID `json:"conv_id"`
	UID    string `json:"uid"`
	Role   int    `json:"role"`
}

// MuteMemberPatch conv.setting.mute_member（until ms；0=解除；≤30 天/次）
type MuteMemberPatch struct {
	UID   string `json:"uid"`
	Until int64  `json:"until"`
}

// ConvSettingPayload WS conv.setting（patch：指针区分未传/传零值，D03 §5.2）
type ConvSettingPayload struct {
	ConvID           ConvID           `json:"conv_id"`
	Name             *string          `json:"name,omitempty"`
	AvatarFileID     *string          `json:"avatar_file_id,omitempty"`
	Announcement     *string          `json:"announcement,omitempty"`       // ≤2000
	MuteAllUntil     *int64           `json:"mute_all_until,omitempty"`     // ms；0=解除全员禁言
	MuteMember       *MuteMemberPatch `json:"mute_member,omitempty"`        // 单人禁言/解除
	JoinMode         *int             `json:"join_mode,omitempty"`          // 1/2/3
	InvitePolicy     *int             `json:"invite_policy,omitempty"`      // 1/2
	MentionAllPolicy *int             `json:"mention_all_policy,omitempty"` // 1/2/3
	HistoryVisible   *bool            `json:"history_visible,omitempty"`
}

// ApplyPayload WS conv.apply（reason ≤200）
type ApplyPayload struct {
	ConvID ConvID `json:"conv_id"`
	Reason string `json:"reason,omitempty"`
}

// ApplyHandlePayload WS conv.apply.handle（action：approve/reject）
type ApplyHandlePayload struct {
	ApplyID string `json:"apply_id"`
	Action  string `json:"action"`
}

// ApplyResult conv.apply ack 载荷（D03 §5.2：{apply_id}）
type ApplyResult struct {
	ApplyID string `json:"apply_id"`
}

// MemberDelta conv.updated(kind=member/setting) 成员增量（S2 状态机快照；
// mute_until 恒输出：0=未禁言/解除——单人禁言走 kind=setting 携带，端内按 uid==self 判输入框态）
type MemberDelta struct {
	UID       int64 `json:"uid"`
	Role      int   `json:"role"`
	Status    int   `json:"status"`
	MuteUntil int64 `json:"mute_until"`
}

// ConvUpdatedEvent topic=conv.updated：kind=meta/member/setting/status/announcement
// （与 ConvStateEvent 同 topic，gateway 按 payload 类型分发——D03 §5.3）
type ConvUpdatedEvent struct {
	Kind         string           `json:"kind"`
	ConvID       int64            `json:"conv_id"`
	Type         int              `json:"type"`
	Name         string           `json:"name"`
	OwnerID      int64            `json:"owner_id"`
	LatestSeq    int64            `json:"latest_seq"`
	MemberCount  int              `json:"member_count"`
	Status       int              `json:"status"`
	Setting      *GroupSettingDTO `json:"setting,omitempty"` // kind=setting/announcement 携带
	OperatorID   int64            `json:"operator_id"`
	MembersDelta []MemberDelta    `json:"members_delta,omitempty"` // kind=member
	MemberIDs    []int64          `json:"member_ids"`              // 扇出目标（快照时点含离群者本人）
}

// MemberDeltaDTO conv.updated 推送 members_delta 项（uid 字符串透出；mute_until ms，0=解除）
type MemberDeltaDTO struct {
	UID       string `json:"uid"`
	Role      int    `json:"role"`
	Status    int    `json:"status"`
	MuteUntil int64  `json:"mute_until"`
}

// ConvSnapshotDTO conv.updated 推送内 conv 快照（camel，端内与会话列表项合并）
type ConvSnapshotDTO struct {
	ID           string           `json:"id"`
	Type         int              `json:"type"`
	Name         string           `json:"name"`
	OwnerID      string           `json:"ownerId,omitempty"`
	LatestSeq    int64            `json:"latestSeq"`
	LastMsgTs    int64            `json:"lastMsgTs,omitempty"`
	MemberCount  int              `json:"memberCount"`
	Status       int              `json:"status"`
	GroupSetting *GroupSettingDTO `json:"groupSetting,omitempty"`
}

// ConvUpdatedPushPayload conv.updated 推送载荷（D03 §5.3：kind+快照+operator+members_delta）
type ConvUpdatedPushPayload struct {
	ConvID       string           `json:"conv_id"`
	Kind         string           `json:"kind"` // meta/member/setting/status/announcement
	Conv         ConvSnapshotDTO  `json:"conv"`
	OperatorID   string           `json:"operator_id"`
	MembersDelta []MemberDeltaDTO `json:"members_delta,omitempty"`
}

// ── 通知中心（D03 §3.9 PIM-09；§4.1 INT-IM-22）──

// 通知 kind 注册表（五分组：@我/回复我/入群审批/Agent 完成/系统公告）
const (
	NotifyKindMention      = "mention"      // msg.new mentions 命中（含 all 全员）
	NotifyKindReply        = "reply"        // reply_to_seq 指向本人消息
	NotifyKindApply        = "apply"        // conv.apply 推 owner/admin（PIM-06 审批卡）
	NotifyKindAgentDone    = "agent_done"   // agent 任务终态（宿主上报 POST /notify/agent-tasks 生成，OQ-C32/14 篇 §3.3）
	NotifyKindAnnouncement = "announcement" // notice.broadcast / 群公告变更
)

// NotificationItem 通知中心列表项（REST camel，对齐客户端 NotificationItem）
type NotificationItem struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	ConvID    string `json:"convId,omitempty"`
	MsgID     string `json:"msgId,omitempty"`
	Seq       int64  `json:"seq,omitempty"`
	Title     string `json:"title"`
	Digest    string `json:"digest,omitempty"`
	Count     int    `json:"count"` // 10s 窗口合并计数（"×N"渲染依据）
	CreatedAt int64  `json:"createdAt"`
	ReadAt    int64  `json:"readAt,omitempty"` // 0=未读
}

// NotificationListResult GET /notifications 响应（cursor=通知 id）
type NotificationListResult struct {
	Items      []NotificationItem `json:"items"`
	NextCursor string             `json:"nextCursor,omitempty"`
	HasMore    bool               `json:"hasMore"`
}

// NotificationReadPayload POST /notifications/read（ids 单条/多条；all 全部）
type NotificationReadPayload struct {
	IDs []string `json:"ids,omitempty"`
	All bool     `json:"all,omitempty"`
}

// UnreadCountResult GET /notifications/unread_count 响应（红点数据源；99+ 封顶在端内）
type UnreadCountResult struct {
	Count int64 `json:"count"`
}

// NotificationPushPayload notification.new 推送（snake，14 篇 §3.2；
// 合并命中时 count 为合并后计数——端内仅做列表/红点失效，真值经 REST 回读）
type NotificationPushPayload struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	ConvID string `json:"conv_id,omitempty"`
	Title  string `json:"title"`
	Digest string `json:"digest,omitempty"`
	Count  int    `json:"count"`
	TS     int64  `json:"ts"`
}

// NotificationEvent topic=notification.new 事件负载（通知生成器 → gateway 推给该 user）
type NotificationEvent struct {
	UserID int64
	Push   NotificationPushPayload
}

// ── Agent 任务终态上报（14 篇 §3.3，OQ-C32：宿主→notify 域，跨端通知事件源）──

// AgentTaskReportPayload POST /notify/agent-tasks 请求体（snake，字段对齐 D16 agent_run 终态快照；
// 上报以用户 OBO token 鉴权，UserID 恒取 token sub——body 不接受越权指定接收人）
type AgentTaskReportPayload struct {
	RunID             string `json:"run_id"`                        // r-{seq}（幂等键）
	Kind              string `json:"kind"`                          // probe | expert | team | delegate
	Status            string `json:"status"`                        // done | failed | cancelled
	SessionID         string `json:"session_id"`                    // 父会话
	ParentRunID       string `json:"parent_run_id,omitempty"`       // 父 run（链路展示用）
	DefRef            string `json:"def_ref,omitempty"`             // builtin.probe / {expertId}@{ver} / backend:{type}
	Title             string `json:"title"`                         // 任务标题（通知标题用）
	Summary           string `json:"summary,omitempty"`             // 结果摘要截断
	ChangedFilesCount int    `json:"changed_files_count,omitempty"` // 变更文件数（展示用，不含内容）
	ETAActualMS       int64  `json:"eta_actual_ms,omitempty"`       // 实际耗时
	OriginDID         string `json:"origin_did,omitempty"`          // 上报设备（推送侧端过滤自己，防双响）
}

// AgentTaskEvent topic=agent.task.completed 事件负载（notify → gateway 推给该 user 全部在线设备；
// 同 run 终态唯一，端侧按 run_id 幂等去重）
type AgentTaskEvent struct {
	UserID int64
	Task   AgentTaskReportPayload
}
