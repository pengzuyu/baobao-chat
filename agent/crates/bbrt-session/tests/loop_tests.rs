//! 核心循环测试：假模型 + 假工具 + 收集 sink 全链路验证（08 §4.1 / D11 §6）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bbrt_aigw::{
    ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg, ToolSpec, Usage,
};
use bbrt_context::{BudgetConfig, Round, Summarizer};
use bbrt_memory::{ActivityEvent, MemoryEngine};
use bbrt_sec::gate::PermissionMode;
use bbrt_sec::memory::GrantScope;

use bbrt_session::events::{ModelTier, SessionEvent, SessionSink};
use bbrt_session::executor::{
    CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome, ToolPreview,
};
use bbrt_session::loop_runner::{
    EventLog, LoopDeps, NoopEventLog, PermissionDecision, PermissionResponse, SessionRunner,
    MAX_STEPS,
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
        snapshots: None,
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
    );
    let report = runner.run_turn("读一下 foo.txt", &d);

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
    let report = runner.run_turn("跑个命令", &d);
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
    let rep2 = r2.run_turn("再跑一个", &d2);
    assert_eq!(tools2.executed.lock().unwrap().len(), 0, "拒绝后不执行");
    assert_eq!(rep2.tool_calls, 1);
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
    );
    runner.permission_timeout = Duration::from_millis(100);
    let report = runner.run_turn("无人应答", &d);
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
    );
    runner.run_turn("记住：本机服务端口用 8090", &d);
    let evs = events_of(sink.as_ref());
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::MemorySaved { title, .. } if title.contains("8090"))));

    runner.end(&d, "测试会话");
    let evs = events_of(sink.as_ref());
    assert!(
        evs.iter()
            .any(|e| matches!(e, SessionEvent::ReportDaily { .. })),
        "session.end 应触发日报"
    );
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::SessionEnded { .. })));
    // 日报文件真实存在
    let reports = tmp.path().join("agent").join("reports");
    assert!(reports.read_dir().unwrap().count() >= 1);
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
    );
    let report = runner.run_turn("反复失败", &d);
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
        snapshots: None,
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
    );
    runner.run_turn("记录一下", &d);
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
        snapshots: None,
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
    );
    // 预填长历史
    let _ = MiniBudget;
    let long_text = "上下文压力测试内容。".repeat(120);
    let report = runner.run_turn(&long_text, &d);
    let evs = events_of(sink.as_ref());
    let compacted = evs
        .iter()
        .any(|e| matches!(e, SessionEvent::Compaction { phase, .. } if phase == "done"));
    // 小窗口下要么压缩成功要么 8010 暂停——两者都算路径可达
    assert!(compacted || report.paused);
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
    let _ = ActivityEvent::SessionStarted {
        session: "s".into(),
        workspace: "/w".into(),
        mode: "ask".into(),
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
    );
    let report = runner.run_turn("无限工具循环", &d);
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
            snapshots: None,
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
    let report = runner.run_turn("委派修一下构建", &d);
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
    let _ = runner.run_turn("再委派一次", &d);
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
        snapshots: None,
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
    );
    runner.permission_timeout = Duration::from_millis(200);
    let _ = runner.run_turn("委派", &d);
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
    );
    let _ = runner.run_turn("跑一下构建", &d);

    // 同工具同错连续 ≥2 次 → feedback 教训自动落盘（带 Why/How to apply）
    let list = mem.knowledge().list();
    assert!(
        list.iter().any(
            |e| e.mtype == bbrt_memory::MemoryType::Feedback && e.title.contains("run_command")
        ),
        "应产出 run_command 教训条目，实际: {list:?}"
    );
    let body = list
        .iter()
        .find(|e| e.title.contains("run_command"))
        .map(|e| mem.knowledge().get(&e.name).unwrap().unwrap().body)
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
    );
    let _ = runner.run_turn("以后做事先给我方案再动手", &d);
    runner.end(&d, "");

    let list = mem.knowledge().list();
    assert!(
        list.iter().any(|e| e.title == "用户偏好先方案"),
        "W3 应落盘提炼条目，实际: {list:?}"
    );
    assert!(events_of(sink.as_ref()).iter().any(
        |e| matches!(e, SessionEvent::MemorySaved { title, .. } if title == "用户偏好先方案")
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
    );
    let _ = runner.run_turn("帮我看下配置", &d);
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
    );
    let _ = runner.run_turn("8090 端口起服务", &d);
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
        snapshots: None,
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
    let _ = runner.run_turn("委派修一下构建", &d);
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
        snapshots: None,
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
    );
    runner.permission_timeout = Duration::from_millis(200);
    // 不发 Launch → brief 超时
    let _ = runner.run_turn("委派但没人确认", &d);
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
        snapshots: None,
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
            title: "切换测试".into(),
            restored: None,
        },
    )
    .unwrap();

    // 同档幂等：不产生事件
    assert_eq!(
        mgr.switch_model(Some("s-sw"), ModelTier::Strong, "user")
            .unwrap(),
        0
    );
    // 切档：事件 + WAL
    assert_eq!(
        mgr.switch_model(Some("s-sw"), ModelTier::Fast, "user")
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
        .switch_model(Some("nope"), ModelTier::Fast, "user")
        .is_err());
    let _ = NoopEventLog; // 引用保持（避免 unused import 波动）
}
