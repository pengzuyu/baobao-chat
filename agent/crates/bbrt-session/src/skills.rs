//! 技能加载器（10 篇 §3.3/§4.5 衔接）。
//!
//! 宿主安装/更新/卸载技能包后发 `tools.reload{reason: skill}`，Runtime 扫描
//! `{dataDir}/eco/skills/*/SKILL.md` 载 frontmatter 元数据（name/triggers/
//! allowedTools/risk）进技能索引；正文按 08 篇 §4.3 预算命中注入——
//! 用户消息含 trigger 关键词的技能正文进组装 skills 区块（context 预算
//! 5% 截断兜底）。
//!
//! v0.1 边界：allowedTools 仅随正文提示模型（工具面收紧待 pick_tools
//! 接线，10 篇 §4.6）；frontmatter 行级解析（键值/列表），不引 yaml 依赖。

use std::path::{Path, PathBuf};

/// 单条技能（SKILL.md = frontmatter 元数据 + 正文指令）
#[derive(Debug, Clone, PartialEq)]
pub struct SkillEntry {
    /// 技能名（frontmatter name；缺省取目录名）
    pub name: String,
    /// 触发关键词（用户消息包含即命中；大小写不敏感）
    pub triggers: Vec<String>,
    /// 允许工具（allowedTools；v0.1 随正文提示模型）
    pub allowed_tools: Vec<String>,
    /// low | medium | high（缺省 low）
    pub risk: String,
    /// 正文指令（frontmatter 围栏之后全部）
    pub body: String,
    /// 来源目录（诊断/审计）
    pub dir: PathBuf,
}

/// 技能索引（bin 装配持有 `Arc<Mutex<SkillIndex>>`；tools.reload 重扫替换）
#[derive(Debug, Clone, Default)]
pub struct SkillIndex {
    /// 按目录名字典序（扫描确定性；命中顺序稳定）
    pub entries: Vec<SkillEntry>,
}

/// 单轮最多注入技能数（防撑爆 skills 预算；10 篇 §4.6"按需注入"）
const MAX_INJECT: usize = 3;

impl SkillIndex {
    /// 扫描 `eco/skills/*/SKILL.md`（目录缺失/子目录无 SKILL.md 静默跳过；
    /// 单份解析失败不阻塞其余——降级语义同生态工具装载）
    pub fn scan(eco_dir: &Path) -> Self {
        let mut dirs: Vec<PathBuf> = match std::fs::read_dir(eco_dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect(),
            Err(_) => return Self::default(),
        };
        dirs.sort(); // 确定性：命中顺序稳定可测
        let entries = dirs
            .iter()
            .filter_map(|dir| {
                let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
                Some(parse_skill(dir, &text))
            })
            .collect();
        Self { entries }
    }

    /// 用户消息命中（trigger 包含匹配；≤ MAX_INJECT 条）
    pub fn match_for(&self, user_text: &str) -> Vec<&SkillEntry> {
        let hay = user_text.to_lowercase();
        self.entries
            .iter()
            .filter(|e| {
                e.triggers
                    .iter()
                    .any(|t| !t.is_empty() && hay.contains(&t.to_lowercase()))
            })
            .take(MAX_INJECT)
            .collect()
    }

    /// 命中技能拼装 skills 区块文本（空命中=空串；allowedTools 随行提示）
    pub fn render(&self, matched: &[&SkillEntry]) -> String {
        matched
            .iter()
            .map(|e| {
                let tools = if e.allowed_tools.is_empty() {
                    String::new()
                } else {
                    format!("\n（本技能允许工具: {}）", e.allowed_tools.join(", "))
                };
                format!("# 技能: {}（risk: {}）{tools}\n{}", e.name, e.risk, e.body)
            })
            .collect::<Vec<_>>()
            .join("\n\n---\n\n")
    }

    /// 已载技能数（诊断/测试）
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 解析单份 SKILL.md：`---` 围栏 frontmatter（行级键值/列表）+ 正文；
/// 无围栏/未闭合围栏视为纯正文（容错：坏文件最多丢元数据，不 panic）
fn parse_skill(dir: &Path, text: &str) -> SkillEntry {
    let t = text.trim_start_matches('\u{feff}').trim();
    let (mut name, mut triggers, mut allowed, mut risk) =
        (None, Vec::new(), Vec::new(), "low".to_string());
    let mut body = t.to_string();

    if let Some(rest) = t.strip_prefix("---") {
        if let Some((fm, after)) = rest.trim_start_matches('\n').split_once("\n---") {
            for line in fm.lines() {
                let Some((k, v)) = line.split_once(':') else {
                    continue;
                };
                let (k, v) = (k.trim(), v.trim());
                match k {
                    "name" => name = Some(v.to_string()),
                    "triggers" => triggers = parse_list(v),
                    "allowedTools" => allowed = parse_list(v),
                    "risk" if !v.is_empty() => risk = v.to_string(),
                    _ => {} // 未知键忽略（前向兼容）
                }
            }
            body = after.trim_start_matches('\n').trim().to_string();
        }
    }

    SkillEntry {
        name: name.unwrap_or_else(|| {
            dir.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unnamed".into())
        }),
        triggers,
        allowed_tools: allowed,
        risk,
        body,
        dir: dir.to_path_buf(),
    }
}

/// 列表值解析：`[a, b]` 或裸 `a`（空段过滤）
fn parse_list(v: &str) -> Vec<String> {
    v.trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(eco: &Path, dir: &str, content: &str) {
        let d = eco.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), content).unwrap();
    }

    fn temp_eco(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bbrt-skills-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 扫描+解析：frontmatter 全字段；缺 name 取目录名；无 SKILL.md 的目录跳过；
    /// 目录缺失返回空索引。
    #[test]
    fn scan_parses_frontmatter() {
        let eco = temp_eco("scan");
        write_skill(
            &eco,
            "expense",
            "---\nname: 报销助手\ntriggers: [报销, 费用]\nallowedTools: [oa.todo.list]\nrisk: medium\n---\n提交报销前先确认事由与金额。",
        );
        write_skill(&eco, "bare", "纯正文技能，无 frontmatter。");
        std::fs::create_dir_all(eco.join("no-skill")).unwrap(); // 无 SKILL.md：跳过

        let idx = SkillIndex::scan(&eco);
        assert_eq!(idx.len(), 2);
        // 字节序：bare < expense
        let expense = &idx.entries[1];
        assert_eq!(expense.name, "报销助手");
        assert_eq!(expense.triggers, vec!["报销", "费用"]);
        assert_eq!(expense.allowed_tools, vec!["oa.todo.list"]);
        assert_eq!(expense.risk, "medium");
        assert_eq!(expense.body, "提交报销前先确认事由与金额。");
        // 无 frontmatter：name 缺省目录名，risk 缺省 low
        assert_eq!(idx.entries[0].name, "bare");
        assert_eq!(idx.entries[0].risk, "low");

        assert!(SkillIndex::scan(&eco.join("不存在")).is_empty());
        let _ = std::fs::remove_dir_all(&eco);
    }

    /// 命中：关键词包含（大小写不敏感）、take 上限、无命中空。
    #[test]
    fn match_and_render() {
        let eco = temp_eco("match");
        write_skill(
            &eco,
            "a",
            "---\nname: A\ntriggers: [PPT, 演示]\n---\n制作幻灯片的规范。",
        );
        write_skill(&eco, "b", "---\nname: B\ntriggers: [报销]\n---\n报销流程。");
        let idx = SkillIndex::scan(&eco);

        let m = idx.match_for("帮我做个ppt 谢谢");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "A");
        let text = idx.render(&m);
        assert!(text.contains("[技能]") || text.contains("# 技能: A"));
        assert!(text.contains("制作幻灯片的规范。"));

        assert!(idx.match_for("今天天气不错").is_empty());
        assert_eq!(idx.render(&[]), "");
        let _ = std::fs::remove_dir_all(&eco);
    }

    /// 热重载语义（tools.reload 后 bin 重扫）：目录新增技能即被发现。
    #[test]
    fn rescan_picks_up_new_skill() {
        let eco = temp_eco("reload");
        write_skill(
            &eco,
            "one",
            "---\nname: 一号\ntriggers: [甲]\n---\n正文一。",
        );
        let idx = SkillIndex::scan(&eco);
        assert_eq!(idx.len(), 1);

        write_skill(
            &eco,
            "two",
            "---\nname: 二号\ntriggers: [乙]\n---\n正文二。",
        );
        let idx2 = SkillIndex::scan(&eco);
        assert_eq!(idx2.len(), 2);
        assert!(idx2.match_for("乙任务").iter().any(|e| e.name == "二号"));
        let _ = std::fs::remove_dir_all(&eco);
    }
}
