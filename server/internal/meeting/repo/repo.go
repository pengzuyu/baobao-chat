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
	ID           int64     `json:"id,string"`
	TenantID     int64     `json:"tenant_id"`
	MeetingID    int64     `json:"meeting_id"`
	UserID       int64     `json:"user_id,string"`
	Role         int       `json:"role"` // 1 organizer 2 host 3 participant
	RSVP         int       `json:"rsvp"`
	InviteSource int       `json:"invite_source"`
	InvitedAt    time.Time `json:"invited_at"`
	RespondedAt  time.Time `json:"responded_at"`
}

// Recurrence 周期系列（21 §5）
type Recurrence struct {
	ID           int64     `json:"id,string"`
	TenantID     int64     `json:"tenant_id"`
	Rule         string    `json:"rule"`
	SkipHolidays bool      `json:"skip_holidays"`
	HolidayCalID int64     `json:"holiday_cal_id,omitempty"`
	SplitFrom    int64     `json:"split_from,omitempty"`
	OrganizerID  int64     `json:"organizer_id,string"`
	CreatedAt    time.Time `json:"created_at"`
}

// Meeting 会议行
type Meeting struct {
	ID            int64         `json:"id,string"`
	TenantID      int64         `json:"tenant_id"`
	SeriesID      int64         `json:"series_id,string,omitempty"` // → Recurrence（单场省略）
	MeetingNo     string        `json:"meeting_no"`
	Title         string        `json:"title"`
	AgendaMD      string        `json:"agenda_md"`
	Type          int           `json:"type"`
	OrganizerID   int64         `json:"organizer_id,string"`
	HostID        int64         `json:"host_id,string"`
	Status        int           `json:"status"`
	StartTime     time.Time     `json:"start_time"`
	EndTime       time.Time     `json:"end_time"`
	TZ            string        `json:"tz"`
	ConvID        int64         `json:"conv_id,string,omitempty"`
	CallSessionID int64         `json:"-"`
	CreatedBy     int64         `json:"created_by,string"`
	CreatedAt     time.Time     `json:"created_at"`
	Participants  []Participant `json:"participants,omitempty"` // 详情/列表携带（repo 联查填充）
}

// CalendarEvent 日历事件（每人一行镜像）
type CalendarEvent struct {
	ID         int64     `json:"id,string"`
	TenantID   int64     `json:"tenant_id"`
	UserID     int64     `json:"user_id,string"`
	Source     int       `json:"source"` // 1 meeting
	RefID      int64     `json:"ref_id,string"`
	Title      string    `json:"title"`
	StartTS    time.Time `json:"start_ts"`
	EndTS      time.Time `json:"end_ts"`
	AllDay     bool      `json:"all_day"`
	TZ         string    `json:"tz"`
	Busy       bool      `json:"busy"`
	RSVPStatus int       `json:"rsvp_status"`
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
	UserID int64     `json:"user_id"`
	Start  time.Time `json:"start"`
	End    time.Time `json:"end"`
	Title  string    `json:"title"`
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
