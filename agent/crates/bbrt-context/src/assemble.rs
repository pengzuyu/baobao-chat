//! 上下文组装（D11 §2.3 assemble.rs + §5.1 弹性规则）。
//!
//! 六个区块：system / 技能 / 项目 / 记忆索引 / 会话历史 / 工具结果。
//! - 文本区块超自身预算即截断（尾部 `…[truncated]` 标注）；
//! - 弹性让渡：技能、项目两块未用满的余量按 4:3 让渡给 历史+工具结果
//!   （system 与记忆索引不让渡）；
//! - 历史自最新一轮向前整轮装填（保持后缀连续，不"跳轮"），仅剩单轮且超预算时
//!   就地截断该轮；工具结果同理，单条超预算时截 summary 并重写 est_tokens；
//! - 任何区块不得挤占 T_out：全部区块预算合计 = T_ctx，组装结果 est_tokens ≤ T_ctx。

use serde::{Deserialize, Serialize};

use crate::budget::{block_budgets, estimate_tokens, BudgetConfig};
use crate::truncate::fit_text;
use crate::types::{Round, ToolCallRecord, ToolResultEntry};

/// 组装输入（借用视图：调用方持有原文，组装产出裁剪后的 Owned 副本）
#[derive(Debug, Clone, Copy)]
pub struct AssembleParts<'a> {
    /// 系统提示词
    pub system: &'a str,
    /// 技能描述（命中技能的拼装文本）
    pub skills: &'a str,
    /// 项目上下文（AGENTS.md + 关键文件 map + git 摘要等拼装文本）
    pub project: &'a str,
    /// 记忆索引（D15 双轨记忆的索引段）
    pub memory_index: &'a str,
    /// 会话历史（时间升序）
    pub history: &'a [Round],
    /// 工具结果条目（时间升序）
    pub tool_results: &'a [ToolResultEntry],
}

/// 组装产物（各区块裁剪后的最终形态 + 总估算）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assembled {
    /// 裁剪后的系统提示词
    pub system: String,
    /// 裁剪后的技能段
    pub skills: String,
    /// 裁剪后的项目上下文段
    pub project: String,
    /// 裁剪后的记忆索引段
    pub memory_index: String,
    /// 保留的历史轮次（原时间序的连续后缀；单轮超预算时可能被就地截断）
    pub history: Vec<Round>,
    /// 保留的工具结果条目（原时间序的连续后缀）
    pub tool_results: Vec<ToolResultEntry>,
    /// 全部区块 token 估算合计（≤ T_ctx）
    pub est_tokens: usize,
    /// 任一区块发生截断/丢弃即为 true
    pub truncated: bool,
}

/// 组装上下文：区块截断 + 弹性让渡 + 历史/工具结果装填。
pub fn assemble(cfg: &BudgetConfig, parts: AssembleParts) -> Assembled {
    let bb = block_budgets(cfg);

    // 1) 文本区块：超自身预算即截断（尾部 …[truncated] 标注）
    let (system, sys_t) = fit_block(parts.system, bb.system);
    let (skills, skill_t) = fit_block(parts.skills, bb.skills);
    let (project, proj_t) = fit_block(parts.project, bb.project);
    let (memory_index, mem_t) = fit_block(parts.memory_index, bb.memory_index);

    // 2) 弹性让渡（§5.1）：技能/项目未用满的余量按 4:3 让渡给 历史+工具结果
    let leftover =
        (bb.skills - estimate_tokens(&skills)) + (bb.project - estimate_tokens(&project));
    let history_budget = bb.history + leftover * 4 / 7;
    let tool_budget = bb.tool_results + leftover * 3 / 7;

    // 3) 历史与工具结果装填（自最新向前；整轮/整条优先）
    let (history, hist_t) = pack_rounds(parts.history, history_budget);
    let (tool_results, tool_t) = pack_tool_results(parts.tool_results, tool_budget);

    // 4) 总估算：六区块求和（区块预算合计 = T_ctx，故 est_tokens ≤ T_ctx，不挤占 T_out）
    let est_tokens = estimate_tokens(&system)
        + estimate_tokens(&skills)
        + estimate_tokens(&project)
        + estimate_tokens(&memory_index)
        + history.iter().map(Round::est_tokens).sum::<usize>()
        + tool_results.iter().map(|e| e.est_tokens).sum::<usize>();

    Assembled {
        system,
        skills,
        project,
        memory_index,
        history,
        tool_results,
        est_tokens,
        truncated: sys_t || skill_t || proj_t || mem_t || hist_t || tool_t,
    }
}

/// 文本区块截断：预算内原样克隆；超预算 fit_text（带尾标注）
fn fit_block(text: &str, budget: usize) -> (String, bool) {
    if estimate_tokens(text) <= budget {
        (text.to_string(), false)
    } else {
        (fit_text(text, budget), true)
    }
}

/// 历史装填：自最新一轮向前整轮累加，装不下即停（更旧轮次被丢弃；保持后缀连续
/// 不跳轮）。最新单轮即超预算时就地截断该轮——丢掉最新一轮不可接受。
fn pack_rounds(history: &[Round], budget: usize) -> (Vec<Round>, bool) {
    let mut kept_rev: Vec<Round> = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;
    for r in history.iter().rev() {
        let est = r.est_tokens();
        if used + est <= budget {
            used += est;
            kept_rev.push(r.clone());
        } else if kept_rev.is_empty() {
            // 单轮超预算：截断保留（est(r) > budget 必然发生截断）
            let fitted = fit_round(r, budget);
            truncated = true;
            used += fitted.est_tokens();
            kept_rev.push(fitted);
        } else {
            truncated = true; // 更旧轮次被丢弃
            break;
        }
    }
    kept_rev.reverse();
    (kept_rev, truncated)
}

/// 工具结果装填：自最新一条向前整条累加；单条超预算时截 summary 到预算内，
/// est_tokens 重写为截断后实际携带成本。
fn pack_tool_results(entries: &[ToolResultEntry], budget: usize) -> (Vec<ToolResultEntry>, bool) {
    let mut kept_rev: Vec<ToolResultEntry> = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;
    for e in entries.iter().rev() {
        if used + e.est_tokens <= budget {
            used += e.est_tokens;
            kept_rev.push(e.clone());
        } else if kept_rev.is_empty() {
            let summary = fit_text(&e.summary, budget);
            let est = estimate_tokens(&summary);
            truncated = true;
            used += est;
            kept_rev.push(ToolResultEntry {
                call_id: e.call_id.clone(),
                name: e.name.clone(),
                summary,
                est_tokens: est,
            });
        } else {
            truncated = true; // 更旧条目被丢弃
            break;
        }
    }
    kept_rev.reverse();
    (kept_rev, truncated)
}

/// 单轮就地截断：id/name 等协议回填必需的小字段保留，可变文本（content /
/// args_digest / summary）按占比分配预算；结果 est ≤ max（小字段先天超预算的
/// 极端配置除外，由上层 OverLimit 兜底）。
fn fit_round(r: &Round, max: usize) -> Round {
    if r.est_tokens() <= max {
        return r.clone();
    }
    match r {
        Round::User { content } => Round::User {
            content: fit_text(content, max),
        },
        Round::Tool {
            call_id,
            name,
            summary,
        } => {
            // call_id/name 为回填必需字段：先扣除其开销，剩余给 summary
            let fixed = estimate_tokens(call_id) + estimate_tokens(name);
            let budget = max.saturating_sub(fixed);
            Round::Tool {
                call_id: call_id.clone(),
                name: name.clone(),
                summary: fit_text(summary, budget),
            }
        }
        Round::Assistant {
            content,
            tool_calls,
        } => {
            let fixed: usize = tool_calls
                .iter()
                .map(|c| estimate_tokens(&c.id) + estimate_tokens(&c.name))
                .sum();
            let free = max.saturating_sub(fixed);
            let content_est = estimate_tokens(content);
            let digest_est_total: usize = tool_calls
                .iter()
                .map(|c| estimate_tokens(&c.args_digest))
                .sum();
            let var_total = content_est + digest_est_total;
            if var_total == 0 {
                // 无可变文本：仅保留小字段
                return Round::Assistant {
                    content: content.clone(),
                    tool_calls: tool_calls.clone(),
                };
            }
            // 按占比分配：digest 取整份额，余量归 content（保证 Σ ≤ free）
            // var_total > 0（上方早退保证），digest_est_total 为 0 时份额自然为 0
            let digest_budget_total = free * digest_est_total / var_total;
            let content_budget = free - digest_budget_total;
            let new_calls = tool_calls
                .iter()
                .map(|c| {
                    // 分母取 max(1)：digest 总估算为 0 时分子亦为 0，结果仍为 0
                    let alloc = digest_budget_total * estimate_tokens(&c.args_digest)
                        / digest_est_total.max(1);
                    ToolCallRecord {
                        id: c.id.clone(),
                        name: c.name.clone(),
                        args_digest: fit_text(&c.args_digest, alloc),
                    }
                })
                .collect();
            Round::Assistant {
                content: fit_text(content, content_budget),
                tool_calls: new_calls,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// est 恰为 tokens 的 User 轮（尾部 4 字符标记便于识别）
    fn round_est(tag: &str, tokens: usize) -> Round {
        Round::User {
            content: format!("{}{}", "a".repeat((tokens - 1) * 4), tag),
        }
    }

    /// 占满技能+项目预算的输入（让渡余量 = 0）
    fn full_static_parts<'a>(
        system: &'a str,
        skills: &'a str,
        project: &'a str,
    ) -> AssembleParts<'a> {
        AssembleParts {
            system,
            skills,
            project,
            memory_index: "",
            history: &[],
            tool_results: &[],
        }
    }

    #[test]
    fn 组装_预算内全量保留() {
        let cfg = BudgetConfig {
            window_tokens: 10_000,
        };
        let history: Vec<Round> = (0..8).map(|i| round_est(&format!("t{i}"), 500)).collect();
        let tools = [ToolResultEntry {
            call_id: "c1".to_string(),
            name: "read_file".to_string(),
            summary: "读文件".to_string(),
            est_tokens: 3,
        }];
        let out = assemble(
            &cfg,
            AssembleParts {
                system: "sys", // est 1
                skills: "",
                project: "abc", // est 1
                memory_index: "",
                history: &history,
                tool_results: &tools,
            },
        );
        assert!(!out.truncated);
        assert_eq!(out.history.len(), 8);
        assert_eq!(out.tool_results.len(), 1);
        // est = system 1 + skills 0 + project 1 + memory 0 + history 4000 + tools 3
        assert_eq!(out.est_tokens, 4_005);
        // 预算合计 = T_ctx = 9000
        assert!(out.est_tokens <= cfg.t_ctx_tokens());
    }

    #[test]
    fn 组装_弹性让渡_技能项目余量按4比3给历史与工具() {
        let cfg = BudgetConfig {
            window_tokens: 10_000,
        };
        // b_skill=450、b_proj=900；skills 空、project est 1 → 余量 450+899=1349
        // 让渡：历史 +1349*4/7=770 → 4370；工具 +1349*3/7=578 → 3278
        // 历史 8 轮 × 500 = 4000 > 3600（无让渡装不下）≤ 4370（让渡后全保留）
        let history: Vec<Round> = (0..8).map(|i| round_est(&format!("t{i}"), 500)).collect();
        let out = assemble(
            &cfg,
            AssembleParts {
                system: "sys",
                skills: "",
                project: "abc",
                memory_index: "",
                history: &history,
                tool_results: &[],
            },
        );
        assert!(!out.truncated);
        assert_eq!(out.history.len(), 8); // 让渡生效：4000 轮历史全保留
    }

    #[test]
    fn 组装_无让渡时历史丢弃最旧轮次() {
        let cfg = BudgetConfig {
            window_tokens: 10_000,
        };
        // 技能 est 恰 450、项目 est 恰 900：让渡余量 0 → 历史预算 3600
        let skills = "s".repeat(1_800);
        let project = "p".repeat(3_600);
        let history: Vec<Round> = (0..8)
            .map(|i| round_est(&format!("t{i:02}"), 500))
            .collect();
        let out = assemble(
            &cfg,
            AssembleParts {
                system: "sys",
                skills: &skills,
                project: &project,
                memory_index: "",
                history: &history,
                tool_results: &[],
            },
        );
        assert!(out.truncated);
        assert_eq!(out.history.len(), 7); // 3500 ≤ 3600 < 4000
                                          // 保留的是连续后缀：最旧 t00 被丢，t01..t07 保留
        assert!(matches!(&out.history[0], Round::User { content } if content.ends_with("t01")));
        assert!(matches!(&out.history[6], Round::User { content } if content.ends_with("t07")));
        // est = 1 + 450 + 900 + 0 + 0 + 3500 = 4851
        assert_eq!(out.est_tokens, 4_851);
    }

    #[test]
    fn 组装_工具结果丢弃最旧条目() {
        let cfg = BudgetConfig {
            window_tokens: 10_000,
        };
        let skills = "s".repeat(1_800); // 占满技能预算，让渡余量只剩项目侧
        let project = "p".repeat(3_600); // 占满项目预算 → 工具预算 2700
        let tools: Vec<ToolResultEntry> = (1..=5)
            .map(|i| ToolResultEntry {
                call_id: format!("c{i}"),
                name: "bash".to_string(),
                summary: "x".repeat(3_200), // est 800
                est_tokens: 800,
            })
            .collect();
        let out = assemble(
            &cfg,
            AssembleParts {
                system: "",
                skills: &skills,
                project: &project,
                memory_index: "",
                history: &[],
                tool_results: &tools,
            },
        );
        assert!(out.truncated);
        // 自最新向前：800×3=2400 ≤ 2700 < 3200 → 保留 c3/c4/c5
        assert_eq!(out.tool_results.len(), 3);
        assert_eq!(out.tool_results[0].call_id, "c3");
        assert_eq!(out.tool_results[2].call_id, "c5");
    }

    #[test]
    fn 组装_单条工具结果超预算截summary并重估() {
        let cfg = BudgetConfig {
            window_tokens: 10_000,
        };
        let skills = "s".repeat(1_800);
        let project = "p".repeat(3_600);
        let tools = [ToolResultEntry {
            call_id: "c1".to_string(),
            name: "bash".to_string(),
            summary: "x".repeat(20_000), // est 5000 > 2700
            est_tokens: 5_000,
        }];
        let out = assemble(
            &cfg,
            AssembleParts {
                system: "",
                skills: &skills,
                project: &project,
                memory_index: "",
                history: &[],
                tool_results: &tools,
            },
        );
        assert!(out.truncated);
        assert_eq!(out.tool_results.len(), 1); // 最新一条不丢，就地截断
        let e = &out.tool_results[0];
        assert!(e.summary.contains("[truncated]"));
        assert!(e.est_tokens <= 2_700);
        assert_eq!(e.est_tokens, estimate_tokens(&e.summary));
    }

    #[test]
    fn 组装_文本区块超预算截断带标注() {
        let cfg = BudgetConfig {
            window_tokens: 10_000,
        };
        let system = "a".repeat(10_000); // est 2500 > 5%×9000=450
        let memory = "m".repeat(8_000); // est 2000 > 10%×9000=900
        let out = assemble(&cfg, full_static_parts(&system, "", ""));
        // full_static_parts 不带 memory：换成手工构造校验 memory_index
        let out_mem = assemble(
            &cfg,
            AssembleParts {
                system: "",
                skills: "",
                project: "",
                memory_index: &memory,
                history: &[],
                tool_results: &[],
            },
        );
        assert!(out.system.ends_with("…[truncated]"));
        assert!(estimate_tokens(&out.system) <= 450);
        assert!(out_mem.memory_index.ends_with("…[truncated]"));
        assert!(estimate_tokens(&out_mem.memory_index) <= 900);
        assert!(out.truncated && out_mem.truncated);
    }

    #[test]
    fn 组装_最新单轮超预算就地截断保住() {
        let cfg = BudgetConfig {
            window_tokens: 1_000,
        };
        // T_ctx=900；b_hist=360，技能+项目全空 → 让渡 (45+90)×4/7=77 → 历史预算 437
        let history = vec![round_est("t0", 1_000)];
        let out = assemble(
            &cfg,
            AssembleParts {
                system: "",
                skills: "",
                project: "",
                memory_index: "",
                history: &history,
                tool_results: &[],
            },
        );
        assert!(out.truncated);
        assert_eq!(out.history.len(), 1); // 不丢最新轮
        assert!(out.history[0].est_tokens() <= 437);
        assert!(out.est_tokens <= cfg.t_ctx_tokens());
    }

    #[test]
    fn 组装_全线超载仍不挤占t_out() {
        let cfg = BudgetConfig {
            window_tokens: 2_000,
        }; // T_ctx=1800
        let system = "s".repeat(80_000);
        let skills = "k".repeat(80_000);
        let project = "p".repeat(80_000);
        let memory = "m".repeat(80_000);
        let history: Vec<Round> = (0..50)
            .map(|i| round_est(&format!("t{i:02}"), 1_000))
            .collect();
        let tools: Vec<ToolResultEntry> = (0..20)
            .map(|i| ToolResultEntry {
                call_id: format!("c{i}"),
                name: "bash".to_string(),
                summary: "x".repeat(3_200),
                est_tokens: 800,
            })
            .collect();
        let out = assemble(
            &cfg,
            AssembleParts {
                system: &system,
                skills: &skills,
                project: &project,
                memory_index: &memory,
                history: &history,
                tool_results: &tools,
            },
        );
        assert!(out.truncated);
        assert!(out.est_tokens <= 1_800); // est ≤ T_ctx，T_out 永不被挤占
        assert_eq!(out.history.len(), 1); // 单轮 1000 > 任何历史预算 → 就地截断保最新
        assert!(!out.history.is_empty());
    }
}
