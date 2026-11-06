//! 活动日志（被动轨原始层，D15 §3.1）：自持轻量 JSONL 按日文件
//! `{dataDir}/agent/journal/YYYY-MM-DD.jsonl`，一行一事件。
//!
//! - 写入：append 模式打开，写一行立即 flush（崩溃至多丢当前行）；
//! - 读取：单日文件按行流式读（内存 O(1)），坏行跳过 + 计数；
//! - 保留：90 天清理（`rotate`，im_db_prune 同节奏）；
//! - 确定性聚合的前置层：日报（digest.rs）只依赖本文件，不依赖 LLM。
//!
//! 行内契约：事件 tag（`type` 字段）用带点线路名（`session.started` 等），
//! 字段统一 snake_case，roundtrip 测试锁定。
//! 注意：`memory.saved` 的记忆类型字段命名为 `memory_type`——
//! serde 内部 tag 模式下变体字段不得与 tag 名 `type` 同名（编译期冲突），
//! 此为对 D15 §3.1 `{session, title, type}` 的唯一刻意偏差。

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::knowledge::MemoryType;

/// journal 保留窗口（天）：保留最近 90 天（含当日），更早的 `rotate` 删除
pub const RETENTION_DAYS: i64 = 90;

/// 文件变更种类（file.changed.kind）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeKind {
    /// 编辑既有文件
    Edit,
    /// 新建文件
    Create,
    /// 删除文件
    Delete,
}

/// 活动事件（D15 §3.1 事件集，枚举可扩展）。
/// tag=`type`，变体线路名带点；字段 snake_case。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ActivityEvent {
    /// 会话开始 {session, workspace, mode}
    #[serde(rename = "session.started")]
    SessionStarted {
        /// 会话 id
        session: String,
        /// 工作区名
        workspace: String,
        /// 会话模式（interactive / obo / delegation…）
        mode: String,
    },
    /// 会话结束 {session, summary?, duration_ms}
    #[serde(rename = "session.ended")]
    SessionEnded {
        /// 会话 id
        session: String,
        /// 会话摘要（可空；W3 提炼用）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        /// 会话时长（毫秒）
        duration_ms: u64,
    },
    /// 工具执行 {session, tool, ok, duration_ms, risk}
    #[serde(rename = "tool.executed")]
    ToolExecuted {
        /// 会话 id
        session: String,
        /// 工具名
        tool: String,
        /// 是否成功
        ok: bool,
        /// 耗时（毫秒）
        duration_ms: u64,
        /// 风险级（低/中/高）
        risk: String,
    },
    /// 工具被拦截 {session, tool, code}（8020-8026 沙箱/门控拦截）
    #[serde(rename = "tool.blocked")]
    ToolBlocked {
        /// 会话 id
        session: String,
        /// 工具名
        tool: String,
        /// 拦截错误码（8020-8026）
        code: u16,
    },
    /// 文件变更 {session, path, kind}
    #[serde(rename = "file.changed")]
    FileChanged {
        /// 会话 id
        session: String,
        /// 变更路径
        path: String,
        /// 变更种类
        kind: FileChangeKind,
    },
    /// 检查点创建 {session, reason}
    #[serde(rename = "checkpoint.created")]
    CheckpointCreated {
        /// 会话 id
        session: String,
        /// 建点原因（pre-edit / manual…）
        reason: String,
    },
    /// 委派启动 {session, backend}
    #[serde(rename = "delegate.launched")]
    DelegateLaunched {
        /// 会话 id
        session: String,
        /// 委派后端（claude / codex…）
        backend: String,
    },
    /// 委派结束 {session, backend, exit_code}
    #[serde(rename = "delegate.ended")]
    DelegateEnded {
        /// 会话 id
        session: String,
        /// 委派后端
        backend: String,
        /// 子进程退出码
        exit_code: i32,
    },
    /// 记忆写入 {session, title, type}——type 字段因 tag 冲突命名为 memory_type
    #[serde(rename = "memory.saved")]
    MemorySaved {
        /// 会话 id
        session: String,
        /// 记忆标题
        title: String,
        /// 记忆类型（user/project/feedback/reference）
        memory_type: MemoryType,
    },
}

impl ActivityEvent {
    /// 事件归属会话 id（聚合分组键）
    pub fn session_id(&self) -> &str {
        match self {
            ActivityEvent::SessionStarted { session, .. }
            | ActivityEvent::SessionEnded { session, .. }
            | ActivityEvent::ToolExecuted { session, .. }
            | ActivityEvent::ToolBlocked { session, .. }
            | ActivityEvent::FileChanged { session, .. }
            | ActivityEvent::CheckpointCreated { session, .. }
            | ActivityEvent::DelegateLaunched { session, .. }
            | ActivityEvent::DelegateEnded { session, .. }
            | ActivityEvent::MemorySaved { session, .. } => session,
        }
    }
}

/// 按日读取结果：解析成功的事件 + 被跳过的坏行数
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DayRead {
    /// 当日全部合法事件（文件序）
    pub events: Vec<ActivityEvent>,
    /// 坏行数（非 JSON / 未知事件类型 / 读失败的行）
    pub skipped: usize,
}

/// 活动日志（目录 = `{dataDir}/agent/journal`）。日期由调用方传入
/// （引擎侧用注入时钟取 today，便于测试跨日）。
#[derive(Debug, Clone)]
pub struct Journal {
    dir: PathBuf,
}

impl Journal {
    /// 打开（或初始化）journal 目录
    pub fn new(dir: impl Into<PathBuf>) -> io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// journal 目录
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 某日的 journal 文件路径
    pub fn path_for(&self, date: &str) -> PathBuf {
        self.dir.join(format!("{date}.jsonl"))
    }

    /// 追加一行事件：append 打开、写后立即 flush（一行一事件即时落盘）。
    /// date 必须是合法 `YYYY-MM-DD`（防注入文件名）。
    pub fn append(&self, date: &str, event: &ActivityEvent) -> io::Result<()> {
        parse_date(date).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, format!("非法日期: {date}"))
        })?;
        let line = serde_json::to_string(event)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path_for(date))?;
        writeln!(file, "{line}")?;
        file.flush()
    }

    /// 单日流式读：逐行回调（内存 O(1)，聚合方边读边算）。
    /// 返回坏行数；文件不存在返回 0（空日）。
    pub fn stream_day<F: FnMut(ActivityEvent)>(&self, date: &str, mut on_event: F) -> usize {
        let Ok(file) = File::open(self.path_for(date)) else {
            return 0;
        };
        let mut skipped = 0;
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else {
                skipped += 1; // 读失败（如非法 UTF-8）按坏行计
                continue;
            };
            if line.trim().is_empty() {
                continue; // 空行（末尾换行产物）静默忽略
            }
            match serde_json::from_str::<ActivityEvent>(&line) {
                Ok(event) => on_event(event),
                Err(_) => skipped += 1, // 坏行跳过 + 计数（D15 §6）
            }
        }
        skipped
    }

    /// 单日读回（收集版；测试与低频路径用）
    pub fn read_day(&self, date: &str) -> DayRead {
        let mut events = Vec::new();
        let skipped = self.stream_day(date, |ev| events.push(ev));
        DayRead { events, skipped }
    }

    /// 目录内全部日志日期（YYYY-MM-DD 升序；非日期文件不入列）
    pub fn dates(&self) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(&self.dir)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| {
                        let name = e.file_name().into_string().ok()?;
                        let stem = name.strip_suffix(".jsonl")?;
                        parse_date(stem)?; // 只认合法日期文件名
                        Some(stem.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort();
        out
    }

    /// 90 天保留清理：删除日期早于 `today - (RETENTION_DAYS-1)` 的日志文件，
    /// 返回被删除的日期列表（升序）。非日期文件不动。
    pub fn rotate(&self, today: &str) -> io::Result<Vec<String>> {
        let today_days = date_to_days(today).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, format!("非法日期: {today}"))
        })?;
        let keep_from = today_days - (RETENTION_DAYS - 1); // 保留窗口含今日共 90 天
        let mut removed = Vec::new();
        for date in self.dates() {
            if date_to_days(&date).is_some_and(|d| d < keep_from) {
                fs::remove_file(self.path_for(&date))?;
                removed.push(date);
            }
        }
        Ok(removed)
    }
}

// ---------------------------------------------------------------------------
// 日期工具（无 chrono：journal 按日分文件与保留窗口只需基本日期算术）。
// civil 天数算法采用 Howard Hinnant 的公历互换公式。
// ---------------------------------------------------------------------------

/// (y, m, d) → 天数锚（1970-01-01 = 0）
pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = i64::from(m) + if m > 2 { -3 } else { 9 }; // [0, 11]，3 月为一年的首月
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// 天数锚 → (y, m, d)（`days_from_civil` 的逆）
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (y + i64::from(m <= 2), m as u32, d as u32)
}

/// 闰年判定
fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// 某月天数
fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// 严格解析 `YYYY-MM-DD`（定长、数字、真实存在的日历日）
pub(crate) fn parse_date(s: &str) -> Option<(i64, u32, u32)> {
    let bytes = s.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digit = |range: std::ops::Range<usize>| -> Option<i64> {
        let mut v: i64 = 0;
        for &b in &bytes[range] {
            if !b.is_ascii_digit() {
                return None;
            }
            v = v * 10 + i64::from(b - b'0');
        }
        Some(v)
    };
    let y = digit(0..4)?;
    let m = digit(5..7)? as u32;
    let d = digit(8..10)? as u32;
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

/// `YYYY-MM-DD` → 天数锚（journal 保留窗口比较用）
pub(crate) fn date_to_days(s: &str) -> Option<i64> {
    let (y, m, d) = parse_date(s)?;
    Some(days_from_civil(y, m, d))
}

/// (y, m, d) → `YYYY-MM-DD`（测试锚点专用）
#[cfg(test)]
pub(crate) fn format_date(y: i64, m: u32, d: u32) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// 日期平移 N 天（负数回退；非法输入返回 None；测试锚点专用）
#[cfg(test)]
pub(crate) fn shift_date(date: &str, delta: i64) -> Option<String> {
    let (y, m, d) = parse_date(date)?;
    let (ny, nm, nd) = civil_from_days(days_from_civil(y, m, d) + delta);
    Some(format_date(ny, nm, nd))
}

// ---------------------------------------------------------------------------
// 单元测试：日期算术锚点 + 行内序列化契约
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_day_anchors() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017); // Hinnant 论文锚点
        assert_eq!(days_from_civil(2026, 11, 6), 20_763);
        // 逆变换往返
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (2026, 11, 6), (2099, 12, 31)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
    }

    #[test]
    fn shift_date_anchors() {
        assert_eq!(shift_date("2026-11-06", 0).as_deref(), Some("2026-11-06"));
        assert_eq!(shift_date("2026-11-06", 1).as_deref(), Some("2026-11-07"));
        assert_eq!(shift_date("2026-11-06", -89).as_deref(), Some("2026-08-09"));
        assert_eq!(shift_date("2026-01-01", -1).as_deref(), Some("2025-12-31"));
        assert_eq!(shift_date("2024-02-28", 1).as_deref(), Some("2024-02-29")); // 闰日
        assert_eq!(shift_date("2026-02-28", 1).as_deref(), Some("2026-03-01")); // 平年
    }

    #[test]
    fn parse_date_strictness() {
        assert_eq!(parse_date("2026-11-06"), Some((2026, 11, 6)));
        assert_eq!(parse_date("2026-1-6"), None); // 非定长
        assert_eq!(parse_date("2026-13-01"), None); // 月越界
        assert_eq!(parse_date("2026-11-31"), None); // 日越界
        assert_eq!(parse_date("2023-02-29"), None); // 平年 2/29
        assert_eq!(parse_date("2024-02-29"), Some((2024, 2, 29))); // 闰年合法
        assert_eq!(parse_date("abcd-11-06"), None);
    }

    #[test]
    fn event_line_contract() {
        // tag 带点 + 字段 snake_case（roundtrip 锁定 D15 §3.1 契约）
        let ev = ActivityEvent::SessionEnded {
            session: "s1".into(),
            summary: None,
            duration_ms: 1234,
        };
        let line = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            line,
            r#"{"type":"session.ended","session":"s1","duration_ms":1234}"#
        );
        assert_eq!(serde_json::from_str::<ActivityEvent>(&line).unwrap(), ev);

        // memory.saved：类型字段为 memory_type（tag 冲突的刻意偏差）
        let ev = ActivityEvent::MemorySaved {
            session: "s1".into(),
            title: "端口约定".into(),
            memory_type: MemoryType::Project,
        };
        let line = serde_json::to_string(&ev).unwrap();
        assert!(line.contains(r#""type":"memory.saved""#));
        assert!(line.contains(r#""memory_type":"project""#));
        assert_eq!(serde_json::from_str::<ActivityEvent>(&line).unwrap(), ev);

        // summary 有值时序列化、缺失时可解析（default）
        let ev = ActivityEvent::SessionEnded {
            session: "s1".into(),
            summary: Some("done".into()),
            duration_ms: 5,
        };
        let line = serde_json::to_string(&ev).unwrap();
        assert!(line.contains(r#""summary":"done""#));
        assert_eq!(serde_json::from_str::<ActivityEvent>(&line).unwrap(), ev);

        // 未知事件类型 → 解析失败（读路径按坏行跳过）
        assert!(serde_json::from_str::<ActivityEvent>(r#"{"type":"unknown.x"}"#).is_err());
    }

    #[test]
    fn session_id_of_every_variant() {
        let events = [
            ActivityEvent::SessionStarted {
                session: "s".into(),
                workspace: "w".into(),
                mode: "interactive".into(),
            },
            ActivityEvent::SessionEnded {
                session: "s".into(),
                summary: None,
                duration_ms: 1,
            },
            ActivityEvent::ToolExecuted {
                session: "s".into(),
                tool: "t".into(),
                ok: true,
                duration_ms: 1,
                risk: "低".into(),
            },
            ActivityEvent::ToolBlocked {
                session: "s".into(),
                tool: "t".into(),
                code: 8021,
            },
            ActivityEvent::FileChanged {
                session: "s".into(),
                path: "p".into(),
                kind: FileChangeKind::Edit,
            },
            ActivityEvent::CheckpointCreated {
                session: "s".into(),
                reason: "pre-edit".into(),
            },
            ActivityEvent::DelegateLaunched {
                session: "s".into(),
                backend: "claude".into(),
            },
            ActivityEvent::DelegateEnded {
                session: "s".into(),
                backend: "claude".into(),
                exit_code: 0,
            },
            ActivityEvent::MemorySaved {
                session: "s".into(),
                title: "t".into(),
                memory_type: MemoryType::User,
            },
        ];
        for ev in &events {
            assert_eq!(ev.session_id(), "s");
        }
    }
}
