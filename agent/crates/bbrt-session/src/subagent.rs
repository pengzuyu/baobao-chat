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
//!
//! 派发入口（2026-11-26）：`spawn_subagents` 通用工具——要不要派子 Agent、
//! 每个任务用哪种类型，全由主 Agent 自己判断（引导与类型清单见
//! [`spawn_subagents_description`]，类型登记见 [`SUBAGENT_KINDS`]）；以一次
//! 工具调用发起，loop_runner 专用路径承接 → 本模块 [`fanout_probes`]。
//! 原「每条消息先跑一次隐藏模型调用判定要不要拆」的前置 planner 已退役：
//! 判定藏在主请求之前，用户只见「正在处理」，首字平白多等一次完整往返。

use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg};
use bbrt_context::{estimate_tokens, Round};
use bbrt_memory::MemoryEngine;

use crate::bg_hub::BgHub;
use crate::events::{SessionEvent, SessionSink};
use crate::executor::{ToolExecutor, ToolInvocation, ToolOutcome};
use crate::loop_runner::{BgHostMsg, EventLog};
use crate::state::{self, SessionState};
use bbrt_sec::gate::PermissionMode;

/// 单子任务步数上限（通用化后调大；超步自杀返回部分结果 + fail 标注）
pub const SUBAGENT_MAX_STEPS: usize = 60;

/// 摘要上限（token 估算；超限截断尾部）
pub const PROBE_SUMMARY_TOKENS: usize = 2000;

/// 并发上限（通用派发入口沿用：一次调用最多派这么多子 Agent）
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

/// 子 agent 通用派发入口的工具名（bbrt-tools 注册薄门面定义；执行由
/// loop_runner 专用路径承接）。子 Agent 自身的工具面剔除本工具，防嵌套派发
pub const SPAWN_SUBAGENTS_TOOL: &str = "spawn_subagents";

/// 类型 id：探查（主的分身）
pub const KIND_PROBE: &str = "probe";

/// 子 agent 类型（通用派发入口的「有哪些」单源）：工具描述由本表渲染，主
/// Agent 据此为每个任务选类型；执行侧按本表校验。新增类型=在此登记一行，
/// 并在 loop_runner 的派发路径接执行分支
pub struct SubagentKindDef {
    /// 类型 id（工具参数 tasks[].kind 的取值）
    pub kind: &'static str,
    /// 一句话介绍（进工具描述，供主 Agent 选择）
    pub summary: &'static str,
}

/// 已登记的子 agent 类型
pub const SUBAGENT_KINDS: &[SubagentKindDef] = &[SubagentKindDef {
    kind: KIND_PROBE,
    summary: "a general-purpose investigator with the same tools, skills and knowledge as you. \
              Use it to search code, read across many files or trace how something works, \
              without filling your own context",
}];

/// 按 id 查已登记类型
pub fn subagent_kind(kind: &str) -> Option<&'static SubagentKindDef> {
    SUBAGENT_KINDS.iter().find(|k| k.kind == kind)
}

/// 通用派发入口的工具描述：何时判断、什么情况该派、任务怎么写、有哪些类型。
/// 判断全交给主 Agent，这段文案是唯一的引导——漏拆/过度拆靠调它，不是硬保证
pub fn spawn_subagents_description() -> String {
    let kinds = SUBAGENT_KINDS
        .iter()
        .map(|k| format!("- {}: {}", k.kind, k.summary))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Launch subagents to handle parts of a task in parallel. Each subagent works in its own \
         context window, cannot see this conversation, does one task and returns a summary; the \
         summaries come back as this tool's result.\n\
         When to call — decide at the very start of the turn, before any other work. Launch \
         subagents when the task spans multiple directories, files or information sources and \
         splits into independent pieces (up to {}); skip it for a single focused question and do \
         that yourself. Subtasks are for investigation only: keep every write operation in the \
         main task and say so in each task.\n\
         Writing a task — each one must stand alone (the subagent has none of this conversation): \
         state the goal, where to look, and what to report back.\n\
         Subagent kinds — choose one per task:\n{kinds}",
        PROBE_MAX_CONCURRENCY
    )
}

/// 通用子 Agent 执行上下文（owned Arc——线程派发/后台化安全；
/// D16 决策①：system/技能/记忆/工具/模型与主会话同一来源）
pub struct ProbeCtx {
    pub model: Arc<dyn ChatClient>,
    pub tools: Arc<dyn ToolExecutor>,
    pub mode: PermissionMode,
    /// 主 system prompt 基底（loop_runner::system_prompt_base()，含品牌身份句与企业身份段）
    pub system: String,
    /// 技能索引（按任务文本命中注入，同主口径 ≤3 条）
    pub skills: Arc<Mutex<crate::skills::SkillIndex>>,
    /// 记忆侧写（recall_for(任务)，同主口径只读注入）
    pub memory: Option<Arc<MemoryEngine>>,
    pub workspace: String,
    /// 主循环同款模型名（override 优先回落档位——"与主一致"）
    pub model_name: String,
    /// 运行中枢（D16 决策⑧：注册补充指令/取消通道；None=未装配仅本地跑）
    pub hub: Option<Arc<BgHub>>,
    /// D35 定时任务：无人值守（工具面剔除 ask_user）
    pub unattended: bool,
}

/// 与主 to_chat_messages 同构的 system 组装（[技能]/[项目]/[记忆] 三段；
/// D19：记忆召回随主会话工作区分级——项目会话注用户+项目两段。
/// D33：技能目录区与主同口径（显式 skill 工具加载，隐式注入退役））
fn probe_system(ctx: &ProbeCtx, task: &str) -> String {
    let skills_text = {
        let idx = ctx.skills.lock().unwrap_or_else(|p| p.into_inner());
        idx.render_catalog()
    };
    let ws = if ctx.workspace.is_empty() {
        None
    } else {
        Some(std::path::Path::new(&ctx.workspace))
    };
    let memory_index = ctx
        .memory
        .as_ref()
        .map(|m| m.recall_scoped(ws, task))
        .unwrap_or_default();
    let project_line = if ctx.workspace.is_empty() {
        // 2026-11-23 三规范文案与主会话 project_line 共用单源（防漂移）
        crate::loop_runner::user_workspace_line(&bbrt_sec::sandbox::default_user_workspace())
    } else {
        format!("workspace: {}", ctx.workspace)
    };
    format!(
        "{}\n\n[Skills]\n{}\n\n[Project]\n{}\n\n[Memory]\n{}",
        ctx.system, skills_text, project_line, memory_index
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
    // 补充指令通道（D16 决策⑧）：注册先于执行循环——主 Agent/宿主
    // 经 hub 定向下发 Input（注入 user 轮）/Cancel（按指令取消）
    let (input_tx, input_rx) = std::sync::mpsc::channel::<BgHostMsg>();
    if let Some(hub) = ctx.hub.as_ref() {
        hub.register(run_id, session_id, input_tx.clone());
    }
    drop(input_tx);
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
    // 子 agent 工具面：恒剔除 spawn_subagents（派发入口只属主 Agent，防嵌套——
    // 执行体也只承接主循环）；D35 无人值守另剔 ask_user（无执行体，防误调）
    let tools = ctx
        .tools
        .tool_specs()
        .into_iter()
        .filter(|s| s.name != SPAWN_SUBAGENTS_TOOL && (!ctx.unattended || s.name != "ask_user"))
        .collect::<Vec<_>>();
    let mut history: Vec<Round> = vec![];
    let mut steps = 0usize;
    let mut cancelled = false;
    let result = loop {
        // 补充指令 drain（每步轮询；注入为 user 轮——下一模型轮即见）
        while let Ok(msg) = input_rx.try_recv() {
            match msg {
                BgHostMsg::Input { text } => {
                    wal.append_run(
                        session_id,
                        run_id,
                        "subagent.input",
                        &serde_json::json!({ "run_id": run_id, "text": text }).to_string(),
                    );
                    history.push(Round::User {
                        content: format!("[主 Agent 补充指令] {text}"),
                        attachments: Vec::new(),
                    });
                    sink.emit(SessionEvent::SubagentProbeEvt {
                        session_id: session_id.to_string(),
                        sub_id: run_id.to_string(),
                        phase: "delta".into(),
                        summary: Some(format!("收到补充指令：{}", truncate_chars(&text, 40))),
                    });
                }
                BgHostMsg::Cancel { .. } => {
                    wal.append_run(
                        session_id,
                        run_id,
                        "subagent.cancel",
                        &serde_json::json!({ "run_id": run_id }).to_string(),
                    );
                    cancelled = true;
                }
            }
        }
        if cancelled {
            break ProbeResult {
                run_id: run_id.to_string(),
                ok: false,
                summary: format!("已按指令取消，部分结果：{}", last_text(&history)),
            };
        }
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
            thinking: None,
        };
        let Ok(stream) = ctx.model.chat(&req) else {
            break ProbeResult {
                run_id: run_id.to_string(),
                ok: false,
                summary: "模型通道失败".into(),
            };
        };
        let (text, tool_calls, finish) = drain(stream);
        // 过程明细外发（D33 §3.2）：每模型轮整段文本一条 trace（正文进侧栏
        // run 流；reasoning 现状丢弃不外发，登记阶段二）
        if !text.is_empty() {
            trace_out(
                sink.as_ref(),
                wal.as_ref(),
                session_id,
                run_id,
                bbrt_protocol::SubagentTraceItem::Text {
                    text: clamp_summary(&text),
                },
            );
        }
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
            // 过程明细外发：工具发起（脱敏参数 + 风险级；P0 对齐=按 gate 逐调用
            // 分类，与主会话 tool.call 同口径，旧按工具名静态表退役）
            let (masked, _) = bbrt_sec::masking::mask_and_digest(&tc.arguments);
            let call = ToolInvocation {
                call_id: tc.id.clone(),
                name: tc.name.clone(),
                args_json: tc.arguments.clone(),
                session_id: session_id.to_string(),
            };
            let risk = match ctx.tools.risk_of_call(&call) {
                "low" => bbrt_protocol::RiskLevel::Low,
                "medium" => bbrt_protocol::RiskLevel::Medium,
                _ => bbrt_protocol::RiskLevel::High,
            };
            trace_out(
                sink.as_ref(),
                wal.as_ref(),
                session_id,
                run_id,
                bbrt_protocol::SubagentTraceItem::ToolCall {
                    call_id: tc.id.clone(),
                    tool: tc.name.clone(),
                    args_masked: masked,
                    risk,
                },
            );
            let exec_started = std::time::Instant::now();
            let (ok, summary) = match ctx.tools.execute(ctx.mode, &call) {
                ToolOutcome::Ok { summary, .. } => (true, summary),
                ToolOutcome::Blocked { summary, .. } => (false, format!("[被拦] {summary}")),
                ToolOutcome::Rejected { summary, .. } => (false, format!("[被拦] {summary}")),
            };
            // 过程明细外发：工具落定（含耗时）
            trace_out(
                sink.as_ref(),
                wal.as_ref(),
                session_id,
                run_id,
                bbrt_protocol::SubagentTraceItem::ToolResult {
                    call_id: tc.id.clone(),
                    ok,
                    summary: clamp_summary(&summary),
                    duration_ms: exec_started.elapsed().as_millis() as u64,
                },
            );
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
            status: if cancelled {
                "cancelled"
            } else if result.ok {
                "done"
            } else {
                "failed"
            },
            eta_actual_ms: started.elapsed().as_millis() as i64,
            summary: &truncate_chars(&result.summary, 400),
        },
    );
    if let Some(hub) = ctx.hub.as_ref() {
        hub.unregister(run_id);
    }
    result
}

/// fan-out 结果（D16 决策④：等待窗内收口=Joined 即时回填；
/// 超窗=Backgrounded——剩余子任务后台继续，摘要经 hub park 下一轮回填
/// （pending_ids=仍在跑的 run id，供主 Agent 经 task.wait 主动等）；
/// 等待中用户停止=Interrupted——已到结果作废，子任务由 hub 取消自行收尾）
pub enum FanoutOutcome {
    Joined(String),
    Backgrounded {
        pending: usize,
        pending_ids: Vec<String>,
    },
    Interrupted,
}

/// 等待窗内的唤醒粒度：每片之间检查一次中断旗（停止的最长反应延迟）
const FANOUT_WAIT_SLICE: std::time::Duration = std::time::Duration::from_millis(500);

/// fan-out 编排（loop_runner 的 spawn_subagents 专用路径调用；目前类型只有
/// 探查）：状态迁移 #9 → 线程并行 ≤3（detached）→ 等待窗内 join #10 即时回填 /
/// 超窗转后台（收口线程聚合剩余 → join 事件 + hub park，D16 §5） / 等待中用户
/// 停止即返。返回聚合产物给调用方决定回填方式。
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
            wal.next_task_id("probe")
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
            hub: env.hub.clone(),
            unattended: env.unattended,
        };
        let tx = tx.clone();
        let sink = Arc::clone(&sink);
        let wal = Arc::clone(&wal);
        let sid = session_id.to_string();
        let run_id = run_id.clone();
        let spec = spec.clone();
        let _ = std::thread::Builder::new()
            .name(format!("bbc-subagent-{run_id}"))
            .spawn(move || {
                // 单任务 panic 不阻塞（结果通道缺项由收口侧兜底标注）
                let r = run_probe(ctx, &sid, &run_id, &spec, sink, wal);
                let _ = tx.send(r);
            });
    }
    drop(tx); // 发送端全在子线程：全部结果到齐后 rx 自然 EOF
              // 等待窗（缺省 SUBAGENT_WAIT_WINDOW=600s，SessionRunner.subagent_wait_window 注入）
    let deadline = std::time::Instant::now() + env.wait_window;
    let stopped = |env: &FanoutEnv<'_>| {
        env.interrupt
            .is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed))
    };
    let mut results: Vec<ProbeResult> = Vec::with_capacity(total);
    while results.len() < total {
        if stopped(env) {
            break;
        }
        let remain = deadline.saturating_duration_since(std::time::Instant::now());
        if remain.is_zero() {
            break;
        }
        // 分片等待：片间回来看一眼中断旗（整窗阻塞等=用户点停止后仍干等
        // 子任务自己收到取消；子任务在模型流中途要到本轮结束才响应）
        match rx.recv_timeout(remain.min(FANOUT_WAIT_SLICE)) {
            Ok(r) => results.push(r),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
    if stopped(env) {
        return FanoutOutcome::Interrupted;
    }
    if results.len() == total {
        // 窗内收口：join 摘要即时回填（旧行为）
        let digest = join_summary(session_id, &results, sink.as_ref(), wal.as_ref());
        return FanoutOutcome::Joined(digest);
    }
    // 超窗转后台：收口线程聚合剩余 → join 事件 + hub park（manager 下轮注入）
    let pending_ids: Vec<String> = run_ids
        .iter()
        .filter(|id| !results.iter().any(|r| &r.run_id == *id))
        .cloned()
        .collect();
    let pending = pending_ids.len();
    let sid = session_id.to_string();
    let sink_bg = Arc::clone(&sink);
    let wal_bg = Arc::clone(&wal);
    let hub = env.hub.clone();
    let _ = std::thread::Builder::new()
        .name("bbc-fanout-join".into())
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
                    crate::bg_hub::BgJoin {
                        name: "subagent.join".into(),
                        run_id: format!("fanout-{total}"),
                        summary: format!("## 并行子任务结果（后台完成）\n{digest}"),
                    },
                );
            }
        });
    FanoutOutcome::Backgrounded {
        pending,
        pending_ids,
    }
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
    /// 主会话中断旗（等待中用户「停止」即返 Interrupted；None=不响应中断）
    pub interrupt: Option<&'a std::sync::atomic::AtomicBool>,
    /// 后台产物 parking（None=无 manager 装配：后台收口仅发事件不注入）
    pub hub: Option<Arc<crate::bg_hub::BgHub>>,
    /// D35 定时任务：无人值守（子 agent 工具面剔除 ask_user）
    pub unattended: bool,
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

/// 过程明细外发 + WAL 同步落行（D33 §3.2）：事件按 sub_id 路由侧栏 run 流；
/// WAL 行 type=subagent.trace、payload=item 序列化（run.history 回放同构投影）。
/// 2026-11-18 起委派 run 过程流同款复用（loop_runner pump）
pub(crate) fn trace_out(
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
    session_id: &str,
    run_id: &str,
    item: bbrt_protocol::SubagentTraceItem,
) {
    sink.emit(SessionEvent::SubagentTrace {
        session_id: session_id.to_string(),
        sub_id: run_id.to_string(),
        item: item.clone(),
    });
    if let Ok(payload) = serde_json::to_string(&item) {
        wal.append_run(session_id, run_id, "subagent.trace", &payload);
    }
}

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
            // 子代理思考增量不并入产物正文（2026-11-11）
            Ok(StreamEvent::ReasoningDelta { .. }) => {}
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

/// 独立窗口组装（探查/专家子会话共用：任意 system + 任务指令，无主历史）。
/// 子代理无视觉通道（2026-11-26）：历史用户轮的附件只以清单行进文本
/// （图像数据不进子窗口——成本与窗口预算归主会话管）
pub(crate) fn messages_with(system: &str, history: &[Round], task: &str) -> Vec<ChatMessage> {
    let mut msgs = vec![
        ChatMessage {
            role: "system".into(),
            content: system.into(),
            tool_calls: vec![],
            tool_call_id: None,
        },
        ChatMessage {
            role: "user".into(),
            content: task.into(),
            tool_calls: vec![],
            tool_call_id: None,
        },
    ];
    for r in history {
        match r {
            Round::User {
                content,
                attachments,
            } => {
                let mut text = content.clone();
                for a in attachments {
                    text.push('\n');
                    text.push_str(&a.context_line());
                }
                msgs.push(ChatMessage {
                    role: "user".into(),
                    content: text.into(),
                    tool_calls: vec![],
                    tool_call_id: None,
                })
            }
            Round::Assistant {
                content,
                tool_calls,
            } => msgs.push(ChatMessage {
                role: "assistant".into(),
                content: content.as_str().into(),
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
                content: clamp_summary(summary).into(),
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

    /// 类型登记表是工具描述的唯一来源：每个已登记类型都出现在描述里，
    /// id 不重复——新登记类型忘了进描述的情况在此被拦
    #[test]
    fn tool_description_lists_every_registered_kind() {
        let desc = spawn_subagents_description();
        for k in SUBAGENT_KINDS {
            assert!(
                desc.contains(&format!("- {}: ", k.kind)),
                "描述缺类型 {}",
                k.kind
            );
            assert!(desc.contains(k.summary), "描述缺类型 {} 的介绍", k.kind);
        }
        let mut ids: Vec<&str> = SUBAGENT_KINDS.iter().map(|k| k.kind).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), SUBAGENT_KINDS.len(), "类型 id 重复");
        assert_eq!(subagent_kind(KIND_PROBE).map(|k| k.kind), Some(KIND_PROBE));
        assert!(subagent_kind("no-such-kind").is_none());
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
