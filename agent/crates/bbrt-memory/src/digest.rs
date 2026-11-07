//! 日报聚合与回补（被动轨产物层，D15 §3.2）：把当日 journal 确定性聚合为
//! `reports/YYYY-MM-DD.md`（人读）+ `YYYY-MM-DD.json`（UI 消费，camelCase）。
//!
//! - 确定性：聚合只依赖 journal 文件，不依赖 LLM（弱网/离线可用）；
//! - 幂等：同日重跑整文件覆盖；
//! - 触发：session.ended 后重算当日（引擎 `on_session_end`）、启动回补
//!   （`backfill`：journal 有而 reports 缺的日期逐日补生成）、跨日定时器（上层挂）；
//! - 空日（无 journal 文件）不出产物；
//! - 日期由调用方传入（引擎侧注入时钟取 today，便于测试）。

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::journal::{ActivityEvent, FileChangeKind, Journal};
use crate::knowledge::MemoryType;

/// 会话明细行（日报"会话明细"表数据；无 started 的事件按需补行）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    /// 会话 id
    pub session: String,
    /// 工作区（无 session.started 时为 "—"）
    pub workspace: String,
    /// 会话时长（毫秒；未结束为 0）
    pub duration_ms: u64,
    /// 工具执行次数
    pub tools: u64,
    /// 被拦截次数
    pub blocked: u64,
    /// 是否正常结束（收到 session.ended）
    pub ended: bool,
}

/// 委派结果（backend + 退出码；日报"委派"行用）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegateExit {
    /// 委派后端
    pub backend: String,
    /// 子进程退出码
    pub exit_code: i32,
}

/// 单日聚合统计（`.json` 产物与 `report.daily` payload 共用；camelCase 线路名）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStats {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 会话数（session.started 计数）
    pub sessions: usize,
    /// 会话时长合计（毫秒）
    pub total_duration_ms: u64,
    /// 工具调用总数
    pub tool_calls: u64,
    /// 工具名 → 调用次数
    pub tools: BTreeMap<String, u64>,
    /// 被拦截总数
    pub blocked: u64,
    /// 拦截码 → 次数（8020-8026）
    pub blocked_codes: BTreeMap<u16, u64>,
    /// 文件变更总数
    pub files_changed: u64,
    /// 变更种类 → 次数（edit/create/delete）
    pub file_kinds: BTreeMap<String, u64>,
    /// 检查点总数
    pub checkpoints: u64,
    /// 检查点原因 → 次数（pre-edit/manual…）
    pub checkpoint_reasons: BTreeMap<String, u64>,
    /// 委派启动次数
    pub delegates: u64,
    /// 委派后端 → 启动次数
    pub delegate_backends: BTreeMap<String, u64>,
    /// 委派结束记录（backend + exit_code）
    pub delegate_exits: Vec<DelegateExit>,
    /// 今日记忆标题列表（写入顺序）
    pub memory_saved: Vec<String>,
    /// 失败教训条数（feedback 类记忆）
    pub feedback_lessons: u64,
    /// 会话明细（session id → 行）
    pub sessions_detail: BTreeMap<String, SessionRow>,
}

impl DailyStats {
    /// 指定日期的空统计
    pub fn new(date: &str) -> Self {
        Self {
            date: date.to_string(),
            ..Self::default()
        }
    }

    /// 吸收单个事件（聚合核心；pub 供增量场景复用）
    pub fn absorb(&mut self, event: &ActivityEvent) {
        let session = event.session_id().to_string();
        let row = self
            .sessions_detail
            .entry(session)
            .or_insert_with(|| SessionRow {
                session: event.session_id().to_string(),
                ..Default::default()
            });
        match event {
            ActivityEvent::SessionStarted { workspace, .. } => {
                row.workspace = workspace.clone();
                self.sessions += 1;
            }
            ActivityEvent::SessionEnded { duration_ms, .. } => {
                row.ended = true;
                row.duration_ms = *duration_ms;
                self.total_duration_ms += *duration_ms;
            }
            ActivityEvent::ToolExecuted { tool, .. } => {
                *self.tools.entry(tool.clone()).or_insert(0) += 1;
                self.tool_calls += 1;
                row.tools += 1;
            }
            ActivityEvent::ToolBlocked { code, .. } => {
                self.blocked += 1;
                *self.blocked_codes.entry(*code).or_insert(0) += 1;
                row.blocked += 1;
            }
            ActivityEvent::FileChanged { kind, .. } => {
                let kind = match kind {
                    FileChangeKind::Edit => "edit",
                    FileChangeKind::Create => "create",
                    FileChangeKind::Delete => "delete",
                };
                self.files_changed += 1;
                *self.file_kinds.entry(kind.to_string()).or_insert(0) += 1;
            }
            ActivityEvent::CheckpointCreated { reason, .. } => {
                self.checkpoints += 1;
                *self.checkpoint_reasons.entry(reason.clone()).or_insert(0) += 1;
            }
            ActivityEvent::DelegateLaunched { backend, .. } => {
                self.delegates += 1;
                *self.delegate_backends.entry(backend.clone()).or_insert(0) += 1;
            }
            ActivityEvent::DelegateEnded {
                backend, exit_code, ..
            } => {
                self.delegate_exits.push(DelegateExit {
                    backend: backend.clone(),
                    exit_code: *exit_code,
                });
            }
            ActivityEvent::MemorySaved {
                title, memory_type, ..
            } => {
                self.memory_saved.push(title.clone());
                if *memory_type == MemoryType::Feedback {
                    self.feedback_lessons += 1; // 失败教训 = feedback 类记忆
                }
            }
        }
    }
}

/// 日报产物（双文件路径 + 统计）
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 人读 markdown 产物路径
    pub md_path: PathBuf,
    /// UI 消费 JSON 产物路径（camelCase）
    pub json_path: PathBuf,
    /// 当日聚合统计
    pub stats: DailyStats,
}

/// 日报层错误
#[derive(Debug, thiserror::Error)]
pub enum DigestError {
    /// 产物写入失败
    #[error("日报产物写入失败: {0}")]
    Io(#[from] io::Error),
    /// 产物 JSON 序列化失败
    #[error("日报 JSON 序列化失败: {0}")]
    Serde(#[from] serde_json::Error),
}

/// 日报生成器（journal 目录 → reports 目录）
#[derive(Debug, Clone)]
pub struct Digest {
    journal: Journal,
    reports_dir: PathBuf,
}

impl Digest {
    /// 打开（或初始化）；journal 由引擎/调用方持有同一实例的克隆（共享目录）
    pub fn new(journal: Journal, reports_dir: impl Into<PathBuf>) -> io::Result<Self> {
        let reports_dir = reports_dir.into();
        fs::create_dir_all(&reports_dir)?;
        Ok(Self {
            journal,
            reports_dir,
        })
    }

    /// reports 目录
    pub fn dir(&self) -> &Path {
        &self.reports_dir
    }

    fn md_path(&self, date: &str) -> PathBuf {
        self.reports_dir.join(format!("{date}.md"))
    }

    fn json_path(&self, date: &str) -> PathBuf {
        self.reports_dir.join(format!("{date}.json"))
    }

    /// 生成某日日报（幂等：重跑整文件覆盖）。
    /// 空日（无 journal 文件）→ Ok(None) 不出产物。
    pub fn generate(&self, date: &str) -> Result<Option<Report>, DigestError> {
        if !self.journal.path_for(date).exists() {
            return Ok(None);
        }
        let mut stats = DailyStats::new(date);
        // 单日按行流式聚合（内存 O(1)，D15 §3.1）
        self.journal.stream_day(date, |ev| stats.absorb(&ev));
        fs::write(self.md_path(date), render_markdown(&stats))?;
        fs::write(self.json_path(date), serde_json::to_string_pretty(&stats)?)?;
        Ok(Some(Report {
            date: date.to_string(),
            md_path: self.md_path(date),
            json_path: self.json_path(date),
            stats,
        }))
    }

    /// 启动回补（D15 §3.2 触发 2）：journal 有而 reports 缺的日期逐日补生成
    /// （覆盖崩溃漏算；含当日，幂等）。返回本次补出的日报（按日期升序）。
    pub fn backfill(&self, today: &str) -> Result<Vec<Report>, DigestError> {
        let mut out = Vec::new();
        for date in self.journal.dates() {
            if date.as_str() > today {
                continue; // 防御：跳过异常未来日期（ISO 字符串序 = 日期序）
            }
            if self.md_path(&date).exists() && self.json_path(&date).exists() {
                continue; // 双产物齐全 → 不重算（幂等）
            }
            if let Some(report) = self.generate(&date)? {
                out.push(report);
            }
        }
        Ok(out)
    }

    /// 已有日报列表（D15 §3.3 report.list）：扫 reports 目录 *.json 反序列化
    /// 统计，按日期倒序取前 limit（0=默认 30）。单文件损坏跳过不阻塞
    /// （与生成侧降级语义一致）；不含路径信息（列表视角只要统计）。
    pub fn list(&self, limit: usize) -> Vec<DailyStats> {
        let limit = if limit == 0 { 30 } else { limit };
        let rd = match fs::read_dir(&self.reports_dir) {
            Ok(rd) => rd,
            Err(_) => return vec![],
        };
        let mut dates: Vec<String> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
            .filter_map(|p| p.file_stem()?.to_str().map(str::to_string))
            .filter(|d| d.len() == 10 && d.as_bytes().get(4) == Some(&b'-')) // YYYY-MM-DD 形状
            .collect();
        dates.sort();
        dates.dedup();
        dates.reverse(); // 倒序：最新在前
        dates
            .into_iter()
            .take(limit)
            .filter_map(|date| {
                let raw = fs::read_to_string(self.json_path(&date)).ok()?;
                serde_json::from_str::<DailyStats>(&raw).ok()
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// markdown 渲染（D15 §3.2 模板；全部来自当日 journal 聚合）
// ---------------------------------------------------------------------------

/// 工具排行展示上限（超出加 "…"）
const TOP_TOOLS_SHOWN: usize = 5;

/// 毫秒 → 人读时长（2h14m / 5m3s / 42s / 0s）
fn format_duration(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    if h > 0 {
        format!("{h}h{m}m")
    } else if m > 0 {
        format!("{m}m{s}s")
    } else {
        format!("{s}s")
    }
}

/// `k×v` 列表（BTreeMap 键序，确定性输出）
fn map_join(map: &BTreeMap<String, u64>) -> String {
    map.iter()
        .map(|(k, v)| format!("{k}×{v}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 渲染整份日报 markdown
fn render_markdown(s: &DailyStats) -> String {
    let mut md = String::new();
    writeln!(md, "# {} Agent 日报", s.date).unwrap();
    writeln!(md).unwrap();

    // 会话行：数量 + 累计时长 + 工作区去重列表
    let mut workspaces: Vec<&str> = Vec::new();
    for row in s.sessions_detail.values() {
        if !row.workspace.is_empty() && !workspaces.contains(&row.workspace.as_str()) {
            workspaces.push(&row.workspace);
        }
    }
    let ws = if workspaces.is_empty() {
        "—".to_string()
    } else {
        workspaces.join("、")
    };
    writeln!(
        md,
        "- 会话 {} 个（累计 {}）；工作区 {}",
        s.sessions,
        format_duration(s.total_duration_ms),
        ws
    )
    .unwrap();

    // 工具行：总数 + Top-N 排行 + 拦截（码×次数）
    let mut tools: Vec<(&String, &u64)> = s.tools.iter().collect();
    tools.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let mut tool_part = tools
        .iter()
        .take(TOP_TOOLS_SHOWN)
        .map(|(name, n)| format!("{name}×{n}"))
        .collect::<Vec<_>>()
        .join(" ");
    if tools.len() > TOP_TOOLS_SHOWN {
        tool_part.push_str(" …");
    }
    let blocked_part = if s.blocked == 0 {
        "被拦截 0 次".to_string()
    } else {
        format!(
            "被拦截 {} 次（{}）",
            s.blocked,
            map_join_u16(&s.blocked_codes)
        )
    };
    writeln!(
        md,
        "- 工具调用 {} 次：{tool_part}；{blocked_part}",
        s.tool_calls
    )
    .unwrap();

    // 文件行 + 检查点行
    let file_part = if s.files_changed == 0 {
        "文件变更 0".to_string()
    } else {
        format!("文件变更 {}：{}", s.files_changed, map_join(&s.file_kinds))
    };
    let cp_part = if s.checkpoints == 0 {
        "检查点 0".to_string()
    } else {
        format!(
            "检查点 {}（{}）",
            s.checkpoints,
            map_join(&s.checkpoint_reasons)
        )
    };
    writeln!(md, "- {file_part}；{cp_part}").unwrap();

    // 委派行 + 失败教训（feedback 类记忆条数）
    let delegate_part = if s.delegates == 0 {
        "委派 0 次".to_string()
    } else if s.delegate_exits.is_empty() {
        format!(
            "委派 {} 次（{}）",
            s.delegates,
            map_join(&s.delegate_backends)
        )
    } else {
        let exits = s
            .delegate_exits
            .iter()
            .map(|e| format!("{}，exit {}", e.backend, e.exit_code))
            .collect::<Vec<_>>()
            .join("／");
        format!("委派 {} 次（{exits}）", s.delegates)
    };
    writeln!(md, "- {delegate_part}；失败教训 {} 条", s.feedback_lessons).unwrap();

    // 记忆行：当日新增标题（「」包裹，与 journal memory.saved 交叉印证）
    let titles = s
        .memory_saved
        .iter()
        .map(|t| format!("「{t}」"))
        .collect::<String>();
    writeln!(md, "- 今日记忆 +{}：{titles}", s.memory_saved.len()).unwrap();

    // 会话明细表
    writeln!(md).unwrap();
    writeln!(md, "## 会话明细").unwrap();
    writeln!(md).unwrap();
    writeln!(md, "| 会话 | 工作区 | 时长 | 工具 | 结果 |").unwrap();
    writeln!(md, "|---|---|---|---|---|").unwrap();
    for row in s.sessions_detail.values() {
        let workspace = if row.workspace.is_empty() {
            "—"
        } else {
            &row.workspace
        };
        let outcome = if row.ended {
            "正常结束"
        } else {
            "未结束"
        };
        writeln!(
            md,
            "| {} | {workspace} | {} | {} | {outcome} |",
            row.session,
            format_duration(row.duration_ms),
            row.tools
        )
        .unwrap();
    }
    md
}

/// 拦截码（u16 键）`k×v` 列表
fn map_join_u16(map: &BTreeMap<u16, u64>) -> String {
    map.iter()
        .map(|(k, v)| format!("{k}×{v}"))
        .collect::<Vec<_>>()
        .join(" / ")
}

// ---------------------------------------------------------------------------
// 单元测试：时长格式化与渲染骨架
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_format() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(42_000), "42s");
        assert_eq!(format_duration(63_000), "1m3s");
        assert_eq!(format_duration(3_600_000), "1h0m");
        assert_eq!(format_duration(8_040_000), "2h14m"); // D15 §3.2 示例
    }

    #[test]
    fn markdown_header_and_sections() {
        let stats = DailyStats::new("2026-11-06");
        let md = render_markdown(&stats);
        assert!(md.starts_with("# 2026-11-06 Agent 日报\n"));
        assert!(md.contains("- 会话 0 个（累计 0s）；工作区 —"));
        assert!(md.contains("- 工具调用 0 次：；被拦截 0 次"));
        assert!(md.contains("## 会话明细"));
        assert!(md.contains("| 会话 | 工作区 | 时长 | 工具 | 结果 |"));
    }
}
