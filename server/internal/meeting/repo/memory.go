// 内存实现：满足 Repo 接口（开发/测试）。
package meetingrepo

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Memory 会议域内存仓储
type Memory struct {
	mu     sync.Mutex
	seq    int64
	byID   map[int64]*Meeting
	recs   map[int64]*Recurrence
	byNo   map[string]int64
	parts  map[int64][]Participant // meetingID → 行
	events map[int64][]CalendarEvent
	eseq   int64
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{byID: map[int64]*Meeting{}, recs: map[int64]*Recurrence{}, byNo: map[string]int64{}, parts: map[int64][]Participant{}, events: map[int64][]CalendarEvent{}}
}

var _ Repo = (*Memory)(nil)

func (m *Memory) CreateMeeting(_ context.Context, mt Meeting, participants []Participant) (Meeting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.byNo[noKey(mt.TenantID, mt.MeetingNo)]; dup {
		return Meeting{}, ErrDupNo
	}
	m.seq++
	mt.ID = m.seq
	mt.CreatedAt = time.Now()
	cp := mt
	m.byID[mt.ID] = &cp
	m.byNo[noKey(mt.TenantID, mt.MeetingNo)] = mt.ID
	rows := append([]Participant{}, participants...)
	for i := range rows {
		m.seq++
		rows[i].ID = m.seq
		rows[i].TenantID = mt.TenantID
		rows[i].MeetingID = mt.ID
		if rows[i].InvitedAt.IsZero() {
			rows[i].InvitedAt = time.Now()
		}
	}
	m.parts[mt.ID] = rows
	mt.Participants = append([]Participant{}, rows...)
	return mt, nil
}

func (m *Memory) GetMeeting(_ context.Context, _, id int64) (*Meeting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mt, ok := m.byID[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := *mt
	out.Participants = append([]Participant{}, m.parts[id]...)
	return &out, nil
}

func (m *Memory) GetByMeetingNo(_ context.Context, tenantID int64, no string) (*Meeting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byNo[noKey(tenantID, no)]
	if !ok {
		return nil, ErrNotFound
	}
	return m.GetMeeting(context.Background(), tenantID, id)
}

func (m *Memory) UpdateMeetingTime(_ context.Context, _, id int64, start, end time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mt, ok := m.byID[id]
	if !ok {
		return ErrNotFound
	}
	mt.StartTime, mt.EndTime = start, end
	return nil
}

func (m *Memory) UpdateStatus(_ context.Context, _, id int64, status int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mt, ok := m.byID[id]
	if !ok {
		return ErrNotFound
	}
	mt.Status = status
	return nil
}

func (m *Memory) ListForUser(_ context.Context, _ int64, userID int64, from, to time.Time, includeCanceled bool) ([]Meeting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Meeting{}
	for _, mt := range m.byID {
		if mt.Status == StatusCanceled && !includeCanceled {
			continue
		}
		if mt.StartTime.Before(to) && mt.EndTime.After(from) {
			involved := mt.OrganizerID == userID
			if !involved {
				for _, p := range m.parts[mt.ID] {
					if p.UserID == userID {
						involved = true
						break
					}
				}
			}
			if involved {
				cp := *mt
				cp.Participants = append([]Participant{}, m.parts[mt.ID]...)
				out = append(out, cp)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartTime.Before(out[j].StartTime) })
	return out, nil
}

func (m *Memory) ListParticipants(_ context.Context, _, meetingID int64) ([]Participant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows, ok := m.parts[meetingID]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]Participant{}, rows...), nil
}

func (m *Memory) UpdateRSVP(_ context.Context, _, meetingID, userID int64, rsvp int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := m.parts[meetingID]
	for i := range rows {
		if rows[i].UserID == userID {
			rows[i].RSVP = rsvp
			rows[i].RespondedAt = time.Now()
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) ReplaceEvents(_ context.Context, _ int64, refID int64, events []CalendarEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := append([]CalendarEvent{}, events...)
	for i := range rows {
		if rows[i].ID == 0 {
			m.eseq++
			rows[i].ID = m.eseq
		}
	}
	m.events[refID] = rows
	return nil
}

func (m *Memory) ListEvents(_ context.Context, _ int64, userID int64, from, to time.Time) ([]CalendarEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []CalendarEvent{}
	for _, rows := range m.events {
		for _, e := range rows {
			if e.UserID == userID && e.StartTS.Before(to) && e.EndTS.After(from) {
				out = append(out, e)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartTS.Before(out[j].StartTS) })
	return out, nil
}

func (m *Memory) BusyOf(_ context.Context, _ int64, userIDs []int64, from, to time.Time) ([]BusyBlock, error) {
	allow := map[int64]bool{}
	for _, id := range userIDs {
		allow[id] = true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []BusyBlock{}
	for _, rows := range m.events {
		for _, e := range rows {
			if e.Busy && allow[e.UserID] && e.StartTS.Before(to) && e.EndTS.After(from) {
				out = append(out, BusyBlock{UserID: e.UserID, Start: e.StartTS, End: e.EndTS, Title: e.Title})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	return out, nil
}

// noKey 会议号索引键
func noKey(tenantID int64, no string) string {
	return strconv.FormatInt(tenantID, 10) + "|" + no
}

func (m *Memory) CreateRecurrence(_ context.Context, r Recurrence) (Recurrence, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	r.ID = m.seq
	r.CreatedAt = time.Now()
	cp := r
	m.recs[r.ID] = &cp
	return r, nil
}

func (m *Memory) GetRecurrence(_ context.Context, _, id int64) (*Recurrence, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.recs[id]; ok {
		out := *r
		return &out, nil
	}
	return nil, ErrNotFound
}

func (m *Memory) ListBySeries(_ context.Context, _, seriesID int64) ([]Meeting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Meeting{}
	for _, mt := range m.byID {
		if mt.SeriesID == seriesID {
			cp := *mt
			cp.Participants = append([]Participant{}, m.parts[mt.ID]...)
			out = append(out, cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartTime.Before(out[j].StartTime) })
	return out, nil
}

func (m *Memory) UpdateSeriesFields(_ context.Context, _, seriesID int64, title, agenda string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mt := range m.byID {
		if mt.SeriesID == seriesID && mt.Status == StatusScheduled {
			mt.Title, mt.AgendaMD = title, agenda
		}
	}
	return nil
}

func (m *Memory) SplitSeries(_ context.Context, _, seriesID, newSeriesID, fromMeetingID int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	from, ok := m.byID[fromMeetingID]
	if !ok || from.SeriesID != seriesID {
		return 0, ErrNotFound
	}
	moved := 0
	for _, mt := range m.byID {
		if mt.SeriesID == seriesID && !mt.StartTime.Before(from.StartTime) && mt.ID != fromMeetingID {
			mt.SeriesID = newSeriesID
			moved++
		}
	}
	from.SeriesID = newSeriesID
	moved++
	return moved, nil
}
