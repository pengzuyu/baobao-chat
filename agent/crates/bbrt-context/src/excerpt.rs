//! read_file 摘录与敏感路径判定（D11 §5.3）。
//!
//! 摘录策略：默认起始 400 行或 32KB（先到为准）；每行带 `{n} ` 行号前缀；
//! 未读完时尾部标注 `[truncated, offset=X]`（X 为本段起始行），模型可带
//! offset/limit 分页续读。二进制/非 UTF-8 拒读属工具层（返回元信息），本模块
//! 只处理已确认为 UTF-8 的文本内容。敏感文件名单判定（默认拒 8026）在此处
//! 纯逻辑化，供工具管线复用。

use serde::{Deserialize, Serialize};

/// 默认行数上限（起始 400 行）
pub const DEFAULT_EXCERPT_LIMIT_LINES: usize = 400;

/// 默认字节上限（32KB，含行号前缀；与行数先到为准）
pub const DEFAULT_EXCERPT_MAX_BYTES: usize = 32 * 1024;

/// 文件摘录结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    /// 带行号的摘录正文（`{n} {line}` 每行；截断时末行附 `[truncated, offset=X]`）
    pub body: String,
    /// 是否还有未读内容（字节上限早停 / 窗口未到文件尾 / 行内字节截断）
    pub truncated: bool,
    /// 文件总行数（供模型决定是否分页续读）
    pub total_lines: usize,
}

/// 摘录文件内容：自 `offset_line`（1 起）取 `limit_lines` 行，总字节不超过
/// [`DEFAULT_EXCERPT_MAX_BYTES`]（先到为准）。
///
/// - `offset_line` 0 视为 1；`limit_lines` 0 视为默认 400；
/// - 单行即超 32KB 时按 UTF-8 边界截断该行，保证窗口内总有内容；
/// - `truncated` = 仍有未读内容（含"窗口读满但文件未到尾"，此时标注提示续读）。
pub fn excerpt(content: &str, offset_line: usize, limit_lines: usize) -> Excerpt {
    let offset = offset_line.max(1);
    let limit = if limit_lines == 0 {
        DEFAULT_EXCERPT_LIMIT_LINES
    } else {
        limit_lines
    };
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    let start = (offset - 1).min(total); // 越界（offset 超过 EOF）→ 空窗口
    let end = (start + limit).min(total);

    let mut body = String::new();
    let mut served_until = start;
    let mut partial_line = false;
    for (i, line) in lines.iter().enumerate().skip(start).take(end - start) {
        let numbered = format!("{} {}", i + 1, line);
        if body.len() + numbered.len() + 1 > DEFAULT_EXCERPT_MAX_BYTES {
            if body.is_empty() && !line.is_empty() {
                // 窗口首行单独超 32KB：按字节（UTF-8 边界）截断该行，保证有内容可读
                let prefix_len = format!("{} ", i + 1).len();
                let room = DEFAULT_EXCERPT_MAX_BYTES.saturating_sub(prefix_len + 1);
                body.push_str(&format!("{} {}", i + 1, byte_cut(line, room)));
                served_until = i + 1;
                partial_line = true;
            }
            break;
        }
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&numbered);
        served_until = i + 1;
    }

    let truncated = partial_line || served_until < total;
    if truncated {
        body.push_str(&format!("\n[truncated, offset={}]", offset));
    }
    Excerpt {
        body,
        truncated,
        total_lines: total,
    }
}

/// 敏感路径判定（D11 §5.3 默认拒读名单 8026）：`.env*` / `*.pem` / `id_rsa*` /
/// `*credentials*` / `.npmrc`，按文件名（最后一个路径段）匹配。
///
/// `.env*` 收窄为 `.env` 本名或后跟 `.`/`-`/`_` 分隔（`.env.local`、`.env-production`），
/// 避免 `.environment` 之类同前缀的正常文件被误伤。大小写敏感。
pub fn is_sensitive_path(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name == ".npmrc"
        || name == ".env"
        || name.starts_with(".env.")
        || name.starts_with(".env-")
        || name.starts_with(".env_")
        || name.ends_with(".pem")
        || name.starts_with("id_rsa")
        || name.contains("credentials")
}

/// 按字节上限截断（落到 UTF-8 字符边界）
fn byte_cut(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成 n 行的文件内容（每行 "l{i}"）
    fn lines_file(n: usize) -> String {
        (1..=n)
            .map(|i| format!("l{i}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn 摘录_短文件全量返回带行号() {
        let ex = excerpt("a\nb\nc\nd\ne", 1, 400);
        assert_eq!(ex.total_lines, 5);
        assert!(!ex.truncated);
        assert_eq!(ex.body, "1 a\n2 b\n3 c\n4 d\n5 e");
    }

    #[test]
    fn 摘录_空文件() {
        let ex = excerpt("", 1, 400);
        assert_eq!(ex.total_lines, 0);
        assert!(!ex.truncated);
        assert_eq!(ex.body, "");
    }

    #[test]
    fn 摘录_默认400行先到并标注续读() {
        let content = lines_file(500);
        let ex = excerpt(&content, 1, 400); // 默认区间
        assert_eq!(ex.total_lines, 500);
        assert!(ex.truncated);
        assert!(ex.body.starts_with("1 l1\n2 l2"));
        assert!(ex.body.contains("\n400 l400"));
        assert!(!ex.body.contains("401 l401"));
        assert_eq!(ex.body.lines().count(), 401); // 400 行 + 标注行
        assert!(ex.body.ends_with("[truncated, offset=1]"));
    }

    #[test]
    fn 摘录_恰好400行不带标注() {
        let content = lines_file(400);
        let ex = excerpt(&content, 1, 400);
        assert_eq!(ex.total_lines, 400);
        assert!(!ex.truncated); // 读到文件尾
        assert!(ex.body.ends_with("400 l400"));
    }

    #[test]
    fn 摘录_32kb先到为准() {
        // 100 行 × 500 字符 ≈ 50KB：行数未到 400，字节先触顶
        let content = (1..=100)
            .map(|_| "a".repeat(500))
            .collect::<Vec<_>>()
            .join("\n");
        let ex = excerpt(&content, 1, 400);
        assert_eq!(ex.total_lines, 100);
        assert!(ex.truncated);
        assert!(ex.body.ends_with("[truncated, offset=1]"));
        // 正文（含行号与标注）不超过 32KB + 标注行
        assert!(
            ex.body.len() < DEFAULT_EXCERPT_MAX_BYTES + 64,
            "len={}",
            ex.body.len()
        );
        assert!(ex.body.len() > DEFAULT_EXCERPT_MAX_BYTES - 2_000); // 确实贴近上限
        assert!(!ex.body.contains("\n90 ")); // 第 90 行应已被字节上限截掉
    }

    #[test]
    fn 摘录_offset分页续读() {
        let content = lines_file(500);
        // 自 401 行读 100 行 → 恰好读到文件尾，无标注
        let ex = excerpt(&content, 401, 100);
        assert!(!ex.truncated);
        assert!(ex.body.starts_with("401 l401"));
        assert!(ex.body.ends_with("500 l500"));
        assert_eq!(ex.body.lines().count(), 100);
        // 自 451 行读 25 行 → 窗口未到尾，标注本段 offset
        let ex = excerpt(&content, 451, 25);
        assert!(ex.truncated);
        assert!(ex.body.starts_with("451 l451"));
        assert!(ex.body.contains("475 l475"));
        assert!(ex.body.ends_with("[truncated, offset=451]"));
    }

    #[test]
    fn 摘录_offset越界与归一() {
        let content = lines_file(5);
        let ex = excerpt(&content, 10, 100); // 越过 EOF：空窗口，不误报截断
        assert_eq!(ex.total_lines, 5);
        assert!(!ex.truncated);
        assert_eq!(ex.body, "");
        let ex = excerpt(&content, 0, 0); // 0 归一为默认 1..=400
        assert_eq!(ex.body, "1 l1\n2 l2\n3 l3\n4 l4\n5 l5");
        assert!(!ex.truncated);
    }

    #[test]
    fn 摘录_单行超32kb按字节截断() {
        let content = "x".repeat(60_000); // 无换行的超长单行
        let ex = excerpt(&content, 1, 400);
        assert_eq!(ex.total_lines, 1);
        assert!(ex.truncated);
        assert!(ex.body.len() < DEFAULT_EXCERPT_MAX_BYTES + 64);
        assert!(ex.body.ends_with("[truncated, offset=1]"));
    }

    #[test]
    fn 敏感路径_名单命中() {
        for hit in [
            ".env",
            ".env.local",
            ".env.production",
            "/home/u/proj/.env",
            "cert.pem",
            "keys/server.pem",
            "id_rsa",
            "id_rsa.pub",
            "/Users/u/.ssh/id_rsa",
            "app_credentials.json",
            "credentials",
            "my-credentials.yaml",
            "/srv/app/.npmrc",
        ] {
            assert!(is_sensitive_path(hit), "应命中: {hit}");
        }
    }

    #[test]
    fn 敏感路径_不误伤正常文件() {
        for miss in [
            ".environment", // 同前缀但非 env 文件（§5.3 名单收窄）
            "environment.py",
            "readme.md",
            "foo.pem.txt", // pem 只是中缀不是扩展名
            "pem.txt",
            "xid_rsax",   // id_rsa 非前缀
            "creds.json", // 缩写不在名单
            "npmrc",      // 无点前缀
            "main.rs",
            "dir/.env.d/backup", // 目录段含 .env.d：basename 是 backup，不命中
        ] {
            assert!(!is_sensitive_path(miss), "不应命中: {miss}");
        }
    }
}
