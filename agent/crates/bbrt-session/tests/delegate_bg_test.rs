//! 后台委派集成测试（D16 §5 / P0-3）：
//! ① raw runner + hub：launch 后 turn 立即返回（会话不阻塞）→ 后台线程
//!    事件流 → delegate.end 全字段上行（P0-2③）→ hub 定向路由审查 →
//!    park_join 产物；
//! ② manager 级：respond_delegate 定向（P0-2②）+ 下一轮 run_turn 自动
//!    注入 delegate.join（产物回填主上下文，捕获模型断言）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bbrt_aigw::{ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_context::BudgetConfig;
use bbrt_sec::gate::PermissionMode;
use bbrt_session::delegate_bg::DelegateHub;
use bbrt_session::delegation::{
    DelegateEvt, DelegateFinal, DelegateLaunchReq, DelegateLauncher, DelegateStream,
};
use bbrt_session::events::{ModelTier, SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::loop_runner::{DelegateHostMsg, LoopDeps, NoopEventLog, SessionRunner};
use bbrt_session::manager::{SessionManager, StartParams};

// ---------------------------------------------------------------------------
// 假件（loop_tests 同款最小集）
// ---------------------------------------------------------------------------

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

/// 轮询等待事件谓词命中（后台线程异步产出）
fn wait_event(
    sink: &CollectSink,
    ms: u64,
    f: impl Fn(&SessionEvent) -> bool,
) -> Option<SessionEvent> {
    for _ in 0..(ms / 10) {
        if let Some(e) = events_of(sink).into_iter().find(&f) {
            return Some(e);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

/// 最小工具执行器（coding.delegate 在 run_tool 专用路径拦截，不达此处）
struct NoopTools;
impl ToolExecutor for NoopTools {
    fn check(&self, _mode: PermissionMode, _call: &ToolInvocation) -> CheckOutcome {
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
        _mode: PermissionMode,
        _call: &ToolInvocation,
        _scope: bbrt_sec::memory::GrantScope,
    ) -> Result<(), String> {
        Ok(())
    }
    fn tool_specs(&self) -> Vec<ToolSpec> {
        vec![]
    }
}

/// 委派工具模型：第 0 轮发 coding.delegate，其余纯文本收尾；
/// seen 记录每轮完整消息（注入断言用）
struct DelegateModel {
    calls: AtomicUsize,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
}
impl ChatClient for DelegateModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        self.seen.lock().unwrap().push(req.messages.clone());
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "交给后台。".into(),
                }),
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "call-d1".into(),
                    name: "coding.delegate".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "{\"task\":\"修构建\"}".into(),
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

/// 委派流 send_input 转发记录器（后台线程 → 测试线程经 static 共享）
static STREAM_INPUTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 剧本委派流：首调 next 延时（留运行窗给 Input 下发）→ EOF；
/// send_input 记录（D16 决策⑧转发断言）；finalize 带 changed_files/session_ref
struct ScriptedStream {
    first: bool,
}
impl DelegateStream for ScriptedStream {
    fn next(&mut self) -> Option<DelegateEvt> {
        if self.first {
            self.first = false;
            std::thread::sleep(Duration::from_millis(120)); // 运行窗（Input 在此到达）
            Some(DelegateEvt::Delta {
                channel: bbrt_session::delegation::DelegateChannel::Text,
                text: "开工".into(),
            })
        } else {
            None // 第 2 轮：先 drain 补充指令再 EOF
        }
    }
    fn cancel(&mut self, _graceful: bool) {}
    fn send_input(&mut self, text: &str) {
        STREAM_INPUTS.lock().unwrap().push(text.to_string());
    }
    fn finalize(&mut self) -> DelegateFinal {
        DelegateFinal {
            summary: "改了 2 个文件".into(),
            changed_files: vec!["a.rs".into(), "b.rs".into()],
            session_ref: Some("claude-sess-9".into()),
            exit_code: Some(0),
        }
    }
}

struct FakeDelegator;
impl DelegateLauncher for FakeDelegator {
    fn backends(&self) -> Vec<String> {
        vec!["fake".into()]
    }
    fn launch(&self, req: &DelegateLaunchReq) -> Result<Box<dyn DelegateStream>, String> {
        assert!(!req.session_id.is_empty(), "P0-2①：父会话关联必须接线");
        STREAM_INPUTS.lock().unwrap().clear();
        Ok(Box::new(ScriptedStream { first: true }))
    }
}

fn bg_deps(model: Arc<DelegateModel>, sink: Arc<CollectSink>) -> LoopDeps {
    LoopDeps {
        model,
        tools: Arc::new(NoopTools),
        delegator: Some(Arc::new(FakeDelegator)),
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink,
        snapshots: None,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    }
}

// ---------------------------------------------------------------------------
// ① raw runner + hub：后台全链
// ---------------------------------------------------------------------------

#[test]
fn background_delegate_turn_returns_immediately_and_parks_join() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(DelegateModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(vec![]),
    });
    let deps = bg_deps(model, sink.clone());
    let hub = Arc::new(DelegateHub::new());

    let mut runner = SessionRunner::new(
        "s-bg1".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.permission_timeout = Duration::from_secs(5);
    runner.delegate_hub = Some(hub.clone());
    let dtx = runner.delegate_sender();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        let _ = dtx.send(DelegateHostMsg::Launch {
            backend: "fake".into(),
            brief: None,
        });
    });

    let report = runner.run_turn("委派修一下构建", &deps);
    assert!(!report.paused, "后台路径 turn 不应暂停: {report:?}");
    assert_eq!(report.tool_calls, 1);

    // run_id 取自简报事件（turn 内同步发出）；运行窗内（首调 next 延时
    // 120ms）经 hub 下发补充指令——D16 决策⑧：应真正转发子进程
    let rid = match wait_event(&sink, 2_000, |e| {
        matches!(e, SessionEvent::DelegateBrief { .. })
    })
    .expect("简报事件应在 turn 内已发出")
    {
        SessionEvent::DelegateBrief {
            delegate_task_id, ..
        } => delegate_task_id,
        _ => unreachable!(),
    };
    assert!(hub.route(
        &rid,
        &DelegateHostMsg::Input {
            text: "顺带补个单测".into()
        }
    ));

    // turn 已返回；后台线程异步产出 end（P0-2③：全字段上行）
    let end = wait_event(&sink, 5_000, |e| {
        matches!(e, SessionEvent::DelegateEnd { exit_code: 0, .. })
    })
    .expect("后台线程应产出 delegate.end");
    match &end {
        SessionEvent::DelegateEnd {
            delegate_task_id,
            changed_files,
            child_session_ref,
            checkpoint_id,
            ..
        } => {
            assert_eq!(changed_files, &vec!["a.rs".to_string(), "b.rs".to_string()]);
            assert_eq!(child_session_ref.as_deref(), Some("claude-sess-9"));
            assert!(checkpoint_id.is_none(), "未装配快照服务时无检查点");
            // hub 定向路由审查（P0-2②）
            assert!(hub.route(delegate_task_id, &DelegateHostMsg::Review { accept: true }));
        }
        _ => unreachable!(),
    }
    // 等后台线程收口（审查通过 → park → 注销）
    for _ in 0..500 {
        if hub.active_count() == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(hub.active_count(), 0, "run 应已注销");
    assert!(wait_event(&sink, 2_000, |e| {
        matches!(e, SessionEvent::DelegateReviewResolved { decision, .. } if decision == "accept")
    })
    .is_some());

    // 补充指令真正到达子进程（转发断言）
    assert_eq!(
        STREAM_INPUTS.lock().unwrap().clone(),
        vec!["顺带补个单测".to_string()],
        "delegate.input 应经 pump 转发子进程"
    );

    // 产物 parking + 手动注入（manager 级注入由测试②覆盖）
    let joins = hub.drain_joins("s-bg1");
    assert_eq!(joins.len(), 1, "accept 应 park 一条产物");
    assert!(joins[0].summary.contains("委派完成"));
    assert!(!joins[0].run_id.is_empty());
}

// ---------------------------------------------------------------------------
// ② manager 级：定向路由 + 下一轮 run_turn 自动注入 delegate.join
// ---------------------------------------------------------------------------

#[test]
fn manager_routes_and_injects_delegate_join_next_turn() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(DelegateModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(vec![]),
    });
    let deps = bg_deps(model.clone(), sink.clone());
    let mgr = Arc::new(SessionManager::new(deps, None));
    mgr.start(
        "s-m1".into(),
        StartParams {
            workspace: "/ws".into(),
            mode: PermissionMode::AutoEdit,
            model_policy: ModelTier::Strong,
            model_override: None,
            title: "后台委派".into(),
            restored: None,
        },
    )
    .unwrap();

    // turn 线程（brief 阻塞等 launch；后台化后 turn 快速收口）
    let mgr2 = Arc::clone(&mgr);
    let turn = std::thread::spawn(move || mgr2.run_turn("s-m1", "委派修构建"));
    // 等简报事件拿 run_id → 定向 launch（P0-2②：session 通道）
    let brief = wait_event(&sink, 5_000, |e| {
        matches!(e, SessionEvent::DelegateBrief { .. })
    })
    .expect("应有简报事件");
    let rid = match &brief {
        SessionEvent::DelegateBrief {
            delegate_task_id, ..
        } => delegate_task_id.clone(),
        _ => unreachable!(),
    };
    mgr.respond_delegate(
        &rid,
        "s-m1",
        DelegateHostMsg::Launch {
            backend: "fake".into(),
            brief: None,
        },
    )
    .unwrap();
    let report = turn.join().unwrap().unwrap();
    assert!(!report.paused);

    // 后台完成 → 定向审查通过（经 hub，无 session_hint）
    wait_event(&sink, 5_000, |e| {
        matches!(e, SessionEvent::DelegateEnd { exit_code: 0, .. })
    })
    .expect("后台 end");
    assert!(
        mgr.respond_delegate(&rid, "", DelegateHostMsg::Review { accept: true })
            .is_ok(),
        "后台 run 应可无 session 定向路由"
    );
    for _ in 0..500 {
        if events_of(&sink)
            .iter()
            .any(|e| matches!(e, SessionEvent::DelegateReviewResolved { decision, .. } if decision == "accept"))
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    // 下一轮 run_turn：join 自动注入主上下文（捕获模型消息可见）
    mgr.run_turn("s-m1", "总结一下").unwrap();
    let seen = model.seen.lock().unwrap().clone();
    // inject_delegate_join 以 Round::Tool(name=delegate.join) 入 history，
    // 组装后 tool 消息 tool_call_id=name:run_id、content=摘要
    let injected = seen.iter().any(|msgs| {
        msgs.iter().any(|m| {
            m.tool_call_id
                .as_deref()
                .is_some_and(|t| t.starts_with("delegate.join:"))
                && m.content.contains("委派完成")
        })
    });
    assert!(injected, "下一轮模型请求应包含委派产物回填");

    // 未知 run 定向：不再广播误投，明确 NotFound
    assert!(mgr
        .respond_delegate("r-404", "", DelegateHostMsg::Review { accept: true })
        .is_err());
    mgr.end("s-m1", "").unwrap();
}
