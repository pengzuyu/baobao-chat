// 会议域服务（21 篇阶段一务实版）。
//
// 会议=预约/日历/RSVP 编排（媒体/信令全复用 05 篇 rtc——入会=加入一场
// 预约好的群通话，meeting_no 即 call_id 约定）。v0.1 裁剪登记：
// 周期会 RRULE 展开与 meeting_recurrence、纪要转写（ASR 依赖）、主持
// 控制媒体面、等候室/锁定、邮件 iCal（22 联动）、会中聊天临时群、
// 外部访客——随阶段二。
package meetingservice

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"strconv"
	"time"

	meetingrepo "github.com/baobaowork/server/internal/meeting/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// 会议时长边界（21 篇 §7 策略缺省；admin_policy 热更随 D10 PAD-09 阶段二）
const (
	MinDuration = 15 * time.Minute
	MaxDuration = 24 * time.Hour
	MaxAhead    = 90 * 24 * time.Hour // 预约不得超 90 天
)

// Options 装配（跨域闭包，D02 §4）
type Options struct {
	// PushMeet 会议事件直推（gateway 惯例：invited/updated/canceled；nil=零推送）
	PushMeet func(userID int64, typ string, payload any)
	Now      func() time.Time
}

// Service 会议域服务
type Service struct {
	repo meetingrepo.Repo
	opts Options
}

// New 构造
func New(r meetingrepo.Repo, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{repo: r, opts: opts}
}

// CreateReq 创建入参（DTO 层转换后）
type CreateReq struct {
	SeriesID     int64
	Title        string
	AgendaMD     string
	Instant      bool // true=即时会（start=now, 30min）
	StartTime    time.Time
	EndTime      time.Time
	TZ           string
	ConvID       int64
	Participants []int64
}

// Create 预约/即时会：校验（时长 15min..24h、≤90 天）→ 组织者+参与者行 →
// calendar_event 全员镜像（唯一日历事实源）→ 推送 invited。
func (s *Service) Create(ctx context.Context, tenantID, organizerID int64, req CreateReq) (*meetingrepo.Meeting, error) {
	if req.Title == "" || len([]rune(req.Title)) > 128 {
		return nil, errx.New(errx.CodeBadRequest, "title 必填（≤128 字）")
	}
	now := s.opts.Now()
	req.TZ = defaultStr(req.TZ, "Asia/Shanghai")
	if req.Instant {
		req.StartTime = now
		req.EndTime = now.Add(30 * time.Minute)
	} else {
		if req.StartTime.IsZero() || req.EndTime.IsZero() {
			return nil, errx.New(errx.CodeBadRequest, "start_time/end_time 必填")
		}
		if d := req.EndTime.Sub(req.StartTime); d < MinDuration || d > MaxDuration {
			return nil, errx.New(errx.CodeBadRequest, "会议时长须 15 分钟～24 小时")
		}
		if req.StartTime.After(now.Add(MaxAhead)) {
			return nil, errx.New(errx.CodeBadRequest, "预约不得超 90 天")
		}
	}
	mtype := meetingrepo.TypeScheduled
	if req.Instant {
		mtype = meetingrepo.TypeInstant
	}
	no, err := meetingNo()
	if err != nil {
		return nil, err
	}
	participants := []meetingrepo.Participant{
		{UserID: organizerID, Role: 1, RSVP: meetingrepo.RSVPAccepted, InviteSource: 1},
	}
	for _, uid := range req.Participants {
		if uid == organizerID {
			continue
		}
		participants = append(participants, meetingrepo.Participant{
			UserID: uid, Role: 3, RSVP: meetingrepo.RSVPPending, InviteSource: 1,
		})
	}
	created, cerr := s.repo.CreateMeeting(ctx, meetingrepo.Meeting{
		TenantID: tenantID, SeriesID: req.SeriesID, MeetingNo: no, Title: req.Title, AgendaMD: req.AgendaMD,
		Type: mtype, OrganizerID: organizerID, HostID: organizerID,
		Status: meetingrepo.StatusScheduled, StartTime: req.StartTime, EndTime: req.EndTime,
		TZ: req.TZ, ConvID: req.ConvID, CreatedBy: organizerID,
	}, participants)
	if cerr != nil {
		if cerr == meetingrepo.ErrDupNo {
			// 会议号碰撞（9 位随机概率极低）：重试一次
			no2, err2 := meetingNo()
			if err2 != nil {
				return nil, err2
			}
			created.MeetingNo = no2
			created, cerr = s.repo.CreateMeeting(ctx, meetingrepo.Meeting{
				TenantID: tenantID, SeriesID: req.SeriesID, MeetingNo: no2, Title: req.Title, AgendaMD: req.AgendaMD,
				Type: mtype, OrganizerID: organizerID, HostID: organizerID,
				Status: meetingrepo.StatusScheduled, StartTime: req.StartTime, EndTime: req.EndTime,
				TZ: req.TZ, ConvID: req.ConvID, CreatedBy: organizerID,
			}, participants)
		}
		if cerr != nil {
			return nil, cerr
		}
	}
	s.syncCalendar(ctx, tenantID, &created)
	s.pushParticipants(&created, "meeting.invited", map[string]any{
		"meeting_id": created.ID, "meeting_no": created.MeetingNo, "title": created.Title,
		"start_ts": created.StartTime.UnixMilli(),
	})
	return &created, nil
}

// Get 详情（参与者可见：组织者/参与者，21 篇 §6 权限口径）
func (s *Service) Get(ctx context.Context, tenantID, userID, id int64) (*meetingrepo.Meeting, error) {
	m, err := s.repo.GetMeeting(ctx, tenantID, id)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "会议不存在")
	}
	if !s.involved(m, userID) {
		return nil, errx.New(errx.CodePermACLDenied, "非会议参与者")
	}
	return m, nil
}

// ListMy 我的会议（组织或参与，时间窗；includeCanceled 含已取消）
func (s *Service) ListMy(ctx context.Context, tenantID, userID int64, from, to time.Time, includeCanceled bool) ([]meetingrepo.Meeting, error) {
	if !to.After(from) {
		return nil, errx.New(errx.CodeBadRequest, "时间窗非法（from<to）")
	}
	return s.repo.ListForUser(ctx, tenantID, userID, from, to, includeCanceled)
}

// CalendarEvents 我的日历（PMT-01 数据源：calendar_event 直读）
func (s *Service) CalendarEvents(ctx context.Context, tenantID, userID int64, from, to time.Time) ([]meetingrepo.CalendarEvent, error) {
	return s.repo.ListEvents(ctx, tenantID, userID, from, to)
}

// FreeBusy 忙闲聚合（S2 预约弹窗冲突提示；uids ≤50）
func (s *Service) FreeBusy(ctx context.Context, tenantID int64, userIDs []int64, from, to time.Time) ([]meetingrepo.BusyBlock, error) {
	if len(userIDs) == 0 || len(userIDs) > 50 {
		return nil, errx.New(errx.CodeBadRequest, "uids 1..50")
	}
	if !to.After(from) {
		return nil, errx.New(errx.CodeBadRequest, "时间窗非法")
	}
	return s.repo.BusyOf(ctx, tenantID, userIDs, from, to)
}

// RSVP 回执（2/3/4）：participant 行更新 + 日历镜像同步 + 组织者推送
func (s *Service) RSVP(ctx context.Context, tenantID, userID, meetingID int64, rsvp int) error {
	if rsvp < meetingrepo.RSVPAccepted || rsvp > meetingrepo.RSVPDeclined {
		return errx.New(errx.CodeBadRequest, "rsvp 2=接受 3=暂定 4=拒绝")
	}
	m, err := s.repo.GetMeeting(ctx, tenantID, meetingID)
	if err != nil {
		return errx.New(errx.CodeNotFound, "会议不存在")
	}
	if m.OrganizerID == userID {
		return errx.New(errx.CodeBadRequest, "组织者无需回执")
	}
	if err := s.repo.UpdateRSVP(ctx, tenantID, meetingID, userID, rsvp); err != nil {
		return errx.New(errx.CodeNotFound, "未被邀请")
	}
	if m, err = s.repo.GetMeeting(ctx, tenantID, meetingID); err == nil {
		s.syncCalendar(ctx, tenantID, m) // rsvp_status 镜像
	}
	if s.opts.PushMeet != nil {
		s.opts.PushMeet(m.OrganizerID, "meeting.rsvp", map[string]any{
			"meeting_id": meetingID, "user_id": userID, "rsvp": rsvp,
		})
	}
	return nil
}

// Reschedule 改期（组织者）：时间校验 + meeting 更新 + 日历同步 + 参与者推送
func (s *Service) Reschedule(ctx context.Context, tenantID, userID, meetingID int64, start, end time.Time) error {
	m, err := s.mustOrganizer(ctx, tenantID, userID, meetingID)
	if err != nil {
		return err
	}
	if m.Status != meetingrepo.StatusScheduled {
		return errx.New(errx.CodeBadRequest, "仅预约态可改期")
	}
	if d := end.Sub(start); d < MinDuration || d > MaxDuration {
		return errx.New(errx.CodeBadRequest, "会议时长须 15 分钟～24 小时")
	}
	if err := s.repo.UpdateMeetingTime(ctx, tenantID, meetingID, start, end); err != nil {
		return err
	}
	if m, err = s.repo.GetMeeting(ctx, tenantID, meetingID); err == nil {
		s.syncCalendar(ctx, tenantID, m)
		s.pushParticipants(m, "meeting.updated", map[string]any{
			"meeting_id": meetingID, "start_ts": start.UnixMilli(),
		})
	}
	return nil
}

// Cancel 取消（组织者）：canceled + 日历清除（ReplaceEvents 空）+ 推送
func (s *Service) Cancel(ctx context.Context, tenantID, userID, meetingID int64) error {
	m, err := s.mustOrganizer(ctx, tenantID, userID, meetingID)
	if err != nil {
		return err
	}
	if m.Status == meetingrepo.StatusEnded || m.Status == meetingrepo.StatusCanceled {
		return errx.New(errx.CodeBadRequest, "会议已结束/取消")
	}
	if err := s.repo.UpdateStatus(ctx, tenantID, meetingID, meetingrepo.StatusCanceled); err != nil {
		return err
	}
	_ = s.repo.ReplaceEvents(ctx, tenantID, meetingID, nil) // 日历撤下
	if m2, gerr := s.repo.GetMeeting(ctx, tenantID, meetingID); gerr == nil {
		s.pushParticipants(m2, "meeting.canceled", map[string]any{"meeting_id": meetingID})
	}
	return nil
}

// StartLive 开始（到点/主持人入会）：scheduled→live；返回 meeting_no
// （客户端以此建群通话 call_id=meeting_no——05 篇 join 模式复用，21 §1.1）
func (s *Service) StartLive(ctx context.Context, tenantID, userID, meetingID int64) (string, error) {
	m, err := s.Get(ctx, tenantID, userID, meetingID)
	if err != nil {
		return "", err
	}
	if m.Status != meetingrepo.StatusScheduled {
		return "", errx.New(errx.CodeBadRequest, "仅预约态可开始")
	}
	if err := s.repo.UpdateStatus(ctx, tenantID, meetingID, meetingrepo.StatusLive); err != nil {
		return "", err
	}
	return m.MeetingNo, nil
}

// EndLive 结束（组织者/主持人）：live→ended + 推送
func (s *Service) EndLive(ctx context.Context, tenantID, userID, meetingID int64) error {
	m, err := s.mustOrganizer(ctx, tenantID, userID, meetingID)
	if err != nil {
		return err
	}
	if m.Status != meetingrepo.StatusLive {
		return errx.New(errx.CodeBadRequest, "会议未在进行中")
	}
	if err := s.repo.UpdateStatus(ctx, tenantID, meetingID, meetingrepo.StatusEnded); err != nil {
		return err
	}
	s.pushParticipants(m, "meeting.ended", map[string]any{"meeting_id": meetingID})
	return nil
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

func (s *Service) mustOrganizer(ctx context.Context, tenantID, userID, meetingID int64) (*meetingrepo.Meeting, error) {
	m, err := s.repo.GetMeeting(ctx, tenantID, meetingID)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "会议不存在")
	}
	if m.OrganizerID != userID && m.HostID != userID {
		return nil, errx.New(errx.CodePermACLDenied, "仅组织者/主持人可操作")
	}
	return m, nil
}

func (s *Service) involved(m *meetingrepo.Meeting, uid int64) bool {
	if m.OrganizerID == uid {
		return true
	}
	for _, p := range m.Participants {
		if p.UserID == uid {
			return true
		}
	}
	return false
}

// syncCalendar 日历镜像（全员一行；RSVP 状态携带）
func (s *Service) syncCalendar(ctx context.Context, tenantID int64, m *meetingrepo.Meeting) {
	events := make([]meetingrepo.CalendarEvent, 0, len(m.Participants)+1)
	events = append(events, meetingrepo.CalendarEvent{
		TenantID: tenantID, UserID: m.OrganizerID, Source: 1, RefID: m.ID,
		Title: m.Title, StartTS: m.StartTime, EndTS: m.EndTime, TZ: m.TZ,
		Busy: true, RSVPStatus: meetingrepo.RSVPAccepted,
	})
	for _, p := range m.Participants {
		if p.UserID == m.OrganizerID {
			continue
		}
		events = append(events, meetingrepo.CalendarEvent{
			TenantID: tenantID, UserID: p.UserID, Source: 1, RefID: m.ID,
			Title: m.Title, StartTS: m.StartTime, EndTS: m.EndTime, TZ: m.TZ,
			Busy: true, RSVPStatus: p.RSVP,
		})
	}
	_ = s.repo.ReplaceEvents(ctx, tenantID, m.ID, events)
}

func (s *Service) pushParticipants(m *meetingrepo.Meeting, typ string, payload any) {
	if s.opts.PushMeet == nil {
		return
	}
	s.opts.PushMeet(m.OrganizerID, typ, payload)
	for _, p := range m.Participants {
		if p.UserID != m.OrganizerID {
			s.opts.PushMeet(p.UserID, typ, payload)
		}
	}
}

// meetingNo 9 位会议号（随机防猜测；UK tenant 内）
func meetingNo() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	n := binary.BigEndian.Uint64(b[:])%900000000 + 100000000
	return strconv.FormatUint(n, 10), nil
}

func defaultStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// ---------------------------------------------------------------------------
// 周期系列（21 §4.2/§5）
// ---------------------------------------------------------------------------

// CreateRecurringReq 周期系列创建
type CreateRecurringReq struct {
	CreateReq              // 首场内容（StartTime/EndTime=首场时刻）
	Rule         RecurRule `json:"rule"`
	SkipHolidays bool      `json:"skip_holidays"`
}

// CreateRecurring 系列创建：规则校验（5023）→ 展开（首场恒含）→ 逐场
// 建会（各场独立会议号，21 §4.2 默认）+ recurrence 行。展开量=首场
// 起每场全员日历镜像（与单场同路径）。
func (s *Service) CreateRecurring(ctx context.Context, tenantID, organizerID int64, req CreateRecurringReq) ([]meetingrepo.Meeting, error) {
	tzName := defaultStr(req.TZ, "Asia/Shanghai")
	tz, err := time.LoadLocation(tzName)
	if err != nil {
		return nil, errx.New(errx.CodeBadRequest, "tz 非法: "+tzName)
	}
	occ, err := Expand(req.StartTime, req.EndTime, req.Rule, tz)
	if err != nil {
		return nil, err
	}
	if req.Title == "" {
		return nil, errx.New(errx.CodeBadRequest, "title 必填")
	}
	ruleJSON, _ := json.Marshal(req.Rule)
	rec, err := s.repo.CreateRecurrence(ctx, meetingrepo.Recurrence{
		TenantID: tenantID, Rule: string(ruleJSON), SkipHolidays: req.SkipHolidays,
		OrganizerID: organizerID,
	})
	if err != nil {
		return nil, err
	}
	out := make([]meetingrepo.Meeting, 0, len(occ))
	for _, o := range occ {
		m, cerr := s.Create(ctx, tenantID, organizerID, CreateReq{
			SeriesID: rec.ID, Title: req.Title, AgendaMD: req.AgendaMD,
			StartTime: o.Start, EndTime: o.End, TZ: req.TZ,
			ConvID: req.ConvID, Participants: req.Participants,
		})
		if cerr != nil {
			return nil, cerr
		}
		out = append(out, *m)
	}
	return out, nil
}

// SeriesList 系列场次清单（组织者/参与者）
func (s *Service) SeriesList(ctx context.Context, tenantID, userID, seriesID int64) ([]meetingrepo.Meeting, error) {
	rec, err := s.repo.GetRecurrence(ctx, tenantID, seriesID)
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "系列不存在")
	}
	if rec.OrganizerID != userID {
		// 参与者可见：任一场参与即可（逐场判）
		list, _ := s.repo.ListBySeries(ctx, tenantID, seriesID)
		for _, m := range list {
			if s.involved(&m, userID) {
				return list, nil
			}
		}
		return nil, errx.New(errx.CodePermACLDenied, "非系列参与者")
	}
	return s.repo.ListBySeries(ctx, tenantID, seriesID)
}

// SplitSeries this_and_after（21 §4.2 系列编辑三选一之二）：目标场及
// 之后拆分为新系列（split_from 记来源）；单场编辑（this）=既有按
// meeting_id 的 reschedule/cancel；整个系列（all）=UpdateSeriesAll。
func (s *Service) SplitSeries(ctx context.Context, tenantID, userID, meetingID int64) (int64, error) {
	m, err := s.mustOrganizer(ctx, tenantID, userID, meetingID)
	if err != nil {
		return 0, err
	}
	if m.SeriesID == 0 {
		return 0, errx.New(errx.CodeBadRequest, "非周期会场")
	}
	rec, err := s.repo.GetRecurrence(ctx, tenantID, m.SeriesID)
	if err != nil {
		return 0, errx.New(errx.CodeNotFound, "系列不存在")
	}
	newRec, err := s.repo.CreateRecurrence(ctx, meetingrepo.Recurrence{
		TenantID: tenantID, Rule: rec.Rule, SkipHolidays: rec.SkipHolidays,
		HolidayCalID: rec.HolidayCalID, SplitFrom: rec.ID, OrganizerID: userID,
	})
	if err != nil {
		return 0, err
	}
	if _, err := s.repo.SplitSeries(ctx, tenantID, m.SeriesID, newRec.ID, meetingID); err != nil {
		return 0, errx.New(errx.CodeBadRequest, "拆分失败（目标场非法）")
	}
	return newRec.ID, nil
}

// UpdateSeriesAll 系列编辑 all：标题/议程应用到未开始场次（scheduled）；
// 规则变更=取消剩余重建（阶段二登记）
func (s *Service) UpdateSeriesAll(ctx context.Context, tenantID, userID, seriesID int64, title, agenda string) error {
	rec, err := s.repo.GetRecurrence(ctx, tenantID, seriesID)
	if err != nil {
		return errx.New(errx.CodeNotFound, "系列不存在")
	}
	if rec.OrganizerID != userID {
		return errx.New(errx.CodePermACLDenied, "仅组织者可改系列")
	}
	if title == "" {
		return errx.New(errx.CodeBadRequest, "title 必填")
	}
	return s.repo.UpdateSeriesFields(ctx, tenantID, seriesID, title, agenda)
}
