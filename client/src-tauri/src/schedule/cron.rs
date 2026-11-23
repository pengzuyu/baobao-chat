//! 5 字段 cron 解析（D35）：分 时 日 月 周（0/7=周日）。
//! 支持 `*`、`n`、`a-b`、`*/n`、`a-b/n`、逗号列表；日与周同时受限时取 OR（cron 惯例）。
//! 只做“下一次触发时刻”计算，不做常驻调度（调度循环在 mod.rs）。

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Timelike};

/// 解析后的 cron 表达式
#[derive(Clone, Debug, PartialEq)]
pub struct CronExpr {
    minutes: [bool; 60],
    hours: [bool; 24],
    days: [bool; 32],   // 1..31
    months: [bool; 13], // 1..12
    dows: [bool; 7],    // 0=周日
    dom_star: bool,
    dow_star: bool,
}

impl CronExpr {
    /// 该日期是否命中（日/月/周）
    fn date_matches(&self, date: NaiveDate) -> bool {
        if !self.months[date.month() as usize] {
            return false;
        }
        let dom_ok = self.dom_star || self.days[date.day() as usize];
        let dow_ok = self.dow_star || self.dows[date.weekday().num_days_from_sunday() as usize];
        if !self.dom_star && !self.dow_star {
            dom_ok || dow_ok // 双受限：OR
        } else {
            dom_ok && dow_ok
        }
    }

    /// 严格晚于 `from` 的下一个触发时刻（分钟粒度）；最多向前搜 5 年
    pub fn next_after(&self, from: NaiveDateTime) -> Option<NaiveDateTime> {
        // 起点=下一分钟整
        let mut start = from.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1);
        let mut date = start.date();
        for _ in 0..(366 * 5) {
            if self.date_matches(date) {
                let from_h = if date == start.date() {
                    start.hour()
                } else {
                    0
                };
                for h in from_h..24 {
                    if !self.hours[h as usize] {
                        continue;
                    }
                    let from_m = if date == start.date() && h == start.hour() {
                        start.minute()
                    } else {
                        0
                    };
                    for m in from_m..60 {
                        if !self.minutes[m as usize] {
                            continue;
                        }
                        let dt = date.and_hms_opt(h, m, 0)?;
                        if dt > from {
                            return Some(dt);
                        }
                    }
                }
            }
            date = date.succ_opt()?;
            start = NaiveDate::from_ymd_opt(date.year(), date.month(), date.day())?
                .and_hms_opt(0, 0, 0)?;
        }
        None
    }
}

/// 解析表达式（错误文案直接给前端）
pub fn parse(expr: &str) -> Result<CronExpr, String> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return Err("cron 需 5 段：分 时 日 月 周".into());
    }
    let minutes = parse_field(parts[0], 0, 59, false)?.0;
    let hours = parse_field(parts[1], 0, 23, false)?.0;
    let (days_v, days_star) = parse_field(parts[2], 1, 31, false)?;
    let months_v = parse_field(parts[3], 1, 12, false)?.0;
    let (dows_v, dows_star) = parse_field(parts[4], 0, 7, true)?;

    let mut minutes_set = [false; 60];
    for v in minutes {
        minutes_set[v as usize] = true;
    }
    let mut hours_set = [false; 24];
    for v in hours {
        hours_set[v as usize] = true;
    }
    let mut days_set = [false; 32];
    for v in days_v {
        days_set[v as usize] = true;
    }
    let mut months_set = [false; 13];
    for v in months_v {
        months_set[v as usize] = true;
    }
    let mut dows_set = [false; 7];
    for v in dows_v {
        dows_set[(v % 7) as usize] = true; // 7→0
    }
    Ok(CronExpr {
        minutes: minutes_set,
        hours: hours_set,
        days: days_set,
        months: months_set,
        dows: dows_set,
        dom_star: days_star,
        dow_star: dows_star,
    })
}

/// 单段解析 → (值列表, 是否 `*` 不受限)
fn parse_field(spec: &str, min: u32, max: u32, sunday7: bool) -> Result<(Vec<u32>, bool), String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("cron 字段为空".into());
    }
    let star = spec == "*";
    let mut out = Vec::new();
    for item in spec.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err("cron 字段含空项".into());
        }
        let (range, step) = match item.split_once('/') {
            Some((r, s)) => {
                let step: u32 = s.parse().map_err(|_| format!("步长非法：{s}"))?;
                if step == 0 {
                    return Err("步长不能为 0".into());
                }
                (r, step)
            }
            None => (item, 1),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            let a: u32 = a.parse().map_err(|_| format!("数值非法：{a}"))?;
            let b: u32 = b.parse().map_err(|_| format!("数值非法：{b}"))?;
            (a, b)
        } else {
            let v: u32 = range.parse().map_err(|_| format!("数值非法：{range}"))?;
            // `a/n` = 从 a 到 max；`a` = 单值
            if item.contains('/') {
                (v, max)
            } else {
                (v, v)
            }
        };
        if lo > hi {
            return Err(format!("范围倒置：{lo}-{hi}"));
        }
        if lo < min || hi > max {
            return Err(format!("超出范围：{min}-{max}"));
        }
        let mut v = lo;
        while v <= hi {
            out.push(if sunday7 && v == 7 { 0 } else { v });
            v += step;
        }
    }
    if out.is_empty() {
        return Err("cron 字段无有效值".into());
    }
    out.sort_unstable();
    out.dedup();
    Ok((out, star))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn parse_and_next_daily() {
        let c = parse("0 9 * * *").unwrap();
        assert_eq!(
            c.next_after(dt("2026-11-19 08:30")).unwrap(),
            dt("2026-11-19 09:00")
        );
        assert_eq!(
            c.next_after(dt("2026-11-19 09:00")).unwrap(),
            dt("2026-11-20 09:00")
        );
    }

    #[test]
    fn weekdays_only() {
        let c = parse("30 8 * * 1-5").unwrap();
        // 2026-11-20 周五 → 下一个周一
        assert_eq!(
            c.next_after(dt("2026-11-20 09:00")).unwrap(),
            dt("2026-11-23 08:30")
        );
    }

    #[test]
    fn step_and_list() {
        let c = parse("*/15 9-18/2 * * *").unwrap();
        // 小时 9,11,13,15,17（步长 2 从 9 起）→ 10:01 的下一触发=11:00
        assert_eq!(
            c.next_after(dt("2026-11-19 10:01")).unwrap(),
            dt("2026-11-19 11:00")
        );
        let c = parse("0 0 1,15 * *").unwrap();
        assert_eq!(
            c.next_after(dt("2026-11-02 00:00")).unwrap(),
            dt("2026-11-15 00:00")
        );
    }

    #[test]
    fn invalid() {
        assert!(parse("0 9 * *").is_err());
        assert!(parse("60 9 * * *").is_err());
        assert!(parse("0 9 * * 8").is_err());
        assert!(parse("*/0 9 * * *").is_err());
    }

    #[test]
    fn sunday_seven_alias() {
        let c = parse("0 9 * * 7").unwrap();
        assert_eq!(
            c.next_after(dt("2026-11-19 00:00")).unwrap(),
            dt("2026-11-22 09:00") // 2026-11-22 周日
        );
    }
}
