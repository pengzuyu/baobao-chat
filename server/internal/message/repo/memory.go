package messagerepo

import (
	"context"
	"sort"
	"sync"

	"github.com/baobaowork/server/internal/message/api"
)

// Memory 内存实现：阶段一跑通全链路；并发安全（单锁足够，量级见 04 篇 §1.1 基线）
type Memory struct {
	mu       sync.Mutex
	convs    map[int64]*Conversation
	members  map[int64][]*Member             // convID → members
	msgs     map[int64][]*messageapi.Message // convID → 按 seq 有序
	dupIndex map[int64]map[string]int64      // convID → clientMsgID → msgID
	receipts map[int64]map[int64]*Receipt    // convID → userID
	seqs     map[int64]int64                 // convID → 已分配最大 seq（对齐 Redis INCR 语义）
	nextID   int64
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{
		convs:    map[int64]*Conversation{},
		members:  map[int64][]*Member{},
		msgs:     map[int64][]*messageapi.Message{},
		dupIndex: map[int64]map[string]int64{},
		receipts: map[int64]map[int64]*Receipt{},
		seqs:     map[int64]int64{},
		nextID:   0, // 会话 ID 从 1 起（雪花占位）
	}
}

var _ Repo = (*Memory)(nil)

// CreateConversation 建会话（ID 自增占位，阶段二雪花）
func (m *Memory) CreateConversation(_ context.Context, c Conversation) (Conversation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.ID == 0 {
		m.nextID++
		c.ID = m.nextID
	}
	if c.Status == 0 {
		c.Status = 1
	}
	cp := c
	m.convs[c.ID] = &cp
	if _, ok := m.members[c.ID]; !ok {
		m.members[c.ID] = []*Member{}
	}
	return cp, nil
}

// DissolveConversation 解散（04 篇 §4.5.2：status=dissolved 只读）
func (m *Memory) DissolveConversation(_ context.Context, convID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.convs[convID]; ok {
		c.Status = 2
	}
	return nil
}

// GetConversation 查会话
func (m *Memory) GetConversation(_ context.Context, convID int64) (*Conversation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.convs[convID]; ok {
		cp := *c
		return &cp, nil
	}
	return nil, messageapi.ErrNotFound
}

// AddMember 加成员（幂等：同 user 覆盖状态）
func (m *Memory) AddMember(_ context.Context, mem Member) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.members[mem.ConvID] {
		if e.UserID == mem.UserID {
			e.Status = 1
			e.Role = mem.Role
			e.MuteUntil = mem.MuteUntil // 覆盖语义：禁言时间一并更新（漏掉导致 upsert 丢禁言）
			return nil
		}
	}
	if mem.Status == 0 {
		mem.Status = 1
	}
	cp := mem
	m.members[mem.ConvID] = append(m.members[mem.ConvID], &cp)
	if c, ok := m.convs[mem.ConvID]; ok {
		c.MemberCount++
	}
	return nil
}

// AllocSeq 会话内单调 +1（生产为 Redis INCR：单点分配天然全序，04 篇 §7.2）
func (m *Memory) AllocSeq(_ context.Context, convID int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seqs[convID]++
	return m.seqs[convID], nil
}

// InsertMessage 落库：幂等冲突返回 ErrDuplicateClientMsgID；msgs 保持 seq 有序
func (m *Memory) InsertMessage(_ context.Context, msg messageapi.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	idx, ok := m.dupIndex[msg.ConvID]
	if !ok {
		idx = map[string]int64{}
		m.dupIndex[msg.ConvID] = idx
	}
	if _, dup := idx[msg.ClientMsgID]; dup {
		return ErrDuplicateClientMsgID
	}
	cp := msg
	idx[msg.ClientMsgID] = msg.ID
	m.msgs[msg.ConvID] = append(m.msgs[msg.ConvID], &cp)
	// service 层在单会话锁内完成 alloc+insert，正常路径天然有序；防御性再排一次
	sort.Slice(m.msgs[msg.ConvID], func(i, j int) bool {
		return m.msgs[msg.ConvID][i].Seq < m.msgs[msg.ConvID][j].Seq
	})
	return nil
}

// FindByClientMsgID 幂等命中查询
func (m *Memory) FindByClientMsgID(_ context.Context, convID int64, clientMsgID string) (*messageapi.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.dupIndex[convID][clientMsgID]; ok {
		for _, msg := range m.msgs[convID] {
			if msg.ID == id {
				cp := *msg
				return &cp, nil
			}
		}
	}
	return nil, nil
}

// ListMessages after<seq<before（after/before=0 表示不限）；按 seq 升序，limit≤0 取 20
func (m *Memory) ListMessages(_ context.Context, convID, after, before int64, limit int) ([]messageapi.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	out := []messageapi.Message{}
	for _, msg := range m.msgs[convID] {
		if after > 0 && msg.Seq <= after {
			continue
		}
		if before > 0 && msg.Seq >= before {
			continue
		}
		out = append(out, *msg)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// MemberOf 查单个成员（不存在返回 nil,nil）
func (m *Memory) MemberOf(_ context.Context, convID, userID int64) (*Member, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.members[convID] {
		if e.UserID == userID {
			cp := *e
			return &cp, nil
		}
	}
	return nil, nil
}

// MembersOf 在群成员 ID 列表（扇出目标）
func (m *Memory) MembersOf(_ context.Context, convID int64) ([]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := []int64{}
	for _, e := range m.members[convID] {
		if e.Status == 1 {
			ids = append(ids, e.UserID)
		}
	}
	return ids, nil
}

// TouchConversation 冗余更新（latest_seq/last_msg_ts）
func (m *Memory) TouchConversation(_ context.Context, convID, seq, ts int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.convs[convID]; ok {
		if seq > c.LatestSeq {
			c.LatestSeq = seq
		}
		c.LastMsgTS = ts
	}
	return nil
}

// GetReceipt 回执游标（无记录返回零值）
func (m *Memory) GetReceipt(_ context.Context, convID, userID int64) (Receipt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if byUser, ok := m.receipts[convID]; ok {
		if r, ok2 := byUser[userID]; ok2 {
			return *r, nil
		}
	}
	return Receipt{ConvID: convID, UserID: userID}, nil
}

// SetReadSeq 更新已读游标
func (m *Memory) SetReadSeq(_ context.Context, convID, userID, readSeq int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	byUser, ok := m.receipts[convID]
	if !ok {
		byUser = map[int64]*Receipt{}
		m.receipts[convID] = byUser
	}
	r, ok := byUser[userID]
	if !ok {
		r = &Receipt{ConvID: convID, UserID: userID}
		byUser[userID] = r
	}
	r.ReadSeq = readSeq
	return nil
}

// ListUserConversations 用户会话列表（内存版：全量扫描成员表；PG 版走 user_conv_state 联查）
func (m *Memory) ListUserConversations(_ context.Context, userID int64) ([]Conversation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Conversation{}
	for convID, ms := range m.members {
		for _, e := range ms {
			if e.UserID == userID && e.Status == 1 {
				if c, ok := m.convs[convID]; ok {
					out = append(out, *c)
				}
				break
			}
		}
	}
	// 按最新消息时间倒序（会话列表排序规则，04 篇 D3 §3.1）
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].LastMsgTS > out[j-1].LastMsgTS; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// LastMessage 会话最后一条（msgs 按 seq 有序，取尾部）
func (m *Memory) LastMessage(_ context.Context, convID int64) (*messageapi.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := m.msgs[convID]
	if len(list) == 0 {
		return nil, nil
	}
	cp := *list[len(list)-1]
	return &cp, nil
}
