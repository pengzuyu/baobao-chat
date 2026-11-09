//! 专家装配器集成（D14）：manifest 装配过滤（§6.3 防线一）→ 受限子会话
//! mini-loop（§3.2：独立上下文/档位路由/步数与预算上限/WAL expert.* 审计流）。

use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::expert::{assemble, parse_manifest, run_expert, AssemblePolicy, ExpertCtx};
use bbrt_session::loop_runner::EventLog;
use bbrt_session::{SkillEntry, SkillIndex};

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

/// 剧本模型：识别专家 system（persona 标记）→ 首轮工具调用 → 见结果收尾；
/// 记录收到的 system/model（验证独立上下文与档位路由）
struct ScriptModel {
    seen: Mutex<Vec<(String, String)>>, // (system 首条, model)
    always_tool: bool,
}
impl ChatClient for ScriptModel {
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
            .map(|m| m.content.clone())
            .unwrap_or_default();
        self.seen
            .lock()
            .unwrap()
            .push((m0.clone(), req.model.clone()));
        let is_expert = m0.contains("资深评审员");
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if !is_expert {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "非专家窗口不应被调用".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 4,
                        completion_tokens: 2,
                    },
                }),
            ]
        } else if self.always_tool || req.messages.len() <= 2 {
            vec![
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "ec-1".into(),
                    name: "git_diff".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "{\"ref\":\"HEAD~1\"}".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: Usage {
                        prompt_tokens: 6,
                        completion_tokens: 2,
                    },
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "阻断问题：无。建议：2 处命名。风险评级：低。".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 6,
                        completion_tokens: 4,
                    },
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
            summary: "diff 3 文件".into(),
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
        ["read_file", "search_files", "git_diff", "kb.search"]
            .into_iter()
            .map(|n| ToolSpec {
                name: n.into(),
                description: "工具".into(),
                input_schema: serde_json::json!({"type":"object"}),
            })
            .collect()
    }
}

const MANIFEST: &str = "\
id: corp.code-reviewer
type: local
version: 1.2.0
display: 代码评审专家
persona: |
  你是资深评审员。输出：阻断问题/建议/风险评级三段结构。
tools:
  builtin: [read_file, git_diff, run_command]
  mcp:    [kb.search, oa.lookup]
skills: [corp.review-standards]
constraints:
  max_steps: 40
  write_policy: readonly
model: { tier: strong }
source: company
";

fn skill_index() -> SkillIndex {
    SkillIndex {
        entries: vec![SkillEntry {
            name: "corp.review-standards".into(),
            triggers: vec![],
            allowed_tools: vec![],
            risk: "low".into(),
            body: "评审基线：圈复杂度>15 阻断。".into(),
            dir: "/tmp/skills/review".into(),
        }],
    }
}

/// 装配过滤：未注册/策略禁用剔除入 dropped，已装技能注入 system，
/// run_command 不因 readonly 被装配层剔除（§8-1 门控管）
#[test]
fn assemble_filters_and_builds_system() {
    let m = parse_manifest(MANIFEST).unwrap();
    let policy = AssemblePolicy {
        deny_tools: vec!["oa.*".into()],
    };
    let a = assemble(
        &m,
        &AllowTools(Mutex::new(vec![])).tool_specs(),
        &skill_index(),
        &policy,
    );

    // 声明 5 项：run_command 未注册、oa.lookup 未注册+策略禁用 → 留 3
    assert_eq!(a.tool_names, vec!["read_file", "git_diff", "kb.search"]);
    let dropped_names: Vec<&str> = a.dropped_tools.iter().map(|d| d.name.as_str()).collect();
    assert!(dropped_names.contains(&"run_command"));
    assert!(dropped_names.contains(&"oa.lookup"));
    assert!(a.dropped_skills.is_empty());

    assert_eq!(a.model, "bbw-strong");
    assert_eq!(a.max_steps, 40);
    // system：persona + 技能正文 + 约束引导 + 知识视野缺省无
    assert!(a.system_prompt.contains("资深评审员"));
    assert!(a.system_prompt.contains("评审基线：圈复杂度>15 阻断。"));
    assert!(a.system_prompt.contains("readonly：产出结构化结论"));
}

/// 技能未安装：剔除入 dropped_skills，system 不含其正文
#[test]
fn assemble_drops_uninstalled_skill() {
    let m = parse_manifest(MANIFEST).unwrap();
    let a = assemble(
        &m,
        &AllowTools(Mutex::new(vec![])).tool_specs(),
        &SkillIndex::default(),
        &AssemblePolicy::default(),
    );
    assert_eq!(a.dropped_skills.len(), 1);
    assert_eq!(a.dropped_skills[0].name, "corp.review-standards");
    assert!(!a.system_prompt.contains("评审基线"));
}

/// 受限子会话全链：独立上下文（persona system、无主历史）+ bbw-strong 路由
/// + 工具真实执行（仅白名单）+ WAL expert.activate/done 审计流（act 值域）
#[test]
fn run_expert_full_chain() {
    let m = parse_manifest(MANIFEST).unwrap();
    let tools = Arc::new(AllowTools(Mutex::new(vec![])));
    let a = assemble(
        &m,
        &tools.tool_specs(),
        &skill_index(),
        &AssemblePolicy::default(),
    );
    let model = ScriptModel {
        seen: Mutex::new(vec![]),
        always_tool: false,
    };
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();

    let r = run_expert(
        ExpertCtx {
            model: &model,
            tools: tools.as_ref(),
            mode: PermissionMode::AutoEdit,
        },
        "sess-1",
        &a,
        "评审 PR #42 的改动",
        sink.as_ref(),
        &log,
        "", // parent_run_id（无 team 编排）
    );

    assert!(r.ok);
    assert!(r.summary.contains("阻断问题"));
    assert!(r.persona_id == "corp.code-reviewer");
    assert!(r.run_id.starts_with("act-"), "未接 Store 退回进程内临时 id");
    // 独立上下文与档位路由
    let seen = model.seen.lock().unwrap().clone();
    assert!(seen
        .iter()
        .all(|(s, model_)| s.contains("资深评审员") && model_ == "bbw-strong"));
    // 工具真实执行（经白名单子集）
    assert_eq!(*tools.0.lock().unwrap(), vec!["git_diff"]);
    // WAL：activate（act=expert:{persona}:{activation}）→ done
    let entries = log.0.lock().unwrap().clone();
    let types: Vec<&str> = entries.iter().map(|(_, t, _)| t.as_str()).collect();
    assert_eq!(types, vec!["expert.activate", "expert.done"]);
    let activate_payload = log.0.lock().unwrap()[0].2.clone();
    assert!(activate_payload.contains(&format!("\"act\":\"expert:{}:", r.persona_id)));
    // 协议事件复用 subagent.*（协议冻结不新增变体）
    let events = sink.0.lock().unwrap();
    assert!(matches!(
        events.first(),
        Some(SessionEvent::SubagentSpawned { .. })
    ));
}

/// 超步自杀：剧本永远工具调用 → max_steps 截断，fail + 部分结果
#[test]
fn run_expert_step_limit() {
    let m = parse_manifest(MANIFEST).unwrap();
    let tools = Arc::new(AllowTools(Mutex::new(vec![])));
    // max_steps=2 压小触发面
    let mut m2 = m.clone();
    m2.constraints.max_steps = 2;
    let a = assemble(
        &m2,
        &tools.tool_specs(),
        &skill_index(),
        &AssemblePolicy::default(),
    );
    let model = ScriptModel {
        seen: Mutex::new(vec![]),
        always_tool: true,
    };
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();

    let r = run_expert(
        ExpertCtx {
            model: &model,
            tools: tools.as_ref(),
            mode: PermissionMode::AutoEdit,
        },
        "sess-2",
        &a,
        "评审",
        sink.as_ref(),
        &log,
        "", // parent_run_id（无 team 编排）
    );

    assert!(!r.ok);
    assert!(r.summary.contains("超步自杀"));
    let entries = log.0.lock().unwrap().clone();
    let types: Vec<&str> = entries.iter().map(|(_, t, _)| t.as_str()).collect();
    assert_eq!(types, vec!["expert.activate", "expert.fail"]);
}

/// 超上下文预算自杀：max_context 压到 8k，剧本首轮即超 → fail（预算防线）
#[test]
fn run_expert_context_budget() {
    let text = MANIFEST.replace("max_steps: 40", "max_steps: 40\n  max_context: 8k");
    let m = parse_manifest(&text).unwrap();
    let tools = Arc::new(AllowTools(Mutex::new(vec![])));
    // persona 撑大 system 使首轮组装即超 8k
    let mut big = m.clone();
    big.persona = format!("你是资深评审员。{}\n", "审查要点细则。".repeat(1200));
    let a = assemble(
        &big,
        &tools.tool_specs(),
        &skill_index(),
        &AssemblePolicy::default(),
    );
    let model = ScriptModel {
        seen: Mutex::new(vec![]),
        always_tool: false,
    };
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();

    let r = run_expert(
        ExpertCtx {
            model: &model,
            tools: tools.as_ref(),
            mode: PermissionMode::AutoEdit,
        },
        "sess-3",
        &a,
        "评审",
        sink.as_ref(),
        &log,
        "", // parent_run_id（无 team 编排）
    );

    assert!(!r.ok);
    assert!(r.summary.contains("超上下文预算"));
    // 未消耗模型轮（预算检查先于请求）
    assert!(model.seen.lock().unwrap().is_empty());
}
