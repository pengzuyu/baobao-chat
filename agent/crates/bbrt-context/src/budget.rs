//! token 预算公式与估算（D11 §5.1）。
//!
//! - `W = min(模型窗口, 租户上限)`，默认 128k（租户/模型差异由上层折算后传入
//!   [`BudgetConfig`]）；
//! - `T_out = 10% × W` 输出预留（不占上下文）；`T_ctx = W − T_out`；
//! - 区块预算（T_ctx 占比）：system 5% | 技能 5% | 项目 10% | 历史 40% | 工具结果 30%；
//!   §5.1 未单列记忆索引，取 5+5+10+40+30=90% 之外的 10% 余量（不参与让渡）；
//! - 软上限：`estimate(history) + estimate(tool_results) ≥ 75% × (40%+30%) × T_ctx`
//!   触发 compaction（见 [`budget_report`]）。
//!
//! `estimate_tokens` 启发式：CJK/非 ASCII 1 字 ≈ 1 token，ASCII 4 字符 ≈ 1 token
//! （向上取整，按字符类别累计、与切分位置无关）。"每模型校准表修正"为 D11 §13
//! 开放问题 3（阶段三接入网关 usage 回填），当前不修正。

use serde::{Deserialize, Serialize};

use crate::types::{Round, ToolResultEntry};

/// 默认模型窗口 W（128k；D11 §5.1）
pub const DEFAULT_WINDOW_TOKENS: usize = 128_000;

/// 输出预留占比：T_out = 10% × W（任何区块不得挤占）
pub const OUT_RESERVE_PERCENT: usize = 10;

/// system 区块占比（T_ctx 的 5%）
pub const SYSTEM_SHARE_PERCENT: usize = 5;
/// 技能区块占比（T_ctx 的 5%）
pub const SKILLS_SHARE_PERCENT: usize = 5;
/// 项目上下文区块占比（T_ctx 的 10%）
pub const PROJECT_SHARE_PERCENT: usize = 10;
/// 会话历史区块占比（T_ctx 的 40%）
pub const HISTORY_SHARE_PERCENT: usize = 40;
/// 工具结果区块占比（T_ctx 的 30%）
pub const TOOL_RESULTS_SHARE_PERCENT: usize = 30;
/// 记忆索引占比：§5.1 分配表未单列，占用 T_ctx 剩余 10% 余量（5+5+10+40+30=90）
pub const MEMORY_INDEX_SHARE_PERCENT: usize = 10;
/// 软上限占比：相对（历史 + 工具结果）区块预算合计的 75%
pub const SOFT_LIMIT_PERCENT: usize = 75;

/// 单张图片的上下文 token 固定估算（2026-11-26 视觉通道）：图片以图像段进请求体，
/// 文本启发式估不出——按主流视觉模型 1k 出头的量级取值，只保证预算不被零成本漏记
pub const IMAGE_TOKENS: usize = 1_100;

/// token 预算配置（W 已由上层按 `min(模型窗口, 租户上限)` 折算）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetConfig {
    /// 模型窗口 W（tokens）
    pub window_tokens: usize,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            window_tokens: DEFAULT_WINDOW_TOKENS,
        }
    }
}

impl BudgetConfig {
    /// 输出预留 T_out = 10% × W（不占上下文）
    pub fn t_out_tokens(&self) -> usize {
        self.window_tokens * OUT_RESERVE_PERCENT / 100
    }

    /// 可用上下文 T_ctx = W − T_out
    pub fn t_ctx_tokens(&self) -> usize {
        self.window_tokens - self.t_out_tokens()
    }
}

/// 文本 token 估算（启发式：非 ASCII 1 字 ≈ 1 token；ASCII 4 字符 ≈ 1 token 向上取整）。
///
/// 按字符类别累计、与切分位置无关：`"你a好b"` = 2 CJK + 2 ASCII = 2 + 1 = 3。
pub fn estimate_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut ascii = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            cjk += 1;
        }
    }
    cjk + ascii.div_ceil(4)
}

/// §5.1 区块预算表（均为 T_ctx 的整数百分比，逐级向下取整）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockBudgets {
    /// system 区块预算
    pub system: usize,
    /// 技能区块预算
    pub skills: usize,
    /// 项目上下文区块预算
    pub project: usize,
    /// 记忆索引区块预算（T_ctx 剩余 10% 余量）
    pub memory_index: usize,
    /// 会话历史区块预算
    pub history: usize,
    /// 工具结果区块预算
    pub tool_results: usize,
}

/// 计算区块预算表（§5.1 分配表；弹性让渡在 assemble 内叠加）
pub fn block_budgets(cfg: &BudgetConfig) -> BlockBudgets {
    let t_ctx = cfg.t_ctx_tokens();
    let pct = |share: usize| t_ctx * share / 100;
    BlockBudgets {
        system: pct(SYSTEM_SHARE_PERCENT),
        skills: pct(SKILLS_SHARE_PERCENT),
        project: pct(PROJECT_SHARE_PERCENT),
        memory_index: pct(MEMORY_INDEX_SHARE_PERCENT),
        history: pct(HISTORY_SHARE_PERCENT),
        tool_results: pct(TOOL_RESULTS_SHARE_PERCENT),
    }
}

/// 预算体检报告（软上限判定，供会话层决定是否触发 compaction）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetReport {
    /// 可用上下文 T_ctx
    pub t_ctx: usize,
    /// 软上限 = 75% × (40%+30%) × T_ctx
    pub soft_limit: usize,
    /// 会话历史 token 估算
    pub history_est: usize,
    /// 工具结果 token 估算（各条目 est_tokens 之和）
    pub tool_results_est: usize,
    /// 是否达到软上限（≥ 触发 compaction）
    pub needs_compaction: bool,
}

/// 体检：按 §5.1 公式计算历史/工具结果估算与软上限触发。
///
/// 工具结果以 `ToolResultEntry::est_tokens` 为准（调用方口径，见该字段文档）。
pub fn budget_report(
    cfg: &BudgetConfig,
    history: &[Round],
    tool_results: &[ToolResultEntry],
) -> BudgetReport {
    let t_ctx = cfg.t_ctx_tokens();
    let bb = block_budgets(cfg);
    let soft_limit = (bb.history + bb.tool_results) * SOFT_LIMIT_PERCENT / 100;
    let history_est = history.iter().map(Round::est_tokens).sum();
    let tool_results_est = tool_results.iter().map(|e| e.est_tokens).sum();
    BudgetReport {
        t_ctx,
        soft_limit,
        history_est,
        tool_results_est,
        needs_compaction: history_est + tool_results_est >= soft_limit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_est(tokens: usize) -> Round {
        // 构造 est_tokens == tokens 的 User 轮（ASCII 4 字符 ≈ 1 token）
        Round::User {
            content: "a".repeat(tokens * 4),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn estimate_用户轮图片按固定估算计入() {
        // 文本 3 + 图片 1 张（IMAGE_TOKENS）+ 路径 "/a.png"（2）+ 文件名 "a.png"（2）
        let r = Round::User {
            content: "你好abc".to_string(),
            attachments: vec![crate::types::AttachmentRef {
                path: "/a.png".to_string(),
                kind: crate::types::AttachmentKind::Image,
                name: "a.png".to_string(),
                size: 1,
                mime: None,
            }],
        };
        assert_eq!(r.est_tokens(), 3 + IMAGE_TOKENS + 2 + 2);
        // 普通文件附件不计图片估算
        let f = Round::User {
            content: String::new(),
            attachments: vec![crate::types::AttachmentRef {
                path: "/a.pdf".to_string(),
                kind: crate::types::AttachmentKind::File,
                name: "a.pdf".to_string(),
                size: 1,
                mime: None,
            }],
        };
        assert_eq!(f.est_tokens(), 2 + 2);
    }

    #[test]
    fn estimate_纯cjk_一字一token() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("你好"), 2);
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn estimate_纯ascii_四字符一token_向上取整() {
        assert_eq!(estimate_tokens("a"), 1); // ceil(1/4)
        assert_eq!(estimate_tokens("aaa"), 1);
        assert_eq!(estimate_tokens("aaaa"), 1);
        assert_eq!(estimate_tokens("aaaaa"), 2);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
    }

    #[test]
    fn estimate_中英混合_按类别累计与位置无关() {
        assert_eq!(estimate_tokens("你好abc"), 2 + 1); // 2 CJK + ceil(3/4)
        assert_eq!(estimate_tokens("ab你好"), 1 + 2);
        assert_eq!(estimate_tokens("你a好b"), 2 + 1); // 交错不影响结果
        assert_eq!(estimate_tokens("你好world"), 2 + 2); // ceil(5/4)=2
    }

    #[test]
    fn 默认配置_t_out与t_ctx() {
        let cfg = BudgetConfig::default();
        assert_eq!(cfg.window_tokens, 128_000);
        assert_eq!(cfg.t_out_tokens(), 12_800); // 10% × W，不占上下文
        assert_eq!(cfg.t_ctx_tokens(), 115_200);
    }

    #[test]
    fn 区块预算_各比例() {
        let bb = block_budgets(&BudgetConfig::default());
        assert_eq!(bb.system, 5_760); // 5% × 115200
        assert_eq!(bb.skills, 5_760);
        assert_eq!(bb.project, 11_520); // 10%
        assert_eq!(bb.memory_index, 11_520); // 剩余 10% 余量
        assert_eq!(bb.history, 46_080); // 40%
        assert_eq!(bb.tool_results, 34_560); // 30%
    }

    #[test]
    fn budget_report_未达软上限() {
        let cfg = BudgetConfig::default();
        // 60 轮 × 1000 = 60000 < 60480
        let history: Vec<Round> = (0..60).map(|_| round_est(1_000)).collect();
        let report = budget_report(&cfg, &history, &[]);
        assert_eq!(report.t_ctx, 115_200);
        assert_eq!(report.soft_limit, 60_480); // 75% × (46080+34560)
        assert_eq!(report.history_est, 60_000);
        assert_eq!(report.tool_results_est, 0);
        assert!(!report.needs_compaction);
    }

    #[test]
    fn budget_report_达到软上限触发压缩() {
        let cfg = BudgetConfig::default();
        let history: Vec<Round> = (0..61).map(|_| round_est(1_000)).collect();
        let report = budget_report(&cfg, &history, &[]);
        assert_eq!(report.history_est, 61_000);
        assert!(report.needs_compaction); // 61000 ≥ 60480

        // 历史 + 工具结果合并计：55000 + 6000 = 61000 ≥ 60480
        let history: Vec<Round> = (0..55).map(|_| round_est(1_000)).collect();
        let tools: Vec<ToolResultEntry> = (0..3)
            .map(|i| ToolResultEntry {
                call_id: format!("c{i}"),
                name: "read_file".to_string(),
                summary: String::new(),
                est_tokens: 2_000,
            })
            .collect();
        let report = budget_report(&cfg, &history, &tools);
        assert_eq!(report.tool_results_est, 6_000);
        assert!(report.needs_compaction);
    }

    #[test]
    fn budget_report_工具结果按est_tokens口径() {
        // summary 为空但 est_tokens 有值：按 est_tokens 计，不按 summary 文本
        let tools = vec![ToolResultEntry {
            call_id: "c1".to_string(),
            name: "bash".to_string(),
            summary: String::new(),
            est_tokens: 7_777,
        }];
        let report = budget_report(&BudgetConfig::default(), &[], &tools);
        assert_eq!(report.tool_results_est, 7_777);
    }
}
