package messagerepo

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/baobaowork/server/internal/message/api"
)

// Memory 内存实现：阶段一跑通全链路；并发安全（单锁足够，量级见 04 篇 §1.1 基线）
type Memory struct {
	mu       sync.Mutex
	convs    map[int64]*Conversation
	members  map[int64][]*Member                // convID → members
	msgs     map[int64][]*messageapi.Message    // convID → 按 seq 有序
	dupIndex map[int64]map[string]int64         // convID → clientMsgID → msgID
	receipts map[int64]map[int64]*Receipt       // convID → userID
	seqs     map[int64]int64                    // convID → 已分配最大 seq（对齐 Redis INCR 语义）
	states   map[int64]map[int64]*UserConvState // userID → convID → 态
	settings map[int64]*GroupSetting            // convID → 群设置（群/广播群才有）
	applies  map[int64]*Apply                   // applyID → 申请
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
		states:   map[int64]map[int64]*UserConvState{},
		settings: map[int64]*GroupSetting{},
		applies:  map[int64]*Apply{},
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

// AddMember 加成员（幂等：同 user 覆盖状态；member_count=在群口径——
// 「已退/被移出 → 复活」补递增，与 Remove/Quit 的递减对齐，仅覆盖在群行不重复计）
func (m *Memory) AddMember(_ context.Context, mem Member) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.members[mem.ConvID] {
		if e.UserID == mem.UserID {
			reactivated := e.Status != 1
			e.Status = 1
			e.Role = mem.Role
			e.MuteUntil = mem.MuteUntil // 覆盖语义：禁言时间一并更新（漏掉导致 upsert 丢禁言）
			e.JoinAt = time.Now()
			if reactivated {
				if c, ok := m.convs[mem.ConvID]; ok {
					c.MemberCount++
				}
			}
			return nil
		}
	}
	if mem.Status == 0 {
		mem.Status = 1
	}
	if mem.JoinAt.IsZero() {
		mem.JoinAt = time.Now()
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

// GetMessageByID 按消息 ID 全表查（内存版线性扫；量级见 04 篇 §1.1）
func (m *Memory) GetMessageByID(_ context.Context, msgID int64) (*messageapi.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, list := range m.msgs {
		for _, msg := range list {
			if msg.ID == msgID {
				cp := *msg
				return &cp, nil
			}
		}
	}
	return nil, messageapi.ErrNotFound
}

// GetMessageBySeq 会话内按 seq 查（引用快照构建）
func (m *Memory) GetMessageBySeq(_ context.Context, convID, seq int64) (*messageapi.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, msg := range m.msgs[convID] {
		if msg.Seq == seq {
			cp := *msg
			return &cp, nil
		}
	}
	return nil, nil // seq 不存在（引用目标已被物理清理等）→ 空快照由 service 兜底
}

// UpdateMessage 全量替换（按 ID 定位原指针）
func (m *Memory) UpdateMessage(_ context.Context, u messageapi.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, list := range m.msgs {
		for i, msg := range list {
			if msg.ID == u.ID {
				cp := u
				list[i] = &cp
				return nil
			}
		}
	}
	return messageapi.ErrNotFound
}

// UserConvState 读用户会话态（无记录返回零值）
func (m *Memory) UserConvState(_ context.Context, userID, convID int64) (UserConvState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if byConv, ok := m.states[userID]; ok {
		if s, ok2 := byConv[convID]; ok2 {
			return *s, nil
		}
	}
	return UserConvState{}, nil
}

// SetUserConvState upsert
func (m *Memory) SetUserConvState(_ context.Context, userID, convID int64, s UserConvState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	byConv, ok := m.states[userID]
	if !ok {
		byConv = map[int64]*UserConvState{}
		m.states[userID] = byConv
	}
	cp := s
	byConv[convID] = &cp
	return nil
}

// ListMessagesLatest 最新 N 条：尾取 N 后反转（msgs 按 seq 有序）
func (m *Memory) ListMessagesLatest(_ context.Context, convID int64, limit int) ([]messageapi.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	list := m.msgs[convID]
	out := []messageapi.Message{}
	for i := len(list) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, *list[i])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
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

// ── 群管理（D03 §3.5/§3.6/§4.1 INT-IM-15~19）──

// findMemberLocked 定位成员指针（须持锁）
func (m *Memory) findMemberLocked(convID, userID int64) *Member {
	for _, e := range m.members[convID] {
		if e.UserID == userID {
			return e
		}
	}
	return nil
}

// UpdateMemberRole 角色变更（status 非 0 时一并覆盖；行不存在返回 ErrNotFound）
func (m *Memory) UpdateMemberRole(_ context.Context, convID, userID int64, role, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.findMemberLocked(convID, userID)
	if e == nil {
		return messageapi.ErrNotFound
	}
	e.Role = role
	if status != 0 {
		e.Status = status
	}
	return nil
}

// RemoveMember 移出（status=3；原在群才递减 member_count，S2 状态机）
func (m *Memory) RemoveMember(_ context.Context, convID, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.findMemberLocked(convID, userID)
	if e == nil || e.Status != 1 {
		return nil
	}
	e.Status = 3
	e.MuteUntil = time.Time{}
	if c, ok := m.convs[convID]; ok && c.MemberCount > 0 {
		c.MemberCount--
	}
	return nil
}

// QuitMember 退群（status=2）
func (m *Memory) QuitMember(_ context.Context, convID, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.findMemberLocked(convID, userID)
	if e == nil || e.Status != 1 {
		return nil
	}
	e.Status = 2
	e.MuteUntil = time.Time{}
	if c, ok := m.convs[convID]; ok && c.MemberCount > 0 {
		c.MemberCount--
	}
	return nil
}

// MuteMember 单人禁言（零值=解除）
func (m *Memory) MuteMember(_ context.Context, convID, userID int64, until time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.findMemberLocked(convID, userID); e != nil {
		e.MuteUntil = until
	}
	return nil
}

// UpdateConversationMeta 群名/群主变更（空串/0 = 不变）
func (m *Memory) UpdateConversationMeta(_ context.Context, convID int64, name string, ownerID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.convs[convID]; ok {
		if name != "" {
			c.Name = name
		}
		if ownerID != 0 {
			c.OwnerID = ownerID
		}
	}
	return nil
}

// FindSingleConv 单聊去重：同对成员且双方在群的 active 单聊（INT-IM-15）
func (m *Memory) FindSingleConv(_ context.Context, userA, userB int64) (*Conversation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for convID, c := range m.convs {
		if c.Type != messageapi.ConvSingle || c.Status != messageapi.ConvActive {
			continue
		}
		aIn, bIn := false, false
		for _, e := range m.members[convID] {
			if e.Status != 1 {
				continue
			}
			if e.UserID == userA {
				aIn = true
			}
			if e.UserID == userB {
				bIn = true
			}
		}
		if aIn && bIn {
			cp := *c
			return &cp, nil
		}
	}
	return nil, nil
}

// ListMembersDetailed 成员行明细（全状态，含 role/mute_until/join_at）
func (m *Memory) ListMembersDetailed(_ context.Context, convID int64) ([]Member, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Member{}
	for _, e := range m.members[convID] {
		out = append(out, *e)
	}
	return out, nil
}

// GetGroupSetting 群设置（无记录返回默认值）
func (m *Memory) GetGroupSetting(_ context.Context, convID int64) (GroupSetting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.settings[convID]; ok {
		return *s, nil
	}
	return DefaultGroupSetting(convID), nil
}

// UpsertGroupSetting 整行覆盖
func (m *Memory) UpsertGroupSetting(_ context.Context, s GroupSetting) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := s
	m.settings[s.ConvID] = &cp
	return nil
}

// CreateApply 入群申请（ID=0 时自增分配；JoinAt 同思路）
func (m *Memory) CreateApply(_ context.Context, a Apply) (Apply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a.ID == 0 {
		m.nextID++
		a.ID = m.nextID
	}
	if a.Status == 0 {
		a.Status = ApplyPending
	}
	cp := a
	m.applies[a.ID] = &cp
	return cp, nil
}

// GetApplyByID 查申请
func (m *Memory) GetApplyByID(_ context.Context, id int64) (*Apply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a, ok := m.applies[id]; ok {
		cp := *a
		return &cp, nil
	}
	return nil, messageapi.ErrNotFound
}

// UpdateApplyStatus 状态机流转
func (m *Memory) UpdateApplyStatus(_ context.Context, id int64, status int, handledBy int64, handledAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a, ok := m.applies[id]; ok {
		a.Status = status
		a.HandledBy = handledBy
		a.HandledAt = handledAt
	}
	return nil
}

// ListAppliesByConv 按状态列申请（status=0 全部）
func (m *Memory) ListAppliesByConv(_ context.Context, convID int64, status int) ([]Apply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Apply{}
	for _, a := range m.applies {
		if a.ConvID == convID && (status == 0 || a.Status == status) {
			out = append(out, *a)
		}
	}
	return out, nil
}
