// 消息域交互扩展（D03 §4/§5）：编辑/撤回/表情回应/正在输入/会话态/转发。
// 全部走「校验 → 仓储 → 事件发布」三段式；推送扇出由 gateway 订阅完成（D02 §5）。
package messageservice

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	messageapi "github.com/baobaowork/server/internal/message/api"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
)

// validateText text 内容策略（长度 3004 / 敏感词 3005；Send 与 Edit 共用）
func (s *Service) validateText(text string) error {
	if len([]rune(text)) > s.opts.MaxTextRunes {
		return errx.New(errx.CodeIMContentTooLong, "消息内容超过长度限制")
	}
	words := s.opts.SensitiveWords
	if s.opts.SensitiveWordSource != nil { // D10 词库热更：管理域增删即时生效
		words = s.opts.SensitiveWordSource()
	}
	for _, w := range words {
		if w != "" && strings.Contains(text, w) {
			return errx.New(errx.CodeIMSensitiveBlocked, "包含违禁词")
		}
	}
	return nil
}

// Edit 编辑本人 text 消息（D03 INT-IM-02/API-IM-08）：≤5min、仅 text、留痕 edit_version。
func (s *Service) Edit(ctx context.Context, userID, msgID int64, text string) (*messageapi.EditResult, error) {
	msg, err := s.repo.GetMessageByID(ctx, msgID)
	if err != nil {
		return nil, errx.New(errx.CodeIMMessageNotFound, "消息不存在")
	}
	if msg.SenderID != userID {
		return nil, errx.New(errx.CodeIMNotMessageOwner, "只能编辑自己的消息")
	}
	if msg.Type != "text" {
		return nil, errx.New(errx.CodeIMNotMessageOwner, "仅文本消息可编辑")
	}
	if msg.Status == messageapi.MsgRecalled {
		return nil, errx.New(errx.CodeIMNotMessageOwner, "已撤回的消息不可编辑")
	}
	if d := time.Duration(s.opts.Now().UnixMilli()-msg.TS) * time.Millisecond; d > s.opts.EditWindow {
		return nil, errx.New(errx.CodeIMEditWindowPassed, "编辑窗口已过（5 分钟）")
	}
	if err := s.validateText(text); err != nil {
		return nil, err
	}

	body, err := json.Marshal(textBody{Text: text})
	if err != nil {
		return nil, errx.From(err)
	}
	msg.Body = body
	msg.Status = messageapi.MsgEdited
	msg.EditedAt = s.opts.Now().UnixMilli()
	// edit_version 语义对齐 D03 §6.3：原文=1（落库默认），首次编辑=2，此后 +1
	if msg.EditVersion < 2 {
		msg.EditVersion = 2
	} else {
		msg.EditVersion++
	}
	if err := s.repo.UpdateMessage(ctx, *msg); err != nil {
		return nil, errx.From(err)
	}

	members, _ := s.repo.MembersOf(ctx, msg.ConvID)
	_ = s.bus.Publish(ctx, eventbus.TopicMsgEdited, messageapi.MsgEditedEvent{Message: *msg, MemberIDs: members})
	return &messageapi.EditResult{
		MsgID: msg.ID, ConvID: fmt.Sprintf("%d", msg.ConvID), Seq: msg.Seq,
		Body: msg.Body, EditedAt: msg.EditedAt, EditVersion: msg.EditVersion,
	}, nil
}

// Recall 撤回（D03 INT-IM-03/API-IM-07）：本人 ≤24h；撤他人需 im:message:recall_any（
// 权限点未接入，登记阶段二）；幂等：已撤回直接返回现态并补发占位扇出。
func (s *Service) Recall(ctx context.Context, userID, msgID int64, reason string) (*messageapi.RecallResult, error) {
	msg, err := s.repo.GetMessageByID(ctx, msgID)
	if err != nil {
		return nil, errx.New(errx.CodeIMMessageNotFound, "消息不存在")
	}
	if msg.SenderID != userID {
		return nil, errx.New(errx.CodeIMNotMessageOwner, "只能撤回自己的消息")
	}
	nowMs := s.opts.Now().UnixMilli()
	if msg.Status != messageapi.MsgRecalled {
		if d := time.Duration(nowMs-msg.TS) * time.Millisecond; d > s.opts.RecallWindow {
			return nil, errx.New(errx.CodeIMRecallTimeout, "撤回窗口已过（24 小时）")
		}
		msg.Status = messageapi.MsgRecalled
		if err := s.repo.UpdateMessage(ctx, *msg); err != nil {
			return nil, errx.From(err)
		}
	}
	members, _ := s.repo.MembersOf(ctx, msg.ConvID)
	_ = s.bus.Publish(ctx, eventbus.TopicMsgRecalled, messageapi.MsgRecalledEvent{
		Message: *msg, OperatorID: userID, MemberIDs: members,
	})
	return &messageapi.RecallResult{
		MsgID: msg.ID, ConvID: fmt.Sprintf("%d", msg.ConvID), Seq: msg.Seq,
		Status: msg.Status, TS: nowMs,
	}, nil
}

// ReactionSet 表情回应增删（D03 INT-IM-23）：同人同 emoji 幂等；全量快照推送。
func (s *Service) ReactionSet(ctx context.Context, userID int64, p messageapi.ReactionSetPayload) (*messageapi.ReactionResult, error) {
	if p.Action != "add" && p.Action != "remove" {
		return nil, errx.New(errx.CodeBadRequest, "action 应为 add/remove")
	}
	if n := utf8.RuneCountInString(p.Emoji); n == 0 || len(p.Emoji) > 8 {
		return nil, errx.New(errx.CodeBadRequest, "emoji 非法（≤8 字节）")
	}
	for _, r := range p.Emoji {
		if r < 0x20 || r == 0x7f {
			return nil, errx.New(errx.CodeBadRequest, "emoji 含控制字符")
		}
	}
	msgID, err := parseMsgID(p.MsgID)
	if err != nil {
		return nil, err
	}
	msg, err := s.repo.GetMessageByID(ctx, msgID)
	if err != nil {
		return nil, errx.New(errx.CodeIMMessageNotFound, "消息不存在")
	}
	if msg.Status == messageapi.MsgRecalled {
		return nil, errx.New(errx.CodeIMMessageNotFound, "已撤回的消息不可回应")
	}
	if err := s.mustActiveMember(ctx, msg.ConvID, userID); err != nil {
		return nil, err
	}

	ext := decodeExt(msg.Ext)
	if ext.Reactions == nil {
		ext.Reactions = map[string][]string{}
	}
	uid := fmt.Sprintf("%d", userID)
	uids := ext.Reactions[p.Emoji]
	if p.Action == "add" {
		if !containsStr(uids, uid) {
			uids = append(uids, uid)
		}
	} else {
		uids = removeStr(uids, uid)
	}
	if len(uids) == 0 {
		delete(ext.Reactions, p.Emoji)
	} else {
		sort.Strings(uids)
		ext.Reactions[p.Emoji] = uids
	}
	extJSON, err := encodeExt(ext)
	if err != nil {
		return nil, errx.From(err)
	}
	msg.Ext = extJSON
	if err := s.repo.UpdateMessage(ctx, *msg); err != nil {
		return nil, errx.From(err)
	}

	members, _ := s.repo.MembersOf(ctx, msg.ConvID)
	_ = s.bus.Publish(ctx, eventbus.TopicMsgReaction, messageapi.MsgReactionEvent{
		MsgID: msg.ID, ConvID: msg.ConvID, Seq: msg.Seq, Reactions: ext.Reactions, MemberIDs: members,
	})
	return &messageapi.ReactionResult{MsgID: msg.ID, Reactions: ext.Reactions}, nil
}

// Typing 正在输入（D03 INT-IM-11）：瞬时事件——不落库、错误不重试；TTL 5s 由客户端承担。
func (s *Service) Typing(ctx context.Context, userID int64, p messageapi.TypingPayload) error {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return err
	}
	if err := s.mustActiveMember(ctx, convID, userID); err != nil {
		return err
	}
	members, _ := s.repo.MembersOf(ctx, convID)
	others := make([]int64, 0, len(members))
	for _, m := range members {
		if m != userID {
			others = append(others, m)
		}
	}
	_ = s.bus.Publish(ctx, eventbus.TopicMsgTyping, messageapi.TypingEvent{
		ConvID: convID, UserID: userID, OtherMemberIDs: others,
	})
	return nil
}

// UpdateConvState 置顶/免打扰/草稿（D03 API-IM-13）：按字段覆盖，多端经 conv.updated(kind=state) 同步。
func (s *Service) UpdateConvState(ctx context.Context, userID, convID int64, patch messageapi.ConvStatePatch) (*messageapi.ConvStateResult, error) {
	if _, err := s.repo.GetConversation(ctx, convID); err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	if err := s.mustActiveMember(ctx, convID, userID); err != nil {
		return nil, err
	}
	cur, err := s.repo.UserConvState(ctx, userID, convID)
	if err != nil {
		return nil, errx.From(err)
	}
	next := cur
	if patch.Pinned != nil {
		next.Pinned = *patch.Pinned
	}
	if patch.Mute != nil {
		next.Mute = *patch.Mute
	}
	if patch.Draft != nil {
		if len([]rune(*patch.Draft)) > s.opts.MaxDraftRunes {
			return nil, errx.New(errx.CodeIMDraftTooLong, "草稿超过长度限制")
		}
		next.Draft = *patch.Draft
	}
	if err := s.repo.SetUserConvState(ctx, userID, convID, next); err != nil {
		return nil, errx.From(err)
	}
	_ = s.bus.Publish(ctx, eventbus.TopicConvUpdated, messageapi.ConvStateEvent{
		ConvID: convID, UserID: userID, State: patch,
		Applied: messageapi.ConvStateResult{Pinned: next.Pinned, Mute: next.Mute, Draft: next.Draft},
	})
	return &messageapi.ConvStateResult{Pinned: next.Pinned, Mute: next.Mute, Draft: next.Draft}, nil
}

// Forward 转发（D03 API-IM-09）：逐条保真转发 / 合并 ≤30；失败逐条回报不上抛。
func (s *Service) Forward(ctx context.Context, userID int64, p messageapi.ForwardPayload) (*messageapi.ForwardResult, error) {
	targetConv, err := parseConvID(p.TargetConvID)
	if err != nil {
		return nil, err
	}
	if p.Mode != "merge" && p.Mode != "one_by_one" {
		return nil, errx.New(errx.CodeBadRequest, "mode 应为 merge/one_by_one")
	}
	if len([]rune(p.Note)) > 500 {
		return nil, errx.New(errx.CodeBadRequest, "附言 ≤500 字")
	}
	if len(p.MsgIDs) == 0 {
		return nil, errx.New(errx.CodeBadRequest, "msg_ids 必填")
	}
	if len(p.MsgIDs) > 30 {
		return nil, errx.New(errx.CodeIMMergeForwardLimit, "合并转发超限（≤30 条）")
	}
	if _, err := s.repo.GetConversation(ctx, targetConv); err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "目标会话不存在")
	}
	if err := s.mustActiveMember(ctx, targetConv, userID); err != nil {
		return nil, err
	}

	// 附言随首条发送（D03 API-IM-09）
	result := &messageapi.ForwardResult{Failed: []messageapi.ForwardItem{}}
	sent := 0
	if p.Note != "" {
		if _, err := s.sendForwardCopy(ctx, userID, targetConv, &messageapi.Message{
			Type: "text", Body: mustJSON(textBody{Text: p.Note}),
		}); err != nil {
			return nil, err // 目标会话问题（禁言/只读）直接上抛
		}
		sent++
	}

	if p.Mode == "merge" {
		items := make([]map[string]any, 0, len(p.MsgIDs))
		for _, idStr := range p.MsgIDs {
			src, err := s.visibleMessage(ctx, userID, idStr)
			if err != nil {
				result.Failed = append(result.Failed, messageapi.ForwardItem{MsgID: idStr, Code: int(errx.From(err).Code)})
				continue
			}
			items = append(items, map[string]any{
				"sender_id":   fmt.Sprintf("%d", src.SenderID),
				"sender_name": s.nameOf(src.SenderID),
				"type":        src.Type,
				"digest":      digestOf(*src),
				"origin_conv": fmt.Sprintf("%d", src.ConvID),
				"origin_seq":  src.Seq,
			})
		}
		if len(items) > 0 {
			body := map[string]any{"title": "聊天记录", "count": len(items), "items": items}
			if _, err := s.sendForwardCopy(ctx, userID, targetConv, &messageapi.Message{
				Type: "merge_forward", Body: mustJSON(body),
			}); err != nil {
				return nil, err
			}
			sent++
		}
		result.SentCount = sent
		return result, nil
	}

	// one_by_one：逐条保真（type/body 原样，reply/mentions 清除——引用属于原会话语境）
	for _, idStr := range p.MsgIDs {
		src, err := s.visibleMessage(ctx, userID, idStr)
		if err != nil {
			result.Failed = append(result.Failed, messageapi.ForwardItem{MsgID: idStr, Code: int(errx.From(err).Code)})
			continue
		}
		if _, err := s.sendForwardCopy(ctx, userID, targetConv, src); err != nil {
			result.Failed = append(result.Failed, messageapi.ForwardItem{MsgID: idStr, Code: int(errx.From(err).Code)})
			continue
		}
		result.SentCount++
	}
	return result, nil
}

// sendForwardCopy 以生成 cmid 走标准 Send 管线（复用禁言/敏感词/广播群校验）
func (s *Service) sendForwardCopy(ctx context.Context, userID, targetConv int64, src *messageapi.Message) (*messageapi.SendResult, error) {
	cmid := fmt.Sprintf("fwd-%d-%d", src.ID, s.opts.Now().UnixNano())
	return s.Send(ctx, userID, messageapi.SendPayload{
		ConvID:      messageapi.ConvID(fmt.Sprintf("%d", targetConv)),
		ClientMsgID: cmid, Type: src.Type, Body: src.Body,
	})
}

// visibleMessage 拉取并校验来源可见性（成员身份 + 未撤回——撤回消息正文不可再分发）
func (s *Service) visibleMessage(ctx context.Context, userID int64, idStr string) (*messageapi.Message, error) {
	id, err := parseMsgID(idStr)
	if err != nil {
		return nil, err
	}
	msg, err := s.repo.GetMessageByID(ctx, id)
	if err != nil {
		return nil, errx.New(errx.CodeIMMessageNotFound, "消息不存在")
	}
	if msg.Status == messageapi.MsgRecalled {
		return nil, errx.New(errx.CodeIMMessageNotFound, "已撤回的消息不可转发")
	}
	if err := s.mustActiveMember(ctx, msg.ConvID, userID); err != nil {
		return nil, err
	}
	return msg, nil
}

// parseMsgID 字符串消息 ID（雪花/自增）统一解析
func parseMsgID(s string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || id <= 0 {
		return 0, errx.New(errx.CodeBadRequest, "msg_id 非法")
	}
	return id, nil
}

// mustActiveMember 会话存活 + 本人是在群成员（3002/3001/3019）
func (s *Service) mustActiveMember(ctx context.Context, convID, userID int64) error {
	conv, err := s.repo.GetConversation(ctx, convID)
	if err != nil {
		return errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	if conv.Status != messageapi.ConvActive {
		return errx.New(errx.CodeIMConvDissolved, "会话已解散")
	}
	member, _ := s.repo.MemberOf(ctx, convID, userID)
	if member == nil || member.Status != 1 {
		return errx.New(errx.CodeIMNotInConversation, "不在会话中")
	}
	return nil
}

// ── ext 编解码小工具 ──

func decodeExt(raw json.RawMessage) messageapi.MsgExt {
	var ext messageapi.MsgExt
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &ext)
	}
	return ext
}

func encodeExt(ext messageapi.MsgExt) (json.RawMessage, error) {
	if ext.Reactions == nil && ext.ReplyDigest == nil {
		return nil, nil
	}
	b, err := json.Marshal(ext)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func containsStr(list []string, s string) bool {
	for _, e := range list {
		if e == s {
			return true
		}
	}
	return false
}

func removeStr(list []string, s string) []string {
	out := list[:0]
	for _, e := range list {
		if e != s {
			out = append(out, e)
		}
	}
	return out
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
