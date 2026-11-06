//! 文本截断工具（D11 §2.3 truncate.rs 中进入上下文的统一截断来源）。
//!
//! 上下文区块超预算截断、归档摘要超 2k 兜底、工具结果单条超预算截断共用本模块。
//! 不变式：`estimate_tokens(结果) <= max_tokens`（截断标注本身的 token 开销已预扣）。

use crate::budget::estimate_tokens;

/// 截断尾标注（进入模型上下文，模型可据此感知"还有更多"）
pub const TRUNCATION_MARKER: &str = "…[truncated]";
/// 尾部保留（自最新一侧）时的头部标注
pub const TRUNCATION_HEAD_MARKER: &str = "…[已截断]";

/// 截到最长前缀（UTF-8 边界安全）：不超预算原样返回；超预算则截前缀并在尾部
/// 追加 `…[truncated]` 标注（标注开销预扣）。预算连标注都放不下时退化为无标注
/// 最长前缀（可能为空串）。
pub fn fit_text(text: &str, max_tokens: usize) -> String {
    if estimate_tokens(text) <= max_tokens {
        return text.to_string();
    }
    let target = max_tokens.saturating_sub(estimate_tokens(TRUNCATION_MARKER));
    if target == 0 {
        return longest_prefix(text, max_tokens).to_string();
    }
    let mut s = longest_prefix(text, target).to_string();
    s.push_str(TRUNCATION_MARKER);
    s
}

/// 截到最长后缀（保留最新一侧内容，供 truncate_oldest 退化）：不超预算原样返回；
/// 超预算则截后缀并在头部追加 `…[已截断]` 标注（开销预扣）。
pub fn fit_text_tail(text: &str, max_tokens: usize) -> String {
    if estimate_tokens(text) <= max_tokens {
        return text.to_string();
    }
    let target = max_tokens.saturating_sub(estimate_tokens(TRUNCATION_HEAD_MARKER));
    if target == 0 {
        return longest_suffix(text, max_tokens).to_string();
    }
    let mut s = String::from(TRUNCATION_HEAD_MARKER);
    s.push_str(longest_suffix(text, target));
    s
}

/// est ≤ limit 的最长前缀（估算随前缀单调不减，首次越界即可停）
fn longest_prefix(text: &str, limit_tokens: usize) -> &str {
    let mut cjk = 0usize;
    let mut ascii = 0usize;
    let mut end = 0usize;
    for (i, ch) in text.char_indices() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            cjk += 1;
        }
        if cjk + ascii.div_ceil(4) > limit_tokens {
            break;
        }
        end = i + ch.len_utf8();
    }
    &text[..end]
}

/// est ≤ limit 的最长后缀
fn longest_suffix(text: &str, limit_tokens: usize) -> &str {
    let mut cjk = 0usize;
    let mut ascii = 0usize;
    let mut start = text.len();
    for (i, ch) in text.char_indices().rev() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            cjk += 1;
        }
        if cjk + ascii.div_ceil(4) > limit_tokens {
            break;
        }
        start = i;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_text_预算内原样返回() {
        assert_eq!(fit_text("abc", 100), "abc");
        assert_eq!(fit_text("", 0), "");
    }

    #[test]
    fn fit_text_超预算截断并预扣标注开销() {
        // est("…[truncated]") = 1(…) + ceil(11/4) = 4；目标 5 → 前缀 est ≤ 1 → "你"
        let out = fit_text("你好世界你好世界", 5); // 原文 est 8
        assert_eq!(out, "你…[truncated]");
        assert_eq!(estimate_tokens(&out), 5); // 恰好等于预算
                                              // ASCII：原文 est 8，预算 6 → 前缀 8 字符（est 2）+ 标注 4 = 6
        let out = fit_text(&"a".repeat(32), 6);
        assert!(out.ends_with(TRUNCATION_MARKER));
        assert_eq!(estimate_tokens(&out), 6);
    }

    #[test]
    fn fit_text_预算小于标注时退化为无标注前缀() {
        let out = fit_text(&"a".repeat(16), 3); // 标注 est 4 > 3
        assert_eq!(out, "a".repeat(12)); // est 3，无标注
        assert!(!out.contains(TRUNCATION_MARKER));
        assert_eq!(fit_text("abc", 0), ""); // 零预算 → 空串
    }

    #[test]
    fn fit_text_tail_保留最新一侧并头标注() {
        let text: String = "前".repeat(100); // est 100
        let out = fit_text_tail(&text, 10);
        assert!(out.starts_with(TRUNCATION_HEAD_MARKER)); // est 3
        assert!(out.ends_with('前'));
        assert_eq!(estimate_tokens(&out), 10); // 3 + 7
                                               // 预算内原样返回
        assert_eq!(fit_text_tail("ab", 10), "ab");
    }
}
