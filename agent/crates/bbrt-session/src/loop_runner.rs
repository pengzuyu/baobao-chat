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

/// 子任务同步等待窗（D16 决策④：探查/专家 120s 超窗转后台；委派直接后台）
pub const SUBAGENT_WAIT_WINDOW: Duration = Duration::from_secs(120);

/// ETA 静态初值表毫秒（D16 §5/P1-6：滚动统计无样本时的兜底）
pub(crate) fn static_eta_ms(kind: &str) -> i64 {
    match kind {
        "probe" => 45_000,
        "expert" => 180_000,
        "team" => 300_000,
        "delegate" => 600_000,
        _ => 60_000,
    }
}

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

/// 澄清回执（宿主 → 循环；D20 ask_user 工具等待）
#[derive(Debug, Clone)]
pub struct ClarifyAnswer {
    pub question_id: String,
    /// 所选选项 label
    pub answers: Vec<String>,
    /// 「其他」自由补充
    pub free_text: Option<String>,
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

/// run 起始快照（D16 §3.1：agent_run 行的会话侧形态；三形态统一审计）
#[derive(Debug, Clone)]
pub struct RunStart {
    pub run_id: String,
    pub session_id: String,
    /// 调用链根会话（v0.1 子 agent 均为顶层：root=session；嵌套链随 P1 扩展）
    pub root_session_id: String,
    /// 父 run（team 成员 expert run=team run id；其余空）
    pub parent_run_id: String,
    /// 触发本次 run 的工具调用 id（委派=coding.delegate 的 call_id）
    pub parent_call_id: String,
    /// probe | expert | team | delegate
    pub kind: &'static str,
    /// builtin.probe / {expertId}@{version} / team:{topology} / backend:{type}
    pub def_ref: String,
    /// ETA 预估毫秒（P1-6 滚动统计接线前恒 0）
    pub eta_hint_ms: i64,
    /// OBO subject 快照（宿主身份接线前空串，登记）
    pub actor: String,
}

/// run 终态回写（D16 §3.1 状态机：done/failed/cancelled；interrupted 仅恢复写入）
#[derive(Debug, Clone, Copy)]
pub struct RunEnd<'a> {
    pub status: &'a str,
    pub eta_actual_ms: i64,
    pub summary: &'a str,
    /// 委派子进程会话句柄（--resume 续接；其余空）
    pub child_session_ref: &'a str,
}

/// WAL 出口抽象（Store 实现；测试可注入 Noop）。
/// run 记录族（next_run_id/run_start/run_end/append_run）带默认 no-op：
/// 旧测试假件只实现 append 即可编译，行为退化为不落 run 行——显式接线
/// 由 Mutex<Store> 实现承载（bin 装配零改动）。
pub trait EventLog: Send + Sync {
    fn append(&self, session_id: &str, type_: &str, payload: &str);

    /// 持久 run 发号（r-{seq} 跨重启唯一；None=未接 Store，调用方退回进程内临时 id）
    fn next_run_id(&self) -> Option<String> {
        None
    }
    /// ETA 滚动统计（P1-6：按 def_ref 最近 8 次均值；None=无样本回落静态表）
    fn eta_hint(&self, def_ref: &str) -> Option<i64> {
        let _ = def_ref;
        None
    }
    /// run 起始落库（status=running）
    fn run_start(&self, run: &RunStart) {
        let _ = run;
    }
    /// run 终态回写
    fn run_end(&self, run_id: &str, end: &RunEnd<'_>) {
        let _ = (run_id, end);
    }
    /// 带 run 归属的事件（默认丢 run_id 退化为 append）
    fn append_run(&self, session_id: &str, _run_id: &str, type_: &str, payload: &str) {
        self.append(session_id, type_, payload);
    }
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
    fn next_run_id(&self) -> Option<String> {
        self.lock().ok().and_then(|s| s.next_run_id().ok())
    }
    fn eta_hint(&self, def_ref: &str) -> Option<i64> {
        self.lock()
            .ok()
            .and_then(|s| s.eta_hint_ms(def_ref).ok().flatten())
    }
    fn run_start(&self, run: &RunStart) {
        if let Ok(store) = self.lock() {
            let now = unix_now_ms();
            let _ = store.insert_run(&bbrt_store::RunRow {
                id: run.run_id.clone(),
                session_id: run.session_id.clone(),
                root_session_id: run.root_session_id.clone(),
                parent_run_id: run.parent_run_id.clone(),
                parent_call_id: run.parent_call_id.clone(),
                kind: run.kind.to_string(),
                def_ref: run.def_ref.clone(),
                status: "running".into(),
                eta_hint_ms: run.eta_hint_ms,
                eta_actual_ms: 0,
                summary: String::new(),
                child_session_ref: String::new(),
                actor: run.actor.clone(),
                created_at: now,
                started_at: now,
                ended_at: None,
            });
        }
    }
    fn run_end(&self, run_id: &str, end: &RunEnd<'_>) {
        if let Ok(store) = self.lock() {
            let _ = store.finish_run(
                run_id,
                end.status,
                end.eta_actual_ms,
                end.summary,
                end.child_session_ref,
            );
        }
    }
    fn append_run(&self, session_id: &str, run_id: &str, type_: &str, payload: &str) {
        if let Ok(store) = self.lock() {
            if let Ok(seq) = store.next_event_seq(session_id) {
                let _ = store.append_event_with_run(session_id, seq, type_, payload, run_id);
            }
        }
    }
}

/// Unix 毫秒（run 行时间戳；manager 同名私有函数同源）
fn unix_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
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
/// compaction 摘要、W3 记忆提炼与探查 planner 共用（19 篇档位别名固定 bbw-fast）
pub(crate) fn chat_text(
    client: &dyn ChatClient,
    system: &str,
    user: &str,
) -> Result<String, String> {
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
        thinking: None,
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
    /// 会话级模型直达引用（0023：p:<provider_id>:<model>；None=档位别名）。
    /// 仅主循环对话模型；planner/压缩/探查/选角等辅助调用恒档位
    pub model_override: Option<String>,
    state: SessionState,
    history: Vec<Round>,
    tool_results: Vec<ToolResultEntry>,
    /// stream.delta 会话内序号
    delta_seq: AtomicU64,
    /// 紧急停止/暂停旗标（宿主置位；循环在事件与步间检查）
    pub interrupted: Arc<AtomicBool>,
    permission_tx: Sender<PermissionResponse>,
    permission_rx: Receiver<PermissionResponse>,
    /// 澄清回执通道（D20 ask_user 阻塞等待；与审批通道分离——无超时，靠 recv 轮询中断）
    clarify_tx: Sender<ClarifyAnswer>,
    clarify_rx: Receiver<ClarifyAnswer>,
    /// 委派宿主指令通道（launch/input/cancel/review；与审批通道分离）
    delegate_tx: Sender<DelegateHostMsg>,
    delegate_rx: Receiver<DelegateHostMsg>,
    /// W2② 连续错误计数器（同工具同错 ≥2 次 → feedback 教训；跨 turn 保留）
    err_tracker: bbrt_memory::ErrorTracker,
    /// 审批超时（测试注入）
    pub permission_timeout: Duration,
    /// 子任务同步等待窗（D16 决策④：探查/专家 spawn 后同步等 120s，
    /// 超窗转后台继续跑——摘要经 hub park 下一轮回填；测试注入更短值）
    pub subagent_wait_window: Duration,
    /// 后台委派中枢（D16 §5：Some=委派后台化——launch 后 turn 立即返回；
    /// None=同步退化路径（raw runner 测试/嵌入式用法）。manager.start 注入，
    /// 生产路径恒 Some；与 manager 共享同一实例（指令定向路由 + join 注入）
    pub delegate_hub: Option<Arc<crate::delegate_bg::DelegateHub>>,
}

impl SessionRunner {
    /// D19 会话工作目录（空串=日常对话 → None）。仅供记忆分级路由（日常=用户级）。
    pub fn ws_path(&self) -> Option<&std::path::Path> {
        if self.workspace.is_empty() {
            None
        } else {
            Some(std::path::Path::new(&self.workspace))
        }
    }

    /// 执行侧工作目录（2026-11-12 日常=默认用户工作区口径）：项目会话=目录；
    /// 日常=ZCode 式用户级工作空间（与 tools 管线 session_env 同一解析）。
    /// 供委派简报/checkpoint/子代理上下文等执行侧使用——记忆路由仍走 ws_path。
    pub fn exec_ws(&self) -> std::path::PathBuf {
        if self.workspace.is_empty() {
            bbrt_sec::sandbox::default_user_workspace()
        } else {
            std::path::PathBuf::from(&self.workspace)
        }
    }

    /// D19 [项目] 行：项目会话=目录；日常=用户工作空间标注（2026-11-12 改口径）
    fn project_line(&self) -> String {
        if self.workspace.is_empty() {
            format!("日常对话（用户工作空间 {}）", self.exec_ws().display())
        } else {
            format!("workspace: {}", self.workspace)
        }
    }
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
    /// 用户中断（2026-11-11「停止」新语义）：收口报 idle（可继续追问），
    /// 与 paused（内部限制/错误自动暂停，不可续）区分
    pub interrupted: bool,
}

impl SessionRunner {
    pub fn new(
        session_id: String,
        workspace: String,
        mode: PermissionMode,
        model_policy: ModelTier,
        model_override: Option<String>,
    ) -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        let (ctx, crx) = std::sync::mpsc::channel();
        let (dtx, drx) = std::sync::mpsc::channel();
        Self {
            session_id,
            workspace,
            mode,
            model_policy,
            model_override,
            state: state::begin(),
            history: vec![],
            tool_results: vec![],
            delta_seq: AtomicU64::new(0),
            interrupted: Arc::new(AtomicBool::new(false)),
            permission_tx: tx,
            permission_rx: rx,
            clarify_tx: ctx,
            clarify_rx: crx,
            delegate_tx: dtx,
            delegate_rx: drx,
            // v0.1 恒开（`memory.heuristic=off` 开关随配置系统接线，D15 §2.2）
            err_tracker: bbrt_memory::ErrorTracker::new(true),
            permission_timeout: PERMISSION_TIMEOUT,
            subagent_wait_window: SUBAGENT_WAIT_WINDOW,
            delegate_hub: None,
        }
    }

    /// 后台产物注入（D16 §5：委派/探查/团队经 hub park 的摘要由 manager
    /// 在下一轮 run_turn 前 drain 后调用——主上下文以对应 join 轮次回填）
    pub fn inject_delegate_join(&mut self, run_id: &str, name: &str, summary: &str) {
        self.history.push(Round::Tool {
            call_id: run_id.to_string(),
            name: name.to_string(),
            summary: summary.to_string(),
        });
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
    /// 探查子 Agent 判定器（08 §4.5；None=未装配零行为，FastPlanner 见 subagent.rs）
    pub fanout: Option<Arc<dyn crate::subagent::FanoutPlanner>>,
    /// 专家会诊源（D14 §3.3 选角；None=未装配零行为，FastCaster 见 team.rs）。
    /// 判定优先于探查——专家=重执行体，探查=信息收集优化
    pub experts: Option<Arc<dyn crate::team::ExpertSource>>,
    pub budget: BudgetConfig,
}

impl SessionRunner {
    /// 执行一轮 turn（user.message 已入 history 前置）
    pub fn run_turn(
        &mut self,
        user_text: &str,
        deps: &LoopDeps,
        thinking: Option<bbrt_protocol::ThinkingLevel>,
    ) -> TurnReport {
        let mut report = TurnReport::default();
        // 中断旗标只作用于当轮：新一轮用户输入前清零，否则中断过的会话下一轮秒断
        self.interrupted.store(false, Ordering::Relaxed);
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

        // 专家会诊（D14 §3：选角命中 → run_team 并行 Activation → 摘要回填；
        // 优先于探查——多专家并行产出结论后主 Agent 综合规划。状态复用
        // #9/#10（"并行子任务执行中"同语义；TeamRun 并发 ≤1 由本顺序天然保证）
        if let Some(source) = deps.experts.as_ref() {
            if let Some(graph) = source.cast(deps.model.as_ref(), user_text) {
                self.state = crate::subagent::transition_fanout(self.state);
                emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                    session_id: id,
                    state: "subagent_fanout".into(),
                    reason: "team.cast".into(),
                });
                // 等待窗 + 超窗转后台（D16 决策④：同探查口径；TeamRun 在
                // 专用线程，窗内收口即时回填 / 超窗 park 摘要下一轮注入）
                let ctx = crate::expert::ExpertCtx {
                    model: Arc::clone(&deps.model),
                    tools: Arc::clone(&deps.tools),
                    mode: self.mode,
                    hub: self.delegate_hub.clone(),
                };
                let sid = self.session_id.clone();
                let sink_bg = Arc::clone(&deps.sink);
                let wal_bg = Arc::clone(&deps.wal);
                let hub = self.delegate_hub.clone();
                let (ttx, trx) = std::sync::mpsc::channel::<Option<crate::team::TeamResult>>();
                let _ = std::thread::Builder::new()
                    .name("bbw-team".into())
                    .spawn(move || {
                        let team = crate::team::run_team(
                            &ctx,
                            &sid,
                            &graph,
                            sink_bg.as_ref(),
                            wal_bg.as_ref(),
                        );
                        // rx 已关（主线程超窗弃等）→ send Err：超窗路径 park 摘要
                        // （TeamError 非 Clone：ok() 值传递，Err 路径无产物不 park）
                        let parked = match &team {
                            Ok(t) => Some(t.clone()),
                            Err(_) => None,
                        };
                        if ttx.send(team.ok()).is_err() {
                            if let (Some(hub), Some(team)) = (hub, parked) {
                                hub.park_join(
                                    &sid,
                                    crate::delegate_bg::DelegateJoin {
                                        name: "team.join".into(),
                                        run_id: team.run_id.clone(),
                                        summary: format!(
                                            "## 专家会诊结果（后台完成）\n{}",
                                            team.summary
                                        ),
                                    },
                                );
                            }
                        }
                    });
                // rx 先移出（超窗须显式 drop 才能让线程 send 失败→走 park 路径）
                let (team_in_window, timed_out) = {
                    let rx = trx;
                    match rx.recv_timeout(self.subagent_wait_window) {
                        Ok(opt) => (opt, false),
                        // 关窗瞬间防丢：非阻塞补收一次再弃等（drop 触发 park）
                        Err(_) => match rx.try_recv() {
                            Ok(opt) => (opt, false),
                            Err(_) => {
                                drop(rx);
                                (None, true)
                            }
                        },
                    }
                };
                self.state = crate::subagent::transition_join(self.state);
                if let Some(team) = team_in_window {
                    self.history.push(Round::Tool {
                        call_id: format!("team-{}", team.run_id),
                        name: "team.join".to_string(),
                        summary: format!("## 专家会诊结果\n{}", team.summary),
                    });
                    emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                        session_id: id,
                        state: "running".into(),
                        reason: "team.join".into(),
                    });
                } else if timed_out {
                    deps.wal.append(&self.session_id, "team.backgrounded", "{}");
                    emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                        session_id: id,
                        state: "running".into(),
                        reason: "team.backgrounded".into(),
                    });
                }
                // else：图校验拒绝（选角器已前置校验，此处兜底）→ 回 running 走主循环
            }
        }

        // 探查子 Agent fan-out（08 §4.5/D11 §7）：判定 complex → ≤3 并行探查 →
        // join 摘要回填（主 Agent 基于摘要继续规划；未装配/不分解=零行为）
        if let Some(planner) = deps.fanout.as_ref() {
            if let Some(subs) = planner.plan(deps.model.as_ref(), user_text) {
                self.state = crate::subagent::transition_fanout(self.state);
                emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                    session_id: id,
                    state: "subagent_fanout".into(),
                    reason: "plan.fanout".into(),
                });
                deps.wal.append(
                    &self.session_id,
                    "subagent.fanout",
                    &format!("{{\"count\":{}}}", subs.len()),
                );
                // 通用子 agent＝主的分身（D16 决策①）：system/技能/记忆/
                // 工具/模型与主会话同源，仅任务提示词不同、历史清零
                let model_name =
                    self.model_override
                        .clone()
                        .unwrap_or_else(|| match self.model_policy {
                            ModelTier::Fast => "bbw-fast".to_string(),
                            ModelTier::Strong => "bbw-strong".to_string(),
                        });
                let outcome = crate::subagent::fanout_probes(
                    &self.session_id,
                    self.mode,
                    Arc::clone(&deps.model),
                    Arc::clone(&deps.tools),
                    Arc::clone(&deps.sink),
                    Arc::clone(&deps.wal),
                    &subs,
                    &crate::subagent::FanoutEnv {
                        system: SYSTEM_PROMPT,
                        skills: &deps.skills,
                        memory: deps.memory.as_ref(),
                        workspace: &self.workspace,
                        model_name,
                        wait_window: self.subagent_wait_window,
                        hub: self.delegate_hub.clone(),
                    },
                );
                self.state = crate::subagent::transition_join(self.state);
                match outcome {
                    crate::subagent::FanoutOutcome::Joined(digest) => {
                        self.history.push(Round::Tool {
                            call_id: format!("fanout-{}", self.history.len()),
                            name: "subagent.join".to_string(),
                            summary: format!("## 并行子任务结果\n{digest}"),
                        });
                        emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                            session_id: id,
                            state: "running".into(),
                            reason: "subagent.join".into(),
                        });
                    }
                    crate::subagent::FanoutOutcome::Backgrounded { pending } => {
                        // 超窗转后台（D16 决策④）：turn 继续，收口线程完成后
                        // 经 hub park 摘要，manager 下一轮 run_turn 注入回填
                        deps.wal.append(
                            &self.session_id,
                            "subagent.backgrounded",
                            &format!("{{\"pending\":{pending}}}"),
                        );
                        emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                            session_id: id,
                            state: "running".into(),
                            reason: "subagent.backgrounded".into(),
                        });
                    }
                }
            }
        }

        // 记忆召回注入（D15 §2.3 按消息精排；D19 分级——项目会话注
        // [用户记忆]+[项目记忆] 两段、日常仅用户段）
        let memory_index = deps
            .memory
            .as_ref()
            .map(|m| m.recall_scoped(self.ws_path(), user_text))
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
            if report.steps >= MAX_STEPS {
                // 步数上限=防失控循环的真暂停（唯一保留 paused 的场景，罕见）
                report.paused = true;
                break;
            }
            // 用户中断：不进 paused（paused=内部限制/错误自动暂停且 resume 未实现），
            // 收口按 idle 报——会话保留可继续追问（2026-11-11「停止」语义）
            if self.interrupted.load(Ordering::Relaxed) {
                report.interrupted = true;
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
                        // 2026-11-11：错误收口 idle（时间线已留 Error 卡）——旧口径
                        // 转 paused 会卡死（resume 通道已随「停止」口径移除），用户无法重试
                        break;
                    }
                }
            }

            // ② 组装 + 请求模型
            report.steps += 1;
            // 技能命中注入（10 篇 §4.5：用户消息含 trigger 的技能正文进 skills
            // 区块，context 预算 5% 截断兜底；索引空/未命中=空段零成本）+
            // 技能索引区（D22 §2.1/L3：未命中技能一行一条 name：description——
            // 模型知晓存在，提及名字即可触发；Claude 格式技能无 triggers 时
            // 解析层已兜底 name 作触发词）+
            // 工具面收紧（10 篇 §4.6 pick_tools 条件①：命中技能**全体**声明
            // 非空 allowedTools → tools 收紧到并集；任一未声明=不限制——
            // 无声明技能语义即全量；快模型预筛/近期调用/目录化 system 随下轮）
            let (skills_text, allowed_tools) = {
                let idx = deps.skills.lock().unwrap_or_else(|p| p.into_inner());
                let matched = idx.match_for(user_text);
                let index_text = idx.render_index(&matched);
                let text = if index_text.is_empty() {
                    idx.render(&matched)
                } else {
                    format!("{}\n\n{}", index_text, idx.render(&matched))
                };
                let allow =
                    if matched.is_empty() || matched.iter().any(|e| e.allowed_tools.is_empty()) {
                        None
                    } else {
                        let mut union: Vec<String> = vec![];
                        for e in &matched {
                            for t in &e.allowed_tools {
                                if !union.contains(t) {
                                    union.push(t.clone());
                                }
                            }
                        }
                        Some(union)
                    };
                (text, allow)
            };
            let assembled = assemble(
                &deps.budget,
                AssembleParts {
                    system: SYSTEM_PROMPT,
                    skills: &skills_text,
                    project: &self.project_line(),
                    memory_index: &memory_index,
                    history: &self.history,
                    tool_results: &self.tool_results,
                },
            );
            let messages = to_chat_messages(&assembled);
            // 19 篇 §3.2 + 0023 引用扩展：override 直达引用优先（p:<id>:<model>，
            // 网关校验归属/清单），缺省回落档位别名
            let model_name =
                self.model_override
                    .clone()
                    .unwrap_or_else(|| match self.model_policy {
                        ModelTier::Fast => "bbw-fast".to_string(),
                        ModelTier::Strong => "bbw-strong".to_string(),
                    });
            let req = ChatRequest {
                model: model_name,
                messages,
                tools: pick_tools(deps.tools.tool_specs(), &allowed_tools),
                // 思考强度三档（2026-11-11 zcode 同款，轮级生效）：low=disabled /
                // medium=enabled / high=enabled+大预算；缺省=medium
                thinking: Some(
                    match thinking.unwrap_or(bbrt_protocol::ThinkingLevel::Medium) {
                        bbrt_protocol::ThinkingLevel::Low => {
                            serde_json::json!({ "type": "disabled" })
                        }
                        bbrt_protocol::ThinkingLevel::Medium => {
                            serde_json::json!({ "type": "enabled" })
                        }
                        bbrt_protocol::ThinkingLevel::High => {
                            serde_json::json!({ "type": "enabled", "budget_tokens": 16384 })
                        }
                    },
                ),
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
                    // 模型失败收口 idle：时间线留错误卡，会话可换模型/重发即重试
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
                    // 思考增量（2026-11-11）：只外发不并入正文——前端思考折叠卡消费
                    Ok(StreamEvent::ReasoningDelta { text: t }) => {
                        let seq = self.delta_seq.fetch_add(1, Ordering::Relaxed) as u32;
                        emit(deps, &self.session_id, |id| SessionEvent::StreamDelta {
                            session_id: id,
                            delta: t,
                            seq,
                            channel: StreamChannel::Reasoning,
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
                // 同 8011：错误收口 idle 可重试（旧 paused 卡死）
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
            // 配对 user.text 落 assistant 轮，摘要级重建即可续会话）。
            // text=本轮回复原文（工作台 session.history 加载聊天记录数据源；
            // 旧行缺此字段 → 历史加载跳过该轮，渐进降级）
            deps.wal.append(
                &self.session_id,
                "assistant.done",
                &format!(
                    "{{\"finish\":\"{}\",\"usage_in\":{},\"usage_out\":{},\"text\":\"{}\"}}",
                    match finish {
                        FinishReason::Stop => "stop",
                        FinishReason::ToolCalls => "tool_calls",
                        FinishReason::Length => "length",
                    },
                    usage.0,
                    usage.1,
                    escape_json(&text)
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
                    report.interrupted = true; // 用户中断（收口 idle，可继续）
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
                                // D19：工具教训属于会话工作场景——项目会话落项目分区
                                if let Ok(outcome) = m.save_memory_scoped(self.ws_path(), &input) {
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
                // ok/summary=工具结果摘要（session.history 历史加载；recovery 只读
                // call_id 不受影响）。summary 已含 "[被阻止 code]" 前缀口径
                deps.wal.append(
                    &self.session_id,
                    "tool.result",
                    &format!(
                        "{{\"call_id\":\"{}\",\"ok\":{},\"summary\":\"{}\"}}",
                        tc.id,
                        matches!(outcome, ToolOutcome::Ok { .. }),
                        escape_json(&summary)
                    ),
                );
                self.history.push(Round::Tool {
                    call_id: tc.id.clone(),
                    name: tc.name.clone(),
                    summary,
                });
                if consecutive_failures > MAX_CONSECUTIVE_FAILURES {
                    emit(deps, &self.session_id, |id| SessionEvent::Error {
                        session_id: id,
                        code: 8021,
                        message: "连续工具失败超限，本轮终止".into(),
                        fatal: false,
                    });
                    // 错误收口 idle（同 8010/8011 口径，避免 paused 卡死）
                    break;
                }
            }
            if report.paused || report.interrupted {
                break;
            }
        }

        // 收尾状态：用户中断 → idle（可继续）；内部限制/错误 → paused
        self.state = if report.paused && !report.interrupted {
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
                "{{\"steps\":{},\"paused\":{},\"interrupted\":{}}}",
                report.steps, report.paused, report.interrupted
            ),
        );
        emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
            session_id: id,
            state: if report.paused && !report.interrupted {
                "paused".into()
            } else {
                "idle".into()
            },
            reason: if report.interrupted {
                "user-interrupt".into()
            } else if report.paused {
                "limit_or_interrupt".into()
            } else {
                "stop".into()
            },
        });
        report
    }

    /// 子 Agent 运行中调整（D16 决策⑧）：subagent.adjust{run_id,instruction} /
    /// subagent.cancel{run_id} → hub 定向 Input/Cancel（探查/专家/委派通用）
    fn run_subagent_adjust(&self, deps: &LoopDeps, call: &ToolInvocation) -> ToolOutcome {
        let v: serde_json::Value =
            serde_json::from_str(&call.args_json).unwrap_or(serde_json::json!({}));
        let run_id = v
            .get("run_id")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        if run_id.is_empty() {
            return ToolOutcome::Blocked {
                code: 8002,
                summary: "缺少 run_id 参数".into(),
            };
        }
        let Some(hub) = self.delegate_hub.as_ref() else {
            return ToolOutcome::Blocked {
                code: 8002,
                summary: "运行中枢未装配（无法调整子任务）".into(),
            };
        };
        let msg = if call.name == "subagent.cancel" {
            deps.wal.append(
                &self.session_id,
                "subagent.adjust",
                &serde_json::json!({ "run_id": run_id, "op": "cancel" }).to_string(),
            );
            DelegateHostMsg::Cancel { graceful: true }
        } else {
            let instruction = v
                .get("instruction")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            if instruction.is_empty() {
                return ToolOutcome::Blocked {
                    code: 8002,
                    summary: "缺少 instruction 参数".into(),
                };
            }
            deps.wal.append(
                &self.session_id,
                "subagent.adjust",
                &serde_json::json!({ "run_id": run_id, "op": "input" }).to_string(),
            );
            DelegateHostMsg::Input { text: instruction }
        };
        if hub.route(&run_id, &msg) {
            ToolOutcome::Ok {
                summary: format!("已下发至运行中的 {run_id}"),
                truncated: false,
                exit_code: None,
                duration_ms: 0,
            }
        } else {
            ToolOutcome::Blocked {
                code: 8002,
                summary: format!("{run_id} 不在运行中（可能已完成或未注册）"),
            }
        }
    }

    /// 委派全流程：简报确认 → 宿主 launch → 事件流 → 审查 → 回填摘要
    fn run_delegate(
        &mut self,
        deps: &LoopDeps,
        call: &ToolInvocation,
        masked: &str,
        _risk: &str,
    ) -> ToolOutcome {
        // 2026-11-12：日常会话委派放开（原 8020 拒绝废除）——工作目录取
        // exec_ws（日常=默认用户工作区，与工具沙箱同口径）
        let Some(delegator) = deps.delegator.clone() else {
            return ToolOutcome::Blocked {
                code: 8030,
                summary: "未装配委派后端（registry 为空）".into(),
            };
        };
        // run 发号（D16 §3.1：委派 run=agent_run 行 kind=delegate；
        // 未接 Store 时退回进程内临时 id，兼容旧格式 dt-{call_id}）
        let run_id = deps
            .wal
            .next_run_id()
            .unwrap_or_else(|| format!("dt-{}", call.call_id));
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
            delegate_task_id: run_id.clone(),
            backend_suggestion: suggestion.clone(),
        });
        deps.wal.append(
            &self.session_id,
            "delegate.brief",
            &format!("{{\"run_id\":\"{run_id}\"}}"),
        );

        // 等宿主 delegate.launch（复用审批超时 120s；超时/取消=放弃该工具调用）
        let (backend, brief_override) = match self.delegate_rx.recv_timeout(self.permission_timeout)
        {
            Ok(DelegateHostMsg::Launch { backend, brief }) => (backend, brief),
            Ok(_) | Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                deps.wal.append(
                    &self.session_id,
                    "delegate.brief_timeout",
                    &format!("{{\"run_id\":\"{run_id}\",\"code\":8030}}"),
                );
                self.state =
                    state::complete_delegation(self.state).unwrap_or(SessionState::Running);
                return ToolOutcome::Blocked {
                    code: 8030,
                    summary: "委派未被确认或超时".into(),
                };
            }
        };
        let brief =
            brief_override.unwrap_or_else(|| parse_brief(call, &self.exec_ws().to_string_lossy()));
        let req = DelegateLaunchReq {
            delegate_task_id: run_id.clone(),
            // P0-2①：父会话关联接线（delegate_bridge → LaunchOpts.parent_session_id）
            session_id: self.session_id.clone(),
            backend: if backend.is_empty() {
                suggestion
            } else {
                backend
            },
            brief,
            mode: self.mode,
        };
        // run 起始（D16 §3.1：backend 确定后落 agent_run；简报超时未 launch
        // 不产生 run 行——无执行过程，审计由 delegate.brief_timeout WAL 覆盖）
        let started = std::time::Instant::now();
        let def_ref = format!("backend:{}", req.backend);
        let eta_hint = deps
            .wal
            .eta_hint(&def_ref)
            .unwrap_or_else(|| static_eta_ms("delegate"));
        deps.wal.run_start(&RunStart {
            run_id: run_id.clone(),
            session_id: self.session_id.clone(),
            root_session_id: self.session_id.clone(),
            parent_run_id: String::new(),
            parent_call_id: call.call_id.clone(),
            kind: "delegate",
            def_ref: def_ref.clone(),
            eta_hint_ms: eta_hint,
            actor: String::new(),
        });
        let mut stream = match delegator.launch(&req) {
            Ok(s) => s,
            Err(e) => {
                deps.wal.append_run(
                    &self.session_id,
                    &run_id,
                    "delegate.launch_failed",
                    &format!(
                        "{{\"run_id\":\"{run_id}\",\"code\":8035,\"error\":\"{}\"}}",
                        crate::subagent::truncate_chars(&e, 120)
                    ),
                );
                deps.wal.run_end(
                    &run_id,
                    &RunEnd {
                        status: "failed",
                        eta_actual_ms: started.elapsed().as_millis() as i64,
                        summary: &crate::subagent::truncate_chars(&e, 400),
                        child_session_ref: "",
                    },
                );
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
        // 委派前置快照（08 §4.4 reason=delegate；子进程改动可回滚锚点，17 篇）。
        // checkpoint_id 随 DelegateEnd 上行（P0-2③：审查卡回滚锚点数据源）
        let mut checkpoint_id: Option<String> = None;
        if let Some(svc) = deps.snapshots.as_ref() {
            if let Ok(out) = svc.create(
                &self.session_id,
                &self.exec_ws().to_string_lossy(),
                "delegate",
            ) {
                emit_checkpoint(deps, &self.session_id, &out);
                checkpoint_id = Some(out.checkpoint_id.clone());
            }
        }
        deps.wal.append_run(
            &self.session_id,
            &run_id,
            "delegate.launch",
            &format!(
                "{{\"run_id\":\"{run_id}\",\"backend\":\"{}\"}}",
                req.backend
            ),
        );
        if let Some(m) = deps.memory.as_ref() {
            let _ = m.record(&ActivityEvent::DelegateLaunched {
                session: self.session_id.clone(),
                backend: req.backend.clone(),
            });
        }

        // ── 后台路径（D16 §5：hub 装配即后台——launch 后 turn 立即返回，会话
        // 可继续对话；事件流/审查在专用线程，宿主指令经 hub 定向路由）──
        if let Some(hub) = self.delegate_hub.clone() {
            hub.spawn(
                run_id.clone(),
                self.session_id.clone(),
                req.backend.clone(),
                checkpoint_id,
                stream,
                deps.sink.clone(),
                deps.wal.clone(),
                deps.memory.clone(),
                self.permission_timeout,
                started,
            );
            self.state = state::complete_delegation(self.state).unwrap_or(SessionState::Running);
            emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                session_id: id,
                state: "running".into(),
                reason: "delegate.backgrounded".into(),
            });
            let _ = masked;
            return ToolOutcome::Ok {
                summary: format!(
                    "[委派后台运行] {run_id}（后端 {}）执行中；完成后出审查卡，通过即自动回填结果",
                    req.backend
                ),
                truncated: false,
                exit_code: None,
                duration_ms: 0,
            };
        }

        // ── 同步退化路径（未装配 hub：raw runner 测试/嵌入式用法=旧阻塞语义）──
        let cancelled = pump_delegate_stream(
            &self.session_id,
            &run_id,
            stream.as_mut(),
            &self.delegate_rx,
            Some(&self.interrupted),
            deps.sink.as_ref(),
            deps.wal.as_ref(),
        );
        let final_rep = finish_delegate_stream(
            &self.session_id,
            &run_id,
            &req.backend,
            checkpoint_id.as_deref(),
            cancelled,
            started,
            stream.as_mut(),
            deps.sink.as_ref(),
            deps.wal.as_ref(),
            deps.memory.as_deref(),
        );
        let exit_code = final_rep.exit_code.unwrap_or(-1);
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
        let accepted = await_delegate_review(
            &self.delegate_rx,
            self.permission_timeout,
            Some(&self.interrupted),
        );
        resolve_delegate_review(
            &self.session_id,
            &run_id,
            accepted,
            deps.sink.as_ref(),
            deps.wal.as_ref(),
        );
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
        // 子 Agent 运行中调整（D16 决策⑧）：经 hub 定向下发补充指令/取消
        // ——适用探查/专家/委派全部在跑 run（bbrt-tools 门面仅提供可发现性）
        if call.name == "subagent.adjust" || call.name == "subagent.cancel" {
            return self.run_subagent_adjust(deps, call);
        }
        // D20 ask_user：向用户提问——专用路径（不走 pipeline 门控/执行）：
        // waiting_clarify 态 + clarify.request 事件 + **不超时**等待（1s 轮询查
        // 中断旗标，用户「停止」= cancelled 收口）；回答以工具结果回给模型
        if call.name == "ask_user" {
            return self.run_ask_user(deps, call);
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

    /// D20 ask_user：阻塞式提问。args={question 必填, header?, options:[{label,
    /// description?}] 2-4 项, multi_select?}。回答（answers+free_text）以工具
    /// 结果回给模型；参数非法=Blocked（模型可修正重试）；等待期用户中断=cancelled。
    fn run_ask_user(&mut self, deps: &LoopDeps, call: &ToolInvocation) -> ToolOutcome {
        let args: serde_json::Value = match serde_json::from_str(&call.args_json) {
            Ok(v) => v,
            Err(_) => {
                return ToolOutcome::Blocked {
                    code: 9001,
                    summary: "ask_user 参数非法：必须是合法 JSON".into(),
                }
            }
        };
        let question = args["question"].as_str().unwrap_or("").trim().to_string();
        let mut options: Vec<(String, Option<String>)> = Vec::new();
        if let Some(arr) = args["options"].as_array() {
            for o in arr {
                if let Some(label) = o["label"].as_str() {
                    let label = label.trim();
                    if !label.is_empty() {
                        options.push((
                            label.to_string(),
                            o["description"].as_str().map(str::to_string),
                        ));
                    }
                }
            }
        }
        if question.is_empty() || options.len() < 2 {
            return ToolOutcome::Blocked {
                code: 9001,
                summary:
                    "ask_user 参数非法：question 必填且 options 至少 2 个（{label,description?}）"
                        .into(),
            };
        }
        let header = args["header"].as_str().map(str::to_string);
        let multi_select = args["multi_select"].as_bool().unwrap_or(false);

        // 状态机 → waiting_clarify（D20 #6b）+ 事件 + WAL
        self.state = state::request_clarify(self.state).unwrap_or(SessionState::WaitingClarify);
        let question_id = format!("q-{}", call.call_id);
        let options_json = serde_json::to_string(
            &options
                .iter()
                .map(|(l, d)| {
                    let mut o = serde_json::Map::new();
                    o.insert("label".into(), serde_json::Value::String(l.clone()));
                    if let Some(d) = d {
                        o.insert("description".into(), serde_json::Value::String(d.clone()));
                    }
                    serde_json::Value::Object(o)
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".into());
        emit(deps, &self.session_id, |id| SessionEvent::ClarifyRequest {
            session_id: id,
            question_id: question_id.clone(),
            question: question.clone(),
            header: header.clone(),
            options_json: options_json.clone(),
            multi_select,
        });
        deps.wal.append(
            &self.session_id,
            "clarify.request",
            &format!("{{\"question_id\":\"{question_id}\"}}"),
        );

        // 不超时等待：1s 轮询查中断旗标（用户「停止」→ cancelled）；迟到的
        // 其它问题回执丢弃继续等
        let answer = loop {
            if self.interrupted.load(Ordering::Relaxed) {
                break None;
            }
            match self.clarify_rx.recv_timeout(Duration::from_secs(1)) {
                Ok(a) if a.question_id == question_id => break Some(a),
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break None,
            }
        };

        self.state = state::clarify_resolved(self.state).unwrap_or(SessionState::Running);
        match answer {
            Some(a) => {
                let labels = a.answers.join("、");
                let summary = match a.free_text.as_deref().map(str::trim) {
                    Some(t) if !t.is_empty() => format!("{labels}；补充：{t}"),
                    _ => labels.clone(),
                };
                emit(deps, &self.session_id, |id| SessionEvent::ClarifyResolved {
                    session_id: id,
                    question_id: question_id.clone(),
                    decision: "answered".into(),
                    answers: summary.clone(),
                });
                deps.wal.append(
                    &self.session_id,
                    "clarify.resolved",
                    &format!("{{\"question_id\":\"{question_id}\",\"decision\":\"answered\"}}"),
                );
                ToolOutcome::Ok {
                    summary: format!("用户回答：{summary}"),
                    truncated: false,
                    exit_code: None,
                    duration_ms: 0,
                }
            }
            None => {
                emit(deps, &self.session_id, |id| SessionEvent::ClarifyResolved {
                    session_id: id,
                    question_id: question_id.clone(),
                    decision: "cancelled".into(),
                    answers: String::new(),
                });
                deps.wal.append(
                    &self.session_id,
                    "clarify.resolved",
                    &format!("{{\"question_id\":\"{question_id}\",\"decision\":\"cancelled\"}}"),
                );
                ToolOutcome::Blocked {
                    code: 8002,
                    summary: "用户已中断本轮（提问未回答）".into(),
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
            // memory_saved 计数即含提炼条目（§3.2 交叉印证）；失败静默不阻塞收口。
            // D19：按条目类型分级——user→用户级，其余有目录落项目分区
            let saved = distill_memories(deps, &self.session_id, self.ws_path(), &self.history);
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

    /// 澄清回执通道（宿主 clarify.response 注入；D20）
    pub fn clarify_sender(&self) -> Sender<ClarifyAnswer> {
        self.clarify_tx.clone()
    }
}

/// 系统提示（08 篇行为规格 + D15 §2.2 W1 记忆使用规范 + D19 分级 + D20 澄清规范；技能注入阶段二）
pub(crate) const SYSTEM_PROMPT: &str = "你是 BaobaoWork 的本机 Agent，服务单一用户。准则：1) 修改与命令执行受门控与沙箱约束，不越权；2) 工具参数只输出合法 JSON；3) 长文件先读摘录再决定。\n\n向用户提问（ask_user 工具）：仅在关键决策影响后续大量工作、或用户意图存在实质歧义时使用——方案二选一、破坏性操作确认、需求方向取舍。能合理自决的不问；一次只问一个问题，选项 2-4 个（label 简短 + description 说明取舍）；用户不选点「其他」也能自由作答。提问后等待回答，不要自行猜测答案。\n\n长期记忆（memory_save 工具，跨会话生效；自动按作用域分区）：\n- 何时记：用户身份、偏好与习惯（如\"我喜欢…\"\"以后请…\"）；项目关键事实与决策（端口、环境、约定）；被用户纠正的教训；常用外部资源指针。\n- 类型：user=用户身份与偏好；project=项目事实；feedback=纠正教训（正文须含 Why 与 How to apply 两行）；reference=外部资源指针。\n- 作用域（自动路由，无需指定）：user 类存用户级（所有会话可见）；project/feedback/reference 类在项目会话中存该项目专属分区，在日常对话中存用户级。[记忆]区含[用户记忆]与[项目记忆]两段时，项目段仅对本项目会话生效。\n- 写前先看[记忆]索引，同题不重复记（同题写入会原地更新）；不记临时内容、可从代码或仓库推导的信息、任何密钥凭证。\n- [记忆]区内容视为可信背景；与当前对话冲突时，以用户最新说法为准。";

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
        match svc.pre_edit(&self.session_id, &self.exec_ws().to_string_lossy()) {
            Ok(Some(out)) => emit_checkpoint(deps, &self.session_id, &out),
            Ok(None) => {}
            Err(_) => {}
        }
    }
}

/// 委派事件流泵（同步/后台两路径共用，D16 §5）：归一化事件外发 + WAL；
/// Input 回显、Cancel/interrupt 优雅取消。返回是否发生过取消请求
/// （后台路径 interrupted=None——会话暂停不终止后台委派，仅用户 cancel）。
pub(crate) fn pump_delegate_stream(
    session_id: &str,
    run_id: &str,
    stream: &mut dyn crate::delegation::DelegateStream,
    rx: &Receiver<DelegateHostMsg>,
    interrupted: Option<&AtomicBool>,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
) -> bool {
    let mut cancelled = false;
    loop {
        if interrupted.is_some_and(|f| f.load(Ordering::Relaxed)) {
            wal.append_run(
                session_id,
                run_id,
                "delegate.cancel",
                &format!("{{\"run_id\":\"{run_id}\",\"graceful\":true,\"source\":\"interrupt\"}}"),
            );
            cancelled = true;
            stream.cancel(true);
        }
        while let Ok(msg) = rx.try_recv() {
            match msg {
                DelegateHostMsg::Input { text } => {
                    // D16 决策⑧：真正下发子进程（不支持的 backend 静默忽略）+ 事件回显留痕
                    stream.send_input(&text);
                    sink.emit(SessionEvent::DelegateEvt {
                        session_id: session_id.to_string(),
                        delegate_task_id: run_id.to_string(),
                        kind: "input".into(),
                        payload: text,
                    });
                }
                DelegateHostMsg::Cancel { graceful } => {
                    wal.append_run(
                        session_id,
                        run_id,
                        "delegate.cancel",
                        &format!("{{\"run_id\":\"{run_id}\",\"graceful\":{graceful}}}"),
                    );
                    cancelled = true;
                    stream.cancel(graceful);
                }
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
            DelegateEvt::ToolUse { call_id, tool, .. } => {
                wal.append_run(
                    session_id,
                    run_id,
                    "delegate.tool_use",
                    &format!(
                        "{{\"run_id\":\"{run_id}\",\"call_id\":\"{call_id}\",\"tool\":\"{tool}\"}}"
                    ),
                );
                (
                    "tool_use",
                    format!("{{\"call_id\":\"{call_id}\",\"tool\":\"{tool}\"}}"),
                )
            }
            DelegateEvt::ToolResult { call_id, ok, .. } => {
                wal.append_run(
                    session_id,
                    run_id,
                    "delegate.tool_result",
                    &format!("{{\"run_id\":\"{run_id}\",\"call_id\":\"{call_id}\",\"ok\":{ok}}}"),
                );
                (
                    "tool_result",
                    format!("{{\"call_id\":\"{call_id}\",\"ok\":{ok}}}"),
                )
            }
            DelegateEvt::Warning { text } => ("warning", text),
            DelegateEvt::Exit { .. } => ("exit", String::new()),
        };
        sink.emit(SessionEvent::DelegateEvt {
            session_id: session_id.to_string(),
            delegate_task_id: run_id.to_string(),
            kind: kind.to_string(),
            payload,
        });
    }
    cancelled
}

/// 委派收尾（两路径共用）：finalize → delegate.end（P0-2③ 全字段上行：
/// changed_files/checkpoint_id/child_session_ref——diff 审查卡数据源与
/// --resume 续接句柄）→ WAL + run 终态 → journal。
#[allow(clippy::too_many_arguments)]
pub(crate) fn finish_delegate_stream(
    session_id: &str,
    run_id: &str,
    backend: &str,
    checkpoint_id: Option<&str>,
    cancelled: bool,
    started: std::time::Instant,
    stream: &mut dyn crate::delegation::DelegateStream,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
    memory: Option<&bbrt_memory::MemoryEngine>,
) -> crate::delegation::DelegateFinal {
    let final_rep = stream.finalize();
    let exit_code = final_rep.exit_code.unwrap_or(-1);
    sink.emit(SessionEvent::DelegateEnd {
        session_id: session_id.to_string(),
        delegate_task_id: run_id.to_string(),
        exit_code,
        summary: final_rep.summary.clone(),
        changed_files: final_rep.changed_files.clone(),
        checkpoint_id: checkpoint_id.map(str::to_string),
        child_session_ref: final_rep.session_ref.clone(),
    });
    wal.append_run(
        session_id,
        run_id,
        "delegate.end",
        &format!("{{\"run_id\":\"{run_id}\",\"exit\":{exit_code}}}"),
    );
    // run 终态（D16 §3.1：cancelled 区分于 failed；执行完成即落终态，
    // 审查 reject 不改写 run 状态——决策在 delegate.review WAL 里）
    wal.run_end(
        run_id,
        &RunEnd {
            status: if cancelled {
                "cancelled"
            } else if exit_code != 0 {
                "failed"
            } else {
                "done"
            },
            eta_actual_ms: started.elapsed().as_millis() as i64,
            summary: &crate::subagent::truncate_chars(&final_rep.summary, 400),
            child_session_ref: final_rep.session_ref.as_deref().unwrap_or(""),
        },
    );
    if let Some(m) = memory {
        let _ = m.record(&ActivityEvent::DelegateEnded {
            session: session_id.to_string(),
            backend: backend.to_string(),
            exit_code,
        });
    }
    final_rep
}

/// 审查等待（两路径共用；120s 窗口超时/取消/interrupt=拒绝——09 §7.4 口径）
pub(crate) fn await_delegate_review(
    rx: &Receiver<DelegateHostMsg>,
    timeout: Duration,
    interrupted: Option<&AtomicBool>,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if interrupted.is_some_and(|f| f.load(Ordering::Relaxed)) {
            return false;
        }
        let remain = deadline.saturating_duration_since(std::time::Instant::now());
        if remain.is_zero() {
            return false;
        }
        match rx.recv_timeout(remain) {
            Ok(DelegateHostMsg::Review { accept }) => return accept,
            Ok(DelegateHostMsg::Cancel { .. }) => return false,
            Ok(_) => continue,
            Err(_) => return false,
        }
    }
}

/// 审查结论落账（两路径共用）：WAL + 事件镜像
pub(crate) fn resolve_delegate_review(
    session_id: &str,
    run_id: &str,
    accepted: bool,
    sink: &dyn SessionSink,
    wal: &dyn EventLog,
) {
    wal.append_run(
        session_id,
        run_id,
        "delegate.review",
        &format!(
            "{{\"run_id\":\"{run_id}\",\"decision\":\"{}\"}}",
            if accepted { "accept" } else { "reject" }
        ),
    );
    sink.emit(SessionEvent::DelegateReviewResolved {
        session_id: session_id.to_string(),
        delegate_task_id: run_id.to_string(),
        decision: if accepted { "accept" } else { "reject" }.into(),
    });
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
/// pick_tools 工具面过滤（10 篇 §4.6 条件①）：allow=Some 并集 → 白名单过滤；
/// 与注册表零交集时回退全量（技能声明错位防会话裸跑）。
fn pick_tools(
    mut all: Vec<bbrt_aigw::ToolSpec>,
    allow: &Option<Vec<String>>,
) -> Vec<bbrt_aigw::ToolSpec> {
    match allow {
        None => all,
        Some(names) => {
            if !all.iter().any(|s| names.contains(&s.name)) {
                return all; // 声明错位兜底：全量回退（技能正文仍提示允许集）
            }
            all.retain(|s| names.contains(&s.name));
            all
        }
    }
}

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

/// D19 记忆作用域路由：user 类（身份/偏好）恒用户级；
/// project/feedback/reference 类随会话工作目录落项目分区（日常会话回落用户级）
fn route_scope<'a>(
    ws: Option<&'a std::path::Path>,
    mtype: bbrt_memory::MemoryType,
) -> Option<&'a std::path::Path> {
    match mtype {
        bbrt_memory::MemoryType::User => None,
        _ => ws,
    }
}

/// W3：会话结束把"决策/偏好/教训"提炼成长期记忆。模型失败、输出不可解析、
/// 条目非法（空标题/未知类型）一律静默跳过——绝不阻塞会话收口。返回落盘条数。
/// D19：条目按类型分级（user→用户级；其余随会话目录落项目分区）。
fn distill_memories(
    deps: &LoopDeps,
    session_id: &str,
    ws: Option<&std::path::Path>,
    history: &[Round],
) -> usize {
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
    // 已有索引喂给模型防重复（取头 60 行控提示长度；save 侧同题去重兜底）。
    // D19：项目会话喂用户+项目两域索引
    let existing = m.recall_scoped(ws, "");
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
        if let Ok(outcome) = m.save_memory_scoped(route_scope(ws, input.mtype), &input) {
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
    // D19 作用域透传（user 域省略字段=旧口径兼容）
    let (scope, workspace_name) = if outcome.saved.scope == "project" {
        (
            Some("project".to_string()),
            outcome.saved.workspace_name.clone(),
        )
    } else {
        (None, None)
    };
    emit(deps, session_id, |id| SessionEvent::MemorySaved {
        session_id: id,
        name: outcome.saved.name.clone(),
        title: outcome.saved.title.clone(),
        memory_type: type_str.to_string(),
        updated: outcome.saved.updated,
        scope,
        workspace_name,
    });
    for ev in &outcome.evicted {
        emit(deps, session_id, |id| SessionEvent::MemoryEvicted {
            session_id: id,
            name: ev.name.clone(),
            reason: ev.reason.clone(),
        });
    }
}
