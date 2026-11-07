// 内存实现：满足 Repo 接口（无 PG 时的开发/测试装配）。
package mailrepo

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Memory 邮件域内存仓储（并发安全；ID 自增）
type Memory struct {
	mu        sync.Mutex
	seq       int64
	domains   map[int64]*Domain
	mailboxes map[int64]*Mailbox
	folders   map[int64]*Folder
	messages  map[int64]*Message // 按 id；folder 归属经 FolderID
	appPwd    map[int64]*AppPassword
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{
		domains:   map[int64]*Domain{},
		mailboxes: map[int64]*Mailbox{},
		folders:   map[int64]*Folder{},
		messages:  map[int64]*Message{},
		appPwd:    map[int64]*AppPassword{},
	}
}

var _ Repo = (*Memory)(nil)

func (m *Memory) nextID() int64 { m.seq++; return m.seq }

// EnsureDefaultDomain seed 默认域（存在即返回）
func (m *Memory) EnsureDefaultDomain(_ context.Context, tenantID int64, domain string) (Domain, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, d := range m.domains {
		if d.TenantID == tenantID && d.IsDefault {
			return *d, nil
		}
	}
	d := Domain{
		ID: m.nextID(), TenantID: tenantID, Domain: domain,
		Mode: 1, IsDefault: true, CreatedAt: time.Now(),
	}
	m.domains[d.ID] = &d
	return d, nil
}

func (m *Memory) ListDomains(_ context.Context, tenantID int64) ([]Domain, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Domain{}
	for _, d := range m.domains {
		if d.TenantID == tenantID {
			out = append(out, *d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) GetMailboxByOwner(_ context.Context, tenantID, userID int64) (*Mailbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mb := range m.mailboxes {
		if mb.TenantID == tenantID && mb.OwnerUserID == userID {
			out := *mb
			return &out, nil
		}
	}
	return nil, ErrNotFound
}

func (m *Memory) GetMailboxByAddress(_ context.Context, tenantID int64, address string) (*Mailbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mb := range m.mailboxes {
		if mb.TenantID == tenantID && strings.EqualFold(mb.Address, address) {
			out := *mb
			return &out, nil
		}
	}
	return nil, ErrNotFound
}

func (m *Memory) CreateMailbox(_ context.Context, mb Mailbox) (Mailbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mb.ID = m.nextID()
	mb.CreatedAt = time.Now()
	cp := mb
	m.mailboxes[mb.ID] = &cp
	for _, name := range SystemFolders {
		f := Folder{ID: m.nextID(), TenantID: mb.TenantID, MailboxID: mb.ID, Name: name}
		m.folders[f.ID] = &f
	}
	return mb, nil
}

func (m *Memory) ListMailboxes(_ context.Context, tenantID int64, status int) ([]Mailbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Mailbox{}
	for _, mb := range m.mailboxes {
		if mb.TenantID == tenantID && (status == 0 || mb.Status == status) {
			out = append(out, *mb)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) UpdateMailboxStatus(_ context.Context, tenantID, mailboxID int64, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mb, ok := m.mailboxes[mailboxID]
	if !ok || mb.TenantID != tenantID {
		return ErrNotFound
	}
	mb.Status = status
	if status == 2 {
		mb.SuspendedAt = time.Now()
	} else {
		mb.SuspendedAt = time.Time{}
	}
	return nil
}

func (m *Memory) AddUsage(_ context.Context, _, mailboxID, delta int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mb, ok := m.mailboxes[mailboxID]
	if !ok {
		return ErrNotFound
	}
	mb.UsedBytes += delta
	if mb.UsedBytes < 0 {
		mb.UsedBytes = 0
	}
	return nil
}

func (m *Memory) UpdateSettings(_ context.Context, _, mailboxID int64, s Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mb, ok := m.mailboxes[mailboxID]
	if !ok {
		return ErrNotFound
	}
	mb.Settings = s
	return nil
}

func (m *Memory) ListFolders(_ context.Context, mailboxID int64) ([]Folder, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Folder{}
	for _, f := range m.folders {
		if f.MailboxID == mailboxID {
			out = append(out, *f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) InsertMessage(_ context.Context, msg Message) (Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.messages {
		if ex.MailboxID == msg.MailboxID && ex.MessageID == msg.MessageID {
			return Message{}, ErrDuplicateMessageID
		}
	}
	msg.ID = m.nextID()
	if msg.ReceivedAt.IsZero() {
		msg.ReceivedAt = time.Now()
	}
	cp := msg
	m.messages[msg.ID] = &cp
	if f, ok := m.folders[msg.FolderID]; ok {
		f.TotalCount++
		if msg.Flags&FlagSeen == 0 {
			f.UnreadCount++
		}
	}
	return msg, nil
}

func (m *Memory) GetMessage(_ context.Context, tenantID, msgID int64) (*Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[msgID]
	if !ok || msg.TenantID != tenantID {
		return nil, ErrNotFound
	}
	out := *msg
	return &out, nil
}

func (m *Memory) ListMessages(_ context.Context, mailboxID, folderID, cursor int64, limit int, filter string) ([]Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Message{}
	for _, msg := range m.messages {
		if msg.MailboxID != mailboxID {
			continue
		}
		if folderID != 0 && msg.FolderID != folderID {
			continue
		}
		if cursor != 0 && msg.ID >= cursor {
			continue
		}
		switch filter {
		case FilterUnread:
			if msg.Flags&FlagSeen != 0 {
				continue
			}
		case FilterStarred:
			if msg.Flags&FlagFlagged == 0 {
				continue
			}
		case FilterAttach:
			if !msg.HasAttachment {
				continue
			}
		}
		out = append(out, *msg)
	}
	sort.Slice(out, func(i, j int) bool {
		pi, pj := out[i], out[j]
		if !pi.ReceivedAt.Equal(pj.ReceivedAt) {
			return pi.ReceivedAt.After(pj.ReceivedAt)
		}
		return pi.ID > pj.ID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Memory) UpdateFlags(_ context.Context, tenantID, msgID int64, mask, val int16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[msgID]
	if !ok || msg.TenantID != tenantID {
		return ErrNotFound
	}
	wasUnread := msg.Flags&FlagSeen == 0
	msg.Flags = (msg.Flags &^ mask) | (val & mask)
	nowUnread := msg.Flags&FlagSeen == 0
	if wasUnread != nowUnread {
		if f, ok := m.folders[msg.FolderID]; ok {
			if nowUnread {
				f.UnreadCount++
			} else {
				f.UnreadCount--
			}
		}
	}
	return nil
}

func (m *Memory) MoveMessage(_ context.Context, tenantID, msgID, folderID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[msgID]
	if !ok || msg.TenantID != tenantID {
		return ErrNotFound
	}
	dst, ok := m.folders[folderID]
	if !ok || dst.MailboxID != msg.MailboxID {
		return ErrNotFound
	}
	if msg.FolderID == folderID {
		return nil
	}
	if src, ok := m.folders[msg.FolderID]; ok {
		src.TotalCount--
		if msg.Flags&FlagSeen == 0 {
			src.UnreadCount--
		}
	}
	msg.FolderID = folderID
	dst.TotalCount++
	if msg.Flags&FlagSeen == 0 {
		dst.UnreadCount++
	}
	return nil
}

func (m *Memory) SearchMessages(_ context.Context, tenantID int64, mailboxIDs []int64, q string, attachOnly bool, limit int) ([]Message, error) {
	allow := map[int64]bool{}
	for _, id := range mailboxIDs {
		allow[id] = true
	}
	needle := strings.ToLower(q)
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Message{}
	for _, msg := range m.messages {
		if msg.TenantID != tenantID || !allow[msg.MailboxID] {
			continue
		}
		if attachOnly && !msg.HasAttachment {
			continue
		}
		if needle != "" &&
			!strings.Contains(strings.ToLower(msg.Subject), needle) &&
			!strings.Contains(strings.ToLower(msg.FromAddr), needle) &&
			!strings.Contains(strings.ToLower(msg.Snippet), needle) &&
			!strings.Contains(strings.ToLower(msg.Body), needle) {
			continue
		}
		out = append(out, *msg)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].ReceivedAt.Equal(out[j].ReceivedAt) {
			return out[i].ReceivedAt.After(out[j].ReceivedAt)
		}
		return out[i].ID > out[j].ID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *Memory) CreateAppPassword(_ context.Context, p AppPassword) (AppPassword, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p.ID = m.nextID()
	p.CreatedAt = time.Now()
	cp := p
	m.appPwd[p.ID] = &cp
	return p, nil
}

func (m *Memory) ListAppPasswords(_ context.Context, tenantID, userID int64) ([]AppPassword, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []AppPassword{}
	for _, p := range m.appPwd {
		if p.TenantID == tenantID && p.UserID == userID && p.RevokedAt.IsZero() {
			out = append(out, *p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) RevokeAppPassword(_ context.Context, tenantID, id, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.appPwd[id]
	if !ok || p.TenantID != tenantID || p.UserID != userID || !p.RevokedAt.IsZero() {
		return ErrNotFound
	}
	p.RevokedAt = time.Now()
	return nil
}

// folderIDByName 内部便捷（测试用）：按邮箱+文件夹名取 folderID
func (m *Memory) folderIDByName(mailboxID int64, name string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.folders {
		if f.MailboxID == mailboxID && f.Name == name {
			return f.ID, nil
		}
	}
	return 0, fmt.Errorf("folder %s not found", name)
}

// GetMailboxByID 主键查
func (m *Memory) GetMailboxByID(_ context.Context, _, id int64) (*Mailbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if mb, ok := m.mailboxes[id]; ok {
		out := *mb
		return &out, nil
	}
	return nil, ErrNotFound
}
