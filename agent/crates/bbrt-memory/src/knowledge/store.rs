//! 知识记忆文件存储（D15 §2.1）：frontmatter + 正文一文件一事实，
//! `MEMORY.md` 一行一记忆索引（ZCode 式）。
//!
//! 本文件只管"文件层"：frontmatter 手写解析/序列化（仅 `key: value` 与
//! `key: [a, b]` 行，不引 yaml 库）、slug 化、脱敏特征扫描、目录扫描、
//! 索引重写与 LRU 淘汰候选；save/list/delete/recall 的业务语义在
//! `mod.rs` 的 `KnowledgeStore`。

use std::fs;
use std::path::Path;

// ---------------------------------------------------------------------------
// 硬性约束常量（D15 §2.1）
// ---------------------------------------------------------------------------

/// 单条正文上限 4KB
pub const MAX_BODY_BYTES: usize = 4 * 1024;
/// 总条数上限 200，超限按 `updated_at` 最旧淘汰（LRU）
pub const MAX_ENTRIES: usize = 200;
/// 标题上限（一句话 ≤40 字）
pub const MAX_TITLE_CHARS: usize = 40;
/// 索引文件名（启动注入 / 重建目标）；索引可从目录重建，故非权威
pub const INDEX_FILE: &str = "MEMORY.md";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/// 记忆类型（frontmatter `type` 字段）：用户偏好 / 项目事实 / 工作方式反馈 / 外部指针
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryType {
    /// 用户偏好（user）
    User,
    /// 项目事实（project）
    Project,
    /// 工作方式反馈/教训（feedback）
    Feedback,
    /// 外部指针（reference）
    Reference,
}

impl MemoryType {
    /// 从 frontmatter 线路名解析（未知值 → None，调用方按坏文件跳过）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "project" => Some(Self::Project),
            "feedback" => Some(Self::Feedback),
            "reference" => Some(Self::Reference),
            _ => None,
        }
    }
}

/// 单条记忆（frontmatter 各字段 + 正文）；文件名 = `{name}.md`
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEntry {
    /// slug（由标题导出，kebab 风格；CJK 字符原样保留）
    pub name: String,
    /// 一句话标题（≤40 字）
    pub title: String,
    /// 记忆类型
    pub mtype: MemoryType,
    /// 首次创建时刻（RFC3339；同题更新时保留）
    pub created_at: String,
    /// 最近更新时刻（RFC3339；LRU 淘汰依据）
    pub updated_at: String,
    /// 产生该记忆的会话 id
    pub session: String,
    /// 关联记忆 slug（可悬空，标记待补）
    pub links: Vec<String>,
    /// 事实正文（feedback/project 类型约定追加 **Why:** 与 **How to apply:** 两行）
    pub body: String,
}

/// 写入输入（W1 模型工具 `memory.save{title, type, body, links?}` 与 W2 候选共用）
#[derive(Debug, Clone)]
pub struct SaveInput {
    /// 标题（内部会做规范化：折叠空白、截 40 字）
    pub title: String,
    /// 记忆类型
    pub mtype: MemoryType,
    /// 正文（≤4KB，命中密钥特征拒写）
    pub body: String,
    /// 产生会话
    pub session: String,
    /// 关联记忆
    pub links: Vec<String>,
}

/// 索引重建结果：成功条数 + 容错跳过的坏文件数
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexOutcome {
    /// 成功编入索引的条目数
    pub indexed: usize,
    /// 解析失败被跳过的文件数（坏文件跳过 + 计数）
    pub skipped: usize,
}

/// 记忆存储层错误（含 D15 §4 脱敏拒写与 §2.1 容量约束）
#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    /// 正文/标题命中密钥特征 → 拒写（D15 §4）
    #[error("内容命中密钥特征，拒写：{0}（D15 §4 脱敏约束）")]
    SensitiveContent(&'static str),
    /// 正文超过 4KB 上限
    #[error("记忆正文超限：{actual} 字节 > 上限 {max} 字节")]
    BodyTooLarge { actual: usize, max: usize },
    /// D23 公共层单条超限（≤80 字，一条一事实一句一线）
    #[error("公共记忆单条超限：{actual} 字 > 上限 {max} 字")]
    GlobalEntryTooLong { actual: usize, max: usize },
    /// 规范化后标题为空
    #[error("记忆标题不能为空")]
    EmptyTitle,
    /// 非法记忆名（空/含路径分隔符/撞索引文件名）
    #[error("非法记忆名: {0}")]
    InvalidName(String),
    /// 文件 IO 错误
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// 标题规范化 / slug / 脱敏
// ---------------------------------------------------------------------------

/// 标题规范化：折叠空白为单空格、去首尾、截 40 字；空标题返回 None
pub(crate) fn normalize_title(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed.chars().take(MAX_TITLE_CHARS).collect())
    }
}

/// 标题 → 文件名 slug：ASCII 字母数字小写、其他文字字符（如 CJK）原样保留，
/// 其余字符折为 `-`（去首尾、不连续）；全符号标题兜底 `memory`。
/// 仅产出"文件名安全"字符（无分隔符、无点号）。
pub(crate) fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut pending_sep = false;
    for ch in title.chars() {
        let kept = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch.is_alphanumeric() {
            Some(ch) // CJK 等文字字符原样保留（文件名合法）
        } else {
            None // 空白/标点 → 分隔符
        };
        match kept {
            Some(c) => {
                if pending_sep && !out.is_empty() {
                    out.push('-');
                }
                pending_sep = false;
                out.push(c);
            }
            None => pending_sep = true,
        }
    }
    if out.is_empty() {
        "memory".to_string()
    } else {
        out
    }
}

/// 脱敏特征扫描（D15 §4）：正文命中私钥/JWT/password=/AWS 键任一特征即拒写。
/// 返回特征描述用于错误提示。不依赖 bbrt-sec（本 crate 依赖受限），
/// 记忆正文是唯一自由文本入口，写入端就地拒敏。
/// 私钥用后缀 `PRIVATE KEY-----` 匹配——覆盖 PKCS#8/RSA/EC/OPENSSH 全部
/// `-----BEGIN X PRIVATE KEY-----` 头（D15 表述的 "BEGIN PRIVATE KEY" 亦在其中）。
pub(crate) fn find_secret(text: &str) -> Option<&'static str> {
    if text.contains("PRIVATE KEY-----") {
        return Some("私钥片段（BEGIN … PRIVATE KEY）");
    }
    if text.to_ascii_lowercase().contains("password=") {
        return Some("口令赋值（password=…）");
    }
    if has_jwt_segment(text) {
        return Some("JWT 令牌段（eyJ…）");
    }
    if has_aws_access_key(text) {
        return Some("AWS 访问键（AKIA…）");
    }
    None
}

/// `eyJ` 开头且后随 ≥20 个 base64url 字符 → 视为 JWT 段
fn has_jwt_segment(text: &str) -> bool {
    let hay = text.as_bytes();
    let mut from = 0;
    while let Some(rel) = hay[from..].windows(3).position(|w| w == b"eyJ") {
        let start = from + rel + 3;
        let run = hay[start..]
            .iter()
            .take_while(|&&b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            .count();
        if run >= 20 {
            return true;
        }
        from = from + rel + 1;
    }
    false
}

/// `AKIA` + 恰好 16 位 [A-Z0-9] → AWS Access Key ID
fn has_aws_access_key(text: &str) -> bool {
    let hay = text.as_bytes();
    let mut from = 0;
    while let Some(rel) = hay[from..].windows(4).position(|w| w == b"AKIA") {
        let start = from + rel + 4;
        if start + 16 <= hay.len()
            && hay[start..start + 16]
                .iter()
                .all(|&b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            return true;
        }
        from = from + rel + 1;
    }
    false
}

// ---------------------------------------------------------------------------
// frontmatter 解析 / 序列化（手写 YAML 子集：仅 `key: value` 与 `key: [a, b]` 行）
// ---------------------------------------------------------------------------

/// 条目 → markdown 全文（frontmatter 固定键序 + 空行 + 正文）
pub(crate) fn entry_to_markdown(e: &MemoryEntry) -> String {
    let links = if e.links.is_empty() {
        "[]".to_string()
    } else {
        format!("[{}]", e.links.join(", "))
    };
    format!(
        "---\nname: {}\ntitle: {}\ntype: {}\ncreated_at: {}\nupdated_at: {}\nsession: {}\nlinks: {}\n---\n\n{}\n",
        e.name, e.title, e.mtype_wire(), e.created_at, e.updated_at, e.session, links, e.body
    )
}

impl MemoryEntry {
    fn mtype_wire(&self) -> &'static str {
        match self.mtype {
            MemoryType::User => "user",
            MemoryType::Project => "project",
            MemoryType::Feedback => "feedback",
            MemoryType::Reference => "reference",
        }
    }

    /// markdown 全文 → 条目。仅支持本 crate 写出的行格式；
    /// 缺必需键/未知类型/缺分隔符均报错（目录扫描时按坏文件跳过）。
    pub fn parse(src: &str) -> Result<Self, String> {
        let mut lines = src.lines();
        if lines.next() != Some("---") {
            return Err("缺少 frontmatter 起始分隔符 ---".to_string());
        }
        let mut kv: Vec<(String, String)> = Vec::new();
        let mut closed = false;
        for line in lines.by_ref() {
            if line == "---" {
                closed = true;
                break;
            }
            let (k, v) = line
                .split_once(':')
                .ok_or_else(|| format!("frontmatter 行缺少冒号: {line}"))?;
            kv.push((k.trim().to_string(), v.trim().to_string()));
        }
        if !closed {
            return Err("缺少 frontmatter 闭合分隔符 ---".to_string());
        }
        // 正文 = 闭合分隔符之后全部行；容忍写方在分隔符后的一个空行（本 crate 约定格式）
        let mut rest: Vec<&str> = lines.collect();
        if rest.first().is_some_and(|l| l.is_empty()) {
            rest.remove(0);
        }
        let body = rest.join("\n");
        let get = |key: &str| kv.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let name = get("name").ok_or("缺少 name")?;
        if name.is_empty() {
            return Err("name 为空".to_string());
        }
        let title = get("title").ok_or("缺少 title")?;
        let mtype = MemoryType::parse(&get("type").ok_or("缺少 type")?)
            .ok_or_else(|| "未知 type".to_string())?;
        Ok(Self {
            name,
            title,
            mtype,
            created_at: get("created_at").ok_or("缺少 created_at")?,
            updated_at: get("updated_at").ok_or("缺少 updated_at")?,
            session: get("session").unwrap_or_default(),
            links: parse_links(&get("links").unwrap_or_default()),
            body,
        })
    }
}

/// `key: [a, b]` 行内列表解析：去括号、逗号切分、trim、丢空项
fn parse_links(raw: &str) -> Vec<String> {
    raw.trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .map(|inner| {
            inner
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 目录扫描 / 索引
// ---------------------------------------------------------------------------

/// 扫描目录下全部条目（跳过 `MEMORY.md` 与 `.tmp` 残留）。
/// 返回（条目列表，按 updated_at 降序、name 升序；坏文件数）——
/// 坏文件跳过 + 计数，绝不因单个坏文件失败（D15 §2.1 崩溃恢复语义）。
pub fn scan_entries(dir: &Path) -> (Vec<MemoryEntry>, usize) {
    let mut entries = Vec::new();
    let mut skipped = 0;
    let Ok(rd) = fs::read_dir(dir) else {
        return (entries, skipped);
    };
    for entry in rd.flatten() {
        let fname = entry.file_name().to_string_lossy().into_owned();
        if fname == INDEX_FILE || !fname.ends_with(".md") {
            continue; // 索引本身与 .tmp 残留（不以 .md 结尾）不入扫描
        }
        match fs::read_to_string(entry.path())
            .map_err(|e| e.to_string())
            .and_then(|src| MemoryEntry::parse(&src))
        {
            Ok(e) => entries.push(e),
            Err(_) => skipped += 1,
        }
    }
    sort_for_display(&mut entries);
    (entries, skipped)
}

/// 展示序：updated_at 新→旧，同刻按 name 字典序（确定性输出，索引/列表共用）
pub(crate) fn sort_for_display(entries: &mut [MemoryEntry]) {
    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// 索引行：`- [标题](文件.md) — 钩子（正文首个非空行，无正文用 title）`
pub(crate) fn index_line(e: &MemoryEntry) -> String {
    format!("- [{}]({}.md) — {}", e.title, e.name, hook_of(e))
}

/// 钩子摘要：正文首个非空行；正文全空时退回标题
pub(crate) fn hook_of(e: &MemoryEntry) -> String {
    e.body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(&e.title)
        .to_string()
}

/// 把条目列表写成 `MEMORY.md`（整文件重写；调用方保证条目已按展示序排列）。
/// 与条目文件"同事务性写入"的落地次序：先写条目再重写索引（D15 §2.1）。
pub(crate) fn write_index(dir: &Path, entries: &[MemoryEntry]) -> std::io::Result<()> {
    let mut content = String::new();
    for e in entries {
        content.push_str(&index_line(e));
        content.push('\n');
    }
    fs::write(dir.join(INDEX_FILE), content)
}

/// 从目录扫描重建索引（崩溃恢复入口）：坏文件跳过 + 计数
pub fn rebuild_index(dir: &Path) -> std::io::Result<IndexOutcome> {
    let (entries, skipped) = scan_entries(dir);
    write_index(dir, &entries)?;
    Ok(IndexOutcome {
        indexed: entries.len(),
        skipped,
    })
}

/// 原子写条目文件：先写 `.md.tmp` 再 rename 覆盖（崩溃不产生半文件）
pub(crate) fn write_entry(dir: &Path, e: &MemoryEntry) -> std::io::Result<()> {
    let final_path = dir.join(format!("{}.md", e.name));
    let tmp_path = dir.join(format!("{}.md.tmp", e.name));
    fs::write(&tmp_path, entry_to_markdown(e))?;
    fs::rename(&tmp_path, &final_path)
}

// ---------------------------------------------------------------------------
// 单元测试：纯函数（frontmatter/slug/脱敏）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MemoryEntry {
        MemoryEntry {
            name: "端口-8090-约定".to_string(),
            title: "端口 8090 约定".to_string(),
            mtype: MemoryType::Project,
            created_at: "2026-11-06T23:20:00+08:00".to_string(),
            updated_at: "2026-11-06T23:21:00+08:00".to_string(),
            session: "sess-1".to_string(),
            links: vec!["gitee-remote".to_string()],
            body: "开发服务固定走 8090。".to_string(),
        }
    }

    #[test]
    fn frontmatter_roundtrip() {
        let md = entry_to_markdown(&sample());
        assert!(md.starts_with("---\n"));
        assert!(md.contains("name: 端口-8090-约定\n"));
        assert!(md.contains("links: [gitee-remote]\n"));
        assert_eq!(MemoryEntry::parse(&md).unwrap(), sample());
        // 空链接往返
        let mut e = sample();
        e.links = vec![];
        assert!(entry_to_markdown(&e).contains("links: []\n"));
        assert!(MemoryEntry::parse(&entry_to_markdown(&e))
            .unwrap()
            .links
            .is_empty());
    }

    #[test]
    fn frontmatter_parse_rejects_bad_files() {
        assert!(MemoryEntry::parse("没有分隔符").is_err());
        assert!(MemoryEntry::parse("---\ntitle: x\n").is_err()); // 未闭合
        assert!(MemoryEntry::parse(
            "---\nname: a\ntitle: t\ntype: hacker\ncreated_at: c\nupdated_at: u\n---\n正文"
        )
        .is_err()); // 未知 type
    }

    #[test]
    fn slugify_cases() {
        assert_eq!(slugify("端口 8090 约定"), "端口-8090-约定");
        assert_eq!(slugify("User Pref! hard-wrap"), "user-pref-hard-wrap");
        assert_eq!(slugify("  ---  "), "memory"); // 全符号兜底
        assert_eq!(slugify("Gitee 远端"), "gitee-远端");
    }

    #[test]
    fn normalize_title_collapses_and_truncates() {
        assert_eq!(normalize_title("  a \n b  c "), Some("a b c".to_string()));
        let long = "忆".repeat(60);
        assert_eq!(
            normalize_title(&long).unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
        assert_eq!(normalize_title("   "), None);
    }

    #[test]
    fn secret_patterns_hit() {
        assert!(find_secret("-----BEGIN RSA PRIVATE KEY-----\nMIIE...").is_some());
        assert!(find_secret("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi").is_some());
        assert!(find_secret("db_url?password=secret123").is_some());
        assert!(find_secret("PASSWORD=hunter2").is_some()); // 大小写不敏感
        assert!(find_secret("key = AKIAIOSFODNN7EXAMPLE").is_some()); // AWS 文档键
    }

    #[test]
    fn secret_patterns_miss_normal_text() {
        assert!(find_secret("端口 8090 约定，别用 8080。").is_none());
        assert!(find_secret("eyJ 太短").is_none()); // eyJ 后 base64 长度不足
        assert!(find_secret("AKIAIOSFODNN7EXAMPL").is_none()); // 少一位
        assert!(find_secret("akiaIOSFODNN7EXAMPLE").is_none()); // 小写不算
        assert!(find_secret("password 是 secret").is_none()); // 无等号
    }
}
