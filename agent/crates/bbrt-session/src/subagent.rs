//! 通用子 Agent（08 §4.5 / D16 决策①）：主 Agent 的"分身"——
//! **system prompt、技能、记忆侧写、工具、MCP、模型全部与主会话一致**，
//! 唯一区别是上下文历史清零 + 收到主 Agent 派发的任务提示词。
//!
//! 用途：上下文污染防治（独立窗口）、并行调查/执行。原"只读探查"
//! 白名单形态并入任务写法（主 Agent 派活时写明"只调查不改"）——
//! 写操作经与主同一九步门控管线，该弹审批弹审批。
//!
//! 护栏（与时长无关，D16 §2）：独立上下文窗口、步数上限（缺省 60，可配）、
//! 摘要 ≤2k tokens 回填、并发 ≤3。执行体落 agent_run（kind=probe，
//! def_ref=builtin.probe，D16 §3.1）。

use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg};
use bbrt_context::{estimate_tokens, Round};
use bbrt_memory::MemoryEngine;

use crate::events::{SessionEvent, SessionSink};
use crate::executor::{ToolExecutor, ToolInvocation, ToolOutcome};
use crate::loop_runner::EventLog;
use crate::state::{self, SessionState};
use bbrt_sec::gate::PermissionMode;

/// 单子任务步数上限（通用化后调大；超步自杀返回部分结果 + fail 标注）
pub const SUBAGENT_MAX_STEPS: usize = 60;

/// 摘要上限（token 估算；超限截断尾部）
pub const PROBE_SUMMARY_TOKENS: usize = 2000;

/// 并发上限（subtasks.take）
pub const PROBE_MAX_CONCURRENCY: usize = 3;

/// 子任务简报（独立上下文：仅此文本 + 与主同构的 system 组装，无主历史）
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeSpec {
    pub task: String,
}

/// 子任务产物（join 聚合与主上下文回填用）
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    /// 持久 run id（D16 §3.1：接 Store 时 r-{seq}；否则退回进程内临时 id）
    pub run_id: String,
    pub ok: bool,
    pub summary: String,
}

/// 分解判定（依赖倒置：bin 用快模型实现；None=不分解回主循环）
pub trait FanoutPlanner: Send + Sync {
    fn plan(&self, model: &dyn ChatClient, user_text: &str) -> Option<Vec<ProbeSpec>>;
}

/// 快模型判定器（19 篇 bbw-fast；输出 JSON {complex, subtasks[]}，
/// 解析失败/围栏噪声一律降级为"不分解"——fan-out 是优化不是依赖）
pub struct FastPlanner;

const PLANNER_SYSTEM: &str = "判定任务是否值得并行派发子任务。输出纯 JSON（无围栏无解释）：\n\
    {\"complex\": true|false, \"subtasks\": [\"独立可并行的子任务\", ...]}\n\
    判定 complex：涉及多目录/多文件/多信息源，可拆出彼此独立的子任务（最多 3 条）；\
    单一问题不拆。修改类任务如需拆分，把写操作留在主任务串行执行，\
    子任务只承担调查与信息收集（在子任务描述里写明）。";

impl FanoutPlanner for FastPlanner {
    fn plan(&self, model: &dyn ChatClient, user_text: &str) -> Option<Vec<ProbeSpec>> {
        let out = crate::loop_runner::chat_text(model, PLANNER_SYSTEM, user_text).ok()?;
        let stripped = strip_fence(&out);
        let v: serde_json::Value = serde_json::from_str(stripped.trim()).ok()?;
        if !v.get("complex")?.as_bool()? {
            return None;
        }
        let subs: Vec<ProbeSpec> = v
            .get("subtasks")?
            .as_array()?
            .iter()
            .filter_map(|t| {
                t.as_str().map(|s| ProbeSpec {
                    task: s.to_string(),
                })
            })
            .collect();
        if subs.is_empty() {
            None
        } else {
            Some(subs.into_iter().take(PROBE_MAX_CONCURRENCY).collect())
        }
    }
}

/// 剥 markdown 代码围栏（```json ... ``` → 内容；两侧空白一并清）
pub(crate) fn strip_fence(s: &str) -> &str {
    let t = s.trim();
    let body = t
        .strip_prefix("```")
        .and_then(|r| r.split_once('\n'))
        .map(|(_, body)| body)
        .unwrap_or(t)
        .trim();
    body.strip_suffix("```").map(str::trim).unwrap_or(body)
}

/// 通用子 Agent 执行上下文（owned Arc——线程派发/后台化安全；
/// D16 决策①：system/技能/记忆/工具/模型与主会话同一来源）
pub struct ProbeCtx {
    pub model: Arc<dyn ChatClient>,
    pub tools: Arc<dyn ToolExecutor>,
    pub mode: PermissionMode,
    /// 主 system prompt（loop_runner::SYSTEM_PROMPT）
    pub system: String,
    /// 技能索引（按任务文本命中注入，同主口径 ≤3 条）
    pub skills: Arc<Mutex<crate::skills::SkillIndex>>,
    /// 记忆侧写（recall_for(任务)，同主口径只读注入）
    pub memory: Option<Arc<MemoryEngine>>,
    pub workspace: String,
    /// 主循环同款模型名（override 优先回落档位——"与主一致"）
    pub model_name: String,
}

/// 与主 to_chat_messages 同构的 system 组装（[技能]/[项目]/[记忆] 三段）
fn probe_system(ctx: &ProbeCtx, task: &str) -> String {
    let skills_text = {
        let idx = ctx.skills.lock().unwrap_or_else(|p| p.into_inner());
        let matched = idx.match_for(task);
        idx.render(&matched)
    };
    let memory_index = ctx
        .memory
        .as_ref()
        .and_then(|m| m.knowledge().recall_for(task).ok())
        .unwrap_or_default();
    format!(
        "{}\n\n[技能]\n{}\n\n[项目]\nworkspace: {}\n\n[记忆]\n{}",
        ctx.system, skills_text, ctx.workspace, memory_index
    )
}

/// 跑一个子任务：run 起始 → spawn 事件 → mini-loop（≤SUBAGENT_MAX_STEPS 步，
/// **全量工具**经完整管线执行——写操作走同一审批/沙箱）→ done/fail 事件 +
/// run 终态。run 行落 agent_run（kind=probe，D16 §3.1）。
pub fn run_probe(
    ctx: ProbeCtx,
    session_id: &str,
    run_id: &str,
    spec: &ProbeSpec,
    sink: Arc<dyn SessionSink>,
    wal: Arc<dyn EventLog>,
) -> ProbeResult {
    use crate::loop_runner::{RunEnd, RunStart};
    let started = std::time::Instant::now();
    // ETA（P1-6）：滚动统计优先，无样本回落静态表
    let def_ref = "builtin.probe";
    let eta_hint = wal
        .eta_hint(def_ref)
        .unwrap_or_else(|| crate::loop_runner::static_eta_ms("probe"));
    wal.run_start(&RunStart {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        root_session_id: session_id.to_string(),
        parent_run_id: String::new(),
        parent_call_id: String::new(),
        kind: "probe",
        def_ref: def_ref.to_string(),
        eta_hint_ms: eta_hint,
        actor: String::new(),
    });
    let tool_names: Vec<String> = ctx.tools.tool_specs().into_iter().map(|s| s.name).collect();
    sink.emit(SessionEvent::SubagentSpawned {
        session_id: session_id.to_string(),
        sub_id: run_id.to_string(),
        task_digest: truncate_chars(&spec.task, 60),
        tool_subset: tool_names,
    });
    wal.append_run(
        session_id,
        run_id,
        "subagent.spawn",
        &format!(
            "{{\"run_id\":\"{run_id}\",\"eta_hint_ms\":{eta_hint},\"task\":\"{}\"}}",
            truncate_chars(&spec.task, 60)
        ),
    );

    let system_full = probe_system(&ctx, &spec.task);
    let tools = ctx.tools.tool_specs();
    let mut history: Vec<Round> = vec![];
    let mut steps = 0usize;
    let result = loop {
        if steps >= SUBAGENT_MAX_STEPS {
            break ProbeResult {
                run_id: run_id.to_string(),
                ok: false,
                summary: format!(
                    "超步自杀（>{SUBAGENT_MAX_STEPS}），部分结果：{}",
                    last_text(&history)
                ),
            };
        }
        steps += 1;
        let req = ChatRequest {
            model: ctx.model_name.clone(),
            messages: messages_with(&system_full, &history, &spec.task),
            tools: tools.clone(),
        };
        let Ok(stream) = ctx.model.chat(&req) else {
            break ProbeResult {
                run_id: run_id.to_string(),
                ok: false,
                summary: "模型通道失败".into(),
            };
        };
        let (text, tool_calls, finish) = drain(stream);
        history.push(Round::Assistant {
            content: text.clone(),
            tool_calls: tool_calls
                .iter()
                .map(|t| bbrt_context::ToolCallRecord {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    args_digest: bbrt_sec::masking::args_digest(&t.arguments),
                })
                .collect(),
        });
        if finish != FinishReason::ToolCalls || tool_calls.is_empty() {
            break ProbeResult {
                run_id: run_id.to_string(),
                ok: true,
                summary: clamp_summary(&text),
            };
        }
        for tc in tool_calls {
            let call = ToolInvocation {
                call_id: tc.id.clone(),
                name: tc.name.clone(),
                args_json: tc.arguments.clone(),
                session_id: session_id.to_string(),
            };
            let summary = match ctx.tools.execute(ctx.mode, &call) {
                ToolOutcome::Ok { summary, .. } => summary,
                ToolOutcome::Blocked { summary, .. } => format!("[被拦] {summary}"),
            };
            history.push(Round::Tool {
                call_id: tc.id.clone(),
                name: tc.name.clone(),
                summary: clamp_summary(&summary),
            });
        }
    };

    let phase = if result.ok { "done" } else { "fail" };
    sink.emit(SessionEvent::SubagentProbeEvt {
        session_id: session_id.to_string(),
        sub_id: run_id.to_string(),
        phase: phase.into(),
        summary: Some(truncate_chars(&result.summary, 200)),
    });
    wal.append_run(
        session_id,
        run_id,
        "subagent.event",
        &format!("{{\"run_id\":\"{run_id}\",\"phase\":\"{phase}\"}}"),
    );
    wal.run_end(
        run_id,
        &RunEnd {
            status: if result.ok { "done" } else { "failed" },
            eta_actual_ms: started.elapsed().as_millis() as i64,
            summary: &truncate_chars(&result.summary, 400),
            child_session_ref: "",
        },
    );
    result
}

/// fan-out 结果（D16 决策④：等待窗内收口=Joined 即时回填；
/// 超窗=Backgrounded——剩余子任务后台继续，摘要经 hub park 下一轮回填）
pub enum FanoutOutcome {
    Joined(String),
    Backgrounded { pending: usize },
}

/// fan-out 编排（loop_runner 调用）：状态迁移 #9 → 线程并行 ≤3（detached）
/// → 等待窗内 join #10 即时回填 / 超窗转后台（收口线程聚合剩余 →
/// join 事件 + hub park，D16 §5）。返回聚合产物给调用方决定回填方式。
#[allow(clippy::too_many_arguments)]
pub fn fanout_probes(
    session_id: &str,
    deps_mode: PermissionMode,
    model: Arc<dyn ChatClient>,
    tools: Arc<dyn ToolExecutor>,
    sink: Arc<dyn SessionSink>,
    wal: Arc<dyn EventLog>,
    subs: &[ProbeSpec],
    env: &FanoutEnv<'_>,
) -> FanoutOutcome {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let total = subs.len();
    let run_ids: Vec<String> = (0..total)
        .map(|i| {
            wal.next_run_id()
                .unwrap_or_else(|| format!("sub-{now_ms}-{i}"))
        })
        .collect();
    // detached 线程（超窗后仍继续跑——D16 决策④无时长上限；结果经通道回投）
    let (tx, rx) = std::sync::mpsc::channel::<ProbeResult>();
    for (spec, run_id) in subs.iter().zip(run_ids.iter()) {
        let ctx = ProbeCtx {
            model: Arc::clone(&model),
            tools: Arc::clone(&tools),
            mode: deps_mode,
            system: env.system.to_string(),
            skills: Arc::clone(env.skills),
            memory: env.memory.cloned(),
            workspace: env.workspace.to_string(),
            model_name: env.model_name.clone(),
        };
        let tx = tx.clone();
        let sink = Arc::clone(&sink);
        let wal = Arc::clone(&wal);
        let sid = session_id.to_string();
        let run_id = run_id.clone();
        let spec = spec.clone();
        let _ = std::thread::Builder::new()
            .name(format!("bbw-subagent-{run_id}"))
            .spawn(move || {
                // 单任务 panic 不阻塞（结果通道缺项由收口侧兜底标注）
                let r = run_probe(ctx, &sid, &run_id, &spec, sink, wal);
                let _ = tx.send(r);
            });
    }
    drop(tx); // 发送端全在子线程：全部结果到齐后 rx 自然 EOF
              // 等待窗（缺省 120s，SessionRunner.subagent_wait_window 注入）
    let deadline = std::time::Instant::now() + env.wait_window;
    let mut results: Vec<ProbeResult> = Vec::with_capacity(total);
    while results.len() < total {
        let remain = deadline.saturating_duration_since(std::time::Instant::now());
        if remain.is_zero() {
            break;
        }
        match rx.recv_timeout(remain) {
            Ok(r) => results.push(r),
            Err(_) => break,
        }
    }
    if results.len() == total {
        // 窗内收口：join 摘要即时回填（旧行为）
        let digest = join_summary(session_id, &results, sink.as_ref(), wal.as_ref());
        return FanoutOutcome::Joined(digest);
    }
    // 超窗转后台：收口线程聚合剩余 → join 事件 + hub park（manager 下轮注入）
    let pending = total - results.len();
    let sid = session_id.to_string();
    let sink_bg = Arc::clone(&sink);
    let wal_bg = Arc::clone(&wal);
    let hub = env.hub.clone();
    let _ = std::thread::Builder::new()
        .name("bbw-fanout-join".into())
        .spawn(move || {
            let mut all = results;
            while all.len() < total {
                match rx.recv() {
                    Ok(r) => all.push(r),
                    Err(_) => break, // 发送端全失（panic 兜底）：带部分结果收口
                }
            }
            let digest = join_summary(&sid, &all, sink_bg.as_ref(), wal_bg.as_ref());
            if let Some(hub) = hub {
                hub.park_join(
                    &sid,
                    crate::delegate_bg::DelegateJoin {
                        name: "subagent.join".into(),
                        run_id: format!("fanout-{total}"),
                        summary: format!("## 并行子任务结果（后台完成）\n{digest}"),
                    },
                );
            }
        });
    FanoutOutcome::Backgrounded { pending }
}

/// fan-out 环境（主会话投影：system/技能/记忆/工作区/模型名 + 等待窗 + hub）
pub struct FanoutEnv<'a> {
    pub system: &'a str,
    pub skills: &'a Arc<Mutex<crate::skills::SkillIndex>>,
    pub memory: Option<&'a Arc<MemoryEngine>>,
    pub workspace: &'a str,
    /// 主循环同款模型名（override 优先回落档位）
    pub model_name: String,
    /// 同步等待窗（超窗转后台，D16 决策④）
    pub wait_window: std::time::Duration,
    /// 后台产物 parking（None=无 manager 装配：后台收口仅发事件不注入）
    pub hub: Option<Arc<crate::delegate_bg::DelegateHub>>,
}

/// join 收口：协议事件 + WAL + 摘要文本（主上下文回填用）
pub fn join_summary(
    session_id: &str,
    results: &[ProbeResult],
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
) -> String {
    let proto: Vec<bbrt_protocol::SubagentResult> = results
        .iter()
        .map(|r| bbrt_protocol::SubagentResult {
            sub_id: r.run_id.clone(),
            ok: r.ok,
            summary: truncate_chars(&r.summary, 200),
        })
        .collect();
    sink.emit(SessionEvent::SubagentJoined {
        session_id: session_id.to_string(),
        results: proto,
    });
    wal.append(
        session_id,
        "subagent.join",
        &format!("{{\"count\":{}}}", results.len()),
    );
    results
        .iter()
        .map(|r| {
            format!(
                "- [{}] {}：{}",
                if r.ok { "ok" } else { "fail" },
                r.run_id,
                truncate_chars(&r.summary, 400)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 状态迁移辅助（loop_runner 注入点用；迁移失败降级继续主循环）
pub fn transition_fanout(state: SessionState) -> SessionState {
    state::begin_fanout(state).unwrap_or(SessionState::SubagentFanout)
}

/// 状态迁移辅助（join 后回 running）
pub fn transition_join(state: SessionState) -> SessionState {
    state::join_subagents(state).unwrap_or(SessionState::Running)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 摘要 token 上限截断（按 CJK≈4:1 保守起步，char boundary 对齐）
pub(crate) fn clamp_summary(text: &str) -> String {
    if estimate_tokens(text) <= PROBE_SUMMARY_TOKENS {
        return text.to_string();
    }
    let mut end = (PROBE_SUMMARY_TOKENS * 3).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    while end > 0 && estimate_tokens(&text[..end]) > PROBE_SUMMARY_TOKENS {
        end = end.saturating_sub(256).min(end);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
    }
    format!("{}…[truncated]", &text[..end])
}

pub(crate) fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn last_text(history: &[Round]) -> String {
    history
        .iter()
        .rev()
        .find_map(|r| match r {
            Round::Assistant { content, .. } if !content.is_empty() => Some(clamp_summary(content)),
            _ => None,
        })
        .unwrap_or_default()
}

/// 流收集（单轮：文本 + 工具调用 + finish）
pub(crate) fn drain(
    stream: Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
) -> (String, Vec<ToolCallMsg>, FinishReason) {
    let mut text = String::new();
    let mut calls = vec![];
    let mut finish = FinishReason::Stop;
    for ev in stream {
        match ev {
            Ok(StreamEvent::TextDelta { text: t }) => text.push_str(&t),
            Ok(StreamEvent::ToolCallBegin { id, name, .. }) => calls.push(ToolCallMsg {
                id,
                name,
                arguments: String::new(),
            }),
            Ok(StreamEvent::ToolCallDelta { index, args_delta }) => {
                if let Some(tc) = calls.get_mut(index) {
                    tc.arguments.push_str(&args_delta);
                }
            }
            Ok(StreamEvent::Done { finish: f, .. }) => finish = f,
            Err(_) => break,
        }
    }
    (text, calls, finish)
}

/// 独立窗口组装（探查/专家子会话共用：任意 system + 任务指令，无主历史）
pub(crate) fn messages_with(system: &str, history: &[Round], task: &str) -> Vec<ChatMessage> {
    let mut msgs = vec![
        ChatMessage {
            role: "system".into(),
            content: system.to_string(),
            tool_calls: vec![],
            tool_call_id: None,
        },
        ChatMessage {
            role: "user".into(),
            content: task.to_string(),
            tool_calls: vec![],
            tool_call_id: None,
        },
    ];
    for r in history {
        match r {
            Round::User { content } => msgs.push(ChatMessage {
                role: "user".into(),
                content: content.clone(),
                tool_calls: vec![],
                tool_call_id: None,
            }),
            Round::Assistant {
                content,
                tool_calls,
            } => msgs.push(ChatMessage {
                role: "assistant".into(),
                content: content.clone(),
                tool_calls: tool_calls
                    .iter()
                    .map(|t| ToolCallMsg {
                        id: t.id.clone(),
                        name: t.name.clone(),
                        arguments: String::new(),
                    })
                    .collect(),
                tool_call_id: None,
            }),
            Round::Tool {
                call_id,
                name,
                summary,
            } => msgs.push(ChatMessage {
                role: "tool".into(),
                content: clamp_summary(summary),
                tool_calls: vec![],
                tool_call_id: Some(format!("{call_id}:{name}")),
            }),
        }
    }
    msgs
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 围栏剥离：```json 围栏/裸 JSON/前置噪声。
    #[test]
    fn strip_fence_variants() {
        assert_eq!(strip_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_fence("{\"a\":1}"), "{\"a\":1}");
    }

    /// clamp_summary：超限截断且落在 char 边界（中文字符不被劈开）。
    #[test]
    fn clamp_summary_respects_boundary() {
        let long = "中".repeat(9000); // ≈9000 tokens（CJK 1:1 估算）
        let out = clamp_summary(&long);
        assert!(out.ends_with("…[truncated]"));
        assert!(estimate_tokens(&out) <= PROBE_SUMMARY_TOKENS + 64);
        let mixed = format!("{}{}", "abc".repeat(3000), long);
        let out2 = clamp_summary(&mixed);
        assert!(out2.contains('…') || estimate_tokens(&mixed) <= PROBE_SUMMARY_TOKENS);
    }
}
