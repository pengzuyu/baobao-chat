//! 知识记忆（主动轨，D15 §2）：ZCode 式"一文件一事实 + `MEMORY.md` 索引"。
//!
//! - 业务面在本文件（`KnowledgeStore` 的 save/list/delete/recall）；
//!   文件层细节（frontmatter、slug、脱敏、索引重写、LRU）在 `store.rs`。
//! - 写入路径：W1 模型工具 → `save()`；W2 规则触发 → `heuristic.rs`（免模型兜底）；
//!   W3 会话结束提炼 → 阶段二（依赖 aigw 压缩摘要）。
//! - 写入规则"同题更新不重复"：slug 相等或 title 完全相等 → 原地更新
//!   （保留 `created_at`、更新 `updated_at`），否则新增（D15 §2.2）。
//! - 召回注入：`recall()` 返回 `MEMORY.md` 全文（≤200 行，超限截断+标注），
//!   由 D11 assemble() 的"项目上下文"区块拼接；记忆属 trusted 内容。

pub mod heuristic;
pub mod store;

pub use heuristic::{detect_memory_hint, ErrorTracker, Heuristic, LessonCandidate};
pub use store::{
    rebuild_index, scan_entries, IndexOutcome, MemoryEntry, MemoryError, MemoryType, SaveInput,
    MAX_BODY_BYTES, MAX_ENTRIES,
};

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::Clock;
use store::{find_secret, normalize_title, slugify, INDEX_FILE};

/// 召回注入的行数上限（D15 §2.3：≤200 行，超限截断+提示）
pub const RECALL_MAX_LINES: usize = 200;
/// 条目数不超过该值时全量注入（v0.1 行为，D15 §2.3"条数少时成本可忽略"）
pub const RECALL_FULL_ENTRIES: usize = 50;
/// 精排注入条数上限（D15 §2.3 Top-K 关键词档；向量档待服务端真 embedding）
pub const RECALL_TOP_K: usize = 50;

/// 记忆列表项（`memory.list` REQ 应答 items 的单条：name/title/type/updated_at/hook）
#[derive(Debug, Clone, PartialEq)]
pub struct MemorySummary {
    /// slug（文件名主干）
    pub name: String,
    /// 标题
    pub title: String,
    /// 记忆类型
    pub mtype: MemoryType,
    /// 最近更新时刻
    pub updated_at: String,
    /// 钩子摘要（正文首行）
    pub hook: String,
}

/// save() 结果：最终 slug/标题、是否同题更新、被 LRU 淘汰的 name 列表
#[derive(Debug, Clone, PartialEq)]
pub struct SaveResult {
    /// 最终 slug（可能因标题规范化与输入不同）
    pub name: String,
    /// 规范化后的标题（截 40 字）
    pub title: String,
    /// true = 命中既有条目原地更新；false = 新增
    pub updated: bool,
    /// 容量淘汰（reason=capacity）的受害者 name，按淘汰序
    pub evicted: Vec<String>,
}

/// 知识记忆存储（目录 = `{dataDir}/agent/memory`）
#[derive(Clone)]
pub struct KnowledgeStore {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for KnowledgeStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 时钟为 trait 对象不可 Debug，只展示目录
        f.debug_struct("KnowledgeStore")
            .field("dir", &self.dir)
            .finish()
    }
}

impl KnowledgeStore {
    /// 打开（或初始化）记忆目录；时间戳取自注入时钟
    pub fn new(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir, clock })
    }

    /// 记忆目录（测试/上层定位用）
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn entry_path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.md"))
    }

    /// 记忆名合法性：非空、无路径分隔符、不撞索引文件名
    fn validate_name(name: &str) -> Result<(), MemoryError> {
        if name.is_empty() || name.contains('/') || name.contains('\\') || name == INDEX_FILE {
            Err(MemoryError::InvalidName(name.to_string()))
        } else {
            Ok(())
        }
    }

    /// W1 写入（D15 §2.2 同题更新规则 + §2.1 容量/脱敏约束）：
    /// 1. 标题规范化、正文 ≤4KB、标题与正文过密钥特征扫描（命中拒写）；
    /// 2. slug 相等或 title 完全相等 → 原地更新（保留 created_at）；
    /// 3. 超过 200 条按 updated_at 最旧 LRU 淘汰（不淘汰本次刚写的条目）；
    /// 4. 先写条目文件（tmp+rename），再整写 `MEMORY.md` 索引。
    pub fn save(&self, input: &SaveInput) -> Result<SaveResult, MemoryError> {
        let title = normalize_title(&input.title).ok_or(MemoryError::EmptyTitle)?;
        if input.body.len() > MAX_BODY_BYTES {
            // String::len 即 UTF-8 字节数（4KB 上限按字节计）
            return Err(MemoryError::BodyTooLarge {
                actual: input.body.len(),
                max: MAX_BODY_BYTES,
            });
        }
        // 脱敏双检：标题与正文都不得携带密钥特征（D15 §4）
        if let Some(what) = find_secret(&title).or_else(|| find_secret(&input.body)) {
            return Err(MemoryError::SensitiveContent(what));
        }
        let name = slugify(&title);
        let now = self.clock.now_rfc3339();

        let (mut entries, _) = store::scan_entries(&self.dir);
        // 同题更新：slug 相等或 title 完全相等（D15 §2.2）
        let existing = entries
            .iter()
            .position(|e| e.name == name || e.title == title);
        let created_at = match existing {
            Some(i) => entries[i].created_at.clone(), // 保留首次创建时刻
            None => now.clone(),
        };
        let entry = MemoryEntry {
            name: name.clone(),
            title: title.clone(),
            mtype: input.mtype,
            created_at,
            updated_at: now,
            session: input.session.clone(),
            links: input.links.clone(),
            body: input.body.clone(),
        };
        store::write_entry(&self.dir, &entry)?; // 先写条目
        let updated = existing.is_some();
        match existing {
            Some(i) => entries[i] = entry,
            None => entries.push(entry),
        }

        // LRU：按 updated_at 升序（最旧在前）淘汰至 ≤200 条
        let mut evicted = Vec::new();
        if entries.len() > MAX_ENTRIES {
            entries.sort_by(|a, b| {
                a.updated_at
                    .cmp(&b.updated_at)
                    .then_with(|| a.name.cmp(&b.name))
            });
            while entries.len() > MAX_ENTRIES {
                let idx = entries
                    .iter()
                    .position(|e| e.name != name) // 刚写入的条目不淘汰
                    .expect("超限必有非本次条目");
                let victim = entries.remove(idx);
                fs::remove_file(self.entry_path(&victim.name))?;
                evicted.push(victim.name);
            }
        }
        store::sort_for_display(&mut entries);
        store::write_index(&self.dir, &entries)?; // 再重写索引
        Ok(SaveResult {
            name,
            title,
            updated,
            evicted,
        })
    }

    /// 全量列表（updated_at 新→旧）；目录缺失/坏文件按容错处理不计失败
    pub fn list(&self) -> Vec<MemorySummary> {
        store::scan_entries(&self.dir)
            .0
            .into_iter()
            .map(|e| {
                let hook = store::hook_of(&e);
                MemorySummary {
                    name: e.name,
                    title: e.title,
                    mtype: e.mtype,
                    updated_at: e.updated_at,
                    hook,
                }
            })
            .collect()
    }

    /// 按名取单条；文件缺失或坏文件 → None
    pub fn get(&self, name: &str) -> Result<Option<MemoryEntry>, MemoryError> {
        Self::validate_name(name)?;
        let path = self.entry_path(name);
        if !path.exists() {
            return Ok(None);
        }
        Ok(fs::read_to_string(path)
            .ok()
            .and_then(|src| MemoryEntry::parse(&src).ok()))
    }

    /// 按名删除（仅 UI `memory.delete` 走此路径，无 TTL 自动删）；
    /// 删除后整写索引。返回是否存在并删除。
    pub fn delete(&self, name: &str) -> Result<bool, MemoryError> {
        Self::validate_name(name)?;
        let path = self.entry_path(name);
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(&path)?;
        let (entries, _) = store::scan_entries(&self.dir);
        store::write_index(&self.dir, &entries)?;
        Ok(true)
    }

    /// 召回注入文本（D15 §2.3）：`MEMORY.md` 全文；
    /// 超过 200 行截断并追加标注行（提示模型存在未展示条目）。
    pub fn recall(&self) -> Result<String, MemoryError> {
        let path = self.dir.join(INDEX_FILE);
        if !path.exists() {
            return Ok(String::new()); // 无记忆/无索引 → 注入空串
        }
        let content = fs::read_to_string(path)?;
        let lines: Vec<&str> = content.lines().collect();
        if lines.len() <= RECALL_MAX_LINES {
            return Ok(content);
        }
        let mut truncated: String = lines[..RECALL_MAX_LINES].join("\n");
        truncated.push('\n');
        truncated.push_str(&format!(
            "…（记忆索引超过 {RECALL_MAX_LINES} 行已截断，原 {total} 行，全量见 memory/{INDEX_FILE}）",
            total = lines.len()
        ));
        Ok(truncated)
    }

    /// 按当前用户消息精排的召回注入（D15 §2.3 Top-K 关键词档）：
    /// - 条目 ≤ `RECALL_FULL_ENTRIES` → 全量（退回 `recall()`，条数少时成本可忽略）；
    /// - 否则按 query 关键词对条目评分（命中 title ×3、钩子行 ×1），
    ///   有命中按分降序取前 `RECALL_TOP_K` 条；全零分退化为展示序
    ///   （updated_at 新→旧）取前 K——保证注入面非空且偏新；
    /// - 输出与 `MEMORY.md` 相同的索引行格式 + 尾注（提示模型为筛选结果）。
    pub fn recall_for(&self, query: &str) -> Result<String, MemoryError> {
        let (entries, _) = store::scan_entries(&self.dir);
        if entries.len() <= RECALL_FULL_ENTRIES {
            return self.recall();
        }
        let terms = extract_terms(query);
        let mut scored: Vec<(usize, &MemoryEntry)> = entries
            .iter()
            .map(|e| {
                let title = e.title.to_lowercase();
                let hook = store::hook_of(e).to_lowercase();
                let mut score = 0usize;
                for t in &terms {
                    if title.contains(t.as_str()) {
                        score += 3; // 标题命中权重高（更强的相关性信号）
                    }
                    if hook.contains(t.as_str()) {
                        score += 1;
                    }
                }
                (score, e)
            })
            .collect();
        if scored.iter().any(|(s, _)| *s > 0) {
            // 分同的按展示序稳定化（updated_at 新→旧、name 升序）
            scored.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| b.1.updated_at.cmp(&a.1.updated_at))
                    .then_with(|| a.1.name.cmp(&b.1.name))
            });
        } // 全零分：保持 scan 的展示序（新→旧），偏新兜底
        let mut out = String::new();
        for (_, e) in scored.iter().take(RECALL_TOP_K) {
            out.push_str(&store::index_line(e));
            out.push('\n');
        }
        out.push_str(&format!(
            "…（共 {total} 条记忆，按与当前消息的相关度注入前 {top} 条，全量见 memory/{INDEX_FILE}）\n",
            total = entries.len(),
            top = RECALL_TOP_K
        ));
        Ok(out)
    }

    /// 从目录扫描重建 `MEMORY.md`（崩溃恢复入口；索引非权威，D15 §2.1）
    pub fn rebuild_index(&self) -> Result<IndexOutcome, io::Error> {
        store::rebuild_index(&self.dir)
    }
}

// ---------------------------------------------------------------------------
// 查询分词（recall_for 评分用；与 aigw mock 嵌入同思路但不依赖该 crate）
// ---------------------------------------------------------------------------

/// query → 检索词集：CJK 连续段切 2-gram（单字段保留单字）、ASCII 连续
/// 字母数字段取整词（≥2 字符，小写化）。不引分词库，确定性输出。
fn extract_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut ascii_run = String::new();
    let mut cjk_run: Vec<char> = Vec::new();
    let flush_ascii = |run: &mut String, out: &mut Vec<String>| {
        if run.chars().count() >= 2 {
            out.push(run.to_lowercase());
        }
        run.clear();
    };
    for ch in query.chars() {
        if ch.is_ascii_alphanumeric() {
            if !cjk_run.is_empty() {
                push_cjk_terms(&cjk_run, &mut terms);
                cjk_run.clear();
            }
            ascii_run.push(ch);
        } else {
            flush_ascii(&mut ascii_run, &mut terms);
            if is_cjk(ch) {
                cjk_run.push(ch);
            } else if !cjk_run.is_empty() {
                push_cjk_terms(&cjk_run, &mut terms);
                cjk_run.clear();
            }
        }
    }
    flush_ascii(&mut ascii_run, &mut terms);
    push_cjk_terms(&cjk_run, &mut terms);
    terms
}

/// CJK 连续段 → 2-gram 词集（单字段输出该字本身）
fn push_cjk_terms(run: &[char], out: &mut Vec<String>) {
    if run.is_empty() {
        return;
    }
    if run.len() == 1 {
        out.push(run.iter().collect());
    } else {
        for w in run.windows(2) {
            out.push(w.iter().collect());
        }
    }
}

/// CJK 统一表意文字（含扩展 A）；不含标点/符号（它们不构成词）
fn is_cjk(ch: char) -> bool {
    let c = ch as u32;
    (0x3400..=0x4DBF).contains(&c) || (0x4E00..=0x9FFF).contains(&c)
}

// ---------------------------------------------------------------------------
// 单元测试：索引行格式与钩子推导
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::store::{hook_of, index_line, MemoryEntry, MemoryType};

    #[test]
    fn index_line_uses_hook_from_body_first_line() {
        let e = MemoryEntry {
            name: "gitee-远端".to_string(),
            title: "Gitee 远端".to_string(),
            mtype: MemoryType::Project,
            created_at: "2026-11-06T10:00:00+08:00".to_string(),
            updated_at: "2026-11-06T10:00:00+08:00".to_string(),
            session: "s".to_string(),
            links: vec![],
            body: "远端用 gitee 而非 github\n第二行".to_string(),
        };
        assert_eq!(
            index_line(&e),
            "- [Gitee 远端](gitee-远端.md) — 远端用 gitee 而非 github"
        );
    }

    #[test]
    fn hook_falls_back_to_title_when_body_blank() {
        let mut e = MemoryEntry {
            name: "n".to_string(),
            title: "标题兜底".to_string(),
            mtype: MemoryType::User,
            created_at: "c".to_string(),
            updated_at: "u".to_string(),
            session: "s".to_string(),
            links: vec![],
            body: "\n  \n".to_string(),
        };
        assert_eq!(hook_of(&e), "标题兜底");
        e.body = String::new();
        assert_eq!(hook_of(&e), "标题兜底");
    }
}
