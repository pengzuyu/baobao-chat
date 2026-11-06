package gateway

import (
	"errors"
	"sync"
	"sync/atomic"
)

var idCounter atomic.Int64

func init() { idCounter.Store(100000) }

func serverIDSeq() int64 { return idCounter.Add(1) }

// 推送错误
var (
	ErrClientClosed  = errors.New("gateway: client closed")
	ErrSendQueueFull = errors.New("gateway: send queue full (slow consumer)")
)

// sendQueueSize 每连接写出队列深度（满即判定慢连接断开；阶段二换背压窗口）
const sendQueueSize = 256

// Client 一条 WS 连接的服务端表示（hub 只路由信封，写盘由 writeLoop 执行）
type Client struct {
	ID       string
	UserID   int64
	DeviceID string
	send     chan []byte
	closed   chan struct{}
	once     sync.Once
}

// NewClient 构造
func NewClient(userID int64, deviceID string) *Client {
	return &Client{
		ID:       NewServerID(),
		UserID:   userID,
		DeviceID: deviceID,
		send:     make(chan []byte, sendQueueSize),
		closed:   make(chan struct{}),
	}
}

// Send 序列化并入队；队列满=慢连接，丢弃并断开（防 fanout 阻塞拖垮全局）
func (c *Client) Send(env *Envelope) error {
	b, err := env.Encode()
	if err != nil {
		return err
	}
	select {
	case <-c.closed:
		return ErrClientClosed
	default:
	}
	select {
	case c.send <- b:
		return nil
	default:
		c.Close()
		return ErrSendQueueFull
	}
}

// Outbox 写盘循环消费（测试可直接读取）
func (c *Client) Outbox() <-chan []byte { return c.send }

// Close 幂等关闭（触发 writeLoop 退出）
func (c *Client) Close() {
	c.once.Do(func() { close(c.closed) })
}

// Closed 关闭信号
func (c *Client) Closed() <-chan struct{} { return c.closed }

// Hub 进程内连接注册表与扇出（D02 §6：多实例后换 Redis pub/sub 或 NATS）
type Hub struct {
	mu     sync.RWMutex
	byUser map[int64]map[*Client]struct{} // 多端在线：一人多设备
}

// NewHub 构造
func NewHub() *Hub {
	return &Hub{byUser: map[int64]map[*Client]struct{}{}}
}

// Register 注册连接（同用户多端共存）
func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.byUser[c.UserID]
	if !ok {
		set = map[*Client]struct{}{}
		h.byUser[c.UserID] = set
	}
	set[c] = struct{}{}
}

// Unregister 摘除连接
func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.byUser[c.UserID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.byUser, c.UserID)
		}
	}
}

// PushToUser 单用户全端推送；返回送达连接数
func (h *Hub) PushToUser(userID int64, env *Envelope) int {
	h.mu.RLock()
	set := h.byUser[userID]
	targets := make([]*Client, 0, len(set))
	for c := range set {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	n := 0
	for _, c := range targets {
		if c.Send(env) == nil {
			n++
		}
	}
	return n
}

// PushToUsers 多用户扇出（去重后逐用户全端）；返回送达连接数
func (h *Hub) PushToUsers(userIDs []int64, env *Envelope) int {
	seen := make(map[int64]struct{}, len(userIDs))
	n := 0
	for _, uid := range userIDs {
		if _, dup := seen[uid]; dup {
			continue
		}
		seen[uid] = struct{}{}
		n += h.PushToUser(uid, env)
	}
	return n
}

// OnlineCount 在线连接数
func (h *Hub) OnlineCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, set := range h.byUser {
		n += len(set)
	}
	return n
}

// OnlineUsers 在线用户 ID（测试/观测）
func (h *Hub) OnlineUsers() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := make([]int64, 0, len(h.byUser))
	for uid := range h.byUser {
		ids = append(ids, uid)
	}
	return ids
}
