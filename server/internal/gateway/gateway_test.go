package gateway

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/message/repo"
	"github.com/baobaowork/server/internal/message/service"
	"github.com/baobaowork/server/internal/platform/authjwt"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
)

// 路由集成：内存 message 模块 + 事件总线 + hub，验证
// ping→pong、msg.send→ack{seq}+成员 msg.new 扇出、未知 type→9001、msg.read 生效。
func newTestGateway(t *testing.T) (*Gateway, *Hub, *messagerepo.Memory) {
	t.Helper()
	r := messagerepo.NewMemory()
	bus := eventbus.New()
	svc := messageservice.New(messageservice.Options{}, r, bus)
	hub := NewHub()
	verify := func(ctx context.Context, token string) (*authjwt.Claims, error) {
		return authjwt.NewSigner([]byte("test-secret-0123456789abcdef0123")).Parse(token)
	}
	g := New(hub, bus, svc, verify, 0)
	// 种子：conv1 单聊 alice(10001)/bob(10002)
	ctx := context.Background()
	if _, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvSingle}); err != nil {
		t.Fatal(err)
	}
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: 1, UserID: 10001, Role: messageapi.MemberMember})
	_ = r.AddMember(ctx, messagerepo.Member{ConvID: 1, UserID: 10002, Role: messageapi.MemberMember})
	return g, hub, r
}

func mustDecode(t *testing.T, raw string) *Envelope {
	t.Helper()
	env, err := Decode([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func TestRoutePingPong(t *testing.T) {
	g, _, _ := newTestGateway(t)
	req := mustDecode(t, `{"v":1,"id":"c-1","type":"ping"}`)
	reply := g.handleEnvelope(context.Background(), 10001, req)
	if reply == nil || reply.Type != "pong" || reply.Ack != "c-1" {
		t.Fatalf("pong 不符: %+v", reply)
	}
}

func TestRouteMsgSendFanout(t *testing.T) {
	g, hub, _ := newTestGateway(t)
	ctx := context.Background()
	// conv1: alice(10001)/bob(10002)；bob 两端在线
	bobDev1 := NewClient(10002, "d1")
	bobDev2 := NewClient(10002, "d2")
	alice := NewClient(10001, "d3")
	hub.Register(bobDev1)
	hub.Register(bobDev2)
	hub.Register(alice)

	req := mustDecode(t, `{"v":1,"id":"c-10","type":"msg.send","payload":{"conv_id":1,"client_msg_id":"x-1","type":"text","body":{"text":"hi"}}}`)
	reply := g.handleEnvelope(ctx, 10001, req)
	if reply == nil || reply.Ack != "c-10" || reply.Type != "msg.send.ack" || reply.Code != 0 {
		t.Fatalf("ack 不符: %+v", reply)
	}
	var res messageapi.SendResult
	if err := json.Unmarshal(reply.Payload, &res); err != nil {
		t.Fatalf("ack payload: %v", err)
	}
	if res.Seq != 1 {
		t.Fatalf("首条 seq 应为 1: %+v", res)
	}

	// 全端 msg.new（扇出去重后 alice 1 端 + bob 2 端）
	for i, c := range []*Client{bobDev1, bobDev2, alice} {
		select {
		case b := <-c.Outbox():
			var e Envelope
			if err := json.Unmarshal(b, &e); err != nil || e.Type != "msg.new" {
				t.Fatalf("端 %d 收到异常推送: %s", i, b)
			}
			var m messageapi.MsgNewPayload
			if err := json.Unmarshal(e.Payload, &m); err != nil || m.Seq != 1 || m.ConvID != "1" {
				t.Fatalf("msg.new payload 不符: %s", e.Payload)
			}
		default:
			t.Fatalf("端 %d 未收到 msg.new", i)
		}
	}
}

// 表驱动：路由错误路径（错误码入 ack.code）
func TestRouteErrors(t *testing.T) {
	g, _, _ := newTestGateway(t)
	ctx := context.Background()

	cases := []struct {
		name     string
		raw      string
		wantCode int
	}{
		{"未知类型", `{"v":1,"id":"c-1","type":"unknown.evt"}`, int(errx.CodeBadRequest)},
		{"不在会话", `{"v":1,"id":"c-2","type":"msg.send","payload":{"conv_id":1,"client_msg_id":"e1","type":"text"}}`, int(errx.CodeIMNotInConversation)}, // sender 99999 非成员
		{"会话不存在", `{"v":1,"id":"c-3","type":"msg.send","payload":{"conv_id":77,"client_msg_id":"e2","type":"text"}}`, int(errx.CodeIMConvNotFound)},
		{"payload 必填", `{"v":1,"id":"c-4","type":"msg.send"}`, int(errx.CodeBadRequest)},
		{"非法游标", `{"v":1,"id":"c-5","type":"msg.read","payload":{"conv_id":1,"read_seq":99}}`, int(errx.CodeIMInvalidCursor)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := mustDecode(t, c.raw)
			var uid int64 = 99999
			if c.name == "非法游标" {
				// conv1 无成员 99999 → 先补充成员使 read 校验走到游标判断
				uid = 10001
			}
			reply := g.handleEnvelope(ctx, uid, req)
			if reply == nil || reply.Code != c.wantCode {
				t.Fatalf("code=%v want=%d (reply=%+v)", replyCode(reply), c.wantCode, reply)
			}
		})
	}
}

func replyCode(r *Envelope) any {
	if r == nil {
		return "nil"
	}
	return r.Code
}

func TestRouteMsgRead(t *testing.T) {
	g, _, _ := newTestGateway(t)
	ctx := context.Background()
	// alice 发 3 条
	for i := 1; i <= 3; i++ {
		req := mustDecode(t, `{"v":1,"id":"c-s`+string(rune('0'+i))+`","type":"msg.send","payload":{"conv_id":1,"client_msg_id":"r`+string(rune('0'+i))+`","type":"text","body":{"text":"x"}}}`)
		if reply := g.handleEnvelope(ctx, 10001, req); reply == nil || reply.Code != 0 {
			t.Fatalf("发送失败: %+v", reply)
		}
	}
	// bob 上报已读到 2
	reply := g.handleEnvelope(ctx, 10002, mustDecode(t, `{"v":1,"id":"c-r1","type":"msg.read","payload":{"conv_id":1,"read_seq":2}}`))
	if reply == nil || reply.Code != 0 {
		t.Fatalf("msg.read ack 失败: %+v", reply)
	}
	var res messageapi.ReadResult
	if err := json.Unmarshal(reply.Payload, &res); err != nil || res.ReadSeq != 2 {
		t.Fatalf("read 结果不符: %s", reply.Payload)
	}
	// 回退 → 生效值仍 2
	reply2 := g.handleEnvelope(ctx, 10002, mustDecode(t, `{"v":1,"id":"c-r2","type":"msg.read","payload":{"conv_id":1,"read_seq":1}}`))
	var res2 messageapi.ReadResult
	_ = json.Unmarshal(reply2.Payload, &res2)
	if res2.ReadSeq != 2 {
		t.Fatalf("回退后生效游标应仍为 2: %+v", res2)
	}
}
