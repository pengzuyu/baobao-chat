// 通知中心生成器与读写服务（D03 §3.9 PIM-09 / §4.1 INT-IM-22）。
//
// 事件源接线（进程内，四源）：
//
//	① TopicMsgCreated（New 装配期订阅）：
//	   mentions 命中 uid（all=true 命中全员，发送者本人除外）→ kind=mention；
//	   reply_to_seq 目标消息作者==接收者本人 → kind=reply（查原消息：GetMessageBySeq）。
//	② conv.apply：group.ApplyJoin 发 apply.submitted 审批系统消息处同步落通知。
//	   取舍登记：事件总线无 conv.apply 专属 topic——为免扩 topic 注册表选用「service 内
//	   直调通知生成器」（同进程内聚、与系统消息强一致；代价是跨域复用需重构，
//	   阶段二 NATS 拆分时补 TopicConvApply）。
//	③ announcement.changed / broadcast.published：group.UpdateConvSetting 内直调 →
//	   全体在群成员（操作者除外）kind=announcement。
//	④ agent_done：宿主上报 REST（ReportAgentTask，14 篇 §3.3 OQ-C32 定稿）——run 终态
//	   以用户 OBO token POST /notify/agent-tasks 上报；本服务落卡（kind=agent_done）+
//	   发布 TopicAgentTaskDone（gateway 跨端推 agent.task.completed）。cancelled 不落卡
//	   （用户主动取消无提醒价值），仅推 WS 事件供其它端刷新 run 面板。
//
// 聚合（生成侧）：同 (user, kind, conv_id) 10s 窗口内未读行 → 不新增行，原行 count+1、
// digest 更新（"×N"渲染）；窗口由 Options.Now 注入时钟判定（可测）。
// 勿扰/mute 用户照常生成——「勿扰时段只入中心不发系统通知」是客户端系统通知投递策略
// （INT-IM-22 / D01 §8），服务端不感知，登记。
// WS：生成成功 → 发布 TopicNotification（gateway 订阅推 notification.new 给目标 user）。
package messageservice

import (
	"context"
	"log"
	"strconv"

	messageapi "github.com/baobaochat/server/internal/message/api"
	messagerepo "github.com/baobaochat/server/internal/message/repo"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/eventbus"
)

// notifyDedupCap 幂等去重容量（与 gateway 同量级）
const notifyDedupCap = 4096

// subscribeNotification 装配期接线：msg.created → @我/回复我（New 内调用）
func (s *Service) subscribeNotification(bus eventbus.Bus) {
	bus.Subscribe(eventbus.TopicMsgCreated, func(ctx context.Context, evt eventbus.Event) error {
		// 至少一次投递去重：通知落行有副作用，重复事件不得重复生成
		return s.notifyDedup.Once(evt.ID, func() error {
			e, ok := evt.Payload.(messageapi.MsgCreatedEvent)
			if !ok {
				log.Printf("[notify] msg.created payload 类型异常: %T", evt.Payload)
				return nil
			}
			s.onMsgCreated(ctx, e)
			return nil
		})
	})
}

// onMsgCreated ①号事件源：mention（含 all 全员命中）+ reply（引用目标作者）
func (s *Service) onMsgCreated(ctx context.Context, e messageapi.MsgCreatedEvent) {
	msg := e.Message
	if msg.Type == "system" {
		return // 系统消息不进通知中心（apply/公告走各自直调路径）
	}
	// mention 目标集：显式 uid（∩成员，防越权通知非成员）+ all 命中全员；剔除发送者本人
	memberSet := map[int64]struct{}{}
	for _, uid := range e.MemberIDs {
		memberSet[uid] = struct{}{}
	}
	targets := map[int64]struct{}{}
	hasAll := false
	for _, m := range msg.Mentions {
		if m.All {
			hasAll = true
			continue
		}
		uid, err := parseUID(m.UID)
		if err != nil || uid == msg.SenderID {
			continue
		}
		if _, in := memberSet[uid]; in {
			targets[uid] = struct{}{}
		}
	}
	if hasAll {
		for uid := range memberSet {
			if uid != msg.SenderID {
				targets[uid] = struct{}{}
			}
		}
	}
	// reply 目标：原消息作者（本人自回复不通知）
	var replyTarget int64
	if msg.ReplyToSeq > 0 {
		if orig, err := s.repo.GetMessageBySeq(ctx, msg.ConvID, msg.ReplyToSeq); err == nil && orig != nil &&
			orig.SenderID != msg.SenderID {
			if _, in := memberSet[orig.SenderID]; in {
				replyTarget = orig.SenderID
			}
		}
	}
	if len(targets) == 0 && replyTarget == 0 {
		return
	}
	convName := s.convNameOf(ctx, msg.ConvID)
	digest := digestOf(msg)
	for uid := range targets {
		s.notifyEmit(ctx, uid, messageapi.NotifyKindMention, msg,
			msg.SenderName+" 在「"+convName+"」中@了你", digest)
	}
	if replyTarget > 0 {
		s.notifyEmit(ctx, replyTarget, messageapi.NotifyKindReply, msg,
			msg.SenderName+" 在「"+convName+"」中回复了你", digest)
	}
}

// notifyApply ②号事件源：入群申请 → owner/admin 收 kind=apply（审批卡在会话内，PIM-06）
func (s *Service) notifyApply(ctx context.Context, conv *messagerepo.Conversation, applicantID int64, reason string) {
	rows, err := s.repo.ListMembersDetailed(ctx, conv.ID)
	if err != nil {
		return
	}
	applicant := s.nameOf(applicantID)
	for _, m := range rows {
		if m.Status != 1 || (m.Role != messageapi.MemberOwner && m.Role != messageapi.MemberAdmin) {
			continue
		}
		if m.UserID == applicantID {
			continue // 申请人不可能是 owner/admin，防御性剔除
		}
		// 尽力关联 apply.submitted 系统消息（点击路由去会话；审批卡渲染依据 apply 流程）
		var msgID, seq int64
		if last, err := s.repo.LastMessage(ctx, conv.ID); err == nil && last != nil {
			msgID, seq = last.ID, last.Seq
		}
		s.notifyEmitRaw(ctx, m.UserID, messageapi.NotifyKindApply, conv.ID, msgID, seq,
			applicant+" 申请加入「"+conv.Name+"」", reason)
	}
}

// notifyAnnouncement ③号事件源：公告变更/广播发布 → 在群成员 kind=announcement（操作者除外）
func (s *Service) notifyAnnouncement(ctx context.Context, conv *messagerepo.Conversation, operatorID int64, text string) {
	members, err := s.repo.MembersOf(ctx, conv.ID)
	if err != nil {
		return
	}
	title := "「" + conv.Name + "」公告已更新"
	if conv.Type == messageapi.ConvBroadcast {
		title = "「" + conv.Name + "」发布了新公告"
	}
	digest := truncateRunes(text, 60)
	var msgID, seq int64
	if last, err := s.repo.LastMessage(ctx, conv.ID); err == nil && last != nil {
		msgID, seq = last.ID, last.Seq
	}
	for _, uid := range members {
		if uid == operatorID {
			continue
		}
		s.notifyEmitRaw(ctx, uid, messageapi.NotifyKindAnnouncement, conv.ID, msgID, seq, title, digest)
	}
}

// notifyEmit 消息源通知落行（mention/reply 统一入口）
func (s *Service) notifyEmit(ctx context.Context, userID int64, kind string, msg messageapi.Message, title, digest string) {
	s.notifyEmitRaw(ctx, userID, kind, msg.ConvID, msg.ID, msg.Seq, title, digest)
}

// notifyEmitRaw 通知生成核心：聚合写入（10s 窗口合并"×N"）→ 发布 notification.new
func (s *Service) notifyEmitRaw(ctx context.Context, userID int64, kind string, convID, msgID, seq int64, title, digest string) {
	n := messagerepo.Notification{
		UserID: userID, Kind: kind, ConvID: convID, MsgID: msgID, Seq: seq,
		Title: title, Digest: digest, Count: 1, CreatedAt: s.opts.Now(),
	}
	row, _, err := s.repo.InsertMergedNotification(ctx, n, s.opts.NotifyMergeWindow)
	if err != nil {
		// 通知属尽力而为通道：落库失败不阻断业务（死信告警属 bus 重试层职责）
		log.Printf("[notify] 通知落库失败 user=%d kind=%s: %v", userID, kind, err)
		return
	}
	push := messageapi.NotificationPushPayload{
		ID: strconv.FormatInt(row.ID, 10), Kind: row.Kind,
		ConvID: strconv.FormatInt(row.ConvID, 10), Title: row.Title, Digest: row.Digest,
		Count: row.Count, TS: row.CreatedAt.UnixMilli(),
	}
	_ = s.bus.Publish(ctx, eventbus.TopicNotification, messageapi.NotificationEvent{
		UserID: userID, Push: push,
	})
}

// convNameOf 会话名解析（通知标题用；失败回落空串）
func (s *Service) convNameOf(ctx context.Context, convID int64) string {
	if conv, err := s.repo.GetConversation(ctx, convID); err == nil && conv != nil {
		return conv.Name
	}
	return ""
}

// ── REST（D03 PIM-09 API-IM-14：列表/已读/未读数；越权防护=仓储层恒按 userID 过滤）──

// ListNotifications 通知列表：kind 分组 + unread_only + cursor（id 倒序）
func (s *Service) ListNotifications(ctx context.Context, userID int64, kind string, unreadOnly bool, cursor int64, limit int) (*messageapi.NotificationListResult, error) {
	if kind != "" && kind != messageapi.NotifyKindMention && kind != messageapi.NotifyKindReply &&
		kind != messageapi.NotifyKindApply && kind != messageapi.NotifyKindAgentDone &&
		kind != messageapi.NotifyKindAnnouncement {
		return nil, errx.New(errx.CodeBadRequest, "kind 应为 mention/reply/apply/agent_done/announcement")
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := s.repo.ListNotifications(ctx, messagerepo.NotificationFilter{
		UserID: userID, Kind: kind, UnreadOnly: unreadOnly, Cursor: cursor, Limit: limit + 1,
	})
	if err != nil {
		return nil, errx.From(err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	out := &messageapi.NotificationListResult{Items: []messageapi.NotificationItem{}, HasMore: hasMore}
	for _, n := range rows {
		item := messageapi.NotificationItem{
			ID: strconv.FormatInt(n.ID, 10), Kind: n.Kind,
			ConvID: strconv.FormatInt(n.ConvID, 10), MsgID: strconv.FormatInt(n.MsgID, 10),
			Seq: n.Seq, Title: n.Title, Digest: n.Digest, Count: n.Count,
			CreatedAt: n.CreatedAt.UnixMilli(),
		}
		if !n.ReadAt.IsZero() {
			item.ReadAt = n.ReadAt.UnixMilli()
		}
		if n.ConvID == 0 {
			item.ConvID = ""
		}
		if n.MsgID == 0 {
			item.MsgID = ""
		}
		out.Items = append(out.Items, item)
	}
	if hasMore && len(rows) > 0 {
		out.NextCursor = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	return out, nil
}

// MarkNotificationsRead 已读：ids（字符串 ID 透出契约）单条/多条；all 全部
func (s *Service) MarkNotificationsRead(ctx context.Context, userID int64, p messageapi.NotificationReadPayload) error {
	if !p.All && len(p.IDs) == 0 {
		return errx.New(errx.CodeBadRequest, "ids 与 all 至少其一")
	}
	ids := make([]int64, 0, len(p.IDs))
	for _, raw := range p.IDs {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			return errx.New(errx.CodeBadRequest, "ids 含非法值")
		}
		ids = append(ids, id)
	}
	_, err := s.repo.MarkNotificationsRead(ctx, userID, ids, p.All, s.opts.Now())
	if err != nil {
		return errx.From(err)
	}
	return nil
}

// UnreadNotificationCount 未读计数（红点数据源）
func (s *Service) UnreadNotificationCount(ctx context.Context, userID int64) (*messageapi.UnreadCountResult, error) {
	n, err := s.repo.CountUnreadNotifications(ctx, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	return &messageapi.UnreadCountResult{Count: n}, nil
}

// BroadcastNotice 平台公告广播（PAD-15 公告发布；admin 域经闭包注入）：
// 逐用户落通知（kind=announcement 系统公告分组）+ notification.new 推送；
// conv/msg 关联为 0（纯平台通知，非会话派生——点击路由到公告详情，端内处理）
func (s *Service) BroadcastNotice(ctx context.Context, _ int64, title, digest string, userIDs []int64) int {
	n := 0
	for _, uid := range userIDs {
		if uid <= 0 {
			continue
		}
		s.notifyEmitRaw(ctx, uid, messageapi.NotifyKindAnnouncement, 0, 0, 0, title, digest)
		n++
	}
	return n
}

// agentTaskKinds / agentTaskStatuses D16 agent_run 终态枚举（上报校验）
var (
	agentTaskKinds   = map[string]bool{"probe": true, "expert": true}
	agentTaskStatus  = map[string]bool{"done": true, "failed": true, "cancelled": true}
	agentTaskOutcome = map[string]string{"done": "已完成", "failed": "失败", "cancelled": "已取消"}
)

// ReportAgentTask ④号事件源：宿主上报 Agent 任务终态（14 篇 §3.3，OQ-C32）。
// 幂等键 run_id+status（宿主重试/事件总线重投不重复落卡）→
//   · done/failed：通知中心落卡（kind=agent_done，10s 聚合窗口内多 run 合并"×N"）
//     + notification.new 推送；
//   · cancelled：不落卡（用户主动取消无提醒价值），仅跨端 WS 事件刷新 run 面板；
//   · 全部终态：发布 TopicAgentTaskDone（gateway 推 agent.task.completed 给该 user
//     全部在线设备，payload 带 origin_did 由端侧自滤防双响）。
// 上报属尽力而为通道：宿主本地重试 3 次后放弃（14 篇 §3.3），服务端失败不回调宿主。
func (s *Service) ReportAgentTask(ctx context.Context, userID int64, p messageapi.AgentTaskReportPayload) error {
	if p.RunID == "" {
		return errx.New(errx.CodeBadRequest, "run_id 必填")
	}
	if !agentTaskKinds[p.Kind] {
		return errx.New(errx.CodeBadRequest, "kind 应为 probe/expert")
	}
	if !agentTaskStatus[p.Status] {
		return errx.New(errx.CodeBadRequest, "status 应为 done/failed/cancelled")
	}
	return s.notifyDedup.Once("agent-task:"+p.RunID+":"+p.Status, func() error {
		if p.Status == "done" || p.Status == "failed" {
			title := p.Title
			if title == "" {
				title = p.Kind
			}
			digest := truncateRunes(p.Summary, 60)
			// conv/msg 关联为 0：Agent 任务非会话派生，点击路由到 Agent 工作台 run 面板（端内处理）
			s.notifyEmitRaw(ctx, userID, messageapi.NotifyKindAgentDone, 0, 0, 0,
				"任务「"+title+"」"+agentTaskOutcome[p.Status], digest)
		}
		_ = s.bus.Publish(ctx, eventbus.TopicAgentTaskDone, messageapi.AgentTaskEvent{
			UserID: userID, Task: p,
		})
		return nil
	})
}

// ── 用户通知偏好（0030 / D12：设置页服务端驱动）──

// GetNotifyPref 偏好读取（无行归一默认：双开+off；tenant 归属校验）
func (s *Service) GetNotifyPref(ctx context.Context, tenantID, userID int64) (*messageapi.NotifyPrefDTO, error) {
	if s.opts.NotifyPrefs == nil {
		return nil, errx.New(errx.CodeInternal, "通知偏好存储未装配")
	}
	p, err := s.opts.NotifyPrefs.GetNotifyPref(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	dto := &messageapi.NotifyPrefDTO{MsgNotify: true, MentionNotify: true, DndRange: "off"}
	if p != nil {
		dto.MsgNotify = p.MsgNotify
		dto.MentionNotify = p.MentionNotify
		dto.DndRange = p.DndRange
	}
	return dto, nil
}

// SetNotifyPref 偏好 upsert（dnd 合法集校验）
func (s *Service) SetNotifyPref(ctx context.Context, tenantID, userID int64, dto messageapi.NotifyPrefDTO) (*messageapi.NotifyPrefDTO, error) {
	if s.opts.NotifyPrefs == nil {
		return nil, errx.New(errx.CodeInternal, "通知偏好存储未装配")
	}
	switch dto.DndRange {
	case "off", "work-night", "all-day":
	default:
		return nil, errx.New(errx.CodeBadRequest, "dnd_range 合法值：off|work-night|all-day")
	}
	if err := s.opts.NotifyPrefs.SetNotifyPref(ctx, messagerepo.NotifyPref{
		UserID: userID, TenantID: tenantID,
		MsgNotify: dto.MsgNotify, MentionNotify: dto.MentionNotify, DndRange: dto.DndRange,
	}); err != nil {
		return nil, errx.From(err)
	}
	return s.GetNotifyPref(ctx, tenantID, userID)
}
