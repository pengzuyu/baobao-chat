//go:build pg

// meeting 域 PG 仓储冒烟（build tag `pg`；mail/acl 同款模式）。
//
//	BBW_PG_TEST_DSN='postgres://bbw:...@127.0.0.1:5432/bbw?sslmode=disable' \
//	  go test -tags pg ./internal/meeting/repo/ -run TestPGMeetingSmoke -v
package meetingrepo

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

func TestPGMeetingSmoke(t *testing.T) {
	dsn := os.Getenv("BBW_PG_TEST_DSN")
	if dsn == "" {
		t.Skip("BBW_PG_TEST_DSN 未设置，跳过 PG 集成测试")
	}
	ctx := context.Background()
	pool, err := bbwpg.New(ctx, dsn)
	if err != nil {
		t.Fatalf("建池: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := bbwpg.Migrate(ctx, pool); err != nil {
		t.Fatalf("迁移（应含 0019 meeting 表）: %v", err)
	}
	sfx := strconv.FormatInt(time.Now().UnixNano()%1000000, 10)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM calendar_event WHERE title LIKE 'pgsmoke-%'`)
		_, _ = pool.Exec(ctx, `DELETE FROM meeting_participant WHERE meeting_id IN
			(SELECT id FROM meeting WHERE title LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM meeting WHERE title LIKE 'pgsmoke-%'`)
	})

	r := NewPostgres(pool)
	now := time.Now()
	no := "9" + sfx + "123"
	if len(no) > 9 {
		no = no[:9]
	}
	m, err := r.CreateMeeting(ctx, Meeting{
		TenantID: 1, MeetingNo: no, Title: "pgsmoke-评审-" + sfx, Type: TypeScheduled,
		OrganizerID: 71001, HostID: 71001, Status: StatusScheduled,
		StartTime: now.Add(time.Hour), EndTime: now.Add(2 * time.Hour),
	}, []Participant{
		{UserID: 71001, Role: 1, RSVP: RSVPAccepted, InviteSource: 1},
		{UserID: 71002, Role: 3, RSVP: RSVPPending, InviteSource: 1},
	})
	if err != nil || m.ID == 0 {
		t.Fatalf("CreateMeeting: %v %+v", err, m)
	}
	// 会议号 UK
	if _, err := r.CreateMeeting(ctx, Meeting{
		TenantID: 1, MeetingNo: no, Title: "dup", Type: TypeInstant,
		OrganizerID: 71001, HostID: 71001, Status: StatusScheduled,
		StartTime: now, EndTime: now.Add(30 * time.Minute),
	}, nil); err != ErrDupNo {
		t.Fatalf("UK 应 ErrDupNo: %v", err)
	}
	// 按号查 + 参与者联查
	got, err := r.GetByMeetingNo(ctx, 1, no)
	if err != nil || len(got.Participants) != 2 {
		t.Fatalf("按号查: %v %+v", err, got)
	}
	// RSVP + 日历镜像 + 忙闲
	if err := r.UpdateRSVP(ctx, 1, m.ID, 71002, RSVPAccepted); err != nil {
		t.Fatal(err)
	}
	if err := r.ReplaceEvents(ctx, 1, m.ID, []CalendarEvent{
		{TenantID: 1, UserID: 71001, Source: 1, RefID: m.ID, Title: "pgsmoke-评审-" + sfx,
			StartTS: now.Add(time.Hour), EndTS: now.Add(2 * time.Hour), Busy: true, RSVPStatus: RSVPAccepted},
		{TenantID: 1, UserID: 71002, Source: 1, RefID: m.ID, Title: "pgsmoke-评审-" + sfx,
			StartTS: now.Add(time.Hour), EndTS: now.Add(2 * time.Hour), Busy: true, RSVPStatus: RSVPAccepted},
	}); err != nil {
		t.Fatal(err)
	}
	blocks, err := r.BusyOf(ctx, 1, []int64{71001, 71002}, now, now.Add(3*time.Hour))
	if err != nil || len(blocks) != 2 {
		t.Fatalf("忙闲: %v %d", err, len(blocks))
	}
	// 改期 + 状态
	if err := r.UpdateMeetingTime(ctx, 1, m.ID, now.Add(3*time.Hour), now.Add(4*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateStatus(ctx, 1, m.ID, StatusLive); err != nil {
		t.Fatal(err)
	}
	got2, _ := r.GetMeeting(ctx, 1, m.ID)
	if got2.Status != StatusLive || !got2.StartTime.Equal(now.Add(3*time.Hour)) {
		t.Fatalf("改期/状态: %+v", got2)
	}
	// 用户列表（组织者窗口命中）
	list, err := r.ListForUser(ctx, 1, 71002, now.Add(2*time.Hour), now.Add(5*time.Hour), false)
	if err != nil || len(list) != 1 {
		t.Fatalf("列表: %v %d", err, len(list))
	}
	// 日历替换幂等（重放不翻倍）
	if err := r.ReplaceEvents(ctx, 1, m.ID, []CalendarEvent{
		{TenantID: 1, UserID: 71001, Source: 1, RefID: m.ID, Title: "pgsmoke-评审-" + sfx,
			StartTS: now.Add(3 * time.Hour), EndTS: now.Add(4 * time.Hour), Busy: true},
	}); err != nil {
		t.Fatal(err)
	}
	ev, _ := r.ListEvents(ctx, 1, 71001, now, now.Add(6*time.Hour))
	if len(ev) != 1 {
		t.Fatalf("ReplaceEvents 应先删后插（不翻倍）：%d", len(ev))
	}
}
