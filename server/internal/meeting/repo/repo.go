// 仓储接口与实体（memory/postgres 双模，D02 §7）。
package meetingrepo

import (
	"context"
	"errors"
	"time"
)

// 哨兵错误
var (
	ErrNotFound = errors.New("meeting: not found")
	ErrDupNo    = errors.New("meeting: duplicate meeting_no")
)

// 会议业务态（21 §4.1）
const (
	StatusScheduled = 1
	StatusLive      = 2
	StatusEnded     = 3
	StatusCanceled  = 4
)

// 类型
const (
	TypeInstant   = 1
	TypeScheduled = 2
)

// RSVP
const (
	RSVPPending   = 1
	RSVPAccepted  = 2
	RSVPTentative = 3
	RSVPDeclined  = 4
)

// Participant 参与者行
type Participant struct {
	ID           int64
	TenantID     int64
	MeetingID    int64
	UserID       int64
	Role         int // 1 organizer 2 host 3 participant
	RSVP         int
	InviteSource int
	InvitedAt    time.Time
	RespondedAt  time.Time
}

// Recurrence 周期系列（21 §5）
type Recurrence struct {
	ID           int64
	TenantID     int64
	Rule         string // rule jsonb 原文
	SkipHolidays bool
	HolidayCalID int64
	SplitFrom    int64 // this_and_after 拆分来源系列
	OrganizerID  int64
	CreatedAt    time.Time
}

// Meeting 会议行
type Meeting struct {
	ID            int64
	TenantID      int64
	SeriesID      int64 // → Recurrence（单场 0）
	MeetingNo     string
	Title         string
	AgendaMD      string
	Type          int
	OrganizerID   int64
	HostID        int64
	Status        int
	StartTime     time.Time
	EndTime       time.Time
	TZ            string
	ConvID        int64
	CallSessionID int64
	CreatedBy     int64
	CreatedAt     time.Time
	Participants  []Participant // 详情/列表携带（repo 联查填充）
}

// CalendarEvent 日历事件（每人一行镜像）
type CalendarEvent struct {
	ID         int64
	TenantID   int64
	UserID     int64
	Source     int // 1 meeting
	RefID      int64
	Title      string
	StartTS    time.Time
	EndTS      time.Time
	AllDay     bool
	TZ         string
	Busy       bool
	RSVPStatus int
}

// CreateReq 预约/即时创建入参
type CreateReq struct {
	SeriesID     int64 // 周期系列归属（单场 0；系列展开直传）
	Title        string
	AgendaMD     string
	Type         int
	StartTime    time.Time
	EndTime      time.Time
	TZ           string
	ConvID       int64
	OrganizerID  int64
	Participants []int64 // 不含组织者（repo 补）
}

// BusyBlock 忙闲聚合块
type BusyBlock struct {
	UserID int64
	Start  time.Time
	End    time.Time
	Title  string
}

// Repo 会议域仓储
type Repo interface {
	CreateMeeting(ctx context.Context, m Meeting, participants []Participant) (Meeting, error)
	GetMeeting(ctx context.Context, tenantID, id int64) (*Meeting, error)
	GetByMeetingNo(ctx context.Context, tenantID int64, no string) (*Meeting, error)
	// UpdateMeetingTime 改期（start/end；日历同步由 service）
	UpdateMeetingTime(ctx context.Context, tenantID, id int64, start, end time.Time) error
	UpdateStatus(ctx context.Context, tenantID, id int64, status int) error
	// ListForUser 用户会议（组织或参与，时间窗 [from,to)，状态过滤 0=非取消）
	ListForUser(ctx context.Context, tenantID, userID int64, from, to time.Time, includeCanceled bool) ([]Meeting, error)
	ListParticipants(ctx context.Context, tenantID, meetingID int64) ([]Participant, error)
	// UpdateRSVP 回执（存在性校验；responded_at 记录）
	UpdateRSVP(ctx context.Context, tenantID, meetingID, userID int64, rsvp int) error

	// 日历（唯一事实源：预约/改期/取消同步维护）
	ReplaceEvents(ctx context.Context, tenantID, refID int64, events []CalendarEvent) error
	ListEvents(ctx context.Context, tenantID, userID int64, from, to time.Time) ([]CalendarEvent, error)
	// BusyOf 忙闲聚合（多用户时间窗）
	BusyOf(ctx context.Context, tenantID int64, userIDs []int64, from, to time.Time) ([]BusyBlock, error)

	// ── 周期系列（21 §4.2/§5）──
	CreateRecurrence(ctx context.Context, r Recurrence) (Recurrence, error)
	GetRecurrence(ctx context.Context, tenantID, id int64) (*Recurrence, error)
	// ListBySeries 系列场次（start 升序）
	ListBySeries(ctx context.Context, tenantID, seriesID int64) ([]Meeting, error)
	// UpdateSeriesFields 系列属性（title/agenda）应用到未开始场次
	UpdateSeriesFields(ctx context.Context, tenantID, seriesID int64, title, agenda string) error
	// SplitSeries fromMeetingID 及其之后（start>=该场）的场次指向新系列
	SplitSeries(ctx context.Context, tenantID, seriesID, newSeriesID, fromMeetingID int64) (int, error)
}
