package eventbus

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestPubSubDeliversToAllSubscribers(t *testing.T) {
	bus := New()
	var got1, got2 atomic.Int32
	bus.Subscribe(TopicMsgCreated, func(_ context.Context, e Event) error {
		got1.Add(1)
		if e.ID == "" {
			t.Error("event_id 必填")
		}
		return nil
	})
	bus.Subscribe(TopicMsgCreated, func(_ context.Context, _ Event) error {
		got2.Add(1)
		return nil
	})
	// 无关 topic 不应触达
	bus.Subscribe(TopicPolicyUpdated, func(_ context.Context, _ Event) error {
		t.Error("不应收到 policy 事件")
		return nil
	})

	if err := bus.Publish(context.Background(), TopicMsgCreated, map[string]int64{"seq": 7}); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if got1.Load() != 1 || got2.Load() != 1 {
		t.Fatalf("两个订阅者各应收到一次: %d/%d", got1.Load(), got2.Load())
	}
}

func TestAtLeastOnceRetryThenDeadLetter(t *testing.T) {
	bus := New() // retries=2 → 共执行 3 次
	var attempts atomic.Int32
	boom := errors.New("boom")
	bus.Subscribe(TopicAuditEvent, func(_ context.Context, _ Event) error {
		attempts.Add(1)
		return boom
	})

	var dead Event
	bus.OnDeadLetter = func(e Event, err error) {
		dead = e
		if err != boom {
			t.Errorf("死信应携带原错误, got %v", err)
		}
	}
	_ = bus.Publish(context.Background(), TopicAuditEvent, nil)

	if attempts.Load() != 3 {
		t.Fatalf("重试次数不符: %d", attempts.Load())
	}
	if dead.ID == "" {
		t.Fatal("死信事件为空")
	}
	if dl := bus.DeadLetters(); len(dl) != 1 {
		t.Fatalf("死信应记录 1 条, got %d", len(dl))
	}
}

func TestRetryUntilSuccess(t *testing.T) {
	bus := New()
	var attempts atomic.Int32
	bus.Subscribe(TopicMsgCreated, func(_ context.Context, _ Event) error {
		if attempts.Add(1) < 2 { // 第 2 次成功
			return errors.New("transient")
		}
		return nil
	})
	_ = bus.Publish(context.Background(), TopicMsgCreated, nil)
	if attempts.Load() != 2 {
		t.Fatalf("应在第 2 次成功, 实际执行 %d 次", attempts.Load())
	}
	if len(bus.DeadLetters()) != 0 {
		t.Fatal("成功重试不应产生死信")
	}
}

func TestDedupOnce(t *testing.T) {
	d := NewDedup(2)
	var n atomic.Int32
	fn := func() error { n.Add(1); return nil }

	if err := d.Once("e1", fn); err != nil {
		t.Fatal(err)
	}
	if err := d.Once("e1", fn); err != nil { // 重复投递：跳过
		t.Fatal(err)
	}
	if n.Load() != 1 {
		t.Fatalf("重复 event_id 应被去重, 执行了 %d 次", n.Load())
	}

	// 失败不标记：下次仍会执行
	fail := func() error { return errors.New("x") }
	_ = d.Once("e2", fail)
	_ = d.Once("e2", fn)
	if n.Load() != 2 {
		t.Fatalf("失败后的重试投递不应被吞, 执行了 %d 次", n.Load())
	}

	// 容量淘汰：max=2，e1/e2/e3 → e1 被淘汰后可再次执行
	_ = d.Once("e3", fn)
	_ = d.Once("e1", fn)
	if n.Load() != 4 {
		t.Fatalf("淘汰后应视为首见, 执行了 %d 次", n.Load())
	}
}
