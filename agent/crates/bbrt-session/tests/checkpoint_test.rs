//! 检查点集成测试：真实 git 快照/恢复（08 §4.4 stash 式语义）+
//! loop 驱动的 pre-edit 快照 + WAL→recovery 时间线闭环（§9.2 契约）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bbrt_aigw::{ChatClient, ChatRequest, FinishReason, StreamEvent, ToolSpec, Usage};
use bbrt_context::BudgetConfig;
use bbrt_sec::gate::PermissionMode;
use bbrt_session::checkpoint::{GitSnapshots, SnapshotOutcome, SnapshotService};
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

/// 临时 Store（Arc<Mutex> 共享形，同 bin 装配）+ 种子会话（agent_checkpoint
/// 有 FK：先 workspace 后 session）
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
            backend: None,
            model_policy: "strong".into(),
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
// 快照/恢复核心语义
// ---------------------------------------------------------------------------

/// 快照→修改→恢复：a.txt 回到快照时内容；恢复自动产生 pre-restore 保护快照。
#[test]
fn snapshot_then_modify_then_restore() {
    let dir = git_repo("restore");
    let store = seeded_store(&dir, "sess-cp");
    let svc = GitSnapshots::new(store);

    let cp1 = svc
        .create("sess-cp", dir.to_str().unwrap(), "manual")
        .unwrap();
    assert!(cp1.git_ref.is_some(), "git 仓库应有隐藏 ref");
    assert_eq!(cp1.files_changed.len(), 0, "干净树无差异");

    std::fs::write(dir.join("a.txt"), "被改坏的 v2\n").unwrap();
    std::fs::write(dir.join("new.txt"), "新增文件\n").unwrap();
    let cp2 = svc
        .create("sess-cp", dir.to_str().unwrap(), "manual")
        .unwrap();
    assert_eq!(cp2.files_changed.len(), 1, "a.txt 修改应入 files_changed");
    assert_eq!(cp2.files_changed[0].path, "a.txt");
    assert_eq!(cp2.untracked.len(), 1, "new.txt 未跟踪");

    // 恢复到 cp1（干净态）：tracked 内容回滚；未跟踪文件不搬移（08 §4.4）
    let guard = svc
        .restore("sess-cp", dir.to_str().unwrap(), &cp1.checkpoint_id)
        .unwrap();
    assert_ne!(guard, cp1.checkpoint_id, "恢复前应建 pre-restore 保护快照");
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1\n");
    assert!(dir.join("new.txt").exists(), "未跟踪文件不删");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 非 git 工作区：快照仍登记（时间线锚点），恢复拒绝。
#[test]
fn non_git_workspace_anchors_but_refuses_restore() {
    let dir = std::env::temp_dir().join(format!("bbrt-cp-nogit-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = seeded_store(&dir, "sess-ng");
    let svc = GitSnapshots::new(store);

    let out = svc
        .create("sess-ng", dir.to_str().unwrap(), "manual")
        .unwrap();
    assert!(out.git_ref.is_none());
    assert!(svc
        .restore("sess-ng", dir.to_str().unwrap(), &out.checkpoint_id)
        .is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

/// pre_edit 5min 窗口：最新检查点在窗口内 → None（复用）；过期 → 新建 pre-edit。
#[test]
fn pre_edit_window_dedup() {
    let dir = git_repo("window");
    let store = seeded_store(&dir, "sess-w");
    let svc = GitSnapshots::new(store.clone());

    // 窗口内：pre_edit 复用（None）
    svc.create("sess-w", dir.to_str().unwrap(), "manual")
        .unwrap();
    assert!(svc
        .pre_edit("sess-w", dir.to_str().unwrap())
        .unwrap()
        .is_none());

    // 过期：另一会话预置一枚 6 分钟前的检查点 → pre_edit 应产出新 pre-edit
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    {
        let st = store.lock().unwrap();
        seed_session(&st, &dir, "sess-old");
        st.insert_checkpoint(&bbrt_store::CheckpointRow {
            id: "cp-old".into(),
            session_id: "sess-old".into(),
            git_ref: None,
            untracked: None,
            files_changed: "[]".into(),
            reason: "pre-edit".into(),
            last_event_seq: 0,
            created_at: now - 6 * 60 * 1000,
        })
        .unwrap();
    }
    let out = svc.pre_edit("sess-old", dir.to_str().unwrap()).unwrap();
    assert_eq!(out.expect("过期应新建").reason, "pre-edit");

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// loop 驱动：pre-edit 快照触发 + WAL→recovery 闭环
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

/// 假快照服务：首调 Some、后续 None（模拟 5min 去重），记录调用
struct FakeSnapshots {
    calls: AtomicUsize,
}
impl SnapshotService for FakeSnapshots {
    fn create(&self, sid: &str, _ws: &str, reason: &str) -> Result<SnapshotOutcome, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(SnapshotOutcome {
            checkpoint_id: format!("cp-{sid}"),
            git_ref: None,
            files_changed: vec![],
            untracked: vec![],
            reason: reason.into(),
        })
    }
    fn pre_edit(&self, sid: &str, ws: &str) -> Result<Option<SnapshotOutcome>, String> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            self.create(sid, ws, "pre-edit").map(Some)
        } else {
            Ok(None)
        }
    }
    fn restore(&self, _sid: &str, _ws: &str, _cp: &str) -> Result<String, String> {
        Ok("cp-guard".into())
    }
}

/// 修改类工具触发 pre-edit 快照（事件+WAL 落账）；只读工具不触发。
#[test]
fn pre_edit_snapshot_fires_on_write_tool() {
    let sink = Arc::new(CollectSink(Mutex::new(vec![])));
    let log = SharedLog::default();
    let snaps = Arc::new(FakeSnapshots {
        calls: AtomicUsize::new(0),
    });
    let deps = LoopDeps {
        model: Arc::new(FakeModel(AtomicUsize::new(0))),
        tools: Arc::new(AllowTools),
        delegator: None,
        memory: None,
        wal: Arc::new(log.clone()),
        sink: sink.clone(),
        snapshots: Some(snaps.clone() as Arc<dyn SnapshotService>),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-cp".into(),
        "/ws".into(),
        PermissionMode::Ask,
        ModelTier::Strong,
    );
    runner.run_turn("帮我改 a.txt", &deps);

    let events = sink.0.lock().unwrap().clone();
    let created: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::CheckpointCreated { reason, .. } => Some(reason.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        created,
        vec!["pre-edit".to_string()],
        "write_file 应触发一枚 pre-edit 快照"
    );
    let wal = log.0.lock().unwrap();
    assert!(
        wal.iter()
            .any(|(_, t, p)| t == "checkpoint.created" && p.contains("pre-edit")),
        "WAL 应落 checkpoint.created"
    );
}

/// WAL→recovery 闭环（§9.2 修复验证）：user.text 原文/assistant 轮/turn 边界可重建。
#[test]
fn wal_replay_recovers_user_turn_after_fix() {
    let dir = git_repo("replay");
    let store = seeded_store(&dir, "s-rp");
    let log = SharedLog::default();
    let deps = LoopDeps {
        model: Arc::new(FakeModel(AtomicUsize::new(0))),
        tools: Arc::new(AllowTools),
        delegator: None,
        memory: None,
        wal: Arc::new(log.clone()),
        sink: Arc::new(CollectSink(Mutex::new(vec![]))),
        snapshots: None,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        budget: BudgetConfig::default(),
    };
    let mut runner = SessionRunner::new(
        "s-rp".into(),
        dir.to_string_lossy().into_owned(),
        PermissionMode::Ask,
        ModelTier::Strong,
    );
    runner.run_turn("修复登录超时并跑测试", &deps);

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
        delegator: None,
        memory: None,
        wal: Arc::new(bbrt_session::NoopEventLog),
        sink,
        snapshots: None,
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        budget: BudgetConfig::default(),
    };
    let mgr = SessionManager::new(deps, None);
    mgr.start(
        "s-mgr".into(),
        StartParams {
            workspace: "/ws/mine".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelTier::Strong,
            title: "t".into(),
            restored: None,
        },
    )
    .unwrap();
    assert_eq!(mgr.workspace_of("s-mgr").unwrap(), "/ws/mine");
    assert!(mgr.workspace_of("无此会话").is_none());

    let _ = std::fs::remove_dir_all(&dir);
}
