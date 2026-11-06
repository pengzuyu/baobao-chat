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
use std::sync::Arc;
use std::time::Duration;

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
    model: String,
}
impl Summarizer for FastSummarizer<'_> {
    fn summarize(&self, text: &str) -> Result<String, String> {
        let req = ChatRequest {
            model: self.model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".into(),
                    content: "把以下对话压缩为要点摘要，≤300字。".into(),
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "user".into(),
                    content: text.to_string(),
                    tool_calls: vec![],
                    tool_call_id: None,
                },
            ],
            tools: vec![],
        };
        let mut out = String::new();
        let iter = self.client.chat(&req).map_err(|e| e.to_string())?;
        for ev in iter {
            match ev {
                Ok(StreamEvent::TextDelta { text }) => out.push_str(&text),
                Ok(_) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        if out.trim().is_empty() {
            Err("空摘要".into())
        } else {
            Ok(out)
        }
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
            permission_timeout: PERMISSION_TIMEOUT,
        }
    }
}

/// 循环依赖集合（bin 装配；测试用假件）
pub struct LoopDeps {
    pub model: Arc<dyn ChatClient>,
    pub tools: Arc<dyn ToolExecutor>,
    pub memory: Option<Arc<MemoryEngine>>,
    pub wal: Arc<dyn EventLog>,
    pub sink: Arc<dyn SessionSink>,
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

        // 记忆召回注入（D15 §2.3：MEMORY.md 全文进项目上下文区块）
        let memory_index = deps
            .memory
            .as_ref()
            .map(|m| m.knowledge().recall().unwrap_or_default())
            .unwrap_or_default();

        self.history.push(Round::User {
            content: user_text.to_string(),
        });
        // 被动轨：用户输入的启发式记忆提示（W2；正文取原句，标题截 40 字）
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
                    let mt = outcome.saved.r#type;
                    emit(deps, &self.session_id, |id| SessionEvent::MemorySaved {
                        session_id: id,
                        name: outcome.saved.name,
                        title: outcome.saved.title,
                        memory_type: match mt {
                            bbrt_memory::MemoryType::User => "user",
                            bbrt_memory::MemoryType::Project => "project",
                            bbrt_memory::MemoryType::Feedback => "feedback",
                            bbrt_memory::MemoryType::Reference => "reference",
                        }
                        .to_string(),
                        updated: outcome.saved.updated,
                    });
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
                    model: "fast".into(),
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
            let assembled = assemble(
                &deps.budget,
                AssembleParts {
                    system: SYSTEM_PROMPT,
                    skills: "",
                    project: &format!("workspace: {}", self.workspace),
                    memory_index: &memory_index,
                    history: &self.history,
                    tool_results: &self.tool_results,
                },
            );
            let messages = to_chat_messages(&assembled);
            let model_name = match self.model_policy {
                ModelTier::Fast => "fast".to_string(),
                ModelTier::Strong => "strong".to_string(),
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

                let outcome = self.run_tool(deps, &call, &masked, risk);
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

    /// 单个工具调用全流程：门控 →（审批 → 记忆）→ 执行
    fn run_tool(
        &mut self,
        deps: &LoopDeps,
        call: &ToolInvocation,
        masked: &str,
        risk: &str,
    ) -> ToolOutcome {
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

    pub fn state(&self) -> SessionState {
        self.state
    }
    pub fn permission_sender(&self) -> Sender<PermissionResponse> {
        self.permission_tx.clone()
    }
}

/// 系统提示（08 篇行为规格的最小内化；技能注入阶段二）
const SYSTEM_PROMPT: &str = "你是 BaobaoWork 的本机 Agent。遵守：1) 修改与命令执行受门控与沙箱约束；2) 工具参数只输出合法 JSON；3) 长文件先读摘录再决定；4) 学到持久事实时优先记忆工具记录（接入后）。";

/// 组装结果 → 模型消息序列（system/记忆/项目 → history → 工具结果）
fn to_chat_messages(a: &bbrt_context::Assembled) -> Vec<ChatMessage> {
    let mut msgs = vec![ChatMessage {
        role: "system".into(),
        content: format!(
            "{}\n\n[项目]\n{}\n\n[记忆]\n{}",
            a.system, a.project, a.memory_index
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

/// 事件外发小工具（闭包拿 session_id，避免重复借用）
fn emit(deps: &LoopDeps, session_id: &str, f: impl FnOnce(String) -> SessionEvent) {
    deps.sink.emit(f(session_id.to_string()));
}
