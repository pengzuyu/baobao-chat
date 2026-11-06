package gateway

import (
	"encoding/json"
	"testing"
	"time"
)

// 信封 roundtrip：JSON → 结构 → JSON，payload 原样保留（RawMessage 不重排）
func TestEnvelopeRoundtrip(t *testing.T) {
	raw := `{"v":1,"id":"c-12345","type":"msg.send","ts":1760000000000,"payload":{"conv_id":1,"client_msg_id":"u-1","type":"text","body":{"text":"你好"}}}`
	env, err := Decode([]byte(raw))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if env.V != 1 || env.ID != "c-12345" || env.Type != "msg.send" || env.TS != 1760000000000 {
		t.Fatalf("字段不符: %+v", env)
	}
	var p map[string]any
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("payload 应为合法 JSON: %v", err)
	}
	if p["client_msg_id"] != "u-1" {
		t.Fatalf("payload 内容不符: %v", p)
	}

	out, err := env.Encode()
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	env2, err := Decode(out)
	if err != nil {
		t.Fatalf("再解码: %v", err)
	}
	if string(env2.Payload) != string(env.Payload) {
		t.Fatalf("payload 不一致: %s vs %s", env2.Payload, env.Payload)
	}
}

// 表驱动：非法信封拒绝
func TestDecodeRejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"版本不符", `{"v":2,"id":"c-1","type":"ping"}`},
		{"缺 id", `{"v":1,"type":"ping"}`},
		{"缺 type", `{"v":1,"id":"c-1"}`},
		{"坏 JSON", `{`},
		{"空串", ``},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Decode([]byte(c.raw)); err == nil {
				t.Fatal("应拒绝")
			}
		})
	}
}

// 请求-ack 成对：ack.id 独立、ack.ack=请求 id、类型映射 ping→pong / msg.send→msg.send.ack
func TestAckPairing(t *testing.T) {
	ping := &Envelope{V: 1, ID: "c-100", Type: "ping"}
	ack := NewAck(ping, 0, nil)
	if ack.Ack != "c-100" || ack.Type != "pong" || ack.Code != 0 {
		t.Fatalf("pong 回执不符: %+v", ack)
	}

	send, _ := Decode([]byte(`{"v":1,"id":"c-200","type":"msg.send","payload":{"conv_id":1,"client_msg_id":"m","type":"text"}}`))
	sack := NewAck(send, 0, map[string]int64{"seq": 7, "ts": 1})
	if sack.Ack != "c-200" || sack.Type != "msg.send.ack" {
		t.Fatalf("ack 类型不符: %+v", sack)
	}
	b, _ := sack.Encode()
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["ack"] != "c-200" || m["type"] != "msg.send.ack" {
		t.Fatalf("序列化 ack 不符: %s", b)
	}
	// 契约（14 篇 §2.2）：成功 ack 必须显式 code:0——客户端 code===0 判定依赖其存在
	// （曾因 omitempty 省略 0，客户端 env.code===undefined 误判失败）
	if v, ok := m["code"].(float64); !ok || v != 0 {
		t.Fatalf("成功 ack 必须显式 code:0: %s", b)
	}
	errAck := NewAck(send, 3004, errBody("too long"))
	eb, _ := errAck.Encode()
	var em map[string]any
	_ = json.Unmarshal(eb, &em)
	if em["code"].(float64) != 3004 {
		t.Fatalf("失败 ack 应携带错误码: %s", eb)
	}
}

func TestNewPush(t *testing.T) {
	NowMillis = func() int64 { return 1760000000123 }
	defer func() { NowMillis = func() int64 { return time.Now().UnixMilli() } }()

	p := NewPush("msg.new", map[string]int64{"seq": 1})
	if p.TS != 1760000000123 || p.ID == "" || p.Type != "msg.new" || p.Ack != "" {
		t.Fatalf("推送信封不符: %+v", p)
	}
	b, err := p.Encode()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, has := m["ack"]; has {
		t.Fatalf("推送不应有 ack 字段: %s", b)
	}
}
