// Package messageservice 消息域业务逻辑。
// 核心链路（04 篇 §4.1 发送时序）：成员/状态校验 → 内容策略 → seq 分配 → 落库 →
// 冗余更新 → 发布 msg.created（gateway 订阅扇出 msg.new）。
package messageservice

import (
	"context"
	"encoding/json"
	"log"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	messageapi "github.com/baobaowork/server/internal/message/api"
	messagerepo "github.com/baobaowork/server/internal/message/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
)

// Options 策略参数（租户策略热更接入点：admin_policy → policy.updated，D02 §8）
type Options struct {
	MaxTextRunes   int                   // text 上限（默认 5000，04 篇 §1.2）
	SensitiveWords []string              // 敏感词（阶段二：租户词库缓存 + 变更热更，04 篇 §7.3）
	Now            func() time.Time      // 时钟注入（测试用）
	NameOf         func(id int64) string // 发送人名称解析（main 注入 org 域；缺省回落 uid 字符串）
}

func (o *Options) fillDefaults() {
	if o.MaxTextRunes == 0 {
		o.MaxTextRunes = 5000
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Service 实现 messageapi.MessageService
type Service struct {
	repo messagerepo.Repo
	bus  eventbus.Bus
	opts Options

	// convLocks 会话级发送锁：alloc+insert 原子化，保证 msgs 按 seq 有序落库
	// （生产环境由 Redis 单点分配保证，等价不变量：会话内 seq 全序——04 篇 §7.2）
	convLocks sync.Map // convID → *sync.Mutex
}

// New 构造
func New(opts Options, r messagerepo.Repo, bus eventbus.Bus) *Service {
	opts.fillDefaults()
	return &Service{repo: r, bus: bus, opts: opts}
}

var _ messageapi.MessageService = (*Service)(nil)

// textBody text 消息 body 约定 {"text": "..."}（校验长度/敏感词用）
type textBody struct {
	Text string `json:"text"`
}

func (s *Service) convLock(convID int64) *sync.Mutex {
	v, _ := s.convLocks.LoadOrStore(convID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// nameOf uid → 展示名（NameOf 未注入时回落字符串 uid）
func (s *Service) nameOf(id int64) string {
	if s.opts.NameOf != nil {
		if n := s.opts.NameOf(id); n != "" {
			return n
		}
	}
	return strconv.FormatInt(id, 10)
}

// parseConvID 客户端 conv_id 为字符串（id 泛型 string），入口统一解析
func parseConvID(s messageapi.ConvID) (int64, error) {
	id, err := strconv.ParseInt(string(s), 10, 64)
	if err != nil || id <= 0 {
		return 0, errx.New(errx.CodeBadRequest, "conv_id 非法")
	}
	return id, nil
}

// Send 发送消息（幂等：client_msg_id 命中直接返回原结果，14 篇 §5.3）
func (s *Service) Send(ctx context.Context, senderID int64, p messageapi.SendPayload) (*messageapi.SendResult, error) {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return nil, err
	}
	if p.ClientMsgID == "" || p.Type == "" {
		return nil, errx.New(errx.CodeBadRequest, "conv_id/client_msg_id/type 必填")
	}

	// ① 幂等前置：同 client_msg_id 已落库 → 返回原 seq（重试安全）
	if m, _ := s.repo.FindByClientMsgID(ctx, convID, p.ClientMsgID); m != nil {
		return &messageapi.SendResult{MsgID: m.ID, Seq: m.Seq, TS: m.TS, Duplicate: true}, nil
	}

	// ② 会话与成员校验（3001/3002/3019）
	conv, err := s.repo.GetConversation(ctx, convID)
	if err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	if conv.Status != messageapi.ConvActive {
		return nil, errx.New(errx.CodeIMConvDissolved, "会话已解散")
	}
	member, _ := s.repo.MemberOf(ctx, convID, senderID)
	if member == nil || member.Status != 1 {
		return nil, errx.New(errx.CodeIMNotInConversation, "不在会话中")
	}
	// 广播群只读：仅 publisher 可发（04 篇 §4.5.4）
	if conv.Type == messageapi.ConvBroadcast && member.Role != messageapi.MemberPublisher {
		return nil, errx.New(errx.CodeIMBroadcastReadOnly, "广播群仅 publisher 可发言")
	}
	// 禁言（04 篇 §4.5.3）
	now := s.opts.Now()
	if member.MuteUntil.After(now) {
		return nil, errx.New(errx.CodeIMMuted, "禁言中")
	}

	// ③ 内容策略（3004/3005）
	if p.Type == "text" {
		var tb textBody
		if len(p.Body) > 0 {
			if err := json.Unmarshal(p.Body, &tb); err != nil {
				return nil, errx.New(errx.CodeBadRequest, "text 消息 body 应为 {\"text\":...}")
			}
		}
		if len([]rune(tb.Text)) > s.opts.MaxTextRunes {
			return nil, errx.New(errx.CodeIMContentTooLong, "消息内容超过长度限制")
		}
		for _, w := range s.opts.SensitiveWords {
			if w != "" && strings.Contains(tb.Text, w) {
				return nil, errx.New(errx.CodeIMSensitiveBlocked, "包含违禁词")
			}
		}
	}

	// ④+⑤ seq 分配 + 落库（会话级锁内原子完成；并发同 client_msg_id 由 UK 兜底）
	lock := s.convLock(convID)
	lock.Lock()
	seq, err := s.repo.AllocSeq(ctx, convID)
	if err != nil {
		lock.Unlock()
		return nil, errx.From(err)
	}
	msg := messageapi.Message{
		ConvID: convID, Seq: seq, ClientMsgID: p.ClientMsgID, SenderID: senderID,
		SenderName: s.nameOf(senderID),
		Type:       p.Type, Body: p.Body, Mentions: p.Mentions, ReplyToSeq: p.ReplyToSeq,
		Status: messageapi.MsgNormal, TS: now.UnixMilli(),
	}
	msg.ID = nextMsgID()
	if err := s.repo.InsertMessage(ctx, msg); err != nil {
		lock.Unlock()
		if err == messagerepo.ErrDuplicateClientMsgID {
			// 并发幂等兜底：对手已落库，返回其结果（04 篇 §7.2）
			if m, _ := s.repo.FindByClientMsgID(ctx, convID, p.ClientMsgID); m != nil {
				return &messageapi.SendResult{MsgID: m.ID, Seq: m.Seq, TS: m.TS, Duplicate: true}, nil
			}
		}
		return nil, errx.From(err)
	}
	lock.Unlock()

	// ⑥ 会话冗余（latest_seq/last_msg_ts）
	if err := s.repo.TouchConversation(ctx, convID, seq, msg.TS); err != nil {
		return nil, errx.From(err)
	}
	// ⑥b 发送者已读自身消息（unread=latest-read 不因自己发言自增，D03 §3.1）
	if err := s.repo.SetReadSeq(ctx, convID, senderID, seq); err != nil {
		return nil, errx.From(err)
	}
	// ⑦ 事件（gateway 订阅 → msg.new 扇出；04 篇 §4.1 ⑦/§7.4）
	members, _ := s.repo.MembersOf(ctx, convID)
	_ = s.bus.Publish(ctx, eventbus.TopicMsgCreated, messageapi.MsgCreatedEvent{
		Message: msg, MemberIDs: members,
	})
	return &messageapi.SendResult{MsgID: msg.ID, Seq: msg.Seq, TS: msg.TS}, nil
}

// MarkRead 已读上报。不变量：read_seq 只进不退，取 max（04 篇 §4.2）。
func (s *Service) MarkRead(ctx context.Context, userID int64, p messageapi.ReadPayload) (*messageapi.ReadResult, error) {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return nil, err
	}
	conv, err := s.repo.GetConversation(ctx, convID)
	if err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	cur, _ := s.repo.GetReceipt(ctx, convID, userID)
	// 回退上报：no-op，返回当前生效值
	if p.ReadSeq <= cur.ReadSeq {
		return &messageapi.ReadResult{ConvID: string(p.ConvID), UserID: strconv.FormatInt(userID, 10), ReadSeq: cur.ReadSeq}, nil
	}
	// 游标越过 latest_seq → 非法（3018）
	if p.ReadSeq > conv.LatestSeq {
		return nil, errx.New(errx.CodeIMInvalidCursor, "read_seq 超过会话最新 seq")
	}
	if err := s.repo.SetReadSeq(ctx, convID, userID, p.ReadSeq); err != nil {
		return nil, errx.From(err)
	}
	// 事件 → gateway 推 msg.receipt 给其他成员（04 篇 §4.2：单聊默认开、群聊租户策略）
	members, _ := s.repo.MembersOf(ctx, convID)
	others := make([]int64, 0, len(members))
	for _, m := range members {
		if m != userID {
			others = append(others, m)
		}
	}
	_ = s.bus.Publish(ctx, eventbus.TopicMsgReadUpdated, messageapi.MsgReadEvent{
		ConvID: convID, UserID: userID, ReadSeq: p.ReadSeq, OtherMemberIDs: others,
	})
	log.Printf("[debug] MarkRead conv=%d user=%d seq=%d others=%v", convID, userID, p.ReadSeq, others)
	return &messageapi.ReadResult{ConvID: string(p.ConvID), UserID: strconv.FormatInt(userID, 10), ReadSeq: p.ReadSeq}, nil
}

// ListMessages 历史翻页/补洞（补 SenderName 供渲染）
func (s *Service) ListMessages(ctx context.Context, convID, after, before int64, limit int) ([]messageapi.Message, error) {
	if _, err := s.repo.GetConversation(ctx, convID); err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	msgs, err := s.repo.ListMessages(ctx, convID, after, before, limit)
	if err != nil {
		return nil, errx.From(err)
	}
	for i := range msgs {
		if msgs[i].SenderName == "" {
			msgs[i].SenderName = s.nameOf(msgs[i].SenderID)
		}
	}
	return msgs, nil
}

// ListUserConversations 会话列表（API-IM-02）：我的会话 + 我的态（未读=latest-read，只进不退保证非负）
func (s *Service) ListUserConversations(ctx context.Context, userID int64) ([]messageapi.ConversationDTO, error) {
	convs, err := s.repo.ListUserConversations(ctx, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]messageapi.ConversationDTO, 0, len(convs))
	for _, c := range convs {
		r, _ := s.repo.GetReceipt(ctx, c.ID, userID)
		unread := c.LatestSeq - r.ReadSeq
		if unread < 0 {
			unread = 0
		}
		dto := messageapi.ConversationDTO{
			ID: strconv.FormatInt(c.ID, 10), Type: c.Type, Name: c.Name,
			LatestSeq: c.LatestSeq, LastMsgTS: c.LastMsgTS, MemberCount: c.MemberCount,
			Status: c.Status,
			My:     messageapi.UserConvStateDTO{ReadSeq: r.ReadSeq, UnreadBadge: unread},
		}
		// 摘要：取最后一条消息生成类型化文案（04 篇 D3 §3.1）
		if last, err := s.repo.LastMessage(ctx, c.ID); err == nil && last != nil {
			dto.LastMsgDigest = digestOf(*last)
		}
		out = append(out, dto)
	}
	return out, nil
}

// digestOf 摘要规则：text 截断 30 rune，其余类型化占位
func digestOf(m messageapi.Message) string {
	if m.Type == "text" {
		var tb textBody
		_ = json.Unmarshal(m.Body, &tb)
		r := []rune(tb.Text)
		if len(r) > 30 {
			return string(r[:30]) + "…"
		}
		return tb.Text
	}
	return "[" + m.Type + "]"
}

// msgIDSeq 消息 ID 自增占位（阶段二换雪花：趋势递增，13 篇 §1）
var msgIDSeq atomic.Int64

func init() { msgIDSeq.Store(100000) }

func nextMsgID() int64 { return msgIDSeq.Add(1) }
