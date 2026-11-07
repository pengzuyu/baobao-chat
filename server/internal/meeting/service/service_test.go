// 会议域阶段一全链测试（21 篇）：预约/即时 → 日历镜像 → RSVP → 忙闲 →
// 改期/取消 → 入会状态机；推送断言。
package meetingservice

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	meetingrepo "github.com/baobaowork/server/internal/meeting/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

const (
	organizer = int64(10001)
	member1   = int64(10002)
	member2   = int64(10003)
)

type pushLog struct {
	mu sync.Mutex
	v  []struct {
		uid int64
		typ string
	}
}

func (p *pushLog) push(uid int64, typ string, _ any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.v = append(p.v, struct {
		uid int64
		typ string
	}{uid, typ})
}

func (p *pushLog) count(typ string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, e := range p.v {
		if e.typ == typ {
			n++
		}
	}
	return n
}

func newSvc() (*Service, *pushLog) {
	push := &pushLog{}
	return New(meetingrepo.NewMemory(), Options{PushMeet: push.push}), push
}

func codeOf(t *testing.T, err error) int {
	t.Helper()
	if err == nil {
		t.Fatal("期望错误但为 nil")
	}
	return int(errx.From(err).Code)
}

var base = time.UnixMilli(1760000000000) // 2025-10-09 固定基准

// 预约全链：创建（时长校验）→ 参与者行 → 日历镜像全员 → invited 推送
func TestScheduledCreateFlow(t *testing.T) {
	svc, push := newSvc()
	ctx := context.Background()
	m, err := svc.Create(ctx, 1, organizer, CreateReq{
		Title: "架构评审", AgendaMD: "议程",
		StartTime: base, EndTime: base.Add(time.Hour),
		Participants: []int64{member1, member2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.MeetingNo) != 9 {
		t.Fatalf("会议号 9 位：%s", m.MeetingNo)
	}
	if m.Type != meetingrepo.TypeScheduled || m.Status != meetingrepo.StatusScheduled {
		t.Fatalf("状态：%+v", m)
	}
	// 组织者+2 参与者；组织者 accepted
	if len(m.Participants) != 3 {
		t.Fatalf("参与者行：%+v", m.Participants)
	}
	// 日历镜像：3 人各一行
	ev, _ := svc.CalendarEvents(ctx, 1, member1, base.Add(-time.Minute), base.Add(2*time.Hour))
	if len(ev) != 1 || ev[0].Title != "架构评审" || ev[0].RSVPStatus != meetingrepo.RSVPPending {
		t.Fatalf("参与者日历镜像：%+v", ev)
	}
	org, _ := svc.CalendarEvents(ctx, 1, organizer, base.Add(-time.Minute), base.Add(2*time.Hour))
	if len(org) != 1 || org[0].RSVPStatus != meetingrepo.RSVPAccepted {
		t.Fatalf("组织者镜像：%+v", org)
	}
	// 推送：3 人 invited
	if push.count("meeting.invited") != 3 {
		t.Fatalf("invited 推送：%d", push.count("meeting.invited"))
	}
	// 时长非法
	if codeOf(t, mustErr(func() error {
		_, e := svc.Create(ctx, 1, organizer, CreateReq{
			Title: "x", StartTime: base, EndTime: base.Add(5 * time.Minute)})
		return e
	})) != 9001 {
		t.Fatal("时长 <15min 应 9001")
	}
}

// 即时会：start=now、30min、type=instant
func TestInstantMeeting(t *testing.T) {
	svc, _ := newSvc()
	ctx := context.Background()
	m, err := svc.Create(ctx, 1, organizer, CreateReq{Title: "快速同步", Instant: true, Participants: []int64{member1}})
	if err != nil {
		t.Fatal(err)
	}
	if m.Type != meetingrepo.TypeInstant {
		t.Fatal("应为即时会")
	}
	if d := m.EndTime.Sub(m.StartTime); d != 30*time.Minute {
		t.Fatalf("即时会默认 30min：%v", d)
	}
}

// RSVP：参与者回执 → 日历镜像同步 → 组织者收推送；未邀请 404 语义
func TestRSVPFlow(t *testing.T) {
	svc, push := newSvc()
	ctx := context.Background()
	m, _ := svc.Create(ctx, 1, organizer, CreateReq{
		Title: "周会", StartTime: base, EndTime: base.Add(time.Hour),
		Participants: []int64{member1},
	})
	if err := svc.RSVP(ctx, 1, member1, m.ID, meetingrepo.RSVPAccepted); err != nil {
		t.Fatal(err)
	}
	ev, _ := svc.CalendarEvents(ctx, 1, member1, base.Add(-time.Minute), base.Add(2*time.Hour))
	if len(ev) != 1 || ev[0].RSVPStatus != meetingrepo.RSVPAccepted {
		t.Fatalf("回执镜像：%+v", ev)
	}
	if push.count("meeting.rsvp") != 1 {
		t.Fatal("组织者应收 rsvp 推送")
	}
	// 未被邀请者
	if err := svc.RSVP(ctx, 1, member2, m.ID, meetingrepo.RSVPAccepted); err == nil {
		t.Fatal("未邀请者应拒")
	}
	// 组织者无需回执
	if err := svc.RSVP(ctx, 1, organizer, m.ID, meetingrepo.RSVPAccepted); err == nil {
		t.Fatal("组织者应拒")
	}
}

// 忙闲聚合：多用户时间窗重叠块
func TestFreeBusy(t *testing.T) {
	svc, _ := newSvc()
	ctx := context.Background()
	_, _ = svc.Create(ctx, 1, organizer, CreateReq{
		Title: "会 A", StartTime: base, EndTime: base.Add(time.Hour), Participants: []int64{member1}})
	_, _ = svc.Create(ctx, 1, member2, CreateReq{
		Title: "会 B", StartTime: base.Add(30 * time.Minute), EndTime: base.Add(90 * time.Minute)})
	blocks, err := svc.FreeBusy(ctx, 1, []int64{organizer, member1, member2},
		base.Add(-time.Hour), base.Add(3*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("忙闲块（A 组织者+参与者、B 组织者）：%d", len(blocks))
	}
	// 空窗
	empty, _ := svc.FreeBusy(ctx, 1, []int64{organizer}, base.Add(10*time.Hour), base.Add(11*time.Hour))
	if len(empty) != 0 {
		t.Fatalf("空窗应无块：%d", len(empty))
	}
}

// 改期：日历同步更新 + 推送；取消：日历撤下 + canceled
func TestRescheduleAndCancel(t *testing.T) {
	svc, push := newSvc()
	ctx := context.Background()
	m, _ := svc.Create(ctx, 1, organizer, CreateReq{
		Title: "改期测试", StartTime: base, EndTime: base.Add(time.Hour),
		Participants: []int64{member1}})
	newStart := base.Add(24 * time.Hour)
	if err := svc.Reschedule(ctx, 1, organizer, m.ID, newStart, newStart.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	// 旧窗口无事件、新窗口有
	old, _ := svc.CalendarEvents(ctx, 1, member1, base.Add(-time.Minute), base.Add(2*time.Hour))
	if len(old) != 0 {
		t.Fatalf("旧窗口应清：%d", len(old))
	}
	cur, _ := svc.CalendarEvents(ctx, 1, member1, newStart.Add(-time.Minute), newStart.Add(2*time.Hour))
	if len(cur) != 1 {
		t.Fatalf("新窗口应有镜像：%d", len(cur))
	}
	if push.count("meeting.updated") != 2 {
		t.Fatal("改期推送全员")
	}
	// 非组织者改期拒
	if err := svc.Reschedule(ctx, 1, member1, m.ID, newStart, newStart.Add(time.Hour)); err == nil {
		t.Fatal("非组织者应拒")
	}
	// 取消：日历撤下 + 推送
	if err := svc.Cancel(ctx, 1, organizer, m.ID); err != nil {
		t.Fatal(err)
	}
	after, _ := svc.CalendarEvents(ctx, 1, member1, newStart.Add(-time.Minute), newStart.Add(2*time.Hour))
	if len(after) != 0 {
		t.Fatal("取消后日历应撤下")
	}
	if push.count("meeting.canceled") != 2 {
		t.Fatal("取消推送全员")
	}
	// 列表默认排除已取消
	list, _ := svc.ListMy(ctx, 1, member1, base.Add(-time.Hour), base.Add(48*time.Hour), false)
	if len(list) != 0 {
		t.Fatal("默认列表应排除取消")
	}
}

// 入会状态机：start（预约→live 返回会议号）→ end（live→ended）
func TestLiveLifecycle(t *testing.T) {
	svc, _ := newSvc()
	ctx := context.Background()
	m, _ := svc.Create(ctx, 1, organizer, CreateReq{
		Title: "入会测试", StartTime: base, EndTime: base.Add(time.Hour), Participants: []int64{member1}})
	no, err := svc.StartLive(ctx, 1, organizer, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if no != m.MeetingNo {
		t.Fatalf("应返回会议号：%s vs %s", no, m.MeetingNo)
	}
	// 重复 start 拒
	if _, err := svc.StartLive(ctx, 1, organizer, m.ID); err == nil {
		t.Fatal("重复 start 应拒")
	}
	if err := svc.EndLive(ctx, 1, organizer, m.ID); err != nil {
		t.Fatal(err)
	}
	// ended 后取消应拒
	if err := svc.Cancel(ctx, 1, organizer, m.ID); err == nil {
		t.Fatal("ended 后取消应拒")
	}
}

// 可见性：非参与者不可见详情
func TestVisibility(t *testing.T) {
	svc, _ := newSvc()
	ctx := context.Background()
	m, _ := svc.Create(ctx, 1, organizer, CreateReq{
		Title: "私密会", StartTime: base, EndTime: base.Add(time.Hour), Participants: []int64{member1}})
	if _, err := svc.Get(ctx, 1, 99999, m.ID); err == nil || !strings.Contains(err.Error(), "参与者") {
		t.Fatalf("外人应拒：%v", err)
	}
	if _, err := svc.Get(ctx, 1, member1, m.ID); err != nil {
		t.Fatal("参与者可见")
	}
}

func mustErr(f func() error) error { return f() }
