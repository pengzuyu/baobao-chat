// 通话卡片落流/回写（D04 阶段一务实版，05 §4.5 call_card）：
//   - invite 时 rtc 域经 SendCallCard 落 type=call_card 消息（sender=主叫，端内按 sender 判方向）；
//   - 结束时经 UpdateCallCard PATCH body（status=ended{duration,reason}），复用 msg.edited 事件
//     → gateway 扇出 msg.updated（客户端原地更新卡片——按现有 message 服务能力择简实现，登记）。
package messageservice

import (
	"context"
	"encoding/json"
	"strconv"

	messageapi "github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/platform/eventbus"
)

// SendCallCard 通话卡片落流（rtc 域注入调用）：免校验系统侧管线，
// client_msg_id 幂等（callcard-<call_id>，同 call 重试不重复落卡）。
func (s *Service) SendCallCard(ctx context.Context, senderID, convID int64, clientMsgID string, body json.RawMessage) (int64, error) {
	if convID <= 0 || senderID <= 0 || clientMsgID == "" {
		return 0, nil // 参数缺失：静默跳过（卡片为辅链路，不阻断信令）
	}
	// 幂等前置：同 client_msg_id 已落 → 回原 msg_id
	if m, _ := s.repo.FindByClientMsgID(ctx, convID, clientMsgID); m != nil {
		return m.ID, nil
	}
	msg := s.sendCore(ctx, convID, senderID, messageapi.SendPayload{
		ConvID:      messageapi.ConvID(strconv.FormatInt(convID, 10)),
		ClientMsgID: clientMsgID,
		Type:        "call_card",
		Body:        body,
	})
	if msg == nil {
		return 0, nil
	}
	return msg.ID, nil
}

// UpdateCallCard 通话结束回写卡片 body 并扇出 msg.updated（仅 call_card 类型可写）
func (s *Service) UpdateCallCard(ctx context.Context, msgID int64, body json.RawMessage) error {
	msg, err := s.repo.GetMessageByID(ctx, msgID)
	if err != nil || msg == nil {
		return nil // 卡片缺失：静默（通话信令已结束，不追补）
	}
	if msg.Type != "call_card" {
		return nil
	}
	msg.Body = body
	msg.EditedAt = s.opts.Now().UnixMilli()
	// edit_version 语义同 Edit（原文=1，首次更新=2）；status 保持 normal（卡片无"已编辑"语义）
	if msg.EditVersion < 2 {
		msg.EditVersion = 2
	} else {
		msg.EditVersion++
	}
	if err := s.repo.UpdateMessage(ctx, *msg); err != nil {
		return err
	}
	members, _ := s.repo.MembersOf(ctx, msg.ConvID)
	_ = s.bus.Publish(ctx, eventbus.TopicMsgEdited, messageapi.MsgEditedEvent{Message: *msg, MemberIDs: members})
	return nil
}
