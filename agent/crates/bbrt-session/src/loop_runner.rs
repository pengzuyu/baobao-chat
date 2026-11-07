//! 核心循环（08 §4.1 伪码的可执行化，D11 §2.2 loop_runner）。
//!
//! 一轮 turn：user.message → 上下文组装（必要时 compaction）→ 模型流式
//! （stream.delta 逐段外发）→ 工具调用轮（门控→审批→沙箱执行→脱敏回填）
//! → 直至 finish=stop 或步数/失败上限。全程 WAL 先行、journal 喂记忆双轨。
//!
//! 并发模型：同步阻塞；每 turn 在独立线程跑（bin 装配），宿主侧
//! respond_permission 经 channel 注入，120s 超时=拒绝（09 §7.4）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::delegation::{DelegateEvt, DelegateLaunchReq, DelegateLauncher};
use bbrt_aigw::{ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg};
use bbrt_context::{
    assemble, budget_report, compact, AssembleParts, BudgetConfig, CompactionOutcome, Round,
    Summarizer, ToolCallRecord, ToolResultEntry,
};
use bbrt_memory::{ActivityEvent, MemoryEngine};
use bbrt_sec::gate::PermissionMode;
use bbrt_sec::memory::GrantScope;
use bbrt_store::Store;

use crate::events::{ModelTier, SessionEvent, SessionSink, StreamChannel};
use crate::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use crate::state::{self, SessionState};

/// 循环上限与失败熔断（D11 §3 表：步数>50、连续工具失败>3）
pub const MAX_STEPS: usize = 50;
pub const MAX_CONSECUTIVE_FAILURES: usize = 3;
/// 审批等待窗口（09 §4.1 ⑥；测试可注入更短值）
pub const PERMISSION_TIMEOUT: Duration = Duration::from_secs(120);

/// 审批回执（宿主 → 循环）
#[derive(Debug, Clone)]
pub struct PermissionResponse {
    pub request_id: String,
    pub decision: PermissionDecision,
    pub scope: GrantScope,
    /// 用户编辑后的命令/参数（D08 §3.4 回传 editedArgs）
    pub edited: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Deny,
}

/// 宿主→循环的委派指令（delegate.launch/input/cancel/review 的 session 侧形态）
#[derive(Debug, Clone)]
pub enum DelegateHostMsg {
    Launch {
        backend: String,
        /// 用户编辑后的简报（None=用模型产出原稿）
        brief: Option<bbrt_protocol::TaskBrief>,
    },
    Input {
        text: String,
    },
    Cancel {
        graceful: bool,
    },
    Review {
        accept: bool,
    },
}

/// WAL 出口抽象（Store 实现；测试可注入 Noop）
pub trait EventLog: Send + Sync {
    fn append(&self, session_id: &str, type_: &str, payload: &str);
}
pub struct NoopEventLog;
impl EventLog for NoopEventLog {
    fn append(&self, _: &str, _: &str, _: &str) {}
}
/// rusqlite Connection 非 Sync（内含 RefCell）——跨线程共享经 Mutex（bin 装配持有 Arc<Mutex<Store>>）
impl EventLog for std::sync::Mutex<Store> {
    fn append(&self, session_id: &str, type_: &str, payload: &str) {
        if let Ok(store) = self.lock() {
            if let Ok(seq) = store.next_event_seq(session_id) {
                let _ = store.append_event(session_id, seq, type_, payload);
            }
        }
    }
}

/// 快模型摘要器（compaction 用；08 §4.6 降档语义的正面应用）
struct FastSummarizer<'a> {
    client: &'a dyn ChatClient,
    /// 档位别名（预留：AigwClient 按别名路由，请求体 model 已固定 bbw-fast）
    #[allow(dead_code)]
    model: String,
}
impl Summarizer for FastSummarizer<'_> {
    fn summarize(&self, text: &str) -> Result<String, String> {
        chat_text(self.client, "把以下对话压缩为要点摘要，≤300字。", text)
    }
}

/// bbw-fast 单轮调用共用壳（system+user → 流式汇总全文）；
/// compaction 摘要与 W3 记忆提炼共用（19 篇档位别名固定 bbw-fast）
fn chat_text(client: &dyn ChatClient, system: &str, user: &str) -> Result<String, String> {
    let req = ChatRequest {
        model: "bbw-fast".to_string(),
        messages: vec![
            ChatMessage {
                role: "system".into(),
                content: system.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".into(),
                content: user.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
            },
        ],
        tools: vec![],
    };
    let mut out = String::new();
    let iter = client.chat(&req).map_err(|e| e.to_string())?;
    for ev in iter {
        match ev {
            Ok(StreamEvent::TextDelta { text }) => out.push_str(&text),
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if out.trim().is_empty() {
        Err("空回复".into())
    } else {
        Ok(out)
    }
}

/// 会话运行器（单会话；由 SessionManager 构造）
pub struct SessionRunner {
    pub session_id: String,
    pub workspace: String,
    pub mode: PermissionMode,
    pub model_policy: ModelTier,
    state: SessionState,
    history: Vec<Round>,
    tool_results: Vec<ToolResultEntry>,
    /// stream.delta 会话内序号
    delta_seq: AtomicU64,
    /// 紧急停止/暂停旗标（宿主置位；循环在事件与步间检查）
    pub interrupted: Arc<AtomicBool>,
    permission_tx: Sender<PermissionResponse>,
    permission_rx: Receiver<PermissionResponse>,
    /// 委派宿主指令通道（launch/input/cancel/review；与审批通道分离）
    delegate_tx: Sender<DelegateHostMsg>,
    delegate_rx: Receiver<DelegateHostMsg>,
    /// W2② 连续错误计数器（同工具同错 ≥2 次 → feedback 教训；跨 turn 保留）
    err_tracker: bbrt_memory::ErrorTracker,
    /// 审批超时（测试注入）
    pub permission_timeout: Duration,
}

/// 一轮 turn 的产物（manager 记账用）
#[derive(Debug, Default)]
pub struct TurnReport {
    pub steps: usize,
    pub tool_calls: usize,
    pub tool_failures: usize,
    pub usage_in: u64,
    pub usage_out: u64,
    pub paused: bool,
}

impl SessionRunner {
    pub fn new(
        session_id: String,
        workspace: String,
        mode: PermissionMode,
        model_policy: ModelTier,
    ) -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        let (dtx, drx) = std::sync::mpsc::channel();
        Self {
            session_id,
            workspace,
            mode,
            model_policy,
            state: state::begin(),
            history: vec![],
            tool_results: vec![],
            delta_seq: AtomicU64::new(0),
            interrupted: Arc::new(AtomicBool::new(false)),
            permission_tx: tx,
            permission_rx: rx,
            delegate_tx: dtx,
            delegate_rx: drx,
            // v0.1 恒开（`memory.heuristic=off` 开关随配置系统接线，D15 §2.2）
            err_tracker: bbrt_memory::ErrorTracker::new(true),
            permission_timeout: PERMISSION_TIMEOUT,
        }
    }
}

/// 循环依赖集合（bin 装配；测试用假件）
pub struct LoopDeps {
    pub model: Arc<dyn ChatClient>,
    pub tools: Arc<dyn ToolExecutor>,
    /// 委派启动器（None=未装配 → coding.delegate 返回 8030）
    pub delegator: Option<Arc<dyn DelegateLauncher>>,
    pub memory: Option<Arc<MemoryEngine>>,
    pub wal: Arc<dyn EventLog>,
    pub sink: Arc<dyn SessionSink>,
    /// 检查点服务（None=未装配 → pre-edit/委派快照跳过；08 §4.4）
    pub snapshots: Option<Arc<dyn crate::checkpoint::SnapshotService>>,
    /// 技能索引（10 篇 §4.5：triggers 命中正文注入 skills 区块；tools.reload 热替换）
    pub skills: Arc<Mutex<crate::skills::SkillIndex>>,
    pub budget: BudgetConfig,
}

impl SessionRunner {
    /// 执行一轮 turn（user.message 已入 history 前置）
    pub fn run_turn(&mut self, user_text: &str, deps: &LoopDeps) -> TurnReport {
        let mut report = TurnReport::default();
        self.state = state::accept_user_message(self.state).unwrap_or(SessionState::Running);
        emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
            session_id: id,
            state: "running".into(),
            reason: "user.message".into(),
        });
        deps.wal.append(
            &self.session_id,
            "turn.start",
            &format!("{{\"text_len\":{}}}", user_text.len()),
        );
        // 崩溃恢复契约（§9.2 时间线重建）：用户原文独立落 WAL——
        // turn.start 仅记长度，恢复重放依赖 user.text 找回轮次内容
        deps.wal.append(
            &self.session_id,
            "user.text",
            &format!("{{\"text\":\"{}\"}}", escape_json(user_text)),
        );

        // 记忆召回注入（D15 §2.3：按当前消息精排——条目少全量、多则 Top-K 关键词档）
        let memory_index = deps
            .memory
            .as_ref()
            .map(|m| m.knowledge().recall_for(user_text).unwrap_or_default())
            .unwrap_or_default();

        self.history.push(Round::User {
            content: user_text.to_string(),
        });
        // 被动轨：用户输入的启发式记忆提示（W2①；正文取原句，标题截 40 字）
        if let Some(m) = deps.memory.as_ref() {
            if let Some(title) = bbrt_memory::detect_memory_hint(user_text) {
                let input = bbrt_memory::SaveInput {
                    title,
                    body: user_text.to_string(),
                    mtype: bbrt_memory::MemoryType::User,
                    session: self.session_id.clone(),
                    links: vec![],
                };
                if let Ok(outcome) = m.save_memory(&input) {
                    emit_memory_saved(deps, &self.session_id, &outcome);
                }
            }
        }

        loop {
            if report.steps >= MAX_STEPS || self.interrupted.load(Ordering::Relaxed) {
                report.paused = true;
                break;
            }
            // ① compaction 判定（D11 §5.2）
            let br = budget_report(&deps.budget, &self.history, &self.tool_results);
            if br.needs_compaction {
                emit(deps, &self.session_id, |id| SessionEvent::Compaction {
                    session_id: id,
                    phase: "start".into(),
                    freed_tokens: 0,
                    degraded: false,
                });
                let summarizer = FastSummarizer {
                    client: deps.model.as_ref(),
                    model: "bbw-fast".into(), // 19 篇档位别名
                };
                match compact(&deps.budget, &self.history, &summarizer) {
                    Ok(CompactionOutcome {
                        archived_summary,
                        kept_rounds,
                        degraded_to_truncation,
                        freed_tokens,
                    }) => {
                        self.history = kept_rounds;
                        self.history.insert(
                            0,
                            Round::User {
                                content: format!(
                                    "[已压缩摘要，原文见本地事件镜像]\n{archived_summary}"
                                ),
                            },
                        );
                        emit(deps, &self.session_id, |id| SessionEvent::Compaction {
                            session_id: id,
                            phase: "done".into(),
                            freed_tokens,
                            degraded: degraded_to_truncation,
                        });
                    }
                    Err(_) => {
                        emit(deps, &self.session_id, |id| SessionEvent::Error {
                            session_id: id,
                            code: 8010,
                            message: "压缩后仍超上下文上限".into(),
                            fatal: true,
                        });
                        report.paused = true;
                        break;
                    }
                }
            }

            // ② 组装 + 请求模型
            report.steps += 1;
            // 技能命中注入（10 篇 §4.5：用户消息含 trigger 的技能正文进 skills
            // 区块，context 预算 5% 截断兜底；索引空/未命中=空段零成本）
            let skills_text = {
                let idx = deps.skills.lock().unwrap_or_else(|p| p.into_inner());
                let matched = idx.match_for(user_text);
                idx.render(&matched)
            };
            let assembled = assemble(
                &deps.budget,
                AssembleParts {
                    system: SYSTEM_PROMPT,
                    skills: &skills_text,
                    project: &format!("workspace: {}", self.workspace),
                    memory_index: &memory_index,
                    history: &self.history,
                    tool_results: &self.tool_results,
                },
            );
            let messages = to_chat_messages(&assembled);
            // 19 篇 §3.2：调用方 model 只允许档位别名
            let model_name = match self.model_policy {
                ModelTier::Fast => "bbw-fast".to_string(),
                ModelTier::Strong => "bbw-strong".to_string(),
            };
            let req = ChatRequest {
                model: model_name,
                messages,
                tools: deps.tools.tool_specs(),
            };

            // ③ 流式消费（delta 即时外发；错误→8011 语义暂停）
            let stream = match deps.model.chat(&req) {
                Ok(s) => s,
                Err(e) => {
                    emit(deps, &self.session_id, |id| SessionEvent::Error {
                        session_id: id,
                        code: 8011,
                        message: format!("模型不可用: {e}"),
                        fatal: false,
                    });
                    report.paused = true;
                    break;
                }
            };
            let mut text = String::new();
            let mut tool_calls: Vec<ToolCallMsg> = vec![];
            let mut finish = FinishReason::Stop;
            let mut usage = (0u64, 0u64);
            let mut stream_failed: Option<String> = None;
            for ev in stream {
                match ev {
                    Ok(StreamEvent::TextDelta { text: t }) => {
                        text.push_str(&t);
                        let seq = self.delta_seq.fetch_add(1, Ordering::Relaxed) as u32;
                        emit(deps, &self.session_id, |id| SessionEvent::StreamDelta {
                            session_id: id,
                            delta: t,
                            seq,
                            channel: StreamChannel::Text,
                        });
                    }
                    Ok(StreamEvent::ToolCallBegin { id, name, .. }) => {
                        tool_calls.push(ToolCallMsg {
                            id,
                            name,
                            arguments: String::new(),
                        });
                    }
                    Ok(StreamEvent::ToolCallDelta { index, args_delta }) => {
                        if let Some(tc) = tool_calls.get_mut(index) {
                            tc.arguments.push_str(&args_delta);
                        }
                    }
                    Ok(StreamEvent::Done {
                        finish: f,
                        usage: u,
                    }) => {
                        finish = f;
                        usage = (u.prompt_tokens as u64, u.completion_tokens as u64);
                    }
                    Err(e) => {
                        stream_failed = Some(e.to_string());
                        break;
                    }
                }
                if self.interrupted.load(Ordering::Relaxed) {
                    break;
                }
            }
            if let Some(detail) = stream_failed {
                emit(deps, &self.session_id, |id| SessionEvent::Error {
                    session_id: id,
                    code: 8011,
                    message: format!("流中断（{detail}），已产出内容不重放（08 §4.6）"),
                    fatal: false,
                });
                report.paused = true;
                break;
            }
            report.usage_in += usage.0;
            report.usage_out += usage.1;
            emit(deps, &self.session_id, |id| SessionEvent::StreamDone {
                session_id: id,
                finish: match finish {
                    FinishReason::Stop => "stop".into(),
                    FinishReason::ToolCalls => "tool_calls".into(),
                    FinishReason::Length => "length".into(),
                },
                usage_in: usage.0,
                usage_out: usage.1,
            });
            // 崩溃恢复契约：一轮模型输出完成（recovery 以 assistant.done
            // 配对 user.text 落 assistant 轮，摘要级重建即可续会话）
            deps.wal.append(
                &self.session_id,
                "assistant.done",
                &format!(
                    "{{\"finish\":\"{}\",\"usage_in\":{},\"usage_out\":{}}}",
                    match finish {
                        FinishReason::Stop => "stop",
                        FinishReason::ToolCalls => "tool_calls",
                        FinishReason::Length => "length",
                    },
                    usage.0,
                    usage.1
                ),
            );
            self.history.push(Round::Assistant {
                content: text.clone(),
                tool_calls: tool_calls
                    .iter()
                    .map(|tc| ToolCallRecord {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        args_digest: bbrt_sec::masking::args_digest(&tc.arguments),
                    })
                    .collect(),
            });

            // ④ 无工具调用 → 本轮完成
            if finish != FinishReason::ToolCalls
                || tool_calls.is_empty()
                || self.interrupted.load(Ordering::Relaxed)
            {
                break;
            }

            // ⑤ 工具轮（严格串行；D11 §6 不变量）
            let mut consecutive_failures = 0usize;
            for tc in tool_calls {
                if self.interrupted.load(Ordering::Relaxed) {
                    report.paused = true;
                    break;
                }
                let call = ToolInvocation {
                    call_id: tc.id.clone(),
                    name: tc.name.clone(),
                    args_json: tc.arguments.clone(),
                    session_id: self.session_id.clone(),
                };
                let (masked, _) = bbrt_sec::masking::mask_and_digest(&call.args_json);
                let risk = risk_of(&tc.name);
                emit(deps, &self.session_id, |id| SessionEvent::ToolCall {
                    session_id: id,
                    call_id: tc.id.clone(),
                    tool: tc.name.clone(),
                    args_masked: masked.clone(),
                    risk: risk.into(),
                });
                deps.wal.append(
                    &self.session_id,
                    "tool.call",
                    &format!("{{\"call_id\":\"{}\",\"tool\":\"{}\"}}", tc.id, tc.name),
                );

                // 修改类工具前置快照（08 §4.4：stash 式 pre-edit；5min 窗口去重在服务内）
                if is_modifying(&tc.name) {
                    self.snapshot_before_edit(deps);
                }

                let outcome = self.run_tool(deps, &call, &masked, risk);
                // W2② 连续错误教训（D15 §2.2：同工具同错 ≥2 次 → 自动记 feedback）
                match &outcome {
                    ToolOutcome::Ok { .. } => self.err_tracker.record_success(&tc.name),
                    ToolOutcome::Blocked { summary, .. } => {
                        if let Some(lesson) = self.err_tracker.record_failure(&tc.name, summary) {
                            if let Some(m) = deps.memory.as_ref() {
                                let input = bbrt_memory::SaveInput {
                                    title: lesson.title,
                                    body: lesson.body,
                                    mtype: bbrt_memory::MemoryType::Feedback,
                                    session: self.session_id.clone(),
                                    links: vec![],
                                };
                                if let Ok(outcome) = m.save_memory(&input) {
                                    emit_memory_saved(deps, &self.session_id, &outcome);
                                }
                            }
                        }
                    }
                }
                let summary = match &outcome {
                    ToolOutcome::Ok {
                        summary,
                        truncated,
                        exit_code,
                        duration_ms,
                    } => {
                        report.tool_calls += 1;
                        if let Some(m) = deps.memory.as_ref() {
                            let _ = m.record(&ActivityEvent::ToolExecuted {
                                session: self.session_id.clone(),
                                tool: tc.name.clone(),
                                ok: true,
                                duration_ms: *duration_ms,
                                risk: risk.into(),
                            });
                        }
                        emit(deps, &self.session_id, |id| SessionEvent::ToolResult {
                            session_id: id,
                            call_id: tc.id.clone(),
                            ok: true,
                            summary: summary.clone(),
                            truncated: *truncated,
                            exit_code: *exit_code,
                            duration_ms: *duration_ms,
                            blocked_code: None,
                        });
                        format!("{summary}{}", if *truncated { " [截断]" } else { "" })
                    }
                    ToolOutcome::Blocked { code, summary } => {
                        report.tool_calls += 1;
                        report.tool_failures += 1;
                        consecutive_failures += 1;
                        if let Some(m) = deps.memory.as_ref() {
                            let _ = m.record(&ActivityEvent::ToolBlocked {
                                session: self.session_id.clone(),
                                tool: tc.name.clone(),
                                code: *code as u16,
                            });
                        }
                        emit(deps, &self.session_id, |id| SessionEvent::ToolResult {
                            session_id: id,
                            call_id: tc.id.clone(),
                            ok: false,
                            summary: summary.clone(),
                            truncated: false,
                            exit_code: None,
                            duration_ms: 0,
                            blocked_code: Some(*code),
                        });
                        format!("[被阻止 {code}] {summary}")
                    }
                };
                self.tool_results.push(ToolResultEntry {
                    call_id: tc.id.clone(),
                    name: tc.name.clone(),
                    summary: summary.clone(),
                    est_tokens: bbrt_context::estimate_tokens(&summary),
                });
                self.history.push(Round::Tool {
                    call_id: tc.id.clone(),
                    name: tc.name.clone(),
                    summary,
                });
                deps.wal.append(
                    &self.session_id,
                    "tool.result",
                    &format!("{{\"call_id\":\"{}\"}}", tc.id),
                );
                if consecutive_failures > MAX_CONSECUTIVE_FAILURES {
                    emit(deps, &self.session_id, |id| SessionEvent::Error {
                        session_id: id,
                        code: 8021,
                        message: "连续工具失败超限，转暂停".into(),
                        fatal: false,
                    });
                    report.paused = true;
                    break;
                }
            }
            if report.paused {
                break;
            }
        }

        // 收尾状态
        self.state = if report.paused {
            state::pause(self.state).unwrap_or(SessionState::Paused)
        } else {
            state::complete_round(self.state).unwrap_or(SessionState::Idle)
        };
        // 崩溃恢复契约：turn 边界（recovery 以 turn.end 关闭 in_turn 窗口——
        // 未闭合的残留 pending_user 同样兜底入历史，用户输入不丢）
        deps.wal.append(
            &self.session_id,
            "turn.end",
            &format!(
                "{{\"steps\":{},\"paused\":{}}}",
                report.steps, report.paused
            ),
        );
        emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
            session_id: id,
            state: if report.paused {
                "paused".into()
            } else {
                "idle".into()
            },
            reason: if report.paused {
                "limit_or_interrupt".into()
            } else {
                "stop".into()
            },
        });
        report
    }

    /// 委派全流程：简报确认 → 宿主 launch → 事件流 → 审查 → 回填摘要
    fn run_delegate(
        &mut self,
        deps: &LoopDeps,
        call: &ToolInvocation,
        masked: &str,
        _risk: &str,
    ) -> ToolOutcome {
        let Some(delegator) = deps.delegator.clone() else {
            return ToolOutcome::Blocked {
                code: 8030,
                summary: "未装配委派后端（registry 为空）".into(),
            };
        };
        let task_id = format!("dt-{}", call.call_id);
        let backends = delegator.backends();
        let suggestion = backends.first().cloned().unwrap_or_default();

        // 状态 → delegating + 简报待确认（D11 #11：确认后才 launch）
        self.state = state::begin_delegation(self.state).unwrap_or(SessionState::Delegating);
        emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
            session_id: id,
            state: "delegating".into(),
            reason: "delegate.brief".into(),
        });
        emit(deps, &self.session_id, |id| SessionEvent::DelegateBrief {
            session_id: id,
            delegate_task_id: task_id.clone(),
            backend_suggestion: suggestion.clone(),
        });
        deps.wal.append(
            &self.session_id,
            "delegate.brief",
            &format!("{{\"task_id\":\"{task_id}\"}}"),
        );

        // 等宿主 delegate.launch（复用审批超时 120s；超时/取消=放弃该工具调用）
        let (backend, brief_override) = match self.delegate_rx.recv_timeout(self.permission_timeout)
        {
            Ok(DelegateHostMsg::Launch { backend, brief }) => (backend, brief),
            Ok(_) | Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                self.state =
                    state::complete_delegation(self.state).unwrap_or(SessionState::Running);
                return ToolOutcome::Blocked {
                    code: 8030,
                    summary: "委派未被确认或超时".into(),
                };
            }
        };
        let brief = brief_override.unwrap_or_else(|| parse_brief(call, &self.workspace));
        let req = DelegateLaunchReq {
            delegate_task_id: task_id.clone(),
            backend: if backend.is_empty() {
                suggestion
            } else {
                backend
            },
            brief,
            mode: self.mode,
        };
        let mut stream = match delegator.launch(&req) {
            Ok(s) => s,
            Err(e) => {
                emit(deps, &self.session_id, |id| SessionEvent::Error {
                    session_id: id,
                    code: 8035,
                    message: format!("委派启动失败: {e}"),
                    fatal: false,
                });
                self.state =
                    state::complete_delegation(self.state).unwrap_or(SessionState::Running);
                return ToolOutcome::Blocked {
                    code: 8035,
                    summary: e,
                };
            }
        };
        // 委派前置快照（08 §4.4 reason=delegate；子进程改动可回滚锚点，17 篇）
        if let Some(svc) = deps.snapshots.as_ref() {
            if let Ok(out) = svc.create(&self.session_id, &self.workspace, "delegate") {
                emit_checkpoint(deps, &self.session_id, &out);
            }
        }
        deps.wal.append(
            &self.session_id,
            "delegate.launch",
            &format!(
                "{{\"task_id\":\"{task_id}\",\"backend\":\"{}\"}}",
                req.backend
            ),
        );
        if let Some(m) = deps.memory.as_ref() {
            let _ = m.record(&ActivityEvent::DelegateLaunched {
                session: self.session_id.clone(),
                backend: req.backend.clone(),
            });
        }

        // 事件流：归一化事件外发；Input/Cancel 即时处理；interrupt 优雅取消
        loop {
            if self.interrupted.load(Ordering::Relaxed) {
                stream.cancel(true);
            }
            while let Ok(msg) = self.delegate_rx.try_recv() {
                match msg {
                    DelegateHostMsg::Input { text } => {
                        emit(deps, &self.session_id, |id| SessionEvent::DelegateEvt {
                            session_id: id,
                            delegate_task_id: task_id.clone(),
                            kind: "input".into(),
                            payload: text,
                        });
                    }
                    DelegateHostMsg::Cancel { graceful } => stream.cancel(graceful),
                    _ => {}
                }
            }
            let Some(evt) = stream.next() else { break };
            let (kind, payload) = match evt {
                DelegateEvt::Meta { text, .. } => ("meta", text),
                DelegateEvt::Delta { channel, text } => (
                    "delta",
                    match channel {
                        crate::delegation::DelegateChannel::Text => format!(
                            "{{\"channel\":\"text\",\"text\":\"{}\"}}",
                            escape_json(&text)
                        ),
                        crate::delegation::DelegateChannel::Reasoning => format!(
                            "{{\"channel\":\"reasoning\",\"text\":\"{}\"}}",
                            escape_json(&text)
                        ),
                    },
                ),
                DelegateEvt::ToolUse { call_id, tool, .. } => (
                    "tool_use",
                    format!("{{\"call_id\":\"{call_id}\",\"tool\":\"{tool}\"}}"),
                ),
                DelegateEvt::ToolResult { call_id, ok, .. } => (
                    "tool_result",
                    format!("{{\"call_id\":\"{call_id}\",\"ok\":{ok}}}"),
                ),
                DelegateEvt::Warning { text } => ("warning", text),
                DelegateEvt::Exit { .. } => ("exit", String::new()),
            };
            emit(deps, &self.session_id, |id| SessionEvent::DelegateEvt {
                session_id: id,
                delegate_task_id: task_id.clone(),
                kind: kind.to_string(),
                payload,
            });
        }

        // finalize + delegate.end（异常退出 8033）
        let final_rep = stream.finalize();
        let exit_code = final_rep.exit_code.unwrap_or(-1);
        emit(deps, &self.session_id, |id| SessionEvent::DelegateEnd {
            session_id: id,
            delegate_task_id: task_id.clone(),
            exit_code,
            summary: final_rep.summary.clone(),
        });
        deps.wal.append(
            &self.session_id,
            "delegate.end",
            &format!("{{\"task_id\":\"{task_id}\",\"exit\":{exit_code}}}"),
        );
        if let Some(m) = deps.memory.as_ref() {
            let _ = m.record(&ActivityEvent::DelegateEnded {
                session: self.session_id.clone(),
                backend: req.backend.clone(),
                exit_code,
            });
        }
        if exit_code != 0 {
            self.state = state::fail_delegation(self.state).unwrap_or(SessionState::Running);
            return ToolOutcome::Blocked {
                code: 8033,
                summary: format!("委派异常退出（exit={exit_code}）"),
            };
        }

        // 审查（D11 #14-15：waiting_review；v0.1 对齐审批 120s 窗口，超时=拒绝，登记）
        self.state = state::request_review(self.state).unwrap_or(SessionState::WaitingReview);
        emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
            session_id: id,
            state: "waiting_review".into(),
            reason: "delegate.review".into(),
        });
        let accepted = loop {
            if self.interrupted.load(Ordering::Relaxed) {
                break false;
            }
            match self.delegate_rx.recv_timeout(self.permission_timeout) {
                Ok(DelegateHostMsg::Review { accept }) => break accept,
                Ok(DelegateHostMsg::Cancel { .. }) => break false,
                Ok(_) => continue,
                Err(_) => break false,
            }
        };
        emit(deps, &self.session_id, |id| {
            SessionEvent::DelegateReviewResolved {
                session_id: id,
                delegate_task_id: task_id.clone(),
                decision: if accepted { "accept" } else { "reject" }.into(),
            }
        });
        self.state = state::resolve_review(self.state).unwrap_or(SessionState::Running);
        let _ = masked;
        if accepted {
            ToolOutcome::Ok {
                summary: format!("[委派完成] {}", final_rep.summary),
                truncated: false,
                exit_code: Some(exit_code),
                duration_ms: 0,
            }
        } else {
            ToolOutcome::Blocked {
                code: 8002,
                summary: "用户拒绝委派结果".into(),
            }
        }
    }

    /// 单个工具调用全流程：门控 →（审批 → 记忆）→ 执行
    fn run_tool(
        &mut self,
        deps: &LoopDeps,
        call: &ToolInvocation,
        masked: &str,
        risk: &str,
    ) -> ToolOutcome {
        // 委派编码（D11 §3 #11-13）：专用路径——delegating 态 + 宿主确认 + 事件流 + 审查
        if call.name == "coding.delegate" || call.name == "coding_delegate" {
            return self.run_delegate(deps, call, masked, risk);
        }
        match deps.tools.check(self.mode, call) {
            CheckOutcome::Allow { source } => {
                let _ = source;
                deps.tools.execute(self.mode, call)
            }
            CheckOutcome::Deny { code, message } => ToolOutcome::Blocked {
                code,
                summary: message,
            },
            CheckOutcome::NeedConfirm {
                reason,
                preview,
                options,
            } => {
                // 状态机 → waiting_permission（D11 §3 #6）
                self.state = state::request_permission(self.state)
                    .unwrap_or(SessionState::WaitingPermission);
                let request_id = format!("pr-{}", call.call_id);
                emit(deps, &self.session_id, |id| {
                    SessionEvent::PermissionRequest {
                        session_id: id,
                        request_id: request_id.clone(),
                        tool: call.name.clone(),
                        risk: risk.into(),
                        args_masked: masked.to_string(),
                        reason,
                        preview_kind: preview.kind.clone(),
                        preview: preview.content.clone(),
                        options,
                    }
                });
                deps.wal.append(
                    &self.session_id,
                    "permission.request",
                    &format!("{{\"request_id\":\"{request_id}\"}}"),
                );

                // 等待宿主回执；120s 超时=拒绝（09 §7.4）
                let decision = match self.permission_rx.recv_timeout(self.permission_timeout) {
                    Ok(resp)
                        if resp.request_id == request_id
                            && resp.decision == PermissionDecision::Allow =>
                    {
                        let _ = deps.tools.record_grant(self.mode, call, resp.scope);
                        emit(deps, &self.session_id, |id| {
                            SessionEvent::PermissionResolved {
                                session_id: id,
                                request_id: request_id.clone(),
                                decision: "allow".into(),
                                scope: format!("{:?}", resp.scope).to_lowercase(),
                            }
                        });
                        // 用户编辑过命令 → 覆盖 args（D08 editedArgs）
                        let mut exec_call = call.clone();
                        if let Some(edited) = resp.edited {
                            exec_call.args_json = edited;
                        }
                        self.state =
                            state::permission_resolved(self.state).unwrap_or(SessionState::Running);
                        deps.wal.append(
                            &self.session_id,
                            "permission.resolved",
                            &format!("{{\"request_id\":\"{request_id}\",\"decision\":\"allow\"}}"),
                        );
                        Some(exec_call)
                    }
                    Ok(resp) if resp.request_id == request_id => {
                        emit(deps, &self.session_id, |id| {
                            SessionEvent::PermissionResolved {
                                session_id: id,
                                request_id: request_id.clone(),
                                decision: "deny".into(),
                                scope: format!("{:?}", resp.scope).to_lowercase(),
                            }
                        });
                        self.state =
                            state::permission_resolved(self.state).unwrap_or(SessionState::Running);
                        deps.wal.append(
                            &self.session_id,
                            "permission.resolved",
                            &format!("{{\"request_id\":\"{request_id}\",\"decision\":\"deny\"}}"),
                        );
                        None
                    }
                    Ok(_) => None, // 迟到的其它回执：按超时处理
                    Err(RecvTimeoutError::Timeout) => {
                        emit(deps, &self.session_id, |id| {
                            SessionEvent::PermissionResolved {
                                session_id: id,
                                request_id: request_id.clone(),
                                decision: "timeout".into(),
                                scope: "once".into(),
                            }
                        });
                        self.state =
                            state::permission_resolved(self.state).unwrap_or(SessionState::Running);
                        deps.wal.append(
                            &self.session_id,
                            "permission.resolved",
                            &format!(
                                "{{\"request_id\":\"{request_id}\",\"decision\":\"timeout\"}}"
                            ),
                        );
                        None
                    }
                    Err(RecvTimeoutError::Disconnected) => None,
                };
                match decision {
                    Some(exec_call) => deps.tools.execute(self.mode, &exec_call),
                    None => ToolOutcome::Blocked {
                        code: 8002,
                        summary: "用户拒绝或审批超时".into(),
                    },
                }
            }
        }
    }

    /// 会话结束：日报重算 + journal 收口（D15 §3.2 触发 1）
    pub fn end(&mut self, deps: &LoopDeps, summary: &str) {
        self.state = state::end(self.state);
        deps.wal.append(
            &self.session_id,
            "session.ended",
            &format!("{{\"summary_len\":{}}}", summary.len()),
        );
        if let Some(m) = deps.memory.as_ref() {
            let _ = m.record(&ActivityEvent::SessionEnded {
                session: self.session_id.clone(),
                summary: if summary.is_empty() {
                    None
                } else {
                    Some(summary.to_string())
                },
                duration_ms: 0,
            });
            // W3 会话结束提炼（D15 §2.2）：在日报重算前落盘——当日日报的
            // memory_saved 计数即含提炼条目（§3.2 交叉印证）；失败静默不阻塞收口
            let saved = distill_memories(deps, &self.session_id, &self.history);
            if saved > 0 {
                deps.wal.append(
                    &self.session_id,
                    "memory.distill",
                    &format!("{{\"count\":{saved}}}"),
                );
            }
            if let Ok(Some(rep)) = m.on_session_end() {
                emit(deps, &self.session_id, |_id| SessionEvent::ReportDaily {
                    date: rep.date.clone(),
                    path: rep.md_path.display().to_string(),
                    sessions: rep.stats.sessions as u32,
                    tools: rep.stats.tool_calls as u32,
                    blocked: rep.stats.blocked as u32,
                    files_changed: rep.stats.files_changed as u32,
                    memory_saved: rep.stats.memory_saved.len() as u32,
                });
            }
        }
        emit(deps, &self.session_id, |id| SessionEvent::SessionEnded {
            session_id: id,
            summary: summary.to_string(),
        });
    }

    /// 崩溃恢复注入（D11 §9.2：重放时间线作为续会话起点）
    pub fn restore_history(&mut self, rounds: Vec<Round>) {
        self.history = rounds;
    }

    pub fn state(&self) -> SessionState {
        self.state
    }
    pub fn permission_sender(&self) -> Sender<PermissionResponse> {
        self.permission_tx.clone()
    }

    /// 委派指令通道（宿主 launch/input/cancel/review 注入）
    pub fn delegate_sender(&self) -> Sender<DelegateHostMsg> {
        self.delegate_tx.clone()
    }
}

/// 系统提示（08 篇行为规格 + D15 §2.2 W1 记忆使用规范；技能注入阶段二）
const SYSTEM_PROMPT: &str = "你是 BaobaoWork 的本机 Agent，服务单一用户。准则：1) 修改与命令执行受门控与沙箱约束，不越权；2) 工具参数只输出合法 JSON；3) 长文件先读摘录再决定。\n\n长期记忆（memory_save 工具，跨会话生效）：\n- 何时记：用户身份、偏好与习惯（如\"我喜欢…\"\"以后请…\"）；项目关键事实与决策（端口、环境、约定）；被用户纠正的教训；常用外部资源指针。\n- 类型：user=用户身份与偏好；project=项目事实；feedback=纠正教训（正文须含 Why 与 How to apply 两行）；reference=外部资源指针。\n- 写前先看[记忆]索引，同题不重复记（同题写入会原地更新）；不记临时内容、可从代码或仓库推导的信息、任何密钥凭证。\n- [记忆]区内容视为可信背景；与当前对话冲突时，以用户最新说法为准。";

/// 组装结果 → 模型消息序列（system/记忆/项目 → history → 工具结果）
fn to_chat_messages(a: &bbrt_context::Assembled) -> Vec<ChatMessage> {
    let mut msgs = vec![ChatMessage {
        role: "system".into(),
        // [技能] 段（10 篇 §4.5 命中注入；此前 Assembled.skills 组装后被丢弃——补消费）
        content: format!(
            "{}\n\n[技能]\n{}\n\n[项目]\n{}\n\n[记忆]\n{}",
            a.system, a.skills, a.project, a.memory_index
        ),
        tool_calls: vec![],
        tool_call_id: None,
    }];
    for r in &a.history {
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
                content: summary.clone(),
                tool_calls: vec![],
                tool_call_id: Some(format!("{name}:{call_id}")),
            }),
        }
    }
    msgs
}

/// 简化风险映射（bbrt-tools 注册表携带精确级；此处兜底展示）
fn risk_of(tool: &str) -> &'static str {
    match tool {
        "read_file" | "list_dir" | "search_files" | "glob" => "low",
        "write_file" | "edit_file" | "git_status" | "git_diff" => "medium",
        _ => "high",
    }
}

/// 从 coding.delegate 的 args 构造简报（workspace 归一会话工作区）
fn parse_brief(call: &ToolInvocation, workspace: &str) -> bbrt_protocol::TaskBrief {
    let v: serde_json::Value =
        serde_json::from_str(&call.args_json).unwrap_or(serde_json::json!({}));
    let s = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let vecs = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|i| i.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    bbrt_protocol::TaskBrief {
        task: s("task"),
        workspace: workspace.to_string(),
        constraints: vecs("constraints"),
        context: vec![],
        acceptance: vecs("acceptance"),
        forbidden: vecs("forbidden"),
    }
}

/// 修改类工具名单（pre-edit 快照判定；只读/网络类不入）
fn is_modifying(tool: &str) -> bool {
    matches!(
        tool,
        "write_file" | "edit_file" | "run_command" | "git_commit" | "git_push"
    )
}

impl SessionRunner {
    /// pre-edit 检查点（失败不阻塞工具执行——审计缺段由 checkpoint.created 缺失体现）
    fn snapshot_before_edit(&self, deps: &LoopDeps) {
        let Some(svc) = deps.snapshots.as_ref() else {
            return;
        };
        match svc.pre_edit(&self.session_id, &self.workspace) {
            Ok(Some(out)) => emit_checkpoint(deps, &self.session_id, &out),
            Ok(None) => {}
            Err(_) => {}
        }
    }
}

/// 检查点落账：WAL + checkpoint.created 事件（pre-edit/manual/delegate/pre-restore 共用）
fn emit_checkpoint(deps: &LoopDeps, session_id: &str, out: &crate::checkpoint::SnapshotOutcome) {
    deps.wal.append(
        session_id,
        "checkpoint.created",
        &format!(
            "{{\"id\":\"{}\",\"reason\":\"{}\"}}",
            out.checkpoint_id, out.reason
        ),
    );
    emit(deps, session_id, |id| SessionEvent::CheckpointCreated {
        session_id: id,
        checkpoint_id: out.checkpoint_id.clone(),
        files_changed: out.files_changed.clone(),
        reason: out.reason.clone(),
        git_ref: out.git_ref.clone(),
    });
}

/// WAL/事件内嵌 JSON 字符串转义（避免手拼破坏 JSON 结构）
fn escape_json(s: &str) -> String {
    serde_json::to_string(s)
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
}

/// 事件外发小工具（闭包拿 session_id，避免重复借用）
fn emit(deps: &LoopDeps, session_id: &str, f: impl FnOnce(String) -> SessionEvent) {
    deps.sink.emit(f(session_id.to_string()));
}

// ---------------------------------------------------------------------------
// W3 会话结束提炼（D15 §2.2 表第 3 行；bbw-fast，尽力而为）
// ---------------------------------------------------------------------------

/// W3 每会话最多提炼条数（防记忆膨胀）
const DISTILL_MAX_ITEMS: usize = 3;
/// W3 会话转录总量上限（字符；超出截断，保尾部最近的轮次）
const DISTILL_TRANSCRIPT_MAX_CHARS: usize = 8_000;

/// W3：会话结束把"决策/偏好/教训"提炼成长期记忆。模型失败、输出不可解析、
/// 条目非法（空标题/未知类型）一律静默跳过——绝不阻塞会话收口。返回落盘条数。
fn distill_memories(deps: &LoopDeps, session_id: &str, history: &[Round]) -> usize {
    let Some(m) = deps.memory.as_ref() else {
        return 0;
    };
    // 无 assistant 回复（如模型不可用即暂停）→ 无可提炼内容
    if !history.iter().any(|r| matches!(r, Round::Assistant { .. })) {
        return 0;
    }
    let transcript = transcript_of(history);
    if transcript.is_empty() {
        return 0;
    }
    // 已有索引喂给模型防重复（取头 60 行控提示长度；save 侧同题去重兜底）
    let existing = m.knowledge().recall().unwrap_or_default();
    let existing_head: String = existing.lines().take(60).collect::<Vec<_>>().join("\n");
    let system = format!(
        "从会话记录提炼值得跨会话记住的长期事实。只输出 JSON 数组（最多 {DISTILL_MAX_ITEMS} 条，\
         无可记输出 []），每项形如 {{\"title\":\"一句话标题≤40字\",\
         \"type\":\"user|project|feedback|reference\",\
         \"body\":\"事实正文（feedback 须含 Why 与 How to apply 两行）\"}}。\
         只记：用户身份/偏好/习惯、项目关键事实与决策、被用户纠正的教训。\
         不记：临时内容、代码细节、密钥。以下为已有记忆索引，与其重复的不要产出：\n\
         {existing_head}"
    );
    let raw = match chat_text(deps.model.as_ref(), &system, &transcript) {
        Ok(s) => s,
        Err(_) => return 0, // 提炼是增益路径：模型不可用/空回复 → 放弃
    };
    let mut saved = 0usize;
    for item in parse_distill_items(&raw)
        .into_iter()
        .take(DISTILL_MAX_ITEMS)
    {
        let input = bbrt_memory::SaveInput {
            title: item.title,
            body: item.body,
            mtype: item.mtype,
            session: session_id.to_string(),
            links: vec![],
        };
        if let Ok(outcome) = m.save_memory(&input) {
            emit_memory_saved(deps, session_id, &outcome);
            saved += 1;
        }
    }
    saved
}

/// 会话历史 → 提炼转录：仅 User/Assistant 文本轮（工具摘要信噪低不入），
/// 每轮截 2K 字符；总量超限从头部丢弃（保最近的轮次）
fn transcript_of(history: &[Round]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for r in history {
        let (role, content) = match r {
            Round::User { content } => ("用户", content.as_str()),
            Round::Assistant { content, .. } => {
                if content.trim().is_empty() {
                    continue;
                }
                ("助手", content.as_str())
            }
            Round::Tool { .. } => continue,
        };
        if content.trim().is_empty() {
            continue;
        }
        let cut: String = content.chars().take(2_000).collect();
        lines.push(format!("{role}：{cut}"));
    }
    let mut total: usize = lines.iter().map(|l| l.chars().count()).sum();
    while total > DISTILL_TRANSCRIPT_MAX_CHARS && !lines.is_empty() {
        // 头部（最旧）轮次整行丢弃；仍超限则该行本身已被 2K 截断，退出
        let dropped = lines.remove(0);
        total -= dropped.chars().count();
        if dropped.chars().count() > DISTILL_TRANSCRIPT_MAX_CHARS {
            break;
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// W3 提炼候选（解析中间态）
struct DistillItem {
    title: String,
    body: String,
    mtype: bbrt_memory::MemoryType,
}

/// 提炼输出解析：剥 ```json 围栏、截取最外层 [...] 段 → JSON 数组；
/// 缺字段/未知类型/空串的条目逐项丢弃（坏一条不弃整批）
fn parse_distill_items(raw: &str) -> Vec<DistillItem> {
    let trimmed = raw.trim();
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.strip_suffix("```").unwrap_or(s))
        .unwrap_or(trimmed);
    let Some(start) = body.find('[') else {
        return vec![];
    };
    let Some(end) = body.rfind(']') else {
        return vec![];
    };
    if end <= start {
        return vec![];
    }
    let Ok(serde_json::Value::Array(arr)) = serde_json::from_str(&body[start..=end]) else {
        return vec![];
    };
    arr.iter()
        .filter_map(|v| {
            let title = v.get("title")?.as_str()?.trim().to_string();
            let text = v.get("body")?.as_str()?.trim().to_string();
            let mtype = bbrt_memory::MemoryType::parse(v.get("type")?.as_str()?)?;
            if title.is_empty() || text.is_empty() {
                return None;
            }
            Some(DistillItem {
                title,
                body: text,
                mtype,
            })
        })
        .collect()
}

/// 记忆写入/更新 → 协议事件外发（memory.saved + memory.evicted；W1/W2/W3 共用）
fn emit_memory_saved(deps: &LoopDeps, session_id: &str, outcome: &bbrt_memory::SaveOutcome) {
    let type_str = match outcome.saved.r#type {
        bbrt_memory::MemoryType::User => "user",
        bbrt_memory::MemoryType::Project => "project",
        bbrt_memory::MemoryType::Feedback => "feedback",
        bbrt_memory::MemoryType::Reference => "reference",
    };
    emit(deps, session_id, |id| SessionEvent::MemorySaved {
        session_id: id,
        name: outcome.saved.name.clone(),
        title: outcome.saved.title.clone(),
        memory_type: type_str.to_string(),
        updated: outcome.saved.updated,
    });
    for ev in &outcome.evicted {
        emit(deps, session_id, |id| SessionEvent::MemoryEvicted {
            session_id: id,
            name: ev.name.clone(),
            reason: ev.reason.clone(),
        });
    }
}
