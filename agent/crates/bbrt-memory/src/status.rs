//! 项目进度台账正文编解码（D37）：`status` 类型记忆条目的五段正文纯函数层。
//!
//! - **不是存储层**——真相仍是 `KnowledgeStore` 的普通记忆条目（同题原地更新/
//!   tmp+rename 原子写/密钥拒写/索引重建全复用）；本文件只做
//!   「解析现有正文 → 合并 delta → 渲染新正文」三步纯变换；
//! - **完全扁平五段**：待办/已做/阻塞/决策/坑（无目标/无线程/无 ID；多任务
//!   并行靠条目自带任务名前缀区分，如 `11-19 D35：批0-4 已推 697707c`）；
//! - **合并是加法**：归一化去重 + 新 done 对账移除同义 todo；不删既有条目、
//!   不做容量裁剪（D37 拍板不限大小，增长治理交使用纪律 + 注入侧 assemble
//!   预算截断兜底）；单条命中密钥特征整条丢弃计 redacted；
//! - **拒绝覆盖**：正文非五段格式（或为空但 delta 无有效条目）→ 返回 None
//!   不写盘——宁可不动，不可误删；
//! - 唯一写入方 = W3 会话结束提炼（`memory_save` 工具拒绝 status 手工写入）。
//!
//! 渲染段序 = 注入优先级：待办（驱动续作）→ 已做 → 阻塞 → 决策 → 坑
//! （注入侧万一被 assemble 预算截断，从尾部丢起，先丢最不敏感的段）。

use serde::Deserialize;

use crate::global::normalize_text;
use crate::knowledge::store::find_secret;

/// 台账条目标题（同时是 slug——CJK 原样保留；每项目一条，同题原地更新）
pub const STATUS_TITLE: &str = "项目进度台账";

// ---------------------------------------------------------------------------
// W3 增量（distill 对象 payload 的 progress 字段）
// ---------------------------------------------------------------------------

/// 会话结束提炼出的进度增量（五段各自可选；条目自带任务名/日期前缀）
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct StatusDelta {
    /// 已完成（如 `11-19 D35：批0-4 已推 697707c，程序侧全绿`）
    #[serde(default)]
    pub done: Vec<String>,
    /// 待办/下一步（如 `D35：真机八项验收`）
    #[serde(default)]
    pub todo: Vec<String>,
    /// 阻塞与风险
    #[serde(default)]
    pub blockers: Vec<String>,
    /// 本任务拍板（任务作用域决策；可泛化的知识/教训走 memories 不走这里）
    #[serde(default)]
    pub decisions: Vec<String>,
    /// 本次踩的坑
    #[serde(default)]
    pub pitfalls: Vec<String>,
}

/// 合并统计（WAL `status.merge` 用）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StatusMergeStats {
    /// 新增条目数（五段合计）
    pub added: usize,
    /// 因新 done 对账移除的 todo 数
    pub completed: usize,
    /// 命中密钥特征被丢弃的条目数
    pub redacted: usize,
}

// ---------------------------------------------------------------------------
// 正文解析态
// ---------------------------------------------------------------------------

/// 台账正文解析态（段内顺序 = 新 → 旧：合并插入段首，尾部最旧）
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct StatusDoc {
    pub todo: Vec<String>,
    pub done: Vec<String>,
    pub blockers: Vec<String>,
    pub decisions: Vec<String>,
    pub pitfalls: Vec<String>,
}

/// 段名 → 解析态槽位（未知段名 → None：其后条目忽略）
#[derive(Debug, Clone, Copy)]
enum Sec {
    Todo,
    Done,
    Blockers,
    Decisions,
    Pitfalls,
}

fn section_by_name(name: &str) -> Option<Sec> {
    match name.trim() {
        "待办" => Some(Sec::Todo),
        "已做" => Some(Sec::Done),
        "阻塞" => Some(Sec::Blockers),
        "决策" => Some(Sec::Decisions),
        "坑" => Some(Sec::Pitfalls),
        _ => None,
    }
}

impl StatusDoc {
    fn slot(&mut self, s: Sec) -> &mut Vec<String> {
        match s {
            Sec::Todo => &mut self.todo,
            Sec::Done => &mut self.done,
            Sec::Blockers => &mut self.blockers,
            Sec::Decisions => &mut self.decisions,
            Sec::Pitfalls => &mut self.pitfalls,
        }
    }
}

/// 正文 → 五段。空正文 = 空台账；**非空但无任何 `## 段名` 标题 → None
/// （非台账格式，拒绝合并——防误覆盖用户手写的同名内容）**。
/// `- [ ] `/`- [x] ` 复选前缀剥掉；标题前/未知段下的行忽略。
pub(crate) fn parse_status_body(body: &str) -> Option<StatusDoc> {
    let mut doc = StatusDoc::default();
    let mut cur: Option<Sec> = None;
    let mut saw_section = false;
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(name) = t.strip_prefix("## ") {
            saw_section = true;
            cur = section_by_name(name);
            continue;
        }
        if let Some(item) = t.strip_prefix("- ") {
            let item = item
                .strip_prefix("[ ] ")
                .or_else(|| item.strip_prefix("[x] "))
                .unwrap_or(item)
                .trim();
            if !item.is_empty() {
                if let Some(s) = cur {
                    doc.slot(s).push(item.to_string());
                }
            }
        }
        // 其余行（段间说明/旧自由正文残留）忽略——只认段标题与条目行
    }
    if !saw_section && !body.trim().is_empty() {
        return None;
    }
    Some(doc)
}

/// 五段 → 正文（空段整段省略；待办带 `- [ ] ` 复选前缀供回显勾选态）
pub(crate) fn render_status(doc: &StatusDoc) -> String {
    let mut out = String::new();
    let sections: [(&str, &Vec<String>); 5] = [
        ("待办", &doc.todo),
        ("已做", &doc.done),
        ("阻塞", &doc.blockers),
        ("决策", &doc.decisions),
        ("坑", &doc.pitfalls),
    ];
    for (name, items) in sections {
        if items.is_empty() {
            continue;
        }
        out.push_str(&format!("## {name}\n"));
        for it in items {
            if name == "待办" {
                out.push_str(&format!("- [ ] {it}\n"));
            } else {
                out.push_str(&format!("- {it}\n"));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

/// 清洗：trim + 去空串（增量条目进入合并前的统一入口）
fn cleaned(items: &[String]) -> impl Iterator<Item = &str> {
    items.iter().map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// 段内去重插入：归一化相等则跳过，否则插段首（新 → 旧）。返回是否新增。
fn push_unique(slot: &mut Vec<String>, item: &str) -> bool {
    let key = normalize_text(item);
    if slot.iter().any(|e| normalize_text(e) == key) {
        return false;
    }
    slot.insert(0, item.to_string());
    true
}

/// 合并 delta 到现有正文：
/// - `existing` None/空 → 新建台账；
/// - 现有正文非五段格式 → **None（拒绝写，不动原条目）**；
/// - delta 无任何有效新条目（去重后零新增零完成）→ None（跳过，不空转重写）；
/// - 新 done 先落段首，同时按归一化相等从 todo 对账移除（计 completed）；
///   新 todo 已在 done/todo 中 → 跳过（防复活已完成项）。
pub(crate) fn merge_status_body(
    existing: Option<&str>,
    delta: &StatusDelta,
) -> Option<(String, StatusMergeStats)> {
    let mut doc = match existing.map(str::trim) {
        None | Some("") => StatusDoc::default(),
        Some(s) => parse_status_body(s)?,
    };
    let mut stats = StatusMergeStats::default();

    for raw in cleaned(&delta.done) {
        if find_secret(raw).is_some() {
            stats.redacted += 1;
            continue;
        }
        let key = normalize_text(raw);
        let before = doc.todo.len();
        doc.todo.retain(|t| normalize_text(t) != key);
        stats.completed += before - doc.todo.len();
        if push_unique(&mut doc.done, raw) {
            stats.added += 1;
        }
    }
    for raw in cleaned(&delta.todo) {
        if find_secret(raw).is_some() {
            stats.redacted += 1;
            continue;
        }
        // 已在 done → 不复活；已在 todo → 去重
        if doc
            .done
            .iter()
            .any(|d| normalize_text(d) == normalize_text(raw))
        {
            continue;
        }
        if push_unique(&mut doc.todo, raw) {
            stats.added += 1;
        }
    }
    for (slot, src) in [
        (&mut doc.blockers, &delta.blockers),
        (&mut doc.decisions, &delta.decisions),
        (&mut doc.pitfalls, &delta.pitfalls),
    ] {
        for raw in cleaned(src) {
            if find_secret(raw).is_some() {
                stats.redacted += 1;
                continue;
            }
            if push_unique(slot, raw) {
                stats.added += 1;
            }
        }
    }

    if stats.added == 0 && stats.completed == 0 {
        return None;
    }
    Some((render_status(&doc), stats))
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(done: &[&str], todo: &[&str]) -> StatusDelta {
        StatusDelta {
            done: done.iter().map(|s| s.to_string()).collect(),
            todo: todo.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn parse_render_roundtrip() {
        let body = "## 待办\n- [ ] D35：真机八项验收\n## 已做\n- 11-19 D35：批0-4 已推 697707c\n## 坑\n- 改日历要重算 workday next_run\n";
        let doc = parse_status_body(body).unwrap();
        assert_eq!(doc.todo, ["D35：真机八项验收"]);
        assert_eq!(doc.done.len(), 1);
        assert!(doc.blockers.is_empty() && doc.decisions.is_empty());
        assert_eq!(doc.pitfalls.len(), 1);
        let rendered = render_status(&doc);
        assert_eq!(rendered, body);
        // 往返再解析仍等价
        assert_eq!(parse_status_body(&rendered).unwrap(), doc);
    }

    #[test]
    fn parse_refuses_non_ledger_body() {
        assert!(parse_status_body("随便一段自由正文，没有段标题").is_none());
        assert!(parse_status_body("开发服务固定走 8090。\n").is_none());
        // 空正文 = 空台账（新建路径）
        assert_eq!(parse_status_body(""), Some(StatusDoc::default()));
        assert_eq!(parse_status_body("  \n"), Some(StatusDoc::default()));
    }

    #[test]
    fn merge_creates_and_orders_newest_first() {
        let (body, stats) = merge_status_body(None, &delta(&["批0 完成"], &["真机验收"])).unwrap();
        assert_eq!(stats.added, 2);
        assert!(body.contains("## 待办\n- [ ] 真机验收"));
        assert!(body.contains("## 已做\n- 批0 完成"));
        // 第二次合并：新条目插段首（新→旧）
        let (body2, _) = merge_status_body(Some(&body), &delta(&["批1 完成"], &[])).unwrap();
        let done_idx_new = body2.find("批1 完成").unwrap();
        let done_idx_old = body2.find("批0 完成").unwrap();
        assert!(done_idx_new < done_idx_old, "新条目应在段首：{body2}");
    }

    #[test]
    fn merge_dedupes_normalized_and_completes_todo() {
        let (base, _) =
            merge_status_body(None, &delta(&["批0 完成"], &["真机验收", "写文档"])).unwrap();
        // 归一化去重（空白差异视为同条）→ 零新增零完成 = 跳过不写
        assert!(
            merge_status_body(Some(&base), &delta(&["批0  完成"], &["真机 验收"])).is_none(),
            "重复条目不应触发写入"
        );
        // done 对账移除 todo
        let (b3, stats) = merge_status_body(Some(&base), &delta(&["写文档"], &[])).unwrap();
        assert_eq!(stats.completed, 1);
        assert_eq!(stats.added, 1);
        assert!(!b3.contains("[ ] 写文档"), "todo 中的「写文档」应被移除");
        assert!(b3.contains("- 写文档"), "done 段应含「写文档」");
        // 已完成项不因 todo 复活（todo 去重跳过 → 零新增 = None）
        assert!(merge_status_body(Some(&b3), &delta(&[], &["写文档"])).is_none());
    }

    #[test]
    fn merge_skips_when_nothing_new() {
        let (base, _) = merge_status_body(None, &delta(&["批0"], &["todo1"])).unwrap();
        assert!(merge_status_body(Some(&base), &delta(&["批0"], &["todo1"])).is_none());
        assert!(merge_status_body(Some(&base), &StatusDelta::default()).is_none());
        // 拒绝路径：非台账正文
        assert!(merge_status_body(Some("自由正文"), &delta(&["x"], &[])).is_none());
    }

    #[test]
    fn merge_drops_secret_items() {
        let d = StatusDelta {
            done: vec![
                "正常进展".into(),
                "token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi".into(),
            ],
            todo: vec!["password=hunter2 的配置".into(), "正常待办".into()],
            ..Default::default()
        };
        let (body, stats) = merge_status_body(None, &d).unwrap();
        assert_eq!(stats.redacted, 2);
        assert_eq!(stats.added, 2);
        assert!(body.contains("正常进展") && body.contains("正常待办"));
        assert!(!body.contains("eyJ"));
        assert!(!body.contains("password="));
    }

    #[test]
    fn render_omits_empty_sections() {
        let doc = StatusDoc {
            todo: vec!["唯一待办".into()],
            ..Default::default()
        };
        assert_eq!(render_status(&doc), "## 待办\n- [ ] 唯一待办\n");
    }
}
