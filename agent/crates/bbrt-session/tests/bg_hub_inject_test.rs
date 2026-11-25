//! 后台任务中枢注入链测试（顶替原 delegate_bg_test 的 manager 注入覆盖——
//! 外部 CLI 委派域已退役 2026-11-18，park→drain→inject_bg_join 的通用链路
//! 改以内部子 agent 形态验证；另覆盖 respond_run_cancel 的 NotFound 语义）。

use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_sec::gate::PermissionMode;
use bbrt_session::bg_hub::{BgHub, BgJoin};
use bbrt_session::events::{ModelTier, SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::loop_runner::{BgHostMsg, LoopDeps, NoopEventLog, SessionRunner};
use bbrt_session::manager::{SessionManager, StartParams};

/// 收集 sink
#[derive(Default)]
struct CollectSink(Mutex<Vec<SessionEvent>>);
impl SessionSink for CollectSink {
    fn emit(&self, evt: SessionEvent) {
        self.0.lock().unwrap().push(evt);
    }
}

/// 消息捕获模型：记录每轮收到的完整消息序列（断言注入轮次用）
struct CaptureModel {
    #[allow(dead_code)]
    calls: AtomicUsize,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
}
impl ChatClient for CaptureModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        self.seen.lock().unwrap().push(req.messages.clone());
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::TextDelta {
                text: "收到。".into(),
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
        ];
        Ok(Box::new(events.into_iter()))
    }
}

/// 最小工具执行器（本套件不真正执行工具）
struct NopTools;
impl ToolExecutor for NopTools {
    fn check(&self, _mode: PermissionMode, _call: &ToolInvocation) -> CheckOutcome {
        CheckOutcome::Allow {
            source: String::new(),
        }
    }
    fn execute(&self, _mode: PermissionMode, _call: &ToolInvocation) -> ToolOutcome {
        ToolOutcome::Ok {
            summary: "ok".into(),
            truncated: false,
            exit_code: None,
            duration_ms: 0,
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

fn deps(model: Arc<CaptureModel>, sink: Arc<CollectSink>) -> LoopDeps {
    LoopDeps {
        model,
        tools: Arc::new(NopTools),
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: Default::default(),
    }
}

/// park→drain→inject_bg_join→下一轮组装：后台完成的内部子 agent 摘要以
/// subagent.join 轮次进入模型消息（tool_call_id=name:run_id、content=摘要）
#[test]
fn hub_park_drain_inject_feeds_model_next_turn() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(CaptureModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(vec![]),
    });
    let d = deps(model.clone(), sink.clone());
    let mut runner = SessionRunner::new(
        "s-inj".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    let _ = runner.run_turn("先干活", &d, None);

    // 后台 run 完成 park → manager 语义在此以 runner 级等价呈现：
    // drain_joins 取走 + inject_bg_join 回填 history
    let hub = Arc::new(BgHub::new());
    hub.park_join(
        "s-inj",
        BgJoin {
            name: "subagent.join".into(),
            run_id: "agent-9f1e2d3c".into(),
            summary: "探查完成：定位到 3 处疑似超时来源".into(),
        },
    );
    for join in hub.drain_joins("s-inj") {
        runner.inject_bg_join(&join.run_id, &join.name, &join.summary);
    }
    assert!(hub.drain_joins("s-inj").is_empty(), "drain 一次性取走");

    // 下一轮：注入轮次应出现在模型消息里
    let _ = runner.run_turn("总结一下", &d, None);
    let seen = model.seen.lock().unwrap().clone();
    let injected = seen.iter().any(|msgs| {
        msgs.iter().any(|m| {
            m.tool_call_id
                .as_deref()
                .is_some_and(|t| t.starts_with("subagent.join:agent-9f1e2d3c"))
                && m.content.contains("定位到 3 处")
        })
    });
    assert!(injected, "下一轮模型请求应包含后台产物回填：{seen:?}");
}

/// 宿主取消路由：未知/已结束 run 明确 NotFound（run.cancel 经
/// SessionManager::respond_run_cancel；命中注册表路径由 loop_tests 的
/// terminal 后台用例覆盖）
#[test]
fn manager_run_cancel_unknown_run_not_found() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(CaptureModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(vec![]),
    });
    let mgr = SessionManager::new(deps(model, sink), None);
    mgr.start(
        "s-c1".into(),
        StartParams {
            workspace: "/ws".into(),
            mode: PermissionMode::AutoEdit,
            model_policy: ModelTier::Strong,
            model_override: None,
            title: "取消路由".into(),
            restored: None,
            unattended: false,
            scene: Default::default(),
        },
    )
    .unwrap();
    assert!(mgr
        .respond_run_cancel("agent-404", BgHostMsg::Cancel { graceful: true })
        .is_err());
    mgr.end("s-c1", "").unwrap();
}

/// interrupt 传导后台任务（2026-11-24 修复「主停子不停」）：点停止=主旗 +
/// 本会话全部后台 run 优雅取消；其他会话的后台 run 不受影响（会话隔离）。
/// 旧实现只置主旗，probe/expert/terminal 后台 run 继续跑完。
#[test]
fn interrupt_cancels_session_background_runs_only() {
    let sink = Arc::new(CollectSink::default());
    let model = Arc::new(CaptureModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(vec![]),
    });
    let mgr = SessionManager::new(deps(model, sink), None);
    let params = |title: &str| StartParams {
        workspace: "/ws".into(),
        mode: PermissionMode::AutoEdit,
        model_policy: ModelTier::Strong,
        model_override: None,
        title: title.into(),
        restored: None,
        unattended: false,
        scene: Default::default(),
    };
    mgr.start("s-i1".into(), params("中断传导")).unwrap();
    mgr.start("s-i2".into(), params("旁观会话")).unwrap();
    // 直注两个后台 run（生产由 runner 在执行前注册；此处只验中枢传导语义）
    let (tx1, rx1) = std::sync::mpsc::channel();
    let (tx2, rx2) = std::sync::mpsc::channel();
    mgr.bg_hub().register("agent-aaa1", "s-i1", tx1);
    mgr.bg_hub().register("agent-aaa2", "s-i2", tx2);

    mgr.interrupt("s-i1").unwrap();
    assert!(
        matches!(
            rx1.recv_timeout(std::time::Duration::from_millis(500)),
            Ok(BgHostMsg::Cancel { graceful: true })
        ),
        "本会话后台 run 应收到优雅取消"
    );
    assert!(
        rx2.recv_timeout(std::time::Duration::from_millis(200)).is_err(),
        "其他会话的后台 run 不受影响"
    );
    mgr.end("s-i1", "").unwrap();
    mgr.end("s-i2", "").unwrap();
}
