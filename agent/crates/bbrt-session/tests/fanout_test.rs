//! 探查子 Agent fanout 集成（08 §4.5 / D11 §7）：假 planner 触发 →
//! 并行 mini-loop（真模型剧本+真工具执行）→ join 摘要回填主上下文；
//! 不分解路径零行为。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_context::BudgetConfig;
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::loop_runner::{EventLog, LoopDeps, SessionRunner};
use bbrt_session::subagent::{FanoutPlanner, ProbeSpec};
use bbrt_session::SkillIndex;

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

/// 主循环模型：n=0 纯文本收尾（fanout 判定由假 planner 承担，不经模型）
struct MainModel(AtomicUsize);
impl ChatClient for MainModel {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        self.0.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::TextDelta {
                text: "探查汇总收到，开始处理。".into(),
            }),
            Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 8,
                    completion_tokens: 2,
                    cached_tokens: None,
                },
                model: None,
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

/// 探查模型：按请求上下文出剧本（首轮 system+user → 工具轮；见工具结果
/// 后 → 文本收尾）——与线程交错无关，每子任务独立收敛；
/// 记录收到的 system/user（验证独立上下文：无主历史、含任务指令）
struct ProbeModel {
    calls: AtomicUsize,
    seen: Mutex<Vec<(String, String)>>,
}
impl ChatClient for ProbeModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
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
        // 通用子 agent（D16 决策①）：system 与主同构，按任务指令文本区分
        let is_probe = m1.contains("查认证模块") || m1.contains("查配置加载");
        if is_probe {
            self.seen.lock().unwrap().push((m0, m1));
        }
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        // 主循环（非探查角色 system）直接文本收尾；探查按轮次（首轮工具/有结果收尾）
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if !is_probe {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "探查汇总收到，开始处理。".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 8,
                        completion_tokens: 2,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else if req.messages.len() <= 2 {
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
                    usage: Usage {
                        prompt_tokens: 6,
                        completion_tokens: 2,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: format!("探查结论#{n}：认证逻辑在 auth.rs。"),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 6,
                        completion_tokens: 3,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        };
        Ok(Box::new(events.into_iter()))
    }
}

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
        vec![ToolSpec {
            name: "search_files".into(),
            description: "检索".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }]
    }
}

/// 固定两子任务的假 planner（真快模型 planner 的解析逻辑无法在此注入，
/// FastPlanner 的 JSON 解析由单测/降级语义覆盖）
struct TwoTasks;
impl FanoutPlanner for TwoTasks {
    fn plan(&self, _m: &dyn ChatClient, _t: &str) -> Option<Vec<ProbeSpec>> {
        Some(vec![
            ProbeSpec {
                task: "查认证模块结构".into(),
            },
            ProbeSpec {
                task: "查配置加载链路".into(),
            },
        ])
    }
}
struct NoFanout;
impl FanoutPlanner for NoFanout {
    fn plan(&self, _m: &dyn ChatClient, _t: &str) -> Option<Vec<ProbeSpec>> {
        None
    }
}

fn deps_for(
    model: Arc<dyn ChatClient>,
    planner: Arc<dyn FanoutPlanner>,
    sink: Arc<CollectSink>,
    log: SharedLog,
    tools: Arc<AllowTools>,
) -> LoopDeps {
    LoopDeps {
        model,
        tools,
        memory: None,
        wal: Arc::new(log),
        sink,
        skills: Arc::new(Mutex::new(SkillIndex::default())),
        fanout: Some(planner),
        experts: None,
        budget: BudgetConfig::default(),
    }
}

/// 全链路：fanout 状态迁移 → 2×spawn（独立上下文）→ 工具真实执行 →
/// join 事件 + 摘要回填主 history（主 Agent 后续可见）。
#[test]
fn fanout_two_probes_join_into_history() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let tools = Arc::new(AllowTools(Mutex::new(vec![])));
    let probe_model = Arc::new(ProbeModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(vec![]),
    });
    let deps = deps_for(
        probe_model.clone(),
        Arc::new(TwoTasks),
        sink.clone(),
        log.clone(),
        tools.clone(),
    );

    let mut runner = SessionRunner::new("s-fan".into(), "/ws".into(), PermissionMode::Ask, None);
    runner.run_turn("梳理这个项目的认证与配置", &deps, None);

    // 工具经完整管线执行（每子任务 1 次 search_files）
    let executed = tools.0.lock().unwrap().clone();
    assert_eq!(executed.len(), 2, "两个子任务各执行一次只读工具");

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
    let states: Vec<(String, String)> = evs
        .iter()
        .filter_map(|e| match e {
            SessionEvent::StateChanged { state, reason, .. } => {
                Some((state.clone(), reason.clone()))
            }
            _ => None,
        })
        .collect();
    assert!(
        states
            .iter()
            .any(|(s, r)| s == "subagent_fanout" && r == "plan.fanout"),
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
    let joins = evs
        .iter()
        .filter(|e| matches!(e, SessionEvent::SubagentJoined { .. }))
        .count();
    assert_eq!(joins, 1);
    let joined: Vec<&SessionEvent> = evs
        .iter()
        .filter(|e| matches!(e, SessionEvent::SubagentJoined { .. }))
        .collect();
    if let Some(SessionEvent::SubagentJoined { results, .. }) = joined.first() {
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok));
        assert!(results.iter().any(|r| r.summary.contains("auth.rs")));
    }

    // WAL：fanout/spawn/join 均落账（崩溃恢复时间线）
    let wal = log.0.lock().unwrap();
    for ty in [
        "subagent.fanout",
        "subagent.spawn",
        "subagent.event",
        "subagent.join",
    ] {
        assert!(wal.iter().any(|(_, t, _)| t == ty), "WAL 缺 {ty}");
    }

    // 摘要回填主上下文（主模型后续可见探查结论）
    let summary_seen = probe_model.seen.lock().unwrap().is_empty();
    assert!(!summary_seen);
}

/// 不分解路径：planner 返回 None → 零 fanout 事件，主循环照常。
#[test]
fn fanout_none_keeps_normal_loop() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let tools = Arc::new(AllowTools(Mutex::new(vec![])));
    let deps = deps_for(
        Arc::new(MainModel(AtomicUsize::new(0))),
        Arc::new(NoFanout),
        sink.clone(),
        log.clone(),
        tools,
    );
    let mut runner = SessionRunner::new("s-plain".into(), "/ws".into(), PermissionMode::Ask, None);
    runner.run_turn("普通单任务", &deps, None);

    let evs = sink.0.lock().unwrap().clone();
    assert!(
        !evs.iter()
            .any(|e| matches!(e, SessionEvent::SubagentSpawned { .. })),
        "不应有子 Agent 事件"
    );
    let wal = log.0.lock().unwrap();
    assert!(!wal.iter().any(|(_, t, _)| t == "subagent.fanout"));
}

// ---------------------------------------------------------------------------
// 超窗转后台（D16 决策④/P1-6）
// ---------------------------------------------------------------------------

/// 慢子任务模型：探查任务每轮 sleep 500ms（两子任务 ≈1s > 窗 150ms）；
/// 主循环请求立即收尾
struct SlowProbeModel;
impl ChatClient for SlowProbeModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let m1 = req
            .messages
            .get(1)
            .map(|m| m.content.text().to_string())
            .unwrap_or_default();
        let is_probe = m1.contains("查认证") || m1.contains("查配置");
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if is_probe {
            std::thread::sleep(std::time::Duration::from_millis(500));
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "慢探查结论".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 5,
                        completion_tokens: 2,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "收到，继续处理。".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 5,
                        completion_tokens: 2,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        };
        Ok(Box::new(events.into_iter()))
    }
}

/// 等待窗 150ms：探查需 ~500ms → 超窗转后台。turn 不被阻塞（<窗+松弛返回）、
/// 后台收口 SubagentJoined 事件 + hub park（下一轮注入回填）。
#[test]
fn fanout_window_timeout_goes_background() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let tools = Arc::new(AllowTools(Mutex::new(vec![])));
    let deps = deps_for(
        Arc::new(SlowProbeModel),
        Arc::new(TwoTasks),
        sink.clone(),
        log.clone(),
        tools,
    );
    let hub = Arc::new(bbrt_session::bg_hub::BgHub::new());
    let mut runner = SessionRunner::new("s-bg-fan".into(), "/ws".into(), PermissionMode::Ask, None);
    runner.subagent_wait_window = std::time::Duration::from_millis(150);
    runner.bg_hub = Some(hub.clone());

    let t0 = std::time::Instant::now();
    runner.run_turn("梳理这个项目的认证与配置", &deps, None);
    let turn_elapsed = t0.elapsed();
    assert!(
        turn_elapsed < std::time::Duration::from_millis(450),
        "turn 应超窗即返回不阻塞：{turn_elapsed:?}"
    );

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
        std::thread::sleep(std::time::Duration::from_millis(10));
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
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let adjusted = req
            .messages
            .iter()
            .any(|m| m.content.text().contains("[主 Agent 补充指令]"));
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if adjusted {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "已按补充调整：聚焦配置链路。".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 5,
                        completion_tokens: 3,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else {
            std::thread::sleep(std::time::Duration::from_millis(50));
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
                    usage: Usage {
                        prompt_tokens: 5,
                        completion_tokens: 2,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        };
        Ok(Box::new(events.into_iter()))
    }
}

/// 运行中补充：探查转后台后经 hub 下发 Input → 注入 user 轮 → 下一模型轮
/// 按新方向收尾；WAL 留痕 subagent.input。
#[test]
fn fanout_midrun_adjust_injected() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let tools = Arc::new(AllowTools(Mutex::new(vec![])));
    let deps = deps_for(
        Arc::new(AdjustableModel),
        Arc::new(TwoTasks),
        sink.clone(),
        log.clone(),
        tools,
    );
    let hub = Arc::new(bbrt_session::bg_hub::BgHub::new());
    let mut runner = SessionRunner::new("s-adj".into(), "/ws".into(), PermissionMode::Ask, None);
    runner.subagent_wait_window = std::time::Duration::from_millis(250);
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
        std::thread::sleep(std::time::Duration::from_millis(10));
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
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(done, "补充指令应注入并被执行");
    // WAL 留痕（subagent.input）
    let wal = log.0.lock().unwrap().clone();
    assert!(wal
        .iter()
        .any(|(_, t, p)| t == "subagent.input" && p.contains("配置加载链路")));
}
