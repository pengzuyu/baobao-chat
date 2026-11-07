//! 协作图编排集成（D14 §3 会诊型）：双专家并行 Activation（独立上下文/
//! 角色位简报）→ WAL team.start/joined 审计 → 摘要聚合；单节点失败/
//! 超步不阻塞其余节点。

use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::expert::{assemble, parse_manifest, AssemblePolicy, ExpertCtx};
use bbrt_session::loop_runner::EventLog;
use bbrt_session::team::{run_team, validate_graph, TeamError, TeamGraph, TeamMember};
use bbrt_session::SkillIndex;

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

/// 剧本模型：按 system 中 persona 标记分派——"安全专家"直接文本收尾；
/// "性能专家"永远工具调用（超步自杀路径）。记录各窗口收到的简报
/// （验证角色位黑板：含共享任务与角色提示，无主历史）
struct TeamModel {
    seen: Mutex<Vec<String>>,
}
impl ChatClient for TeamModel {
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
        // 黑板断言口径：system(persona) + user(共享简报) 拼接记录
        let m1 = req
            .messages
            .get(1)
            .map(|m| m.content.clone())
            .unwrap_or_default();
        self.seen.lock().unwrap().push(format!("{m0}\n{m1}"));
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if m0.contains("安全人设")
        {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "安全结论：无阻断项，1 处建议。".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 6,
                        completion_tokens: 4,
                    },
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "tc-1".into(),
                    name: "git_diff".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "{}".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: Usage {
                        prompt_tokens: 6,
                        completion_tokens: 2,
                    },
                }),
            ]
        };
        Ok(Box::new(events.into_iter()))
    }
}

struct AllowTools;
impl ToolExecutor for AllowTools {
    fn check(&self, _m: PermissionMode, _c: &ToolInvocation) -> CheckOutcome {
        CheckOutcome::Allow {
            source: "matrix".into(),
        }
    }
    fn execute(&self, _m: PermissionMode, _c: &ToolInvocation) -> ToolOutcome {
        ToolOutcome::Ok {
            summary: "diff 1 文件".into(),
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
        vec![ToolSpec {
            name: "git_diff".into(),
            description: "diff".into(),
            input_schema: serde_json::json!({"type":"object"}),
        }]
    }
}

fn member(label: &str, persona_mark: &str, max_steps: usize) -> TeamMember {
    let text = format!(
        "id: corp.{label}\ntype: local\nversion: 1.0.0\ndisplay: {label}专家\npersona: |\n  {persona_mark}\ntools:\n  builtin: [git_diff]\nconstraints:\n  max_steps: {max_steps}\n  write_policy: readonly\nsource: company\n"
    );
    let m = parse_manifest(&text).unwrap();
    let a = assemble(
        &m,
        &AllowTools.tool_specs(),
        &SkillIndex::default(),
        &AssemblePolicy::default(),
    );
    TeamMember {
        label: label.into(),
        expert: Arc::new(a),
    }
}

/// 双专家会诊：并行 Activation（安全=ok / 性能=超步 fail）→ 单败不阻塞 →
/// WAL team.start→[2×expert.activate/joined]→team.joined → 摘要含双结论
#[test]
fn team_consult_full_chain() {
    let model = TeamModel {
        seen: Mutex::new(vec![]),
    };
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let tools = AllowTools;
    let graph = TeamGraph {
        task: "评审 PR#42 的改动".into(),
        members: vec![
            member("security", "安全人设：审查注入面。", 10),
            member("perf", "性能人设：查热点循环。", 2), // 2 步即超步自杀
        ],
    };

    let result = run_team(
        &ExpertCtx {
            model: &model,
            tools: &tools,
            mode: PermissionMode::AutoEdit,
        },
        "sess-team-1",
        &graph,
        sink.as_ref(),
        &log,
    )
    .unwrap();

    // 单败不阻塞：安全 ok、性能 fail（超步）
    assert_eq!(result.failed, vec!["perf"]);
    let sec = result.nodes.iter().find(|n| n.label == "security").unwrap();
    assert!(sec.result.ok && sec.result.summary.contains("安全结论"));
    let perf = result.nodes.iter().find(|n| n.label == "perf").unwrap();
    assert!(!perf.result.ok && perf.result.summary.contains("超步自杀"));
    // 摘要：双结论折叠 + fail 标注
    assert!(result.summary.contains("协作图汇总（2 个节点）"));
    assert!(result.summary.contains("[ok] security"));
    assert!(result.summary.contains("[fail] perf"));
    assert!(result.run_id.starts_with("team-"));
    // 黑板：两窗口简报均含共享任务与各自角色位，无主历史
    let seen = model.seen.lock().unwrap().clone();
    assert!(seen.len() >= 2);
    assert!(seen.iter().all(|s| s.contains("评审 PR#42 的改动")));
    // WAL 序列：team.start → 2×(expert.activate + expert.done/fail) → team.joined
    let entries = log.0.lock().unwrap().clone();
    let types: Vec<&str> = entries.iter().map(|(_, t, _)| t.as_str()).collect();
    assert_eq!(types.first(), Some(&"team.start"));
    assert_eq!(types.last(), Some(&"team.joined"));
    assert_eq!(types.iter().filter(|t| **t == "expert.activate").count(), 2);
    let joined = entries.last().unwrap().2.clone();
    assert!(joined.contains("\"total\":2") && joined.contains("\"ok\":1"));
    // 协议事件复用 subagent.*（2 spawn + 2 probe evt）
    let events = sink.0.lock().unwrap();
    let spawns = events
        .iter()
        .filter(|e| matches!(e, SessionEvent::SubagentSpawned { .. }))
        .count();
    assert_eq!(spawns, 2);
}

/// 图校验拒绝在 Activation 前（WAL 零写入）
#[test]
fn team_invalid_graph_no_activation() {
    let model = TeamModel {
        seen: Mutex::new(vec![]),
    };
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    // 4×40=160 > 120
    let graph = TeamGraph {
        task: "过重".into(),
        members: vec![
            member("a", "安全人设：x。", 40),
            member("b", "安全人设：x。", 40),
            member("c", "安全人设：x。", 40),
            member("d", "安全人设：x。", 40),
        ],
    };
    assert_eq!(
        run_team(
            &ExpertCtx {
                model: &model,
                tools: &AllowTools,
                mode: PermissionMode::AutoEdit,
            },
            "sess-team-2",
            &graph,
            sink.as_ref(),
            &log,
        )
        .unwrap_err(),
        TeamError::TotalStepsExceeded
    );
    assert!(log.0.lock().unwrap().is_empty(), "校验拒绝不得写 WAL");
    assert!(sink.0.lock().unwrap().is_empty());
    assert_eq!(validate_graph(&graph), Err(TeamError::TotalStepsExceeded));
}
