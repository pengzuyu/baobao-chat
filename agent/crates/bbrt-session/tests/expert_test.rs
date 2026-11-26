//! 专家装配器集成（D14）：manifest 装配过滤（§6.3 防线一）→ 受限子会话
//! mini-loop（§3.2：独立上下文/档位路由/步数与预算上限/WAL expert.* 审计流）。

use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::expert::{
    assemble, parse_manifest, run_expert, AssemblePolicy, ExpertCtx, ExpertIndex,
};
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
            .map(|m| m.content.text().to_string())
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
                        cached_tokens: None,
                    },
                    model: None,
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
                        cached_tokens: None,
                    },
                    model: None,
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
            description: String::new(),
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

    assert_eq!(a.model, "bbc-strong");
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

/// 受限子会话全链：独立上下文（persona system、无主历史）+ bbc-strong 路由
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
    let model = Arc::new(ScriptModel {
        seen: Mutex::new(vec![]),
        always_tool: false,
    });
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();

    let r = run_expert(
        &ExpertCtx {
            model: model.clone(),
            tools: tools.clone(),
            mode: PermissionMode::AutoEdit,
            hub: None,
            unattended: false,
        },
        "sess-1",
        &a,
        "评审 PR #42 的改动",
        sink.as_ref(),
        &log,
        "", // parent_run_id（顶层调用，无父 run）
    );

    assert!(r.ok);
    assert!(r.summary.contains("阻断问题"));
    assert!(r.persona_id == "corp.code-reviewer");
    assert!(r.run_id.starts_with("act-"), "未接 Store 退回进程内临时 id");
    // 独立上下文与档位路由
    let seen = model.seen.lock().unwrap().clone();
    assert!(seen
        .iter()
        .all(|(s, model_)| s.contains("资深评审员") && model_ == "bbc-strong"));
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
    let model = Arc::new(ScriptModel {
        seen: Mutex::new(vec![]),
        always_tool: true,
    });
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();

    let r = run_expert(
        &ExpertCtx {
            model: model.clone(),
            tools: tools.clone(),
            mode: PermissionMode::AutoEdit,
            hub: None,
            unattended: false,
        },
        "sess-2",
        &a,
        "评审",
        sink.as_ref(),
        &log,
        "", // parent_run_id（顶层调用，无父 run）
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
    let model = Arc::new(ScriptModel {
        seen: Mutex::new(vec![]),
        always_tool: false,
    });
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();

    let r = run_expert(
        &ExpertCtx {
            model: model.clone(),
            tools: tools.clone(),
            mode: PermissionMode::AutoEdit,
            hub: None,
            unattended: false,
        },
        "sess-3",
        &a,
        "评审",
        sink.as_ref(),
        &log,
        "", // parent_run_id（顶层调用，无父 run）
    );

    assert!(!r.ok);
    assert!(r.summary.contains("超上下文预算"));
    // 未消耗模型轮（预算检查先于请求）
    assert!(model.seen.lock().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// 专家库索引（D14 §3.3 单专家选角的数据源）
// ---------------------------------------------------------------------------

fn yaml_for(id: &str, display: &str) -> String {
    format!(
        "id: {id}\ntype: local\nversion: 1.0.0\ndisplay: {display}\npersona: |\n  {display}视角。\nconstraints:\n  max_steps: 20\nsource: company\n"
    )
}

fn scan_dir(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (name, body) in files {
        std::fs::write(dir.path().join(name), body).unwrap();
    }
    dir
}

/// ExpertIndex：合法/非法混合扫描（失败跳过不阻塞）+ 按 id 取
#[test]
fn expert_index_scan() {
    let dir = scan_dir(&[
        ("a.yaml", &yaml_for("corp.sec", "安全专家")),
        ("b.yaml", &yaml_for("corp.perf", "性能专家")),
        ("broken.yaml", "id: 坏的\n缺必填: true\n"),
        ("c.txt", "非 yaml 扩展"),
    ]);
    let idx = ExpertIndex::scan(dir.path());
    assert_eq!(idx.manifests.len(), 2, "坏文件跳过、非 yaml 忽略");
    assert!(idx.get("corp.sec").is_some());
    assert!(idx.get("不存在").is_none());
    // 目录缺失=空索引
    assert!(ExpertIndex::scan(std::path::Path::new("/nonexistent"))
        .manifests
        .is_empty());
}

/// ExpertIndex::scan：{id}.override.yaml 合并进 manifest；坏覆写降级沿用建议配置
#[test]
fn expert_index_merges_override_files() {
    let dir = tempfile::tempdir().unwrap();
    let edir = dir.path().join("experts");
    std::fs::create_dir_all(&edir).unwrap();
    std::fs::write(
        edir.join("corp.demo.yaml"),
        "id: corp.demo\ntype: local\nversion: 1.0.0\ndisplay: 演示\npersona: |\n  干活\nconstraints:\n  max_steps: 20\nsource: company\n",
    )
    .unwrap();
    std::fs::write(
        edir.join("corp.demo.override.yaml"),
        "tools:\n  builtin: [read_file]\nconstraints:\n  max_steps: 80\nmodel: { tier: fast }\n",
    )
    .unwrap();
    std::fs::write(edir.join("corp.bad.override.yaml"), "persona: |\n  x\n").unwrap();

    let idx = ExpertIndex::scan(&edir);
    assert_eq!(idx.manifests.len(), 1, "坏覆写不产生专家行");
    let m = idx.get("corp.demo").unwrap();
    assert_eq!(m.constraints.max_steps, 80, "覆写调参生效");
    assert_eq!(m.model_tier, "fast");
    assert!(
        m.tools.builtin.contains(&"read_file".to_string()),
        "覆写加工具生效"
    );
}
