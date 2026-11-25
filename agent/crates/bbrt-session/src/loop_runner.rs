//! 核心循环（08 §4.1 伪码的可执行化，D11 §2.2 loop_runner）。
//!
//! 一轮 turn：user.message → 上下文组装（必要时 compaction）→ 模型流式
//! （stream.delta 逐段外发）→ 工具调用轮（门控→审批→沙箱执行→脱敏回填）
//! → 直至 finish=stop 或步数/失败上限。全程 WAL 先行。
//!
//! 并发模型：同步阻塞；每 turn 在独立线程跑（bin 装配），宿主侧
//! respond_permission 经 channel 注入，不超时等待（2026-11-25 拍板：
//! 审批不会发生过期，与 clarify 同款；用户中断/拒绝才收口）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use bbrt_aigw::{ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg};
use bbrt_context::{
    assemble, budget_report, compact, AssembleParts, BudgetConfig, CompactionOutcome, Round,
    Summarizer, ToolCallRecord, ToolResultEntry,
};
use bbrt_memory::MemoryEngine;
use bbrt_sec::gate::PermissionMode;
use bbrt_sec::memory::GrantScope;
use bbrt_store::Store;

use crate::events::{ModelTier, SessionEvent, SessionSink, StreamChannel};
use crate::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use crate::state::{self, SessionState};

/// 循环上限（D11 §3 表：步数>50）。连续工具失败熔断已退役（2026-11-25
/// 用户拍板：不自动杀会话——用户拒绝/连续失败都不终止本轮，防失控由
/// 步数上限 + 用户中断兜底；8021 码位随之彻底无生产者）
pub const MAX_STEPS: usize = 50;

/// 子任务同步等待窗（D16 决策④：探查/专家超窗转后台；2026-11-24 用户拍板
/// 默认 120s→600s——真实调查任务 120s 普遍超窗转后台，本轮内看不到结果）
pub const SUBAGENT_WAIT_WINDOW: Duration = Duration::from_secs(600);

/// run_command 同步等待阈值（hybrid：到点未完不杀，自动转后台返回任务 id
/// 保住执行进度——对齐 Claude Code「超时转后台」；用户拍板 300s 保持现状口径）
pub(crate) const BG_SWITCH_AFTER_SECS: u64 = 300;

/// ETA 静态初值表毫秒（D16 §5/P1-6：滚动统计无样本时的兜底）
pub(crate) fn static_eta_ms(kind: &str) -> i64 {
    match kind {
        "probe" => 45_000,
        "expert" => 180_000,
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

/// 宿主→后台任务的指令（run.cancel / subagent.adjust 的 session 侧形态；
/// 探查/专家/终端后台命令共用。外部委派的 Launch/Review 已随委派域退役）
#[derive(Debug, Clone)]
pub enum BgHostMsg {
    /// 进程内子 agent 补充指令（probe/expert 经 subagent.adjust 注入下一模型轮）
    Input {
        text: String,
    },
    Cancel {
        graceful: bool,
    },
}

/// run 起始快照（D16 §3.1：agent_run 行的会话侧形态；统一后台任务审计）
#[derive(Debug, Clone)]
pub struct RunStart {
    pub run_id: String,
    pub session_id: String,
    /// 调用链根会话（v0.1 子 agent 均为顶层：root=session；嵌套链随 P1 扩展）
    pub root_session_id: String,
    /// 父 run（嵌套子任务用；顶层 run 恒空）
    pub parent_run_id: String,
    /// 触发本次 run 的工具调用 id（terminal=run_command 的 call_id）
    pub parent_call_id: String,
    /// probe | expert | terminal
    pub kind: &'static str,
    /// builtin.probe / {expertId}@{version} / shell
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
}

/// WAL 出口抽象（Store 实现；测试可注入 Noop）。
/// run 记录族（next_run_id/run_start/run_end/append_run）带默认 no-op：
/// 旧测试假件只实现 append 即可编译，行为退化为不落 run 行——显式接线
/// 由 Mutex<Store> 实现承载（bin 装配零改动）。
pub trait EventLog: Send + Sync {
    fn append(&self, session_id: &str, type_: &str, payload: &str);

    /// 持久任务发号（统一后台任务体系：kind 分前缀 agent-/terminal-
    /// + 32 hex；None=未接 Store，调用方退回进程内临时 id）
    fn next_task_id(&self, _kind: &str) -> Option<String> {
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
    /// 按 id 查 run 终态快照（subagent.wait 轮询；None=未接 Store 或 run 不存在）
    fn run_snapshot(&self, _run_id: &str) -> Option<EventRunSnapshot> {
        None
    }
}

/// run 终态快照（EventLog::run_snapshot 返回；跨 crate 不引 RunRow）
#[derive(Debug, Clone)]
pub struct EventRunSnapshot {
    pub status: String,
    pub kind: String,
    pub summary: String,
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
    fn next_task_id(&self, kind: &str) -> Option<String> {
        self.lock().ok().and_then(|s| s.next_task_id(kind).ok())
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
                actor: run.actor.clone(),
                created_at: now,
                started_at: now,
                ended_at: None,
            });
        }
    }
    fn run_end(&self, run_id: &str, end: &RunEnd<'_>) {
        if let Ok(store) = self.lock() {
            let _ = store.finish_run(run_id, end.status, end.eta_actual_ms, end.summary);
        }
    }
    fn append_run(&self, session_id: &str, run_id: &str, type_: &str, payload: &str) {
        if let Ok(store) = self.lock() {
            if let Ok(seq) = store.next_event_seq(session_id) {
                let _ = store.append_event_with_run(session_id, seq, type_, payload, run_id);
            }
        }
    }
    fn run_snapshot(&self, run_id: &str) -> Option<EventRunSnapshot> {
        self.lock().ok().and_then(|s| {
            s.run_by_id(run_id)
                .ok()
                .flatten()
                .map(|r| EventRunSnapshot {
                    status: r.status,
                    kind: r.kind,
                    summary: r.summary,
                })
        })
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
    /// 档位别名（预留：AigwClient 按别名路由，请求体 model 已固定 bbc-fast）
    #[allow(dead_code)]
    model: String,
}
impl Summarizer for FastSummarizer<'_> {
    fn summarize(&self, text: &str) -> Result<String, String> {
        chat_text(self.client, "把以下对话压缩为要点摘要，≤300字。", text)
    }
}

/// bbc-fast 单轮调用共用壳（system+user → 流式汇总全文）；
/// compaction 摘要、W3 记忆提炼与探查 planner 共用（19 篇档位别名固定 bbc-fast）
pub(crate) fn chat_text(
    client: &dyn ChatClient,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let req = ChatRequest {
        model: "bbc-fast".to_string(),
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
    /// 会话权限模式（共享句柄：session.set_mode 中途切档即时生效——runner 被
    /// turn 线程取走期间 manager 仍经同一 Arc 改写；读点每次取当前值）
    pub mode: Arc<RwLock<PermissionMode>>,
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
    /// W2② 连续错误计数器（同工具同错 ≥2 次 → feedback 教训；跨 turn 保留）
    err_tracker: bbrt_memory::ErrorTracker,
    /// D35 定时任务：无人值守——工具面剔除 ask_user + SYSTEM_PROMPT 追加约束
    pub unattended: bool,
    /// 子任务同步等待窗（D16 决策④：探查/专家 spawn 后同步等窗内 join，
    /// 超窗转后台继续跑——摘要经 hub park 下一轮回填；测试注入更短值）
    pub subagent_wait_window: Duration,
    /// 后台任务中枢（D16 §5 后台化推广：探查/专家超窗与终端后台命令
    /// 共用——run 注册/取消路由 + join parking。None=未装配（raw runner
    /// 测试/嵌入式用法）。manager.start 注入，生产路径恒 Some；
    /// 与 manager 共享同一实例
    pub bg_hub: Option<Arc<crate::bg_hub::BgHub>>,
    /// 会话场景（2026-11-23 三区块场景提示词；unattended 同款 pub 注入——
    /// manager.start 赋值，raw runner 缺省 Task）。决定 SYSTEM_PROMPT 末尾
    /// 追加哪段场景段
    pub scene: Scene,
    /// 记忆索引会话级快照（前缀稳定：首次 run_turn 渲染定格，之后整会话
    /// 复用——原按每条消息精排会让 system 消息逐轮变化，打断模型侧
    /// prompt cache 的整个 history 缓存前缀。代价=本会话中途新存记忆
    /// 下一会话才进索引）
    memory_snapshot: Option<String>,
    /// 技能目录会话级快照（同上：原每 step 重渲染，技能装卸会中途打断前缀）
    skills_snapshot: Option<String>,
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
    /// 供委派简报/子代理上下文等执行侧使用——记忆路由仍走 ws_path。
    pub fn exec_ws(&self) -> std::path::PathBuf {
        if self.workspace.is_empty() {
            bbrt_sec::sandbox::default_user_workspace()
        } else {
            std::path::PathBuf::from(&self.workspace)
        }
    }

    /// D19 [项目] 行：项目会话=目录；空 workspace=用户工作空间三规范文案
    /// （2026-11-23 拍板：跨任务共享+统一「用户工作空间」措辞，不区分场景）
    fn project_line(&self) -> String {
        if self.workspace.is_empty() {
            user_workspace_line(&self.exec_ws())
        } else {
            format!("workspace: {}", self.workspace)
        }
    }
}

/// 用户工作空间 [项目] 行文案（2026-11-23 拍板落码；主会话 project_line 与
/// 子代理 probe_system 共用单源防漂移）。三规范=操作约束/目录规范/命名规范，
/// 每轮随 system 重拼注入（compact 不丢）；PathPolicy 越根 8020 是文案对应的
/// 硬拦截层。
pub(crate) fn user_workspace_line(ws: &std::path::Path) -> String {
    format!(
        "User workspace {} (shared across tasks on this machine; store all outputs here)\n\
         - Operations: read and write only inside this space — read_file/list_dir to read and \
         list, write_file/edit_file to write and modify (create new files directly with \
         write_file); create directories and delete files/directories via run_command. \
         Writing outside the space is not allowed (out-of-bounds access will be rejected).\n\
         - Directory layout: organize outputs into topic subdirectories (e.g. reports/, \
         data/) instead of piling loose files in the root; put one-off intermediates in tmp/.\n\
         - Naming: semantic file names; CJK characters are allowed; no spaces or special \
         characters (use hyphens as separators); when iterating on the same topic, do not \
         overwrite existing files — append a suffix like -v2.",
        ws.display()
    )
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
        Self {
            session_id,
            workspace,
            mode: Arc::new(RwLock::new(mode)),
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
            // v0.1 恒开（`memory.heuristic=off` 开关随配置系统接线，D15 §2.2）
            err_tracker: bbrt_memory::ErrorTracker::new(true),
            unattended: false,
            subagent_wait_window: SUBAGENT_WAIT_WINDOW,
            bg_hub: None,
            scene: Scene::default(),
            memory_snapshot: None,
            skills_snapshot: None,
        }
    }

    /// 模式共享句柄（start 时克隆入 ManagedSession——session.set_mode 经
    /// manager 改写同一实例，runner 被 turn 线程取走期间也能生效）
    pub fn mode_handle(&self) -> Arc<RwLock<PermissionMode>> {
        Arc::clone(&self.mode)
    }

    /// 当前模式（消费点取读锁即时值——中途切档对下一个工具调用生效）
    fn cur_mode(&self) -> PermissionMode {
        *self.mode.read().unwrap()
    }

    /// 后台产物注入（D16 §5：探查/专家经 hub park 的摘要由 manager
    /// 在下一轮 run_turn 前 drain 后调用——主上下文以对应 join 轮次回填）
    pub fn inject_bg_join(&mut self, run_id: &str, name: &str, summary: &str) {
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
    pub memory: Option<Arc<MemoryEngine>>,
    pub wal: Arc<dyn EventLog>,
    pub sink: Arc<dyn SessionSink>,
    /// 技能索引（10 篇 §4.5：triggers 命中正文注入 skills 区块；tools.reload 热替换）
    pub skills: Arc<Mutex<crate::skills::SkillIndex>>,
    /// 探查子 Agent 判定器（08 §4.5；None=未装配零行为，FastPlanner 见 subagent.rs）
    pub fanout: Option<Arc<dyn crate::subagent::FanoutPlanner>>,
    /// 专家调用源（D14 §3.3 单专家选角；None=未装配零行为，FastPicker 见 expert.rs）。
    /// 判定优先于探查——专家=重执行体，探查=信息收集优化
    pub experts: Option<Arc<dyn crate::expert::ExpertSource>>,
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

        // 单专家调用（D14 §3.3 精简形态：选角命中 → run_expert → 摘要回填；
        // 优先于探查——专家=重执行体，探查=信息收集优化。状态复用 #9/#10
        // （"并行子任务执行中"同语义；专家并发 ≤1 由本顺序天然保证）
        if let Some(source) = deps.experts.as_ref() {
            if let Some(pick) = source.pick(deps.model.as_ref(), user_text) {
                self.state = crate::subagent::transition_fanout(self.state);
                emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                    session_id: id,
                    state: "subagent_fanout".into(),
                    reason: "expert.pick".into(),
                });
                deps.wal.append(
                    &self.session_id,
                    "expert.pick",
                    &format!("{{\"expert\":\"{}\"}}", escape_json(&pick.label)),
                );
                // 等待窗 + 超窗转后台（D16 决策④：同探查口径；专家在专用线程，
                // 窗内收口即时回填 / 超窗 park 摘要下一轮注入）
                let ctx = crate::expert::ExpertCtx {
                    model: Arc::clone(&deps.model),
                    tools: Arc::clone(&deps.tools),
                    mode: self.cur_mode(),
                    unattended: self.unattended,
                    hub: self.bg_hub.clone(),
                };
                let sid = self.session_id.clone();
                let sink_bg = Arc::clone(&deps.sink);
                let wal_bg = Arc::clone(&deps.wal);
                let hub = self.bg_hub.clone();
                let label = pick.label.clone();
                let (etx, erx) = std::sync::mpsc::channel::<crate::expert::ExpertResult>();
                let _ = std::thread::Builder::new()
                    .name("bbc-expert".into())
                    .spawn(move || {
                        let result = crate::expert::run_expert(
                            &ctx,
                            &sid,
                            &pick.expert,
                            &pick.task,
                            sink_bg.as_ref(),
                            wal_bg.as_ref(),
                            "",
                        );
                        // rx 已关（主线程超窗弃等）→ send Err：超窗路径 park 摘要
                        if etx.send(result.clone()).is_err() {
                            if let Some(hub) = hub {
                                // 超窗完成也发事件（通知/run 面板刷新；与窗内收口同构）
                                sink_bg.emit(SessionEvent::SubagentJoined {
                                    session_id: sid.clone(),
                                    results: vec![bbrt_protocol::SubagentResult {
                                        sub_id: result.run_id.clone(),
                                        ok: result.ok,
                                        summary: crate::subagent::truncate_chars(
                                            &result.summary,
                                            120,
                                        ),
                                    }],
                                });
                                hub.park_join(
                                    &sid,
                                    crate::bg_hub::BgJoin {
                                        name: "expert.join".into(),
                                        run_id: result.run_id.clone(),
                                        summary: format!(
                                            "## 专家结论（后台完成）\n{}",
                                            result.summary
                                        ),
                                    },
                                );
                            }
                        }
                    });
                // rx 先移出（超窗须显式 drop 才能让线程 send 失败→走 park 路径）
                let (expert_in_window, timed_out) = {
                    let rx = erx;
                    match rx.recv_timeout(self.subagent_wait_window) {
                        Ok(result) => (Some(result), false),
                        // 关窗瞬间防丢：非阻塞补收一次再弃等（drop 触发 park）
                        Err(_) => match rx.try_recv() {
                            Ok(result) => (Some(result), false),
                            Err(_) => {
                                drop(rx);
                                (None, true)
                            }
                        },
                    }
                };
                self.state = crate::subagent::transition_join(self.state);
                if let Some(result) = expert_in_window {
                    self.history.push(Round::Tool {
                        call_id: format!("expert-{}", result.run_id),
                        name: "expert.join".to_string(),
                        summary: format!("## 专家结论（{}）\n{}", label, result.summary),
                    });
                    emit(deps, &self.session_id, |id| SessionEvent::SubagentJoined {
                        session_id: id,
                        results: vec![bbrt_protocol::SubagentResult {
                            sub_id: result.run_id.clone(),
                            ok: result.ok,
                            summary: crate::subagent::truncate_chars(&result.summary, 120),
                        }],
                    });
                    emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                        session_id: id,
                        state: "running".into(),
                        reason: "expert.join".into(),
                    });
                } else if timed_out {
                    deps.wal
                        .append(&self.session_id, "expert.backgrounded", "{}");
                    emit(deps, &self.session_id, |id| SessionEvent::StateChanged {
                        session_id: id,
                        state: "running".into(),
                        reason: "expert.backgrounded".into(),
                    });
                }
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
                            ModelTier::Fast => "bbc-fast".to_string(),
                            ModelTier::Strong => "bbc-strong".to_string(),
                        });
                // D35：无人值守上下文传给子 agent（禁 ask_user + 提示词约束）
                let fanout_system = if self.unattended {
                    format!("{}{UNATTENDED_NOTE}", system_prompt_base())
                } else {
                    system_prompt_base()
                };
                let outcome = crate::subagent::fanout_probes(
                    &self.session_id,
                    self.cur_mode(),
                    Arc::clone(&deps.model),
                    Arc::clone(&deps.tools),
                    Arc::clone(&deps.sink),
                    Arc::clone(&deps.wal),
                    &subs,
                    &crate::subagent::FanoutEnv {
                        system: &fanout_system,
                        unattended: self.unattended,
                        skills: &deps.skills,
                        memory: deps.memory.as_ref(),
                        workspace: &self.workspace,
                        model_name,
                        wait_window: self.subagent_wait_window,
                        hub: self.bg_hub.clone(),
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

        // 记忆召回注入（D15 §2.3；D19 分级——项目会话注
        // [用户记忆]+[项目记忆] 两段、日常仅用户段）。
        // 前缀稳定（2026-11-23 快照化）：首次 run_turn 渲染定格，整会话复用——
        // 按消息精排会让 system 消息逐轮变化，打断模型侧 prompt cache 对整个
        // history 的缓存前缀；代价=本会话中途新存记忆下一会话才进索引
        if self.memory_snapshot.is_none() {
            self.memory_snapshot = Some(
                deps.memory
                    .as_ref()
                    .map(|m| m.recall_scoped(self.ws_path(), user_text))
                    .unwrap_or_default(),
            );
        }

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
                    model: "bbc-fast".into(), // 19 篇档位别名
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
                        wal_turn_error(deps, &self.session_id, 8010, "压缩后仍超上下文上限", true);
                        // 2026-11-11：错误收口 idle（时间线已留 Error 卡）——旧口径
                        // 转 paused 会卡死（resume 通道已随「停止」口径移除），用户无法重试
                        break;
                    }
                }
            }

            // ② 组装 + 请求模型
            report.steps += 1;
            // 技能目录区（D33 §3.1：技能加载改显式 `skill` 工具调用——组装只放
            // 全量目录引导（name：description，正文不漏），隐式触发词注入退役；
            // 空索引=空段零成本。工具面收紧（allowedTools 并集）随显式调用阶段二
            // 重接线——本轮恒不限制。
            // 前缀稳定（2026-11-23 快照化）：首个 step 渲染定格，整会话复用——
            // 技能装卸中途变化同样会打断缓存前缀
            if self.skills_snapshot.is_none() {
                let text = {
                    let idx = deps.skills.lock().unwrap_or_else(|p| p.into_inner());
                    idx.render_catalog()
                };
                self.skills_snapshot = Some(text);
            }
            let skills_text = self.skills_snapshot.clone().unwrap_or_default();
            let allowed_tools: Option<Vec<String>> = None;
            // D35 无人值守：工具面剔除 ask_user（三层保障之二；分支防御在 run_tool）
            let mut tool_specs = deps.tools.tool_specs();
            if self.unattended {
                tool_specs.retain(|s| s.name != "ask_user");
            }
            // 场景段（2026-11-23 三区块）：基底共用，末尾按 scene 追加；
            // 会话内恒定（conv_id 是会话常量）→ 不动缓存前缀
            let mut system_prompt = format!("{}{}", system_prompt_base(), self.scene.system_note());
            if self.unattended {
                system_prompt.push_str(UNATTENDED_NOTE);
            }
            let assembled = assemble(
                &deps.budget,
                AssembleParts {
                    system: &system_prompt,
                    skills: &skills_text,
                    project: &self.project_line(),
                    memory_index: self.memory_snapshot.as_deref().unwrap_or(""),
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
                        ModelTier::Fast => "bbc-fast".to_string(),
                        ModelTier::Strong => "bbc-strong".to_string(),
                    });
            let req = ChatRequest {
                model: model_name,
                messages,
                tools: pick_tools(tool_specs, &allowed_tools),
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
                    wal_turn_error(deps, &self.session_id, 8011, &format!("模型不可用: {e}"), false);
                    // 模型失败收口 idle：时间线留错误卡，会话可换模型/重发即重试
                    break;
                }
            };
            let mut text = String::new();
            let mut thinking = String::new();
            let mut tool_calls: Vec<ToolCallMsg> = vec![];
            let mut finish = FinishReason::Stop;
            let mut usage = (0u64, 0u64);
            // D36：上游缓存命中/实际模型名（最后一次 Done 为准；None=未知）
            let mut cached_tokens: Option<u64> = None;
            let mut model_name: Option<String> = None;
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
                    // 思考增量（2026-11-11）：只外发不并入正文——前端思考折叠卡消费；
                    // 全文积累随步落 WAL（D33 思考回放：session.history 重开还原过程区）
                    Ok(StreamEvent::ReasoningDelta { text: t }) => {
                        thinking.push_str(&t);
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
                        model: m,
                    }) => {
                        finish = f;
                        usage = (u.prompt_tokens as u64, u.completion_tokens as u64);
                        cached_tokens = u.cached_tokens.map(|v| v as u64);
                        if m.is_some() {
                            model_name = m;
                        }
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
                wal_turn_error(
                    deps,
                    &self.session_id,
                    8011,
                    &format!("流中断（{detail}），已产出内容不重放（08 §4.6）"),
                    false,
                );
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
                cached_tokens,
                model: model_name.clone(),
            });
            // 思考全文先行落 WAL（非空才落；置于 assistant.done 前——回放顺序
            // =直播顺序 thinking→正文。D33 思考回放批次，正文前的过程条目）
            if !thinking.is_empty() {
                deps.wal.append(
                    &self.session_id,
                    "assistant.thinking",
                    &serde_json::json!({ "text": thinking }).to_string(),
                );
            }
            // 崩溃恢复契约：一轮模型输出完成（recovery 以 assistant.done
            // 配对 user.text 落 assistant 轮，摘要级重建即可续会话）。
            // text=本轮回复原文（工作台 session.history 加载聊天记录数据源；
            // 旧行缺此字段 → 历史加载跳过该轮，渐进降级）；
            // D36：附 cached_tokens/model（session.history.lastUsage 恢复状态条用，
            // 旧行缺省=未知）
            deps.wal.append(
                &self.session_id,
                "assistant.done",
                &serde_json::json!({
                    "finish": match finish {
                        FinishReason::Stop => "stop",
                        FinishReason::ToolCalls => "tool_calls",
                        FinishReason::Length => "length",
                    },
                    "usage_in": usage.0,
                    "usage_out": usage.1,
                    "text": text,
                    "cached_tokens": cached_tokens,
                    "model": model_name,
                })
                .to_string(),
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
                // P0 显示层对齐：风险级按 gate 逐调用分类（命令内容），旧静态表退役
                let risk = deps.tools.risk_of_call(&call);
                emit(deps, &self.session_id, |id| SessionEvent::ToolCall {
                    session_id: id,
                    call_id: tc.id.clone(),
                    tool: tc.name.clone(),
                    args_masked: masked.clone(),
                    risk: risk.into(),
                });
                // D33 §3.4：WAL 补记脱敏参数——session.history 回放工具卡保真
                // （命令/路径/diff 重启可见；旧读法按缺 args 降级）
                deps.wal.append(
                    &self.session_id,
                    "tool.call",
                    &serde_json::json!({
                        "call_id": tc.id,
                        "tool": tc.name,
                        "args": masked,
                    })
                    .to_string(),
                );

                let outcome = self.run_tool(deps, &call, &masked, risk);
                // W2② 连续错误教训（D15 §2.2：同工具同错 ≥2 次 → 自动记 feedback）。
                // Rejected（用户拒绝/审批超时）不喂——流程控制结果非执行失败
                match &outcome {
                    ToolOutcome::Ok { .. } => self.err_tracker.record_success(&tc.name),
                    ToolOutcome::Rejected { .. } => {}
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
                    ToolOutcome::Rejected { code, summary } => {
                        // 只计调用数不计失败数（拒绝≠失败）；事件/前缀口径与
                        // Blocked 一致，前端零改动
                        report.tool_calls += 1;
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
                    ToolOutcome::Blocked { code, summary } => {
                        report.tool_calls += 1;
                        report.tool_failures += 1;
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

    /// 工具执行统一入口（hybrid）：run_command 走 execute_or_handoff——
    /// 完成即同步结果；到 BG_SWITCH_AFTER_SECS 未完自动转后台（不杀），
    /// 「快完成的构建被杀重跑」从 run_command 上退役。其余工具=同步 execute。
    fn execute_maybe_handoff(&mut self, deps: &LoopDeps, call: &ToolInvocation) -> ToolOutcome {
        if call.name == "run_command" {
            let started = std::time::Instant::now();
            return match deps
                .tools
                .execute_or_handoff(self.cur_mode(), call, BG_SWITCH_AFTER_SECS)
            {
                crate::executor::CommandHandoff::Done(out) => out,
                crate::executor::CommandHandoff::StillRunning(det) => {
                    let task_id = deps
                        .wal
                        .next_task_id("terminal")
                        .unwrap_or_else(|| format!("term-{}", call.call_id));
                    deps.wal.run_start(&RunStart {
                        run_id: task_id.clone(),
                        session_id: self.session_id.clone(),
                        root_session_id: self.session_id.clone(),
                        parent_run_id: String::new(),
                        parent_call_id: call.call_id.clone(),
                        kind: "terminal",
                        def_ref: "shell".into(),
                        eta_hint_ms: 0,
                        actor: String::new(),
                    });
                    self.adopt_background_command(deps, det, &task_id, started, false)
                }
            };
        }
        deps.tools.execute(self.cur_mode(), call)
    }

    /// run_command 后台执行（统一后台任务体系 2026-11-18）：gate 放行后、
    /// execute 之前拦截 background=true——spawn 进程组立即返回 terminal- 任务 id，
    /// 专用线程收割落终态；无时长上限仅取消（D16 决策④口径）；
    /// 结果摘要（exit+输出尾部）存 agent_run.summary，task.wait 统一取回。
    fn run_command_background(&mut self, deps: &LoopDeps, call: &ToolInvocation) -> ToolOutcome {
        let task_id = deps
            .wal
            .next_task_id("terminal")
            .unwrap_or_else(|| format!("term-{}", call.call_id));
        deps.wal.run_start(&RunStart {
            run_id: task_id.clone(),
            session_id: self.session_id.clone(),
            root_session_id: self.session_id.clone(),
            parent_run_id: String::new(),
            parent_call_id: call.call_id.clone(),
            kind: "terminal",
            def_ref: "shell".into(),
            eta_hint_ms: 0,
            actor: String::new(),
        });
        let started = std::time::Instant::now();
        let det = match deps.tools.spawn_background(call) {
            Ok(d) => d,
            Err(e) => {
                deps.wal.run_end(
                    &task_id,
                    &RunEnd {
                        status: "failed",
                        eta_actual_ms: started.elapsed().as_millis() as i64,
                        summary: &e,
                    },
                );
                return ToolOutcome::Blocked {
                    code: 8020,
                    summary: e,
                };
            }
        };
        self.adopt_background_command(deps, det, &task_id, started, true)
    }

    /// 接管一个在跑的后台命令（显式 background 与同步超时自动转后台共用）：
    /// hub 注册取消路由 + 专用收割线程（终态+摘要截 2000 落 agent_run）。
    /// 返回「后台执行中」工具结果。
    #[allow(clippy::too_many_arguments)]
    fn adopt_background_command(
        &mut self,
        deps: &LoopDeps,
        det: bbrt_sec::sandbox::DetachedCommand,
        task_id: &str,
        started: std::time::Instant,
        explicit: bool,
    ) -> ToolOutcome {
        const SIGINT: i32 = 2;
        const SIGKILL: i32 = 9;
        let task_id = task_id.to_string();
        // hub 注册（取消路由；未装配=退化，仅不可中途取消）
        let rx = match self.bg_hub.as_ref() {
            Some(hub) => {
                let (tx, rx) = std::sync::mpsc::channel::<BgHostMsg>();
                hub.register(&task_id, &self.session_id, tx);
                rx
            }
            None => {
                let (_tx, rx) = std::sync::mpsc::channel::<BgHostMsg>();
                rx
            }
        };
        let wal = deps.wal.clone();
        let sid = self.session_id.clone();
        let tid = task_id.clone();
        let hub_for_cleanup = self.bg_hub.clone();
        let _ = std::thread::Builder::new()
            .name(format!("bbc-shell-{tid}"))
            .spawn(move || {
                let mut det = det;
                let mut cancelled = false;
                loop {
                    // 宿主指令 drain（取消：graceful=SIGINT→3s→SIGKILL；强制=直接杀）
                    while let Ok(msg) = rx.try_recv() {
                        if let BgHostMsg::Cancel { graceful } = msg {
                            cancelled = true;
                            wal.append_run(
                                &sid,
                                &tid,
                                "terminal.cancel",
                                &format!("{{\"run_id\":\"{tid}\",\"graceful\":{graceful}}}"),
                            );
                            det.signal_group(if graceful { SIGINT } else { SIGKILL });
                        }
                    }
                    match det.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) => {}
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let r = det.finish();
                // 摘要组装（对齐 cmd::run_with_launcher 口径，截 2000 存库）
                let mut summary = r.stdout.clone();
                if !r.stderr.trim().is_empty() {
                    summary.push_str(&format!("\n[stderr]\n{}", r.stderr));
                }
                if r.exit_code != Some(0) {
                    summary.push_str(&format!(
                        "\n[{}]",
                        match r.exit_code {
                            Some(c) => format!("exit_code={c}"),
                            None => "signal".to_string(),
                        }
                    ));
                }
                if r.truncated {
                    summary.push_str(&format!(
                        "\n[输出超限截断，total={} bytes]",
                        r.total_output_bytes
                    ));
                }
                let summary = crate::subagent::truncate_chars(&summary, 2000);
                let status = if cancelled {
                    "cancelled"
                } else if r.exit_code == Some(0) {
                    "done"
                } else {
                    "failed"
                };
                wal.run_end(
                    &tid,
                    &RunEnd {
                        status,
                        eta_actual_ms: r.duration_ms as i64,
                        summary: &summary,
                    },
                );
                if let Some(hub) = hub_for_cleanup {
                    hub.unregister(&tid);
                }
            });
        let waited = started.elapsed().as_secs();
        let summary = if explicit {
            format!("[后台执行中] {task_id}——用 task.wait 等待结果")
        } else {
            format!(
                "[已运行 {waited}s，自动转后台（命令继续执行不受影响）] {task_id}——用 task.wait 等待结果"
            )
        };
        ToolOutcome::Ok {
            summary,
            truncated: false,
            exit_code: None,
            duration_ms: started.elapsed().as_millis() as u64,
        }
    }

    /// 等待子 Agent/委派 run 终态并取回结果（B 批 2026-11-18）：异步委派/
    /// 后台子任务发起后，模型需要其输出才能继续时主动等待——已完成立即
    /// 返回结果摘要；超时返回「仍在运行」（非错误，可再次调用或先做别的）。
    /// 等待期响应 interrupt（紧急停止收口等待；主会话中断已联动取消
    /// 本会话后台 run，见 manager::interrupt）。
    fn run_subagent_wait(&mut self, deps: &LoopDeps, call: &ToolInvocation) -> ToolOutcome {
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
        // 缺省对齐 SUBAGENT_WAIT_WINDOW（600s），上限 3600s 防呆
        let timeout_secs = v
            .get("timeout_secs")
            .and_then(|x| x.as_u64())
            .unwrap_or(SUBAGENT_WAIT_WINDOW.as_secs())
            .min(3600);
        let Some(mut snap) = deps.wal.run_snapshot(&run_id) else {
            return ToolOutcome::Blocked {
                code: 8002,
                summary: format!("未知 run {run_id}（未落库或来自其他环境）"),
            };
        };
        let started = std::time::Instant::now();
        let deadline = started + Duration::from_secs(timeout_secs);
        let is_final = |st: &str| matches!(st, "done" | "failed" | "cancelled" | "interrupted");
        loop {
            if is_final(&snap.status) {
                deps.wal.append(
                    &self.session_id,
                    "subagent.wait",
                    &serde_json::json!({
                        "run_id": run_id,
                        "waited_ms": started.elapsed().as_millis() as u64,
                        "status": snap.status,
                    })
                    .to_string(),
                );
                let summary = match snap.kind.as_str() {
                    "terminal" => format!("[命令完成·{}] {}", snap.status, snap.summary),
                    _ => format!("[子任务完成·{}] {}", snap.status, snap.summary),
                };
                return ToolOutcome::Ok {
                    summary,
                    truncated: false,
                    exit_code: None,
                    duration_ms: started.elapsed().as_millis() as u64,
                };
            }
            if self.interrupted.load(Ordering::Relaxed) {
                return ToolOutcome::Blocked {
                    code: 8002,
                    summary: format!("等待被中断（已请求取消后台任务 {run_id}）"),
                };
            }
            if std::time::Instant::now() >= deadline {
                deps.wal.append(
                    &self.session_id,
                    "subagent.wait",
                    &serde_json::json!({
                        "run_id": run_id,
                        "waited_ms": started.elapsed().as_millis() as u64,
                        "status": snap.status,
                        "timeout": true,
                    })
                    .to_string(),
                );
                return ToolOutcome::Ok {
                    summary: format!(
                        "{run_id} 仍在运行（状态 {}，已等 {}s）——可再次调用 subagent.wait 继续等待，或先处理其他事务",
                        snap.status,
                        started.elapsed().as_secs()
                    ),
                    truncated: false,
                    exit_code: None,
                    duration_ms: started.elapsed().as_millis() as u64,
                };
            }
            std::thread::sleep(Duration::from_millis(500));
            if let Some(next) = deps.wal.run_snapshot(&run_id) {
                snap = next;
            }
        }
    }

    /// 子 Agent 运行中调整（D16 决策⑧）：subagent.adjust{run_id,instruction} /
    /// subagent.cancel{run_id} → hub 定向 Input/Cancel（探查/专家/终端通用）
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
        let Some(hub) = self.bg_hub.as_ref() else {
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
            BgHostMsg::Cancel { graceful: true }
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
            BgHostMsg::Input { text: instruction }
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

    /// 单个工具调用全流程：门控 →（审批 → 记忆）→ 执行
    fn run_tool(
        &mut self,
        deps: &LoopDeps,
        call: &ToolInvocation,
        masked: &str,
        risk: &str,
    ) -> ToolOutcome {
        // 子 Agent 运行中调整（D16 决策⑧）：经 hub 定向下发补充指令/取消
        // ——适用探查/专家/终端全部在跑 run（bbrt-tools 门面仅提供可发现性）
        if call.name == "subagent.adjust" || call.name == "subagent.cancel" {
            return self.run_subagent_adjust(deps, call);
        }
        // 等待子任务结果（B 批 2026-11-18）：异步发起后主动等待/取回
        if call.name == "task.wait" || call.name == "subagent.wait" {
            return self.run_subagent_wait(deps, call);
        }
        // D20 ask_user：向用户提问——专用路径（不走 pipeline 门控/执行）：
        // waiting_clarify 态 + clarify.request 事件 + **不超时**等待（1s 轮询查
        // 中断旗标，用户「停止」= cancelled 收口）；回答以工具结果回给模型
        if call.name == "ask_user" {
            // D35 无人值守：工具面已剔除，此处再防御（模型硬调/旧上下文残留）
            if self.unattended {
                return ToolOutcome::Blocked {
                    code: 8002,
                    summary: "无人值守定时执行不支持向用户提问，请按最合理默认继续并在结论说明假设"
                        .into(),
                };
            }
            return self.run_ask_user(deps, call);
        }
        match deps.tools.check(self.cur_mode(), call) {
            CheckOutcome::Allow { source } => {
                let _ = source;
                self.execute_allowed(deps, call)
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

                // 等待宿主回执：不超时（2026-11-25 用户拍板：审批不会发生过期，
                // 与 clarify 等待同款口径）；1s 轮询查中断旗（用户「停止」→
                // 作废未决审批收口 cancelled）；迟到的其它回执丢弃继续等
                let decision = loop {
                    if self.interrupted.load(Ordering::Relaxed) {
                        emit(deps, &self.session_id, |id| {
                            SessionEvent::PermissionResolved {
                                session_id: id,
                                request_id: request_id.clone(),
                                decision: "cancelled".into(),
                                scope: "once".into(),
                            }
                        });
                        self.state =
                            state::permission_resolved(self.state).unwrap_or(SessionState::Running);
                        deps.wal.append(
                            &self.session_id,
                            "permission.resolved",
                            &format!(
                                "{{\"request_id\":\"{request_id}\",\"decision\":\"cancelled\"}}"
                            ),
                        );
                        break None;
                    }
                    match self.permission_rx.recv_timeout(Duration::from_secs(1)) {
                        Ok(resp)
                            if resp.request_id == request_id
                                && resp.decision == PermissionDecision::Allow =>
                        {
                            let _ = deps.tools.record_grant(self.cur_mode(), call, resp.scope);
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
                            self.state = state::permission_resolved(self.state)
                                .unwrap_or(SessionState::Running);
                            deps.wal.append(
                                &self.session_id,
                                "permission.resolved",
                                &format!(
                                    "{{\"request_id\":\"{request_id}\",\"decision\":\"allow\"}}"
                                ),
                            );
                            break Some(exec_call);
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
                            self.state = state::permission_resolved(self.state)
                                .unwrap_or(SessionState::Running);
                            deps.wal.append(
                                &self.session_id,
                                "permission.resolved",
                                &format!(
                                    "{{\"request_id\":\"{request_id}\",\"decision\":\"deny\"}}"
                                ),
                            );
                            break None;
                        }
                        Ok(_) => continue, // 迟到的其它回执丢弃继续等（原按超时处理）
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => break None,
                    }
                };
                match decision {
                    // 审批通过后同样走 execute_allowed：用户批准的命令若带
                    // background:true 同样转后台（审批语义与同步路径一致）
                    Some(exec_call) => self.execute_allowed(deps, &exec_call),
                    None => ToolOutcome::Rejected {
                        code: 8002,
                        summary: "用户拒绝或会话中断".into(),
                    },
                }
            }
        }
    }

    /// gate 放行后的执行分派（缺口修复 2026-11-24）：run_command 带
    /// background:true 转后台 spawn（统一后台任务体系），其余同步/hybrid。
    /// 后台拦截原在 check 之前=后台命令免审直跑（ask 档 rm 也能 spawn）——
    /// 现矩阵放行或用户批准后才 spawn，审批语义与同步路径完全一致
    fn execute_allowed(&mut self, deps: &LoopDeps, call: &ToolInvocation) -> ToolOutcome {
        if run_command_is_background(call) {
            return self.run_command_background(deps, call);
        }
        self.execute_maybe_handoff(deps, call)
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

    /// 会话结束：W3 提炼收口（D15 §2.2；D15 被动轨日报已随 UI 退役移除）
    pub fn end(&mut self, deps: &LoopDeps, summary: &str) {
        self.state = state::end(self.state);
        deps.wal.append(
            &self.session_id,
            "session.ended",
            &format!("{{\"summary_len\":{}}}", summary.len()),
        );
        // W3 会话结束提炼：失败静默不阻塞收口。
        // D19：按条目类型分级——user→用户级，其余有目录落项目分区
        let saved = distill_memories(deps, &self.session_id, self.ws_path(), &self.history);
        if saved > 0 {
            deps.wal.append(
                &self.session_id,
                "memory.distill",
                &format!("{{\"count\":{saved}}}"),
            );
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

    /// 澄清回执通道（宿主 clarify.response 注入；D20）
    pub fn clarify_sender(&self) -> Sender<ClarifyAnswer> {
        self.clarify_tx.clone()
    }
}

/// 系统提示基底（08 篇行为规格 + D15 §2.2 W1 记忆使用规范 + D19 分级 + D20 澄清规范；技能注入阶段二）。
/// 开头身份句不在本常量（brand::AGENT_NAME 编译期定制），经 system_prompt_base() 拼装
pub(crate) const SYSTEM_PROMPT_BODY: &str = "Rules: 1) File modifications and command execution are subject to permission gating and sandboxing — never act beyond granted permissions. 2) Tool arguments must be valid JSON only. 3) For long files, read excerpts first, then decide.\n\nCoding conduct:\n- Scope discipline: do only what the task requires — no extra features, no drive-by refactors, no new abstractions. A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper; don't design for hypothetical future requirements. Three similar lines beat a premature abstraction. No error handling, fallbacks, or validation for scenarios that can't happen — validate only at system boundaries (user input, external APIs, network/file IO). Delete unused code completely instead of compatibility shims (renaming to _unused, re-exports, \"// removed\" comments). No half-finished work: either it's done, or say explicitly that it isn't.\n- Read before you act: read any file before modifying it; prefer reading the relevant sections over guessing structure. Interpret vague or colloquial instructions as engineering tasks and act on the code — if told to rename something, find the identifier and rename it, don't reply with a suggestion. Search the codebase for existing implementations or helpers before writing new ones. New code must read like the surrounding code: match its comment density, naming, and idioms.\n- Workspace & version control: a dirty worktree is normal — NEVER revert or overwrite changes you didn't make (that is the user's work in progress); if a file you must touch already has foreign changes, understand them and build on top. If you notice unexpected changes you didn't cause, STOP IMMEDIATELY and ask the user. NEVER use destructive commands (git reset --hard, git checkout --, rm -rf, dropping tables) unless explicitly requested or approved; when blocked, find the root cause, don't bypass with destructive shortcuts (no --no-verify, don't delete lock files). Don't commit, push, or amend unless explicitly asked.\n- Risk tiers: local, reversible actions (editing files, running tests, building) are free to take. Actions that are hard to reverse, affect shared systems, or are externally visible (pushing, sending messages, deleting data, changing shared config) — explain first and wait for confirmation; one approval covers that scope only, never extrapolate.\n- Verification & reporting: always verify changes with the project's own tooling (tests/compile/build). Report failures honestly with output attached — no sugarcoating, no skipping; state plainly which steps were left unverified. Say \"done\" only when done AND verified. Always cite code as file_path:line_number. When stuck, diagnose and switch approaches (retry, different tool, different source) instead of idling; stop only for genuine blockers, stating exactly what's missing. Lead with the conclusion and keep it terse: dump no whole files — give paths and key lines; offer next steps as a numbered list so the user can reply with a single digit.\n- Security: never introduce injection vulnerabilities (command, SQL, XSS — OWASP Top 10); fix insecure code the moment you notice it. No hardcoded secrets or credentials.\n\nAsking the user (ask_user tool): use only when a pivotal decision would shape substantial downstream work, or the user's intent is genuinely ambiguous — choosing between two approaches, confirming a destructive operation, or trading off requirement directions. Decide on your own whenever reasonable. Ask one question at a time with 2-4 options (short label + description of the trade-off); the user can also answer freely via the \"Other\" option. After asking, wait for the answer — never guess it.\n\nLong-term memory (memory_save tool; persists across sessions; automatically scoped by partition):\n- When to save: user identity, preferences and habits (e.g. \"I like…\", \"from now on please…\"); key project facts and decisions (ports, environments, conventions); lessons from user corrections; pointers to frequently used external resources.\n- Types: user = identity & preferences; project = project facts; feedback = correction lessons (body must include Why and How to apply lines); reference = external resource pointers.\n- Scoping (automatic routing, no need to specify): user items go to the user level (visible in all sessions); project/feedback/reference items go to the project's own partition in project sessions, and to the user level in casual conversations. When the [Memory] block contains both [User Memory] and [Project Memory] sections, the project section applies only to this project's sessions.\n- Before writing, check the [Memory] index; don't duplicate an existing topic (writing the same topic updates it in place). Don't save transient content, information derivable from code or the repository, or any secrets/credentials.\n- Treat [Memory] content as trusted background; on conflict with the current conversation, the user's latest statement wins.\n- [Project Progress] (project sessions): this project's cross-session work ledger, auto-updated at the end of each session (done/todo/blockers/decisions/pitfalls); treat it as trusted background. When resuming, read todo and done first; on conflict with the current conversation, the user's latest statement wins.";

/// 完整系统提示基底（主链路与子 agent 共用）：身份句 + 行为体 + 企业身份段。
/// brand::AGENT_NAME / AGENT_IDENTITY 由 brand/brand.json 生成（企业白标，D31 同源；
/// 名字空值生成期回退品牌 name，identity 空串不追加——默认部署与定制前逐字节一致）。
/// 身份段在场景段（scene_note）/无人值守段（UNATTENDED_NOTE）之前：全局身份进稳定前缀，利于 prompt cache
pub(crate) fn system_prompt_base() -> String {
    let mut p = format!(
        "You are the local agent of {}, serving a single user. Always reply in the user's \
         language. {SYSTEM_PROMPT_BODY}",
        crate::brand::AGENT_NAME
    );
    if !crate::brand::AGENT_IDENTITY.is_empty() {
        p.push_str("\n\n");
        p.push_str(crate::brand::AGENT_IDENTITY);
    }
    p
}

/// D35 定时任务无人值守追加段（append 在 SYSTEM_PROMPT 后）：ask_user 已从
/// 工具面移除，此处再明确行为约束——不提问、按合理默认继续、结论说明假设。
pub(crate) const UNATTENDED_NOTE: &str = "\n\n[Unattended scheduled run] This run was triggered automatically by a scheduled task and the user is not present: do NOT ask the user anything (ask_user is unavailable); when information is uncertain, proceed with the most reasonable default and clearly state the assumptions made in your final conclusion.";

/// 会话场景（2026-11-23 三区块场景提示词）。三区块共用 SYSTEM_PROMPT 基底，
/// 末尾按场景追加场景段（同 UNATTENDED_NOTE 机制）。写法口径（用户拍板）：
/// 只写场景定位、上下文来源、工作流指引；不写回答风格、输出格式、用途约定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scene {
    /// 项目会话（workspace 非空）
    Project,
    /// 日常对话（IM 私聊/群聊唤起；conv_id=im_history 参数、conv_type 区分
    /// 单聊/群聊——群聊=多人发言、指代更模糊，是模型理解上下文需要的事实）
    Embedded {
        conv_id: String,
        conv_type: String, // "single" | "group"（缺省按 single 渲染）
    },
    /// 任务会话（不绑定单一项目）
    Task,
}

impl Default for Scene {
    /// raw runner（测试/嵌入式）缺省=Task；生产路径 manager.start 显式注入
    fn default() -> Self {
        Scene::Task
    }
}

impl Scene {
    /// 场景段渲染（拼在 SYSTEM_PROMPT 末尾）
    pub fn system_note(&self) -> String {
        match self {
            Scene::Project => SCENE_PROJECT.into(),
            Scene::Embedded { conv_id, conv_type } => {
                let kind = if conv_type == "group" {
                    "group chat"
                } else {
                    "direct chat"
                };
                format!(
                    "\n\n[Scene: Chat] This session was invoked by the user from their {kind} \
                     (conv_id: {conv_id}); the discussion context of this session is that \
                     conversation's message history, readable via the im_history tool with \
                     this conv_id (lines starting with 【Agent】 are your own earlier replies)."
                )
            }
            Scene::Task => SCENE_TASK.into(),
        }
    }
}

/// 项目会话场景段：定位+工作流指引（project_line 已带 workspace 路径，不重复）
const SCENE_PROJECT: &str = "\n\n[Scene: Project] This session works on the repository that workspace points to. Before acting, read [Project Memory] and [Project Progress] to learn existing decisions and open items; follow the repository's established conventions when changing code — when unsure, the repository's current state is the source of truth.";

/// 任务会话场景段：不承诺能力面没有的东西（任务会话无读其他项目记忆分区的
/// 工具面——跨项目落地路径=用户给路径，文件/命令工具走绝对路径）
const SCENE_TASK: &str = "\n\n[Scene: Task] This session is not bound to a single project and suits cross-project or general-purpose work; when a specific project is involved, treat the project path given by the user as the working target.";

/// 组装结果 → 模型消息序列（system/记忆/项目 → history → 工具结果）
fn to_chat_messages(a: &bbrt_context::Assembled) -> Vec<ChatMessage> {
    let mut msgs = vec![ChatMessage {
        role: "system".into(),
        // [技能] 段（10 篇 §4.5 命中注入；此前 Assembled.skills 组装后被丢弃——补消费）
        content: format!(
            "{}\n\n[Skills]\n{}\n\n[Project]\n{}\n\n[Memory]\n{}",
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

/// run_command 的 args.background 读取（非 run_command/解析失败 = false）。
/// 仅执行分派用——门控判定不感知 background（同一命令同档位同结论）
fn run_command_is_background(call: &ToolInvocation) -> bool {
    call.name == "run_command"
        && serde_json::from_str::<serde_json::Value>(&call.args_json)
            .ok()
            .and_then(|v| v.get("background").and_then(|b| b.as_bool()))
            .unwrap_or(false)
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

/// 回合错误落 WAL（turn.error 行：8011 模型不可用/流中断、8010 超限、8021 等）。
/// 与 emit 的实时 NTF 并行——错误卡重开回放保留（session.history 投影
/// HistoryItem::Error），用户重进会话能看到 agent 为何没回复；
/// recover() 重放忽略该行（错误给用户看，不进模型上下文）。
fn wal_turn_error(deps: &LoopDeps, session_id: &str, code: u32, message: &str, fatal: bool) {
    deps.wal.append(
        session_id,
        "turn.error",
        &serde_json::json!({ "code": code, "message": message, "fatal": fatal }).to_string(),
    );
}

// ---------------------------------------------------------------------------
// W3 会话结束提炼（D15 §2.2 表第 3 行；bbc-fast，尽力而为）
// ---------------------------------------------------------------------------

/// W3 每会话最多提炼条数（防记忆膨胀）
const DISTILL_MAX_ITEMS: usize = 3;
/// W3 会话转录总量上限（字符；超出截断，保尾部最近的轮次）
const DISTILL_TRANSCRIPT_MAX_CHARS: usize = 8_000;
/// D37：W3 提示词中已有进度台账的头部行数（去重参考，控提示长度）
const STATUS_PROMPT_HEAD_LINES: usize = 40;

/// D19 记忆作用域路由：user 类（身份/偏好）恒用户级；
/// project/feedback/reference 类随会话工作目录落项目分区（日常会话回落用户级）
fn route_scope(
    ws: Option<&std::path::Path>,
    mtype: bbrt_memory::MemoryType,
) -> Option<&std::path::Path> {
    match mtype {
        bbrt_memory::MemoryType::User => None,
        _ => ws,
    }
}

/// W3：会话结束提炼——①"决策/偏好/教训"落长期记忆；②（D37，项目会话）
/// 进度增量并入项目进度台账。模型失败、输出不可解析、条目非法一律静默
/// 跳过——绝不阻塞会话收口。返回落盘条数（记忆+进度合计）。
/// D19：记忆条目按类型分级（user→用户级；其余随会话目录落项目分区）。
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
    // D19：项目会话喂用户+项目两域索引；D37：改喂不含进度段的记忆召回
    // （进度段单独喂全量头 40 行，避免 60 行截断把台账切掉）
    let existing = m.recall_memory_scoped(ws, "");
    let existing_head: String = existing.lines().take(60).collect::<Vec<_>>().join("\n");
    let system = if ws.is_some() {
        // D37：项目会话一次调用同时产出记忆与进度增量（对象 payload）
        let status_head = ws
            .and_then(|w| m.status_body(w))
            .map(|b| {
                b.lines()
                    .take(STATUS_PROMPT_HEAD_LINES)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_else(|| "(none)".to_string());
        format!(
            "Distill two kinds of content from the session transcript. Output exactly one JSON \
             object (nothing to record → {{\"memories\":[],\"progress\":{{}}}}), shaped like:\n\
             {{\"memories\":[{{\"title\":\"one-line title, max 40 chars\",\
             \"type\":\"user|project|feedback|reference\",\
             \"body\":\"factual body (feedback must include Why and How to apply lines)\"}}],\n\
             \"progress\":{{\"done\":[\"11-19 D35: batch 0-4 pushed, all checks green\"],\
             \"todo\":[\"D35: on-device acceptance, eight items\"],\"blockers\":[],\"decisions\":[],\"pitfalls\":[]}}}}\n\
             Rules:\n\
             - memories: generalizable long-term facts only (max {DISTILL_MAX_ITEMS} items): \
             user identity/preferences/habits, key project facts and decisions, lessons from \
             user corrections; no transient content, code minutiae, or secrets.\n\
             - progress: this project's task state from THIS session only: done = completed \
             (each item prefixed with date + task name), todo = next steps, blockers = \
             blockers and risks, decisions = calls made for this task, pitfalls = traps hit \
             along the way.\n\
             - Keep the split clean: progress = in-flight task state; memories = durable \
             facts that still hold in a different session; never write the same content in both.\n\
             Existing memory index follows — do not emit memories duplicating it:\n{existing_head}\n\
             Existing project progress ledger follows — do not emit progress items duplicating it:\n{status_head}"
        )
    } else {
        format!(
            "Distill long-term facts from the session transcript that are worth keeping across \
             sessions. Output exactly a JSON array (max {DISTILL_MAX_ITEMS} items; nothing to \
             record → []), each item shaped like {{\"title\":\"one-line title, max 40 chars\",\
             \"type\":\"user|project|feedback|reference\",\
             \"body\":\"factual body (feedback must include Why and How to apply lines)\"}}. \
             Record only: user identity/preferences/habits, key project facts and decisions, \
             lessons from user corrections. Never record: transient content, code minutiae, \
             secrets. Existing memory index follows — do not emit items duplicating it:\n\
             {existing_head}"
        )
    };
    let raw = match chat_text(deps.model.as_ref(), &system, &transcript) {
        Ok(s) => s,
        Err(_) => return 0, // 提炼是增益路径：模型不可用/空回复 → 放弃
    };
    let payload = parse_distill_payload(&raw);
    let mut saved = 0usize;
    for item in payload.memories.into_iter().take(DISTILL_MAX_ITEMS) {
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
    // D37：进度增量并入台账（仅项目会话；拒绝覆盖/零增量静默跳过不阻塞收口）
    if let (Some(ws), Some(delta)) = (ws, payload.progress.as_ref()) {
        if let Ok(Some((outcome, stats))) = m.merge_status(ws, delta, session_id) {
            emit_memory_saved(deps, session_id, &outcome);
            deps.wal.append(
                session_id,
                "status.merge",
                &format!(
                    "{{\"added\":{},\"completed\":{},\"redacted\":{}}}",
                    stats.added, stats.completed, stats.redacted
                ),
            );
            saved += 1;
        }
    }
    saved
}

/// 会话历史 → 提炼转录：仅 User/Assistant 文本轮（工具摘要信噪低不入），
/// 每轮截 2K 字符；总量超限从头部丢弃（保最近的轮次）——**首条用户消息
/// 永远保留**（D37：任务目标/需求原话通常在首条，进度提炼的任务归属依据）
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
    // 从第二条起丢最旧（首条=任务目标锚点，D37）
    while total > DISTILL_TRANSCRIPT_MAX_CHARS && lines.len() > 1 {
        let dropped = lines.remove(1);
        total -= dropped.chars().count();
    }
    if total > DISTILL_TRANSCRIPT_MAX_CHARS && lines.len() == 1 {
        lines[0] = lines[0]
            .chars()
            .take(DISTILL_TRANSCRIPT_MAX_CHARS)
            .collect();
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

/// W3 输出整体（D37 对象 payload + 旧数组兼容）：
/// - 对象 `{"memories":[...],"progress":{...}}` → 记忆条目 + 进度增量；
/// - 解析不出对象 → 回退旧数组（仅 memories）；
/// - 坏条逐项丢弃（坏一条不弃整批）；memories 中 `type=status` 一律丢弃
///   （台账唯一写入方 = progress → `merge_status`，防止绕过合并护栏）。
struct DistillPayload {
    memories: Vec<DistillItem>,
    progress: Option<bbrt_memory::StatusDelta>,
}

/// 提炼输出解析（对象优先，数组兜底）。
/// 对象判定=剥围栏后**外层即 `{` 开头**——防旧数组输出被劫持（数组元素里的
/// `{}` 不能被误当外层对象，否则 memories 全丢）；对象整串解析失败再退
/// `{…}` 子串（容忍尾随解释文本），仍失败则按旧数组解析。
fn parse_distill_payload(raw: &str) -> DistillPayload {
    let trimmed = raw.trim();
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.strip_suffix("```").unwrap_or(s))
        .unwrap_or(trimmed);
    if body.starts_with('{') {
        // 整串解析失败再截子串（容忍 `{...}` 后尾随解释文本）
        let obj_src: Option<serde_json::Value> = serde_json::from_str(body).ok().or_else(|| {
            body.rfind('}')
                .and_then(|end| serde_json::from_str(&body[..=end]).ok())
        });
        if let Some(serde_json::Value::Object(map)) = obj_src {
            let memories = map
                .get("memories")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(distill_item_of).collect())
                .unwrap_or_default();
            let progress = map
                .get("progress")
                .cloned()
                .and_then(|v| serde_json::from_value::<bbrt_memory::StatusDelta>(v).ok());
            return DistillPayload { memories, progress };
        }
    }
    DistillPayload {
        memories: parse_distill_items(raw),
        progress: None,
    }
}

/// 单条 memory 候选解析（数组/对象两形态共用）；
/// `type=status` 丢弃（D37：台账专用类型不进 memories）
fn distill_item_of(v: &serde_json::Value) -> Option<DistillItem> {
    let title = v.get("title")?.as_str()?.trim().to_string();
    let text = v.get("body")?.as_str()?.trim().to_string();
    let mtype = bbrt_memory::MemoryType::parse(v.get("type")?.as_str()?)?;
    if title.is_empty() || text.is_empty() || mtype == bbrt_memory::MemoryType::Status {
        return None;
    }
    Some(DistillItem {
        title,
        body: text,
        mtype,
    })
}

/// 提炼输出解析（旧数组形态，日常会话/对象解析失败兜底）：剥 ```json 围栏、
/// 截取最外层 [...] 段 → JSON 数组；缺字段/未知类型/空串的条目逐项丢弃
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
    arr.iter().filter_map(distill_item_of).collect()
}

/// 记忆写入/更新 → 协议事件外发（memory.saved + memory.evicted；W1/W2/W3 共用）
fn emit_memory_saved(deps: &LoopDeps, session_id: &str, outcome: &bbrt_memory::SaveOutcome) {
    let type_str = match outcome.saved.r#type {
        bbrt_memory::MemoryType::User => "user",
        bbrt_memory::MemoryType::Project => "project",
        bbrt_memory::MemoryType::Feedback => "feedback",
        bbrt_memory::MemoryType::Reference => "reference",
        bbrt_memory::MemoryType::Status => "status",
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 系统提示基底=身份句（brand::AGENT_NAME 企业白标拼装）+ 行为体；
    /// identity 空串（默认部署）不追加任何尾部内容
    #[test]
    fn system_prompt_base_identity_head() {
        let p = system_prompt_base();
        assert!(
            p.starts_with(&format!(
                "You are the local agent of {}, serving a single user.",
                crate::brand::AGENT_NAME
            )),
            "开头应为品牌身份句: {p}"
        );
        assert!(p.contains("Long-term memory"));
        assert!(
            p.ends_with("the user's latest statement wins."),
            "identity 空时不应有尾部追加"
        );
    }
}
