package gateway

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/platform/authjwt"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
	"github.com/baobaowork/server/internal/platform/httpx"
	"github.com/baobaowork/server/internal/platform/ws"
)

// Gateway /ws/connect 接入：鉴权 → 升级 → 注册 hub → 信封路由 → 心跳 → 清理（D02 §6）
type Gateway struct {
	hub       *Hub
	msgs      messageapi.MessageService
	verify    TokenVerifier
	dedup     *eventbus.Dedup
	heartbeat time.Duration // 读超时=无心跳断开窗口
}

// TokenVerifier 与 httpx 一致的令牌校验函数
type TokenVerifier func(ctx context.Context, token string) (*authjwt.Claims, error)

// New 装配并订阅 msg.created → hub 扇出 msg.new（04 篇 §4.1 ⑦）
func New(hub *Hub, bus eventbus.Bus, msgs messageapi.MessageService, verify TokenVerifier, heartbeat time.Duration) *Gateway {
	if heartbeat <= 0 {
		heartbeat = 90 * time.Second
	}
	g := &Gateway{hub: hub, msgs: msgs, verify: verify, dedup: eventbus.NewDedup(4096), heartbeat: heartbeat}

	// 推送扇出：进程内订阅（多实例部署换 Redis/NATS，D02 §11-1）
	bus.Subscribe(eventbus.TopicMsgCreated, func(ctx context.Context, evt eventbus.Event) error {
		return g.dedup.Once(evt.ID, func() error { // 幂等消费：重复投递去重
			e, ok := evt.Payload.(messageapi.MsgCreatedEvent)
			if !ok {
				log.Printf("[gateway] msg.created payload 类型异常: %T", evt.Payload)
				return nil
			}
			// 推送载荷走 snake（客户端 mapMsgNew 契约，D03 §5.3）
			g.hub.PushToUsers(e.MemberIDs, NewPush("msg.new", e.Message.ToMsgNew()))
			return nil
		})
	})
	// 已读回执：推给除阅读者外的成员（04 篇 §4.2）
	bus.Subscribe(eventbus.TopicMsgReadUpdated, func(ctx context.Context, evt eventbus.Event) error {
		return g.dedup.Once(evt.ID, func() error {
			e, ok := evt.Payload.(messageapi.MsgReadEvent)
			if !ok {
				log.Printf("[gateway] msg.read.updated payload 类型异常: %T", evt.Payload)
				return nil
			}
			g.hub.PushToUsers(e.OtherMemberIDs, NewPush("msg.receipt", messageapi.MsgReceiptPayload{
				ConvID:  strconv.FormatInt(e.ConvID, 10),
				UserID:  strconv.FormatInt(e.UserID, 10),
				ReadSeq: e.ReadSeq,
			}))
			return nil
		})
	})
	// 撤回：全端 msg.recall（占位渲染，seq 不断裂，D03 §5.3）
	bus.Subscribe(eventbus.TopicMsgRecalled, func(ctx context.Context, evt eventbus.Event) error {
		return g.dedup.Once(evt.ID, func() error {
			e, ok := evt.Payload.(messageapi.MsgRecalledEvent)
			if !ok {
				log.Printf("[gateway] msg.recalled payload 类型异常: %T", evt.Payload)
				return nil
			}
			g.hub.PushToUsers(e.MemberIDs, NewPush("msg.recall", messageapi.MsgRecallPayload{
				MsgID: strconv.FormatInt(e.Message.ID, 10), ConvID: strconv.FormatInt(e.Message.ConvID, 10),
				Seq: e.Message.Seq, OperatorID: strconv.FormatInt(e.OperatorID, 10), TS: e.Message.TS,
			}))
			return nil
		})
	})
	// 编辑：全端 msg.updated 原地更新（D03 INT-IM-02）
	bus.Subscribe(eventbus.TopicMsgEdited, func(ctx context.Context, evt eventbus.Event) error {
		return g.dedup.Once(evt.ID, func() error {
			e, ok := evt.Payload.(messageapi.MsgEditedEvent)
			if !ok {
				log.Printf("[gateway] msg.edited payload 类型异常: %T", evt.Payload)
				return nil
			}
			g.hub.PushToUsers(e.MemberIDs, NewPush("msg.updated", messageapi.MsgUpdatedPayload{
				MsgID: strconv.FormatInt(e.Message.ID, 10), ConvID: strconv.FormatInt(e.Message.ConvID, 10),
				Seq: e.Message.Seq, Body: e.Message.Body, EditedAt: e.Message.EditedAt,
				EditVersion: e.Message.EditVersion,
			}))
			return nil
		})
	})
	// 表情回应：全端 msg.reaction.new 全量快照（端侧幂等合并，D03 INT-IM-23）
	bus.Subscribe(eventbus.TopicMsgReaction, func(ctx context.Context, evt eventbus.Event) error {
		return g.dedup.Once(evt.ID, func() error {
			e, ok := evt.Payload.(messageapi.MsgReactionEvent)
			if !ok {
				log.Printf("[gateway] msg.reaction payload 类型异常: %T", evt.Payload)
				return nil
			}
			g.hub.PushToUsers(e.MemberIDs, NewPush("msg.reaction.new", messageapi.MsgReactionNewPayload{
				MsgID: strconv.FormatInt(e.MsgID, 10), ConvID: strconv.FormatInt(e.ConvID, 10),
				Seq: e.Seq, Reactions: e.Reactions,
			}))
			return nil
		})
	})
	// 正在输入：瞬时事件，只推其他成员（不落库不重试，D03 INT-IM-11）
	bus.Subscribe(eventbus.TopicMsgTyping, func(ctx context.Context, evt eventbus.Event) error {
		e, ok := evt.Payload.(messageapi.TypingEvent)
		if !ok {
			log.Printf("[gateway] msg.typing payload 类型异常: %T", evt.Payload)
			return nil
		}
		g.hub.PushToUsers(e.OtherMemberIDs, NewPush("msg.typing", messageapi.TypingPushPayload{
			ConvID: strconv.FormatInt(e.ConvID, 10), UserID: strconv.FormatInt(e.UserID, 10),
		}))
		return nil // 瞬时事件不入 dedup（无副作用，重复推送由客户端 TTL 合并）
	})
	// 会话态（置顶/免打扰/草稿）：仅推本人多端（conv.updated kind=state，D03 §10-1）
	bus.Subscribe(eventbus.TopicConvUpdated, func(ctx context.Context, evt eventbus.Event) error {
		return g.dedup.Once(evt.ID, func() error {
			e, ok := evt.Payload.(messageapi.ConvStateEvent)
			if !ok {
				return nil // conv.updated 其它 kind（meta/member/...）现阶段无发布方，静默
			}
			g.hub.PushToUsers([]int64{e.UserID}, NewPush("conv.updated", map[string]any{
				"conv_id": strconv.FormatInt(e.ConvID, 10),
				"kind":    "state",
				"state":   e.State,
				"applied": e.Applied,
			}))
			return nil
		})
	})
	return g
}

// ServeWS /ws/connect?token=<access>&did=<deviceId>&v=1（14 篇 §2.1）
func (g *Gateway) ServeWS(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	did := r.URL.Query().Get("did")
	claims, err := g.verify(r.Context(), token)
	if err != nil {
		// 升级前以 HTTP 拒绝；升级后失效走 WS close 4001（14 篇 §2.1）
		rejectAuth(w, r, err)
		return
	}
	uid, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil {
		rejectAuth(w, r, err)
		return
	}

	conn, err := ws.Upgrade(w, r)
	if err != nil {
		log.Printf("[gateway] upgrade 失败: %v", err)
		return
	}
	client := NewClient(uid, did)
	g.hub.Register(client)
	defer func() {
		g.hub.Unregister(client)
		client.Close()
		_ = conn.Close()
	}()

	// 写盘循环：唯一写者，帧不交错
	go func() {
		for {
			select {
			case b := <-client.Outbox():
				if err := conn.WriteText(b); err != nil {
					client.Close()
					return
				}
			case <-client.Closed():
				_ = conn.WriteClose(ws.CloseNormal, "bye")
				_ = conn.Close()
				return
			}
		}
	}()

	// 读循环：帧级 ping 自动回 pong；文本帧走信封路由
	for {
		_ = conn.SetReadDeadline(time.Now().Add(g.heartbeat)) // 无心跳判定半开
		f, err := conn.ReadFrame()
		if err != nil {
			return
		}
		switch f.Opcode {
		case ws.OpPing:
			_ = conn.WritePong(f.Payload)
		case ws.OpClose:
			_ = conn.WriteClose(ws.CloseNormal, "")
			return
		case ws.OpText:
			env, err := Decode(f.Payload)
			if err != nil {
				log.Printf("[gateway] 非法信封: %v", err)
				_ = conn.WriteClose(ws.CloseProtocolErr, "bad envelope")
				return
			}
			if reply := g.handleEnvelope(r.Context(), uid, env); reply != nil {
				if err := client.Send(reply); err != nil {
					return
				}
			}
		default:
			// 二进制/分片不进信封通道（14 篇 §2.2）
			_ = conn.WriteClose(ws.CloseProtocolErr, "text frames only")
			return
		}
	}
}

// handleEnvelope 信封路由（纯函数化便于单测）：请求→成对 ack
func (g *Gateway) handleEnvelope(ctx context.Context, uid int64, env *Envelope) *Envelope {
	switch env.Type {
	case "ping":
		// 应用层心跳（14 篇 §2.1：30s 一次）
		return NewAck(env, 0, nil)

	case "msg.send":
		var p messageapi.SendPayload
		if err := unmarshalPayload(env, &p); err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		res, err := g.msgs.Send(ctx, uid, p)
		if err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		return NewAck(env, 0, res)

	case "msg.read":
		var p messageapi.ReadPayload
		if err := unmarshalPayload(env, &p); err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		res, err := g.msgs.MarkRead(ctx, uid, p)
		if err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		return NewAck(env, 0, res)

	case "msg.typing":
		var p messageapi.TypingPayload
		if err := unmarshalPayload(env, &p); err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		if err := g.msgs.Typing(ctx, uid, p); err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		return NewAck(env, 0, map[string]any{})

	case "msg.reaction.set":
		var p messageapi.ReactionSetPayload
		if err := unmarshalPayload(env, &p); err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		if _, err := g.msgs.ReactionSet(ctx, uid, p); err != nil {
			e := errx.From(err)
			return NewAck(env, int(e.Code), errBody(e.Msg))
		}
		// 全量快照经 msg.reaction.new 推送（含本人端），ack 载荷为空（D03 §5.2）
		return NewAck(env, 0, map[string]any{})

	default:
		// 未知 type：ack 9001（前向兼容由客户端忽略未注册推送承担，14 篇 §8）
		return NewAck(env, int(errx.CodeBadRequest), errBody("未知事件类型: "+env.Type))
	}
}

func unmarshalPayload(env *Envelope, v any) error {
	if len(env.Payload) == 0 {
		return errx.New(errx.CodeBadRequest, "payload 必填")
	}
	return json.Unmarshal(env.Payload, v)
}

func errBody(msg string) map[string]string {
	return map[string]string{"message": msg}
}

// rejectAuth WS 鉴权失败的 HTTP 侧响应（1003/1004 映射与 httpx.Auth 一致）
func rejectAuth(w http.ResponseWriter, r *http.Request, err error) {
	code := errx.CodeAuthTokenRevoked
	if err == authjwt.ErrExpired {
		code = errx.CodeAuthTokenExpired
	}
	httpx.Fail(w, r, errx.New(code, "ws auth failed"))
}
