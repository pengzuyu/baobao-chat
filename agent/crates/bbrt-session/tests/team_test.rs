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
        ..Default::default()
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
        ..Default::default()
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

// ---------------------------------------------------------------------------
// 选角引擎（ExpertIndex/FastCaster）与 loop 接线
// ---------------------------------------------------------------------------

use bbrt_context::BudgetConfig;
use bbrt_session::events::ModelTier;
use bbrt_session::expert::AssembledExpert;
use bbrt_session::loop_runner::LoopDeps;
use bbrt_session::team::{ExpertIndex, ExpertSource, FastCaster};
use bbrt_session::SessionRunner;

/// 固定输出模型（选角剧本）
struct CasterModel(&'static str);
impl ChatClient for CasterModel {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::TextDelta {
                text: self.0.into(),
            }),
            Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 4,
                    completion_tokens: 2,
                },
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

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

fn fixture_assembler(m: &bbrt_session::ExpertManifest) -> AssembledExpert {
    let registry = AllowTools.tool_specs();
    let mut a = assemble(
        m,
        &registry,
        &SkillIndex::default(),
        &AssemblePolicy::default(),
    );
    a.system_prompt = m.persona.clone();
    a
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

/// FastCaster：合法 JSON 组队（label 缺省=display；重复去重）
#[test]
fn fast_caster_casts() {
    let dir = scan_dir(&[
        ("a.yaml", &yaml_for("corp.sec", "安全专家")),
        ("b.yaml", &yaml_for("corp.perf", "性能专家")),
    ]);
    let idx = ExpertIndex::scan(dir.path());
    let caster = FastCaster {
        index: idx,
        assemble_for: fixture_assembler,
    };
    let model = CasterModel(
        "{\"team\": true, \"cast\": [{\"id\": \"corp.sec\"}, {\"id\": \"corp.perf\", \"label\": \"性能\"}, {\"id\": \"corp.sec\"}]}",
    );
    let graph = caster.cast(&model, "多维度评审这个 PR").unwrap();
    assert_eq!(graph.members.len(), 2, "重复选角去重");
    assert_eq!(graph.members[0].label, "安全专家", "label 缺省=display");
    assert_eq!(graph.members[1].label, "性能");
    assert_eq!(graph.task, "多维度评审这个 PR");
}

/// FastCaster 降级矩阵：team=false / 垃圾输出 / 幻觉 id / 空库 / 超步图
#[test]
fn fast_caster_degrades() {
    let dir = scan_dir(&[
        ("a.yaml", &yaml_for("corp.sec", "安全专家")),
        ("b.yaml", &yaml_for("corp.perf", "性能专家")),
    ]);
    let caster = || FastCaster {
        index: ExpertIndex::scan(dir.path()),
        assemble_for: fixture_assembler,
    };
    // team=false
    let m = CasterModel("{\"team\": false, \"cast\": []}");
    assert!(caster().cast(&m, "单一问题").is_none());
    // 围栏 JSON 仍可解析（strip_fence）
    let m = CasterModel("```json\n{\"team\": true, \"cast\": [{\"id\": \"corp.sec\"}]}\n```");
    assert!(caster().cast(&m, "评审").is_some());
    // 垃圾输出
    let m = CasterModel("我觉得需要三个专家一起看");
    assert!(caster().cast(&m, "评审").is_none());
    // 幻觉 id（清单外专家）→ None
    let m = CasterModel("{\"team\": true, \"cast\": [{\"id\": \"corp.hallucinated\"}]}");
    assert!(caster().cast(&m, "评审").is_none());
    // 空库 → None（不消耗模型判定）
    let empty = FastCaster {
        index: ExpertIndex::default(),
        assemble_for: fixture_assembler,
    };
    assert!(empty.cast(&CasterModel("{\"team\": true}"), "x").is_none());
    // 超 4 人截断（快模型超发）→ ≤4
    let dir5 = scan_dir(&[
        ("a.yaml", &yaml_for("corp.a", "A")),
        ("b.yaml", &yaml_for("corp.b", "B")),
        ("c.yaml", &yaml_for("corp.c", "C")),
        ("d.yaml", &yaml_for("corp.d", "D")),
        ("e.yaml", &yaml_for("corp.e", "E")),
    ]);
    let cast5 = format!(
        "{{\"team\": true, \"cast\": [{}]}}",
        ["corp.a", "corp.b", "corp.c", "corp.d", "corp.e"]
            .iter()
            .map(|id| format!("{{\"id\": \"{id}\"}}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let m = CasterModel(Box::leak(cast5.into_boxed_str()));
    let graph = FastCaster {
        index: ExpertIndex::scan(dir5.path()),
        assemble_for: fixture_assembler,
    }
    .cast(&m, "大会诊")
    .unwrap();
    assert_eq!(graph.members.len(), 4, "≤4 硬顶截断");
}

/// 固定返回双专家图的假 ExpertSource（loop 接线测试：剧本专家直接文本收尾）
struct FixedTeam;
impl ExpertSource for FixedTeam {
    fn cast(&self, _model: &dyn ChatClient, user_text: &str) -> Option<TeamGraph> {
        let mk = |id: &str, display: &str, label: &str| {
            let m = parse_manifest(&yaml_for(id, display)).unwrap();
            let mut a = fixture_assembler(&m);
            a.max_steps = 5;
            TeamMember {
                label: label.into(),
                expert: Arc::new(a),
            }
        };
        Some(TeamGraph {
            task: user_text.to_string(),
            members: vec![
                mk("corp.sec", "安全人设：查注入。", "安全"),
                mk("corp.perf", "性能人设：查热点。", "性能"),
            ],
            ..Default::default()
        })
    }
}

/// loop 接线全链：选角命中 → run_team（专家并行文本收尾）→ 摘要回填
/// history（team.join）→ 主循环继续；StateChanged team.cast/team.join
#[test]
fn loop_expert_consult_wiring() {
    // 主循环模型：非专家窗口（system 无 persona 标记）→ 文本收尾；
    // 专家窗口（含"人设"）→ 各自文本收尾
    struct LoopModel;
    impl ChatClient for LoopModel {
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
            let text = if m0.contains("人设") {
                format!(
                    "{}结论。",
                    if m0.contains("安全") {
                        "安全"
                    } else {
                        "性能"
                    }
                )
            } else {
                "综合两方结论，开始处理。".to_string()
            };
            let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
                Ok(StreamEvent::TextDelta { text }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 6,
                        completion_tokens: 3,
                    },
                }),
            ];
            Ok(Box::new(events.into_iter()))
        }
    }

    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let model = Arc::new(LoopModel);
    let tools = Arc::new(AllowTools);
    let deps = LoopDeps {
        model: model.clone(),
        tools: tools.clone(),
        delegator: None,
        memory: None,
        wal: Arc::new(log.clone()),
        sink: sink.clone(),
        snapshots: None,
        skills: Arc::new(Mutex::new(SkillIndex::default())),
        fanout: None,
        experts: Some(Arc::new(FixedTeam)),
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-team-loop".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
    );
    runner.run_turn("多维度评审 PR#7", &deps);

    // 状态序列：team.cast 进 fanout 态 → team.join 回 running
    let evs = sink.0.lock().unwrap().clone();
    let states: Vec<(String, String)> = evs
        .iter()
        .filter_map(|e| match e {
            SessionEvent::StateChanged { state, reason, .. } => {
                Some((state.clone(), reason.clone()))
            }
            _ => None,
        })
        .collect();
    assert!(
        states
            .iter()
            .any(|(s, r)| s == "subagent_fanout" && r == "team.cast"),
        "{states:?}"
    );
    assert!(
        states
            .iter()
            .any(|(s, r)| s == "running" && r == "team.join"),
        "{states:?}"
    );
    // WAL：team.start/joined + 2×expert
    let entries = log.0.lock().unwrap().clone();
    let types: Vec<&str> = entries.iter().map(|(_, t, _)| t.as_str()).collect();
    assert!(types.contains(&"team.start") && types.contains(&"team.joined"));
    assert_eq!(types.iter().filter(|t| **t == "expert.activate").count(), 2);
    // 摘要回填：主循环模型看到 team.join 结论（第二轮 user 上下文含会诊结果）
    // ——以 history 轮次断言（turn 完成后摘要仍在 runner 历史，经 WAL join 佐证）
    let joined = entries
        .iter()
        .find(|(_, t, _)| *t == "team.joined")
        .unwrap();
    assert!(joined.2.contains("\"ok\":2"));
}

/// 校验拒绝兜底路径：假源返回超步图 → run_team Err → 回 running 不 panic
#[test]
fn loop_expert_invalid_graph_fallback() {
    struct HeavyTeam;
    impl ExpertSource for HeavyTeam {
        fn cast(&self, _m: &dyn ChatClient, _t: &str) -> Option<TeamGraph> {
            let mk = |id: &str| {
                let m = parse_manifest(&format!(
                    "id: {id}\ntype: local\nversion: 1.0.0\ndisplay: D\npersona: |\n  人设\nconstraints:\n  max_steps: 100\nsource: company\n"
                ))
                .unwrap();
                TeamMember {
                    label: id.into(),
                    expert: Arc::new(fixture_assembler(&m)),
                }
            };
            Some(TeamGraph {
                task: "t".into(),
                members: vec![mk("corp.a"), mk("corp.b")], // 2×100=200 > 120
                ..Default::default()
            })
        }
    }
    struct Plain;
    impl ChatClient for Plain {
        fn chat(
            &self,
            _req: &ChatRequest,
        ) -> Result<
            Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
            bbrt_aigw::AigwError,
        > {
            Ok(Box::new(
                vec![
                    Ok(StreamEvent::TextDelta {
                        text: "继续处理。".into(),
                    }),
                    Ok(StreamEvent::Done {
                        finish: FinishReason::Stop,
                        usage: Usage {
                            prompt_tokens: 4,
                            completion_tokens: 2,
                        },
                    }),
                ]
                .into_iter(),
            ))
        }
    }
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let deps = LoopDeps {
        model: Arc::new(Plain),
        tools: Arc::new(AllowTools),
        delegator: None,
        memory: None,
        wal: Arc::new(log.clone()),
        sink,
        snapshots: None,
        skills: Arc::new(Mutex::new(SkillIndex::default())),
        fanout: None,
        experts: Some(Arc::new(HeavyTeam)),
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-team-bad".into(),
        "/ws".into(),
        PermissionMode::AutoEdit,
        ModelTier::Strong,
    );
    runner.run_turn("任务", &deps); // 不 panic 即兜底成立
    let entries = log.0.lock().unwrap().clone();
    // team.start 未写（校验先于 WAL）
    assert!(!entries.iter().any(|(_, t, _)| *t == "team.start"));
}

// ---------------------------------------------------------------------------
// 流水线与评审环拓扑（D14 §3.1 ②③）
// ---------------------------------------------------------------------------

use bbrt_session::team::{TeamTopology, REVIEW_MAX_ROUNDS};

/// 剧本模型（拓扑专用）：按 user 简报内容分派——
/// "流水线第 N 段"→段结论；"评审返工第 N 轮"→修订产出；
/// "待评审产出"→VERDICT 首行（可配置每轮判定）；记录收到的简报
struct TopoModel {
    verdicts: Vec<&'static str>, // reviewer 逐轮判定（"pass"/"revise"）
    seen: Mutex<Vec<String>>,
}
impl ChatClient for TopoModel {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let m1 = req
            .messages
            .get(1)
            .map(|m| m.content.clone())
            .unwrap_or_default();
        self.seen.lock().unwrap().push(m1.clone());
        let text = if m1.contains("待评审产出") {
            // reviewer：按轮次出判定
            let round = self
                .seen
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.contains("待评审产出"))
                .count();
            let verdict = self.verdicts.get(round - 1).copied().unwrap_or("pass");
            format!("VERDICT: {verdict}\n意见：命名不规范。")
        } else if m1.contains("流水线第") || m1.contains("评审返工第") {
            "依据上游输入的结论。".into()
        } else if m1.contains("你的角色位") {
            "首段结论：方案 A。".into() // 流水线首段/评审 producer 首轮（brief_for 简报）
        } else {
            "未预期分支".into()
        };
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = vec![
            Ok(StreamEvent::TextDelta { text }),
            Ok(StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 6,
                    completion_tokens: 3,
                },
            }),
        ];
        Ok(Box::new(events.into_iter()))
    }
}

fn topo_team_model(verdicts: Vec<&'static str>) -> TopoModel {
    TopoModel {
        verdicts,
        seen: Mutex::new(vec![]),
    }
}

/// 流水线：三段串行，下游简报含上游结论（黑板链），nodes 保序
#[test]
fn pipeline_three_stages_flow() {
    let model = topo_team_model(vec![]);
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let graph = TeamGraph {
        task: "实现需求 R-7".into(),
        members: vec![
            member("analyst", "分析人设：拆需求。", 10),
            member("coder", "编码人设：写代码。", 10),
            member("reviewer2", "评审人设：看 diff。", 10),
        ],
        topology: TeamTopology::Pipeline,
        ..Default::default()
    };
    let result = run_team(
        &ExpertCtx {
            model: &model,
            tools: &AllowTools,
            mode: PermissionMode::AutoEdit,
        },
        "sess-pipe",
        &graph,
        sink.as_ref(),
        &log,
    )
    .unwrap();
    assert_eq!(result.nodes.len(), 3);
    assert_eq!(result.rounds, 1);
    assert!(!result.escalated);
    // 保序：analyst → coder → reviewer2
    let labels: Vec<&str> = result.nodes.iter().map(|n| n.label.as_str()).collect();
    assert_eq!(labels, vec!["analyst", "coder", "reviewer2"]);
    // 黑板链：第 2/3 段简报含上游结论与"流水线第"
    let seen = model.seen.lock().unwrap().clone();
    assert!(seen
        .iter()
        .any(|s| s.contains("流水线第 2 段") && s.contains("首段结论")));
    assert!(seen
        .iter()
        .any(|s| s.contains("流水线第 3 段") && s.contains("上游结论")));
    // WAL：topology=pipeline
    let entries = log.0.lock().unwrap().clone();
    let start = entries.iter().find(|(_, t, _)| *t == "team.start").unwrap();
    assert!(start.2.contains("\"topology\":\"pipeline\""));
}

/// 评审环：一轮 pass（reviewer 首行 VERDICT: pass）
#[test]
fn review_loop_pass_first_round() {
    let model = topo_team_model(vec!["pass"]);
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let graph = TeamGraph {
        task: "生成周报".into(),
        members: vec![
            member("writer", "写作人设：产出周报。", 10),
            member("checker", "检查人设：审周报。", 10),
        ],
        topology: TeamTopology::ReviewLoop,
        ..Default::default()
    };
    let result = run_team(
        &ExpertCtx {
            model: &model,
            tools: &AllowTools,
            mode: PermissionMode::AutoEdit,
        },
        "sess-rev1",
        &graph,
        sink.as_ref(),
        &log,
    )
    .unwrap();
    assert_eq!(result.rounds, 1);
    assert!(!result.escalated);
    assert_eq!(result.nodes.len(), 2, "一轮=producer+reviewer 各一");
    assert!(result.nodes.iter().all(|n| n.round == 1));
}

/// 评审环：round1 revise → round2 pass（返工简报含评审意见）
#[test]
fn review_loop_revise_then_pass() {
    let model = topo_team_model(vec!["revise", "pass"]);
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let graph = TeamGraph {
        task: "生成周报".into(),
        members: vec![
            member("writer", "写作人设：产出周报。", 10),
            member("checker", "检查人设：审周报。", 10),
        ],
        topology: TeamTopology::ReviewLoop,
        ..Default::default()
    };
    let result = run_team(
        &ExpertCtx {
            model: &model,
            tools: &AllowTools,
            mode: PermissionMode::AutoEdit,
        },
        "sess-rev2",
        &graph,
        sink.as_ref(),
        &log,
    )
    .unwrap();
    assert_eq!(result.rounds, 2);
    assert!(!result.escalated);
    assert_eq!(result.nodes.len(), 4, "两轮×(producer+reviewer)");
    // 返工简报：含评审意见（VERDICT 行被带给 producer）
    let seen = model.seen.lock().unwrap().clone();
    assert!(seen
        .iter()
        .any(|s| s.contains("评审返工第 1 轮") && s.contains("VERDICT: revise")));
    // 轮次标注：round2 的两个节点
    assert!(result.nodes.iter().filter(|n| n.round == 2).count() == 2);
}

/// 评审环：N=2 用尽仍 revise → escalated 转人工（WAL team.escalated）
#[test]
fn review_loop_escalates_after_max_rounds() {
    let model = topo_team_model(vec!["revise", "revise", "revise"]);
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let graph = TeamGraph {
        task: "生成周报".into(),
        members: vec![
            member("writer", "写作人设：产出周报。", 10),
            member("checker", "检查人设：审周报。", 10),
        ],
        topology: TeamTopology::ReviewLoop,
        ..Default::default()
    };
    let result = run_team(
        &ExpertCtx {
            model: &model,
            tools: &AllowTools,
            mode: PermissionMode::AutoEdit,
        },
        "sess-rev3",
        &graph,
        sink.as_ref(),
        &log,
    )
    .unwrap();
    assert!(result.escalated, "N={REVIEW_MAX_ROUNDS} 用尽应转人工");
    assert_eq!(result.rounds, REVIEW_MAX_ROUNDS + 1);
    assert_eq!(result.nodes.len(), (REVIEW_MAX_ROUNDS + 1) * 2);
    let entries = log.0.lock().unwrap().clone();
    let types: Vec<&str> = entries.iter().map(|(_, t, _)| t.as_str()).collect();
    assert!(types.contains(&"team.escalated"), "{types:?}");
    assert!(types.last() == Some(&"team.joined"));
}

/// 校验：评审环恰 2 成员；预算按 ×(N+1) 折算（2×40×3=240 > 120 拒）
#[test]
fn review_loop_graph_validation() {
    let three = TeamGraph {
        task: "x".into(),
        members: vec![
            member("w", "写。", 10),
            member("c", "查。", 10),
            member("e", "_extra。", 10),
        ],
        topology: TeamTopology::ReviewLoop,
        ..Default::default()
    };
    assert!(run_team(
        &ExpertCtx {
            model: &topo_team_model(vec![]),
            tools: &AllowTools,
            mode: PermissionMode::AutoEdit
        },
        "s-x",
        &three,
        Arc::new(CollectSink(Mutex::new(vec![]))).as_ref(),
        &SharedLog::default(),
    )
    .is_err());

    let heavy = TeamGraph {
        members: vec![member("w", "写。", 40), member("c", "查。", 40)],
        topology: TeamTopology::ReviewLoop,
        ..Default::default()
    };
    let g = TeamGraph {
        task: "x".into(),
        ..heavy
    };
    assert!(
        bbrt_session::team::validate_graph(&g).is_err(),
        "2×40×3=240 应超预算"
    );
    // 同预算会诊合法（2×40=80）——拓扑差异化校验生效
    let consult = TeamGraph {
        topology: TeamTopology::Consult,
        ..g
    };
    assert!(bbrt_session::team::validate_graph(&consult).is_ok());
}
