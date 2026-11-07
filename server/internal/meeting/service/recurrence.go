// 周期会展开（21 §4.2 RRULE 简化子集）：纯函数 + 校验。
//
// 四频率：daily / weekly(by_weekday 选周几) / biweekly / monthly(by_day 按
// 日 | nth_weekday 第 N 个周 X)。实现口径：**统一逐日扫 + 规则命中过滤**
// （52 场上限 ⇒ 扫描窗 ≤ 366+366 天，复杂度无关紧要——月末/月末第 N 个
// 周边界的正确性远比步进优化重要）。结束 count≤52 或 until 先到；非法
// 子集 → 5023。节假日跳过：skip_holidays 落库但数据源随阶段二（无数据
// =不跳），登记。
package meetingservice

import (
	"time"

	errx "github.com/baobaowork/server/internal/platform/errors"
)

// RecurRule 周期规则（rule jsonb 同构）
type RecurRule struct {
	Freq      string `json:"freq"`                 // daily|weekly|biweekly|monthly
	ByWeekday []int  `json:"by_weekday,omitempty"` // 1..7（周一..周日）
	MonthMode string `json:"month_mode,omitempty"` // by_day|nth_weekday（monthly）
	MonthDay  int    `json:"month_day,omitempty"`  // by_day：每月几号（1..31）
	Nth       int    `json:"nth,omitempty"`        // nth_weekday：第 N 个（1..5）
	Count     int    `json:"count,omitempty"`      // 场次上限（含首场，≤52）
	UntilMS   int64  `json:"until_ms,omitempty"`   // 截止时刻 ms（与 count 先到）
}

const (
	FreqDaily    = "daily"
	FreqWeekly   = "weekly"
	FreqBiweekly = "biweekly"
	FreqMonthly  = "monthly"

	MonthByDay      = "by_day"
	MonthNthWeekday = "nth_weekday"
)

// MaxOccurrences 场次硬顶（21 §4.2 默认 ≤52）
const MaxOccurrences = 52

// weekdayOf 周几（1..7，周日=7）
func weekdayOf(t time.Time) int {
	if wd := int(t.Weekday()); wd != 0 {
		return wd
	}
	return 7
}

// nthWeekdayOf 月内第几个周 X（1..5）
func nthWeekdayOf(t time.Time) int { return (t.Day()-1)/7 + 1 }

// Validate 规则校验（非法子集 → 5023）
func (r RecurRule) Validate() error {
	switch r.Freq {
	case FreqDaily, FreqMonthly:
	case FreqWeekly, FreqBiweekly:
		if len(r.ByWeekday) == 0 {
			return errx.New(errx.CodeMeetingRecurrenceInvalid, "weekly/biweekly 须 by_weekday（1..7）")
		}
		for _, d := range r.ByWeekday {
			if d < 1 || d > 7 {
				return errx.New(errx.CodeMeetingRecurrenceInvalid, "by_weekday ∈ 1..7")
			}
		}
	default:
		return errx.New(errx.CodeMeetingRecurrenceInvalid, "freq ∈ daily|weekly|biweekly|monthly")
	}
	if r.Freq == FreqMonthly {
		switch r.MonthMode {
		case MonthByDay:
			if r.MonthDay < 1 || r.MonthDay > 31 {
				return errx.New(errx.CodeMeetingRecurrenceInvalid, "month_day ∈ 1..31")
			}
		case MonthNthWeekday:
			if r.Nth < 1 || r.Nth > 5 || len(r.ByWeekday) != 1 {
				return errx.New(errx.CodeMeetingRecurrenceInvalid, "nth_weekday 须 nth(1..5)+单 by_weekday")
			}
		default:
			return errx.New(errx.CodeMeetingRecurrenceInvalid, "month_mode ∈ by_day|nth_weekday")
		}
	}
	if r.Count > MaxOccurrences {
		return errx.New(errx.CodeMeetingRecurrenceInvalid, "count ≤52")
	}
	if r.Count == 0 && r.UntilMS == 0 {
		return errx.New(errx.CodeMeetingRecurrenceInvalid, "count 与 until 至少其一（无限循环拒）")
	}
	return nil
}

// Occurrence 单场时刻
type Occurrence struct {
	Start time.Time
	End   time.Time
}

// Expand 展开：首场恒含（不做 weekday 修正——首场即系列锚，21 §4.2
// 展开语义）；其后逐日扫按规则命中。biweekly=与首场同相位周（首场日起
// 每 14 天窗口内的命中 weekday）。count 含首场。
func Expand(firstStart, firstEnd time.Time, rule RecurRule, tz *time.Location) ([]Occurrence, error) {
	if err := rule.Validate(); err != nil {
		return nil, err
	}
	if tz == nil {
		tz = time.UTC
	}
	dur := firstEnd.Sub(firstStart)
	var until time.Time
	if rule.UntilMS > 0 {
		until = time.UnixMilli(rule.UntilMS)
	}
	out := []Occurrence{{Start: firstStart, End: firstEnd}} // 首场恒含
	cur := firstStart
	// 逐日扫：52 场 × 最疏 monthly=366 天 ⇒ 窗 800 天封顶防御
	for day := 0; day < 800 && len(out) < MaxOccurrences; day++ {
		cur = cur.AddDate(0, 0, 1)
		if !until.IsZero() && cur.After(until) {
			break
		}
		if rule.Count > 0 && len(out) >= rule.Count {
			break
		}
		hit := false
		local := cur.In(tz)
		wd := weekdayOf(local)
		switch rule.Freq {
		case FreqDaily:
			hit = true
		case FreqWeekly:
			for _, d := range rule.ByWeekday {
				if d == wd {
					hit = true
				}
			}
		case FreqBiweekly:
			// 同相位周：首场日起的天数差为 14 的倍数窗口内命中 weekday
			since := int(cur.Sub(firstStart).Hours() / 24)
			if since%14 < 7 { // 每两周的 7 天窗口（首场周与其后每二周）
				for _, d := range rule.ByWeekday {
					if d == wd {
						hit = true
					}
				}
			}
		case FreqMonthly:
			if rule.MonthMode == MonthByDay {
				hit = local.Day() == rule.MonthDay
			} else {
				hit = wd == rule.ByWeekday[0] && nthWeekdayOf(local) == rule.Nth
			}
		}
		if hit {
			out = append(out, Occurrence{Start: cur, End: cur.Add(dur)})
		}
	}
	if len(out) == 0 {
		return nil, errx.New(errx.CodeMeetingRecurrenceInvalid, "展开为空")
	}
	return out, nil
}
