//! 探查子 Agent（08 §4.5 / D11 §7）：主 Agent 派生的**独立上下文窗口**
//! 轻量执行体——只读工具子集、快模型、单任务 ≤15 步、只回传摘要
//! （≤2k tokens，不回传原文），并发 ≤3。
//!
//! 触发：FanoutPlanner（bin 装配快模型实现；测试注入假件）判定任务
//! complex 并给出子任务清单。执行体直接复用 LoopDeps 的模型与工具
//! （完整走 bbrt-tools 管线：gate/审计/脱敏——"复用 09 篇权限模型"，
//! 只读子集天然 A 放行，不产生检查点）。

use bbrt_aigw::{
    ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg, ToolSpec,
};
use bbrt_context::{estimate_tokens, Round};

use crate::events::SessionEvent;
use crate::executor::{ToolExecutor, ToolInvocation, ToolOutcome};
use crate::state::{self, SessionState};
use bbrt_sec::gate::PermissionMode;

/// 探查工具白名单（08 §4.5 只读子集；kb_query/doc_read 随网关供给后加入）
pub const PROBE_TOOLS: &[&str] = &[
    "read_file",
    "list_dir",
    "search_files",
    "git_status",
    "git_diff",
];

/// 单子任务步数上限（超步自杀，返回部分结果 + fail 标注）
pub const PROBE_MAX_STEPS: usize = 15;

/// 摘要上限（token 估算；超限截断尾部）
pub const PROBE_SUMMARY_TOKENS: usize = 2000;

/// 并发上限（subtasks.take）
pub const PROBE_MAX_CONCURRENCY: usize = 3;

/// 子任务简报（独立上下文：仅此文本 + 探查角色 system，无主历史）
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeSpec {
    pub task: String,
}

/// 子任务产物（join 聚合与主上下文回填用）
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub sub_id: String,
    pub ok: bool,
    pub summary: String,
}

/// 分解判定（依赖倒置：bin 用快模型实现；None=不分解回主循环）
pub trait FanoutPlanner: Send + Sync {
    fn plan(&self, model: &dyn ChatClient, user_text: &str) -> Option<Vec<ProbeSpec>>;
}

/// 快模型判定器（19 篇 bbw-fast；输出 JSON {complex, subtasks[]}，
/// 解析失败/围栏噪声一律降级为"不分解"——探查是优化不是依赖）
pub struct FastPlanner;

const PLANNER_SYSTEM: &str = "判定任务是否值得并行探查。输出纯 JSON（无围栏无解释）：\n\
    {\"complex\": true|false, \"subtasks\": [\"独立可并行的探查任务\", ...]}\n\
    判定 complex：涉及多目录/多文件/多信息源，且子任务只读可并行（最多 3 条）；\
    单一问题/修改类任务 complex=false。";

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

/// 探查执行上下文（借用 LoopDeps 的模型与工具执行器）
pub struct ProbeCtx<'a> {
    pub model: &'a dyn ChatClient,
    pub tools: &'a dyn ToolExecutor,
    pub mode: PermissionMode,
}

const PROBE_SYSTEM: &str = "你是只读探查 Agent（子任务执行体）。只使用提供的只读工具收集信息，\
    不做任何修改。完成后输出结构化摘要（要点、关键路径、结论），\
    不粘贴文件原文大段内容。";

/// 跑一个探查子任务：spawn 事件 → mini-loop（≤15 步，工具经完整管线执行）
/// → done/fail 事件（phase delta 略——探查摘要以 done 一次性上报）。
pub fn run_probe(
    ctx: ProbeCtx<'_>,
    session_id: &str,
    sub_id: &str,
    spec: &ProbeSpec,
    sink: &dyn crate::events::SessionSink,
    wal: &dyn crate::loop_runner::EventLog,
) -> ProbeResult {
    sink.emit(SessionEvent::SubagentSpawned {
        session_id: session_id.to_string(),
        sub_id: sub_id.to_string(),
        task_digest: truncate_chars(&spec.task, 60),
        tool_subset: PROBE_TOOLS.iter().map(|s| s.to_string()).collect(),
    });
    wal.append(
        session_id,
        "subagent.spawn",
        &format!(
            "{{\"sub_id\":\"{}\",\"task\":\"{}\"}}",
            sub_id,
            truncate_chars(&spec.task, 60)
        ),
    );

    let mut history: Vec<Round> = vec![];
    let mut steps = 0usize;
    let result = loop {
        if steps >= PROBE_MAX_STEPS {
            break ProbeResult {
                sub_id: sub_id.to_string(),
                ok: false,
                summary: format!(
                    "超步自杀（>{PROBE_MAX_STEPS}），部分结果：{}",
                    last_text(&history)
                ),
            };
        }
        steps += 1;
        let req = ChatRequest {
            model: "bbw-fast".to_string(),
            messages: probe_messages(&history, &spec.task),
            tools: probe_specs(ctx.tools),
        };
        let Ok(stream) = ctx.model.chat(&req) else {
            break ProbeResult {
                sub_id: sub_id.to_string(),
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
                sub_id: sub_id.to_string(),
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
        sub_id: sub_id.to_string(),
        phase: phase.into(),
        summary: Some(truncate_chars(&result.summary, 200)),
    });
    wal.append(
        session_id,
        "subagent.event",
        &format!("{{\"sub_id\":\"{sub_id}\",\"phase\":\"{phase}\"}}"),
    );
    result
}

/// fan-out 编排（loop_runner 调用）：状态迁移 #9 → 线程并行 ≤3 → join #10。
/// 返回聚合结果（调用方负责回填主上下文与 join 事件）。
pub fn fanout_probes(
    session_id: &str,
    deps_mode: PermissionMode,
    model: &dyn ChatClient,
    tools: &dyn ToolExecutor,
    sink: &dyn crate::events::SessionSink,
    wal: &dyn crate::loop_runner::EventLog,
    subs: &[ProbeSpec],
) -> Vec<ProbeResult> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 线程并行（ChatClient: Send+Sync；单任务 panic 不阻塞——join 处标注，08 §4.5）
    std::thread::scope(|s| {
        let handles: Vec<_> = subs
            .iter()
            .enumerate()
            .map(|(i, spec)| {
                let sub_id = format!("sub-{now_ms}-{i}");
                let spec = spec.clone();
                s.spawn(move || {
                    run_probe(
                        ProbeCtx {
                            model,
                            tools,
                            mode: deps_mode,
                        },
                        session_id,
                        &sub_id,
                        &spec,
                        sink,
                        wal,
                    )
                })
            })
            .collect();
        handles
            .into_iter()
            .enumerate()
            .map(|(i, h)| {
                h.join().unwrap_or_else(|_| ProbeResult {
                    sub_id: format!("sub-{now_ms}-{i}"),
                    ok: false,
                    summary: "子任务线程 panic".into(),
                })
            })
            .collect()
    })
}

/// join 收口：协议事件 + WAL + 摘要文本（主上下文回填用）
pub fn join_summary(
    session_id: &str,
    results: &[ProbeResult],
    sink: &dyn crate::events::SessionSink,
    wal: &dyn crate::loop_runner::EventLog,
) -> String {
    let proto: Vec<bbrt_protocol::SubagentResult> = results
        .iter()
        .map(|r| bbrt_protocol::SubagentResult {
            sub_id: r.sub_id.clone(),
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
                r.sub_id,
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

/// 探查消息组装（独立窗口：system 角色 + 任务指令，无主历史）
fn probe_messages(history: &[Round], task: &str) -> Vec<ChatMessage> {
    messages_with(PROBE_SYSTEM, history, task)
}

/// 通用独立窗口组装（探查/专家子会话共用：任意 system + 任务指令，无主历史）
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

/// 白名单工具 specs（模型只见只读子集）
fn probe_specs(tools: &dyn ToolExecutor) -> Vec<ToolSpec> {
    tools
        .tool_specs()
        .into_iter()
        .filter(|s| PROBE_TOOLS.contains(&s.name.as_str()))
        .collect()
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
