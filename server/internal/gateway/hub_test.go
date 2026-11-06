package gateway

import (
	"encoding/json"
	"sync"
	"testing"
)

// 多端注册与摘除
func TestHubRegisterUnregister(t *testing.T) {
	h := NewHub()
	c1 := NewClient(10001, "did-1")
	c2 := NewClient(10001, "did-2") // 同用户第二台设备
	c3 := NewClient(10002, "did-3")

	h.Register(c1)
	h.Register(c2)
	h.Register(c3)
	if h.OnlineCount() != 3 {
		t.Fatalf("在线连接数=%d want 3", h.OnlineCount())
	}
	if len(h.OnlineUsers()) != 2 {
		t.Fatalf("在线用户数=%d want 2", len(h.OnlineUsers()))
	}

	h.Unregister(c2)
	if h.OnlineCount() != 2 {
		t.Fatalf("摘除后连接数=%d want 2", h.OnlineCount())
	}
	if len(h.OnlineUsers()) != 2 {
		t.Fatalf("用户 10001 仍在线（c1 存活）: %v", h.OnlineUsers())
	}
	h.Unregister(c1)
	if len(h.OnlineUsers()) != 1 {
		t.Fatalf("用户 10001 全端下线后应移除: %v", h.OnlineUsers())
	}
	// 重复摘除幂等
	h.Unregister(c1)
	if h.OnlineCount() != 1 {
		t.Fatal("重复摘除应幂等")
	}
}

// 扇出：目标用户全端送达，非目标不送达；用户列表去重
func TestHubFanout(t *testing.T) {
	h := NewHub()
	alice1 := NewClient(10001, "d1")
	alice2 := NewClient(10001, "d2")
	bob := NewClient(10002, "d3")
	carol := NewClient(10003, "d4")
	h.Register(alice1)
	h.Register(alice2)
	h.Register(bob)
	h.Register(carol)

	env := NewPush("msg.new", map[string]int64{"seq": 9})
	n := h.PushToUsers([]int64{10001, 10002, 10001}, env) // 10001 重复应去重
	if n != 3 {
		t.Fatalf("送达连接数=%d want 3", n)
	}
	for i, c := range []*Client{alice1, alice2, bob} {
		select {
		case b := <-c.Outbox():
			var e Envelope
			if err := decodeJSON(b, &e); err != nil || e.Type != "msg.new" {
				t.Fatalf("连接 %d 收到异常推送: %s", i, b)
			}
		default:
			t.Fatalf("连接 %d 未收到推送", i)
		}
	}
	select {
	case <-carol.Outbox():
		t.Fatal("非扇出目标不应收到")
	default:
	}
}

// 慢连接：队列满时断开并返回错误（不阻塞扇出方）
func TestHubSlowConsumer(t *testing.T) {
	h := NewHub()
	c := NewClient(10001, "d1")
	h.Register(c)

	var (
		mu   sync.Mutex
		full int
	)
	for i := 0; i < sendQueueSize+50; i++ {
		if err := c.Send(NewPush("msg.new", nil)); err != nil {
			mu.Lock()
			full++
			mu.Unlock()
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if full == 0 {
		t.Fatal("队列满应产生 ErrSendQueueFull")
	}
	select {
	case <-c.Closed():
	default:
		t.Fatal("慢连接应被断开")
	}
	// 断开后 Send 直接报 closed
	if err := c.Send(NewPush("msg.new", nil)); err != ErrClientClosed {
		t.Fatalf("断开后应 ErrClientClosed, got %v", err)
	}
}

func decodeJSON(b []byte, v any) error {
	return json.Unmarshal(b, v)
}
