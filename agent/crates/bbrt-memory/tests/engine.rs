//! 装配与协议集成测试（D15 §6"协议"行 + §5 装配）：
//! MemoryEngine 的 save_memory 落盘联动、`memory.saved` / `memory.evicted`
//! payload 序列化 roundtrip（嵌套 struct 自带 camelCase——7698c52 教训）。
//! （D15 被动轨 journal/digest 日报已随日报 UI 整域退役移除。）

use std::fs;
use std::sync::Arc;

use bbrt_memory::knowledge::store::INDEX_FILE;
use bbrt_memory::{
    FixedClock, MemoryEngine, MemoryEvictedEvent, MemorySavedEvent, MemoryType, SaveInput,
};

/// 引擎 + 可变固定时钟脚手架（保留句柄模拟跨日推进）
fn setup(now: &str, today: &str) -> (MemoryEngine, Arc<FixedClock>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("临时目录");
    let clock = Arc::new(FixedClock::new(now, today));
    let engine = MemoryEngine::open(dir.path(), clock.clone()).expect("打开引擎");
    (engine, clock, dir)
}

// ---------------------------------------------------------------------------
// 装配：目录布局 + 启动重建索引
// ---------------------------------------------------------------------------

#[test]
fn open_creates_layout_and_rebuilds_stale_index() {
    let dir = tempfile::tempdir().unwrap();
    // 预置一个条目 + 一份陈旧/损坏索引（模拟上次崩溃）
    let mem = dir.path().join("agent/memory");
    fs::create_dir_all(&mem).unwrap();
    fs::write(
        mem.join("端口-8090-约定.md"),
        "---\nname: 端口-8090-约定\ntitle: 端口 8090 约定\ntype: project\ncreated_at: 2026-11-05T09:00:00+08:00\nupdated_at: 2026-11-05T09:00:00+08:00\nsession: s0\nlinks: []\n---\n\n开发服务固定走 8090。\n",
    )
    .unwrap();
    fs::write(mem.join(INDEX_FILE), "崩溃前的陈旧索引").unwrap();

    let clock = Arc::new(FixedClock::new("2026-11-06T10:00:00+08:00", "2026-11-06"));
    let engine = MemoryEngine::open(dir.path(), clock).unwrap();

    // 记忆目录就位
    assert!(dir.path().join("agent/memory").is_dir(), "缺目录 memory");
    // D23 一次性迁移：project 类不迁公共层——旧文件与陈旧索引整体移 archive/，
    // 根索引重建为空（用户级文件族由 global/ 取代）
    let index = fs::read_to_string(dir.path().join("agent/memory").join(INDEX_FILE)).unwrap();
    assert_eq!(index, "");
    assert_eq!(engine.knowledge().list().len(), 0);
    assert!(
        dir.path()
            .join("agent/memory/archive/端口-8090-约定.md")
            .exists(),
        "旧条目应归档"
    );
    assert!(
        dir.path().join("agent/memory/archive/MEMORY.md").exists(),
        "旧索引应归档"
    );
    assert!(
        dir.path().join("agent/memory/global").is_dir(),
        "公共层目录就位"
    );
}

// ---------------------------------------------------------------------------
// save_memory：主动轨落盘
// ---------------------------------------------------------------------------

#[test]
fn save_memory_persists_and_updates() {
    let (engine, clock, dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    // D23：Project 类走项目分区（日常会话会回落公共层，见 tests/global.rs）
    let ws = dir.path().join("proj");
    fs::create_dir_all(&ws).unwrap();
    let outcome = engine
        .save_memory_scoped(
            Some(&ws),
            &SaveInput {
                title: "端口 8090 约定".into(),
                mtype: MemoryType::Project,
                body: "开发服务固定走 8090。".into(),
                session: "s1".into(),
                links: vec![],
            },
        )
        .unwrap();
    assert!(!outcome.saved.updated);
    assert!(outcome.evicted.is_empty());
    assert_eq!(outcome.saved.name, "端口-8090-约定");
    assert_eq!(outcome.saved.scope, "project");

    // 同题再写：updated=true，条目仍 1 条
    clock.set("2026-11-06T12:00:00+08:00", "2026-11-06");
    let outcome2 = engine
        .save_memory_scoped(
            Some(&ws),
            &SaveInput {
                title: "端口 8090 约定".into(),
                mtype: MemoryType::Project,
                body: "改：8090 只用于开发。".into(),
                session: "s1".into(),
                links: vec![],
            },
        )
        .unwrap();
    assert!(outcome2.saved.updated);
    assert_eq!(engine.list_scoped(Some(&ws)).len(), 1);

    // 拒敏路径：save_memory 不落盘
    assert!(engine
        .save_memory(&SaveInput {
            title: "秘密".into(),
            mtype: MemoryType::Reference,
            body: "AKIAIOSFODNN7EXAMPLE".into(),
            session: "s1".into(),
            links: vec![],
        })
        .is_err());
    assert_eq!(engine.list_scoped(Some(&ws)).len(), 1);
}

// ---------------------------------------------------------------------------
// 协议 payload 序列化 roundtrip（camelCase 契约锁定）
// ---------------------------------------------------------------------------

#[test]
fn memory_saved_payload_roundtrip_camel_case() {
    let ev = MemorySavedEvent {
        session_id: "sess-1".into(),
        name: "端口-8090-约定".into(),
        title: "端口 8090 约定".into(),
        r#type: MemoryType::Project,
        updated: true,
        scope: "user".into(),
        workspace_name: None,
        global_type: None,
    };
    let json = serde_json::to_string(&ev).unwrap();
    assert_eq!(
        json,
        r#"{"sessionId":"sess-1","name":"端口-8090-约定","title":"端口 8090 约定","type":"project","updated":true,"scope":"user"}"#
    );
    assert_eq!(serde_json::from_str::<MemorySavedEvent>(&json).unwrap(), ev);

    // D19 项目作用域：workspaceName 携带分区名；scope 缺省反序列化回落 user
    let proj = MemorySavedEvent {
        scope: "project".into(),
        workspace_name: Some("baobao-work-72ab07a9e501bc35".into()),
        ..ev.clone()
    };
    let proj_json = serde_json::to_string(&proj).unwrap();
    assert!(proj_json.contains(r#""scope":"project""#));
    assert!(proj_json.contains(r#""workspaceName":"baobao-work-72ab07a9e501bc35""#));
    assert_eq!(
        serde_json::from_str::<MemorySavedEvent>(&proj_json).unwrap(),
        proj
    );
    let legacy = r#"{"sessionId":"s","name":"n","title":"t","type":"user","updated":false}"#;
    assert_eq!(
        serde_json::from_str::<MemorySavedEvent>(legacy)
            .unwrap()
            .scope,
        "user"
    );
}

#[test]
fn memory_evicted_payload_roundtrip_camel_case() {
    let ev = MemoryEvictedEvent {
        session_id: Some("sess-1".into()),
        name: "最旧条目".into(),
        reason: "capacity".into(),
    };
    let json = serde_json::to_string(&ev).unwrap();
    assert_eq!(
        json,
        r#"{"sessionId":"sess-1","name":"最旧条目","reason":"capacity"}"#
    );
    assert_eq!(
        serde_json::from_str::<MemoryEvictedEvent>(&json).unwrap(),
        ev
    );
    // session_id 可空（D15 §2.4 sessionId?）
    let bare = MemoryEvictedEvent {
        session_id: None,
        name: "n".into(),
        reason: "capacity".into(),
    };
    let json = serde_json::to_string(&bare).unwrap();
    assert_eq!(json, r#"{"sessionId":null,"name":"n","reason":"capacity"}"#);
    assert_eq!(
        serde_json::from_str::<MemoryEvictedEvent>(&json).unwrap(),
        bare
    );
}
