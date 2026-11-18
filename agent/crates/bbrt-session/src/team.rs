//! 协作图编排（D14 §3）：会诊型 TeamRun——多专家并行 Activation →
//! join 汇总 → 摘要回填主上下文。专家执行体复用 expert::run_expert
//! （受限子会话），本模块只承担编排语义：
//!
//! - **并行度 ≤4**（§3.2：会诊型专家并行上限；探查子 Agent 另计 ≤3）
//! - **成员通信经黑板中转**：共享任务简报 + 结论汇总（§3.2——与
//!   dsh-agent-teams 直连通信的取舍：可审计性优先）；工作区产物区
//!   `.bbc/team/{runId}/`（专家 checkpointed 落盘产物）随阶段二
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

use bbrt_aigw::ChatClient;

use crate::events::SessionSink;
use crate::expert::{
    parse_manifest, run_expert, AssembledExpert, ExpertCtx, ExpertManifest, ExpertResult,
};
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

/// 协作拓扑（§3.1 三种）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TeamTopology {
    /// ① 会诊型：并行 fan-out，join 汇总（默认）
    #[default]
    Consult,
    /// ② 流水线：串行，上游结论经黑板流入下游简报
    Pipeline,
    /// ③ 评审环：producer⇄reviewer ≤N 轮，revise 带意见返工，超限转人工
    ReviewLoop,
}

/// 评审环默认轮次上限（§3.1 ③：N=2 超限转人工）
pub const REVIEW_MAX_ROUNDS: usize = 2;

/// 协作图（三拓扑；成员数/步数预算按拓扑校验；Default=会诊空图）
#[derive(Debug, Clone, Default)]
pub struct TeamGraph {
    /// 共享任务简报（黑板：全员同一份，独立上下文无主历史）
    pub task: String,
    /// 成员（Consult 1..=4 并行 / Pipeline 有序串行 / ReviewLoop 恰 2：
    /// [0]=producer [1]=reviewer）
    pub members: Vec<TeamMember>,
    pub topology: TeamTopology,
    /// ReviewLoop 轮次上限（缺省 2；其他拓扑忽略）
    pub max_rounds: usize,
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
    #[error("评审环须恰 2 成员（producer + reviewer）")]
    ReviewLoopMembers,
}

/// 校验图（Activation 前置；§3.2 并行度 + §8-5 总步数——评审环按
/// 单轮 Σ×(N+1) 折算预算：producer+reviewer 各跑一轮 + N 次 revise 返工）
pub fn validate_graph(g: &TeamGraph) -> Result<(), TeamError> {
    if g.members.is_empty() || g.members.len() > TEAM_MAX_MEMBERS {
        return Err(TeamError::MembersOutOfRange);
    }
    let per_round: usize = g.members.iter().map(|m| m.expert.max_steps).sum();
    let budget = match g.topology {
        TeamTopology::ReviewLoop => {
            if g.members.len() != 2 {
                return Err(TeamError::ReviewLoopMembers);
            }
            let rounds = if g.max_rounds == 0 {
                REVIEW_MAX_ROUNDS
            } else {
                g.max_rounds
            };
            per_round.saturating_mul(rounds + 1)
        }
        _ => per_round,
    };
    if budget > TEAM_MAX_TOTAL_STEPS {
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
    /// 评审环轮次（1 起；会诊/流水线恒 1）
    pub round: usize,
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
    /// ReviewLoop 实际轮次（会诊/流水线恒 1）
    pub rounds: usize,
    /// ReviewLoop 超限转人工（§3.1 ③ N=2 超限；编排上游据此介入）
    pub escalated: bool,
}

/// TeamRun 序号（进程内唯一化；仅未接 Store 时的 run id 退路）
static TEAM_SEQ: AtomicUsize = AtomicUsize::new(0);

/// 跑一次会诊型 TeamRun：team run 起始（agent_run kind=team，D16 §3.1；
/// 成员 expert run 以本 run 为 parent_run_id 成链）→ team.start（WAL）→
/// 并行 Activation（thread::scope，单节点 panic 不阻塞 join 标注——同
/// fanout 口径）→ team.joined → 摘要 → team run 终态。
/// 各节点事件复用 subagent.* 协议变体（Spawned/ProbeEvt，协议冻结）。
pub fn run_team(
    ctx: &ExpertCtx,
    session_id: &str,
    graph: &TeamGraph,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
) -> Result<TeamResult, TeamError> {
    use crate::loop_runner::{RunEnd, RunStart};
    validate_graph(graph)?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let started = std::time::Instant::now();
    let run_id = wal
        .next_task_id("team")
        .unwrap_or_else(|| format!("team-{now_ms}-{}", TEAM_SEQ.fetch_add(1, Ordering::Relaxed)));
    let def_ref = format!("team:{}", topology_name(graph.topology));
    let eta_hint = wal
        .eta_hint(&def_ref)
        .unwrap_or_else(|| crate::loop_runner::static_eta_ms("team"));
    wal.run_start(&RunStart {
        run_id: run_id.clone(),
        session_id: session_id.to_string(),
        root_session_id: session_id.to_string(),
        parent_run_id: String::new(),
        parent_call_id: String::new(),
        kind: "team",
        def_ref: def_ref.clone(),
        eta_hint_ms: eta_hint,
        actor: String::new(),
    });
    let labels: Vec<&str> = graph.members.iter().map(|m| m.label.as_str()).collect();
    wal.append_run(
        session_id,
        &run_id,
        "team.start",
        &format!(
            "{{\"run_id\":\"{run_id}\",\"topology\":\"{}\",\"members\":{},\"task\":\"{}\"}}",
            topology_name(graph.topology),
            serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into()),
            truncate_chars(&graph.task, 80)
        ),
    );

    let (nodes, rounds, escalated) = match graph.topology {
        TeamTopology::Pipeline => (
            run_pipeline(ctx, session_id, graph, sink, wal, &run_id),
            1,
            false,
        ),
        TeamTopology::ReviewLoop => run_review_loop(ctx, session_id, graph, sink, wal, &run_id),
        TeamTopology::Consult => (
            run_consult(ctx, session_id, graph, sink, wal, &run_id),
            1,
            false,
        ),
    };

    let failed: Vec<String> = nodes
        .iter()
        .filter(|n| !n.result.ok)
        .map(|n| n.label.clone())
        .collect();
    let ok_count = nodes.len() - failed.len();
    wal.append_run(
        session_id,
        &run_id,
        "team.joined",
        &format!(
            "{{\"run_id\":\"{run_id}\",\"total\":{},\"ok\":{ok_count},\"failed\":{},\"rounds\":{rounds},\"escalated\":{escalated}}}",
            nodes.len(),
            serde_json::to_string(&failed).unwrap_or_else(|_| "[]".into())
        ),
    );
    wal.run_end(
        &run_id,
        &RunEnd {
            status: if failed.is_empty() { "done" } else { "failed" },
            eta_actual_ms: started.elapsed().as_millis() as i64,
            summary: &truncate_chars(&team_summary(&nodes), 400),
            child_session_ref: "",
        },
    );

    Ok(TeamResult {
        summary: team_summary(&nodes),
        nodes,
        failed,
        run_id,
        rounds,
        escalated,
    })
}

/// 拓扑 WAL 标识
fn topology_name(t: TeamTopology) -> &'static str {
    match t {
        TeamTopology::Consult => "consult",
        TeamTopology::Pipeline => "pipeline",
        TeamTopology::ReviewLoop => "review_loop",
    }
}

/// 会诊型：并行 Activation（原 run_team 主体；panic 兜底按索引挂标签）
fn run_consult(
    ctx: &ExpertCtx,
    session_id: &str,
    graph: &TeamGraph,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
    parent_run_id: &str,
) -> Vec<NodeResult> {
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
                let ctx = ctx.clone(); // owned：线程内独立持有
                s.spawn(move || {
                    let result = run_expert(
                        &ctx,
                        session_id,
                        &expert,
                        &task_brief,
                        sink,
                        wal,
                        parent_run_id,
                    );
                    NodeResult {
                        label,
                        result,
                        round: 1,
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .enumerate()
            .map(|(i, h)| match h.join() {
                Ok(node) => node,
                Err(_) => NodeResult {
                    round: 1,
                    label: graph.members[i].label.clone(),
                    result: ExpertResult {
                        run_id: String::new(),
                        persona_id: graph.members[i].expert.manifest.id.clone(),
                        ok: false,
                        summary: "节点线程 panic".into(),
                    },
                },
            })
            .collect()
    });
    nodes
}

/// 节点任务简报（黑板：共享任务 + 角色位提示；独立上下文无主历史）
fn brief_for(task: &str, label: &str) -> String {
    format!(
        "【协作任务】{task}\n\n你的角色位：{label}。仅就本角色视角给出结构化结论，\
        其余成员并行工作，不可见彼此输出。"
    )
}

/// 流水线：有序串行——上游结论经黑板流入下游简报（§3.1 ②）；上游
/// fail 不阻断：下游简报带失败标注继续（降级语义同 §3.2"失败不阻塞"）
fn run_pipeline(
    ctx: &ExpertCtx,
    session_id: &str,
    graph: &TeamGraph,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
    parent_run_id: &str,
) -> Vec<NodeResult> {
    let mut nodes: Vec<NodeResult> = vec![];
    let mut board = String::new(); // 黑板：上游结论链
    for (i, m) in graph.members.iter().enumerate() {
        let brief = if i == 0 {
            brief_for(&graph.task, &m.label)
        } else {
            format!(
                "【协作任务】{}\n\n你的角色位：{}（流水线第 {} 段）。上游结论（含失败标注，据此继续）：\n{}",
                graph.task, m.label, i + 1, board
            )
        };
        let result = run_expert(ctx, session_id, &m.expert, &brief, sink, wal, parent_run_id);
        board.push_str(&format!(
            "- [{}] {}：{}\n",
            if result.ok { "ok" } else { "fail" },
            m.label,
            truncate_chars(&result.summary, 300)
        ));
        nodes.push(NodeResult {
            label: m.label.clone(),
            result,
            round: 1,
        });
    }
    nodes
}

/// 评审环：producer 产出 → reviewer 评审（VERDICT 首行约定）→ revise 带
/// 意见返工 ≤N 轮，超限转人工（escalated；§3.1 ③）。verdict 解析失败按
/// revise 保守处理（评审产出不明=不放行）。
fn run_review_loop(
    ctx: &ExpertCtx,
    session_id: &str,
    graph: &TeamGraph,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
    parent_run_id: &str,
) -> (Vec<NodeResult>, usize, bool) {
    let producer = &graph.members[0];
    let reviewer = &graph.members[1];
    let max_rounds = if graph.max_rounds == 0 {
        REVIEW_MAX_ROUNDS
    } else {
        graph.max_rounds
    };
    let mut nodes: Vec<NodeResult> = vec![];
    for round in 1..=max_rounds + 1 {
        // producer（第 1 轮任务简报；返工轮带评审意见）
        let prod_brief = if round == 1 {
            brief_for(&graph.task, &producer.label)
        } else {
            let last_review = nodes
                .iter()
                .rev()
                .find(|n| n.label == reviewer.label)
                .map(|n| n.result.summary.clone())
                .unwrap_or_default();
            format!(
                "【协作任务】{}\n\n你的角色位：{}（评审返工第 {} 轮）。评审意见（按此修订产出）：\n{}",
                graph.task, producer.label, round - 1, last_review
            )
        };
        let prod = run_expert(
            ctx,
            session_id,
            &producer.expert,
            &prod_brief,
            sink,
            wal,
            parent_run_id,
        );
        let artifact = prod.summary.clone(); // 本轮产出（即产即用）
        nodes.push(NodeResult {
            label: producer.label.clone(),
            result: prod,
            round,
        });

        // reviewer（评审 producer 产物；persona 侧约定首行 VERDICT: pass|revise）
        let rev_brief = format!(
            "【协作任务】评审以下产出是否符合要求：{}\n\n你的角色位：{}。\
            首行必须输出 VERDICT: pass 或 VERDICT: revise，随后给意见。",
            graph.task, reviewer.label
        );
        let rev_input = format!(
            "{rev_brief}\n\n待评审产出：\n{}",
            truncate_chars(&artifact, 2000)
        );
        let rev = run_expert(
            ctx,
            session_id,
            &reviewer.expert,
            &rev_input,
            sink,
            wal,
            parent_run_id,
        );
        let passed = rev.ok && parse_verdict(&rev.summary);
        nodes.push(NodeResult {
            label: reviewer.label.clone(),
            result: rev,
            round,
        });
        if passed {
            return (nodes, round, false);
        }
    }
    // N 轮 revise 用尽：转人工（§3.1 ③）
    wal.append_run(
        session_id,
        parent_run_id,
        "team.escalated",
        &format!("{{\"task\":\"{}\"}}", truncate_chars(&graph.task, 60)),
    );
    (nodes, max_rounds + 1, true)
}

/// VERDICT 首行解析（pass=放行；revise/解析失败=不放行——保守）
fn parse_verdict(summary: &str) -> bool {
    summary
        .lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_ascii_lowercase().starts_with("verdict: pass"))
        .unwrap_or(false)
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

// ---------------------------------------------------------------------------
// 选角引擎（§3.3 自动构图·依赖倒置）+ 专家库索引
// ---------------------------------------------------------------------------

/// 专家执行源（依赖倒置：loop_runner 只依赖本 trait；bin 装配 FastCaster，
/// 测试注入假件。None=不组队回主循环——组队是优化不是依赖，降级语义同探查）
pub trait ExpertSource: Send + Sync {
    /// 选角并装配（返回可执行 TeamGraph；成员已过装配过滤）
    fn cast(&self, model: &dyn ChatClient, user_text: &str) -> Option<TeamGraph>;
}

/// 专家库索引：扫描 `eco/experts/*.yaml`（一文件一 manifest；解析失败
/// 静默跳过不阻塞其余——降级语义同技能装载；tools.reload 联动由 bin 侧重扫）
#[derive(Debug, Clone, Default)]
pub struct ExpertIndex {
    pub manifests: Vec<ExpertManifest>,
}

impl ExpertIndex {
    /// 扫描专家库目录（缺失/空目录=空索引；yaml/yml 双扩展）。
    /// `{id}.override.yaml` = 本地覆写（D16 §6 三层配置：建议配置→覆写→
    /// 硬上限）：tools/skills 合并增强、constraints/model 覆盖后重校验；
    /// 坏覆写降级=沿用建议配置（不阻塞该专家可用）。
    pub fn scan(dir: &std::path::Path) -> Self {
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return Self::default(),
        };
        let mut manifests: Vec<ExpertManifest> = vec![];
        let mut overrides: Vec<(String, String)> = vec![]; // (id, 覆写文本)
        for p in rd.filter_map(|e| e.ok()).map(|e| e.path()) {
            if !matches!(p.extension().and_then(|x| x.to_str()), Some("yaml" | "yml")) {
                continue;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            if let Some(stem) = name
                .strip_suffix(".override.yaml")
                .or_else(|| name.strip_suffix(".override.yml"))
            {
                overrides.push((stem.to_string(), text));
            } else if let Ok(m) = parse_manifest(&text) {
                manifests.push(m);
            }
        }
        for (id, text) in overrides {
            let Some(m) = manifests.iter_mut().find(|m| m.id == id) else {
                continue; // 孤儿覆写（上游已删）：忽略
            };
            if let Err(e) = crate::expert::apply_override(m, &text) {
                eprintln!("[bbrt] 专家 {id} 本地覆写非法，沿用建议配置：{e}");
            }
        }
        manifests.sort_by(|a, b| a.id.cmp(&b.id)); // 确定性：选角清单顺序稳定
        Self { manifests }
    }

    /// 按 id 取 manifest
    pub fn get(&self, id: &str) -> Option<&ExpertManifest> {
        self.manifests.iter().find(|m| m.id == id)
    }

    /// 选角清单文本（id + display + persona 摘要——快模型视角）
    fn roster(&self) -> String {
        self.manifests
            .iter()
            .map(|m| {
                format!(
                    "- {}：{}｜{}",
                    m.id,
                    m.display,
                    truncate_chars(m.persona.trim(), 60)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// 快模型选角器（§3.3：任务关键词 × manifest 能力声明匹配；输出 JSON
/// {team, cast:[{id,label}]}——解析失败/围栏噪声/幻觉 id/超 4 人一律降级
/// 不组队）。装配闭包由 bin 注入（registry/skills/policy 绑定侧）。
pub struct FastCaster<F>
where
    F: Fn(&ExpertManifest) -> AssembledExpert + Send + Sync,
{
    pub index: ExpertIndex,
    /// manifest → 装配产物（assemble() 的绑定封装，含 dropped 标灰信息）
    pub assemble_for: F,
}

const CASTER_SYSTEM: &str = "判定任务是否需要组建专家团队。可用专家清单：\nROSTER\n\
    输出纯 JSON（无围栏无解释）：\n\
    {\"team\": true|false, \"cast\": [{\"id\": \"专家id\", \"label\": \"角色位\"}]}\n\
    判定 team：任务可按多专家视角并行分解（评审/多维度分析/多领域排查），\
    且清单中有匹配专家（最多 4 个）；单一问题/清单不匹配 team=false。";

impl<F> ExpertSource for FastCaster<F>
where
    F: Fn(&ExpertManifest) -> AssembledExpert + Send + Sync,
{
    fn cast(&self, model: &dyn ChatClient, user_text: &str) -> Option<TeamGraph> {
        if self.manifests_empty() {
            return None;
        }
        let system = CASTER_SYSTEM.replacen("ROSTER", &self.roster_text(), 1);
        let out = crate::loop_runner::chat_text(model, &system, user_text).ok()?;
        let v: serde_json::Value =
            serde_json::from_str(crate::subagent::strip_fence(&out).trim()).ok()?;
        if !v.get("team")?.as_bool()? {
            return None;
        }
        let mut members: Vec<TeamMember> = vec![];
        let mut seen = std::collections::HashSet::new();
        let mut steps_budget = 0usize;
        for c in v.get("cast")?.as_array()? {
            let id = c.get("id")?.as_str()?;
            // 幻觉 id 防线：只认清单内专家（声明式——不在库=不存在）
            let m = self.index.get(id)?;
            if !seen.insert(id.to_string()) {
                continue; // 重复选角去重
            }
            // 双预算截断（§3.2 ≤4 人 + §8-5 Σ≤120）：快模型超发时先到先得
            if members.len() == TEAM_MAX_MEMBERS
                || steps_budget + m.constraints.max_steps > TEAM_MAX_TOTAL_STEPS
            {
                break;
            }
            steps_budget += m.constraints.max_steps;
            let label = c
                .get("label")
                .and_then(|l| l.as_str())
                .filter(|l| !l.trim().is_empty())
                .unwrap_or(&m.display)
                .to_string();
            members.push(TeamMember {
                label,
                expert: std::sync::Arc::new((self.assemble_for)(m)),
            });
        }
        if members.is_empty() {
            return None;
        }
        // 图级校验（Σsteps ≤120 等）不通过=不组队（降级，不阻断主循环）
        let graph = TeamGraph {
            task: user_text.to_string(),
            members,
            ..Default::default() // 选角引擎 v0.1 仅会诊拓扑（其余拓扑手动构图）
        };
        validate_graph(&graph).ok()?;
        Some(graph)
    }
}

impl<F> FastCaster<F>
where
    F: Fn(&ExpertManifest) -> AssembledExpert + Send + Sync,
{
    fn manifests_empty(&self) -> bool {
        self.index.manifests.is_empty()
    }
    fn roster_text(&self) -> String {
        self.index.roster()
    }
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
            ..Default::default()
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
