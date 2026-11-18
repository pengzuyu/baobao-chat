//! run 记录集成测试（D16 §3.1）：走**真实 Store** 的 EventLog 实现
//! （bin 装配同路径：Arc<Mutex<Store>> → Arc<dyn EventLog>）验证——
//! 发号 r-{seq}、run 起止落 agent_run、事件带 run_id、
//! 崩溃恢复把 running run 置 interrupted。
//! （其余套件的假 EventLog 只验行为不落库；本套件补生产路径。）

use std::sync::Mutex;

use bbrt_session::loop_runner::{EventLog, RunEnd, RunStart};
use bbrt_session::recover;
use bbrt_store::{SessionRow, Store};

fn open_store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().expect("临时目录失败");
    let store = Store::open(&dir.path().join("runtime.db")).expect("打开 Store 失败");
    (dir, store)
}

fn seed_session(store: &Store, id: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    store
        .insert_session(&SessionRow {
            id: id.to_string(),
            workspace_id: None,
            title: "run 记录测试".into(),
            form: "workbench".into(),
            mode: "ask".into(),
            backend: None,
            model_policy: "auto".into(),
            model_override: None,
            status: "idle".into(),
            share_enabled: false,
            created_at: now,
            updated_at: now,
            ended_at: None,
            summary: None,
        })
        .expect("种子会话失败");
}

/// 全链路：next_run_id → run_start → append_run → run_end，
/// agent_run 行与事件 run_id 归属同时可查（一次调用=一条可重放流水）。
#[test]
fn eventlog_impl_records_run_lifecycle_into_sqlite() {
    let (_dir, store) = open_store();
    seed_session(&store, "sess-1");
    let wal: &dyn EventLog = &Mutex::new(store);

    let run_id = wal.next_run_id().expect("发号失败");
    assert_eq!(run_id, "r-000001");

    wal.run_start(&RunStart {
        run_id: run_id.clone(),
        session_id: "sess-1".into(),
        root_session_id: "sess-1".into(),
        parent_run_id: String::new(),
        parent_call_id: "call-9".into(),
        kind: "delegate",
        def_ref: "backend:claude".into(),
        eta_hint_ms: 0,
        actor: String::new(),
    });
    wal.append_run(
        "sess-1",
        &run_id,
        "delegate.launch",
        "{\"backend\":\"claude\"}",
    );
    wal.append_run("sess-1", &run_id, "delegate.end", "{\"exit\":0}");
    wal.run_end(
        &run_id,
        &RunEnd {
            status: "done",
            eta_actual_ms: 42_000,
            summary: "委派完成",
            child_session_ref: "claude-sess-7",
        },
    );

    // 校验：EventLog 侧持有 Store 的所有权（包进 Mutex），独立句柄重开断言
    // （SQLite WAL 多连接并发读安全；TempDir 存活至测试结束）
    let store2 = Store::open(&_dir.path().join("runtime.db")).unwrap();
    let runs = store2.runs_of("sess-1").unwrap();
    assert_eq!(runs.len(), 1);
    let r = &runs[0];
    assert_eq!(
        (r.id.as_str(), r.kind.as_str(), r.status.as_str()),
        ("r-000001", "delegate", "done")
    );
    assert_eq!(r.def_ref, "backend:claude");
    assert_eq!(r.parent_call_id, "call-9");
    assert_eq!(r.eta_actual_ms, 42_000);
    assert_eq!(r.child_session_ref, "claude-sess-7");
    assert!(r.ended_at.is_some());

    // 事件归属：主循环事件 run_id 空；delegate.* 两条挂本 run
    let events = store2.events_after("sess-1", 0, 100).unwrap();
    let with_run: Vec<&bbrt_store::EventRow> =
        events.iter().filter(|e| e.run_id == "r-000001").collect();
    assert_eq!(with_run.len(), 2);
    assert!(with_run.iter().all(|e| e.type_.starts_with("delegate.")));
}

/// 崩溃恢复：running run → interrupted（recover 调用路径）
#[test]
fn recovery_marks_running_runs_interrupted() {
    let (_dir, store) = open_store();
    seed_session(&store, "sess-2");
    {
        let wal: &dyn EventLog = &Mutex::new(store);
        let id = wal.next_run_id().unwrap();
        wal.run_start(&RunStart {
            run_id: id,
            session_id: "sess-2".into(),
            root_session_id: "sess-2".into(),
            parent_run_id: String::new(),
            parent_call_id: String::new(),
            kind: "probe",
            def_ref: "builtin.probe".into(),
            eta_hint_ms: 0,
            actor: String::new(),
        });
        // 模拟崩溃：不 run_end 直接丢弃
    }
    let store2 = Store::open(&_dir.path().join("runtime.db")).unwrap();
    let report = recover(&store2, "sess-2");
    assert!(report.found);
    assert_eq!(report.interrupted_runs, 1, "恢复应收口悬空 run");
    assert_eq!(store2.runs_of("sess-2").unwrap()[0].status, "interrupted");
    // 幂等：再恢复一遍不再计数
    let report2 = recover(&store2, "sess-2");
    assert_eq!(report2.interrupted_runs, 0);
}
