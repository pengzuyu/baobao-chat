//! AGENTS.md 白名单声明解析（缺口修复 2026-11-24：v0.1 白名单通道恒空，
//! `ToolsConfig.whitelist_prefixes` 无生产装配方——AGENTS.md 白名单拍板了
//! 却从未接上）。
//!
//! 项目 AGENTS.md 中以围栏代码块声明免确认命令前缀（D32 拍板 #4：白名单=
//! 「系统构建工具直调」专属——命中仍须过 gate 的 `is_plain_direct_invocation`
//! 守卫与危险规则扫描，白名单只免确认不免规则）：
//!
//! ````text
//! ```bbc-whitelist
//! cargo test
//! go build ./...
//! # 注释行跳过
//! ```
//! ````
//!
//! 解析口径：info 串首 token 恰为 `bbc-whitelist` 的围栏块全部合并；条目=
//! trim 后非空、非 `#` 注释、可剥列表符号 `- ` 的行；去重保序。加载按会话
//! 工作区单源（项目会话=项目根 AGENTS.md，日常会话=默认用户工作区），
//! `config.whitelist_prefixes` 保留为全局手工通道合并项。

/// 解析 AGENTS.md 中全部 `bbc-whitelist` 围栏块，返回去重保序的命令前缀清单
pub fn parse_agents_whitelist(md: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_block = false;
    for line in md.lines() {
        let t = line.trim();
        if !in_block {
            if t.starts_with("```") && info_is_whitelist(t) {
                in_block = true;
            }
            continue;
        }
        if t.starts_with("```") {
            in_block = false;
            continue;
        }
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        // 容错：剥 markdown 列表符号（围栏内写 `- cargo test` 的习惯写法）
        let entry = t.strip_prefix("- ").unwrap_or(t).trim().to_string();
        if !entry.is_empty() && !out.contains(&entry) {
            out.push(entry);
        }
    }
    out
}

/// 围栏 info 串判定：首 token 恰为 `bbc-whitelist`（`` ``` `` 独立行自然落空）
fn info_is_whitelist(fence: &str) -> bool {
    fence.trim_start_matches('`')
        .split_whitespace()
        .next()
        .is_some_and(|lang| lang == "bbc-whitelist")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic_block() {
        let md = "# 项目说明\n\n```bbc-whitelist\ncargo test\ngo build ./...\n```\n\n正文";
        assert_eq!(parse_agents_whitelist(md), vec!["cargo test", "go build ./..."]);
    }

    #[test]
    fn parse_skips_comments_blanks_and_bullets() {
        let md = "```bbc-whitelist\n# 构建类\ncargo build\n\ncargo test\n- npm run lint\n```\n";
        assert_eq!(
            parse_agents_whitelist(md),
            vec!["cargo build", "cargo test", "npm run lint"]
        );
    }

    #[test]
    fn parse_merges_blocks_and_dedupes() {
        let md = "```bbc-whitelist\ncargo test\n```\n中间正文 ```bbc-whitelist 不会误开（不在行首形态也无所谓，按行扫描）\n```bbc-whitelist\ngo vet\ncargo test\n```";
        assert_eq!(parse_agents_whitelist(md), vec!["cargo test", "go vet"]);
    }

    #[test]
    fn other_fences_ignored() {
        let md = "```bash\ncargo test\n```\n```bbc-whitelist-sh\ngo test\n```";
        assert!(parse_agents_whitelist(md).is_empty());
    }

    #[test]
    fn no_block_returns_empty() {
        assert!(parse_agents_whitelist("纯说明文档，无声明").is_empty());
        assert!(parse_agents_whitelist("").is_empty());
    }
}
