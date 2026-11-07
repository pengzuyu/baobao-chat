// 周期展开与系列编排测试（21 §4.2）。
package meetingservice

import (
	"context"
	"testing"
	"time"
)

var shTZ = mustTZ()

func mustTZ() *time.Location {
	tz, _ := time.LoadLocation("Asia/Shanghai")
	return tz
}

// 四频率展开（首场恒含；count 含首场）
func TestExpandFourFreqs(t *testing.T) {
	base := time.Date(2026, 11, 2, 10, 0, 0, 0, shTZ) // 周一
	// daily ×3
	occ, err := Expand(base, base.Add(time.Hour), RecurRule{Freq: FreqDaily, Count: 3}, shTZ)
	if err != nil || len(occ) != 3 || !occ[2].Start.Equal(base.AddDate(0, 0, 2)) {
		t.Fatalf("daily：%v %v", err, occ)
	}
	// weekly 周一三五 ×4（首场周一 + 周三 + 周五 + 次周一）
	occ, err = Expand(base, base.Add(time.Hour), RecurRule{
		Freq: FreqWeekly, ByWeekday: []int{1, 3, 5}, Count: 4}, shTZ)
	if err != nil || len(occ) != 4 {
		t.Fatalf("weekly：%v %d", err, len(occ))
	}
	want := []time.Time{base, base.AddDate(0, 0, 2), base.AddDate(0, 0, 4), base.AddDate(0, 0, 7)}
	for i, w := range want {
		if !occ[i].Start.Equal(w) {
			t.Fatalf("weekly #%d：%v want %v", i, occ[i].Start, w)
		}
	}
	// biweekly 周一 ×3（每 14 天）
	occ, err = Expand(base, base.Add(time.Hour), RecurRule{
		Freq: FreqBiweekly, ByWeekday: []int{1}, Count: 3}, shTZ)
	if err != nil || len(occ) != 3 || !occ[2].Start.Equal(base.AddDate(0, 0, 28)) {
		t.Fatalf("biweekly：%v", occ)
	}
	// monthly by_day 每月 15 号 count=3（含首场：首场 11-02 恒含 + 11-15 + 12-15）
	occ, err = Expand(base, base.Add(time.Hour), RecurRule{
		Freq: FreqMonthly, MonthMode: MonthByDay, MonthDay: 15, Count: 3}, shTZ)
	if err != nil || len(occ) != 3 {
		t.Fatalf("monthly by_day：%d", len(occ))
	}
	if occ[1].Start.Day() != 15 || occ[1].Start.Month() != time.November {
		t.Fatalf("monthly #1：%v", occ[1].Start)
	}
	if occ[2].Start.Day() != 15 || occ[2].Start.Month() != time.December {
		t.Fatalf("monthly #2：%v", occ[2].Start)
	}
	// monthly nth_weekday 每月第 2 个周三 ×2（首场恒含 + 11-11 本月第 2 个周三）
	occ, err = Expand(base, base.Add(time.Hour), RecurRule{
		Freq: FreqMonthly, MonthMode: MonthNthWeekday, Nth: 2, ByWeekday: []int{3}, Count: 2}, shTZ)
	if err != nil {
		t.Fatal(err)
	}
	second := occ[1].Start.In(shTZ)
	if int(second.Weekday()) != 3 || nthWeekdayOf(second) != 2 || second.Day() != 11 || second.Month() != time.November {
		t.Fatalf("nth_weekday #1：%v", second)
	}
}

// 非法子集 → 5023；until 先到
func TestExpandValidationAndUntil(t *testing.T) {
	base := time.Date(2026, 11, 2, 10, 0, 0, 0, shTZ)
	bad := []RecurRule{
		{Freq: "hourly", Count: 3},
		{Freq: FreqWeekly, Count: 3}, // 无 by_weekday
		{Freq: FreqWeekly, ByWeekday: []int{8}, Count: 3},
		{Freq: FreqMonthly, MonthMode: MonthByDay, MonthDay: 32, Count: 3},
		{Freq: FreqMonthly, MonthMode: MonthNthWeekday, Nth: 6, ByWeekday: []int{3}, Count: 3},
		{Freq: FreqDaily, Count: 53}, // >52
		{Freq: FreqDaily},            // 无限
	}
	for i, r := range bad {
		if _, err := Expand(base, base.Add(time.Hour), r, shTZ); err == nil {
			t.Fatalf("非法 #%d 应 5023", i)
		}
	}
	// until 先到：daily 但 2 天后截止 → 首场+2
	occ, err := Expand(base, base.Add(time.Hour), RecurRule{
		Freq: FreqDaily, UntilMS: base.AddDate(0, 0, 2).Add(time.Hour).UnixMilli()}, shTZ)
	if err != nil || len(occ) != 3 {
		t.Fatalf("until：%v %d", err, len(occ))
	}
}

// 系列全链：创建展开（每场独立会议号+同 series）→ all 改标题 →
// this_and_after 拆分 → 单场改期（this=既有 API）
func TestRecurringSeriesLifecycle(t *testing.T) {
	svc, _ := newSvc()
	ctx := context.Background()
	base := time.Date(2026, 11, 2, 10, 0, 0, 0, shTZ)
	list, err := svc.CreateRecurring(ctx, 1, organizer, CreateRecurringReq{
		CreateReq: CreateReq{
			Title: "部门周会", StartTime: base, EndTime: base.Add(time.Hour),
			TZ: "Asia/Shanghai", Participants: []int64{member1},
		},
		Rule: RecurRule{Freq: FreqWeekly, ByWeekday: []int{1}, Count: 4},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 4 {
		t.Fatalf("展开 4 场：%d", len(list))
	}
	sid := list[0].SeriesID
	if sid == 0 || list[3].SeriesID != sid {
		t.Fatal("全场同系列")
	}
	if list[0].MeetingNo == list[1].MeetingNo {
		t.Fatal("各场独立会议号")
	}
	// 系列清单（参与者可见）
	sl, err := svc.SeriesList(ctx, 1, member1, sid)
	if err != nil || len(sl) != 4 {
		t.Fatalf("系列清单：%v %d", err, len(sl))
	}
	// all：改标题应用未开始场次
	if err := svc.UpdateSeriesAll(ctx, 1, organizer, sid, "部门周会 v2", "新议程"); err != nil {
		t.Fatal(err)
	}
	sl, _ = svc.SeriesList(ctx, 1, organizer, sid)
	if sl[0].Title != "部门周会 v2" || sl[0].AgendaMD != "新议程" {
		t.Fatalf("all 应用：%+v", sl[0])
	}
	// 单场改期（this：既有 API 不动系列归属）
	if err := svc.Reschedule(ctx, 1, organizer, sl[1].ID,
		sl[1].StartTime.Add(2*time.Hour), sl[1].EndTime.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	// this_and_after：第 3 场起拆新系列
	newSID, err := svc.SplitSeries(ctx, 1, organizer, sl[2].ID)
	if err != nil {
		t.Fatal(err)
	}
	if newSID == sid {
		t.Fatal("应拆出新系列")
	}
	old, _ := svc.SeriesList(ctx, 1, organizer, sid)
	fresh, _ := svc.SeriesList(ctx, 1, organizer, newSID)
	if len(old) != 2 || len(fresh) != 2 {
		t.Fatalf("拆分后旧 %d 新 %d", len(old), len(fresh))
	}
	if fresh[0].ID != sl[2].ID {
		t.Fatalf("新系列首场=拆分点：%d vs %d", fresh[0].ID, sl[2].ID)
	}
	// 非组织者拆分拒
	if _, err := svc.SplitSeries(ctx, 1, member1, fresh[0].ID); err == nil {
		t.Fatal("非组织者应拒")
	}
}
