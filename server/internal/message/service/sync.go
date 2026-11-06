// 增量同步（D03 API-IM-01）：登录/重连后按各会话本地游标拉增量。
package messageservice

import (
	"context"
	"strconv"

	messageapi "github.com/baobaowork/server/internal/message/api"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// Sync 增量拉取：逐会话校验成员 → after=cursor 取增量（超出 limit 标 gap 由端侧翻页补洞）
func (s *Service) Sync(ctx context.Context, userID int64, cursors map[string]int64, limit int) (*messageapi.SyncResult, error) {
	if len(cursors) > 100 {
		return nil, errx.New(errx.CodeBadRequest, "cursors 超上限（≤100 会话/次，14 篇 §9-3）")
	}
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	out := &messageapi.SyncResult{Convs: []messageapi.SyncConvItem{}, Presences: []map[string]any{}}
	totalUnread := int64(0)
	for convIDStr, cursor := range cursors {
		convID, err := strconv.ParseInt(convIDStr, 10, 64)
		if err != nil || convID <= 0 || cursor < 0 {
			return nil, errx.New(errx.CodeIMInvalidCursor, "游标非法")
		}
		conv, err := s.repo.GetConversation(ctx, convID)
		if err != nil {
			continue // 会话已删：端侧自行移除（跳过不下发）
		}
		if member, _ := s.repo.MemberOf(ctx, convID, userID); member == nil || member.Status != 1 {
			continue // 非成员：不下发（历史可见性属 conv 详情语义）
		}
		r, _ := s.repo.GetReceipt(ctx, convID, userID)
		unread := conv.LatestSeq - r.ReadSeq
		if unread < 0 {
			unread = 0
		}
		totalUnread += unread

		item := messageapi.SyncConvItem{
			ConvID: convIDStr, Type: conv.Type, Name: conv.Name, LatestSeq: conv.LatestSeq,
			Unread: unread,
		}
		// cursor 之后有新消息 → 带回增量（广播群读扩散：仅游标不带货，D03 §4.6）
		if conv.Type != messageapi.ConvBroadcast && conv.LatestSeq > cursor {
			msgs, err := s.repo.ListMessages(ctx, convID, cursor, 0, limit+1)
			if err != nil {
				return nil, errx.From(err)
			}
			if len(msgs) > limit {
				msgs = msgs[:limit]
				item.Gap = true // 缺口：端侧走 GET messages 翻页补洞（D03 §9）
			}
			for i := range msgs {
				if msgs[i].SenderName == "" {
					msgs[i].SenderName = s.nameOf(msgs[i].SenderID)
				}
			}
			item.Messages = msgs
		}
		out.Convs = append(out.Convs, item)
	}
	out.Badges.TotalUnread = totalUnread
	out.ServerTS = s.opts.Now().UnixMilli()
	return out, nil
}
