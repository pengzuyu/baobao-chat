package gateway

// rtc.* 路由集成（D04 阶段一）：内存 message 模块（call_card 落流）+ rtc 服务挂载
// + hub 推送，验证 invite→ringing 推送、accept→connecting、signal 透传、
// bye→ended+卡片 msg.updated 扇出、5009/5010 错误码入 ack。

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/message/repo"
	"github.com/baobaowork/server/internal/message/service"
	"github.com/baobaowork/server/internal/platform/authjwt"
	"github.com/baobaowork/server/internal/platform/eventbus"
	"github.com/baobaowork/server/internal/rtc"
	rtcapi "github.com/baobaowork/server/internal/rtc/api"
)

// newTestGatewayRTC 完整装配：message(内存)+rtc(内存)+hub
func newTestGatewayRTC(t *testing.T) (*Gateway, *Hub) {
	t.Helper()
	r := messagerepo.NewMemory()
	bus := eventbus.New()
	msgSvc := messageservice.New(messageservice.Options{NameOf: func(id int64) string {
		if id == 10001 {
			return "Alice"
		}
		return "Bob"
	}}, r, bus)
	hub := NewHub()
	verify := func(ctx context.Context, token string) (*authjwt.Claims, error) {
		return authjwt.NewSigner([]byte("test-secret-0123456789abcdef0123")).Parse(token)
	}
	g := New(hub, bus, msgSvc, verify, 0)
	// conv1 单聊 alice/bob 种子
	ctx := context.Background()
	if _, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvSingle}); err != nil {
		t.Fatal(err)
	}
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: 1, UserID: 10001, Role: messageapi.MemberMember})
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: 1, UserID: 10002, Role: messageapi.MemberMember})
	// rtc 装配：hub 推送适配 + message 卡片适配
	rtcSvc := rtc.NewModule(RtcPusher{Hub: hub}, rtcCardSinkAdapter{msgs: msgSvc}, rtc.Options{
		IsConvActive: func(ctx context.Context, convID int64) bool {
			c, err := r.GetConversation(ctx, convID)
			return err == nil && c != nil && c.Status == messageapi.ConvActive
		},
		IsConvMember: func(ctx context.Context, convID, uid int64) bool {
			m, err := r.MemberOf(ctx, convID, uid)
			return err == nil && m != nil && m.Status == 1
		},
		NameOf:      func(id int64) string { return "Alice" },
		RingTimeout: time.Hour,
	})
	g.MountRTC(rtcSvc.API())
	return g, hub
}

// rtcCardSinkAdapter 测试内联适配器（main.go 同款）
type rtcCardSinkAdapter struct{ msgs messageapi.MessageService }

func (a rtcCardSinkAdapter) SendCard(ctx context.Context, senderID, convID int64, clientMsgID string, body json.RawMessage) int64 {
	id, _ := a.msgs.SendCallCard(ctx, senderID, convID, clientMsgID, body)
	return id
}

func (a rtcCardSinkAdapter) FinishCard(ctx context.Context, msgID int64, body json.RawMessage) {
	_ = a.msgs.UpdateCallCard(ctx, msgID, body)
}

// drain 收集指定端全部推送（type 过滤可空）
func drainTyped(c *Client, typ string) []string {
	var out []string
	for {
		select {
		case b := <-c.Outbox():
			env, err := Decode(b)
			if err != nil {
				continue
			}
			if typ == "" || env.Type == typ {
				out = append(out, string(env.Payload))
			}
		default:
			return out
		}
	}
}

func TestRouteRTCFullCall(t *testing.T) {
	g, hub := newTestGatewayRTC(t)
	ctx := context.Background()
	alice := NewClient(10001, "a-dev")
	bob := NewClient(10002, "b-dev")
	hub.Register(alice)
	hub.Register(bob)

	// ① invite：ack{call_id} + bob 收 rtc.ringing + 双端 call_card msg.new
	reply := g.handleEnvelope(ctx, 10001, mustDecode(t,
		`{"v":1,"id":"c-r1","type":"rtc.call.invite","payload":{"call_id":"ca-e2e","conv_id":"1","callee_id":"10002","call_type":"video"}}`))
	if reply == nil || reply.Code != 0 {
		t.Fatalf("invite ack 失败: %+v", reply)
	}
	var ack rtcapi.InviteAck
	_ = json.Unmarshal(reply.Payload, &ack)
	if ack.CallID != "ca-e2e" {
		t.Fatalf("ack call_id 不符: %s", reply.Payload)
	}
	ringing := drainTyped(bob, "rtc.ringing")
	if len(ringing) != 1 || !strings.Contains(ringing[0], `"name":"Alice"`) {
		t.Fatalf("bob 应收 rtc.ringing(含主叫名): %v", ringing)
	}
	if cards := drainTyped(alice, "msg.new"); len(cards) == 0 {
		t.Fatalf("主叫端应收 call_card msg.new")
	}
	drainTyped(bob, "msg.new")

	// ② 同会话重复 invite → 5009
	reply2 := g.handleEnvelope(ctx, 10001, mustDecode(t,
		`{"v":1,"id":"c-r2","type":"rtc.call.invite","payload":{"call_id":"ca-dup","conv_id":"1","callee_id":"10002","call_type":"audio"}}`))
	if reply2 == nil || reply2.Code != 5009 {
		t.Fatalf("重复呼叫应 5009: %+v", reply2)
	}

	// ③ bob 接听：alice 收 rtc.state(connecting)
	reply3 := g.handleEnvelope(ctx, 10002, mustDecode(t,
		`{"v":1,"id":"c-r3","type":"rtc.accept","payload":{"call_id":"ca-e2e","answer":true,"did":"b-dev"}}`))
	if reply3 == nil || reply3.Code != 0 {
		t.Fatalf("accept ack 失败: %+v", reply3)
	}
	states := drainTyped(alice, "rtc.state")
	if len(states) == 0 || !strings.Contains(states[len(states)-1], `"kind":"connecting"`) {
		t.Fatalf("alice 应收 connecting: %v", states)
	}
	drainTyped(bob, "rtc.state") // answered_elsewhere(bob)

	// ④ alice 发 offer：bob 收 rtc.signal 透传 + 双端 connected
	reply4 := g.handleEnvelope(ctx, 10001, mustDecode(t,
		`{"v":1,"id":"c-r4","type":"rtc.signal","payload":{"call_id":"ca-e2e","data":{"kind":"sdp","type":"offer","sdp":"v=0"}}}`))
	if reply4 == nil || reply4.Code != 0 {
		t.Fatalf("signal ack 失败: %+v", reply4)
	}
	if sig := drainTyped(bob, "rtc.signal"); len(sig) != 1 || !strings.Contains(sig[0], `"kind":"sdp"`) {
		t.Fatalf("bob 应收透传 signal: %v", sig)
	}
	drainTyped(alice, "rtc.state")
	drainTyped(bob, "rtc.state")

	// ⑤ bob 挂断：双端 ended(bye) + call_card msg.updated（status=ended）
	reply5 := g.handleEnvelope(ctx, 10002, mustDecode(t,
		`{"v":1,"id":"c-r5","type":"rtc.bye","payload":{"call_id":"ca-e2e"}}`))
	if reply5 == nil || reply5.Code != 0 {
		t.Fatalf("bye ack 失败: %+v", reply5)
	}
	// 一次性收取 alice 全部推送（drainTyped 会消费整队列，分段断言会吞帧）
	tail := drainTyped(alice, "")
	ended := false
	var updated []string
	for _, s := range tail {
		if strings.Contains(s, `"kind":"ended"`) && strings.Contains(s, `"reason":"bye"`) {
			ended = true
		}
		if strings.Contains(s, `"status":"ended"`) {
			updated = append(updated, s)
		}
	}
	if !ended {
		t.Fatalf("alice 应收 ended(bye): %v", tail)
	}
	if len(updated) != 1 {
		t.Fatalf("call_card 应回写 msg.updated(ended): %v", tail)
	}

	// ⑥ 结束后再 accept → 5010
	reply6 := g.handleEnvelope(ctx, 10002, mustDecode(t,
		`{"v":1,"id":"c-r6","type":"rtc.accept","payload":{"call_id":"ca-e2e","answer":true,"did":"b-dev"}}`))
	if reply6 == nil || reply6.Code != 5010 {
		t.Fatalf("结束后 accept 应 5010: %+v", reply6)
	}
}

// 未挂载 rtc 服务时 rtc.* → 9001（前向兼容守卫）
func TestRouteRTCNotMounted(t *testing.T) {
	g, _, _ := newTestGateway(t)
	reply := g.handleEnvelope(context.Background(), 10001, mustDecode(t,
		`{"v":1,"id":"c-x","type":"rtc.call.invite","payload":{"call_id":"c1","conv_id":"1","callee_id":"10002","call_type":"audio"}}`))
	if reply == nil || reply.Code != 9001 {
		t.Fatalf("未挂载 rtc 应 9001: %+v", reply)
	}
}
