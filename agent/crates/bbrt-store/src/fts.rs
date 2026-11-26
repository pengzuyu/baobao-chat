//! 会话全文检索的查询净化与路由（session_search 数据源；索引见 migrations/008_event_fts.sql）。
//!
//! 参考 hermes-agent（tools/session_search_tool.py、hermes_state.py::search_messages）的
//! 三路径路由，两处收紧：①按「每个词的字符数」而非「仅 CJK 字数」判定 trigram
//! （`K8s 部署不了` 这类混合词同样能走索引）；②大小写的 and/or/not 一律按布尔运算符
//! 处理（FTS5 只认大写，小写会被当成普通搜索词）。
//!
//! 输入先解析为布尔结构（OR 连接的 AND 词组 + 排除词），再按路径重新拼装——
//! 用户/模型输入永不直接进 MATCH。

/// 检索执行路径（由查询串形态决定，[`plan_query`] 产出）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchPlan {
    /// unicode61 词级索引（查询不含中文）
    Fts(FtsQuery),
    /// trigram 子串索引（含中文且每个词 ≥3 个字符）
    Trigram(FtsQuery),
    /// LIKE 兜底（含 1–2 字的词，trigram 无法匹配）
    Like(LikeQuery),
}

/// FTS 路径的查询。排除不写进 MATCH：FTS5 的 NOT 是二元运算符、没有「匹配全部」的
/// 左操作数（纯排除查询无法表达）——store 层用子查询在同一个索引上取排除集再剔除。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FtsQuery {
    /// 正部 MATCH 串：OR 连接的 AND 词组；空串=纯排除查询
    pub positive: String,
    /// 排除部 MATCH 串：各词 OR（命中任一排除词即剔除）；空串=无排除
    pub exclude: String,
}

/// LIKE 路径的布尔结构（FTS 路径的布尔求值由 SQLite 自己完成，不需要）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LikeQuery {
    /// OR 连接的词组，每组内部 AND（可为空=纯排除查询）
    pub groups: Vec<Vec<String>>,
    /// 排除词（NOT）
    pub exclude: Vec<String>,
}

/// 检索结果排序
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchSort {
    /// bm25 相关度（缺省，时间中性）
    Rank,
    /// 时间倒序，相关度决胜（「上次做到哪了」）
    Newest,
    /// 时间正序，相关度决胜（「这事最早怎么定的」）
    Oldest,
}

/// 词法单元：搜索词 / 引号短语 / 布尔运算符
#[derive(Debug, Clone, PartialEq, Eq)]
enum Item {
    Word(String),
    Phrase(String),
    And,
    Or,
    Not,
}

/// 词的匹配方式：普通词（可带前缀 `*`）或引号短语
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TermKind {
    Word { prefix: bool },
    Phrase,
}

/// 布尔结构：OR 连接的 AND 词组 + 排除词
#[derive(Debug, Default, PartialEq, Eq)]
struct Bool {
    groups: Vec<Vec<(String, TermKind)>>,
    exclude: Vec<(String, TermKind)>,
}

/// 把查询串解析为检索路径；无任何可检索内容（空串、纯符号）返回 None。
pub fn plan_query(raw: &str) -> Option<SearchPlan> {
    let b = structure(&lex(raw));
    let terms: Vec<&(String, TermKind)> =
        b.groups.iter().flatten().chain(b.exclude.iter()).collect();
    if terms.is_empty() {
        return None;
    }
    if !contains_cjk(raw) {
        Some(SearchPlan::Fts(to_fts(&b, fts_term)))
    } else if terms.iter().all(|(t, _)| t.chars().count() >= 3) {
        Some(SearchPlan::Trigram(to_fts(&b, trigram_term)))
    } else {
        let plain = |v: &[(String, TermKind)]| v.iter().map(|(t, _)| t.clone()).collect();
        Some(SearchPlan::Like(LikeQuery {
            groups: b.groups.iter().map(|g| plain(g)).collect(),
            exclude: plain(&b.exclude),
        }))
    }
}

/// 是否含 CJK 字符（中日韩；码点段同 hermes _is_cjk_codepoint）
fn contains_cjk(text: &str) -> bool {
    text.chars().any(is_cjk)
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF     // CJK 统一表意文字
        | 0x3400..=0x4DBF   // 扩展 A
        | 0x20000..=0x2A6DF // 扩展 B
        | 0x3000..=0x303F   // CJK 符号与标点
        | 0x3040..=0x309F   // 平假名
        | 0x30A0..=0x30FF   // 片假名
        | 0xAC00..=0xD7AF) // 谚文音节
}

/// 词外分隔符：FTS5 特殊字符 `+ {} ( ) [ ] ^ :`、CJK 标点与全角符号、弯引号与省略号。
/// 引号内的内容不分隔（短语）；`- _ .` 保留在词内（复合标识符）。
fn is_separator(c: char) -> bool {
    c.is_whitespace()
        || matches!(c, '+' | '{' | '}' | '(' | ')' | '[' | ']' | '^' | ':')
        || matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFFEF | 0x2018..=0x201F)
        || c == '…'
}

fn lex(raw: &str) -> Vec<Item> {
    let mut items = Vec::new();
    let mut buf = String::new();
    // 引号外的缓冲区落成一个词（或大小写不敏感的布尔运算符）
    let flush = |buf: &mut String, items: &mut Vec<Item>| {
        let tok = buf.trim();
        if tok.eq_ignore_ascii_case("and") {
            items.push(Item::And);
        } else if tok.eq_ignore_ascii_case("or") {
            items.push(Item::Or);
        } else if tok.eq_ignore_ascii_case("not") {
            items.push(Item::Not);
        } else if !tok.is_empty() {
            items.push(Item::Word(tok.to_string()));
        }
        buf.clear();
    };
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                flush(&mut buf, &mut items);
                // 读到下一个引号；未闭合则读到串尾，同样按整段短语处理
                let mut inner = String::new();
                for cc in chars.by_ref() {
                    if cc == '"' {
                        break;
                    }
                    inner.push(cc);
                }
                if !inner.trim().is_empty() {
                    items.push(Item::Phrase(inner.trim().to_string()));
                }
            }
            c if is_separator(c) => flush(&mut buf, &mut items),
            c => buf.push(c),
        }
    }
    flush(&mut buf, &mut items);
    items
}

/// 词法单元 → 布尔结构。悬空运算符（开头/结尾/连续）自然被容忍：
/// OR 只在当前词组非空时开新组，NOT 只作用于紧随其后的一个词。
fn structure(items: &[Item]) -> Bool {
    let mut b = Bool::default();
    b.groups.push(Vec::new());
    let mut negate_next = false;
    for item in items {
        match item {
            Item::Or => {
                if b.groups.last().is_some_and(|g| !g.is_empty()) {
                    b.groups.push(Vec::new());
                }
            }
            Item::And => {}
            Item::Not => negate_next = true,
            Item::Word(text) | Item::Phrase(text) => {
                let kind = match item {
                    Item::Phrase(_) => TermKind::Phrase,
                    // 前缀 `*` 只对词有意义；子串路径本身覆盖前缀，不单独保留
                    _ => TermKind::Word {
                        prefix: text.ends_with('*') && !text.trim_end_matches('*').is_empty(),
                    },
                };
                let text = match kind {
                    TermKind::Phrase => text.clone(),
                    TermKind::Word { .. } => text.trim_end_matches('*').to_string(),
                };
                // 纯标点/符号的词没有可检索内容
                if !text.chars().any(|c| c.is_alphanumeric()) {
                    continue;
                }
                if negate_next {
                    b.exclude.push((text, kind));
                    negate_next = false;
                } else {
                    b.groups
                        .last_mut()
                        .expect("groups 恒有当前组")
                        .push((text, kind));
                }
            }
        }
    }
    b.groups.retain(|g| !g.is_empty());
    b
}

/// unicode61 路径：一个词 → FTS5 MATCH 片段。普通单词用引号短语（恒语法安全，
/// 单词语义与裸词等价）；带前缀 `*` 的纯字母数字词保留裸词形态。
fn fts_term(text: &str, kind: TermKind) -> Option<String> {
    let body: String = text.chars().filter(|c| *c != '"').collect();
    if !body.chars().any(|c| c.is_alphanumeric()) {
        return None;
    }
    match kind {
        TermKind::Word { prefix: true }
            if body
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-') =>
        {
            Some(format!("{body}*"))
        }
        _ => Some(format!("\"{body}\"")),
    }
}

/// trigram 路径：一个词 → 引号短语（子串匹配；长度由路由保证 ≥3 字符）
fn trigram_term(text: &str, _: TermKind) -> Option<String> {
    Some(format!("\"{}\"", text.replace('"', "")))
}

/// 布尔结构 → FTS 查询（`term` 按路径给一个词拼 MATCH 片段，None=该词不可检索）
fn to_fts(b: &Bool, term: impl Fn(&str, TermKind) -> Option<String>) -> FtsQuery {
    let groups: Vec<String> = b
        .groups
        .iter()
        .filter_map(|g| {
            let terms: Vec<String> = g.iter().filter_map(|(t, k)| term(t, *k)).collect();
            (!terms.is_empty()).then(|| format!("({})", terms.join(" ")))
        })
        .collect();
    FtsQuery {
        positive: groups.join(" OR "),
        exclude: b
            .exclude
            .iter()
            .filter_map(|(t, k)| term(t, *k))
            .collect::<Vec<_>>()
            .join(" OR "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fts(positive: &str, exclude: &str) -> SearchPlan {
        SearchPlan::Fts(FtsQuery {
            positive: positive.into(),
            exclude: exclude.into(),
        })
    }

    fn tri(positive: &str, exclude: &str) -> SearchPlan {
        SearchPlan::Trigram(FtsQuery {
            positive: positive.into(),
            exclude: exclude.into(),
        })
    }

    fn like(groups: &[&[&str]], exclude: &[&str]) -> SearchPlan {
        SearchPlan::Like(LikeQuery {
            groups: groups
                .iter()
                .map(|g| g.iter().map(|s| s.to_string()).collect())
                .collect(),
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
        })
    }

    /// 纯英文：词级索引；AND 是缺省连接
    #[test]
    fn 纯英文_走词级索引() {
        assert_eq!(
            plan_query("auth refactor"),
            Some(fts("(\"auth\" \"refactor\")", ""))
        );
    }

    /// 前缀 `*`、OR、NOT（只作用于紧随其后的一个词）；悬空运算符与多余 `*` 被清理
    #[test]
    fn 英文_前缀与布尔算符() {
        assert_eq!(
            plan_query("deploy** OR kubernetes NOT docker"),
            Some(fts("(deploy*) OR (\"kubernetes\")", "\"docker\""))
        );
        assert_eq!(plan_query("OR docker AND"), Some(fts("(\"docker\")", "")));
    }

    /// 小写 and/or/not 同样按布尔运算符处理（FTS5 只认大写）
    #[test]
    fn 小写算符_按布尔处理() {
        assert_eq!(
            plan_query("docker or kubernetes"),
            plan_query("docker OR kubernetes")
        );
    }

    /// FTS5 特殊字符被当作分隔符；纯符号串无检索内容
    #[test]
    fn 特殊字符_清理() {
        assert_eq!(
            plan_query("+{auth} ^(refactor):"),
            Some(fts("(\"auth\" \"refactor\")", ""))
        );
        assert_eq!(plan_query("***"), None);
        assert_eq!(plan_query("   "), None);
        assert_eq!(plan_query("OR NOT"), None);
    }

    /// 带连字符/点号/下划线的复合标识符整词成短语（分词器会把它们拆开）
    #[test]
    fn 复合标识符_成短语() {
        assert_eq!(
            plan_query("chat-send P2.2 my_app.config"),
            Some(fts("(\"chat-send\" \"P2.2\" \"my_app.config\")", ""))
        );
    }

    /// 引号短语原样保留，内部的特殊字符不分隔
    #[test]
    fn 引号短语_保留() {
        assert_eq!(
            plan_query("\"exact phrase\" docker"),
            Some(fts("(\"exact phrase\" \"docker\")", ""))
        );
        assert_eq!(plan_query("\"a:b(c)\""), Some(fts("(\"a:b(c)\")", "")));
    }

    /// 纯排除查询：正部为空，由 store 层走「子查询取排除集」的扫描形态
    #[test]
    fn 纯排除查询() {
        assert_eq!(plan_query("NOT java"), Some(fts("", "\"java\"")));
        assert_eq!(
            plan_query("NOT java NOT python"),
            Some(fts("", "\"java\" OR \"python\""))
        );
        assert_eq!(
            plan_query("NOT java OR python"),
            Some(fts("(\"python\")", "\"java\""))
        );
    }

    /// 含中文且每个词 ≥3 字符：trigram 子串索引（混合词同样成立）
    #[test]
    fn 长中文_走trigram() {
        assert_eq!(plan_query("修复登录"), Some(tri("(\"修复登录\")", "")));
        assert_eq!(
            plan_query("SQLite 事务表"),
            Some(tri("(\"SQLite\" \"事务表\")", ""))
        );
        assert_eq!(
            plan_query("K8s 部署不了"),
            Some(tri("(\"K8s\" \"部署不了\")", ""))
        );
        assert_eq!(
            plan_query("登录超时 OR 注册流程 NOT 游客登录"),
            Some(tri("(\"登录超时\") OR (\"注册流程\")", "\"游客登录\""))
        );
    }

    /// 含 1–2 字的词：trigram 无法匹配，落 LIKE 兜底；布尔结构保留
    #[test]
    fn 短中文_走like兜底() {
        assert_eq!(plan_query("登录"), Some(like(&[&["登录"]], &[])));
        assert_eq!(plan_query("K8s 坑"), Some(like(&[&["K8s", "坑"]], &[])));
        assert_eq!(
            plan_query("登录 OR 注册 NOT 游客"),
            Some(like(&[&["登录"], &["注册"]], &["游客"]))
        );
        // 排除词同样参与路由：出现 1–2 字的词整体落 LIKE
        assert_eq!(
            plan_query("登录超时 NOT 坑"),
            Some(like(&[&["登录超时"]], &["坑"]))
        );
    }

    /// 中文标点/全角符号作分隔符（否则「登录，注册」会当成一个 5 字词走 trigram 精确匹配）
    #[test]
    fn 中文标点_作分隔符() {
        assert_eq!(
            plan_query("登录，注册"),
            Some(like(&[&["登录", "注册"]], &[]))
        );
        assert_eq!(plan_query("「登录」"), Some(like(&[&["登录"]], &[])));
    }

    /// 路由按字符数：3 字符的混合词走 trigram，2 字符走 LIKE
    #[test]
    fn 路由_按字符数() {
        assert_eq!(plan_query("ab中"), Some(tri("(\"ab中\")", "")));
        assert_eq!(plan_query("a中"), Some(like(&[&["a中"]], &[])));
    }

    /// 前缀 `*` 在子串路径不单独保留
    #[test]
    fn 前缀星号_子串路径丢弃() {
        assert_eq!(plan_query("部署配置*"), Some(tri("(\"部署配置\")", "")));
    }

    #[test]
    fn cjk_码点判定() {
        assert!(is_cjk('中'));
        assert!(is_cjk('。'));
        assert!(is_cjk('あ'));
        assert!(is_cjk('한'));
        assert!(!is_cjk('a'));
        assert!(!is_cjk('，'));
    }
}
