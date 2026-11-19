//! WAL→recovery 闭环（§9.2 契约：user 原文/assistant 轮/turn 边界可重建）+
//! SessionManager.workspace_of 查询。
//! （原检查点集成测试已随检查点机制整域退役，git 历史可溯。）

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_context::BudgetConfig;
use bbrt_sec::gate::PermissionMode;
use bbrt_session::events::{ModelTier, SessionEvent, SessionSink};
use bbrt_session::executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_session::loop_runner::{EventLog, LoopDeps, SessionRunner};
use bbrt_session::{recover, SessionManager, StartParams};
use bbrt_store::{SessionRow, Store, Workspace};

// ---------------------------------------------------------------------------
// 临时仓库与 Store 脚手架
// ---------------------------------------------------------------------------

fn sh(dir: &Path, program: &str, args: &[&str]) {
    let out = Command::new(program)
        .args(args)
        .current_dir(dir)
        .output()
        .expect("命令执行失败");
    assert!(
        out.status.success(),
        "{program} {args:?} 失败: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// 建临时 git 仓库（1 个初始提交，含 a.txt）
fn git_repo(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "bbrt-cp-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    sh(&dir, "git", &["init", "-q"]);
    sh(&dir, "git", &["config", "user.email", "t@t"]);
    sh(&dir, "git", &["config", "user.name", "t"]);
    // Store 的 SQLite 落本仓（runtime.db*）：忽略，避免混入未跟踪断言
    std::fs::write(dir.join(".gitignore"), "runtime.db*\n").unwrap();
    std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
    sh(&dir, "git", &["add", "."]);
    sh(&dir, "git", &["commit", "-q", "-m", "init"]);
    dir
}

/// 临时 Store（Arc<Mutex> 共享形，同 bin 装配）+ 种子会话
fn seeded_store(dir: &Path, session_id: &str) -> Arc<Mutex<Store>> {
    let store = Store::open(&dir.join("runtime.db")).unwrap();
    seed_session(&store, dir, session_id);
    Arc::new(Mutex::new(store))
}

/// 单建会话行（多会话测试复用；workspace/session 两级 FK 都要前置登记）
fn seed_session(store: &Store, dir: &Path, session_id: &str) {
    store
        .upsert_workspace(&Workspace {
            id: format!("ws-{session_id}"),
            // path 唯一约束：同目录多会话时按会话拼唯一路径（登记用，不必真实存在）
            path: format!("{}/{}", dir.display(), session_id),
            name: "test".into(),
            is_repo: true,
            trusted: true,
            extra_dirs: None,
            last_opened_at: 0,
            created_at: 0,
        })
        .unwrap();
    store
        .insert_session(&SessionRow {
            id: session_id.into(),
            workspace_id: Some(format!("ws-{session_id}")),
            title: session_id.into(),
            form: "workbench".into(),
            mode: "ask".into(),
            model_policy: "strong".into(),
            model_override: None,
            status: "idle".into(),
            share_enabled: false,
            created_at: 0,
            updated_at: 0,
            ended_at: None,
            summary: None,
        })
        .unwrap();
}

// ---------------------------------------------------------------------------
// loop 驱动脚手架
// ---------------------------------------------------------------------------

struct CollectSink(Mutex<Vec<SessionEvent>>);
impl SessionSink for CollectSink {
    fn emit(&self, evt: SessionEvent) {
        self.0.lock().unwrap().push(evt);
    }
}

/// 收集 WAL（重现 bin 的 Mutex<Store> 适配语义）
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

/// 假模型：0=write_file 工具轮，1=纯文本收尾
struct FakeModel(AtomicUsize);
impl ChatClient for FakeModel {
    fn chat(
        &self,
        _req: &ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let events: Vec<Result<StreamEvent, bbrt_aigw::AigwError>> = if n == 0 {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "改一下".into(),
                }),
                Ok(StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "call-1".into(),
                    name: "write_file".into(),
                }),
                Ok(StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "{\"path\":\"a.txt\"}".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: Usage {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                    },
                }),
            ]
        } else {
            vec![
                Ok(StreamEvent::TextDelta {
                    text: "完成".into(),
                }),
                Ok(StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 12,
                        completion_tokens: 3,
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
            summary: "ok".into(),
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
            name: "write_file".into(),
            description: "写".into(),
            input_schema: serde_json::json!({"type": "object"}),
        }]
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

/// WAL→recovery 闭环（§9.2 修复验证）：user.text 原文/assistant 轮/turn 边界可重建。
#[test]
fn wal_replay_recovers_user_turn_after_fix() {
    let dir = git_repo("replay");
    let store = seeded_store(&dir, "s-rp");
    let log = SharedLog::default();
    let deps = LoopDeps {
        model: Arc::new(FakeModel(AtomicUsize::new(0))),
        tools: Arc::new(AllowTools),
        memory: None,
        wal: Arc::new(log.clone()),
        sink: Arc::new(CollectSink(Mutex::new(vec![]))),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-rp".into(),
        dir.to_string_lossy().into_owned(),
        PermissionMode::Ask,
        ModelTier::Strong,
        None,
    );
    runner.run_turn("修复登录超时并跑测试", &deps, None);

    // WAL 灌回 SQLite 事件镜像（重现 EventLog for Mutex<Store> 的写入）
    {
        let st = store.lock().unwrap();
        for (sid, t, p) in log.0.lock().unwrap().iter() {
            let seq = st.next_event_seq(sid).unwrap();
            st.append_event(sid, seq, t, p).unwrap();
        }
        let rep = recover(&st, "s-rp");
        assert_replay(rep);
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// 重放断言（wal_replay 用）：user 原文/工具轮/turn 边界全部可重建
fn assert_replay(rep: bbrt_session::ReplayReport) {
    assert_eq!(rep.broken, 0);
    assert_eq!(
        rep.final_state,
        bbrt_session::state::SessionState::Idle,
        "turn.end 应落定 idle"
    );
    // 用户轮次原文找回（修复前 user.text 未写 → 恢复丢用户输入）
    assert!(rep.history.iter().any(
        |r| matches!(r, bbrt_context::Round::User { content } if content == "修复登录超时并跑测试")
    ));
    // 工具轮以摘要重建
    assert!(rep
        .history
        .iter()
        .any(|r| matches!(r, bbrt_context::Round::Tool { name, .. } if name == "write_file")));
}

/// manager.workspace_of：start 后可查，未开会话 None。
#[test]
fn manager_workspace_of() {
    let dir = std::env::temp_dir().join(format!("bbrt-cp-mgr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let deps = LoopDeps {
        model: Arc::new(FakeModel(AtomicUsize::new(0))),
        tools: Arc::new(AllowTools),
        memory: None,
        wal: Arc::new(bbrt_session::NoopEventLog),
        sink,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: BudgetConfig::default(),
    };
    let mgr = SessionManager::new(deps, None);
    mgr.start(
        "s-mgr".into(),
        StartParams {
            workspace: "/ws/mine".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelTier::Strong,
            model_override: None,
            title: "t".into(),
            restored: None,
        },
    )
    .unwrap();
    assert_eq!(mgr.workspace_of("s-mgr").unwrap(), "/ws/mine");
    assert!(mgr.workspace_of("无此会话").is_none());

    let _ = std::fs::remove_dir_all(&dir);
}
