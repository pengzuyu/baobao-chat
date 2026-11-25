//! 核心循环测试：假模型 + 假工具 + 收集 sink 全链路验证（08 §4.1 / D11 §6）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bbrt_aigw::{
    ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg, ToolSpec, Usage,
};
use bbrt_context::{BudgetConfig, Round, Summarizer};
use bbrt_memory::MemoryEngine;
use bbrt_sec::gate::PermissionMode;
use bbrt_sec::memory::GrantScope;

use bbrt_session::events::{ModelTier, SessionEvent, SessionSink};
use bbrt_session::executor::{
    CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome, ToolPreview,
};
use bbrt_session::loop_runner::{
    ClarifyAnswer, EventLog, LoopDeps, NoopEventLog, PermissionDecision, PermissionResponse, Scene,
    SessionRunner, MAX_STEPS,
};
use bbrt_session::manager::{SessionManager, StartParams};

/// 收集 sink
#[derive(Default)]
struct CollectSink(Mutex<Vec<SessionEvent>>);
impl SessionSink for CollectSink {
    fn emit(&self, evt: SessionEvent) {
        self.0.lock().unwrap().push(evt);
    }
}
fn events_of(sink: &CollectSink) -> Vec<SessionEvent> {
    sink.0.lock().unwrap().clone()
}

/// 假模型：按调用次数出剧本（0=工具调用轮，其余=纯文本收尾）
struct FakeModel {
    calls: AtomicUsize,
    tool_name: Option<String>,
}
impl ChatClient for FakeModel {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> =
            if n == 0 && self.tool_name.is_some() {
                vec![
                    Ok(StreamEvent::TextDelta {
                        text: "我先看一下文件。".into(),
                    }),
                    Ok(StreamEvent::ToolCallBegin {
                        index: 0,
                        id: "call-1".into(),
                        name: self.tool_name.clone().unwrap(),
                    }),
                    Ok(StreamEvent::ToolCallDelta {
                        index: 0,
                        args_delta: "{\"path\":\"foo.txt\"}".into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::ToolCalls,
                        usage: Usage {
                            prompt_tokens: 100,
                            completion_tokens: 20,
                            cached_tokens: None,
                        },
                        model: None,
                    }),
                ]
            } else {
                vec![
                    Ok(StreamEvent::TextDelta {
                        text: "完成了。".into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::Stop,
                        usage: Usage {
                            prompt_tokens: 120,
                            completion_tokens: 8,
                            cached_tokens: None,
                        },
                        model: None,
                    }),
                ]
            };
        Ok(Box::new(events.into_iter()))
    }
}

/// 假工具执行器：check 行为可脚本化
struct FakeTools {
    confirm: bool,
    executed: Mutex<Vec<String>>,
    fail: bool,
}
impl ToolExecutor for FakeTools {
    fn check(&self, _mode: PermissionMode, call: &ToolInvocation) -> CheckOutcome {
        if self.confirm {
            CheckOutcome::NeedConfirm {
                reason: "任意命令需确认".into(),
                preview: ToolPreview {
                    kind: "command".into(),
                    content: format!("cat {}", call.args_json),
                },
                options: vec!["once".into(), "session".into(), "permanent".into()],
            }
        } else {
            CheckOutcome::Allow {
                source: "matrix".into(),
            }
        }
    }
    fn execute(&self, _mode: PermissionMode, call: &ToolInvocation) -> ToolOutcome {
        self.executed.lock().unwrap().push(call.name.clone());
        if self.fail {
            ToolOutcome::Blocked {
                code: 8021,
                summary: "危险命令".into(),
            }
        } else {
            ToolOutcome::Ok {
                summary: "文件内容：hello".into(),
                truncated: false,
                exit_code: Some(0),
                duration_ms: 12,
            }
        }
    }
    fn record_grant(
        &self,
        _m: PermissionMode,
        _c: &ToolInvocation,
        _s: GrantScope,
    ) -> Result<(), String> {
        Ok(())
    }
    fn tool_specs(&self) -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: "read_file".into(),
                description: "读文件".into(),
                input_schema: serde_json::json!({"type":"object"}),
            },
            // D35：无人值守工具面过滤断言用（ask_user 无执行体，主循环按名拦截）
            ToolSpec {
                name: "ask_user".into(),
                description: "提问".into(),
                input_schema: serde_json::json!({"type":"object"}),
            },
        ]
    }
}

fn deps<M: bbrt_aigw::ChatClient + 'static>(
    model: Arc<M>,
    tools: Arc<FakeTools>,
    sink: Arc<CollectSink>,
    memory: Option<Arc<MemoryEngine>>,
) -> LoopDeps {
    LoopDeps {
        model,
        tools,
        memory,
        wal: Arc::new(NoopEventLog),
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    }
}

fn test_memory(dir: &std::path::Path) -> Arc<MemoryEngine> {
    Arc::new(MemoryEngine::open(dir, Arc::new(bbrt_memory::SystemClock)).unwrap())
}

#[test]
fn happy_path_tool_call_then_answer() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("read_file".into()),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model.clone(), tools.clone(), sink.clone(), None);

    let mut runner = SessionRunner::new(
        "s-1".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("读一下 foo.txt", &d, None);

    assert_eq!(report.steps, 2); // 工具轮 + 收尾轮
    assert_eq!(report.tool_calls, 1);
    assert!(!report.paused);
    assert_eq!(
        *tools.executed.lock().unwrap(),
        vec!["read_file".to_string()]
    );
    let evs = events_of(sink.as_ref());
    // 事件顺序关键断言：StateChanged(running) → StreamDelta → ToolCall → ToolResult → StreamDone → StateChanged(idle)
    let kinds: Vec<String> = evs.iter().map(kind_of).collect();
    assert!(kinds.contains(&"tool_call".into()));
    assert!(kinds.contains(&"tool_result".into()));
    let idx = |k: &str| kinds.iter().position(|x| x == k).unwrap();
    // stream.done 每轮模型各一次（工具轮的 done 先于 tool.call）——只保证工具序与轮数
    assert!(idx("tool_call") < idx("tool_result"));
    assert_eq!(kinds.iter().filter(|k| *k == "stream_done").count(), 2);
    // 结尾 idle
    assert!(
        matches!(evs.last(), Some(SessionEvent::StateChanged { state, .. }) if state == "idle")
    );
    // 两次模型调用
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
}

fn kind_of(e: &SessionEvent) -> String {
    serde_json::to_value(e)
        .ok()
        .and_then(|v| v.get("type").cloned())
        .and_then(|t| t.as_str().map(String::from))
        .unwrap_or_default()
}

#[test]
fn permission_allow_executes_and_denies_blocks() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("run_command".into()),
    });
    let tools = Arc::new(FakeTools {
        confirm: true,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools.clone(), sink.clone(), None);

    let mut runner = SessionRunner::new(
        "s-2".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let tx = runner.permission_sender();
    // 后台线程扮演宿主：收到请求即允许
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        let _ = tx2.send(PermissionResponse {
            request_id: "pr-call-1".into(),
            decision: PermissionDecision::Allow,
            scope: GrantScope::Session,
            edited: Some("{\"cmd\":\"echo hi\"}".into()),
        });
    });
    let report = runner.run_turn("跑个命令", &d, None);
    assert_eq!(report.tool_calls, 1);
    assert_eq!(
        *tools.executed.lock().unwrap(),
        vec!["run_command".to_string()]
    );
    let evs = events_of(sink.as_ref());
    assert!(evs.iter().any(
        |e| matches!(e, SessionEvent::PermissionRequest { tool, .. } if tool == "run_command")
    ));
    assert!(evs.iter().any(
        |e| matches!(e, SessionEvent::PermissionResolved { decision, .. } if decision == "allow")
    ));

    // 拒绝路径：重跑一单，宿主回 deny
    let sink2 = Arc::new(CollectSink::default());
    let model2 = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("run_command".into()),
    });
    let tools2 = Arc::new(FakeTools {
        confirm: true,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d2 = deps(model2, tools2.clone(), sink2, None);
    let mut r2 = SessionRunner::new(
        "s-2b".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let tx = r2.permission_sender();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        let _ = tx.send(PermissionResponse {
            request_id: "pr-call-1".into(),
            decision: PermissionDecision::Deny,
            scope: GrantScope::Once,
            edited: None,
        });
    });
    let rep2 = r2.run_turn("再跑一个", &d2, None);
    assert_eq!(tools2.executed.lock().unwrap().len(), 0, "拒绝后不执行");
    assert_eq!(rep2.tool_calls, 1);
}

/// D20 假模型：0=ask_user 工具调用轮（args 可脚本化，缺省合法提问），其余=纯文本收尾
struct FakeClarifyModel {
    calls: AtomicUsize,
    ask_args: String,
}
impl ChatClient for FakeClarifyModel {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "我先问一下用户。".into(),
                }),
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "call-1".into(),
                    name: "ask_user".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: self.ask_args.clone(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: Usage {
                        prompt_tokens: 100,
                        completion_tokens: 20,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "按你的选择继续。".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 120,
                        completion_tokens: 8,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        };
        Ok(Box::new(events.into_iter()))
    }
}

const GOOD_ASK_ARGS: &str = r#"{"question":"用哪种方式修复？","header":"修复方式","options":[{"label":"方案A","description":"保守"},{"label":"方案B","description":"激进"}],"multi_select":false}"#;

#[test]
fn clarify_answered_continues_turn() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeClarifyModel {
        calls: AtomicUsize::new(0),
        ask_args: GOOD_ASK_ARGS.into(),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools.clone(), sink.clone(), None);
    let mut runner = SessionRunner::new(
        "s-cl1".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let tx = runner.clarify_sender();
    // 后台扮演宿主：300ms 后回答「方案A」+自由补充
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let _ = tx.send(ClarifyAnswer {
            question_id: "q-call-1".into(),
            answers: vec!["方案A".into()],
            free_text: Some("注意兼容旧配置".into()),
        });
    });
    let report = runner.run_turn("修一下", &d, None);
    assert_eq!(report.tool_calls, 1);
    assert_eq!(
        tools.executed.lock().unwrap().len(),
        0,
        "ask_user 不走 pipeline"
    );
    let evs = events_of(sink.as_ref());
    assert!(evs.iter().any(|e| matches!(
        e,
        SessionEvent::ClarifyRequest { question, multi_select, .. }
            if question == "用哪种方式修复？" && !*multi_select
    )));
    assert!(evs.iter().any(|e| matches!(
        e,
        SessionEvent::ClarifyResolved { decision, answers, .. }
            if decision == "answered" && answers.contains("方案A") && answers.contains("兼容旧配置")
    )));
    // 回答作为工具结果回给模型（下一轮模型可见）
    assert!(evs.iter().any(|e| matches!(
        e,
        SessionEvent::ToolResult { summary, .. } if summary.contains("方案A")
    )));
}

#[test]
fn clarify_interrupt_cancels() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeClarifyModel {
        calls: AtomicUsize::new(0),
        ask_args: GOOD_ASK_ARGS.into(),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools.clone(), sink.clone(), None);
    let mut runner = SessionRunner::new(
        "s-cl2".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    // 后台 300ms 后置中断旗标（提问等待 1s 轮询感知 → cancelled 收口）
    let flag = runner.interrupted.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::SeqCst);
    });
    let report = runner.run_turn("问了又停", &d, None);
    assert!(report.interrupted, "用户中断收口");
    assert!(events_of(sink.as_ref()).iter().any(|e| matches!(
        e,
        SessionEvent::ClarifyResolved { decision, .. } if decision == "cancelled"
    )));
}

#[test]
fn clarify_bad_args_blocked_no_request() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeClarifyModel {
        calls: AtomicUsize::new(0),
        ask_args: r#"{"question":"缺选项"}"#.into(), // options<2 → 9001
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools.clone(), sink.clone(), None);
    let mut runner = SessionRunner::new(
        "s-cl3".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("坏参数", &d, None);
    assert_eq!(report.tool_calls, 1);
    let evs = events_of(sink.as_ref());
    assert!(
        !evs.iter()
            .any(|e| matches!(e, SessionEvent::ClarifyRequest { .. })),
        "参数非法不发提问卡"
    );
    assert!(evs.iter().any(|e| matches!(
        e,
        SessionEvent::ToolResult {
            blocked_code: Some(9001),
            ..
        }
    )));
}

/// 审批不超时（2026-11-25 拍板：审批不会发生过期，超时=拒绝机制整链退役）：
/// 无人应答期间不产生任何 resolved 事件（含 timeout）、不执行工具；应答
/// 迟到也照常放行——等待由用户 allow/deny/中断收口
#[test]
fn permission_waits_indefinitely_until_response() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("run_command".into()),
    });
    let tools = Arc::new(FakeTools {
        confirm: true,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools.clone(), sink.clone(), None);
    let mut runner = SessionRunner::new(
        "s-3".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let tx = runner.permission_sender();
    let turn = std::thread::spawn(move || runner.run_turn("无人应答", &d, None));
    // 等审批卡出现（=已进入等待）
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::PermissionRequest { .. }))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "3s 内未出现审批卡，turn 未进入等待"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // 冷置 300ms（远超旧 100ms 超时窗）：不自动拒绝、不执行
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !events_of(sink.as_ref())
            .iter()
            .any(|e| matches!(e, SessionEvent::PermissionResolved { .. })),
        "无人应答期间不得产生任何审批收口事件（超时机制已退役）"
    );
    assert_eq!(tools.executed.lock().unwrap().len(), 0);
    // 迟到的应答照常放行
    let _ = tx.send(PermissionResponse {
        request_id: "pr-call-1".into(),
        decision: PermissionDecision::Allow,
        scope: GrantScope::Once,
        edited: None,
    });
    let report = turn.join().unwrap();
    assert_eq!(report.tool_calls, 1);
    assert_eq!(
        *tools.executed.lock().unwrap(),
        vec!["run_command".to_string()]
    );
    assert!(events_of(sink.as_ref()).iter().any(
        |e| matches!(e, SessionEvent::PermissionResolved { decision, .. } if decision == "allow")
    ));
}

/// 回合进行中（runner 被 turn 线程取走、阻塞在等审批）interrupt() 仍能置旗：
/// 旧实现对 entry.runner（None）置旗被静默跳过=点停止全链路回执成功却无效果；
/// 修复后经 ManagedSession.interrupt_flag 穿透取走窗口，等审批 1s 轮询感知
/// → PermissionResolved(cancelled) 收口 interrupted
#[test]
fn interrupt_flags_through_taken_runner_while_waiting_permission() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("run_command".into()),
    });
    let tools = Arc::new(FakeTools {
        confirm: true, // 首工具 NeedConfirm → 阻塞在等审批
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let mgr = Arc::new(SessionManager::new(
        deps(model, tools.clone(), sink.clone(), None),
        None,
    ));
    mgr.start(
        "s-ir".into(),
        StartParams {
            workspace: "/w".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelTier::Strong,
            model_override: None,
            title: "t".into(),
            restored: None,
            unattended: false,
            scene: Default::default(),
        },
    )
    .unwrap();
    // turn 独立线程：runner 被取走、阻塞在 permission 等待
    let turn_mgr = Arc::clone(&mgr);
    let turn = std::thread::spawn(move || turn_mgr.run_turn("s-ir", "跑个命令", None).unwrap());
    // 等审批卡出现（=runner 已被取走且阻塞在 recv）再中断
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::PermissionRequest { .. }))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "3s 内未出现审批卡，turn 未进入等待"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    mgr.interrupt("s-ir").unwrap(); // 旧实现：runner=None 静默跳过
    let report = turn.join().unwrap();
    assert!(report.interrupted, "回合进行中中断应生效收口");
    assert_eq!(
        tools.executed.lock().unwrap().len(),
        0,
        "中断后不应执行工具"
    );
    assert!(events_of(sink.as_ref()).iter().any(|e| matches!(
        e,
        SessionEvent::PermissionResolved { decision, .. } if decision == "cancelled"
    )));
}

/// 感知模式的假工具：check 记录每次收到的 mode（验证 session.set_mode
/// 中途切档对下一个工具门控即时生效——共享句柄与 runner 读点同一实例）
struct ModeProbeTools {
    seen: Mutex<Vec<PermissionMode>>,
}
impl ToolExecutor for ModeProbeTools {
    fn check(&self, mode: PermissionMode, _call: &ToolInvocation) -> CheckOutcome {
        self.seen.lock().unwrap().push(mode);
        CheckOutcome::Allow {
            source: "matrix".into(),
        }
    }
    fn execute(&self, _mode: PermissionMode, _call: &ToolInvocation) -> ToolOutcome {
        ToolOutcome::Ok {
            summary: "ok".into(),
            truncated: false,
            exit_code: Some(0),
            duration_ms: 1,
        }
    }
    fn record_grant(
        &self,
        _m: PermissionMode,
        _c: &ToolInvocation,
        _s: GrantScope,
    ) -> Result<(), String> {
        Ok(())
    }
    fn tool_specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "run_command".into(),
            description: "跑命令".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }]
    }
}

#[test]
fn set_mode_takes_effect_on_next_tool_gate() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("run_command".into()),
    });
    // 探针句柄共享：一份进 LoopDeps，测试侧留一份读 seen
    let probe = Arc::new(ModeProbeTools {
        seen: Mutex::new(vec![]),
    });
    let d = LoopDeps {
        model,
        tools: probe.clone(),
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mgr = SessionManager::new(d, None);
    mgr.start(
        "s-sm".into(),
        StartParams {
            workspace: "/w".into(),
            mode: PermissionMode::Ask, // 以 Ask 启动
            model_policy: ModelTier::Strong,
            model_override: None,
            title: "t".into(),
            restored: None,
            unattended: false,
            scene: Default::default(),
        },
    )
    .unwrap();
    // 中途切 full-auto（此前协议缺口：runtime 恒按 start 时的模式）
    mgr.set_mode("s-sm", PermissionMode::FullAuto).unwrap();
    let report = mgr.run_turn("s-sm", "跑个命令", None).unwrap();
    assert_eq!(report.tool_calls, 1);
    // 门控收到的模式=切换后的 full-auto（start 时的 Ask 已被覆盖）
    assert_eq!(*probe.seen.lock().unwrap(), vec![PermissionMode::FullAuto]);
}

#[test]
fn memory_heuristic_and_daily_report() {
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: None,
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools, sink.clone(), Some(mem.clone()));

    let mut runner = SessionRunner::new(
        "s-4".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Fast,
        None,
    );
    runner.run_turn("记住：本机服务端口用 8090", &d, None);
    let evs = events_of(sink.as_ref());
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::MemorySaved { title, .. } if title.contains("8090"))));

    runner.end(&d, "测试会话");
    let evs = events_of(sink.as_ref());
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::SessionEnded { .. })));
}

#[test]
fn consecutive_failures_no_circuit_break() {
    // 2026-11-25 熔断退役（用户拍板：不自动杀会话）：模型每轮都要工具、全部
    // Blocked 也不得提前终止——继续跑满步数上限由 MAX_STEPS 收口 paused；
    // 防失控=步数上限+用户中断，不再有连续失败熔断路径
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(AlwaysToolModel);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: true,
    });
    let d = deps(model, tools, sink.clone(), None);
    let mut runner = SessionRunner::new(
        "s-5".into(),
        "/tmp/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("反复失败", &d, None);
    // 旧熔断在第 4 次失败即终止；现在必须远超熔断阈值、由步数上限收口
    assert!(report.tool_calls >= 10, "tool_calls={} 应跑满步数上限而非熔断提前终止", report.tool_calls);
    assert!(report.paused);
    assert!(events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::StateChanged { state, .. } if state == "paused")));
    // 熔断错误不再产生
    assert!(!events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::Error { code, .. } if *code == 8021)));
}

/// 每次调用都返回工具调用（驱动长循环）
struct AlwaysToolModel;
impl ChatClient for AlwaysToolModel {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::ToolCallBegin {
                index: 0,
                id: "c".into(),
                name: "run_command".into(),
            }),
            Ok(StreamEvent::ToolCallDelta {
                index: 0,
                args_delta: "{}".into(),
            }),
            Ok(StreamEvent::Done {
                finish: FinishReason::ToolCalls,
                usage: Usage {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    cached_tokens: None,
                },
                model: None,
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

#[test]
fn wal_records_monotonic_events() {
    struct CountingLog(Mutex<Vec<(String, String)>>);
    impl EventLog for CountingLog {
        fn append(&self, session_id: &str, t: &str, _p: &str) {
            self.0
                .lock()
                .unwrap()
                .push((session_id.to_string(), t.to_string()));
        }
    }
    let log = Arc::new(CountingLog(Mutex::new(vec![])));
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("read_file".into()),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = LoopDeps {
        model,
        tools,
        memory: None,
        wal: log.clone(),
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-6".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    runner.run_turn("记录一下", &d, None);
    let wal = log.0.lock().unwrap();
    assert!(wal.iter().any(|(_, t)| t == "turn.start"));
    assert!(wal.iter().any(|(_, t)| t == "tool.call"));
    assert!(wal.iter().any(|(_, t)| t == "tool.result"));
}

#[test]
fn manager_unlimited_sessions_guard_removed() {
    // 2026-11-24 用户裁决：≤3 活跃名额护栏解除——「会话不死」后名额只进不出
    // （end 无 UI 入口、idle 复活再占位），把「用过」当「活跃中」误伤正常使用；
    // 资源护栏如需恢复按「回合进行中」口径重设。回归：超出旧上限照常可建
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: None,
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let mgr = SessionManager::new(deps(model, tools, sink, None), None);
    for i in 0..4 {
        mgr.start(
            format!("s-{i}"),
            StartParams {
                workspace: "/w".into(),
                mode: PermissionMode::Ask,
                model_policy: ModelTier::Fast,
                model_override: None,
                title: "t".into(),
                restored: None,
                unattended: false,
                scene: Default::default(),
            },
        )
        .unwrap();
    }
    assert_eq!(mgr.active_count(), 4, "旧上限 3 已解除");
    mgr.end("s-1", "done").unwrap();
    assert_eq!(mgr.active_count(), 3);
    mgr.start(
        "s-4".into(),
        StartParams {
            workspace: "/w".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelTier::Fast,
            model_override: None,
            title: "t".into(),
            restored: None,
            unattended: false,
            scene: Default::default(),
        },
    )
    .unwrap();
    assert_eq!(mgr.active_count(), 4);
}

#[test]
fn compaction_triggers_on_long_history() {
    // 长历史逼近预算 → compaction 事件出现且摘要注入
    struct MiniBudget;
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: None,
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let cfg = BudgetConfig { window_tokens: 400 }; // 极小窗口逼出压缩
    let d = LoopDeps {
        model,
        tools,
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: cfg,
    };
    let mut runner = SessionRunner::new(
        "s-7".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    // 预填长历史
    let _ = MiniBudget;
    let long_text = "上下文压力测试内容。".repeat(120);
    let report = runner.run_turn(&long_text, &d, None);
    let evs = events_of(sink.as_ref());
    let compacted = evs
        .iter()
        .any(|e| matches!(e, SessionEvent::Compaction { phase, .. } if phase == "done"));
    // 小窗口下要么压缩成功、要么 8010 错误卡落时间线——两者都算路径可达。
    // 2026-11-11 口径：错误收口 idle（不再 paused 卡死），断言改为错误事件在流内
    let errored_8010 = evs
        .iter()
        .any(|e| matches!(e, SessionEvent::Error { code: 8010, .. }));
    assert!(compacted || errored_8010);
    assert!(!report.paused, "错误不再收口 paused（resume 通道已移除）");
}

/// Summarizer trait 引用确认（编译期契约锚点）
#[test]
fn summarizer_trait_object_compatible() {
    struct S;
    impl Summarizer for S {
        fn summarize(&self, t: &str) -> Result<String, String> {
            Ok(t.to_string())
        }
    }
    let s: &dyn Summarizer = &S;
    assert_eq!(s.summarize("x").unwrap(), "x");
    // Round/ChatMessage 形态锚点
    let _ = Round::User {
        content: String::new(),
    };
    let _ = ChatMessage {
        role: "user".into(),
        content: String::new(),
        tool_calls: vec![ToolCallMsg {
            id: "1".into(),
            name: "n".into(),
            arguments: "{}".into(),
        }],
        tool_call_id: None,
    };
}

#[test]
fn max_steps_guard() {
    // AlwaysTool + 全部成功执行 → 步数达 MAX_STEPS 停
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(AlwaysToolOk);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools, sink, None);
    let mut runner = SessionRunner::new(
        "s-8".into(),
        "/tmp/ws".into(),
        PermissionMode::FullAuto,
        ModelTier::Fast,
        None,
    );
    let report = runner.run_turn("无限工具循环", &d, None);
    assert!(report.steps <= MAX_STEPS);
    assert!(report.paused);
}

struct AlwaysToolOk;
impl ChatClient for AlwaysToolOk {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::ToolCallBegin {
                index: 0,
                id: "c".into(),
                name: "read_file".into(),
            }),
            Ok(StreamEvent::ToolCallDelta {
                index: 0,
                args_delta: "{\"path\":\"a\"}".into(),
            }),
            Ok(StreamEvent::Done {
                finish: FinishReason::ToolCalls,
                usage: Usage {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    cached_tokens: None,
                },
                model: None,
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

// ---------------------------------------------------------------------------
// 记忆双轨接线（D15 §2.2）：W2② 连击教训 / W3 会话结束提炼 / 召回注入
// ---------------------------------------------------------------------------

/// 剧本模型：按调用次数回放预置回复；顺带捕获 system 消息文本（prompt 断言用）
struct ScriptedModel {
    calls: AtomicUsize,
    replies: Vec<String>,
    seen_system: Mutex<Vec<String>>,
}
impl ScriptedModel {
    fn new(replies: Vec<String>) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            replies,
            seen_system: Mutex::new(vec![]),
        })
    }
}
impl ChatClient for ScriptedModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(first) = req.messages.first() {
            self.seen_system.lock().unwrap().push(first.content.clone());
        }
        let text = self
            .replies
            .get(n)
            .cloned()
            .unwrap_or_else(|| "（剧本耗尽）".into());
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::TextDelta { text }),
            Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    cached_tokens: None,
                },
                model: None,
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

#[test]
fn w2_lesson_after_repeated_tool_failures() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(AlwaysToolModel); // 每轮都发起工具调用
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: true, // execute 恒 Blocked(8021 "危险命令")
    });
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    let d = deps(model, tools, sink.clone(), Some(mem.clone()));
    let mut runner = SessionRunner::new(
        "s-w2".into(),
        "/ws".into(),
        PermissionMode::FullAuto,
        ModelTier::Strong,
        None,
    );
    let _ = runner.run_turn("跑一下构建", &d, None);

    // 同工具同错连续 ≥2 次 → feedback 教训自动落盘（带 Why/How to apply）。
    // D19：项目会话（/ws）的 feedback 教训落该项目分区，用户级不再出现
    let ws = std::path::Path::new("/ws");
    let list = mem.list_scoped(Some(ws));
    assert!(
        list.iter().any(
            |e| e.mtype == bbrt_memory::MemoryType::Feedback && e.title.contains("run_command")
        ),
        "应产出 run_command 教训条目，实际: {list:?}"
    );
    assert!(
        mem.knowledge().list().is_empty(),
        "用户级不应混入项目教训（D19 分级）"
    );
    let body = list
        .iter()
        .find(|e| e.title.contains("run_command"))
        .and_then(|e| mem.get_scoped_entry(Some(ws), &e.name))
        .unwrap();
    assert!(body.contains("**Why:**") && body.contains("**How to apply:**"));
    // 协议事件外发
    assert!(events_of(sink.as_ref()).iter().any(
        |e| matches!(e, SessionEvent::MemorySaved { memory_type, .. } if memory_type == "feedback")
    ));
}

#[test]
fn w3_distills_memories_on_session_end() {
    let sink = Arc::new(CollectSink::default());
    let model = ScriptedModel::new(vec![
        "好的，我记住了你的偏好。".into(), // run_turn 对话
        "[{\"title\":\"用户偏好先方案\",\"type\":\"user\",\"body\":\"用户做事前要先出方案再动手。\"}]".into(), // W3 提炼
    ]);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    let d = deps(model.clone(), tools, sink.clone(), Some(mem.clone()));
    let mut runner = SessionRunner::new(
        "s-w3".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let _ = runner.run_turn("以后做事先给我方案再动手", &d, None);
    runner.end(&d, "");

    // D23：user 类提炼条目恒落公共层（画像档，文本=标题：正文首行）
    let list = mem.list_scoped(None);
    assert!(
        list.iter().any(|e| e.title.contains("用户偏好先方案")),
        "W3 应落公共层提炼条目，实际: {list:?}"
    );
    assert!(mem.global().view().contains("[画像] 用户偏好先方案"));
    assert!(events_of(sink.as_ref()).iter().any(
        |e| matches!(e, SessionEvent::MemorySaved { title, .. } if title.contains("用户偏好先方案"))
    ));
    // SessionEnded 正常外发（提炼不阻塞收口）
    assert!(events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::SessionEnded { .. })));
}

/// D37：项目会话 W3 输出对象 payload——记忆与进度一次调用双产出
///（progress 并入台账 status 条目 + memory.saved 回执；memories 照旧落项目分区）
#[test]
fn w3_object_payload_merges_project_progress() {
    let sink = Arc::new(CollectSink::default());
    let model = ScriptedModel::new(vec![
        "批0-4 已推 697707c。".into(), // run_turn 对话
        // W3 提炼：对象 payload（memories + progress 两类）
        "{\"memories\":[{\"title\":\"端口 8090 约定\",\"type\":\"project\",\"body\":\"开发服务走 8090。\"}],\
         \"progress\":{\"done\":[\"11-19 D35：批0-4 已推 697707c\"],\
         \"todo\":[\"D35：真机八项验收\"],\"blockers\":[],\
         \"decisions\":[\"D37：台账仅会话结束自动写\"],\
         \"pitfalls\":[\"改日历要重算 workday next_run\"]}}"
            .into(),
    ]);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let mem = test_memory(tmp.path());
    let d = deps(model, tools, sink.clone(), Some(mem.clone()));
    let mut runner = SessionRunner::new(
        "s-w3p".into(),
        ws.to_string_lossy().into_owned(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let _ = runner.run_turn("D35 定时任务做到哪了", &d, None);
    runner.end(&d, "");

    // 进度台账落盘（status 条目，五段合并）
    let body = mem.status_body(&ws).expect("W3 应产出项目进度台账");
    assert!(body.contains("批0-4 已推 697707c"), "{body}");
    assert!(body.contains("- [ ] D35：真机八项验收"), "{body}");
    assert!(body.contains("台账仅会话结束自动写"), "{body}");
    assert!(body.contains("改日历要重算 workday next_run"), "{body}");
    // memories 照旧落项目分区（project 类随会话目录）
    let list = mem.list_scoped(Some(&ws));
    assert!(
        list.iter().any(|e| e.title.contains("端口 8090 约定")),
        "对象 payload 的 memories 应照常落盘：{list:?}"
    );
    assert!(
        list.iter()
            .any(|e| e.mtype == bbrt_memory::MemoryType::Status),
        "台账条目应在分区列表：{list:?}"
    );
    // 台账回执（memory.saved，type=status）
    assert!(events_of(sink.as_ref()).iter().any(
        |e| matches!(e, SessionEvent::MemorySaved { title, .. } if title.contains("项目进度台账"))
    ));
}

/// D37：日常会话（无 workspace）不产生进度——对象 payload 的 progress 跳过，
/// 且全程不触碰项目分区目录
#[test]
fn w3_progress_skipped_for_daily_sessions() {
    let sink = Arc::new(CollectSink::default());
    let model = ScriptedModel::new(vec![
        "好了。".into(),
        "{\"memories\":[],\"progress\":{\"done\":[\"某进展\"]}}".into(),
    ]);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    let d = deps(model, tools, sink.clone(), Some(mem));
    let mut runner = SessionRunner::new(
        "s-w3d".into(),
        String::new(), // 日常会话
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let _ = runner.run_turn("聊聊", &d, None);
    runner.end(&d, "");
    assert!(
        !tmp.path().join("agent/memory/projects").exists(),
        "日常会话不应创建任何项目分区"
    );
    assert!(events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::SessionEnded { .. })));
}

#[test]
fn w3_distill_swallows_unparseable_output() {
    let sink = Arc::new(CollectSink::default());
    let model = ScriptedModel::new(vec![
        "完成了。".into(),
        "我无法输出结构化内容。".into(), // 非法提炼输出
    ]);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    let d = deps(model, tools, sink.clone(), Some(mem.clone()));
    let mut runner = SessionRunner::new(
        "s-w3b".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let _ = runner.run_turn("帮我看下配置", &d, None);
    runner.end(&d, "");
    // 非法输出 → 静默跳过：无记忆条目、无 MemorySaved，但会话正常收口
    assert!(mem.knowledge().list().is_empty());
    assert!(events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::SessionEnded { .. })));
}

#[test]
fn w3_skipped_when_no_assistant_reply() {
    let sink = Arc::new(CollectSink::default());
    // 剧本只有 W3 位（run_turn 第 0 次就失败场景难构造，直接不跑 turn）
    let model = ScriptedModel::new(vec!["[]".into()]);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    let d = deps(model.clone(), tools, sink, Some(mem));
    let mut runner = SessionRunner::new(
        "s-w3c".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    runner.end(&d, ""); // 未发生任何对话
    assert_eq!(
        model.calls.load(Ordering::SeqCst),
        0,
        "空会话不应调模型提炼"
    );
}

#[test]
fn system_prompt_carries_memory_guidance_and_recall() {
    let sink = Arc::new(CollectSink::default());
    let model = ScriptedModel::new(vec!["好的。".into()]);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    // 预置一条既有记忆：召回注入 + "同题不重复"引导可见
    mem.save_memory(&bbrt_memory::SaveInput {
        title: "端口 8090 约定".into(),
        body: "服务端开发口令走 8090。".into(),
        mtype: bbrt_memory::MemoryType::Project,
        session: "seed".into(),
        links: vec![],
    })
    .unwrap();
    let d = deps(model.clone(), tools, sink, Some(mem));
    let mut runner = SessionRunner::new(
        "s-sys".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let _ = runner.run_turn("8090 端口起服务", &d, None);
    let systems = model.seen_system.lock().unwrap().clone();
    let sys = systems.first().expect("应捕获 system 消息");
    assert!(sys.contains("memory_save"), "W1 工具引导应在 system 提示中");
    assert!(sys.contains("Long-term memory"));
    assert!(sys.contains("[Memory]"));
    assert!(sys.contains("端口 8090 约定"), "记忆索引应注入 system");
}

/// 场景段（2026-11-23 三区块）：runner.scene 决定 SYSTEM_PROMPT 末尾追加哪段；
/// 写法口径=场景定位/上下文来源/工作流指引，无回答风格/格式/用途约定
#[test]
fn scene_notes_appended_by_scene() {
    let mk = || {
        (
            Arc::new(CollectSink::default()),
            ScriptedModel::new(vec!["好的。".into(); 3]),
            Arc::new(FakeTools {
                confirm: false,
                executed: Mutex::new(vec![]),
                fail: false,
            }),
        )
    };
    // ① 项目：以仓库为工作对象 + 台账指引
    {
        let (sink, model, tools) = mk();
        let d = deps(model.clone(), tools, sink, None);
        let mut runner = SessionRunner::new(
            "s-proj".into(),
            "/ws".into(),
            PermissionMode::Ask,
            ModelTier::Strong,
            None,
        );
        runner.scene = Scene::Project;
        let _ = runner.run_turn("看下这个仓库", &d, None);
        let sys = model.seen_system.lock().unwrap()[0].clone();
        assert!(sys.contains("[Scene: Project]"), "项目场景段应追加: {sys}");
        assert!(sys.contains("[Project Progress]"));
        assert!(!sys.contains("[Scene: Chat]"));
    }
    // ② 日常对话：conv_id + 单聊/群聊事实 + im_history 指向（抗压缩常驻）
    {
        let (sink, model, tools) = mk();
        let d = deps(model.clone(), tools, sink, None);
        let mut runner = SessionRunner::new(
            "s-emb".into(),
            String::new(),
            PermissionMode::Ask,
            ModelTier::Strong,
            None,
        );
        runner.scene = Scene::Embedded {
            conv_id: "886".into(),
            conv_type: "group".into(),
        };
        let _ = runner.run_turn("总结下讨论", &d, None);
        let sys = model.seen_system.lock().unwrap()[0].clone();
        assert!(sys.contains("[Scene: Chat]"), "聊天场景段应追加: {sys}");
        assert!(sys.contains("conv_id: 886"));
        assert!(sys.contains("group chat"));
        assert!(sys.contains("im_history"));
        // 无回答形态约束（口径：不写风格/格式/用途约定）
        assert!(!sys.contains("简洁"));
    }
    // ③ 任务：不绑定单一项目定位
    {
        let (sink, model, tools) = mk();
        let d = deps(model.clone(), tools, sink, None);
        let mut runner = SessionRunner::new(
            "s-task".into(),
            String::new(),
            PermissionMode::Ask,
            ModelTier::Strong,
            None,
        );
        runner.scene = Scene::Task;
        let _ = runner.run_turn("整理两边进展", &d, None);
        let sys = model.seen_system.lock().unwrap()[0].clone();
        assert!(sys.contains("[Scene: Task]"), "任务场景段应追加: {sys}");
        assert!(sys.contains("not bound to a single project"));
    }
}

/// 快照化（2026-11-23 前缀稳定）：memory_index/skills 目录首次 run_turn 定格，
/// 会话中途新增的记忆不进本会话索引——system 消息跨轮字节一致，模型侧
/// prompt cache 的 history 前缀不被打断
#[test]
fn memory_snapshot_frozen_across_turns() {
    let sink = Arc::new(CollectSink::default());
    let model = ScriptedModel::new(vec!["好的。".into(), "明白。".into()]);
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let tmp = tempfile::tempdir().unwrap();
    let mem = test_memory(tmp.path());
    let d = deps(model.clone(), tools, sink, Some(mem.clone()));
    let mut runner = SessionRunner::new(
        "s-snap".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    runner.scene = Scene::Project;
    let _ = runner.run_turn("第一轮", &d, None);
    // 会话中途落一条新记忆（模拟 memory_save / 被动轨启发式）
    mem.save_memory(&bbrt_memory::SaveInput {
        title: "中途新增记忆".into(),
        body: "这条不该出现在本会话的索引里。".into(),
        mtype: bbrt_memory::MemoryType::Project,
        session: "s-snap".into(),
        links: vec![],
    })
    .unwrap();
    let _ = runner.run_turn("第二轮", &d, None);
    let systems = model.seen_system.lock().unwrap().clone();
    assert_eq!(systems.len(), 2);
    assert!(
        !systems[1].contains("中途新增记忆"),
        "第二轮 system 不应含中途新增记忆（快照应定格）: {}",
        systems[1]
    );
    assert_eq!(
        systems[0], systems[1],
        "两轮 system 应字节一致（缓存前缀稳定）"
    );
}

// ---------------------------------------------------------------------------
// model.switch 审计
// ---------------------------------------------------------------------------

/// 记录型 WAL（WAL 断言用）
struct LogSink(std::sync::Mutex<Vec<String>>);
impl bbrt_session::loop_runner::EventLog for LogSink {
    fn append(&self, _sid: &str, type_: &str, _payload: &str) {
        self.0.lock().unwrap().push(type_.into());
    }
}

/// model.switch（D11 §4 ModelSwitched 产生方）：空闲切换 → 事件 + WAL；
/// 同档幂等；turn 中（runner 被取走）跳过
#[test]
fn manager_switch_model_emits() {
    use bbrt_session::events::SessionEvent;
    use bbrt_session::loop_runner::NoopEventLog;
    use bbrt_session::manager::SessionManager;
    use bbrt_session::StartParams;

    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: None,
    });
    let log = Arc::new(LogSink(std::sync::Mutex::new(vec![])));
    let d = LoopDeps {
        model,
        tools: Arc::new(FakeTools {
            confirm: false,
            executed: Mutex::new(vec![]),
            fail: false,
        }),
        memory: None,
        wal: log.clone(),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mgr = SessionManager::new(d, None);
    mgr.start(
        "s-sw".into(),
        StartParams {
            workspace: "/ws-sw".into(),
            mode: PermissionMode::AutoEdit,
            model_policy: ModelTier::Strong,
            model_override: None,
            title: "切换测试".into(),
            restored: None,
            unattended: false,
            scene: Default::default(),
        },
    )
    .unwrap();

    // 同档幂等：不产生事件
    assert_eq!(
        mgr.switch_model(Some("s-sw"), ModelTier::Strong, None, "user")
            .unwrap(),
        0
    );
    // 切档：事件 + WAL
    assert_eq!(
        mgr.switch_model(Some("s-sw"), ModelTier::Fast, None, "user")
            .unwrap(),
        1
    );
    assert!(events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::ModelSwitched { to, .. } if *to == ModelTier::Fast)));
    assert!(log
        .0
        .lock()
        .unwrap()
        .contains(&"model.switched".to_string()));
    // 不存在的会话 → NotFound
    assert!(mgr
        .switch_model(Some("nope"), ModelTier::Fast, None, "user")
        .is_err());
    let _ = NoopEventLog; // 引用保持（避免 unused import 波动）
}

// ── 0023 模型直达引用：override 优先 / 档位回落 / 切换持久化 ──

/// 捕获型假模型：记录每次请求的 model（剧本=纯文本收尾）
struct CapturingModel {
    models: Mutex<Vec<String>>,
}
impl ChatClient for CapturingModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        self.models.lock().unwrap().push(req.model.clone());
        Ok(Box::new(
            vec![
                Ok(StreamEvent::TextDelta { text: "答".into() }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 5,
                        completion_tokens: 1,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
            .into_iter(),
        ))
    }
}

fn capture_deps(model: Arc<CapturingModel>) -> LoopDeps {
    LoopDeps {
        model,
        tools: Arc::new(FakeTools {
            confirm: false,
            executed: Mutex::new(vec![]),
            fail: false,
        }),
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink: Arc::new(CollectSink::default()),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    }
}

/// override 存在 → 主循环 model 直达引用透传；None → 回落档位别名
#[test]
fn model_override_routes_reference_and_falls_back() {
    let cap = Arc::new(CapturingModel {
        models: Mutex::new(vec![]),
    });
    let d = capture_deps(cap.clone());
    let mut runner = SessionRunner::new(
        "s-ref".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        Some("p:1:glm-5.3".into()),
    );
    let _ = runner.run_turn("你好", &d, None);
    assert_eq!(*cap.models.lock().unwrap(), vec!["p:1:glm-5.3".to_string()]);

    let cap2 = Arc::new(CapturingModel {
        models: Mutex::new(vec![]),
    });
    let d2 = capture_deps(cap2.clone());
    let mut runner2 = SessionRunner::new(
        "s-ref2".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let _ = runner2.run_turn("你好", &d2, None);
    assert_eq!(*cap2.models.lock().unwrap(), vec!["bbc-strong".to_string()]);
}

/// switch_model 带 override：事件携带引用 + agent_session 持久化（含清除）
#[test]
fn switch_model_override_persists() {
    use bbrt_session::events::SessionEvent;
    use bbrt_session::manager::SessionManager;
    use bbrt_store::Store;

    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(Mutex::new(Store::open(&tmp.path().join("t.db")).unwrap()));
    let sink = Arc::new(CollectSink::default());
    let d = LoopDeps {
        model: Arc::new(FakeModel {
            calls: AtomicUsize::new(0),
            tool_name: None,
        }),
        tools: Arc::new(FakeTools {
            confirm: false,
            executed: Mutex::new(vec![]),
            fail: false,
        }),
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mgr = SessionManager::new(d, Some(store.clone()));
    mgr.start(
        "s-ov".into(),
        bbrt_session::StartParams {
            workspace: "/ws".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelTier::Strong,
            model_override: Some("p:2:deepseek-chat".into()),
            title: "引用持久化".into(),
            restored: None,
            unattended: false,
            scene: Default::default(),
        },
    )
    .unwrap();
    // start 即带 override → 落库
    {
        let s = store.lock().unwrap();
        let row = s.get_session("s-ov").unwrap().unwrap();
        assert_eq!(row.model_override.as_deref(), Some("p:2:deepseek-chat"));
    }

    // 切到档位（清 override）→ 事件 + 库回写
    assert_eq!(
        mgr.switch_model(Some("s-ov"), ModelTier::Fast, None, "user")
            .unwrap(),
        1
    );
    let evts = events_of(sink.as_ref());
    assert!(evts.iter().any(|e| matches!(
        e,
        SessionEvent::ModelSwitched { to, model_override: None, .. } if *to == ModelTier::Fast
    )));
    {
        let s = store.lock().unwrap();
        let row = s.get_session("s-ov").unwrap().unwrap();
        assert_eq!(row.model_policy, "fast");
        assert!(row.model_override.is_none());
    }

    // 再切回引用 → 库存 override
    assert_eq!(
        mgr.switch_model(Some("s-ov"), ModelTier::Fast, Some("p:1:glm-5.3"), "user")
            .unwrap(),
        1
    );
    {
        let s = store.lock().unwrap();
        let row = s.get_session("s-ov").unwrap().unwrap();
        assert_eq!(row.model_override.as_deref(), Some("p:1:glm-5.3"));
    }
}

// ---------------------------------------------------------------------------
// B 批：subagent.wait（等待子任务/委派 run 终态并取回结果）
// ---------------------------------------------------------------------------

/// 出一轮 subagent.wait 工具调用、其余纯文本收尾的假模型（args 可脚本化）
struct FakeWaitModel {
    calls: AtomicUsize,
    args: String,
}
impl ChatClient for FakeWaitModel {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
            vec![
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "call-w1".into(),
                    name: "subagent.wait".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: self.args.clone(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: Usage {
                        prompt_tokens: 10,
                        completion_tokens: 4,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "拿到结果了".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 10,
                        completion_tokens: 4,
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        };
        Ok(Box::new(events.into_iter()))
    }
}

/// 带 run 快照表的假 WAL（run_snapshot 查表；append 丢弃）
struct SnapLog {
    rows: Mutex<std::collections::HashMap<String, bbrt_session::loop_runner::EventRunSnapshot>>,
}
impl EventLog for SnapLog {
    fn append(&self, _session_id: &str, _t: &str, _p: &str) {}
    fn run_snapshot(&self, run_id: &str) -> Option<bbrt_session::loop_runner::EventRunSnapshot> {
        self.rows.lock().unwrap().get(run_id).cloned()
    }
}

fn wait_deps(model: Arc<FakeWaitModel>, wal: Arc<SnapLog>, sink: Arc<CollectSink>) -> LoopDeps {
    LoopDeps {
        model,
        tools: Arc::new(FakeTools {
            confirm: false,
            executed: Mutex::new(vec![]),
            fail: false,
        }),
        memory: None,
        wal,
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    }
}

/// 已完成 run：立即返回结果摘要（terminal 命令带 exit 摘要）
#[test]
fn subagent_wait_finished_run_returns_result() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeWaitModel {
        calls: AtomicUsize::new(0),
        args: r#"{"run_id":"r-ab12cd34"}"#.into(),
    });
    let wal = Arc::new(SnapLog {
        rows: Mutex::new(
            [(
                "r-ab12cd34".to_string(),
                bbrt_session::loop_runner::EventRunSnapshot {
                    status: "done".into(),
                    kind: "terminal".into(),
                    summary: "构建完成：cargo test 51 passed（exit 0）".into(),
                },
            )]
            .into_iter()
            .collect(),
        ),
    });
    let d = wait_deps(model, wal, sink.clone());
    let mut runner = SessionRunner::new(
        "s-w1".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("等那个后台命令的结果", &d, None);
    assert_eq!(report.tool_calls, 1);
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter().any(|e| matches!(
            e,
            SessionEvent::ToolResult { summary, .. }
                if summary.contains("[命令完成·done]") && summary.contains("cargo test 51 passed")
        )),
        "应返回后台命令结果摘要: {evs:?}"
    );
}

/// 未知 run：8002 拒绝（不挂起不误等）
#[test]
fn subagent_wait_unknown_run_rejected() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeWaitModel {
        calls: AtomicUsize::new(0),
        args: r#"{"run_id":"r-nope"}"#.into(),
    });
    let wal = Arc::new(SnapLog {
        rows: Mutex::new(std::collections::HashMap::new()),
    });
    let d = wait_deps(model, wal, sink.clone());
    let mut runner = SessionRunner::new(
        "s-w2".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("等结果", &d, None);
    assert_eq!(report.tool_calls, 1);
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter().any(|e| matches!(
            e,
            SessionEvent::ToolResult { summary, .. } if summary.contains("未知 run r-nope")
        )),
        "未知 run 应 8002 拒绝: {evs:?}"
    );
}

// ---------------------------------------------------------------------------
// 统一后台任务体系：run_command background + task.wait 对 terminal
// ---------------------------------------------------------------------------

/// 真存 run 状态的假 WAL（run_start/run_end/run_snapshot 落 HashMap——
/// 后台线程与断言侧共享所见）
struct BgStoreLog {
    rows: Mutex<std::collections::HashMap<String, bbrt_session::loop_runner::EventRunSnapshot>>,
    seq: AtomicUsize,
}
impl EventLog for BgStoreLog {
    fn append(&self, _session_id: &str, _t: &str, _p: &str) {}
    fn next_task_id(&self, kind: &str) -> Option<String> {
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        Some(format!("{kind}-test{:04}", n))
    }
    fn run_start(&self, run: &bbrt_session::loop_runner::RunStart) {
        self.rows.lock().unwrap().insert(
            run.run_id.clone(),
            bbrt_session::loop_runner::EventRunSnapshot {
                status: "running".into(),
                kind: run.kind.to_string(),
                summary: String::new(),
            },
        );
    }
    fn run_end(&self, run_id: &str, end: &bbrt_session::loop_runner::RunEnd<'_>) {
        let mut rows = self.rows.lock().unwrap();
        if let Some(snap) = rows.get_mut(run_id) {
            snap.status = end.status.to_string();
            snap.summary = end.summary.to_string();
        }
    }
    fn run_snapshot(&self, run_id: &str) -> Option<bbrt_session::loop_runner::EventRunSnapshot> {
        self.rows.lock().unwrap().get(run_id).cloned()
    }
}

/// spawn_background 真起 /bin/sh 的假执行器（其余同 FakeTools 语义）
struct BgShellTools;
impl ToolExecutor for BgShellTools {
    fn check(&self, _mode: PermissionMode, _call: &ToolInvocation) -> CheckOutcome {
        CheckOutcome::Allow {
            source: "matrix".into(),
        }
    }
    fn execute(&self, _mode: PermissionMode, _call: &ToolInvocation) -> ToolOutcome {
        ToolOutcome::Ok {
            summary: "不应走到同步执行".into(),
            truncated: false,
            exit_code: Some(0),
            duration_ms: 0,
        }
    }
    fn record_grant(
        &self,
        _m: PermissionMode,
        _c: &ToolInvocation,
        _s: GrantScope,
    ) -> Result<(), String> {
        Ok(())
    }
    fn tool_specs(&self) -> Vec<ToolSpec> {
        vec![]
    }
    fn spawn_background(
        &self,
        _call: &ToolInvocation,
    ) -> Result<bbrt_sec::sandbox::DetachedCommand, String> {
        let spec = bbrt_sec::sandbox::RunSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "echo bg-hello-world".into()],
            cwd: None,
            env: vec![],
        };
        bbrt_sec::sandbox::DetachedCommand::spawn(&spec, &bbrt_sec::sandbox::RunOpts::default())
    }
    /// hybrid：直接 StillRunning（模拟同步等待到阈值未完——转后台路径）
    fn execute_or_handoff(
        &self,
        mode: PermissionMode,
        call: &ToolInvocation,
        _wait_secs: u64,
    ) -> bbrt_session::CommandHandoff {
        match self.spawn_background(call) {
            Ok(det) => bbrt_session::CommandHandoff::StillRunning(det),
            Err(_) => bbrt_session::CommandHandoff::Done(self.execute(mode, call)),
        }
    }
}

/// background=true：立即返回任务 id（turn 不等命令）+ 后台线程落终态（含输出）
#[test]
fn run_command_background_returns_task_id_and_finishes() {
    let sink = Arc::new(CollectSink::default());
    // FakeModel 的 args 是 {"path":"foo.txt"}——需要 background:true，换脚本化模型
    struct BgModel {
        calls: AtomicUsize,
    }
    impl ChatClient for BgModel {
        fn chat(
            &self,
            _req: &ChatRequest,
        ) -> Result<
            Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
            bbrt_aigw::AigwError,
        > {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
                vec![
                    Ok(StreamEvent::ToolCallBegin {
                        index: 0,
                        id: "call-bg1".into(),
                        name: "run_command".into(),
                    }),
                    Ok(StreamEvent::ToolCallDelta {
                        index: 0,
                        args_delta: r#"{"command":"echo bg-hello-world","background":true}"#.into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::ToolCalls,
                        usage: Usage {
                            prompt_tokens: 10,
                            completion_tokens: 4,
                            cached_tokens: None,
                        },
                        model: None,
                    }),
                ]
            } else {
                vec![
                    Ok(StreamEvent::TextDelta {
                        text: "已转后台".into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::Stop,
                        usage: Usage {
                            prompt_tokens: 10,
                            completion_tokens: 4,
                            cached_tokens: None,
                        },
                        model: None,
                    }),
                ]
            };
            Ok(Box::new(events.into_iter()))
        }
    }
    let model = Arc::new(BgModel {
        calls: AtomicUsize::new(0),
    });
    let wal = Arc::new(BgStoreLog {
        rows: Mutex::new(std::collections::HashMap::new()),
        seq: AtomicUsize::new(0),
    });
    let d = LoopDeps {
        model,
        tools: Arc::new(BgShellTools),
        memory: None,
        wal: wal.clone(),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let started = std::time::Instant::now();
    let mut runner = SessionRunner::new(
        "s-bg1".into(),
        "/tmp/ws".into(),
        PermissionMode::FullAuto,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("后台跑个构建", &d, None);
    // turn 立即收口（不等命令：echo 秒完，此处断言主要防回归成同步长等）
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(report.tool_calls, 1);
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter().any(|e| matches!(
            e,
            SessionEvent::ToolResult { summary, .. }
                if summary.contains("[后台执行中]") && summary.contains("terminal-") && summary.contains("task.wait")
        )),
        "应立即返回 terminal- 任务 id: 见事件流"
    );
    // 后台线程落终态：轮询至多 3s
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut final_snap = None;
    while std::time::Instant::now() < deadline {
        let task_id = wal
            .rows
            .lock()
            .unwrap()
            .keys()
            .find(|k| k.starts_with("terminal-"))
            .cloned()
            .unwrap_or_default();
        let snap = wal.run_snapshot(&task_id);
        if let Some(s) = snap {
            if s.status != "running" {
                final_snap = Some(s);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let snap = final_snap.expect("后台线程应在 3s 内落终态");
    assert_eq!(snap.status, "done");
    assert!(
        snap.summary.contains("bg-hello-world"),
        "摘要应含输出: {}",
        snap.summary
    );
}

/// hybrid：同步 run_command（无 background）到阈值自动转后台——返回任务 id
/// 「自动转后台」文案 + 后台线程落终态
#[test]
fn run_command_sync_times_out_into_background() {
    let sink = Arc::new(CollectSink::default());
    struct SyncBgModel {
        calls: AtomicUsize,
    }
    impl ChatClient for SyncBgModel {
        fn chat(
            &self,
            _req: &ChatRequest,
        ) -> Result<
            Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
            bbrt_aigw::AigwError,
        > {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
                vec![
                    Ok(StreamEvent::ToolCallBegin {
                        index: 0,
                        id: "call-sbg1".into(),
                        name: "run_command".into(),
                    }),
                    Ok(StreamEvent::ToolCallDelta {
                        index: 0,
                        args_delta: r#"{"command":"cargo build --release"}"#.into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::ToolCalls,
                        usage: Usage {
                            prompt_tokens: 10,
                            completion_tokens: 4,
                            cached_tokens: None,
                        },
                        model: None,
                    }),
                ]
            } else {
                vec![
                    Ok(StreamEvent::TextDelta {
                        text: "转后台了".into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::Stop,
                        usage: Usage {
                            prompt_tokens: 10,
                            completion_tokens: 4,
                            cached_tokens: None,
                        },
                        model: None,
                    }),
                ]
            };
            Ok(Box::new(events.into_iter()))
        }
    }
    let model = Arc::new(SyncBgModel {
        calls: AtomicUsize::new(0),
    });
    let wal = Arc::new(BgStoreLog {
        rows: Mutex::new(std::collections::HashMap::new()),
        seq: AtomicUsize::new(0),
    });
    let d = LoopDeps {
        model,
        tools: Arc::new(BgShellTools),
        memory: None,
        wal: wal.clone(),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-sbg1".into(),
        "/tmp/ws".into(),
        PermissionMode::FullAuto,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("跑个构建", &d, None);
    assert_eq!(report.tool_calls, 1);
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter().any(|e| matches!(
            e,
            SessionEvent::ToolResult { summary, .. }
                if summary.contains("自动转后台") && summary.contains("terminal-") && summary.contains("task.wait")
        )),
        "同步超时应转后台返回任务 id"
    );
    // 后台线程落终态（echo 秒完）
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut done = false;
    while std::time::Instant::now() < deadline {
        let rows = wal.rows.lock().unwrap();
        if rows
            .values()
            .any(|s| s.status == "done" && s.summary.contains("bg-hello-world"))
        {
            done = true;
            break;
        }
        drop(rows);
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(done, "后台线程应落 done 终态含输出");
}

/// 缺口修复回归（2026-11-24）：run_command background:true 必须先过 gate——
/// 原实现后台拦截在 check 之前=后台命令免审直跑（ask 档 rm 也能 spawn）。
/// Deny 执行器下：命令被拒、无 terminal- 任务落库、spawn 不发生
#[test]
fn run_command_background_must_pass_gate() {
    use std::sync::atomic::AtomicUsize;
    let sink = Arc::new(CollectSink::default());
    struct DenyTools {
        checks: AtomicUsize,
    }
    impl ToolExecutor for DenyTools {
        fn check(&self, _mode: PermissionMode, _call: &ToolInvocation) -> CheckOutcome {
            self.checks.fetch_add(1, Ordering::SeqCst);
            CheckOutcome::Deny {
                code: 8002,
                message: "缺少权限点 agent:tool:run_command".into(),
            }
        }
        fn execute(&self, _mode: PermissionMode, _call: &ToolInvocation) -> ToolOutcome {
            ToolOutcome::Ok {
                summary: "不应走到同步执行".into(),
                truncated: false,
                exit_code: Some(0),
                duration_ms: 0,
            }
        }
        fn record_grant(
            &self,
            _m: PermissionMode,
            _c: &ToolInvocation,
            _s: GrantScope,
        ) -> Result<(), String> {
            Ok(())
        }
        fn tool_specs(&self) -> Vec<ToolSpec> {
            vec![]
        }
        fn spawn_background(
            &self,
            _call: &ToolInvocation,
        ) -> Result<bbrt_sec::sandbox::DetachedCommand, String> {
            panic!("gate 拒绝后不得 spawn 后台命令");
        }
    }
    struct BgDenyModel {
        calls: AtomicUsize,
    }
    impl ChatClient for BgDenyModel {
        fn chat(
            &self,
            _req: &ChatRequest,
        ) -> Result<
            Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
            bbrt_aigw::AigwError,
        > {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
                vec![
                    Ok(StreamEvent::ToolCallBegin {
                        index: 0,
                        id: "call-bgd1".into(),
                        name: "run_command".into(),
                    }),
                    Ok(StreamEvent::ToolCallDelta {
                        index: 0,
                        args_delta: r#"{"command":"rm -rf /tmp/x","background":true}"#.into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::ToolCalls,
                        usage: Usage {
                            prompt_tokens: 10,
                            completion_tokens: 4,
                            cached_tokens: None,
                        },
                        model: None,
                    }),
                ]
            } else {
                vec![Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 10,
                        completion_tokens: 4,
                        cached_tokens: None,
                    },
                    model: None,
                })]
            };
            Ok(Box::new(events.into_iter()))
        }
    }
    let tools = Arc::new(DenyTools {
        checks: AtomicUsize::new(0),
    });
    let wal = Arc::new(BgStoreLog {
        rows: Mutex::new(std::collections::HashMap::new()),
        seq: AtomicUsize::new(0),
    });
    let d = LoopDeps {
        model: Arc::new(BgDenyModel {
            calls: AtomicUsize::new(0),
        }),
        tools: Arc::clone(&tools) as Arc<dyn ToolExecutor>,
        memory: None,
        wal: wal.clone(),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-bgd1".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("后台跑个删除", &d, None);
    // gate 必须被咨询（原实现后台路径零 check）
    assert!(
        tools.checks.load(Ordering::SeqCst) >= 1,
        "后台命令必须先过 gate"
    );
    // 无 terminal- 任务落库（spawn 未发生）
    assert!(
        !wal.rows
            .lock()
            .unwrap()
            .keys()
            .any(|k| k.starts_with("terminal-")),
        "gate 拒绝后不得 spawn 后台任务"
    );
    // 工具结果为拒（模型可感知并转告用户）
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter()
            .any(|e| matches!(e, SessionEvent::ToolResult { ok: false, .. })),
        "应回工具失败结果: {report:?}"
    );
}

/// task.wait 对 terminal 任务：已完成立即返回 [命令完成·done] + 输出
#[test]
fn task_wait_terminal_task_returns_output() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeWaitModel {
        calls: AtomicUsize::new(0),
        args: r#"{"run_id":"terminal-ab01"}"#.into(),
    });
    let wal = Arc::new(SnapLog {
        rows: Mutex::new(
            [(
                "terminal-ab01".to_string(),
                bbrt_session::loop_runner::EventRunSnapshot {
                    status: "done".into(),
                    kind: "terminal".into(),
                    summary: "bg-hello-world\n[exit_code=0]".into(),
                },
            )]
            .into_iter()
            .collect(),
        ),
    });
    let d = wait_deps(model, wal, sink.clone());
    let mut runner = SessionRunner::new(
        "s-tw1".into(),
        "/tmp/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    let report = runner.run_turn("等命令结果", &d, None);
    assert_eq!(report.tool_calls, 1);
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter().any(|e| matches!(
            e,
            SessionEvent::ToolResult { summary, .. }
                if summary.contains("[命令完成·done]") && summary.contains("bg-hello-world")
        )),
        "task.wait 应返回命令输出: {evs:?}"
    );
}

// ---------------------------------------------------------------------------
// D35 定时任务无人值守：工具面剔除 ask_user + 硬调防御
// ---------------------------------------------------------------------------

/// 记录模型请求里的工具面（断言过滤用）
struct RecordingModel {
    tools: Mutex<Vec<String>>,
}
impl ChatClient for RecordingModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        *self.tools.lock().unwrap() = req.tools.iter().map(|t| t.name.clone()).collect();
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::TextDelta { text: "ok".into() }),
            Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    cached_tokens: None,
                },
                model: None,
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

#[test]
fn unattended_filters_ask_user_tool_spec() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(RecordingModel {
        tools: Mutex::new(vec![]),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model.clone(), tools, sink, None);
    let mut runner = SessionRunner::new(
        "s-tools".into(),
        String::new(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    runner.unattended = true;
    let _ = runner.run_turn("列一下工具", &d, None);
    let names = model.tools.lock().unwrap().clone();
    assert!(
        names.contains(&"read_file".to_string()),
        "普通工具应保留: {names:?}"
    );
    assert!(
        !names.contains(&"ask_user".to_string()),
        "无人值守应剔除 ask_user: {names:?}"
    );
}

#[test]
fn unattended_blocks_ask_user_call_without_clarify_event() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeClarifyModel {
        calls: AtomicUsize::new(0),
        ask_args: GOOD_ASK_ARGS.into(),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = deps(model, tools, sink.clone(), None);
    let mut runner = SessionRunner::new(
        "s-block".into(),
        String::new(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    runner.unattended = true;
    let rep = runner.run_turn("无人值守跑一下", &d, None);
    assert_eq!(rep.tool_calls, 1);
    let evts = events_of(&sink);
    assert!(
        !evts
            .iter()
            .any(|e| matches!(e, SessionEvent::ClarifyRequest { .. })),
        "无人值守不应发 clarify.request: {evts:?}"
    );
}

/// 场景落库（2026-11-23）：embedded 场景 form=embedded + conv_id 落库；
/// 任务/项目落 workbench（表 CHECK IN('embedded','workbench')）——复活路径
/// 按库行还原场景，不依赖前端 IDB 映射
#[test]
fn manager_persists_scene_form_and_conv_id() {
    use bbrt_session::manager::SessionManager;
    use bbrt_store::Store;

    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(Mutex::new(Store::open(&tmp.path().join("t.db")).unwrap()));
    let mk_deps = |sink: Arc<CollectSink>| LoopDeps {
        model: Arc::new(FakeModel {
            calls: AtomicUsize::new(0),
            tool_name: None,
        }),
        tools: Arc::new(FakeTools {
            confirm: false,
            executed: Mutex::new(vec![]),
            fail: false,
        }),
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    // embedded：form=embedded + conv_id
    {
        let mgr = SessionManager::new(
            mk_deps(Arc::new(CollectSink::default())),
            Some(store.clone()),
        );
        mgr.start(
            "s-emb-db".into(),
            StartParams {
                workspace: String::new(),
                mode: PermissionMode::Ask,
                model_policy: ModelTier::Strong,
                model_override: None,
                title: "与张三的对话".into(),
                restored: None,
                unattended: false,
                scene: Scene::Embedded {
                    conv_id: "886".into(),
                    conv_type: "group".into(),
                },
            },
        )
        .unwrap();
        let row = store
            .lock()
            .unwrap()
            .get_session("s-emb-db")
            .unwrap()
            .unwrap();
        assert_eq!(row.form, "embedded");
        assert_eq!(row.conv_id.as_deref(), Some("886"));
    }
    // 任务/项目：form=workbench、无 conv_id（CHECK 约束域内）
    for (sid, ws, scene) in [
        ("s-task-db", String::new(), Scene::Task),
        ("s-proj-db", "/ws".to_string(), Scene::Project),
    ] {
        let mgr = SessionManager::new(
            mk_deps(Arc::new(CollectSink::default())),
            Some(store.clone()),
        );
        mgr.start(
            sid.into(),
            StartParams {
                workspace: ws,
                mode: PermissionMode::Ask,
                model_policy: ModelTier::Strong,
                model_override: None,
                title: "t".into(),
                restored: None,
                unattended: false,
                scene,
            },
        )
        .unwrap();
        let row = store.lock().unwrap().get_session(sid).unwrap().unwrap();
        assert_eq!(row.form, "workbench");
        assert_eq!(row.conv_id, None);
    }
}
