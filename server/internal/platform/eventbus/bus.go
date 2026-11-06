// Package eventbus 进程内事件总线（D02 §5）。
// 语义：至少一次投递 + 订阅方按 event_id 幂等去重；
// 阶段二替换为 NATS/Redis Streams（接口不变，D02 §11 开放问题 1）。
package eventbus

import (
	"context"
	"crypto/rand"
	"fmt"
	"sync"
	"time"
)

// Topic 事件主题（注册表：D02 §5；新增 topic 必须先登记）
const (
	TopicMsgCreated      = "msg.created"         // message → gateway(扇出)/notify/audit
	TopicMsgReadUpdated  = "msg.read.updated"    // message → gateway(推送 msg.receipt 给其他成员，04 篇 §4.2)
	TopicMsgRecalled     = "msg.recalled"        // message → gateway/audit
	TopicConvUpdated     = "conv.updated"        // message → gateway/audit
	TopicFileScanDone    = "file.scan.completed" // file → gateway/message
	TopicDocVersion      = "doc.version.created" // doc → gateway/kb
	TopicKBDocReady      = "kb.doc.ready"        // kb → gateway
	TopicAppPublished    = "app.version.published"
	TopicAppRevoked      = "app.revoked"
	TopicAuditEvent      = "audit.event"           // 全部 → audit（落库失败必须死信告警，15 篇）
	TopicPolicyUpdated   = "policy.updated"        // admin → gateway
	TopicUserOffboarded  = "user.offboarded"       // admin → org/doc/kb/eco/mail
	TopicUserUpdated     = "user.updated"          // org → gateway/message
	TopicUserDeptChanged = "user.dept_changed"     // org → gateway/message
	TopicTenantStatus    = "tenant.status.changed" // admin → gateway/各域
)

// Event 事件信封；ID 用于订阅方幂等去重（至少一次语义下的重复投递是常态）
type Event struct {
	ID        string `json:"event_id"`
	Topic     string `json:"topic"`
	Payload   any    `json:"payload"`
	Timestamp int64  `json:"ts"`
}

// Handler 订阅回调；返回 error 触发重试，重试耗尽进死信
type Handler func(ctx context.Context, evt Event) error

// Bus 总线接口（D02 §5）
type Bus interface {
	Publish(ctx context.Context, topic string, payload any) error
	Subscribe(topic string, h Handler)
}

func newEventID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("eventbus: rand: %v", err))
	}
	return fmt.Sprintf("evt-%x", b)
}

// InMemory 进程内实现：同步分发 + 固定次数重试 + 死信回调。
// 注意：Publish 与 Subscribe 并发安全；分发在发布方 goroutine 内同步执行
// （单机阶段一够用；跨进程后由 NATS 承担至少一次语义）。
type InMemory struct {
	mu           sync.RWMutex
	subs         map[string][]Handler
	retries      int // 失败后额外重试次数（共执行 retries+1 次）
	now          func() time.Time
	dead         []Event
	deadMu       sync.Mutex
	OnDeadLetter func(evt Event, handlerErr error) // 死信回调（告警挂点，15 篇：不允许静默丢失）
}

// New 构造默认总线（每 handler 最多重试 2 次）
func New() *InMemory {
	return &InMemory{subs: map[string][]Handler{}, retries: 2, now: time.Now}
}

// Subscribe 装配期注册（运行期不应变更）
func (b *InMemory) Subscribe(topic string, h Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subs[topic] = append(b.subs[topic], h)
}

// Publish 至少 once 分发；本实现无订阅者即丢弃（阶段一注释：跨进程实现需持久化）
func (b *InMemory) Publish(ctx context.Context, topic string, payload any) error {
	evt := Event{ID: newEventID(), Topic: topic, Payload: payload, Timestamp: b.now().UnixMilli()}

	b.mu.RLock()
	handlers := make([]Handler, len(b.subs[topic]))
	copy(handlers, b.subs[topic])
	b.mu.RUnlock()

	for _, h := range handlers {
		var err error
		for attempt := 0; attempt <= b.retries; attempt++ {
			if err = h(ctx, evt); err == nil {
				break
			}
		}
		if err != nil {
			b.deadMu.Lock()
			b.dead = append(b.dead, evt)
			b.deadMu.Unlock()
			if b.OnDeadLetter != nil {
				b.OnDeadLetter(evt, err)
			}
		}
	}
	return nil
}

// DeadLetters 死信快照（观测/测试用）
func (b *InMemory) DeadLetters() []Event {
	b.deadMu.Lock()
	defer b.deadMu.Unlock()
	return append([]Event(nil), b.dead...)
}

// Dedup 幂等消费骨架：同一 event_id 的处理函数只成功执行一次。
// 不变量：仅处理成功后才标记已见——失败重试不会被去重吞掉。
type Dedup struct {
	mu    sync.Mutex
	seen  map[string]struct{}
	order []string // FIFO 淘汰顺序
	max   int
}

// NewDedup 容量上限 max（超出淘汰最早记录，防内存无界增长）
func NewDedup(max int) *Dedup {
	if max <= 0 {
		max = 1024
	}
	return &Dedup{seen: map[string]struct{}{}, max: max}
}

// Once 首见执行 fn；重复 event_id 直接跳过（返回 nil）
func (d *Dedup) Once(id string, fn func() error) error {
	d.mu.Lock()
	_, dup := d.seen[id]
	d.mu.Unlock()
	if dup {
		return nil
	}
	if err := fn(); err != nil {
		return err // 失败不标记，允许下次投递重试
	}
	d.mu.Lock()
	if _, ok := d.seen[id]; !ok {
		if len(d.order) >= d.max { // 淘汰最早
			delete(d.seen, d.order[0])
			d.order = d.order[1:]
		}
		d.seen[id] = struct{}{}
		d.order = append(d.order, id)
	}
	d.mu.Unlock()
	return nil
}
