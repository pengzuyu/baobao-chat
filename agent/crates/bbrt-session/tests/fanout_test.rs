//! 子 agent 派发集成（08 §4.5 / D11 §7；2026-11-26 起入口=spawn_subagents 通用
//! 工具，类型登记表里目前只有探查）：
//! 主模型首轮以工具调用发起派发 → 并行 mini-loop（真模型剧本+真工具执行）→
//! join 摘要作为工具结果回填主上下文；不派发路径零行为。
//!
//! 2026-11-26 之前探查由「主请求前的一次隐藏模型调用」判定触发（假 planner
//! 注入）；现改由主 Agent 自己判断、显式调用——判定与派发对用户全程可见。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bbrt_aigw::{
    AigwError, ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage,
};
use bbrt_context::BudgetConfig;
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::loop_runner::{EventLog, LoopDeps, SessionRunner};
use bbrt_session::SkillIndex;

type Round = Vec<Result<StreamEvent, AigwError>>;

struct CollectSink(Mutex<Vec<SessionEvent>>);
impl SessionSink for CollectSink {
    fn emit(&self, evt: SessionEvent) {
        self.0.lock().unwrap().push(evt);
    }
}

#[derive(Clone, Default)]
struct SharedLog(Arc<Mutex<Vec<(String, String, String)>>>);
impl EventLog for SharedLog {
    fn append(&self, session_id: &str, type_: &str, payload: &str) {
        self.0
            .lock()
            .unwrap()
            .push((session_id.into(), type_.into(), payload.into()));
    }
}

// ---------------------------------------------------------------------------
// 假件
// ---------------------------------------------------------------------------

struct AllowTools(Mutex<Vec<String>>);
impl ToolExecutor for AllowTools {
    fn check(&self, _m: PermissionMode, _c: &ToolInvocation) -> CheckOutcome {
        CheckOutcome::Allow {
            source: "matrix".into(),
        }
    }
    fn execute(&self, _m: PermissionMode, c: &ToolInvocation) -> ToolOutcome {
        self.0.lock().unwrap().push(c.name.clone());
        ToolOutcome::Ok {
            summary: "命中 3 处".into(),
            truncated: false,
            exit_code: Some(0),
            duration_ms: 1,
        }
    }
    fn record_grant(
        &self,
        _m: PermissionMode,
        _c: &ToolInvocation,
        _s: bbrt_sec::memory::GrantScope,
    ) -> Result<(), String> {
        Ok(())
    }
    fn tool_specs(&self) -> Vec<ToolSpec> {
        // 与真实注册表同形：派发入口在主 Agent 工具面里
        vec![
            ToolSpec {
                name: "search_files".into(),
                description: "检索".into(),
                input_schema: serde_json::json!({"type":"object"}),
            },
            ToolSpec {
                name: "spawn_subagents".into(),
                description: "派发子 agent".into(),
                input_schema: serde_json::json!({"type":"object"}),
            },
        ]
    }
}

fn fresh_tools() -> Arc<AllowTools> {
    Arc::new(AllowTools(Mutex::new(vec![])))
}

fn deps_for(
    model: Arc<dyn ChatClient>,
    tools: Arc<AllowTools>,
    sink: Arc<CollectSink>,
    log: SharedLog,
) -> LoopDeps {
    LoopDeps {
        model,
        tools,
        memory: None,
        wal: Arc::new(log),
        sink,
        skills: Arc::new(Mutex::new(SkillIndex::default())),
        budget: BudgetConfig::default(),
    }
}

fn new_runner(session_id: &str) -> SessionRunner {
    SessionRunner::new(session_id.into(), "/ws".into(), PermissionMode::Ask, None)
}

fn states_of(evs: &[SessionEvent]) -> Vec<(String, String)> {
    evs.iter()
        .filter_map(|e| match e {
            SessionEvent::StateChanged { state, reason, .. } => {
                Some((state.clone(), reason.clone()))
            }
            _ => None,
        })
        .collect()
}

fn tool_result_of(evs: &[SessionEvent]) -> (bool, Option<u32>, String) {
    match evs
        .iter()
        .find(|e| matches!(e, SessionEvent::ToolResult { .. }))
    {
        Some(SessionEvent::ToolResult {
            ok,
            summary,
            blocked_code,
            ..
        }) => (*ok, *blocked_code, summary.clone()),
        _ => panic!("应有工具结果事件: {evs:?}"),
    }
}

// ---------------------------------------------------------------------------
// 剧本
// ---------------------------------------------------------------------------

fn small_usage() -> Usage {
    Usage {
        prompt_tokens: 6,
        completion_tokens: 2,
        cached_tokens: None,
    }
}

/// 主模型一轮：发起探查派发（args=spawn_subagents 的参数）
fn spawn_call_with(args: &str) -> Round {
    vec![
        Ok(StreamEvent::ToolCallBegin {
            index: 0,
            id: "sp-1".into(),
            name: "spawn_subagents".into(),
        }),
        Ok(StreamEvent::ToolCallDelta {
            index: 0,
            args_delta: args.into(),
        }),
        Ok(StreamEvent::Done {
            finish: FinishReason::ToolCalls,
            usage: small_usage(),
            model: None,
        }),
    ]
}

const TWO_TASKS_ARGS: &str = r#"{"tasks":[{"kind":"probe","task":"查认证模块结构"},{"kind":"probe","task":"查配置加载链路"}]}"#;

/// 主模型一轮：纯文本收尾
fn text_round(text: &str) -> Round {
    vec![
        Ok(StreamEvent::TextDelta { text: text.into() }),
        Ok(StreamEvent::Done {
            finish: FinishReason::Stop,
            usage: small_usage(),
            model: None,
        }),
    ]
}

/// 主请求剧本（各假件共用）：尚未见到工具结果→发起派发；见到→文本收尾
fn main_round(req: &ChatRequest, text: &str) -> Round {
    let has_tool_result = req.messages.iter().any(|m| m.role == "tool");
    if has_tool_result {
        text_round(text)
    } else {
        spawn_call_with(TWO_TASKS_ARGS)
    }
}

/// 请求角色判定：探查子 agent 的 user=任务指令（含任务关键词）；主请求的
/// user=用户原话
fn is_probe_req(req: &ChatRequest) -> bool {
    let m1 = req
        .messages
        .get(1)
        .map(|m| m.content.text().to_string())
        .unwrap_or_default();
    m1.contains("查认证模块") || m1.contains("查配置加载")
}

fn texts_of(messages: &[ChatMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|m| m.content.text().to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// 全链路
// ---------------------------------------------------------------------------

/// 主+探查合一的模型：探查按请求上下文出剧本（首轮 system+user → 工具轮；见
/// 工具结果后 → 文本收尾）——与线程交错无关，每子任务独立收敛；记录收到的
/// system/user（验证独立上下文：无主历史、含任务指令）
struct ProbeModel {
    calls: AtomicUsize,
    /// 探查请求的 (system, user)
    seen: Mutex<Vec<(String, String)>>,
    /// 每个请求的 (是否探查, 工具清单)——验证子 agent 工具面剔除 spawn_subagents
    tools_seen: Mutex<Vec<(bool, Vec<String>)>>,
    /// 主请求各轮的消息文本——验证探查结论进了主上下文
    main_seen: Mutex<Vec<Vec<String>>>,
}
impl ChatClient for ProbeModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError> {
        let is_probe = is_probe_req(req);
        self.tools_seen
            .lock()
            .unwrap()
            .push((is_probe, req.tools.iter().map(|t| t.name.clone()).collect()));
        if !is_probe {
            self.main_seen.lock().unwrap().push(texts_of(&req.messages));
            return Ok(Box::new(
                main_round(req, "探查汇总收到，开始处理。").into_iter(),
            ));
        }
        let m0 = req
            .messages
            .first()
            .map(|m| m.content.text().to_string())
            .unwrap_or_default();
        let m1 = req
            .messages
            .get(1)
            .map(|m| m.content.text().to_string())
            .unwrap_or_default();
        self.seen.lock().unwrap().push((m0, m1));
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let round: Round = if req.messages.len() <= 2 {
            vec![
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: format!("pc-{n}"),
                    name: "search_files".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "{\"pattern\":\"auth\"}".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: small_usage(),
                    model: None,
                }),
            ]
        } else {
            text_round(&format!("探查结论#{n}：认证逻辑在 auth.rs。"))
        };
        Ok(Box::new(round.into_iter()))
    }
}

/// 全链路：主模型调 spawn_subagents → fanout 状态迁移 → 2×spawn（独立上下文）→
/// 工具真实执行 → join 事件 + 摘要作为工具结果回填主 history。
#[test]
fn spawn_subagents_runs_two_probes_and_returns_digest() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let tools = fresh_tools();
    let probe_model = Arc::new(ProbeModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(vec![]),
        tools_seen: Mutex::new(vec![]),
        main_seen: Mutex::new(vec![]),
    });
    let deps = deps_for(
        probe_model.clone(),
        tools.clone(),
        sink.clone(),
        log.clone(),
    );

    let mut runner = new_runner("s-fan");
    runner.run_turn("梳理这个项目的认证与配置", &deps, None);

    // 工具经完整管线执行（每子任务 1 次 search_files）
    let executed = tools.0.lock().unwrap().clone();
    assert_eq!(
        executed.len(),
        2,
        "两个子任务各执行一次只读工具: {executed:?}"
    );

    // 独立上下文：system=与主同构（含主 prompt + [技能]/[项目]/[记忆] 段）、
    // user=任务指令、无主历史（D16 决策①：通用子 agent＝主的分身）
    let seen = probe_model.seen.lock().unwrap().clone();
    assert!(seen.len() >= 4, "2 子任务 × ≥2 轮");
    assert!(seen
        .iter()
        .all(|(s, _)| s.contains("local agent of BaobaoChat")));
    assert!(seen
        .iter()
        .all(|(s, _)| s.contains("[Project]") && s.contains("/ws")));
    assert!(seen.iter().any(|(_, u)| u.contains("认证模块")));
    assert!(seen.iter().any(|(_, u)| u.contains("配置加载")));

    // 事件序列：fanout 状态 → spawn×2 → done×2 → join → 回 running
    let evs = sink.0.lock().unwrap().clone();
    let states = states_of(&evs);
    assert!(
        states
            .iter()
            .any(|(s, r)| s == "subagent_fanout" && r == "subagent.fanout"),
        "应进入 fanout 态: {states:?}"
    );
    assert!(states
        .iter()
        .any(|(s, r)| s == "running" && r == "subagent.join"));
    let spawns = evs
        .iter()
        .filter(|e| matches!(e, SessionEvent::SubagentSpawned { .. }))
        .count();
    assert_eq!(spawns, 2);
    let joined: Vec<&SessionEvent> = evs
        .iter()
        .filter(|e| matches!(e, SessionEvent::SubagentJoined { .. }))
        .collect();
    assert_eq!(joined.len(), 1);
    if let Some(SessionEvent::SubagentJoined { results, .. }) = joined.first() {
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok));
        assert!(results.iter().any(|r| r.summary.contains("auth.rs")));
    }

    // 派发以一次工具调用发起、结论作为工具结果回给模型（用户在工具卡上可见）
    let tool_calls: Vec<String> = evs
        .iter()
        .filter_map(|e| match e {
            SessionEvent::ToolCall { tool, .. } => Some(tool.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(tool_calls, vec!["spawn_subagents".to_string()]);
    let (ok, blocked_code, summary) = tool_result_of(&evs);
    assert!(ok);
    assert!(blocked_code.is_none());
    assert!(
        summary.contains("并行子任务结果") && summary.contains("auth.rs"),
        "{summary}"
    );

    // WAL：fanout（带发起调用的 call_id）/spawn/join 均落账（崩溃恢复时间线）
    let wal = log.0.lock().unwrap();
    for ty in [
        "subagent.fanout",
        "subagent.spawn",
        "subagent.event",
        "subagent.join",
    ] {
        assert!(wal.iter().any(|(_, t, _)| t == ty), "WAL 缺 {ty}");
    }
    assert!(wal
        .iter()
        .any(|(_, t, p)| t == "subagent.fanout" && p.contains("sp-1") && p.contains("\"probe\"")));
    drop(wal);

    // 主模型第二轮看得到探查结论（工具结果进了主上下文）：两轮=发起派发+见结果收尾
    let main_seen = probe_model.main_seen.lock().unwrap().clone();
    assert_eq!(main_seen.len(), 2, "主请求两轮: {main_seen:?}");
    assert!(
        main_seen[1].iter().any(|m| m.contains("auth.rs")),
        "探查结论应进主上下文: {:?}",
        main_seen[1]
    );

    // 工具面：主请求含 spawn_subagents；探查子 agent 不含（防嵌套派发）
    let tools_seen = probe_model.tools_seen.lock().unwrap().clone();
    assert!(tools_seen
        .iter()
        .filter(|(p, _)| !p)
        .all(|(_, names)| names.iter().any(|n| n == "spawn_subagents")));
    assert!(tools_seen
        .iter()
        .filter(|(p, _)| *p)
        .all(|(_, names)| !names.iter().any(|n| n == "spawn_subagents")));
}

/// 主模型不调派发工具：一条消息只有一次模型请求（主请求之前没有任何隐藏的
/// 前置模型调用——2026-11-26 之前每条消息先跑一次判定，首字平白多等一次
/// 完整往返），零子 Agent 事件。
#[test]
fn no_spawn_call_means_single_model_request() {
    struct CountingModel(AtomicUsize);
    impl ChatClient for CountingModel {
        fn chat(
            &self,
            _req: &ChatRequest,
        ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError>
        {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(text_round("普通单任务，直接处理。").into_iter()))
        }
    }
    let model = Arc::new(CountingModel(AtomicUsize::new(0)));
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let deps = deps_for(model.clone(), fresh_tools(), sink.clone(), log.clone());
    let mut runner = new_runner("s-plain");
    runner.run_turn("普通单任务", &deps, None);

    assert_eq!(
        model.0.load(Ordering::SeqCst),
        1,
        "一条消息只应有一次模型请求"
    );
    let evs = sink.0.lock().unwrap().clone();
    assert!(
        !evs.iter()
            .any(|e| matches!(e, SessionEvent::SubagentSpawned { .. })),
        "不应有子 Agent 事件"
    );
    assert!(
        states_of(&evs).iter().all(|(s, _)| s != "subagent_fanout"),
        "不应进入 fanout 态"
    );
    assert!(!log
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|(_, t, _)| t == "subagent.fanout"));
}

// ---------------------------------------------------------------------------
// 超窗转后台（D16 决策④/P1-6）
// ---------------------------------------------------------------------------

/// 慢子任务模型：探查任务每轮 sleep 500ms（两子任务 ≈1s > 窗 150ms）；
/// 主请求按通用剧本
struct SlowProbeModel;
impl ChatClient for SlowProbeModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError> {
        let round: Round = if is_probe_req(req) {
            std::thread::sleep(Duration::from_millis(500));
            text_round("慢探查结论")
        } else {
            main_round(req, "收到，继续处理。")
        };
        Ok(Box::new(round.into_iter()))
    }
}

/// 等待窗 150ms：探查需 ~500ms → 超窗转后台。turn 不被阻塞（<窗+松弛返回）、
/// 工具结果告知仍在跑的 run id、后台收口 SubagentJoined 事件 + hub park
/// （下一轮注入回填）。
#[test]
fn spawn_subagents_window_timeout_goes_background() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let deps = deps_for(
        Arc::new(SlowProbeModel),
        fresh_tools(),
        sink.clone(),
        log.clone(),
    );
    let hub = Arc::new(bbrt_session::bg_hub::BgHub::new());
    let mut runner = new_runner("s-bg-fan");
    runner.subagent_wait_window = Duration::from_millis(150);
    runner.bg_hub = Some(hub.clone());

    let t0 = Instant::now();
    let report = runner.run_turn("梳理这个项目的认证与配置", &deps, None);
    let turn_elapsed = t0.elapsed();
    assert_eq!(report.steps, 2, "发起派发 + 见结果收尾");
    assert!(
        turn_elapsed < Duration::from_millis(450),
        "turn 应超窗即返回不阻塞：{turn_elapsed:?}"
    );

    // 工具结果=转后台说明 + 仍在跑的 run id（主 Agent 可经 task.wait 主动等）
    let evs = sink.0.lock().unwrap().clone();
    let spawned_ids: Vec<String> = evs
        .iter()
        .filter_map(|e| match e {
            SessionEvent::SubagentSpawned { sub_id, .. } => Some(sub_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(spawned_ids.len(), 2);
    let (ok, blocked_code, summary) = tool_result_of(&evs);
    assert!(ok);
    assert!(blocked_code.is_none());
    assert!(summary.contains("子任务转后台"), "{summary}");
    assert!(
        spawned_ids.iter().all(|id| summary.contains(id)),
        "转后台结果应列出仍在跑的 run id：{summary}"
    );
    assert!(states_of(&evs)
        .iter()
        .any(|(s, r)| s == "running" && r == "subagent.backgrounded"));

    // 后台收口：SubagentJoined 事件 + hub park（≤5s）
    let mut joined = false;
    for _ in 0..500 {
        if sink
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, SessionEvent::SubagentJoined { .. }))
        {
            joined = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(joined, "后台收口应发出 subagent.join 事件");
    let joins = hub.drain_joins("s-bg-fan");
    assert_eq!(joins.len(), 1, "超窗产物应 park 一条");
    assert_eq!(joins[0].name, "subagent.join");
    assert!(joins[0].summary.contains("慢探查结论"));

    // 注入回填（manager 级 drain→inject 同款调用面）
    runner.inject_bg_join("fanout-2", &joins[0].name, &joins[0].summary);
}

// ---------------------------------------------------------------------------
// 运行中补充机制（D16 决策⑧）
// ---------------------------------------------------------------------------

/// 可调子任务模型：未见补充指令→每轮 sleep 50ms+工具调用（保活）；
/// 见 "[主 Agent 补充指令]" → 按新方向收尾
struct AdjustableModel;
impl ChatClient for AdjustableModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError> {
        if !is_probe_req(req) {
            return Ok(Box::new(main_round(req, "收到，继续处理。").into_iter()));
        }
        let adjusted = req
            .messages
            .iter()
            .any(|m| m.content.text().contains("[主 Agent 补充指令]"));
        let round: Round = if adjusted {
            text_round("已按补充调整：聚焦配置链路。")
        } else {
            std::thread::sleep(Duration::from_millis(50));
            vec![
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "adj-1".into(),
                    name: "search_files".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "{}".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: small_usage(),
                    model: None,
                }),
            ]
        };
        Ok(Box::new(round.into_iter()))
    }
}

/// 运行中补充：探查转后台后经 hub 下发 Input → 注入 user 轮 → 下一模型轮
/// 按新方向收尾；WAL 留痕 subagent.input。
#[test]
fn spawned_probes_midrun_adjust_injected() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let deps = deps_for(
        Arc::new(AdjustableModel),
        fresh_tools(),
        sink.clone(),
        log.clone(),
    );
    let hub = Arc::new(bbrt_session::bg_hub::BgHub::new());
    let mut runner = new_runner("s-adj");
    runner.subagent_wait_window = Duration::from_millis(250);
    runner.bg_hub = Some(hub.clone());
    runner.run_turn("梳理认证与配置", &deps, None);

    // 从 spawn 事件拿 run_id（探查注册于 spawn 前——路由即达）
    let mut run_id = String::new();
    for _ in 0..200 {
        let evs = sink.0.lock().unwrap().clone();
        if let Some(SessionEvent::SubagentSpawned { sub_id, .. }) = evs
            .iter()
            .find(|e| matches!(e, SessionEvent::SubagentSpawned { .. }))
        {
            run_id = sub_id.clone();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!run_id.is_empty(), "应捕获 spawn 事件");

    // 运行中补充：经 hub 定向下发（主 Agent subagent.adjust 同通道）
    assert!(hub.route(
        &run_id,
        &bbrt_session::loop_runner::BgHostMsg::Input {
            text: "只聚焦配置加载链路，忽略认证".into(),
        }
    ));

    // 下一模型轮按新方向收尾
    let mut done = false;
    for _ in 0..600 {
        let evs = sink.0.lock().unwrap().clone();
        if evs.iter().any(|e| {
            matches!(e, SessionEvent::SubagentProbeEvt { phase, summary, .. }
                if phase == "done" && summary.as_deref().is_some_and(|s| s.contains("已按补充调整")))
        }) {
            done = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(done, "补充指令应注入并被执行");
    // WAL 留痕（subagent.input）
    let wal = log.0.lock().unwrap().clone();
    assert!(wal
        .iter()
        .any(|(_, t, p)| t == "subagent.input" && p.contains("配置加载链路")));
}

// ---------------------------------------------------------------------------
// 停止与参数校验
// ---------------------------------------------------------------------------

/// 卡住的子任务：探查每轮 sleep 5s；主请求按通用剧本
struct StuckProbeModel;
impl ChatClient for StuckProbeModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError> {
        let round: Round = if is_probe_req(req) {
            std::thread::sleep(Duration::from_secs(5));
            text_round("迟到结论")
        } else {
            main_round(req, "收到。")
        };
        Ok(Box::new(round.into_iter()))
    }
}

/// 等待中用户「停止」：子任务很慢（每轮 5s）、等待窗 10s——置中断旗后 turn
/// 应在一个等待片内返回，不干等子任务自己收尾；工具结果=被阻止。
#[test]
fn spawn_subagents_wait_returns_promptly_on_interrupt() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let deps = deps_for(
        Arc::new(StuckProbeModel),
        fresh_tools(),
        sink.clone(),
        log.clone(),
    );
    let mut runner = new_runner("s-stop");
    runner.subagent_wait_window = Duration::from_secs(10);
    // 未装配中枢：子任务收不到取消、仍会睡满——turn 不得等它
    runner.bg_hub = None;
    let flag = Arc::clone(&runner.interrupted);
    std::thread::spawn(move || {
        // 探查首轮睡 5s：此刻必在等待窗内
        std::thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::SeqCst);
    });

    let t0 = Instant::now();
    let report = runner.run_turn("梳理这个项目的认证与配置", &deps, None);
    let elapsed = t0.elapsed();
    assert!(report.interrupted, "应按中断收口");
    assert!(
        elapsed < Duration::from_millis(1500),
        "停止后应及时返回，不等子任务：{elapsed:?}"
    );
    let evs = sink.0.lock().unwrap().clone();
    let (ok, blocked_code, summary) = tool_result_of(&evs);
    assert!(!ok);
    assert_eq!(blocked_code, Some(8002));
    assert!(summary.contains("子任务被中断"), "{summary}");
    // 状态收口 idle（可继续追问）；探查期间进过的 fanout 态已迁回
    let states = states_of(&evs);
    assert_eq!(
        states.last(),
        Some(&("idle".to_string(), "user-interrupt".to_string())),
        "{states:?}"
    );
    // 未采纳任何结论：没有 join 事件
    assert!(!evs
        .iter()
        .any(|e| matches!(e, SessionEvent::SubagentJoined { .. })));
}

/// 参数校验（不静默丢弃，逐条明说，模型能纠正）：空任务表、未知类型、缺 kind
/// 三种非法形态 → 工具被阻止（8002），不派发、不进 fanout 态。
#[test]
fn spawn_subagents_rejects_bad_tasks() {
    struct BadArgsModel(&'static str);
    impl ChatClient for BadArgsModel {
        fn chat(
            &self,
            req: &ChatRequest,
        ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError>
        {
            let round = if req.messages.iter().any(|m| m.role == "tool") {
                text_round("好的，我自己处理。")
            } else {
                spawn_call_with(self.0)
            };
            Ok(Box::new(round.into_iter()))
        }
    }
    for (args, expect) in [
        (r#"{"tasks":[]}"#, "tasks"),
        (
            r#"{"tasks":[{"kind":"reviewer","task":"把整个项目再审一遍"}]}"#,
            "未知子 agent 类型",
        ),
        (r#"{"tasks":[{"task":"查认证模块结构"}]}"#, "kind"),
    ] {
        let sink = Arc::new(CollectSink(Mutex::new(vec![])));
        let log = SharedLog::default();
        let deps = deps_for(
            Arc::new(BadArgsModel(args)),
            fresh_tools(),
            sink.clone(),
            log.clone(),
        );
        let mut runner = new_runner("s-bad-args");
        let report = runner.run_turn("看看这个项目", &deps, None);
        assert_eq!(report.steps, 2, "被阻止后模型见结果收尾：{args}");

        let evs = sink.0.lock().unwrap().clone();
        assert!(
            !evs.iter()
                .any(|e| matches!(e, SessionEvent::SubagentSpawned { .. })),
            "非法参数不应派发：{args}"
        );
        assert!(
            states_of(&evs).iter().all(|(s, _)| s != "subagent_fanout"),
            "非法参数不应进 fanout 态：{args}"
        );
        let (ok, blocked_code, summary) = tool_result_of(&evs);
        assert!(!ok, "{args}");
        assert_eq!(blocked_code, Some(8002), "{args}");
        assert!(summary.contains(expect), "{args} → {summary}");
        // 未知类型：把可用类型列出来，模型据此纠正
        if expect == "未知子 agent 类型" {
            assert!(summary.contains("probe"), "应列出可用类型：{summary}");
        }
        assert!(
            !log.0
                .lock()
                .unwrap()
                .iter()
                .any(|(_, t, _)| t == "subagent.fanout"),
            "{args}"
        );
    }
}
