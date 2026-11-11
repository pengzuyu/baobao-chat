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
use bbrt_session::{SkillEntry, SkillIndex};

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
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-skl".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );

    // 命中轮
    runner.run_turn("帮我报销上次的差旅费", &deps, None);
    // 未命中轮
    runner.run_turn("今天天气怎么样", &deps, None);

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

// ---------------------------------------------------------------------------
// pick_tools 工具面收紧（10 篇 §4.6 条件①）
// ---------------------------------------------------------------------------

/// 记录 req.tools 名集的模型（首轮文本收尾）
struct ToolsCaptureModel(std::sync::Mutex<Vec<Vec<String>>>, AtomicUsize);
impl ChatClient for ToolsCaptureModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        self.0
            .lock()
            .unwrap()
            .push(req.tools.iter().map(|t| t.name.clone()).collect());
        let n = self.1.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "收到".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 4,
                        completion_tokens: 1,
                    },
                }),
            ]
        } else {
            vec![Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 4,
                    completion_tokens: 1,
                },
            })]
        };
        Ok(Box::new(events.into_iter()))
    }
}

/// 三工具注册表（read_file/list_dir/search_files）
struct ThreeTools;
impl ToolExecutor for ThreeTools {
    fn check(&self, _m: PermissionMode, _c: &ToolInvocation) -> CheckOutcome {
        CheckOutcome::Allow {
            source: "matrix".into(),
        }
    }
    fn execute(&self, _m: PermissionMode, _c: &ToolInvocation) -> ToolOutcome {
        ToolOutcome::Ok {
            summary: "ok".into(),
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
        ["read_file", "list_dir", "search_files"]
            .into_iter()
            .map(|n| ToolSpec {
                name: n.into(),
                description: "t".into(),
                input_schema: serde_json::json!({"type":"object"}),
            })
            .collect()
    }
}

/// 命中技能全体声明 allowedTools → tools 收紧到并集
#[test]
fn pick_tools_narrows_to_declared_union() {
    let skills = SkillIndex {
        entries: vec![
            SkillEntry {
                name: "deploy".into(),
                triggers: vec!["部署".into()],
                allowed_tools: vec!["read_file".into()],
                risk: "low".into(),
                body: "部署流程".into(),
                dir: "/tmp/skills/deploy".into(),
            },
            SkillEntry {
                name: "audit".into(),
                triggers: vec!["部署".into()], // 同 trigger 双技能并集
                allowed_tools: vec!["search_files".into()],
                risk: "low".into(),
                body: "审计流程".into(),
                dir: "/tmp/skills/audit".into(),
            },
        ],
    };
    let model = Arc::new(ToolsCaptureModel(
        std::sync::Mutex::new(vec![]),
        AtomicUsize::new(0),
    ));
    let deps = LoopDeps {
        model: model.clone(),
        tools: Arc::new(ThreeTools),
        delegator: None,
        memory: None,
        wal: Arc::new(bbrt_session::loop_runner::NoopEventLog),
        sink: Arc::new(CollectSink(std::sync::Mutex::new(vec![]))),
        snapshots: None,
        skills: Arc::new(Mutex::new(skills)),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = bbrt_session::loop_runner::SessionRunner::new(
        "s-pick".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.run_turn("帮我部署服务", &deps, None);
    let seen = model.0.lock().unwrap().clone();
    assert!(!seen.is_empty());
    // 收紧：并集 {read_file, search_files}，不含 list_dir
    assert!(
        seen.iter()
            .all(|names| names.contains(&"read_file".to_string())
                && names.contains(&"search_files".to_string())
                && !names.contains(&"list_dir".to_string())),
        "工具面应收紧到并集: {seen:?}"
    );
}

/// 命中技能未声明 allowedTools → 不收紧（全量）
#[test]
fn pick_tools_keeps_full_when_undeclared() {
    let skills = SkillIndex {
        entries: vec![SkillEntry {
            name: "free".into(),
            triggers: vec!["自由".into()],
            allowed_tools: vec![], // 未声明=全量语义
            risk: "low".into(),
            body: "不限工具".into(),
            dir: "/tmp/skills/free".into(),
        }],
    };
    let model = Arc::new(ToolsCaptureModel(
        std::sync::Mutex::new(vec![]),
        AtomicUsize::new(0),
    ));
    let deps = LoopDeps {
        model: model.clone(),
        tools: Arc::new(ThreeTools),
        delegator: None,
        memory: None,
        wal: Arc::new(bbrt_session::loop_runner::NoopEventLog),
        sink: Arc::new(CollectSink(std::sync::Mutex::new(vec![]))),
        snapshots: None,
        skills: Arc::new(Mutex::new(skills)),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = bbrt_session::loop_runner::SessionRunner::new(
        "s-pick2".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
        None,
    );
    runner.run_turn("自由发挥", &deps, None);
    let seen = model.0.lock().unwrap().clone();
    assert!(seen.iter().all(|n| n.len() == 3), "未声明不收紧: {seen:?}");
}
