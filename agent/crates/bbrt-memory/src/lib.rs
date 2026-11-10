//! bbrt-memory：知识记忆双轨与活动日报（权威 = docs/detail/D15）。
//!
//! - **主动轨** `knowledge/`：ZCode 式文件记忆（frontmatter + `MEMORY.md` 索引）。
//!   写入路径 W1（模型工具 `memory.save`）与 W2（规则启发，免模型兜底）；
//!   W3（会话结束提炼）阶段二随 aigw 压缩摘要接入。
//! - **被动轨** `journal` + `digest`：活动 JSONL 按日落地 → 确定性聚合出日报
//!   （md + json 双产物，不依赖 LLM，弱网/离线可用）。
//! - 装配：`MemoryEngine` 组合 knowledge + journal + digest，被 bbrt-session 依赖
//!   （会话事件喂 journal；session.ended 触发当日日报重算）。
//!
//! 约束：同步 API、无 tokio；存储为纯文件（不依赖 SQLite），目录即权威；
//! 脱敏在记忆正文入口就地拒写（D15 §4；不依赖 bbrt-sec，接入层可叠加 masking）。

#![forbid(unsafe_code)]

pub mod digest;
pub mod journal;
pub mod knowledge;

pub use digest::{DailyStats, DelegateExit, Digest, DigestError, Report, SessionRow};
pub use journal::{ActivityEvent, DayRead, FileChangeKind, Journal, RETENTION_DAYS};
pub use knowledge::{
    detect_memory_hint, ErrorTracker, Heuristic, IndexOutcome, KnowledgeStore, LessonCandidate,
    MemoryEntry, MemoryError, MemorySummary, MemoryType, SaveInput, SaveResult, MAX_BODY_BYTES,
    MAX_ENTRIES, RECALL_FULL_ENTRIES, RECALL_TOP_K,
};

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 可注入时钟（时间戳/日界统一出口；测试注入固定值）
// ---------------------------------------------------------------------------

/// 时钟抽象：RFC3339 时间戳（记忆 frontmatter 用）与本地日（journal/日报日界）。
/// std 无本地时区接口且本 crate 不引 chrono，`SystemClock` 取 UTC 日界
/// （v0.1 已知简化，跨时区用户的"一天"以 UTC 切分）。
pub trait Clock: Send + Sync {
    /// 当前时刻（RFC3339，含时区偏移）
    fn now_rfc3339(&self) -> String;
    /// 当前日（`YYYY-MM-DD`）
    fn today(&self) -> String;
}

/// 系统时钟（UTC）
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_rfc3339(&self) -> String {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        epoch_to_rfc3339(secs)
    }

    fn today(&self) -> String {
        self.now_rfc3339()[..10].to_string()
    }
}

/// 测试/嵌入用固定时钟：可运行中改值（模拟跨日）
#[derive(Debug)]
pub struct FixedClock(Mutex<(String, String)>);

impl FixedClock {
    /// `(now_rfc3339, today)` 初始值
    pub fn new(now_rfc3339: &str, today: &str) -> Self {
        Self(Mutex::new((now_rfc3339.to_string(), today.to_string())))
    }

    /// 改值（模拟时间推进/跨日）
    pub fn set(&self, now_rfc3339: &str, today: &str) {
        *self.0.lock().expect("FixedClock 未中毒") = (now_rfc3339.to_string(), today.to_string());
    }
}

impl Clock for FixedClock {
    fn now_rfc3339(&self) -> String {
        self.0.lock().expect("FixedClock 未中毒").0.clone()
    }

    fn today(&self) -> String {
        self.0.lock().expect("FixedClock 未中毒").1.clone()
    }
}

/// Unix 秒 → RFC3339（UTC）
fn epoch_to_rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = journal::civil_from_days(days);
    let (h, mi, s) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}+00:00")
}

// ---------------------------------------------------------------------------
// 协议 payload（D15 §2.4 / §3.3 的 RT→宿主事件体；嵌套 struct 自带
// rename_all=camelCase——7698c52 教训：枚举变体的 rename_all 不传导到嵌套 struct）
// ---------------------------------------------------------------------------

/// `memory.saved`：记忆写入/更新上报（UNT）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySavedEvent {
    /// 会话 id
    pub session_id: String,
    /// 记忆 slug
    pub name: String,
    /// 标题
    pub title: String,
    /// 记忆类型
    pub r#type: MemoryType,
    /// true = 同题原地更新；false = 新增
    pub updated: bool,
}

/// `memory.evicted`：容量淘汰上报（UNT；reason=capacity）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvictedEvent {
    /// 触发淘汰的会话（可空）
    pub session_id: Option<String>,
    /// 被淘汰记忆的 name
    pub name: String,
    /// 淘汰原因（v0.1 恒 "capacity"）
    pub reason: String,
}

/// `report.daily`：日报产出/更新上报（UNT）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDailyEvent {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 人读产物路径
    pub path: String,
    /// 聚合统计（camelCase）
    pub stats: DailyStats,
}

/// `save_memory` 完整结果：写入/更新事件 + 淘汰事件列表
#[derive(Debug, Clone, PartialEq)]
pub struct SaveOutcome {
    /// 记忆写入/更新事件（`memory.saved`）
    pub saved: MemorySavedEvent,
    /// 本次触发的容量淘汰事件（`memory.evicted`；通常为空）
    pub evicted: Vec<MemoryEvictedEvent>,
}

impl Report {
    /// 日报产物 → `report.daily` 协议事件
    pub fn to_event(&self) -> ReportDailyEvent {
        ReportDailyEvent {
            date: self.date.clone(),
            path: self.md_path.to_string_lossy().into_owned(),
            stats: self.stats.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// MemoryEngine：knowledge + journal + digest 装配
// ---------------------------------------------------------------------------

/// 记忆引擎：统一打开 `{dataDir}/agent` 下的 memory / journal / reports 三目录。
///
/// 目录布局（D15 §2.1 / §3.1 / §3.2）：
/// ```text
/// {dataDir}/agent/memory/    MEMORY.md + <slug>.md
/// {dataDir}/agent/journal/   YYYY-MM-DD.jsonl
/// {dataDir}/agent/reports/   YYYY-MM-DD.md + YYYY-MM-DD.json
/// ```
#[derive(Clone)]
pub struct MemoryEngine {
    clock: Arc<dyn Clock>,
    knowledge: KnowledgeStore,
    journal: Journal,
    digest: Digest,
}

impl std::fmt::Debug for MemoryEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 时钟为 trait 对象不可 Debug，展示三个子组件
        f.debug_struct("MemoryEngine")
            .field("knowledge", &self.knowledge)
            .field("journal", &self.journal)
            .field("digest", &self.digest)
            .finish()
    }
}

impl MemoryEngine {
    /// 打开（或初始化）引擎；启动即重建 `MEMORY.md` 索引
    /// （崩溃恢复：索引可重建故非权威，D15 §2.1）。
    pub fn open(data_dir: &Path, clock: Arc<dyn Clock>) -> io::Result<Self> {
        let base = data_dir.join("agent");
        let knowledge = KnowledgeStore::new(base.join("memory"), Arc::clone(&clock))?;
        let journal = Journal::new(base.join("journal"))?;
        let digest = Digest::new(journal.clone(), base.join("reports"))?;
        knowledge.rebuild_index()?;
        Ok(Self {
            clock,
            knowledge,
            journal,
            digest,
        })
    }

    /// 知识记忆存储（主动轨）
    pub fn knowledge(&self) -> &KnowledgeStore {
        &self.knowledge
    }

    /// 活动日志（被动轨原始层）
    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    /// 日报生成器（被动轨产物层）
    pub fn digest(&self) -> &Digest {
        &self.digest
    }

    /// 当前日（注入时钟）
    pub fn today(&self) -> String {
        self.clock.today()
    }

    /// 活动事件入 journal（写前 append、写后 flush；D15 §3.1）。
    /// `memory.saved` 事件同样落 journal——日报聚合即读 journal，
    /// 统计由同一数据源驱动（D15 §3.2 交叉印证）。
    pub fn record(&self, event: &ActivityEvent) -> io::Result<()> {
        self.journal.append(&self.clock.today(), event)
    }

    /// W1 写入路径：知识记忆落盘 + journal 记 `memory.saved` + 产出协议事件。
    /// journal 记录失败时返回错误——但记忆文件已落盘，重试安全（同题更新不重复）。
    /// D19 起为本方法的作用域路由入口（None/空 workspace=用户级）。
    pub fn save_memory(&self, input: &SaveInput) -> Result<SaveOutcome, MemoryError> {
        self.save_memory_scoped(None, input)
    }

    /// D19 W1 作用域写入：Some(workspace) → 项目分区；None/空 → 用户级。
    /// 两条路径共享 journal（被动轨全局活动统计）与容量/脱敏约束。
    pub fn save_memory_scoped(
        &self,
        workspace: Option<&Path>,
        input: &SaveInput,
    ) -> Result<SaveOutcome, MemoryError> {
        let (store, scope, workspace_name) = match workspace.map(Path::to_path_buf) {
            Some(ws) if !ws.as_os_str().is_empty() => {
                let real = fs::canonicalize(&ws).unwrap_or(ws);
                let name = scope_key(&real);
                let store = self
                    .project_store(&real)
                    .map_err(MemoryError::Io)?;
                (store, "project".to_string(), Some(name))
            }
            _ => (self.knowledge.clone(), "user".to_string(), None),
        };
        let result = store.save(input)?;
        self.record(&ActivityEvent::MemorySaved {
            session: input.session.clone(),
            title: result.title.clone(),
            memory_type: input.mtype,
        })?;
        Ok(SaveOutcome {
            saved: MemorySavedEvent {
                session_id: input.session.clone(),
                name: result.name.clone(),
                title: result.title.clone(),
                r#type: input.mtype,
                updated: result.updated,
                scope,
                workspace_name,
            },
            evicted: result
                .evicted
                .iter()
                .map(|name| MemoryEvictedEvent {
                    session_id: Some(input.session.clone()),
                    name: name.clone(),
                    reason: "capacity".to_string(),
                })
                .collect(),
        })
    }

    /// D19 作用域列表：Some(workspace) → 该项目分区条目；None/空 → 用户级条目。
    pub fn list_scoped(&self, workspace: Option<&Path>) -> Vec<MemorySummary> {
        match workspace.map(Path::to_path_buf) {
            Some(ws) if !ws.as_os_str().is_empty() => {
                let real = fs::canonicalize(&ws).unwrap_or(ws);
                self.project_store(&real)
                    .map(|s| s.list())
                    .unwrap_or_default()
            }
            _ => self.knowledge.list(),
        }
    }

    /// D19 全部项目分区清单（memory.list scope=project 未指定路径时）：
    /// 扫 projects/ 一级子目录（目录名即 scope_key），每分区带条目。
    pub fn list_project_partitions(&self) -> Vec<(String, Vec<MemorySummary>)> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(&self.projects_dir) else {
            return out;
        };
        let mut keys: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        keys.sort();
        for dir in keys {
            let Some(key) = dir.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let store = KnowledgeStore::new(&dir, Arc::clone(&self.clock))
                .map_err(MemoryError::Io)
                .map(|s| s.list())
                .unwrap_or_default();
            out.push((key.to_string(), store));
        }
        out
    }

    /// D19 作用域删除：Some(workspace) → 项目分区；None/空 → 用户级。
    pub fn delete_scoped(
        &self,
        workspace: Option<&Path>,
        name: &str,
    ) -> Result<bool, MemoryError> {
        match workspace.map(Path::to_path_buf) {
            Some(ws) if !ws.as_os_str().is_empty() => {
                let real = fs::canonicalize(&ws).unwrap_or(ws);
                self.project_store(&real)
                    .map_err(MemoryError::Io)?
                    .delete(name)
            }
            _ => self.knowledge.delete(name),
        }
    }

    /// D19 作用域召回（loop_runner [记忆] 块数据源）：
    /// - 日常（None/空）→ 仅用户级（等价 recall_for）；
    /// - 项目会话 → 用户级 + 项目级两段，带 `[用户记忆]`/`[项目记忆·<分区>]`
    ///   小节头（单段为空则只注另一段；两段皆空 → 空串）。
    pub fn recall_scoped(&self, workspace: Option<&Path>, query: &str) -> String {
        let user_part = self
            .knowledge
            .recall_for(query)
            .unwrap_or_default();
        let project_part = match workspace.map(Path::to_path_buf) {
            Some(ws) if !ws.as_os_str().is_empty() => {
                let real = fs::canonicalize(&ws).unwrap_or(ws);
                self.project_store(&real)
                    .ok()
                    .and_then(|s| s.recall_for(query).ok())
                    .unwrap_or_default()
            }
            _ => String::new(),
        };
        match (user_part.is_empty(), project_part.is_empty()) {
            (true, true) => String::new(),
            (false, true) => user_part,
            (true, false) => {
                let key = scope_key(
                    &fs::canonicalize(workspace.unwrap_or_default())
                        .unwrap_or_else(|_| workspace.unwrap_or_default().to_path_buf()),
                );
                format!("[项目记忆·{key}]\n{project_part}")
            }
            (false, false) => {
                let key = scope_key(
                    &fs::canonicalize(workspace.unwrap_or_default())
                        .unwrap_or_else(|_| workspace.unwrap_or_default().to_path_buf()),
                );
                format!("[用户记忆]\n{user_part}\n\n[项目记忆·{key}]\n{project_part}")
            }
        }
    }

    /// session.ended 落地后的当日日报重算（D15 §3.2 触发 1；幂等覆盖）。
    /// 空日（当日无 journal）返回 None。
    pub fn on_session_end(&self) -> Result<Option<Report>, DigestError> {
        self.digest.generate(&self.clock.today())
    }

    /// Runtime 启动回补（D15 §3.2 触发 2）：journal 有而 reports 缺的日期
    /// 逐日补生成（覆盖崩溃漏算；含当日）。返回补出的日报（日期升序）。
    pub fn startup_backfill(&self) -> Result<Vec<Report>, DigestError> {
        self.digest.backfill(&self.clock.today())
    }

    /// 已有日报列表（D15 §3.3 report.list：reports 目录统计，日期倒序）
    pub fn list_reports(&self, limit: usize) -> Vec<DailyStats> {
        self.digest.list(limit)
    }

    /// journal 90 天保留清理（D15 §3.1；im_db_prune 同节奏）。返回被删日期。
    pub fn rotate_journal(&self) -> io::Result<Vec<String>> {
        self.journal.rotate(&self.clock.today())
    }
}

// ---------------------------------------------------------------------------
// 单元测试：时钟换算
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_to_rfc3339_anchors() {
        assert_eq!(epoch_to_rfc3339(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(epoch_to_rfc3339(1), "1970-01-01T00:00:01+00:00");
        // 2026-11-06T00:00:00Z = 20_763 天 × 86400
        assert_eq!(
            epoch_to_rfc3339(20_763 * 86_400),
            "2026-11-06T00:00:00+00:00"
        );
        assert_eq!(epoch_to_rfc3339(86_399), "1970-01-01T23:59:59+00:00");
    }

    #[test]
    fn system_clock_today_is_date_prefix() {
        let clock = SystemClock;
        let now = clock.now_rfc3339();
        assert_eq!(now.len(), 25); // YYYY-MM-DDTHH:MM:SS+00:00
        assert_eq!(clock.today(), now[..10]);
    }

    #[test]
    fn fixed_clock_mutable() {
        let clock = FixedClock::new("2026-11-05T23:00:00+08:00", "2026-11-05");
        assert_eq!(clock.today(), "2026-11-05");
        clock.set("2026-11-06T00:01:00+08:00", "2026-11-06");
        assert_eq!(clock.now_rfc3339(), "2026-11-06T00:01:00+08:00");
        assert_eq!(clock.today(), "2026-11-06");
    }
}
