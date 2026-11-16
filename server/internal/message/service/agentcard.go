// IM 内嵌 Agent 卡落流/阶段更新（D18 §4.2）：
//   - 落流走既有 WS msg.send（type=agent_card 服务端透传，本文件不管落流）；
//   - 分阶段更新走本通道：发起者 PATCH 卡片 body（stages/status/sources），
//     复用 msg.edited 事件 → gateway 扇出 msg.updated，接收端原地更新卡片
//     （call_card 回写先例同款机制，2026-11 瘦身移除后随 D18 复活为用户侧通道）。
package messageservice

import (
	"context"
	"encoding/json"

	messageapi "github.com/baobaochat/server/internal/message/api"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/eventbus"
)

// UpdateAgentCard 内嵌 Agent 卡阶段更新（仅发起者本人 + type=agent_card 可写；
// body 为不透明 JSON 透传——kind/stages 结构约定见 D18 §4.1，服务端不解析内容）。
func (s *Service) UpdateAgentCard(ctx context.Context, userID, msgID int64, body json.RawMessage) error {
	if len(body) == 0 || !json.Valid(body) {
		return errx.New(errx.CodeBadRequest, "卡片体非法 JSON")
	}
	msg, err := s.repo.GetMessageByID(ctx, msgID)
	if err != nil || msg == nil {
		return errx.New(errx.CodeIMMessageNotFound, "消息不存在")
	}
	if msg.SenderID != userID {
		return errx.New(errx.CodeIMNotMessageOwner, "仅卡片发起者可更新")
	}
	if msg.Type != "agent_card" {
		return errx.New(errx.CodeIMNotMessageOwner, "仅 agent_card 消息可经此通道更新")
	}
	msg.Body = body
	msg.EditedAt = s.opts.Now().UnixMilli()
	// edit_version 语义同 Edit（原文=1，首次更新=2）；status 保持 normal（卡片无"已编辑"角标语义）
	if msg.EditVersion < 2 {
		msg.EditVersion = 2
	} else {
		msg.EditVersion++
	}
	if err := s.repo.UpdateMessage(ctx, *msg); err != nil {
		return errx.From(err)
	}
	members, _ := s.repo.MembersOf(ctx, msg.ConvID)
	_ = s.bus.Publish(ctx, eventbus.TopicMsgEdited, messageapi.MsgEditedEvent{Message: *msg, MemberIDs: members})
	return nil
}
