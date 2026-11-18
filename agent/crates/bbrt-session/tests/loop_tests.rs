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
    ClarifyAnswer, EventLog, LoopDeps, NoopEventLog, PermissionDecision, PermissionResponse,
    SessionRunner, MAX_STEPS,
};
use bbrt_session::manager::{ManagerError, SessionManager, StartParams};

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
                        },
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
                        },
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
        vec![ToolSpec {
            name: "read_file".into(),
            description: "读文件".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }]
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
        delegator: None,
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
    runner.permission_timeout = Duration::from_millis(500);
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
    r2.permission_timeout = Duration::from_millis(500);
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
                    },
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
                    },
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

#[test]
fn permission_timeout_counts_as_deny() {
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
    runner.permission_timeout = Duration::from_millis(100);
    let report = runner.run_turn("无人应答", &d, None);
    assert_eq!(tools.executed.lock().unwrap().len(), 0);
    assert_eq!(report.tool_calls, 1);
    assert!(events_of(sink.as_ref()).iter().any(
        |e| matches!(e, SessionEvent::PermissionResolved { decision, .. } if decision == "timeout")
    ));
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
fn consecutive_failures_pause_loop() {
    // 模型每轮都要求工具、工具全部 Blocked：连续失败>3 → 暂停
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
    assert!(report.paused);
    assert!(events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::StateChanged { state, .. } if state == "paused")));
}

/// 每次调用都返回工具调用（驱动失败熔断）
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
                },
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
        delegator: None,
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
fn manager_limits_three_active_sessions() {
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
    for i in 0..3 {
        mgr.start(
            format!("s-{i}"),
            StartParams {
                workspace: "/w".into(),
                mode: PermissionMode::Ask,
                model_policy: ModelTier::Fast,
                model_override: None,
                title: "t".into(),
                restored: None,
            },
        )
        .unwrap();
    }
    assert!(matches!(
        mgr.start(
            "s-4".into(),
            StartParams {
                workspace: "/w".into(),
                mode: PermissionMode::Ask,
                model_policy: ModelTier::Fast,
                model_override: None,
                title: "t".into(),
                restored: None
            }
        ),
        Err(ManagerError::TooManyActive)
    ));
    mgr.end("s-1", "done").unwrap();
    assert_eq!(mgr.active_count(), 2);
    mgr.start(
        "s-4".into(),
        StartParams {
            workspace: "/w".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelTier::Fast,
            model_override: None,
            title: "t".into(),
            restored: None,
        },
    )
    .unwrap();
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
        delegator: None,
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
                },
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

// ---- 委派编排（D11 §3 #11-13）：假启动器走全流程 ----

use bbrt_session::delegation::{
    DelegateChannel, DelegateEvt, DelegateFinal, DelegateLaunchReq, DelegateLauncher,
    DelegateStream,
};
use bbrt_session::loop_runner::DelegateHostMsg;

struct ScriptedStream {
    events: std::sync::Mutex<std::collections::VecDeque<DelegateEvt>>,
    cancelled: std::sync::Mutex<bool>,
}
impl DelegateStream for ScriptedStream {
    fn next(&mut self) -> Option<DelegateEvt> {
        self.events.lock().unwrap().pop_front()
    }
    fn cancel(&mut self, graceful: bool) {
        *self.cancelled.lock().unwrap() = graceful;
    }
    fn finalize(&mut self) -> DelegateFinal {
        DelegateFinal {
            summary: "委派摘要：改了 2 个文件".into(),
            changed_files: vec!["a.rs".into()],
            session_ref: Some("sess-x".into()),
            exit_code: Some(0),
        }
    }
}

struct FakeDelegator;
impl DelegateLauncher for FakeDelegator {
    fn backends(&self) -> Vec<String> {
        vec!["fake".into()]
    }
    fn launch(&self, _req: &DelegateLaunchReq) -> Result<Box<dyn DelegateStream>, String> {
        Ok(Box::new(ScriptedStream {
            events: std::sync::Mutex::new(
                [
                    DelegateEvt::Meta {
                        text: "init".into(),
                        session_ref: Some("sess-x".into()),
                    },
                    DelegateEvt::Delta {
                        channel: DelegateChannel::Text,
                        text: "正在改文件".into(),
                    },
                    DelegateEvt::ToolUse {
                        call_id: "t1".into(),
                        tool: "Edit".into(),
                        args: serde_json::json!({}),
                        risk: "medium",
                    },
                    DelegateEvt::ToolResult {
                        call_id: "t1".into(),
                        ok: true,
                        summary: "ok".into(),
                    },
                    DelegateEvt::Exit {
                        exit_code: Some(0),
                        signal: None,
                    },
                ]
                .into_iter()
                .collect(),
            ),
            cancelled: std::sync::Mutex::new(false),
        }))
    }
}

/// 委派工具模型（第一轮 tool_calls=coding.delegate，第二轮收尾）
struct DelegateToolModel {
    calls: AtomicUsize,
}
impl ChatClient for DelegateToolModel {
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
                    id: "call-d1".into(),
                    name: "coding.delegate".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: r#"{"task":"修复构建","forbidden":["git push"]}"#.into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: Usage {
                        prompt_tokens: 10,
                        completion_tokens: 5,
                    },
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "委派结果已确认。".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 20,
                        completion_tokens: 6,
                    },
                }),
            ]
        };
        Ok(Box::new(events.into_iter()))
    }
}

fn delegate_turn_setup() -> (Arc<CollectSink>, LoopDeps) {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(DelegateToolModel {
        calls: AtomicUsize::new(0),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    (
        sink.clone(),
        LoopDeps {
            model,
            tools,
            delegator: Some(Arc::new(FakeDelegator)),
            memory: None,
            wal: Arc::new(NoopEventLog),
            sink,
            skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
            fanout: None,
            experts: None,
            budget: BudgetConfig::default(),
        },
    )
}

#[test]
fn delegate_flow_accept_review() {
    let (sink, d) = delegate_turn_setup();
    let mut runner = SessionRunner::new(
        "s-d1".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.permission_timeout = Duration::from_millis(800);
    let dtx = runner.delegate_sender();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        let _ = dtx.send(DelegateHostMsg::Launch {
            backend: "fake".into(),
            brief: None,
        });
        std::thread::sleep(Duration::from_millis(120));
        let _ = dtx.send(DelegateHostMsg::Review { accept: true });
    });
    let report = runner.run_turn("委派修一下构建", &d, None);
    assert!(!report.paused);
    let evs = events_of(sink.as_ref());
    // 状态链：delegating → waiting_review → running（含 brief/事件/end/review 镜像）
    let states: Vec<String> = evs
        .iter()
        .filter_map(|e| match e {
            SessionEvent::StateChanged { state, .. } => Some(state.clone()),
            _ => None,
        })
        .collect();
    assert!(
        states.contains(&"delegating".into()),
        "应有 delegating 态: {states:?}"
    );
    assert!(
        states.contains(&"waiting_review".into()),
        "应有 waiting_review: {states:?}"
    );
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::DelegateBrief { .. })));
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::DelegateEvt { kind, .. } if kind == "delta")));
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::DelegateEnd { exit_code: 0, .. })));
    assert!(evs.iter().any(|e| matches!(e, SessionEvent::DelegateReviewResolved { decision, .. } if decision == "accept")));
    // 收尾轮看到委派摘要
    assert!(events_of(sink.as_ref()).iter().any(
        |e| matches!(e, SessionEvent::StreamDelta { delta, .. } if delta.contains("委派结果已确认"))
    ));
}

#[test]
fn delegate_flow_reject_review() {
    let (sink, d) = delegate_turn_setup();
    let mut runner = SessionRunner::new(
        "s-d2".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.permission_timeout = Duration::from_millis(800);
    let dtx = runner.delegate_sender();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        let _ = dtx.send(DelegateHostMsg::Launch {
            backend: "fake".into(),
            brief: None,
        });
        std::thread::sleep(Duration::from_millis(120));
        let _ = dtx.send(DelegateHostMsg::Review { accept: false });
    });
    let _ = runner.run_turn("再委派一次", &d, None);
    assert!(events_of(sink.as_ref())
        .iter()
        .any(|e| matches!(e, SessionEvent::DelegateReviewResolved { decision, .. } if decision == "reject")));
}

#[test]
fn delegate_without_launcher_blocked_8030() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(DelegateToolModel {
        calls: AtomicUsize::new(0),
    });
    let tools = Arc::new(FakeTools {
        confirm: false,
        executed: Mutex::new(vec![]),
        fail: false,
    });
    let d = LoopDeps {
        model,
        tools,
        delegator: None,
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink: sink.clone(),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-d3".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.permission_timeout = Duration::from_millis(200);
    let _ = runner.run_turn("委派", &d, None);
    assert!(events_of(sink.as_ref()).iter().any(|e| matches!(
        e,
        SessionEvent::ToolResult {
            ok: false,
            blocked_code: Some(8030),
            ..
        }
    )));
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
                },
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
    assert!(sys.contains("长期记忆"));
    assert!(sys.contains("[记忆]"));
    assert!(sys.contains("端口 8090 约定"), "记忆索引应注入 system");
}

// ---------------------------------------------------------------------------
// 委派审计链（delegate.* WAL 全点）与 model.switch
// ---------------------------------------------------------------------------

/// 记录型 WAL（WAL 断言用）
struct LogSink(std::sync::Mutex<Vec<String>>);
impl bbrt_session::loop_runner::EventLog for LogSink {
    fn append(&self, _sid: &str, type_: &str, _payload: &str) {
        self.0.lock().unwrap().push(type_.into());
    }
}

/// 全链 WAL：brief → launch → end → review（accept）均落账
#[test]
fn delegate_wal_audit_trail() {
    use std::sync::atomic::AtomicUsize;
    let sink = Arc::new(CollectSink::default());
    let log = Arc::new(LogSink(std::sync::Mutex::new(vec![])));
    let model = Arc::new(DelegateToolModel {
        calls: AtomicUsize::new(0),
    });
    let d = LoopDeps {
        model,
        tools: Arc::new(FakeTools {
            confirm: false,
            executed: Mutex::new(vec![]),
            fail: false,
        }),
        delegator: Some(Arc::new(FakeDelegator)),
        memory: None,
        wal: log.clone(),
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-dwal".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.permission_timeout = Duration::from_millis(800);
    let dtx = runner.delegate_sender();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        let _ = dtx.send(DelegateHostMsg::Launch {
            backend: "fake".into(),
            brief: None,
        });
        std::thread::sleep(Duration::from_millis(120));
        let _ = dtx.send(DelegateHostMsg::Review { accept: true });
    });
    let _ = runner.run_turn("委派修一下构建", &d, None);
    let types = log.0.lock().unwrap().clone();
    for expect in [
        "delegate.brief",
        "delegate.launch",
        "delegate.end",
        "delegate.review",
    ] {
        assert!(
            types.iter().any(|t| t == expect),
            "WAL 缺 {expect}: {types:?}"
        );
    }
}

/// brief 超时 8030 也落 WAL（放弃路径审计）
#[test]
fn delegate_brief_timeout_wal() {
    use std::sync::atomic::AtomicUsize;
    let sink = Arc::new(CollectSink::default());
    let log = Arc::new(LogSink(std::sync::Mutex::new(vec![])));
    let model = Arc::new(DelegateToolModel {
        calls: AtomicUsize::new(0),
    });
    let d = LoopDeps {
        model,
        tools: Arc::new(FakeTools {
            confirm: false,
            executed: Mutex::new(vec![]),
            fail: false,
        }),
        delegator: Some(Arc::new(FakeDelegator)),
        memory: None,
        wal: log.clone(),
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-dto".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.permission_timeout = Duration::from_millis(200);
    // 不发 Launch → brief 超时
    let _ = runner.run_turn("委派但没人确认", &d, None);
    let types = log.0.lock().unwrap().clone();
    assert!(
        types.iter().any(|t| t == "delegate.brief_timeout"),
        "超时应落账: {types:?}"
    );
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
        delegator: None,
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
                    },
                }),
            ]
            .into_iter(),
        ))
    }
}

fn capture_deps(model: Arc<CapturingModel>) -> LoopDeps {
    LoopDeps {
        model,
        delegator: None,
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
        delegator: None,
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
                    },
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta { text: "拿到结果了".into() }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 10,
                        completion_tokens: 4,
                    },
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
    fn run_snapshot(
        &self,
        run_id: &str,
    ) -> Option<bbrt_session::loop_runner::EventRunSnapshot> {
        self.rows.lock().unwrap().get(run_id).cloned()
    }
}

fn wait_deps(
    model: Arc<FakeWaitModel>,
    wal: Arc<SnapLog>,
    sink: Arc<CollectSink>,
) -> LoopDeps {
    LoopDeps {
        model,
        delegator: None,
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

/// 已完成 run：立即返回结果摘要（委派带可续接句柄提示）
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
                    kind: "delegate".into(),
                    summary: "委派完成：新增 2 个文件并通过测试".into(),
                    child_session_ref: "claude-sess-9".into(),
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
    let report = runner.run_turn("等那个委派的结果", &d, None);
    assert_eq!(report.tool_calls, 1);
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter().any(|e| matches!(
            e,
            SessionEvent::ToolResult { summary, .. }
                if summary.contains("[委派完成·done]") && summary.contains("可续接句柄 claude-sess-9")
        )),
        "应返回委派结果摘要: {evs:?}"
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
                child_session_ref: String::new(),
            },
        );
    }
    fn run_end(
        &self,
        run_id: &str,
        end: &bbrt_session::loop_runner::RunEnd<'_>,
    ) {
        let mut rows = self.rows.lock().unwrap();
        if let Some(snap) = rows.get_mut(run_id) {
            snap.status = end.status.to_string();
            snap.summary = end.summary.to_string();
        }
    }
    fn run_snapshot(
        &self,
        run_id: &str,
    ) -> Option<bbrt_session::loop_runner::EventRunSnapshot> {
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
}

/// background=true：立即返回任务 id（turn 不等命令）+ 后台线程落终态（含输出）
#[test]
fn run_command_background_returns_task_id_and_finishes() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(FakeModel {
        calls: AtomicUsize::new(0),
        tool_name: Some("run_command".into()),
    });
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
                        },
                    }),
                ]
            } else {
                vec![
                    Ok(StreamEvent::TextDelta { text: "已转后台".into() }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::Stop,
                        usage: Usage {
                            prompt_tokens: 10,
                            completion_tokens: 4,
                        },
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
        delegator: None,
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
    assert!(snap.summary.contains("bg-hello-world"), "摘要应含输出: {}", snap.summary);
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
                    child_session_ref: String::new(),
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
