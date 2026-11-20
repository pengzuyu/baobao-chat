//! 公共层记忆（D23 §3）：`journal.jsonl`（真相）+ `USER.md`（压实视图=缓存）。
//!
//! - 十类硬枚举（§3.1）+硬度轴：禁止/授权=硬（仅显式解除，M2 压实漏斗结构性
//!   保护——硬条目不进 LLM 输入）；目标=时敏（重放时过期即清）；其余软（新盖旧）；
//! - journal 只追加永不删行（remove=tombstone）；**USER.md=journal 纯派生物**，
//!   每次写入重投影——规则渲染 ≤3000 字直写，超限**保留旧视图**（宁旧勿错；
//!   M2 compact.rs 接 bbc-fast 后超限路径改为压缩）；
//! - 写入收敛（D23 §3.6）：W1 工具/W2 启发/W3 提炼/设置页（M3）→ `add()`/`forget()`
//!   两个入口，全进程单写者=本 crate 调用方（MemoryEngine）进程内 Mutex 串行；
//! - 与 D15 被动轨活动日志（`agent/journal/*.jsonl`）是**两个东西**：目录隔离、
//!   语义不同（本文件是记忆写入日志；D23 §3.2 命名注记）。
//!
//! M1 范围：存储/重放/重投影/一次性迁移/更正；压实漏斗（compact.rs）随 M2。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::knowledge::store::find_secret;
use crate::Clock;

pub mod compact;

pub use compact::{compaction_prompt, parse_compacted, Compactor};

/// 视图硬顶（D23 拍板 #3：3000 字）
pub const HARD_LIMIT_CHARS: usize = 3000;
/// 压实常态目标（M2 压实漏斗使用；余量使压实低频）
pub const SOFT_TARGET_CHARS: usize = 2400;
/// 单条上限：一条一事实、一句一线（D23 拍板 #3）
pub const MAX_ENTRY_CHARS: usize = 80;
/// 视图文件（内容名：全是关于用户的事实；D23 拍板 #11）
pub const VIEW_FILE: &str = "USER.md";
/// 写入日志文件（机制名保留；永不注入上下文）
pub const JOURNAL_FILE: &str = "journal.jsonl";

/// 视图头：标注生成物（用户手改不支持，修改走设置页；D23 §3.1）
const VIEW_HEADER: &str = "（USER.md 由记忆系统自动生成——修改请经设置页；真相在 journal.jsonl）\n";

// ---------------------------------------------------------------------------
// 十类（D23 §3.1；wire 值=中文标签，模型直读自释；USER.md 行前缀同值）
// ---------------------------------------------------------------------------

/// 公共层记忆类型（十类硬枚举；serde wire 值=中文标签，模型直读自释）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GlobalType {
    /// 画像：「我是谁」的稳定事实（软）
    #[serde(rename = "画像")]
    Profile,
    /// 偏好：内容与流程的取舍（软）
    #[serde(rename = "偏好")]
    Preference,
    /// 风格：呈现形式（软）
    #[serde(rename = "风格")]
    Style,
    /// 习惯：周期性行为（软）
    #[serde(rename = "习惯")]
    Habit,
    /// 禁止：硬否定约束（**硬**——仅显式解除，压实不可删）
    #[serde(rename = "禁止")]
    Prohibition,
    /// 授权：硬肯定许可（**硬**——与 09 篇 allow.json 工具授权正交）
    #[serde(rename = "授权")]
    Grant,
    /// 人际：对具体他人的协作事实（软）
    #[serde(rename = "人际")]
    Person,
    /// 术语：私有词汇表（软）
    #[serde(rename = "术语")]
    Glossary,
    /// 目标：阶段性方向（**时敏**——文本内日期全过期即清）
    #[serde(rename = "目标")]
    Goal,
    /// 教训：泛化的失败规律（软）
    #[serde(rename = "教训")]
    Lesson,
}

impl GlobalType {
    /// 线路名解析（即中文标签；未知值 None，调用方报错）
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "画像" => Self::Profile,
            "偏好" => Self::Preference,
            "风格" => Self::Style,
            "习惯" => Self::Habit,
            "禁止" => Self::Prohibition,
            "授权" => Self::Grant,
            "人际" => Self::Person,
            "术语" => Self::Glossary,
            "目标" => Self::Goal,
            "教训" => Self::Lesson,
            _ => return None,
        })
    }

    /// USER.md 行前缀/事件展示标签
    pub fn label(&self) -> &'static str {
        match self {
            Self::Profile => "画像",
            Self::Preference => "偏好",
            Self::Style => "风格",
            Self::Habit => "习惯",
            Self::Prohibition => "禁止",
            Self::Grant => "授权",
            Self::Person => "人际",
            Self::Glossary => "术语",
            Self::Goal => "目标",
            Self::Lesson => "教训",
        }
    }

    /// 硬约束（禁止/授权）：更正仅经 forget 显式解除（D23 拍板 #8）
    pub fn is_hard(&self) -> bool {
        matches!(self, Self::Prohibition | Self::Grant)
    }
}

// ---------------------------------------------------------------------------
// journal op 与重放条目
// ---------------------------------------------------------------------------

/// journal 一行 op（内部格式；provenance 只在此层，D23 拍板 #6）
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GlobalOp {
    /// "add" | "remove" | "snapshot"
    pub op: String,
    /// 条目类型（snapshot 不消费此字段，序列化为占位默认值）
    #[serde(rename = "type", default)]
    pub gtype: GlobalType,
    /// add=条目文本；remove=contains 匹配串（条目粒度，防同名误伤）
    pub text: String,
    /// snapshot 专有：压实后的全量有效条目（其余 op 恒空）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<GlobalEntry>,
    /// 写入时刻（RFC3339）
    pub ts: String,
    /// 来源会话（审计用；压实快照记 "compactor"）
    pub session: String,
}

/// 重放后的在册条目
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GlobalEntry {
    /// 类型
    pub gtype: GlobalType,
    /// 一句话内容（≤80 字）
    pub text: String,
}

impl Default for GlobalType {
    /// serde default（snapshot op 的 gtype 占位）
    fn default() -> Self {
        Self::Profile
    }
}

/// 公共层错误（D15 §4 脱敏拒写同口径）
#[derive(Debug, thiserror::Error)]
pub enum GlobalError {
    /// 条目规范化后为空
    #[error("公共记忆条目为空")]
    EmptyText,
    /// 单条超 80 字
    #[error("公共记忆单条超限：{actual} 字 > 上限 {max} 字（一条一事实，凝练到一句）")]
    EntryTooLong { actual: usize, max: usize },
    /// 命中密钥特征拒写
    #[error("内容命中密钥特征，拒写：{0}（D15 §4 脱敏约束）")]
    Sensitive(&'static str),
    /// 文件 IO
    #[error("IO 错误: {0}")]
    Io(#[from] io::Error),
}

/// add() 结果：同题命中与否 + 视图预算余量（负值=待压实）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AddOutcome {
    /// true=同 type+归一文本已存在（更新语义）
    pub updated: bool,
    /// 硬顶 − 当前视图字数（可为负：超限待 M2 压实）
    pub budget_left: isize,
}

// ---------------------------------------------------------------------------
// GlobalStore
// ---------------------------------------------------------------------------

/// 公共层存储（`{dataDir}/agent/memory/global/`）。
/// 所有公开方法内部持锁串行——配合"bbrt 唯一碰目录的进程"构成单写者
/// （D23 拍板 #7）。Clone 手工实现（Mutex 不 Clone；克隆=新锁，目录语义不变）。
pub struct GlobalStore {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
    lock: Mutex<()>,
    /// 压实器（M2；None=超限保留旧视图——测试/降级态）
    compactor: Mutex<Option<Arc<dyn Compactor>>>,
}

impl Clone for GlobalStore {
    fn clone(&self) -> Self {
        Self {
            dir: self.dir.clone(),
            clock: Arc::clone(&self.clock),
            lock: Mutex::new(()),
            compactor: Mutex::new(
                self.compactor
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone(),
            ),
        }
    }
}

impl std::fmt::Debug for GlobalStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GlobalStore")
            .field("dir", &self.dir)
            .finish()
    }
}

impl GlobalStore {
    /// 打开（或初始化）公共层目录
    pub fn new(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            clock,
            lock: Mutex::new(()),
            compactor: Mutex::new(None),
        })
    }

    /// 装配压实器（bbrt main 接 bbc-fast；见 bbrt_session::FastCompactor）
    pub fn set_compactor(&self, c: Option<Arc<dyn Compactor>>) {
        *self.compactor.lock().unwrap_or_else(|p| p.into_inner()) = c;
    }

    /// 存储目录
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// journal 路径（迁移幂等判据：存在即已迁移过）
    pub fn journal_path(&self) -> PathBuf {
        self.dir.join(JOURNAL_FILE)
    }

    /// 视图路径
    pub fn view_path(&self) -> PathBuf {
        self.dir.join(VIEW_FILE)
    }

    /// 追加一行 op（调用方持锁）
    fn append_op(&self, op: &GlobalOp) -> io::Result<()> {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.journal_path())?;
        let mut line = serde_json::to_string(op).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("GlobalOp 序列化失败: {e}"),
            )
        })?;
        line.push('\n');
        f.write_all(line.as_bytes())
    }

    /// 重放 journal → 在册条目（D23 §3.3 规则层，全部确定性零 LLM）：
    /// ① snapshot：以其条目集**整体替换**此前全部状态（压实结果的持久化——
    ///    journal 仍只追加，永不删行；增长随每次压实收敛）；
    /// ② 应用 remove tombstone（remove 只影响其前的 add——forget 后重写同款=合法回加）；
    /// ③ 去重：同 type+归一文本 → 保最后（软类"新盖旧"的落地）；
    /// ④ 目标类过期剔除（文本内日期全部早于今天）。
    /// 坏行容忍：跳过不计数失败（与 D15 §2.1 目录扫描同语义）。
    pub fn replay(&self) -> Vec<GlobalEntry> {
        let mut entries: Vec<GlobalEntry> = Vec::new();
        let Ok(content) = fs::read_to_string(self.journal_path()) else {
            return entries;
        };
        for line in content.lines() {
            let Ok(op) = serde_json::from_str::<GlobalOp>(line) else {
                continue;
            };
            match op.op.as_str() {
                "add" => entries.push(GlobalEntry {
                    gtype: op.gtype,
                    text: op.text,
                }),
                "remove" => entries.retain(|e| !(e.gtype == op.gtype && e.text.contains(&op.text))),
                "snapshot" => entries = op.entries,
                _ => {}
            }
        }
        // 去重：保最后出现
        let mut dedup: Vec<GlobalEntry> = Vec::new();
        for e in entries {
            let key = (e.gtype, normalize_text(&e.text));
            match dedup
                .iter()
                .position(|d| (d.gtype, normalize_text(&d.text)) == key)
            {
                Some(i) => dedup[i] = e,
                None => dedup.push(e),
            }
        }
        // 目标过期
        let today = self.clock.today();
        dedup
            .into_iter()
            .filter(|e| e.gtype != GlobalType::Goal || !goal_expired(&e.text, &today))
            .collect()
    }

    /// 条目集 → USER.md 内容（视图=纯渲染，无元数据；D23 拍板 #6）
    pub fn render(entries: &[GlobalEntry]) -> String {
        let mut s = String::from(VIEW_HEADER);
        for e in entries {
            s.push('[');
            s.push_str(e.gtype.label());
            s.push_str("] ");
            s.push_str(&e.text);
            s.push('\n');
        }
        s
    }

    /// 重投影（每次写入/启动 reconcile 调用；调用方持锁；D23 §3.3 压实漏斗）：
    /// 1. 规则渲染 ≤3000 字 → temp+rename 原子写（常规路径，零 LLM）；
    /// 2. 超限 → 压实：硬条目（禁止/授权）程序保留**不进 LLM 输入**，
    ///    仅软条目交压实器（目标 ≤2400−硬占字）；输出校验（条目合法/非空/
    ///    总渲染 ≤3000）不过则保留旧视图（宁旧勿错）；通过则 journal 追加
    ///    **snapshot op** 持久化压实结果再写视图；
    /// 3. 无压实器/压实失败 → 保留旧视图，journal 无损，下次再试。
    fn reproject(&self) -> io::Result<()> {
        let entries = self.replay();
        let content = Self::render(&entries);
        if content.chars().count() <= HARD_LIMIT_CHARS {
            return atomic_write(&self.view_path(), &content);
        }
        let compactor = self
            .compactor
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let Some(compactor) = compactor else {
            return Ok(()); // 无压实器：宁旧勿错
        };
        let hard: Vec<GlobalEntry> = entries
            .iter()
            .filter(|e| e.gtype.is_hard())
            .cloned()
            .collect();
        let soft: Vec<GlobalEntry> = entries
            .iter()
            .filter(|e| !e.gtype.is_hard())
            .cloned()
            .collect();
        let budget = SOFT_TARGET_CHARS.saturating_sub(Self::render(&hard).chars().count());
        let compacted = match compactor.compact(&soft, budget) {
            Ok(c) => c,
            Err(_) => return Ok(()), // 压实失败：保留旧视图
        };
        // 校验：空输出（软条目非空时）=压丢一切，按失败处理；单条限长
        if compacted.is_empty() && !soft.is_empty() {
            return Ok(());
        }
        if compacted
            .iter()
            .any(|e| e.text.trim().is_empty() || e.text.chars().count() > MAX_ENTRY_CHARS)
        {
            return Ok(());
        }
        let mut merged = hard;
        merged.extend(compacted);
        let content = Self::render(&merged);
        if content.chars().count() > HARD_LIMIT_CHARS {
            return Ok(()); // 压缩不达标：保留旧视图
        }
        // snapshot 持久化压实结果（journal 只追加；replay 以其整体替换历史）
        self.append_op(&GlobalOp {
            op: "snapshot".to_string(),
            gtype: GlobalType::Profile, // 占位：snapshot 不消费
            text: String::new(),
            entries: merged,
            ts: self.clock.now_rfc3339(),
            session: "compactor".to_string(),
        })?;
        atomic_write(&self.view_path(), &content)
    }

    /// 启动 reconcile（D23 §3.4）：确定性重建覆盖一切漂移（视图被删/半写/
    /// 崩溃残留）。超限保留现视图（最近一次成功压实/渲染产物，启动不跑 LLM）。
    pub fn reconcile(&self) -> io::Result<()> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        self.reproject()
    }

    /// 写入一条（全部写入路径的统一入口）。
    /// 校验：非空、≤80 字、脱敏双检（D15 §4 同口径）。
    pub fn add(
        &self,
        gtype: GlobalType,
        text: &str,
        session: &str,
    ) -> Result<AddOutcome, GlobalError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(GlobalError::EmptyText);
        }
        let count = text.chars().count();
        if count > MAX_ENTRY_CHARS {
            return Err(GlobalError::EntryTooLong {
                actual: count,
                max: MAX_ENTRY_CHARS,
            });
        }
        if let Some(what) = find_secret(text) {
            return Err(GlobalError::Sensitive(what));
        }
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        // 同题判定（先于追加）：同 type+归一文本存在 → updated 语义
        let updated = self
            .replay()
            .iter()
            .any(|e| e.gtype == gtype && normalize_text(&e.text) == normalize_text(text));
        self.append_op(&GlobalOp {
            op: "add".to_string(),
            gtype,
            text: text.to_string(),
            entries: Vec::new(),
            ts: self.clock.now_rfc3339(),
            session: session.to_string(),
        })?;
        self.reproject()?;
        let budget_left = HARD_LIMIT_CHARS as isize
            - fs::read_to_string(self.view_path())
                .map(|v| v.chars().count() as isize)
                .unwrap_or(0);
        Ok(AddOutcome {
            updated,
            budget_left,
        })
    }

    /// 显式解除/更正第一步（D23 §3.5）：tombstone 匹配条目并重投影。
    /// 匹配=同 type 且 text.contains(contains)——条目粒度防同名误伤；
    /// 返回被移除条目文本（0/1/N 三态回显给调用方）。
    pub fn forget(
        &self,
        gtype: GlobalType,
        contains: &str,
        session: &str,
    ) -> Result<Vec<String>, GlobalError> {
        let contains = contains.trim();
        if contains.is_empty() {
            return Err(GlobalError::EmptyText);
        }
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let removed: Vec<String> = self
            .replay()
            .into_iter()
            .filter(|e| e.gtype == gtype && e.text.contains(contains))
            .map(|e| e.text)
            .collect();
        if !removed.is_empty() {
            self.append_op(&GlobalOp {
                op: "remove".to_string(),
                gtype,
                text: contains.to_string(),
                entries: Vec::new(),
                ts: self.clock.now_rfc3339(),
                session: session.to_string(),
            })?;
            self.reproject()?;
        }
        Ok(removed)
    }

    /// USER.md 全文（召回注入与记忆页数据源；无视图=空串）
    pub fn view(&self) -> String {
        fs::read_to_string(self.view_path()).unwrap_or_default()
    }

    /// 在册条目数（记忆页/测试用）
    pub fn len(&self) -> usize {
        self.replay().len()
    }

    /// 是否零条目
    pub fn is_empty(&self) -> bool {
        self.replay().is_empty()
    }

    /// 视图预算余量（硬顶 − 当前视图字数；负=超限待压实）
    pub fn budget_left(&self) -> isize {
        HARD_LIMIT_CHARS as isize - self.view().chars().count() as isize
    }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/// 归一文本（去空白+小写）：去重/同题判定键（D37 起 status.rs 台账去重共用）
pub(crate) fn normalize_text(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// title(+正文首行) → 单条文本：`标题：钩子`，截 80 字（W1/W2/W3 共用）
pub fn global_line(title: &str, body: &str) -> String {
    let title = title.trim();
    let hook = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let text = if hook.is_empty() || hook == title {
        title.to_string()
    } else {
        format!("{title}：{hook}")
    };
    text.chars().take(MAX_ENTRY_CHARS).collect()
}

/// 目标类过期判定：文本内全部 `YYYY-MM-DD` 日期早于今天 → 过期
/// （无日期=不过期；D23 §3.3 规则层③）
fn goal_expired(text: &str, today: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut dates: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 10 <= chars.len() {
        let w: String = chars[i..i + 10].iter().collect();
        if is_date(&w) {
            dates.push(w);
            i += 10;
        } else {
            i += 1;
        }
    }
    !dates.is_empty() && dates.iter().all(|d| d.as_str() < today)
}

/// `YYYY-MM-DD` 且月 01-12、日 01-31
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && ("01"..="12").contains(&&s[5..7])
        && ("01"..="31").contains(&&s[8..10])
}

/// temp+rename 原子写（与 knowledge/store.rs write_entry 同语义）
fn atomic_write(path: &Path, content: &str) -> io::Result<()> {
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)
}

// ---------------------------------------------------------------------------
// 一次性迁移（D23 §2）：既有用户级 slug 文件族 → journal 灌入 → archive/ 归档
// ---------------------------------------------------------------------------

/// 迁移幂等判据=journal 已存在。类型映射（§3.1）：user→画像、feedback→教训、
/// reference→术语；**project 不迁 global**（随 archive 归档——按 D19 本应落项目
/// 分区，历史误落用户级者不污染公共层预算）。返回灌入条数。
pub fn migrate_legacy_user_store(
    memory_root: &Path,
    store: &GlobalStore,
    clock: &Arc<dyn Clock>,
) -> io::Result<usize> {
    if store.journal_path().exists() {
        return Ok(0); // 已迁移（或已有新写入）
    }
    let (entries, _) = crate::knowledge::scan_entries(memory_root);
    if entries.is_empty() {
        return Ok(0); // 干净安装：不建 journal，首次 add 时自然创建
    }
    let archive = memory_root.join("archive");
    fs::create_dir_all(&archive)?;
    let _g = store.lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut migrated = 0usize;
    for e in entries {
        let src = memory_root.join(format!("{}.md", e.name));
        let dst = archive.join(format!("{}.md", e.name));
        let gtype = match e.mtype {
            crate::knowledge::MemoryType::User => Some(GlobalType::Profile),
            crate::knowledge::MemoryType::Feedback => Some(GlobalType::Lesson),
            crate::knowledge::MemoryType::Reference => Some(GlobalType::Glossary),
            // 归档不灌 journal（status 为 D37 新类型，legacy 文件族不可能出现——防御分支）
            crate::knowledge::MemoryType::Project | crate::knowledge::MemoryType::Status => None,
        };
        if let Some(gtype) = gtype {
            let text = global_line(&e.title, &e.body);
            if !text.is_empty() && find_secret(&text).is_none() {
                store
                    .append_op(&GlobalOp {
                        op: "add".to_string(),
                        gtype,
                        text,
                        entries: Vec::new(),
                        ts: e.updated_at.clone(),
                        session: e.session.clone(),
                    })
                    .ok(); // 单条失败不阻断迁移（归档文件保留原内容可人工恢复）
            }
        }
        fs::rename(&src, &dst).ok();
        migrated += 1;
    }
    // 旧索引一并归档；journal 落盘即迁移完成标记
    let old_index = memory_root.join(crate::knowledge::store::INDEX_FILE);
    if old_index.exists() {
        fs::rename(
            &old_index,
            archive.join(crate::knowledge::store::INDEX_FILE),
        )
        .ok();
    }
    let _ = clock; // ts 取条目自身 updated_at（保真），时钟仅备未来扩展
    store.reproject()?;
    Ok(migrated)
}

// ---------------------------------------------------------------------------
// 单元测试（纯函数；存储层集成测试见 tests/global.rs）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_type_parse_roundtrip() {
        for t in [
            GlobalType::Profile,
            GlobalType::Preference,
            GlobalType::Style,
            GlobalType::Habit,
            GlobalType::Prohibition,
            GlobalType::Grant,
            GlobalType::Person,
            GlobalType::Glossary,
            GlobalType::Goal,
            GlobalType::Lesson,
        ] {
            assert_eq!(GlobalType::parse(t.label()), Some(t));
            assert_eq!(
                serde_json::to_string(&t).unwrap(),
                format!("\"{}\"", t.label())
            );
        }
        assert_eq!(
            GlobalType::parse("user"),
            None,
            "user 走 MemoryType 兼容路径"
        );
        assert!(GlobalType::Prohibition.is_hard());
        assert!(GlobalType::Grant.is_hard());
        assert!(!GlobalType::Preference.is_hard());
    }

    #[test]
    fn global_line_joins_and_truncates() {
        assert_eq!(
            global_line("端口约定", "服务固定 8090。"),
            "端口约定：服务固定 8090。"
        );
        assert_eq!(global_line("偏好", ""), "偏好");
        assert_eq!(global_line("偏好", "偏好"), "偏好"); // 钩子与标题相同不拼接
        let long = global_line("长标题", &"忆".repeat(200));
        assert!(long.chars().count() <= MAX_ENTRY_CHARS);
    }

    #[test]
    fn goal_expiry_by_dates() {
        let today = "2026-11-12";
        assert!(goal_expired("11 月底发 v0.1（2026-11-01 前）", today));
        assert!(!goal_expired("11 月底发 v0.1（2026-11-30 前）", today));
        assert!(!goal_expired("11 月底发 v0.1", today), "无日期不过期");
        assert!(
            !goal_expired("里程碑 2026-01-01 与 2026-12-31", today),
            "任一未到期即不过期"
        );
        assert!(is_date("2026-11-12"));
        assert!(!is_date("2026-13-01"));
        assert!(!is_date("20261112"));
    }

    #[test]
    fn normalize_text_collapses_whitespace_and_case() {
        assert_eq!(
            normalize_text("先 方案\n后落笔"),
            normalize_text("先方案后落笔")
        );
        assert_eq!(normalize_text("Go=Rust"), normalize_text("go=rust"));
    }
}
