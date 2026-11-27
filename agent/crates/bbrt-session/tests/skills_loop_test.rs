//! 技能目录区 loop 集成（D33 §3.1：技能加载改显式 `skill` 工具调用——
//! 组装只放全量目录引导，隐式触发词注入退役；工具面收紧随显式调用
//! 阶段二重接线，本轮恒不限制）。
//!
//! 历史：2026-11-17 前本文件验证「triggers 命中正文自动注入 + allowedTools
//! 收紧」——随机制退役改写（口径见 D33 拍板 #2）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_context::BudgetConfig;
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{SessionEvent, SessionSink};
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
            self.0.lock().unwrap().push(m.content.text().to_string());
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
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else {
            vec![Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 5,
                    completion_tokens: 1,
                    cached_tokens: None,
                },
                model: None,
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

/// D33：[技能] 段=全量目录引导（引导句 + name：description）——正文不因
/// trigger 关键词注入（显式 skill 工具加载才取正文）；两轮目录一致
#[test]
fn skill_catalog_listed_in_system_only() {
    let eco = eco_with_skill();
    let captured = Arc::new(Mutex::new(vec![]));
    let deps = LoopDeps {
        model: Arc::new(CaptureModel(captured.clone(), AtomicUsize::new(0))),
        tools: Arc::new(NoopTools),
        memory: None,
        wal: Arc::new(NoopEventLog),
        sink: Arc::new(CollectSink(Mutex::new(vec![]))),
        skills: Arc::new(Mutex::new(SkillIndex::scan(&eco))),
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new("s-skl".into(), "/ws".into(), PermissionMode::Ask, None);

    // 「命中」关键词轮（旧机制会注入正文——新口径同样只有目录）
    runner.run_turn("帮我报销上次的差旅费", &deps, None);
    // 无关轮
    runner.run_turn("今天天气怎么样", &deps, None);

    let systems = captured.lock().unwrap().clone();
    assert_eq!(systems.len(), 2, "两轮各一次模型调用");
    for sys in &systems {
        assert!(
            sys.contains("[Skills]") && sys.contains("skill tool") && sys.contains("报销助手"),
            "目录区应含引导句与技能名: {sys}"
        );
        assert!(
            !sys.contains("报销三步"),
            "正文不因 trigger 注入（显式调用才加载）: {sys}"
        );
    }

    let _ = std::fs::remove_dir_all(&eco);
}

// ---------------------------------------------------------------------------
// 工具面（10 篇 §4.6 pick_tools——D33：随隐式注入退役恒不收紧）
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
                        cached_tokens: None,
                    },
                    model: None,
                }),
            ]
        } else {
            vec![Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 4,
                    completion_tokens: 1,
                    cached_tokens: None,
                },
                model: None,
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

/// D33：技能声明 allowedTools 也不收紧（旧「命中并集收紧」随隐式注入退役；
/// 收紧随显式 skill 调用阶段二重接线）
#[test]
fn pick_tools_not_narrowed_by_skill_declarations() {
    let skills = SkillIndex {
        entries: vec![
            SkillEntry {
                name: "deploy".into(),
                description: String::new(),
                triggers: vec!["部署".into()],
                allowed_tools: vec!["read_file".into()],
                risk: "low".into(),
                body: "部署流程".into(),
                dir: "/tmp/skills/deploy".into(),
            },
            SkillEntry {
                name: "audit".into(),
                description: String::new(),
                triggers: vec!["部署".into()],
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
        memory: None,
        wal: Arc::new(bbrt_session::loop_runner::NoopEventLog),
        sink: Arc::new(CollectSink(std::sync::Mutex::new(vec![]))),
        skills: Arc::new(Mutex::new(skills)),
        budget: BudgetConfig::default(),
    };
    let mut runner = bbrt_session::loop_runner::SessionRunner::new(
        "s-pick".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        None,
    );
    runner.run_turn("帮我部署服务", &deps, None);
    let seen = model.0.lock().unwrap().clone();
    assert!(!seen.is_empty());
    assert!(
        seen.iter().all(|names| names.len() == 3),
        "D33：不因技能声明收紧（全量三工具）: {seen:?}"
    );
}

/// 未声明 allowedTools → 全量（口径不变，回归护栏）
#[test]
fn pick_tools_keeps_full_when_undeclared() {
    let skills = SkillIndex {
        entries: vec![SkillEntry {
            name: "free".into(),
            description: String::new(),
            triggers: vec!["自由".into()],
            allowed_tools: vec![],
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
        memory: None,
        wal: Arc::new(bbrt_session::loop_runner::NoopEventLog),
        sink: Arc::new(CollectSink(std::sync::Mutex::new(vec![]))),
        skills: Arc::new(Mutex::new(skills)),
        budget: BudgetConfig::default(),
    };
    let mut runner = bbrt_session::loop_runner::SessionRunner::new(
        "s-pick2".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        None,
    );
    runner.run_turn("自由发挥", &deps, None);
    let seen = model.0.lock().unwrap().clone();
    assert!(seen.iter().all(|n| n.len() == 3), "未声明不收紧: {seen:?}");
}
