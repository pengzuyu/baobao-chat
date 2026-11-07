//! 技能注入 loop 集成：triggers 命中的技能正文进 system 消息 [技能] 段
//! （10 篇 §4.5 / 08 篇 §4.3 预算），未命中不注入。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_context::BudgetConfig;
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{ModelTier, SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::loop_runner::{LoopDeps, NoopEventLog, SessionRunner};
use bbrt_session::SkillIndex;

struct CollectSink(Mutex<Vec<SessionEvent>>);
impl SessionSink for CollectSink {
    fn emit(&self, evt: SessionEvent) {
        self.0.lock().unwrap().push(evt);
    }
}

/// 假模型：捕获 system 消息，首轮纯文本收尾
struct CaptureModel(Arc<Mutex<Vec<String>>>, AtomicUsize);
impl ChatClient for CaptureModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        if let Some(m) = req.messages.first() {
            self.0.lock().unwrap().push(m.content.clone());
        }
        let n = self.1.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "好的".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 5,
                        completion_tokens: 1,
                    },
                }),
            ]
        } else {
            vec![Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 5,
                    completion_tokens: 1,
                },
            })]
        };
        Ok(Box::new(events.into_iter()))
    }
}

struct NoopTools;
impl ToolExecutor for NoopTools {
    fn check(&self, _m: PermissionMode, _c: &ToolInvocation) -> CheckOutcome {
        CheckOutcome::Allow {
            source: "matrix".into(),
        }
    }
    fn execute(&self, _m: PermissionMode, _c: &ToolInvocation) -> ToolOutcome {
        ToolOutcome::Ok {
            summary: String::new(),
            truncated: false,
            exit_code: Some(0),
            duration_ms: 0,
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
        vec![]
    }
}

fn eco_with_skill() -> std::path::PathBuf {
    let eco = std::env::temp_dir().join(format!(
        "bbrt-skill-loop-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let dir = eco.join("expense");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: 报销助手\ntriggers: [报销]\nallowedTools: [oa.todo.list]\n---\n报销三步：填单、贴票、提交审批。",
    )
    .unwrap();
    eco
}

/// 命中轮：[技能] 段含技能名与正文；未命中轮：[技能] 段为空。
#[test]
fn skill_body_injected_on_trigger_only() {
    let eco = eco_with_skill();
    let captured = Arc::new(Mutex::new(vec![]));
    let deps = LoopDeps {
        model: Arc::new(CaptureModel(captured.clone(), AtomicUsize::new(0))),
        tools: Arc::new(NoopTools),
        delegator: None,
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink: Arc::new(CollectSink(Mutex::new(vec![]))),
        snapshots: None,
        skills: Arc::new(Mutex::new(SkillIndex::scan(&eco))),
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-skl".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
    );

    // 命中轮
    runner.run_turn("帮我报销上次的差旅费", &deps);
    // 未命中轮
    runner.run_turn("今天天气怎么样", &deps);

    let systems = captured.lock().unwrap().clone();
    assert_eq!(systems.len(), 2, "两轮各一次模型调用");
    assert!(
        systems[0].contains("[技能]")
            && systems[0].contains("报销助手")
            && systems[0].contains("报销三步"),
        "命中轮应注入技能正文: {}",
        systems[0]
    );
    assert!(!systems[1].contains("报销三步"), "未命中轮不应注入技能正文");

    let _ = std::fs::remove_dir_all(&eco);
}
