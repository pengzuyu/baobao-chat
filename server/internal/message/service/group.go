// 群管理全链路（D03 §3.5 PIM-05 / §3.6 PIM-06 / §4.1 INT-IM-15~19 / §5.2 conv.* 事件）：
// 每个操作走「角色矩阵校验（04 篇 §4.5.1：owner>admin>member）→ 落库 → 系统消息
// （PIM-12 kind，复用 Send 标准扇出管线）→ 发布 conv.updated」四段式。
// 错误码复用已注册表：3010 上限 / 3011 目标不可加入 / 3012 已在会话 / 3014 @全体
// / 3015 无权（群管理通用拒绝）/ 3016 群主不可退群 / 3002 解散 / 3019 会话不存在。
package messageservice

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	messageapi "github.com/baobaochat/server/internal/message/api"
	messagerepo "github.com/baobaochat/server/internal/message/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/eventbus"
)

// receiptPanelMemberLimit 已读回执面板展开名单的参与成员上限（OQ-B04 拍板：
// >200 人群已读"仅计数不展开名单"——大群名单查询/渲染/扰动成本高）
const receiptPanelMemberLimit = 200

// hasMentionAll mentions 是否含 @全体（Send 的 mention_all_policy 校验用）
func hasMentionAll(ms []messageapi.Mention) bool {
	for _, m := range ms {
		if m.All {
			return true
		}
	}
	return false
}

// parseUID 字符串 uid（ID 透出契约）统一解析
func parseUID(s string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || id <= 0 {
		return 0, errx.New(errx.CodeBadRequest, "uid 非法")
	}
	return id, nil
}

// memberRank 角色权重：owner(3) > admin(2) > member(1)；publisher(0) 广播群专用
func memberRank(role int) int {
	switch role {
	case messageapi.MemberOwner:
		return 3
	case messageapi.MemberAdmin:
		return 2
	case messageapi.MemberMember:
		return 1
	}
	return 0
}

// convMemberCap 会话人数上限（普通群 500 / 广播群 5000，3010）
func (s *Service) convMemberCap(convType int) int {
	if convType == messageapi.ConvBroadcast {
		return s.opts.MaxBroadcastMembers
	}
	return s.opts.MaxGroupMembers
}

// mustActiveGroupConv 群/广播群存在且未解散（3019/3002/9001）
func (s *Service) mustActiveGroupConv(ctx context.Context, convID int64) (*messagerepo.Conversation, error) {
	conv, err := s.repo.GetConversation(ctx, convID)
	if err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	if conv.Status != messageapi.ConvActive {
		return nil, errx.New(errx.CodeIMConvDissolved, "会话已解散")
	}
	if conv.Type == messageapi.ConvSingle {
		return nil, errx.New(errx.CodeBadRequest, "单聊不支持该操作")
	}
	return conv, nil
}

// mustGroupOperator 操作者在群且返回其成员行（3019/3002/3001）
func (s *Service) mustGroupOperator(ctx context.Context, convID, userID int64) (*messagerepo.Conversation, *messagerepo.Member, error) {
	conv, err := s.mustActiveGroupConv(ctx, convID)
	if err != nil {
		return nil, nil, err
	}
	member, _ := s.repo.MemberOf(ctx, convID, userID)
	if member == nil || member.Status != 1 {
		return nil, nil, errx.New(errx.CodeIMNotInConversation, "不在会话中")
	}
	return conv, member, nil
}

// userExists 目标用户有效性（NameOf 注入时解析失败 → 3011 目标不可加入；未注入跳过）
func (s *Service) userExists(uid int64) bool {
	if s.opts.NameOf == nil {
		return true
	}
	return s.opts.NameOf(uid) != ""
}

// sendSystem 系统消息占位（PIM-12）：跳过成员/禁言校验（操作者可能已离群、会话可能已解散），
// 其余复用 Send 标准管线——seq 分配/落库/冗余/发布 msg.created 全端扇出。
// actor 缺省填操作者；join_by_apply 等无操作者语境由调用方显式留空（端内模板忽略）。
func (s *Service) sendSystem(ctx context.Context, convID, actorID int64, body messageapi.SystemBody) {
	if body.Actor == "" {
		body.Actor = strconv.FormatInt(actorID, 10)
		body.ActorName = s.nameOf(actorID)
	}
	s.sendCore(ctx, convID, actorID, messageapi.SendPayload{
		ConvID:      messageapi.ConvID(strconv.FormatInt(convID, 10)),
		ClientMsgID: fmt.Sprintf("sys-%d", nextMsgID()), // 全局自增：时钟注入下也唯一
		Type:        "system",
		Body:        mustJSON(body),
	})
}

// sendCore Send 的免校验核心（seq 分配→落库→冗余→已读→msg.created 扇出）。
// 返回落库消息（失败返回 nil；系统侧调用方需要回链 msg_id）。
func (s *Service) sendCore(ctx context.Context, convID, senderID int64, p messageapi.SendPayload) *messageapi.Message {
	now := s.opts.Now()
	lock := s.convLock(convID)
	lock.Lock()
	seq, err := s.repo.AllocSeq(ctx, convID)
	if err != nil {
		lock.Unlock()
		return nil
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
		return nil
	}
	lock.Unlock()
	_ = s.repo.TouchConversation(ctx, convID, seq, msg.TS)
	_ = s.repo.SetReadSeq(ctx, convID, senderID, seq)
	members, _ := s.repo.MembersOf(ctx, convID)
	_ = s.bus.Publish(ctx, eventbus.TopicMsgCreated, messageapi.MsgCreatedEvent{
		Message: msg, MemberIDs: members,
	})
	return &msg
}

// groupSettingDTO 群设置转 DTO（毫秒化可空时间）
func groupSettingDTO(convID int64, gs messagerepo.GroupSetting) *messageapi.GroupSettingDTO {
	dto := &messageapi.GroupSettingDTO{
		ConvID:           strconv.FormatInt(convID, 10),
		JoinMode:         gs.JoinMode,
		InvitePolicy:     gs.InvitePolicy,
		MentionAllPolicy: gs.MentionAllPolicy,
		HistoryVisible:   gs.HistoryVisible,
		Announcement:     gs.Announcement,
	}
	if !gs.MuteAllUntil.IsZero() {
		dto.MuteAllUntil = gs.MuteAllUntil.UnixMilli()
	}
	if !gs.AnnouncementTS.IsZero() {
		dto.AnnouncementTs = gs.AnnouncementTS.UnixMilli()
	}
	return dto
}

// publishConvUpdated 发布 conv.updated 事件（gateway 订阅后推快照给 MemberIDs）
func (s *Service) publishConvUpdated(ctx context.Context, conv *messagerepo.Conversation,
	kind string, operatorID int64, deltas []messageapi.MemberDelta, memberIDs []int64,
	setting *messageapi.GroupSettingDTO) {
	_ = s.bus.Publish(ctx, eventbus.TopicConvUpdated, messageapi.ConvUpdatedEvent{
		Kind: kind, ConvID: conv.ID, Type: conv.Type, Name: conv.Name, OwnerID: conv.OwnerID,
		LatestSeq: conv.LatestSeq, MemberCount: conv.MemberCount, Status: conv.Status,
		Setting: setting, OperatorID: operatorID, MembersDelta: deltas, MemberIDs: memberIDs,
	})
}

// displayConvName 会话显示名：单聊=对端显示名（微信同款；种子/历史行存的
// "alice-bob" 双拼名不面向用户），群/广播群=会话名。对端解析失败回落原 Name。
func (s *Service) displayConvName(ctx context.Context, conv *messagerepo.Conversation, viewerID int64) string {
	if conv.Type != messageapi.ConvSingle {
		return conv.Name
	}
	ids, err := s.repo.MembersOf(ctx, conv.ID)
	if err != nil {
		return conv.Name
	}
	for _, id := range ids {
		if id != viewerID {
			if n := s.nameOf(id); n != "" {
				return n
			}
		}
	}
	return conv.Name
}

// buildDetail 会话详情组装（API-IM-03：成员概要全量简版 + group_setting + my）
func (s *Service) buildDetail(ctx context.Context, conv *messagerepo.Conversation, viewerID int64) (*messageapi.ConvDetailDTO, error) {
	r, _ := s.repo.GetReceipt(ctx, conv.ID, viewerID)
	st, _ := s.repo.UserConvState(ctx, viewerID, conv.ID)
	unread := conv.LatestSeq - r.ReadSeq
	if unread < 0 {
		unread = 0
	}
	dto := &messageapi.ConvDetailDTO{
		ConversationDTO: messageapi.ConversationDTO{
			ID: strconv.FormatInt(conv.ID, 10), Type: conv.Type, Name: s.displayConvName(ctx, conv, viewerID),
			OwnerID:   strconv.FormatInt(conv.OwnerID, 10),
			LatestSeq: conv.LatestSeq, LastMsgTS: conv.LastMsgTS, MemberCount: conv.MemberCount,
			Status: conv.Status,
			My: messageapi.UserConvStateDTO{
				Pinned: st.Pinned, Mute: st.Mute, Draft: st.Draft,
				ReadSeq: r.ReadSeq, UnreadBadge: unread,
			},
		},
		Members: []messageapi.MemberDTO{},
	}
	if conv.Type != messageapi.ConvSingle {
		gs, _ := s.repo.GetGroupSetting(ctx, conv.ID)
		dto.GroupSetting = groupSettingDTO(conv.ID, gs)
	}
	if m, _ := s.repo.MemberOf(ctx, conv.ID, viewerID); m != nil {
		dto.MyRole = m.Role
		if !m.MuteUntil.IsZero() {
			dto.MyMuteUntil = m.MuteUntil.UnixMilli()
		}
	}
	rows, err := s.repo.ListMembersDetailed(ctx, conv.ID)
	if err != nil {
		return nil, errx.From(err)
	}
	for _, m := range rows {
		dto.Members = append(dto.Members, s.memberDTO(m))
	}
	return dto, nil
}

// memberDTO 成员行 → DTO（名称实时解析）
func (s *Service) memberDTO(m messagerepo.Member) messageapi.MemberDTO {
	dto := messageapi.MemberDTO{
		UID: strconv.FormatInt(m.UserID, 10), DisplayName: s.nameOf(m.UserID),
		Role: m.Role, Status: m.Status,
	}
	if !m.MuteUntil.IsZero() {
		dto.MuteUntil = m.MuteUntil.UnixMilli()
	}
	if !m.JoinAt.IsZero() {
		dto.JoinAt = m.JoinAt.UnixMilli()
	}
	return dto
}

// ── conv.create（D03 §5.2；INT-IM-15）──

// CreateConversation 建会话：单聊去重复用 / 建群校验 / 广播群创建者=publisher。
// ack 载荷 {conv}（ConvDetailDTO）。
func (s *Service) CreateConversation(ctx context.Context, userID int64, p messageapi.ConvCreatePayload) (*messageapi.ConvDetailDTO, error) {
	if p.Type != messageapi.ConvSingle && p.Type != messageapi.ConvGroup && p.Type != messageapi.ConvBroadcast {
		return nil, errx.New(errx.CodeBadRequest, "type 应为 1/2/3")
	}
	// 成员解析 + 去重（剔除创建者自身）
	uids := make([]int64, 0, len(p.MemberIDs))
	seen := map[int64]bool{userID: true}
	for _, raw := range p.MemberIDs {
		uid, err := parseUID(raw)
		if err != nil {
			return nil, err
		}
		if seen[uid] {
			continue
		}
		seen[uid] = true
		uids = append(uids, uid)
	}
	if p.Type == messageapi.ConvSingle && len(uids) != 1 {
		return nil, errx.New(errx.CodeBadRequest, "单聊 member_ids 恰 1 人")
	}
	if p.Type != messageapi.ConvSingle && strings.TrimSpace(p.Name) == "" {
		return nil, errx.New(errx.CodeBadRequest, "群聊 name 必填")
	}
	if len([]rune(p.Name)) > s.opts.MaxGroupName {
		return nil, errx.New(errx.CodeBadRequest, fmt.Sprintf("群名 ≤%d 字", s.opts.MaxGroupName))
	}
	// 目标有效性（3011）
	for _, uid := range uids {
		if !s.userExists(uid) {
			return nil, errx.New(errx.CodeIMTargetNotJoinable, "目标用户不可加入")
		}
	}
	// 单聊去重：同对成员已有 active 单聊直接复用（INT-IM-15）
	if p.Type == messageapi.ConvSingle {
		if existing, _ := s.repo.FindSingleConv(ctx, userID, uids[0]); existing != nil {
			return s.buildDetail(ctx, existing, userID)
		}
	}
	// 上限预检：创建者 + 成员 ≤ 上限（3010）
	limit := s.convMemberCap(p.Type)
	if 1+len(uids) > limit {
		return nil, errx.New(errx.CodeIMMemberLimit, fmt.Sprintf("成员数超上限 %d", limit))
	}

	// 落库：会话 + 成员（创建者 owner/publisher）+ 群设置默认行
	conv, err := s.repo.CreateConversation(ctx, messagerepo.Conversation{
		TenantID: 1, Type: p.Type, Name: p.Name,
	})
	if err != nil {
		return nil, errx.From(err)
	}
	creatorRole := messageapi.MemberOwner
	if p.Type == messageapi.ConvBroadcast {
		creatorRole = messageapi.MemberPublisher // 广播群：创建者即唯一可发言角色（04 篇 §4.5.4）
	}
	if err := s.repo.UpdateConversationMeta(ctx, conv.ID, "", userID); err != nil {
		return nil, errx.From(err)
	}
	if err := s.repo.AddMember(ctx, messagerepo.Member{
		ConvID: conv.ID, UserID: userID, Role: creatorRole, Status: 1,
	}); err != nil {
		return nil, errx.From(err)
	}
	for _, uid := range uids {
		if err := s.repo.AddMember(ctx, messagerepo.Member{
			ConvID: conv.ID, UserID: uid, Role: messageapi.MemberMember, Status: 1,
		}); err != nil {
			return nil, errx.From(err)
		}
	}
	if p.Type != messageapi.ConvSingle {
		if err := s.repo.UpsertGroupSetting(ctx, messagerepo.DefaultGroupSetting(conv.ID)); err != nil {
			return nil, errx.From(err)
		}
	}
	// 系统消息：group.created（PIM-12）+ 每位受邀成员 member.joined（04 篇 §4.5.2 邀请文案）。
	// 仅群聊/广播群——单聊是两人私密对话不落群生命周期文案（2026-11-12 用户报
	// 「发消息却显示创建了群聊/邀请加入」；残迹单聊里的错误系统消息另行数据清理）
	if p.Type != messageapi.ConvSingle {
		s.sendSystem(ctx, conv.ID, userID, messageapi.SystemBody{
			Kind: messageapi.SysKindGroupCreated, Group: p.Name,
		})
		for _, uid := range uids {
			s.sendSystem(ctx, conv.ID, userID, messageapi.SystemBody{
				Kind: messageapi.SysKindMemberJoined, Target: strconv.FormatInt(uid, 10),
				TargetName: s.nameOf(uid), Group: p.Name,
			})
		}
	}
	fresh, _ := s.repo.GetConversation(ctx, conv.ID)
	members, _ := s.repo.MembersOf(ctx, conv.ID)
	s.publishConvUpdated(ctx, fresh, "meta", userID, nil, members, nil)
	return s.buildDetail(ctx, fresh, userID)
}

// ── conv.quit（INT-IM-19/04 篇 §4.5.2）──

// QuitConversation 退群：owner 3016 拒绝（引导转让/解散）；系统消息 member.quit。
func (s *Service) QuitConversation(ctx context.Context, userID, convID int64) error {
	conv, member, err := s.mustGroupOperator(ctx, convID, userID)
	if err != nil {
		return err
	}
	if member.Role == messageapi.MemberOwner {
		return errx.New(errx.CodeIMOwnerCannotQuit, "群主不可退群，请先转让或解散")
	}
	// 扇出快照先取：退群者本人也要收到 conv.updated（端内强制退出会话视图）
	members, _ := s.repo.MembersOf(ctx, convID)
	if err := s.repo.QuitMember(ctx, convID, userID); err != nil {
		return errx.From(err)
	}
	s.sendSystem(ctx, convID, userID, messageapi.SystemBody{Kind: messageapi.SysKindMemberQuit})
	conv, _ = s.repo.GetConversation(ctx, convID)
	s.publishConvUpdated(ctx, conv, "member", userID, []messageapi.MemberDelta{
		{UID: userID, Role: member.Role, Status: 2},
	}, members, nil)
	return nil
}

// ── conv.member.add（INT-IM-16 邀请）──

// AddMembers 邀请入群：invite_policy 校验（member 无权 → 3015）；批量 ≤100/次；
// 上限 3010；已在会话 3012；目标不可加入 3011。
// join_mode=apply 时被邀端确认流（04 篇 §4.5.2）后续阶段接入（登记）。
func (s *Service) AddMembers(ctx context.Context, userID int64, p messageapi.MemberAddPayload) error {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return err
	}
	conv, operator, err := s.mustGroupOperator(ctx, convID, userID)
	if err != nil {
		return err
	}
	if len(p.UIDs) == 0 || len(p.UIDs) > 100 {
		return errx.New(errx.CodeBadRequest, "uids 1..100")
	}
	gs, _ := s.repo.GetGroupSetting(ctx, convID)
	// 邀请权限：invite_policy=2（仅管理）时 member 拒（广播群 publisher 视同管理）
	isMgr := operator.Role == messageapi.MemberOwner || operator.Role == messageapi.MemberAdmin ||
		operator.Role == messageapi.MemberPublisher
	if gs.InvitePolicy == messagerepo.InvitePolicyAdmin && !isMgr {
		return errx.New(errx.CodeIMApplyInvalid, "该群仅管理员可邀请")
	}
	// 目标逐个校验：3011 无效 / 3012 已在会话
	targets := make([]int64, 0, len(p.UIDs))
	dedup := map[int64]bool{}
	for _, raw := range p.UIDs {
		uid, err := parseUID(raw)
		if err != nil {
			return err
		}
		if dedup[uid] {
			continue
		}
		dedup[uid] = true
		if !s.userExists(uid) {
			return errx.New(errx.CodeIMTargetNotJoinable, "目标用户不可加入")
		}
		if m, _ := s.repo.MemberOf(ctx, convID, uid); m != nil && m.Status == 1 {
			return errx.New(errx.CodeIMALreadyInConv, "已在会话中")
		}
		targets = append(targets, uid)
	}
	// 余量预检（3010）
	if limit := s.convMemberCap(conv.Type); conv.MemberCount+len(targets) > limit {
		return errx.New(errx.CodeIMMemberLimit, fmt.Sprintf("成员数超上限 %d", limit))
	}
	deltas := make([]messageapi.MemberDelta, 0, len(targets))
	for _, uid := range targets {
		if err := s.repo.AddMember(ctx, messagerepo.Member{
			ConvID: convID, UserID: uid, Role: messageapi.MemberMember, Status: 1,
		}); err != nil {
			return errx.From(err)
		}
		s.sendSystem(ctx, convID, userID, messageapi.SystemBody{
			Kind: messageapi.SysKindMemberJoined, Target: strconv.FormatInt(uid, 10),
			TargetName: s.nameOf(uid), Group: conv.Name,
		})
		deltas = append(deltas, messageapi.MemberDelta{UID: uid, Role: messageapi.MemberMember, Status: 1})
	}
	conv, _ = s.repo.GetConversation(ctx, convID)
	members, _ := s.repo.MembersOf(ctx, convID)
	s.publishConvUpdated(ctx, conv, "member", userID, deltas, members, nil)
	return nil
}

// ── conv.member.remove（INT-IM-17 移出）──

// RemoveMember 移出：owner 可移 admin/member；admin 仅 member 级（矩阵 → 3015）。
func (s *Service) RemoveMember(ctx context.Context, userID int64, p messageapi.MemberRemovePayload) error {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return err
	}
	conv, operator, err := s.mustGroupOperator(ctx, convID, userID)
	if err != nil {
		return err
	}
	if conv.Type == messageapi.ConvBroadcast {
		return errx.New(errx.CodeBadRequest, "广播群不支持移出")
	}
	if operator.Role != messageapi.MemberOwner && operator.Role != messageapi.MemberAdmin {
		return errx.New(errx.CodeIMApplyInvalid, "无权移出成员")
	}
	targetID, err := parseUID(p.UID)
	if err != nil {
		return err
	}
	if targetID == userID {
		return errx.New(errx.CodeBadRequest, "不能移出自己（退群走 conv.quit）")
	}
	target, _ := s.repo.MemberOf(ctx, convID, targetID)
	if target == nil || target.Status != 1 {
		return errx.New(errx.CodeIMTargetNotJoinable, "目标不在会话中")
	}
	// 矩阵：admin 不能动 owner/admin（04 篇 §4.5.1）
	if operator.Role == messageapi.MemberAdmin && memberRank(target.Role) >= memberRank(messageapi.MemberAdmin) {
		return errx.New(errx.CodeIMApplyInvalid, "管理员不能移出群主/管理员")
	}
	members, _ := s.repo.MembersOf(ctx, convID) // 含被移者：端内强制退出会话视图
	if err := s.repo.RemoveMember(ctx, convID, targetID); err != nil {
		return errx.From(err)
	}
	s.sendSystem(ctx, convID, userID, messageapi.SystemBody{
		Kind: messageapi.SysKindMemberRemoved, Target: p.UID,
		TargetName: s.nameOf(targetID), Group: conv.Name,
	})
	conv, _ = s.repo.GetConversation(ctx, convID)
	s.publishConvUpdated(ctx, conv, "member", userID, []messageapi.MemberDelta{
		{UID: targetID, Role: target.Role, Status: 3},
	}, members, nil)
	return nil
}

// ── conv.member.role（INT-IM-17/19 角色与转让）──

// SetMemberRole 角色变更（仅 owner）：role=1 转让（owner⇄）/ 2 设管 / 3 取消。
func (s *Service) SetMemberRole(ctx context.Context, userID int64, p messageapi.MemberRolePayload) error {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return err
	}
	conv, operator, err := s.mustGroupOperator(ctx, convID, userID)
	if err != nil {
		return err
	}
	if conv.Type != messageapi.ConvGroup {
		return errx.New(errx.CodeBadRequest, "仅群聊支持角色管理")
	}
	if operator.Role != messageapi.MemberOwner {
		return errx.New(errx.CodeIMApplyInvalid, "仅群主可设置角色")
	}
	if p.Role != messageapi.MemberOwner && p.Role != messageapi.MemberAdmin && p.Role != messageapi.MemberMember {
		return errx.New(errx.CodeBadRequest, "role 应为 1/2/3")
	}
	targetID, err := parseUID(p.UID)
	if err != nil {
		return err
	}
	target, _ := s.repo.MemberOf(ctx, convID, targetID)
	if target == nil || target.Status != 1 {
		return errx.New(errx.CodeIMTargetNotJoinable, "目标不在会话中")
	}
	if targetID == userID && p.Role != messageapi.MemberOwner {
		return errx.New(errx.CodeBadRequest, "群主不能降级自己（转让 role=1 或解散）")
	}

	var deltas []messageapi.MemberDelta
	if p.Role == messageapi.MemberOwner {
		// 转让：target 升 owner、操作者降 member（危险确认在端内，D01 §8）
		if err := s.repo.UpdateConversationMeta(ctx, convID, "", targetID); err != nil {
			return errx.From(err)
		}
		if err := s.repo.UpdateMemberRole(ctx, convID, targetID, messageapi.MemberOwner, 1); err != nil {
			return errx.From(err)
		}
		if err := s.repo.UpdateMemberRole(ctx, convID, userID, messageapi.MemberMember, 1); err != nil {
			return errx.From(err)
		}
		s.sendSystem(ctx, convID, userID, messageapi.SystemBody{
			Kind: messageapi.SysKindOwnerTransferred, Target: p.UID,
			TargetName: s.nameOf(targetID), Group: conv.Name,
		})
		deltas = []messageapi.MemberDelta{
			{UID: targetID, Role: messageapi.MemberOwner, Status: 1},
			{UID: userID, Role: messageapi.MemberMember, Status: 1},
		}
	} else {
		if err := s.repo.UpdateMemberRole(ctx, convID, targetID, p.Role, 1); err != nil {
			return errx.From(err)
		}
		extra := "member"
		if p.Role == messageapi.MemberAdmin {
			extra = "admin"
		}
		s.sendSystem(ctx, convID, userID, messageapi.SystemBody{
			Kind: messageapi.SysKindMemberRoleChanged, Target: p.UID, Extra: extra,
			TargetName: s.nameOf(targetID), Group: conv.Name,
		})
		deltas = []messageapi.MemberDelta{{UID: targetID, Role: p.Role, Status: 1}}
	}
	conv, _ = s.repo.GetConversation(ctx, convID)
	members, _ := s.repo.MembersOf(ctx, convID)
	s.publishConvUpdated(ctx, conv, "member", userID, deltas, members, nil)
	return nil
}

// ── conv.setting（INT-IM-17/18 + 04 篇 §4.5.3）──

// UpdateConvSetting 群设置 patch：逐字段权限矩阵（owner/admin；广播群公告=publisher）
// 与取值校验，落库后按变更面发对应系统消息与 conv.updated（meta/setting/announcement）。
func (s *Service) UpdateConvSetting(ctx context.Context, userID int64, p messageapi.ConvSettingPayload) error {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return err
	}
	conv, operator, err := s.mustGroupOperator(ctx, convID, userID)
	if err != nil {
		return err
	}
	gs, _ := s.repo.GetGroupSetting(ctx, convID)
	isMgr := operator.Role == messageapi.MemberOwner || operator.Role == messageapi.MemberAdmin ||
		operator.Role == messageapi.MemberPublisher
	requireMgr := func() error {
		if !isMgr {
			return errx.New(errx.CodeIMApplyInvalid, "仅群主/管理员可修改")
		}
		return nil
	}

	metaChanged := false
	settingChanged := false
	annoChanged := false
	// muteDelta：单人禁言的成员增量（kind=setting 携带，端内按 uid==self 判输入框态）
	var muteDelta *messageapi.MemberDelta
	now := s.opts.Now()

	if p.Name != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		if len([]rune(*p.Name)) > s.opts.MaxGroupName || strings.TrimSpace(*p.Name) == "" {
			return errx.New(errx.CodeBadRequest, fmt.Sprintf("群名 1..%d 字", s.opts.MaxGroupName))
		}
		if err := s.repo.UpdateConversationMeta(ctx, convID, *p.Name, 0); err != nil {
			return errx.From(err)
		}
		metaChanged = true
	}
	if p.Announcement != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		if len([]rune(*p.Announcement)) > s.opts.MaxAnnouncement {
			return errx.New(errx.CodeBadRequest, fmt.Sprintf("公告 ≤%d 字", s.opts.MaxAnnouncement))
		}
		gs.Announcement = *p.Announcement
		gs.AnnouncementTS = now
		annoChanged = true
	}
	if p.MuteAllUntil != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		// 0 或过去时间 = 解除（端内开关语义）
		if *p.MuteAllUntil > 0 && *p.MuteAllUntil > now.UnixMilli() {
			gs.MuteAllUntil = time.UnixMilli(*p.MuteAllUntil)
		} else {
			gs.MuteAllUntil = time.Time{}
		}
		settingChanged = true
	}
	if p.MuteMember != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		targetID, err := parseUID(p.MuteMember.UID)
		if err != nil {
			return err
		}
		target, _ := s.repo.MemberOf(ctx, convID, targetID)
		if target == nil || target.Status != 1 {
			return errx.New(errx.CodeIMTargetNotJoinable, "目标不在会话中")
		}
		// 禁言矩阵：admin 不能禁 owner/admin（04 篇 §4.5.1）
		if operator.Role == messageapi.MemberAdmin && memberRank(target.Role) >= memberRank(messageapi.MemberAdmin) {
			return errx.New(errx.CodeIMApplyInvalid, "管理员不能禁言群主/管理员")
		}
		until := time.Time{}
		if p.MuteMember.Until > 0 {
			until = time.UnixMilli(p.MuteMember.Until)
			if until.After(now.Add(s.opts.MaxMuteDuration)) {
				return errx.New(errx.CodeBadRequest, "禁言时长 ≤30 天/次")
			}
		}
		if err := s.repo.MuteMember(ctx, convID, targetID, until); err != nil {
			return errx.From(err)
		}
		kind := messageapi.SysKindMemberUnmuted
		if !until.IsZero() {
			kind = messageapi.SysKindMemberMuted
		}
		body := messageapi.SystemBody{
			Kind: kind, Target: p.MuteMember.UID, TargetName: s.nameOf(targetID), Group: conv.Name,
		}
		if !until.IsZero() {
			body.Until = until.UnixMilli()
		}
		s.sendSystem(ctx, convID, userID, body)
		muteMs := int64(0)
		if !until.IsZero() {
			muteMs = until.UnixMilli()
		}
		muteDelta = &messageapi.MemberDelta{UID: targetID, Role: target.Role, Status: 1, MuteUntil: muteMs}
		settingChanged = true
	}
	if p.JoinMode != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		if *p.JoinMode < messagerepo.JoinModeDirect || *p.JoinMode > messagerepo.JoinModeInviteOnly {
			return errx.New(errx.CodeBadRequest, "join_mode 应为 1/2/3")
		}
		gs.JoinMode = *p.JoinMode
		settingChanged = true
	}
	if p.InvitePolicy != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		if *p.InvitePolicy != messagerepo.InvitePolicyAll && *p.InvitePolicy != messagerepo.InvitePolicyAdmin {
			return errx.New(errx.CodeBadRequest, "invite_policy 应为 1/2")
		}
		gs.InvitePolicy = *p.InvitePolicy
		settingChanged = true
	}
	if p.MentionAllPolicy != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		if *p.MentionAllPolicy < messagerepo.MentionAllPolicyAll || *p.MentionAllPolicy > messagerepo.MentionAllPolicyOff {
			return errx.New(errx.CodeBadRequest, "mention_all_policy 应为 1/2/3")
		}
		gs.MentionAllPolicy = *p.MentionAllPolicy
		settingChanged = true
	}
	if p.HistoryVisible != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		gs.HistoryVisible = *p.HistoryVisible
		settingChanged = true
	}
	if p.AvatarFileID != nil {
		if err := requireMgr(); err != nil {
			return err
		}
		metaChanged = true // 头像随 meta 面推送（快照字段，暂不落库独立行）
	}
	if !metaChanged && !settingChanged && !annoChanged {
		return errx.New(errx.CodeBadRequest, "patch 为空")
	}
	if settingChanged || annoChanged {
		if err := s.repo.UpsertGroupSetting(ctx, gs); err != nil {
			return errx.From(err)
		}
	}

	// 系统消息：公告 announcement.changed / 广播群 broadcast.published；全员禁言 mute.all.on/off
	if annoChanged {
		kind := messageapi.SysKindAnnouncementChanged
		if conv.Type == messageapi.ConvBroadcast {
			kind = messageapi.SysKindBroadcastPublished
		}
		s.sendSystem(ctx, convID, userID, messageapi.SystemBody{Kind: kind, Group: conv.Name})
	}
	if p.MuteAllUntil != nil {
		kind := messageapi.SysKindMuteAllOff
		body := messageapi.SystemBody{Kind: kind, Group: conv.Name}
		if !gs.MuteAllUntil.IsZero() {
			body.Kind = messageapi.SysKindMuteAllOn
			body.Until = gs.MuteAllUntil.UnixMilli()
		}
		s.sendSystem(ctx, convID, userID, body)
	}

	conv, _ = s.repo.GetConversation(ctx, convID)
	members, _ := s.repo.MembersOf(ctx, convID)
	if metaChanged {
		s.publishConvUpdated(ctx, conv, "meta", userID, nil, members, nil)
	}
	if settingChanged {
		var deltas []messageapi.MemberDelta
		if muteDelta != nil {
			deltas = []messageapi.MemberDelta{*muteDelta}
		}
		s.publishConvUpdated(ctx, conv, "setting", userID, deltas, members, groupSettingDTO(convID, gs))
	}
	if annoChanged {
		s.publishConvUpdated(ctx, conv, "announcement", userID, nil, members, groupSettingDTO(convID, gs))
		// 通知中心（PIM-09 系统公告分组）：全体在群成员 kind=announcement（操作者除外）。
		// 取舍登记：与 announcement.changed 系统消息同点直调（notify.go 包注释）
		s.notifyAnnouncement(ctx, conv, userID, gs.Announcement)
	}
	return nil
}

// ── conv.dissolve（INT-IM-19）──

// DissolveConversation 解散：仅 owner（广播群 publisher 创建者视同）；全端只读。
func (s *Service) DissolveConversation(ctx context.Context, userID, convID int64) error {
	conv, operator, err := s.mustGroupOperator(ctx, convID, userID)
	if err != nil {
		return err
	}
	if operator.Role != messageapi.MemberOwner && operator.Role != messageapi.MemberPublisher {
		return errx.New(errx.CodeIMApplyInvalid, "仅群主可解散")
	}
	members, _ := s.repo.MembersOf(ctx, convID)
	s.sendSystem(ctx, convID, userID, messageapi.SystemBody{Kind: messageapi.SysKindConvDissolved, Group: conv.Name})
	if err := s.repo.DissolveConversation(ctx, convID); err != nil {
		return errx.From(err)
	}
	conv, _ = s.repo.GetConversation(ctx, convID)
	s.publishConvUpdated(ctx, conv, "status", userID, nil, members, nil)
	return nil
}

// ── conv.apply / conv.apply.handle（PIM-06，D03 §3.6）──

// ApplyJoin 入群申请：join_mode=仅邀请拒（3015）；已在会话 3012；同群同人待审唯一
// （幂等返回原 apply_id）；申请 7 天未处理过期（status=4，懒判定）。
// ack 载荷 {apply_id}。
func (s *Service) ApplyJoin(ctx context.Context, userID int64, p messageapi.ApplyPayload) (*messageapi.ApplyResult, error) {
	convID, err := parseConvID(p.ConvID)
	if err != nil {
		return nil, err
	}
	conv, err := s.repo.GetConversation(ctx, convID)
	if err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	if conv.Status != messageapi.ConvActive {
		return nil, errx.New(errx.CodeIMConvDissolved, "会话已解散")
	}
	if conv.Type != messageapi.ConvGroup {
		return nil, errx.New(errx.CodeBadRequest, "仅群聊支持申请入群")
	}
	if m, _ := s.repo.MemberOf(ctx, convID, userID); m != nil && m.Status == 1 {
		return nil, errx.New(errx.CodeIMALreadyInConv, "已在会话中")
	}
	gs, _ := s.repo.GetGroupSetting(ctx, convID)
	if gs.JoinMode == messagerepo.JoinModeInviteOnly {
		return nil, errx.New(errx.CodeIMApplyInvalid, "该群仅邀请可入")
	}
	if len([]rune(p.Reason)) > s.opts.MaxApplyReason {
		return nil, errx.New(errx.CodeBadRequest, fmt.Sprintf("申请理由 ≤%d 字", s.opts.MaxApplyReason))
	}
	// 待审唯一：命中未过期的待审申请 → 幂等返回原 id（uk_apply_pending 兜底）
	now := s.opts.Now()
	pending, _ := s.repo.ListAppliesByConv(ctx, convID, messagerepo.ApplyPending)
	for _, a := range pending {
		if a.UserID != userID {
			continue
		}
		if now.Sub(a.CreatedAt) >= s.opts.ApplyTTL {
			_ = s.repo.UpdateApplyStatus(ctx, a.ID, messagerepo.ApplyExpired, 0, now)
			break
		}
		return &messageapi.ApplyResult{ApplyID: strconv.FormatInt(a.ID, 10)}, nil
	}
	apply, err := s.repo.CreateApply(ctx, messagerepo.Apply{
		ConvID: convID, UserID: userID, Reason: p.Reason,
		Status: messagerepo.ApplyPending, CreatedAt: now,
	})
	if err != nil {
		return nil, errx.From(err)
	}
	// 审批卡（PIM-06）：系统消息流内 kind=apply.submitted，owner/admin 端渲染按钮
	s.sendSystem(ctx, convID, userID, messageapi.SystemBody{
		Kind: messageapi.SysKindApplySubmitted, Group: conv.Name,
		Extra: p.Reason, ApplyID: strconv.FormatInt(apply.ID, 10),
	})
	// 通知中心双通道（INT-IM-16）：审批通知推 owner/admin（PIM-09 入群审批分组）。
	// 取舍登记：无 conv.apply 专属 topic——service 内直调通知生成器（notify.go 包注释）
	s.notifyApply(ctx, conv, userID, p.Reason)
	return &messageapi.ApplyResult{ApplyID: strconv.FormatInt(apply.ID, 10)}, nil
}

// HandleApply 审批：仅 owner/admin（3015）；approve 入群（上限 3010）+ member.joined(通过申请)；
// 拒绝方通知通道（申请人在群外）后续接通知中心（登记）。
func (s *Service) HandleApply(ctx context.Context, userID int64, p messageapi.ApplyHandlePayload) error {
	if p.Action != "approve" && p.Action != "reject" {
		return errx.New(errx.CodeBadRequest, "action 应为 approve/reject")
	}
	applyID, err := strconv.ParseInt(strings.TrimSpace(p.ApplyID), 10, 64)
	if err != nil || applyID <= 0 {
		return errx.New(errx.CodeBadRequest, "apply_id 非法")
	}
	apply, err := s.repo.GetApplyByID(ctx, applyID)
	if err != nil {
		return errx.New(errx.CodeIMApplyInvalid, "申请不存在")
	}
	// 懒过期：待审超 7 天 → status=4，拒绝处理（D03 §3.6）
	now := s.opts.Now()
	if apply.Status == messagerepo.ApplyPending && now.Sub(apply.CreatedAt) >= s.opts.ApplyTTL {
		_ = s.repo.UpdateApplyStatus(ctx, applyID, messagerepo.ApplyExpired, 0, now)
		return errx.New(errx.CodeIMApplyInvalid, "申请已过期")
	}
	if apply.Status != messagerepo.ApplyPending {
		return errx.New(errx.CodeIMApplyInvalid, "申请已被处理")
	}
	conv, operator, err := s.mustGroupOperator(ctx, apply.ConvID, userID)
	if err != nil {
		return err
	}
	if operator.Role != messageapi.MemberOwner && operator.Role != messageapi.MemberAdmin {
		return errx.New(errx.CodeIMApplyInvalid, "无权审批")
	}

	if p.Action == "reject" {
		if err := s.repo.UpdateApplyStatus(ctx, applyID, messagerepo.ApplyRejected, userID, now); err != nil {
			return errx.From(err)
		}
		return nil // 拒绝结果推申请人（群外无通道）→ 通知中心后续接入（登记）
	}

	// approve：上限预检（3010）→ 状态流转 → 入群 → 系统消息 + conv.updated(member)
	if limit := s.convMemberCap(conv.Type); conv.MemberCount+1 > limit {
		return errx.New(errx.CodeIMMemberLimit, fmt.Sprintf("成员数超上限 %d", limit))
	}
	if err := s.repo.UpdateApplyStatus(ctx, applyID, messagerepo.ApplyApproved, userID, now); err != nil {
		return errx.From(err)
	}
	if err := s.repo.AddMember(ctx, messagerepo.Member{
		ConvID: apply.ConvID, UserID: apply.UserID, Role: messageapi.MemberMember, Status: 1,
	}); err != nil {
		return errx.From(err)
	}
	// 申请通过路径：member.joined 走「通过申请加入」文案（无邀请者，PIM-12）
	s.sendSystem(ctx, apply.ConvID, apply.UserID, messageapi.SystemBody{
		Kind: messageapi.SysKindMemberJoined, JoinByApply: true,
		Target: strconv.FormatInt(apply.UserID, 10), TargetName: s.nameOf(apply.UserID), Group: conv.Name,
	})
	conv, _ = s.repo.GetConversation(ctx, apply.ConvID)
	members, _ := s.repo.MembersOf(ctx, apply.ConvID)
	s.publishConvUpdated(ctx, conv, "member", userID, []messageapi.MemberDelta{
		{UID: apply.UserID, Role: messageapi.MemberMember, Status: 1},
	}, members, nil)
	return nil
}

// ── REST（API-IM-03/05）──

// GetConvDetail 会话详情：非成员拒（3001）；解散会话历史可见（history_visible 只读）
func (s *Service) GetConvDetail(ctx context.Context, userID, convID int64) (*messageapi.ConvDetailDTO, error) {
	conv, err := s.repo.GetConversation(ctx, convID)
	if err != nil {
		return nil, errx.New(errx.CodeIMConvNotFound, "会话不存在")
	}
	m, _ := s.repo.MemberOf(ctx, convID, userID)
	if m == nil {
		return nil, errx.New(errx.CodeIMNotInConversation, "不在会话中")
	}
	return s.buildDetail(ctx, conv, userID)
}

// ListMembers 成员列表（API-IM-05 简版：在群成员；分页/role 过滤后续接入）
func (s *Service) ListMembers(ctx context.Context, userID, convID int64) ([]messageapi.MemberDTO, error) {
	if _, err := s.GetConvDetail(ctx, userID, convID); err != nil {
		return nil, err
	}
	rows, err := s.repo.ListMembersDetailed(ctx, convID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := []messageapi.MemberDTO{}
	for _, m := range rows {
		if m.Status == 1 {
			out = append(out, s.memberDTO(m))
		}
	}
	return out, nil
}

// ListReceiptPanel 已读回执面板（API-IM-06）：在群成员 ⋈ message_receipt，
// read_seq≥seq 判已读；无回执行=未读（并集口径）；发送者本人不入名单
// （自己的消息对自己恒已读，产品语义同企微）。成员即可查（本人或他人
// 消息的已读分布同权——租户 im.read_receipt 策略联动阶段二接）。
func (s *Service) ListReceiptPanel(ctx context.Context, userID, convID, seq int64) (*messageapi.ReceiptPanelDTO, error) {
	if seq <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "seq 必填")
	}
	if _, err := s.GetConvDetail(ctx, userID, convID); err != nil { // 成员权限校验复用
		return nil, err
	}
	// seq 对应消息须存在且属本会话（防跨会话探测成员）；repo 契约未命中=(nil,nil)
	m, err := s.repo.GetMessageBySeq(ctx, convID, seq)
	if err != nil {
		return nil, errx.From(err)
	}
	if m == nil {
		return nil, errx.New(errx.CodeNotFound, "消息不存在")
	}
	senderID := m.SenderID
	members, err := s.repo.ListMembersDetailed(ctx, convID)
	if err != nil {
		return nil, errx.From(err)
	}
	receipts, err := s.repo.ListReceipts(ctx, convID)
	if err != nil {
		return nil, errx.From(err)
	}
	readMap := make(map[int64]bool, len(receipts))
	for _, r := range receipts {
		if r.ReadSeq >= seq {
			readMap[r.UserID] = true
		}
	}
	dto := &messageapi.ReceiptPanelDTO{Seq: seq, Read: []messageapi.ReceiptMemberDTO{}, Unread: []messageapi.ReceiptMemberDTO{}}
	for _, mm := range members {
		if mm.Status != 1 || mm.UserID == senderID { // 仅在群成员参与；发送者不入名单
			continue
		}
		row := messageapi.ReceiptMemberDTO{UID: strconv.FormatInt(mm.UserID, 10), DisplayName: s.nameOf(mm.UserID)}
		if readMap[mm.UserID] {
			dto.ReadCount++
			dto.Read = append(dto.Read, row)
		} else {
			dto.UnreadCount++
			dto.Unread = append(dto.Unread, row)
		}
	}
	// 大群仅计数（OQ-B04）：参与成员 >200 不展开名单——置空列表，前端以计数卡呈现
	if dto.ReadCount+dto.UnreadCount > receiptPanelMemberLimit {
		dto.Truncated = true
		dto.Read, dto.Unread = nil, nil
	}
	return dto, nil
}

// decodeSystemBody body → SystemBody（测试断言用）
func decodeSystemBody(raw json.RawMessage) messageapi.SystemBody {
	var b messageapi.SystemBody
	_ = json.Unmarshal(raw, &b)
	return b
}
