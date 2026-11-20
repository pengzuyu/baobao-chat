//! bbrt-memory：知识记忆（权威 = docs/detail/D15）+ 公共层压实记忆（D23 升级）。
//!
//! - **主动轨** `knowledge/`：ZCode 式文件记忆（frontmatter + `MEMORY.md` 索引）。
//!   写入路径 W1（模型工具 `memory.save`）与 W2（规则启发，免模型兜底）；
//!   W3（会话结束提炼）阶段二随 aigw 压缩摘要接入。
//! - **公共层** `global/`（D23）：用户级换制——journal.jsonl（真相）+ USER.md
//!   （压实视图=缓存）；十类硬枚举+硬度轴；user 类与日常会话回落路由至此。
//! - **项目进度台账** `status.rs`（D37）：`status` 类型记忆条目的五段正文
//!   编解码（待办/已做/阻塞/决策/坑，加法合并不裁剪）；仅 W3 会话结束写入，
//!   注入为 [记忆] 块第三段 `[项目进度]`。
//! - 装配：`MemoryEngine` 组合 global + knowledge，被 bbrt-session 依赖。
//!   （D15 被动轨 journal/digest 活动日报已随日报 UI 整域退役移除。）
//!
//! 约束：同步 API、无 tokio；存储为纯文件（不依赖 SQLite），目录即权威；
//! 脱敏在记忆正文入口就地拒写（D15 §4；不依赖 bbrt-sec，接入层可叠加 masking）。

#![forbid(unsafe_code)]

pub mod global;
pub mod knowledge;
pub mod status;

pub use global::{
    compaction_prompt, global_line, parse_compacted, AddOutcome, Compactor, GlobalEntry,
    GlobalError, GlobalOp, GlobalStore, GlobalType, HARD_LIMIT_CHARS, MAX_ENTRY_CHARS,
    SOFT_TARGET_CHARS,
};
pub use knowledge::{
    detect_memory_hint, ErrorTracker, Heuristic, IndexOutcome, KnowledgeStore, LessonCandidate,
    MemoryEntry, MemoryError, MemorySummary, MemoryType, SaveInput, SaveResult,
    RECALL_FULL_ENTRIES, RECALL_TOP_K,
};
pub use status::{StatusDelta, StatusMergeStats, STATUS_TITLE};

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// 可注入时钟（时间戳/日界统一出口；测试注入固定值）
// ---------------------------------------------------------------------------

/// 时钟抽象：RFC3339 时间戳（记忆 frontmatter 用）与本地日。
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
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}+00:00")
}

// ---------------------------------------------------------------------------
// 日期工具（无 chrono；civil 天数算法采用 Howard Hinnant 的公历互换公式，
// 原 journal.rs 随被动轨退役后仅时钟换算仍需 days→(y,m,d) 一个方向）
// ---------------------------------------------------------------------------

/// 天数锚 → (y, m, d)（1970-01-01 = 0）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
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
    /// D19 作用域："user" | "project"（默认 user=旧口径；D23 起 user=公共层）
    #[serde(default = "default_scope_user")]
    pub scope: String,
    /// D19 项目分区名（scope=project 时携带；scope_key 形如 baobao-work-72ab07a9…）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    /// D23 公共层十类标签（画像/偏好/…；None=项目分区知识记忆）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_type: Option<String>,
}

/// serde 默认值：作用域 user
fn default_scope_user() -> String {
    "user".to_string()
}

/// D23：公共层错误 → 记忆错误（save_memory_scoped 回落路由共用错误面）
impl From<GlobalError> for MemoryError {
    fn from(e: GlobalError) -> Self {
        match e {
            GlobalError::EmptyText => MemoryError::EmptyTitle,
            GlobalError::EntryTooLong { actual, max } => {
                MemoryError::GlobalEntryTooLong { actual, max }
            }
            GlobalError::Sensitive(w) => MemoryError::SensitiveContent(w),
            GlobalError::Io(io) => MemoryError::Io(io),
        }
    }
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

/// `save_memory` 完整结果：写入/更新事件 + 淘汰事件列表
#[derive(Debug, Clone, PartialEq)]
pub struct SaveOutcome {
    /// 记忆写入/更新事件（`memory.saved`）
    pub saved: MemorySavedEvent,
    /// 本次触发的容量淘汰事件（`memory.evicted`；通常为空）
    pub evicted: Vec<MemoryEvictedEvent>,
}

// ---------------------------------------------------------------------------
// MemoryEngine：knowledge + global 装配
// ---------------------------------------------------------------------------

/// 记忆引擎：统一打开 `{dataDir}/agent` 下的 memory 目录。
///
/// 目录布局（D15 §2.1；D19 增项目分区；D23 用户级换制+迁移归档）：
/// ```text
/// {dataDir}/agent/memory/global/          D23 公共层：journal.jsonl + USER.md
/// {dataDir}/agent/memory/projects/<key>/  项目级分区（key=scope_key(工作目录)）
/// {dataDir}/agent/memory/archive/         D23 一次性迁移归档（旧用户级文件族）
/// ```
/// MemoryEngine（Clone 为手工实现——见下方 impl）
pub struct MemoryEngine {
    clock: Arc<dyn Clock>,
    global: GlobalStore,
    knowledge: KnowledgeStore,
    /// D19 项目分区根（memory/projects）
    projects_dir: PathBuf,
    /// D19 分区缓存（realpath → store；KnowledgeStore=PathBuf+Arc 时钟，克隆廉价）
    project_stores: Mutex<HashMap<PathBuf, KnowledgeStore>>,
    /// D37 进度合并锁：跨 clone 共享同一把（与 GlobalStore「克隆=新锁」不同——
    /// 多会话并发结束时 W3 各持引擎克隆，读-合并-写必须进程内串行防丢更新）
    status_lock: Arc<Mutex<()>>,
}

impl Clone for MemoryEngine {
    /// 手工实现：缓存 Mutex 不 Clone——锁出内层 HashMap 克隆（分区 store 廉价）；
    /// `status_lock` 为 Arc 共享（克隆后仍是同一把锁，D37）
    fn clone(&self) -> Self {
        let cached = self
            .project_stores
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        Self {
            clock: Arc::clone(&self.clock),
            global: self.global.clone(),
            knowledge: self.knowledge.clone(),
            projects_dir: self.projects_dir.clone(),
            project_stores: Mutex::new(cached),
            status_lock: Arc::clone(&self.status_lock),
        }
    }
}

impl std::fmt::Debug for MemoryEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 时钟为 trait 对象不可 Debug，展示子组件
        f.debug_struct("MemoryEngine")
            .field("global", &self.global)
            .field("knowledge", &self.knowledge)
            .field("projects_dir", &self.projects_dir)
            .finish()
    }
}

/// D19 项目分区 key：`<目录名>-<路径 sha256 前 16hex>`（ZCode 同款；
/// 2026-11-20 由 FNV-1a 64 换制对齐，旧 FNV 分区不迁移、作废口径）。
/// 目录名保留 Unicode 字母数字与 . _（其余折叠为 -，截 48 字符防文件名超限，
/// CJK 项目名不再退化 project-）；同名不同路径靠哈希段区分；
/// 调用方先 canonicalize 再取 key（路径别名归一）。
pub fn scope_key(path: &Path) -> String {
    let dir_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let mut sane = String::new();
    let mut last_dash = false;
    for c in dir_name.chars() {
        if c.is_alphanumeric() || c == '.' || c == '_' {
            if sane.chars().count() < 48 {
                sane.push(c);
            }
            last_dash = false;
        } else if !last_dash {
            sane.push('-');
            last_dash = true;
        }
    }
    let sane = sane.trim_matches('-').to_string();
    let sane = if sane.is_empty() {
        "project".to_string()
    } else {
        sane
    };
    // sha256 前 16hex；输入 = 绝对路径字符串字节（与 ZCode 一致）
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{sane}-{}", &hex[..16])
}

impl MemoryEngine {
    /// 打开（或初始化）引擎；启动链：D23 一次性迁移（幂等）→ 重建项目分区索引
    /// → 公共层 reconcile（确定性重建视图；崩溃恢复：索引/视图可重建故非权威）。
    pub fn open(data_dir: &Path, clock: Arc<dyn Clock>) -> io::Result<Self> {
        Self::open_root(data_dir, None, clock)
    }

    /// D23/M3：`BBC_MEMORY_ROOT` 覆盖入口——记忆根（global/projects/archive）
    /// 可整体指到别处（联调隔离：防 :8090 测试期 agent 脏记忆污染日常 USER.md）。
    pub fn open_root(
        data_dir: &Path,
        memory_root: Option<PathBuf>,
        clock: Arc<dyn Clock>,
    ) -> io::Result<Self> {
        let base = data_dir.join("agent");
        let memory_root = memory_root.unwrap_or_else(|| base.join("memory"));
        let global = GlobalStore::new(memory_root.join("global"), Arc::clone(&clock))?;
        let knowledge = KnowledgeStore::new(&memory_root, Arc::clone(&clock))?;
        global::migrate_legacy_user_store(&memory_root, &global, &clock)?;
        knowledge.rebuild_index()?;
        global.reconcile()?;
        Ok(Self {
            clock,
            global,
            knowledge,
            projects_dir: memory_root.join("projects"),
            project_stores: Mutex::new(HashMap::new()),
            status_lock: Arc::new(Mutex::new(())),
        })
    }

    /// D23 公共层存储（journal + USER.md）
    pub fn global(&self) -> &GlobalStore {
        &self.global
    }

    /// 知识记忆存储（主动轨；项目分区根目录——D23 起用户级走 `global`）
    pub fn knowledge(&self) -> &KnowledgeStore {
        &self.knowledge
    }

    /// D19 取（或惰性初始化）项目分区存储。realpath 归一后作为缓存键与
    /// scope_key 输入（路径别名同分区）。KnowledgeStore 为廉价克隆。
    pub fn project_store(&self, workspace: &Path) -> io::Result<KnowledgeStore> {
        let real = fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        let mut cache = self
            .project_stores
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(store) = cache.get(&real) {
            return Ok(store.clone());
        }
        let store = KnowledgeStore::new(
            self.projects_dir.join(scope_key(&real)),
            Arc::clone(&self.clock),
        )?;
        store.rebuild_index()?;
        cache.insert(real, store.clone());
        Ok(store)
    }

    /// 当前日（注入时钟）
    pub fn today(&self) -> String {
        self.clock.today()
    }

    /// W1 写入路径：知识记忆落盘 + 产出协议事件。
    /// D19 起为本方法的作用域路由入口（None/空 workspace=用户级）。
    pub fn save_memory(&self, input: &SaveInput) -> Result<SaveOutcome, MemoryError> {
        self.save_memory_scoped(None, input)
    }

    /// D19 W1 作用域写入。D23 §3.6 路由修订：
    /// - `user` 类**恒公共层**（画像）——项目会话也不例外（用户事实与项目无关）；
    /// - 日常会话（None/空 workspace）的 project/feedback/reference **回落公共层**
    ///   （落地修订 A：IM embedded 主场景不丢教训——feedback→教训、reference→术语、
    ///   project→画像）；
    /// - 项目会话三类知识记忆落项目分区（D19 原口径不变）。
    pub fn save_memory_scoped(
        &self,
        workspace: Option<&Path>,
        input: &SaveInput,
    ) -> Result<SaveOutcome, MemoryError> {
        let ws = workspace.and_then(|w| (!w.as_os_str().is_empty()).then(|| w.to_path_buf()));
        if ws.is_none() || input.mtype == MemoryType::User {
            let gtype = match input.mtype {
                MemoryType::User | MemoryType::Project => GlobalType::Profile,
                MemoryType::Feedback => GlobalType::Lesson,
                MemoryType::Reference => GlobalType::Glossary,
                // D37：进度台账仅属于项目分区；日常会话（ws=None 走到这）拒绝，
                // 不回落公共层（进度是项目状态，不是用户画像）
                MemoryType::Status => return Err(MemoryError::StatusRequiresProject),
            };
            let text = global_line(&input.title, &input.body);
            return self.save_global(gtype, &text, &input.session);
        }
        let real = fs::canonicalize(ws.as_ref().expect("ws.is_some 已保证"))
            .unwrap_or_else(|_| ws.clone().expect("ws.is_some 已保证"));
        let name = scope_key(&real);
        let store = self.project_store(&real).map_err(MemoryError::Io)?;
        let result = store.save(input)?;
        Ok(SaveOutcome {
            saved: MemorySavedEvent {
                session_id: input.session.clone(),
                name: result.name.clone(),
                title: result.title.clone(),
                r#type: input.mtype,
                updated: result.updated,
                scope: "project".to_string(),
                workspace_name: Some(name),
                global_type: None,
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

    /// D23 公共层写入（W1 十类直通 / W2·W3 回落统一入口）：
    /// journal 追加 + 重投影（规则内免 LLM）。
    pub fn save_global(
        &self,
        gtype: GlobalType,
        text: &str,
        session: &str,
    ) -> Result<SaveOutcome, MemoryError> {
        let outcome = self.global.add(gtype, text, session)?;
        Ok(SaveOutcome {
            saved: MemorySavedEvent {
                session_id: session.to_string(),
                name: global::VIEW_FILE.to_string(),
                title: text.to_string(),
                r#type: MemoryType::User,
                updated: outcome.updated,
                scope: "user".to_string(),
                workspace_name: None,
                global_type: Some(gtype.label().to_string()),
            },
            evicted: vec![],
        })
    }

    /// D23 更正第一步（§3.5）：tombstone 匹配条目；返回被移除文本
    /// （0/1/N 三态回显防同名误伤——误删可重写，journal 有底）。
    pub fn forget_global(
        &self,
        gtype: GlobalType,
        contains: &str,
        session: &str,
    ) -> Result<Vec<String>, MemoryError> {
        self.global
            .forget(gtype, contains, session)
            .map_err(MemoryError::from)
    }

    /// D23 `memory_read` 数据源：取项目分区单条正文并 touch `last_used`（§4.2）。
    /// 日常会话（None/空）返回 None——公共层 USER.md 已全文注入无需读。
    pub fn read_scoped_entry(&self, workspace: Option<&Path>, name: &str) -> Option<String> {
        let ws = workspace.and_then(|w| (!w.as_os_str().is_empty()).then(|| w.to_path_buf()))?;
        let real = fs::canonicalize(&ws).unwrap_or(ws);
        let store = self.project_store(&real).ok()?;
        let entry = store.get(name).ok()??;
        let _ = store.touch(name);
        Some(entry.body)
    }

    /// D23：装配公共层压实器（bbrt main 接 bbc-fast；见 bbrt_session::FastCompactor）
    pub fn set_compactor(&self, c: Option<Arc<dyn global::Compactor>>) {
        self.global.set_compactor(c);
    }

    /// D19 作用域列表：Some(workspace) → 该项目分区条目；None/空 → 公共层条目
    /// （D23：用户级换制为 USER.md 视图——name 取文本 slug 仅供展示，
    /// 删除/编辑走 `forget_global`，M3 协议收口）。
    pub fn list_scoped(&self, workspace: Option<&Path>) -> Vec<MemorySummary> {
        match workspace.and_then(|w| (!w.as_os_str().is_empty()).then(|| w.to_path_buf())) {
            Some(ws) => {
                let real = fs::canonicalize(&ws).unwrap_or(ws);
                self.project_store(&real)
                    .map(|s| s.list())
                    .unwrap_or_default()
            }
            None => self.global_summaries(),
        }
    }

    /// 公共层条目 → 记忆页摘要（title=条目文本；updated_at 空——视图无元数据，
    /// D23 拍板 #6）
    fn global_summaries(&self) -> Vec<MemorySummary> {
        self.global
            .replay()
            .into_iter()
            .map(|e| MemorySummary {
                name: knowledge::store::slugify(&e.text),
                title: e.text.clone(),
                mtype: MemoryType::User,
                updated_at: String::new(),
                hook: e.text,
            })
            .collect()
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

    /// D19 作用域取单条正文（测试/预览用）：Some(workspace) → 项目分区；
    /// None/空 → 用户级；缺失返回 None。
    pub fn get_scoped_entry(&self, workspace: Option<&Path>, name: &str) -> Option<String> {
        let entry = match workspace {
            Some(ws) if !ws.as_os_str().is_empty() => {
                let real = fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf());
                self.project_store(&real).ok()?.get(name).ok().flatten()?
            }
            _ => self.knowledge.get(name).ok().flatten()?,
        };
        Some(entry.body)
    }

    /// D19 作用域删除：Some(workspace) → 项目分区；None/空 → 用户级。
    pub fn delete_scoped(&self, workspace: Option<&Path>, name: &str) -> Result<bool, MemoryError> {
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

    /// D19 作用域召回（记忆两段；D37 拆出——W3 去重参考用，不含进度段）：
    /// - 用户段 = **USER.md 全文**（公共层压实视图，≤3000 字常载成本恒定，
    ///   取代旧用户级 MEMORY.md 全量/Top-K）；
    /// - 项目段 = 分区 MEMORY.md（D15 v0.2 分档沿用：≤50 全量/>50 Top-K）；
    /// - 日常（None/空）仅用户段；项目会话两段带 `[用户记忆]`/`[项目记忆·<分区>]`
    ///   小节头（单段为空则只注另一段；两段皆空 → 空串）。
    pub fn recall_memory_scoped(&self, workspace: Option<&Path>, query: &str) -> String {
        let user_part = self.global.view();
        let project =
            match workspace.and_then(|w| (!w.as_os_str().is_empty()).then(|| w.to_path_buf())) {
                Some(ws) => {
                    let real = fs::canonicalize(&ws).unwrap_or(ws);
                    let key = scope_key(&real);
                    let part = self
                        .project_store(&real)
                        .ok()
                        .and_then(|s| s.recall_for(query).ok())
                        .unwrap_or_default();
                    Some((key, part))
                }
                None => None,
            };
        match (&user_part, &project) {
            (u, None) if u.is_empty() => String::new(),
            (u, None) => u.clone(),
            (u, Some((key, p))) if u.is_empty() => format!("[项目记忆·{key}]\n{p}"),
            (u, Some((key, p))) => format!("[用户记忆]\n{u}\n\n[项目记忆·{key}]\n{p}"),
        }
    }

    /// 作用域召回（loop_runner [记忆] 块数据源；D23 §6 + D37 进度段）：
    /// `recall_memory_scoped` 两段之外，项目会话再追加 `[项目进度]`（status
    /// 条目正文全文）。日常会话无进度段；无台账时输出与旧口径逐字节一致。
    pub fn recall_scoped(&self, workspace: Option<&Path>, query: &str) -> String {
        let mut out = self.recall_memory_scoped(workspace, query);
        if let Some(ws) = workspace.filter(|w| !w.as_os_str().is_empty()) {
            let real = fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf());
            if let Some(body) = self.status_body(&real) {
                if out.is_empty() {
                    out = format!("[项目进度]\n{body}");
                } else {
                    out.push_str("\n\n[项目进度]\n");
                    out.push_str(&body);
                }
            }
        }
        out
    }

    /// D37：项目进度台账正文（status 条目；不存在 / 非 status / 空正文 → None）。
    pub fn status_body(&self, ws: &Path) -> Option<String> {
        let real = fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf());
        let store = self.project_store(&real).ok()?;
        let slug = knowledge::store::slugify(status::STATUS_TITLE);
        let entry = store.get(&slug).ok()??;
        if entry.mtype != MemoryType::Status {
            return None; // 同名非 status 条目（用户手写同题记忆）不冒充台账
        }
        if entry.body.trim().is_empty() {
            None
        } else {
            Some(entry.body)
        }
    }

    /// D37 会话结束合并进度（W3 唯一写入方；`status_lock` 串行「读-合并-写」）：
    /// - 同名条目非 status 类型 → `Ok(None)` 拒绝覆盖；
    /// - 正文非五段格式 / delta 零新增 → `Ok(None)` 跳过（不空转重写）；
    /// - 写入走 `save_memory_scoped`（同题原地更新 + memory.saved 事件语义）。
    pub fn merge_status(
        &self,
        ws: &Path,
        delta: &status::StatusDelta,
        session: &str,
    ) -> Result<Option<(SaveOutcome, status::StatusMergeStats)>, MemoryError> {
        let real = fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf());
        let _guard = self.status_lock.lock().unwrap_or_else(|p| p.into_inner());
        let store = self.project_store(&real).map_err(MemoryError::Io)?;
        let slug = knowledge::store::slugify(status::STATUS_TITLE);
        let existing = store.get(&slug)?;
        if let Some(e) = &existing {
            if e.mtype != MemoryType::Status {
                return Ok(None); // 同名非 status：拒绝覆盖
            }
        }
        let Some((body, stats)) =
            status::merge_status_body(existing.as_ref().map(|e| e.body.as_str()), delta)
        else {
            return Ok(None); // 正文非台账格式 / 无新内容
        };
        let input = SaveInput {
            title: status::STATUS_TITLE.to_string(),
            body,
            mtype: MemoryType::Status,
            session: session.to_string(),
            links: vec![],
        };
        let outcome = self.save_memory_scoped(Some(&real), &input)?;
        Ok(Some((outcome, stats)))
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

// ---------------------------------------------------------------------------
// D19 作用域分区测试
// ---------------------------------------------------------------------------
#[cfg(test)]
mod scoped_tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bbc-mem-scope-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn engine(tag: &str) -> (TempDir, MemoryEngine) {
        let dir = TempDir::new(tag);
        let eng = MemoryEngine::open(
            &dir.0,
            Arc::new(FixedClock::new("2026-11-10T10:00:00+08:00", "2026-11-10")),
        )
        .unwrap();
        (dir, eng)
    }

    fn input(title: &str, body: &str) -> SaveInput {
        SaveInput {
            title: title.to_string(),
            body: body.to_string(),
            mtype: MemoryType::Project,
            session: "sess-1".to_string(),
            links: vec![],
        }
    }

    /// 分区 key：目录名净化 + 路径哈希；同名不同路径区分、别名归一。
    #[test]
    fn scope_key_sanitizes_and_hashes() {
        // 固定向量锁死算法（sha256 前 16hex，防回退 FNV）：
        // sha256("/tmp/proj-p") = caf7c0822513f18f…
        assert_eq!(
            scope_key(Path::new("/tmp/proj-p")),
            "proj-p-caf7c0822513f18f"
        );
        let a = scope_key(Path::new("/Users/me/code/baobao-chat"));
        let b = scope_key(Path::new("/Users/other/code/baobao-chat"));
        assert!(a.starts_with("baobao-chat-"), "{a}");
        assert_ne!(a, b, "同名不同路径必须不同 key");
        // CJK 目录名保留可读（2026-11-20 放宽：不再退化 project-）
        let cjk = scope_key(Path::new("/Users/me/code/宝贝项目"));
        assert!(cjk.starts_with("宝贝项目-"), "{cjk}");
    }

    /// 作用域写入：项目分区与用户级物理隔离；事件带 scope/workspace_name。
    #[test]
    fn save_scoped_partitions_user_and_project() {
        let (dir, eng) = engine("save");
        let ws = dir.0.join("proj-a");
        fs::create_dir_all(&ws).unwrap();

        let out = eng
            .save_memory_scoped(Some(&ws), &input("端口约定", "服务端口 8090"))
            .unwrap();
        assert_eq!(out.saved.scope, "project");
        assert!(out.saved.workspace_name.is_some());

        eng.save_memory(&input("用户偏好", "回答用中文")).unwrap();

        // 公共层（D23 用户级换制）不含项目条目；项目分区不含用户条目
        let user_titles: Vec<String> = eng
            .list_scoped(None)
            .iter()
            .map(|m| m.title.clone())
            .collect();
        assert_eq!(user_titles.len(), 1, "user 类应落公共层：{user_titles:?}");
        assert!(user_titles[0].contains("用户偏好"), "{user_titles:?}");
        // USER.md 真实落盘
        assert!(dir.0.join("agent/memory/global/USER.md").exists());
        let ws_titles: Vec<String> = eng
            .list_scoped(Some(&ws))
            .iter()
            .map(|m| m.title.clone())
            .collect();
        assert_eq!(ws_titles, ["端口约定"]);
        // 分区目录真实落盘在 memory/projects/<key>/
        let key = out.saved.workspace_name.unwrap();
        assert!(dir
            .0
            .join("agent/memory/projects")
            .join(&key)
            .join("MEMORY.md")
            .exists());
    }

    /// 同项目不同路径别名（realpath 归一）同分区；不同项目互不可见。
    #[test]
    fn project_store_canonicalizes_alias_paths() {
        let (dir, eng) = engine("alias");
        let ws = dir.0.join("proj-x");
        fs::create_dir_all(&ws).unwrap();
        let alias = dir.0.join("./proj-x/./"); // 词法脏路径 → canonicalize 归一
        eng.save_memory_scoped(Some(&alias), &input("构建命令", "make check"))
            .unwrap();
        let titles: Vec<String> = eng
            .list_scoped(Some(&ws))
            .iter()
            .map(|m| m.title.clone())
            .collect();
        assert_eq!(titles, ["构建命令"]);
    }

    /// 作用域召回：项目会话两段（用户+项目），日常仅用户段。
    #[test]
    fn recall_scoped_composes_both_sections() {
        let (dir, eng) = engine("recall");
        let ws = dir.0.join("proj-r");
        fs::create_dir_all(&ws).unwrap();
        eng.save_memory(&input("用户偏好", "回答用中文")).unwrap();
        eng.save_memory_scoped(Some(&ws), &input("端口约定", "8090"))
            .unwrap();

        let daily = eng.recall_scoped(None, "端口");
        assert!(daily.contains("用户偏好"));
        assert!(!daily.contains("端口约定"));

        let proj = eng.recall_scoped(Some(&ws), "端口");
        assert!(proj.contains("[用户记忆]"), "项目会话应含用户段头");
        assert!(proj.contains("[项目记忆·"), "项目会话应含项目段头");
        assert!(proj.contains("端口约定"));
        assert!(proj.contains("用户偏好"));
    }

    /// 作用域删除互不影响另一域。
    #[test]
    fn delete_scoped_is_isolated() {
        let (dir, eng) = engine("del");
        let ws = dir.0.join("proj-d");
        fs::create_dir_all(&ws).unwrap();
        eng.save_memory(&input("同名条目", "用户级内容")).unwrap();
        eng.save_memory_scoped(Some(&ws), &input("同名条目", "项目级内容"))
            .unwrap();

        assert!(eng.delete_scoped(Some(&ws), "同名条目").unwrap());
        assert!(eng.list_scoped(Some(&ws)).is_empty(), "项目分区应已空");
        // 用户级仍在
        assert_eq!(eng.list_scoped(None).len(), 1);
    }

    /// 全量分区清单：目录名即 key。
    #[test]
    fn list_project_partitions_scans_dirs() {
        let (dir, eng) = engine("parts");
        let ws = dir.0.join("proj-p");
        fs::create_dir_all(&ws).unwrap();
        eng.save_memory_scoped(Some(&ws), &input("事实", "v1"))
            .unwrap();
        let parts = eng.list_project_partitions();
        assert_eq!(parts.len(), 1);
        assert!(parts[0].0.starts_with("proj-p-"));
        assert_eq!(parts[0].1.len(), 1);
    }
}
