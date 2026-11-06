//! compaction 状态机（D11 §5.2 伪码）。
//!
//! 摘要器以 [`Summarizer`] trait 注入：本 crate 零 IO、不依赖 aigw，由上层把
//! aigw 快模型（bullet 摘要）适配成 trait 对象。快模型失败 → `truncate_oldest`
//! 退化（保留 old 渲染文本最新一侧 ≤2k）并以 `degraded_to_truncation` 标记
//! （warn 上报由调用方负责）。压缩后仍超 T_ctx → [`crate::ContextError::OverLimit`]
//! （8010 语义）。compaction 事件发射、agent_context 持久化与关键文件 map 的
//! "不清除"均属调用方职责（本函数不触碰文件 map）。

use serde::{Deserialize, Serialize};

use crate::budget::{estimate_tokens, BudgetConfig};
use crate::truncate::{fit_text, fit_text_tail};
use crate::types::{ContextError, Round};

/// 保留最近 N 轮原文（§5.2 keep）
pub const KEEP_ROUNDS: usize = 6;

/// 归档摘要上限（≤2k tokens；不含标注行本身）
pub const ARCHIVE_MAX_TOKENS: usize = 2_048;

/// 归档段标注（§5.2：原文见本地事件镜像，UI 可从事件镜像取原文展开、不回上下文）
pub const ARCHIVE_NOTE: &str = "[已压缩摘要，原文见本地事件镜像]";

/// 摘要器抽象（实现方：aigw 快模型适配层；测试用 stub）
pub trait Summarizer {
    /// 输入待压缩原文（轮次渲染文本），返回 bullet 摘要；
    /// Err 表示快模型失败（触发 truncate_oldest 退化）
    fn summarize(&self, text: &str) -> Result<String, String>;
}

/// 一次压缩的产物
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionOutcome {
    /// 归档段（首行 [已压缩摘要] 标注 + 摘要正文 ≤2k；history ≤ KEEP_ROUNDS 时为空串）
    pub archived_summary: String,
    /// 保留的最近 KEEP_ROUNDS 轮原文
    pub kept_rounds: Vec<Round>,
    /// true = 快模型失败，退化为截断（warn 标记）
    pub degraded_to_truncation: bool,
    /// 本次压缩释放的 token 估算（old 轮估算 − 归档段估算，下限 0）
    pub freed_tokens: usize,
}

/// 执行压缩（§5.2 伪码）：
///
/// 1. keep 最近 [`KEEP_ROUNDS`] 轮原文；其余为 old；
/// 2. old 渲染成文本交 `summarizer` 摘要（≤[`ARCHIVE_MAX_TOKENS`]，超长兜底截断），
///    失败则 `truncate_oldest` 退化并置 `degraded_to_truncation`；
/// 3. 归档段首行加 [`ARCHIVE_NOTE`] 标注；
/// 4. 压缩后估算（归档 + kept）仍超 T_ctx → `Err(OverLimit)`。
pub fn compact(
    cfg: &BudgetConfig,
    history: &[Round],
    summarizer: &dyn Summarizer,
) -> Result<CompactionOutcome, ContextError> {
    let t_ctx = cfg.t_ctx_tokens();
    let keep_start = history.len().saturating_sub(KEEP_ROUNDS);
    let (old, kept) = history.split_at(keep_start);
    let old_est: usize = old.iter().map(Round::est_tokens).sum();
    let kept_est: usize = kept.iter().map(Round::est_tokens).sum();

    // 无可压缩轮次：直接透传（归档段为空，不调用快模型）
    let (body, degraded) = if old.is_empty() {
        (String::new(), false)
    } else {
        let rendered = render_rounds(old);
        match summarizer.summarize(&rendered) {
            // 摘要超 2k 上限时兜底截断（不信任快模型的长度自律）
            Ok(s) => (fit_text(&s, ARCHIVE_MAX_TOKENS), false),
            // 快模型失败 → truncate_oldest 退化：保留 old 的最新一侧 ≤2k
            Err(_) => (fit_text_tail(&rendered, ARCHIVE_MAX_TOKENS), true),
        }
    };
    let archived_summary = if body.is_empty() {
        String::new()
    } else {
        format!("{ARCHIVE_NOTE}\n{body}")
    };
    let archive_est = estimate_tokens(&archived_summary);

    // §5.2 末行：压缩后仍超 T_ctx → error(8010)
    let est_after = archive_est + kept_est;
    if est_after > t_ctx {
        return Err(ContextError::OverLimit {
            est: est_after,
            limit: t_ctx,
        });
    }

    Ok(CompactionOutcome {
        archived_summary,
        kept_rounds: kept.to_vec(),
        degraded_to_truncation: degraded,
        freed_tokens: old_est.saturating_sub(archive_est),
    })
}

/// 轮次渲染成喂给摘要器的纯文本（user/assistant/tool 三态线性化）
fn render_rounds(rounds: &[Round]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(rounds.len());
    for r in rounds {
        parts.push(match r {
            Round::User { content } => format!("[user] {content}"),
            Round::Assistant {
                content,
                tool_calls,
            } => {
                let mut s = format!("[assistant] {content}");
                for c in tool_calls {
                    s.push_str(&format!("\n[tool_call] {} ({})", c.name, c.args_digest));
                }
                s
            }
            Round::Tool {
                call_id,
                name,
                summary,
            } => {
                format!("[tool:{name}#{call_id}] {summary}")
            }
        });
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// est 恰为 tokens 的 User 轮（尾部标记便于识别）
    fn round_est(tag: &str, tokens: usize) -> Round {
        Round::User {
            content: format!("{}{}", "a".repeat((tokens - 1) * 4), tag),
        }
    }

    /// 固定返回小摘要的 stub
    struct OkSummarizer;
    impl Summarizer for OkSummarizer {
        fn summarize(&self, _text: &str) -> Result<String, String> {
            Ok("要点1：完成A；要点2：进行B".to_string())
        }
    }

    /// 恒失败的 stub（模拟快模型不可用）
    struct FailSummarizer;
    impl Summarizer for FailSummarizer {
        fn summarize(&self, _text: &str) -> Result<String, String> {
            Err("快模型不可用".to_string())
        }
    }

    /// 返回超长摘要的 stub（5000 tokens）
    struct OverlongSummarizer;
    impl Summarizer for OverlongSummarizer {
        fn summarize(&self, _text: &str) -> Result<String, String> {
            Ok("字".repeat(5_000))
        }
    }

    #[test]
    fn 压缩_不足keep轮数直接透传() {
        let cfg = BudgetConfig::default();
        let history: Vec<Round> = (0..3).map(|i| round_est(&format!("t{i}"), 100)).collect();
        let out = compact(&cfg, &history, &OkSummarizer).unwrap();
        assert_eq!(out.kept_rounds.len(), 3);
        assert_eq!(out.archived_summary, ""); // 无归档段
        assert!(!out.degraded_to_truncation);
        assert_eq!(out.freed_tokens, 0);

        // 恰好 6 轮：同样无 old
        let history: Vec<Round> = (0..6).map(|i| round_est(&format!("t{i}"), 100)).collect();
        let out = compact(&cfg, &history, &FailSummarizer).unwrap();
        assert_eq!(out.kept_rounds.len(), 6);
        assert_eq!(out.archived_summary, "");
        assert!(!out.degraded_to_truncation); // 未触发摘要器
    }

    #[test]
    fn 压缩_keep最近6轮并注入归档标注() {
        let cfg = BudgetConfig::default();
        let history: Vec<Round> = (0..10)
            .map(|i| round_est(&format!("t{i:02}"), 1_000))
            .collect();
        let out = compact(&cfg, &history, &OkSummarizer).unwrap();
        assert!(!out.degraded_to_truncation);
        assert_eq!(out.kept_rounds.len(), 6);
        // 保留的是最近 6 轮（t04..t09），最旧的 4 轮被归档
        assert!(matches!(&out.kept_rounds[0], Round::User { content } if content.ends_with("t04")));
        assert!(matches!(&out.kept_rounds[5], Round::User { content } if content.ends_with("t09")));
        // 归档段首行带 §5.2 标注
        assert!(out
            .archived_summary
            .starts_with("[已压缩摘要，原文见本地事件镜像]\n"));
        // 释放量 = old 4000 − 归档段（摘要很短）
        assert!(out.freed_tokens >= 3_000, "freed={}", out.freed_tokens);
    }

    #[test]
    fn 压缩_摘要器失败退化为截断并标记() {
        let cfg = BudgetConfig::default();
        let history: Vec<Round> = (0..10)
            .map(|i| round_est(&format!("t{i:02}"), 1_000))
            .collect();
        let out = compact(&cfg, &history, &FailSummarizer).unwrap();
        assert!(out.degraded_to_truncation); // warn 标记
        assert!(out.archived_summary.contains(ARCHIVE_NOTE));
        assert!(out.archived_summary.contains("…[已截断]")); // truncate_oldest 的头标注
                                                             // 退化产物 ≤ 2k + 标注行开销
        assert!(estimate_tokens(&out.archived_summary) <= ARCHIVE_MAX_TOKENS + 32);
        assert_eq!(out.kept_rounds.len(), 6);
        assert!(out.freed_tokens > 0); // 4000 − ~2k 仍有释放
    }

    #[test]
    fn 压缩_摘要超2k兜底截断() {
        let cfg = BudgetConfig::default();
        let history: Vec<Round> = (0..10)
            .map(|i| round_est(&format!("t{i:02}"), 1_000))
            .collect();
        let out = compact(&cfg, &history, &OverlongSummarizer).unwrap();
        assert!(!out.degraded_to_truncation); // Ok 路径，只是内容超长被截
        assert!(estimate_tokens(&out.archived_summary) <= ARCHIVE_MAX_TOKENS + 32);
        assert!(out.archived_summary.contains("[truncated]"));
    }

    #[test]
    fn 压缩_压缩后仍超限返回over_limit() {
        let cfg = BudgetConfig {
            window_tokens: 2_000,
        }; // T_ctx=1800
           // 10 轮 × 1000：keep 6 轮即 6000 > 1800，无论归档多短都超
        let history: Vec<Round> = (0..10)
            .map(|i| round_est(&format!("t{i:02}"), 1_000))
            .collect();
        let err = compact(&cfg, &history, &OkSummarizer).unwrap_err();
        match err {
            ContextError::OverLimit { est, limit } => {
                assert_eq!(limit, 1_800);
                assert!(est >= 6_000, "est={est}");
            }
        }
        // Display 携带 8010 提示语
        let msg = format!(
            "{}",
            ContextError::OverLimit {
                est: 100,
                limit: 50
            }
        );
        assert!(msg.contains("8010"));
    }

    #[test]
    fn 压缩_轮次渲染包含三态() {
        let rounds = vec![
            Round::User {
                content: "看下日志".to_string(),
            },
            Round::Assistant {
                content: "好的".to_string(),
                tool_calls: vec![crate::types::ToolCallRecord {
                    id: "t1".to_string(),
                    name: "bash".to_string(),
                    args_digest: "tail -n 100".to_string(),
                }],
            },
            Round::Tool {
                call_id: "t1".to_string(),
                name: "bash".to_string(),
                summary: "exit 0".to_string(),
            },
        ];
        let text = render_rounds(&rounds);
        assert!(text.contains("[user] 看下日志"));
        assert!(text.contains("[assistant] 好的"));
        assert!(text.contains("[tool_call] bash (tail -n 100)"));
        assert!(text.contains("[tool:bash#t1] exit 0"));
    }
}
