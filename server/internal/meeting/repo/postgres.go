// PG 实现：满足 Repo 接口（表见 migrations/0019_meeting.sql）。
// advisory lock 9129(meeting/participant) / 9130(calendar_event)。
package meetingrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

const (
	lockKeyMeeting int64 = 9129
	lockKeyCal     int64 = 9130
)

// Postgres 会议域 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

func (p *Postgres) CreateMeeting(ctx context.Context, m Meeting, participants []Participant) (Meeting, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Meeting{}, err
	}
	defer tx.Rollback(ctx)
	if m.ID == 0 {
		if m.ID, err = bbwpg.AllocID(ctx, tx, lockKeyMeeting, "meeting"); err != nil {
			return Meeting{}, err
		}
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now()
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO meeting (id, tenant_id, series_id, meeting_no, title, agenda_md, type,
			organizer_id, host_id, status, start_time, end_time, tz, conv_id, created_by, created_at)
		VALUES ($1,$2,NULLIF($3,0),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULLIF($14,0),$15,$16)
		RETURNING created_at`,
		m.ID, m.TenantID, m.SeriesID, m.MeetingNo, m.Title, m.AgendaMD, m.Type,
		m.OrganizerID, m.HostID, m.Status, m.StartTime, m.EndTime, m.TZ, m.ConvID, m.CreatedBy, m.CreatedAt).
		Scan(&m.CreatedAt); err != nil {
		return Meeting{}, translateErr(err)
	}
	for i := range participants {
		if participants[i].ID == 0 {
			if participants[i].ID, err = bbwpg.AllocID(ctx, tx, lockKeyMeeting, "meeting_participant"); err != nil {
				return Meeting{}, err
			}
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO meeting_participant (id, tenant_id, meeting_id, user_id, role, rsvp, invite_source, invited_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			participants[i].ID, m.TenantID, m.ID, participants[i].UserID,
			participants[i].Role, participants[i].RSVP, participants[i].InviteSource,
			time.Now()); err != nil {
			return Meeting{}, translateErr(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Meeting{}, err
	}
	m.Participants = participants
	return m, nil
}

func translateErr(err error) error {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
		return ErrDupNo
	}
	return err
}

const meetingCols = `id, tenant_id, meeting_no, title, COALESCE(agenda_md,''), type,
	organizer_id, host_id, status, start_time, end_time, tz,
	COALESCE(conv_id,0), COALESCE(call_session_id,0), created_by, created_at`

func (p *Postgres) loadMeeting(ctx context.Context, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, tenantID, id int64) (*Meeting, error) {
	var m Meeting
	if err := q.QueryRow(ctx, `SELECT `+meetingCols+` FROM meeting WHERE tenant_id=$1 AND id=$2`,
		tenantID, id).Scan(&m.ID, &m.TenantID, &m.MeetingNo, &m.Title, &m.AgendaMD, &m.Type,
		&m.OrganizerID, &m.HostID, &m.Status, &m.StartTime, &m.EndTime, &m.TZ,
		&m.ConvID, &m.CallSessionID, &m.CreatedBy, &m.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &m, nil
}

func (p *Postgres) GetMeeting(ctx context.Context, tenantID, id int64) (*Meeting, error) {
	m, err := p.loadMeeting(ctx, p.pool, tenantID, id)
	if err != nil {
		return nil, err
	}
	m.Participants, _ = p.ListParticipants(ctx, tenantID, id)
	return m, nil
}

func (p *Postgres) GetByMeetingNo(ctx context.Context, tenantID int64, no string) (*Meeting, error) {
	var id int64
	if err := p.pool.QueryRow(ctx,
		`SELECT id FROM meeting WHERE tenant_id=$1 AND meeting_no=$2`, tenantID, no).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return p.GetMeeting(ctx, tenantID, id)
}

func (p *Postgres) UpdateMeetingTime(ctx context.Context, tenantID, id int64, start, end time.Time) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE meeting SET start_time=$1, end_time=$2, updated_at=now()
		WHERE tenant_id=$3 AND id=$4`, start, end, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) UpdateStatus(ctx context.Context, tenantID, id int64, status int) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE meeting SET status=$1, updated_at=now() WHERE tenant_id=$2 AND id=$3`,
		status, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) ListForUser(ctx context.Context, tenantID, userID int64, from, to time.Time, includeCanceled bool) ([]Meeting, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+meetingCols+` FROM meeting m
		WHERE m.tenant_id=$1 AND m.start_time < $3 AND m.end_time > $2
		  AND ($5 OR m.status <> $6)
		  AND (m.organizer_id = $4 OR EXISTS (
		    SELECT 1 FROM meeting_participant mp
		    WHERE mp.meeting_id = m.id AND mp.user_id = $4))
		ORDER BY m.start_time`,
		tenantID, from, to, userID, includeCanceled, StatusCanceled)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Meeting{}
	ids := []int64{}
	for rows.Next() {
		var m Meeting
		if err := rows.Scan(&m.ID, &m.TenantID, &m.MeetingNo, &m.Title, &m.AgendaMD, &m.Type,
			&m.OrganizerID, &m.HostID, &m.Status, &m.StartTime, &m.EndTime, &m.TZ,
			&m.ConvID, &m.CallSessionID, &m.CreatedBy, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
		ids = append(ids, m.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 参与者批量填充
	for i := range out {
		out[i].Participants, _ = p.ListParticipants(ctx, tenantID, ids[i])
	}
	return out, nil
}

func (p *Postgres) ListParticipants(ctx context.Context, _ int64, meetingID int64) ([]Participant, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, meeting_id, user_id, role, rsvp, invite_source,
			invited_at, COALESCE(responded_at, 'epoch')
		FROM meeting_participant WHERE meeting_id=$1 ORDER BY id`, meetingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Participant{}
	for rows.Next() {
		var pt Participant
		if err := rows.Scan(&pt.ID, &pt.TenantID, &pt.MeetingID, &pt.UserID,
			&pt.Role, &pt.RSVP, &pt.InviteSource, &pt.InvitedAt, &pt.RespondedAt); err != nil {
			return nil, err
		}
		if pt.RespondedAt.Equal(time.Unix(0, 0).UTC()) {
			pt.RespondedAt = time.Time{}
		}
		out = append(out, pt)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateRSVP(ctx context.Context, tenantID, meetingID, userID int64, rsvp int) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE meeting_participant SET rsvp=$1, responded_at=now()
		WHERE tenant_id=$2 AND meeting_id=$3 AND user_id=$4`,
		rsvp, tenantID, meetingID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) ReplaceEvents(ctx context.Context, tenantID int64, refID int64, events []CalendarEvent) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx,
		`DELETE FROM calendar_event WHERE tenant_id=$1 AND source=1 AND ref_id=$2`, tenantID, refID); err != nil {
		return err
	}
	for _, e := range events {
		if e.ID == 0 {
			if e.ID, err = bbwpg.AllocID(ctx, tx, lockKeyCal, "calendar_event"); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO calendar_event (id, tenant_id, user_id, source, ref_id, title,
				start_ts, end_ts, all_day, tz, busy, rsvp_status)
			VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
			e.ID, tenantID, e.UserID, refID, e.Title, e.StartTS, e.EndTS,
			e.AllDay, e.TZ, e.Busy, e.RSVPStatus); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *Postgres) ListEvents(ctx context.Context, tenantID int64, userID int64, from, to time.Time) ([]CalendarEvent, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, user_id, source, ref_id, title, start_ts, end_ts,
			all_day, tz, busy, rsvp_status
		FROM calendar_event
		WHERE tenant_id=$1 AND user_id=$2 AND start_ts < $4 AND end_ts > $3
		ORDER BY start_ts`, tenantID, userID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CalendarEvent{}
	for rows.Next() {
		var e CalendarEvent
		if err := rows.Scan(&e.ID, &e.TenantID, &e.UserID, &e.Source, &e.RefID, &e.Title,
			&e.StartTS, &e.EndTS, &e.AllDay, &e.TZ, &e.Busy, &e.RSVPStatus); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (p *Postgres) BusyOf(ctx context.Context, tenantID int64, userIDs []int64, from, to time.Time) ([]BusyBlock, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT user_id, start_ts, end_ts, title FROM calendar_event
		WHERE tenant_id=$1 AND user_id = ANY($2) AND busy AND start_ts < $4 AND end_ts > $3
		ORDER BY start_ts`, tenantID, userIDs, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BusyBlock{}
	for rows.Next() {
		var b BusyBlock
		if err := rows.Scan(&b.UserID, &b.Start, &b.End, &b.Title); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ── 周期系列 ──

func (p *Postgres) CreateRecurrence(ctx context.Context, r Recurrence) (Recurrence, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Recurrence{}, err
	}
	defer tx.Rollback(ctx)
	if r.ID == 0 {
		if r.ID, err = bbwpg.AllocID(ctx, tx, lockKeyMeeting, "meeting_recurrence"); err != nil {
			return Recurrence{}, err
		}
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO meeting_recurrence (id, tenant_id, rule, skip_holidays,
			holiday_cal_id, split_from, organizer_id)
		VALUES ($1,$2,$3,$4,NULLIF($5,0),NULLIF($6,0),$7) RETURNING created_at`,
		r.ID, r.TenantID, r.Rule, r.SkipHolidays, r.HolidayCalID, r.SplitFrom, r.OrganizerID).
		Scan(&r.CreatedAt); err != nil {
		return Recurrence{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Recurrence{}, err
	}
	return r, nil
}

func (p *Postgres) GetRecurrence(ctx context.Context, tenantID, id int64) (*Recurrence, error) {
	var r Recurrence
	if err := p.pool.QueryRow(ctx, `
		SELECT id, tenant_id, rule, skip_holidays,
			COALESCE(holiday_cal_id,0), COALESCE(split_from,0), organizer_id, created_at
		FROM meeting_recurrence WHERE tenant_id=$1 AND id=$2`, tenantID, id).
		Scan(&r.ID, &r.TenantID, &r.Rule, &r.SkipHolidays,
			&r.HolidayCalID, &r.SplitFrom, &r.OrganizerID, &r.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &r, nil
}

func (p *Postgres) ListBySeries(ctx context.Context, tenantID, seriesID int64) ([]Meeting, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+meetingCols+` FROM meeting
		WHERE tenant_id=$1 AND series_id=$2 ORDER BY start_time`, tenantID, seriesID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Meeting{}
	for rows.Next() {
		var m Meeting
		if err := rows.Scan(&m.ID, &m.TenantID, &m.MeetingNo, &m.Title, &m.AgendaMD, &m.Type,
			&m.OrganizerID, &m.HostID, &m.Status, &m.StartTime, &m.EndTime, &m.TZ,
			&m.ConvID, &m.CallSessionID, &m.CreatedBy, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.SeriesID = seriesID
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Participants, _ = p.ListParticipants(ctx, tenantID, out[i].ID)
	}
	return out, nil
}

func (p *Postgres) UpdateSeriesFields(ctx context.Context, tenantID, seriesID int64, title, agenda string) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE meeting SET title=$1, agenda_md=$2, updated_at=now()
		WHERE tenant_id=$3 AND series_id=$4 AND status=1`, title, agenda, tenantID, seriesID)
	return err
}

func (p *Postgres) SplitSeries(ctx context.Context, tenantID, seriesID, newSeriesID, fromMeetingID int64) (int, error) {
	tag, err := p.pool.Exec(ctx, `
		UPDATE meeting SET series_id=$1, updated_at=now()
		WHERE tenant_id=$2 AND series_id=$3 AND id IN (
			SELECT id FROM meeting WHERE tenant_id=$2 AND series_id=$3 AND id=$4
			UNION
			SELECT id FROM meeting WHERE tenant_id=$2 AND series_id=$3
			  AND start_time >= (SELECT start_time FROM meeting WHERE id=$4)
		)`, newSeriesID, tenantID, seriesID, fromMeetingID)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, ErrNotFound
	}
	return int(tag.RowsAffected()), nil
}
