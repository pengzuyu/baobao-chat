// 内嵌 Agent 卡阶段更新测试（D18 §4.2）。
package messageservice

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"

	messageapi "github.com/baobaochat/server/internal/message/api"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/eventbus"
)

func agentCardPayload(cmid, status string) messageapi.SendPayload {
	body, _ := json.Marshal(map[string]any{"kind": "embedded_agent", "status": status, "stages": []any{}})
	return messageapi.SendPayload{
		ConvID: messageapi.ConvID(strconv.FormatInt(1, 10)), ClientMsgID: cmid, Type: "agent_card", Body: body,
	}
}

func TestUpdateAgentCard(t *testing.T) {
	svc, _, bus := seedFixture(t, Options{NameOf: func(int64) string { return "u" }})
	ctx := context.Background()

	// 落流一条 agent_card（WS msg.send 透传口径：type 非专项校验类直接落库）
	sent, err := svc.Send(ctx, 10001, agentCardPayload("ac-1", "running"))
	if err != nil || sent == nil {
		t.Fatalf("agent_card 落流失败: %v", err)
	}
	msgID := sent.MsgID

	newBody, _ := json.Marshal(map[string]any{
		"kind": "embedded_agent", "session_id": "s-77", "status": "done",
		"stages": []map[string]any{{"t": "conclusion", "md": "结论"}},
	})

	// 非本人 → 3017
	if err := svc.UpdateAgentCard(ctx, 10002, msgID, newBody); errx.From(err).Code != errx.CodeIMNotMessageOwner {
		t.Fatalf("非发起者应拒，got %v", err)
	}
	// 非法 JSON → 9001
	if err := svc.UpdateAgentCard(ctx, 10001, msgID, json.RawMessage(`{broken`)); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("非法 body 应 9001，got %v", err)
	}
	// 本人更新 → 成功 + msg.edited 扇出 + edit_version 递增
	var got messageapi.MsgEditedEvent
	bus.Subscribe(eventbus.TopicMsgEdited, func(_ context.Context, e eventbus.Event) error {
		if evt, ok := e.Payload.(messageapi.MsgEditedEvent); ok {
			got = evt
		}
		return nil
	})
	if err := svc.UpdateAgentCard(ctx, 10001, msgID, newBody); err != nil {
		t.Fatalf("本人更新应成功: %v", err)
	}
	if got.Message.ID != msgID || got.Message.EditVersion != 2 {
		t.Fatalf("扇出事件异常: id=%d v=%d", got.Message.ID, got.Message.EditVersion)
	}
	if string(got.Message.Body) != string(newBody) {
		t.Fatalf("body 未更新: %s", got.Message.Body)
	}
	// 再更新一次 → edit_version=3
	if err := svc.UpdateAgentCard(ctx, 10001, msgID, newBody); err != nil {
		t.Fatal(err)
	}
	// 非 agent_card 类型 → 拒
	txt, err := svc.Send(ctx, 10001, textPayload(1, "t-1", "hi"))
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.UpdateAgentCard(ctx, 10001, txt.MsgID, newBody); errx.From(err).Code != errx.CodeIMNotMessageOwner {
		t.Fatalf("text 消息应拒，got %v", err)
	}
	// 不存在 → 3017（message not found 口径）
	if err := svc.UpdateAgentCard(ctx, 10001, 99999, newBody); errx.From(err).Code != errx.CodeIMMessageNotFound {
		t.Fatalf("不存在应 3017，got %v", err)
	}
}
