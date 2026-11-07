//! 协作图编排（D14 §3）：会诊型 TeamRun——多专家并行 Activation →
//! join 汇总 → 摘要回填主上下文。专家执行体复用 expert::run_expert
//! （受限子会话），本模块只承担编排语义：
//!
//! - **并行度 ≤4**（§3.2：会诊型专家并行上限；探查子 Agent 另计 ≤3）
//! - **成员通信经黑板中转**：共享任务简报 + 结论汇总（§3.2——与
//!   dsh-agent-teams 直连通信的取舍：可审计性优先）；工作区产物区
//!   `.bbw/team/{runId}/`（专家 checkpointed 落盘产物）随阶段二
//! - **失败不阻塞**：单专家失败标注继续（补派/降级为探查由编排层
//!   上游选择）；两次失败转人工的策略位在调用方（bin/loop_runner）
//! - **图级总步数 ≤120**（§8-5）：装配时校验 Σmembers.max_steps
//! - **嵌套深度 ≤2**：编译期结构保证——expert.rs 不引用本模块，
//!   专家子会话内无法再拉协作图（探查可由专家自用，不受此限）
//! - **TeamRun 并发 ≤1/主会话**（§8-5）：调用方守卫（loop_runner
//!   接线随下轮选角引擎；v0.1 单线程假设，登记）
//!
//! v0.1 裁剪登记：仅会诊型（并行 fan-out）拓扑落地；流水线（串行）与
//! 评审环（≤N 轮返工）随后续批次；选角引擎（§3.3 自动构图）与协作摘要
//! 卡（PAG-17 客户端）同批。协议复用 subagent.*（冻结不动），编排级
//! 审计走 WAL `team.start`/`team.joined`。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::events::SessionSink;
use crate::expert::{run_expert, AssembledExpert, ExpertCtx, ExpertResult};
use crate::loop_runner::EventLog;
use crate::subagent::truncate_chars;

/// 会诊型并行上限（§3.2）
pub const TEAM_MAX_MEMBERS: usize = 4;
/// 图级总步数上限（§8-5：专家总步数 ≤120/图）
pub const TEAM_MAX_TOTAL_STEPS: usize = 120;
/// 单专家结论入摘要的截断（汇总卡折叠口径）
const SUMMARY_RESULT_CHARS: usize = 400;

/// 团队成员：标签（角色位，如"安全评审"）+ 装配产物
#[derive(Debug, Clone)]
pub struct TeamMember {
    /// 节点标签（TeamRun 视图/PAG-16 节点名；与 persona display 可不同）
    pub label: String,
    pub expert: Arc<AssembledExpert>,
}

/// 协作图（v0.1 会诊型：全员并行，join 汇总；流水线/评审环结构预留）
#[derive(Debug, Clone)]
pub struct TeamGraph {
    /// 共享任务简报（黑板：全员同一份，独立上下文无主历史）
    pub task: String,
    /// 会诊成员（1..=4）
    pub members: Vec<TeamMember>,
}

/// 图校验错误（编排前置，未产生任何 Activation）
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum TeamError {
    #[error("成员数须 1..={TEAM_MAX_MEMBERS}（会诊型并行上限）")]
    MembersOutOfRange,
    #[error("图级总步数超限（Σmax_steps > {TEAM_MAX_TOTAL_STEPS}）")]
    TotalStepsExceeded,
    #[error("成员标签为空或重复：{0}")]
    BadLabels(String),
}

/// 校验图（Activation 前置；§3.2 并行度 + §8-5 总步数）
pub fn validate_graph(g: &TeamGraph) -> Result<(), TeamError> {
    if g.members.is_empty() || g.members.len() > TEAM_MAX_MEMBERS {
        return Err(TeamError::MembersOutOfRange);
    }
    let total: usize = g.members.iter().map(|m| m.expert.max_steps).sum();
    if total > TEAM_MAX_TOTAL_STEPS {
        return Err(TeamError::TotalStepsExceeded);
    }
    let mut seen = std::collections::HashSet::new();
    for m in &g.members {
        if m.label.trim().is_empty() || !seen.insert(m.label.as_str()) {
            return Err(TeamError::BadLabels(m.label.clone()));
        }
    }
    Ok(())
}

/// 单节点结果（NodeRun 终态；fail 不阻塞其余节点）
#[derive(Debug, Clone, PartialEq)]
pub struct NodeResult {
    pub label: String,
    pub result: ExpertResult,
}

/// TeamRun 汇总（全部节点终态后产出；摘要回填主上下文，PAG-17 卡片数据源）
#[derive(Debug, Clone, PartialEq)]
pub struct TeamResult {
    pub run_id: String,
    pub nodes: Vec<NodeResult>,
    /// 折叠摘要文本（主上下文回填，同 fanout join_summary 口径）
    pub summary: String,
    /// 失败节点标签（补派/降级决策位在编排上游）
    pub failed: Vec<String>,
}

/// TeamRun 序号（run_id 唯一化；WAL 审计关联）
static TEAM_SEQ: AtomicUsize = AtomicUsize::new(0);

/// 跑一次会诊型 TeamRun：team.start（WAL）→ 并行 Activation（thread::scope，
/// 单节点 panic 不阻塞 join 标注——同 fanout 口径）→ team.joined → 摘要。
/// 各节点事件复用 subagent.* 协议变体（Spawned/ProbeEvt，协议冻结）。
pub fn run_team(
    ctx: &ExpertCtx<'_>,
    session_id: &str,
    graph: &TeamGraph,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
) -> Result<TeamResult, TeamError> {
    validate_graph(graph)?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let run_id = format!("team-{now_ms}-{}", TEAM_SEQ.fetch_add(1, Ordering::Relaxed));
    let labels: Vec<&str> = graph.members.iter().map(|m| m.label.as_str()).collect();
    wal.append(
        session_id,
        "team.start",
        &format!(
            "{{\"run_id\":\"{run_id}\",\"members\":{},\"task\":\"{}\"}}",
            serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into()),
            truncate_chars(&graph.task, 80)
        ),
    );

    // 并行 Activation（ChatClient: Send+Sync；共享简报=黑板中转，节点间零直连；
    // panic 兜底按 handle/member 同序索引取回标签，同 fanout join 口径）
    let nodes: Vec<NodeResult> = std::thread::scope(|s| {
        let handles: Vec<_> = graph
            .members
            .iter()
            .map(|m| {
                let expert = Arc::clone(&m.expert);
                let label = m.label.clone();
                let task_brief = brief_for(&graph.task, &label);
                s.spawn(move || {
                    let result = run_expert(
                        ExpertCtx {
                            model: ctx.model,
                            tools: ctx.tools,
                            mode: ctx.mode,
                        },
                        session_id,
                        &expert,
                        &task_brief,
                        sink,
                        wal,
                    );
                    NodeResult { label, result }
                })
            })
            .collect();
        handles
            .into_iter()
            .enumerate()
            .map(|(i, h)| match h.join() {
                Ok(node) => node,
                Err(_) => NodeResult {
                    label: graph.members[i].label.clone(),
                    result: ExpertResult {
                        activation_id: String::new(),
                        persona_id: graph.members[i].expert.manifest.id.clone(),
                        ok: false,
                        summary: "节点线程 panic".into(),
                    },
                },
            })
            .collect()
    });

    let failed: Vec<String> = nodes
        .iter()
        .filter(|n| !n.result.ok)
        .map(|n| n.label.clone())
        .collect();
    let ok_count = nodes.len() - failed.len();
    wal.append(
        session_id,
        "team.joined",
        &format!(
            "{{\"run_id\":\"{run_id}\",\"total\":{},\"ok\":{ok_count},\"failed\":{}}}",
            nodes.len(),
            serde_json::to_string(&failed).unwrap_or_else(|_| "[]".into())
        ),
    );

    Ok(TeamResult {
        summary: team_summary(&nodes),
        nodes,
        failed,
        run_id,
    })
}

/// 节点任务简报（黑板：共享任务 + 角色位提示；独立上下文无主历史）
fn brief_for(task: &str, label: &str) -> String {
    format!(
        "【协作任务】{task}\n\n你的角色位：{label}。仅就本角色视角给出结构化结论，\
        其余成员并行工作，不可见彼此输出。"
    )
}

/// 汇总折叠（join 口径：ok/fail 标注 + 标签 + 结论截断；回填主上下文）
fn team_summary(nodes: &[NodeResult]) -> String {
    let mut out = format!("协作图汇总（{} 个节点）：", nodes.len());
    for n in nodes {
        out.push_str(&format!(
            "\n- [{}] {}（{}）：{}",
            if n.result.ok { "ok" } else { "fail" },
            n.label,
            n.result.persona_id,
            truncate_chars(&n.result.summary, SUMMARY_RESULT_CHARS)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expert::{assemble, parse_manifest, AssemblePolicy};
    use crate::skills::SkillIndex;

    fn member(label: &str, persona_mark: &str, max_steps: usize) -> TeamMember {
        let text = format!(
            "id: corp.{label}\ntype: local\nversion: 1.0.0\ndisplay: {label}\npersona: |\n  你是{persona_mark}。\nconstraints:\n  max_steps: {max_steps}\nsource: company\n"
        );
        let m = parse_manifest(&text).unwrap();
        let mut a = assemble(&m, &[], &SkillIndex::default(), &AssemblePolicy::default());
        a.system_prompt = format!("你是{persona_mark}。");
        TeamMember {
            label: label.into(),
            expert: Arc::new(a),
        }
    }

    fn graph(members: Vec<TeamMember>) -> TeamGraph {
        TeamGraph {
            task: "评审 PR#42".into(),
            members,
        }
    }

    /// 图校验：成员数/总步数/标签
    #[test]
    fn graph_validation() {
        assert_eq!(
            validate_graph(&graph(vec![])),
            Err(TeamError::MembersOutOfRange)
        );
        let five = (0..5).map(|i| member(&format!("e{i}"), "x", 10)).collect();
        assert_eq!(
            validate_graph(&graph(five)),
            Err(TeamError::MembersOutOfRange)
        );
        // 总步数：4×40=160 > 120
        let heavy: Vec<_> = (0..4).map(|i| member(&format!("h{i}"), "x", 40)).collect();
        assert_eq!(
            validate_graph(&graph(heavy)),
            Err(TeamError::TotalStepsExceeded)
        );
        let dup = vec![member("dup", "x", 10), member("dup", "y", 10)];
        assert!(matches!(
            validate_graph(&graph(dup)),
            Err(TeamError::BadLabels(_))
        ));
        assert!(validate_graph(&graph(vec![member("solo", "x", 40)])).is_ok());
    }
}
