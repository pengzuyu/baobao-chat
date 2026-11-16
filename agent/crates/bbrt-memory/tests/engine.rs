//! 装配与协议集成测试（D15 §6"协议"行 + §5 装配）：
//! MemoryEngine 的 record → on_session_end 闭环、save_memory 双轨联动、
//! 启动回补；`memory.saved` / `memory.evicted` / `report.daily` payload
//! 序列化 roundtrip（嵌套 struct 自带 camelCase——7698c52 教训）。

use std::fs;
use std::path::Path;
use std::sync::Arc;

use bbrt_memory::knowledge::store::INDEX_FILE;
use bbrt_memory::{
    ActivityEvent, FixedClock, MemoryEngine, MemoryEvictedEvent, MemorySavedEvent, MemoryType,
    ReportDailyEvent, SaveInput,
};

/// 引擎 + 可变固定时钟脚手架（保留句柄模拟跨日推进）
fn setup(now: &str, today: &str) -> (MemoryEngine, Arc<FixedClock>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("临时目录");
    let clock = Arc::new(FixedClock::new(now, today));
    let engine = MemoryEngine::open(dir.path(), clock.clone()).expect("打开引擎");
    (engine, clock, dir)
}

fn started(session: &str) -> ActivityEvent {
    ActivityEvent::SessionStarted {
        session: session.to_string(),
        workspace: "baobao-chat".to_string(),
        mode: "interactive".to_string(),
    }
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

    // 三目录就位
    for sub in ["memory", "journal", "reports"] {
        assert!(dir.path().join("agent").join(sub).is_dir(), "缺目录 {sub}");
    }
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
// record → on_session_end 闭环
// ---------------------------------------------------------------------------

#[test]
fn record_then_session_end_recomputes_daily_report() {
    let (engine, _clock, dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    engine.record(&started("s1")).unwrap();
    for tool in ["read_file", "read_file", "edit_file"] {
        engine
            .record(&ActivityEvent::ToolExecuted {
                session: "s1".into(),
                tool: tool.into(),
                ok: true,
                duration_ms: 50,
                risk: "低".into(),
            })
            .unwrap();
    }
    engine
        .record(&ActivityEvent::SessionEnded {
            session: "s1".into(),
            summary: None,
            duration_ms: 120_000,
        })
        .unwrap();

    // 当日无产物时 on_session_end 前 reports 为空
    let report = engine
        .on_session_end()
        .unwrap()
        .expect("当日有 journal 必有产物");
    assert_eq!(report.stats.sessions, 1);
    assert_eq!(report.stats.tool_calls, 3);
    assert_eq!(report.stats.total_duration_ms, 120_000);
    assert_eq!(
        report.md_path,
        dir.path().join("agent/reports/2026-11-06.md")
    );
    assert_eq!(
        report.json_path,
        dir.path().join("agent/reports/2026-11-06.json")
    );
    assert!(report.md_path.is_file() && report.json_path.is_file());

    // 再记录再触发 → 覆盖重算（幂等闭环）
    engine
        .record(&ActivityEvent::MemorySaved {
            session: "s1".into(),
            title: "新事实".into(),
            memory_type: MemoryType::User,
        })
        .unwrap();
    let report2 = engine.on_session_end().unwrap().unwrap();
    assert_eq!(report2.stats.memory_saved, vec!["新事实"]);
    let md = fs::read_to_string(report2.md_path).unwrap();
    assert!(md.contains("今日记忆 +1：「新事实」"));
}

#[test]
fn session_end_on_empty_day_returns_none() {
    let (engine, _clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    assert!(engine.on_session_end().unwrap().is_none(), "空日不出产物");
}

// ---------------------------------------------------------------------------
// save_memory：主动轨落盘 + 被动轨记事件（双轨联动）
// ---------------------------------------------------------------------------

#[test]
fn save_memory_persists_and_journals() {
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

    // 被动轨：journal 记了 memory.saved
    let day = engine.journal().read_day("2026-11-06");
    assert_eq!(day.events.len(), 1);
    assert!(matches!(day.events[0], ActivityEvent::MemorySaved { .. }));

    // 同题再写：updated=true，journal 累计 2 行，条目仍 1 条
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
    assert_eq!(engine.journal().read_day("2026-11-06").events.len(), 2);
    assert_eq!(engine.list_scoped(Some(&ws)).len(), 1);

    // 日报聚合到 memory_saved 标题（交叉印证）
    let report = engine.on_session_end().unwrap().unwrap();
    assert_eq!(
        report.stats.memory_saved,
        vec!["端口 8090 约定", "端口 8090 约定"]
    );
    assert!(dir.path().join("agent/reports/2026-11-06.json").is_file());

    // 拒敏路径：save_memory 不落盘也不记事件
    let before = engine.journal().read_day("2026-11-06").events.len();
    assert!(engine
        .save_memory(&SaveInput {
            title: "秘密".into(),
            mtype: MemoryType::Reference,
            body: "AKIAIOSFODNN7EXAMPLE".into(),
            session: "s1".into(),
            links: vec![],
        })
        .is_err());
    assert_eq!(engine.journal().read_day("2026-11-06").events.len(), before);
    assert_eq!(engine.list_scoped(Some(&ws)).len(), 1);
}

// ---------------------------------------------------------------------------
// 启动回补（引擎视角：换日用 FixedClock 推进）
// ---------------------------------------------------------------------------

#[test]
fn startup_backfill_fills_missed_days_across_dates() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(FixedClock::new("2026-11-04T10:00:00+08:00", "2026-11-04"));
    {
        let engine = MemoryEngine::open(dir.path(), clock.clone()).unwrap();
        engine.record(&started("s1")).unwrap();
        engine
            .record(&ActivityEvent::SessionEnded {
                session: "s1".into(),
                summary: None,
                duration_ms: 1_000,
            })
            .unwrap();
        clock.set("2026-11-06T10:00:00+08:00", "2026-11-06");
        engine.record(&started("s2")).unwrap(); // 当日会话尚未结束
    }
    // 重新打开（模拟下次启动）：两天都无产物 → 全部回补
    let engine = MemoryEngine::open(dir.path(), clock.clone()).unwrap();
    let filled = engine.startup_backfill().unwrap();
    assert_eq!(
        filled.iter().map(|r| r.date.as_str()).collect::<Vec<_>>(),
        vec!["2026-11-04", "2026-11-06"]
    );
    let md = fs::read_to_string(dir.path().join("agent/reports/2026-11-04.md")).unwrap();
    assert!(md.contains("会话 1 个"));
    // 再跑一次：无漏日
    assert!(engine.startup_backfill().unwrap().is_empty());
}

#[test]
fn rotate_journal_via_engine() {
    let (engine, _clock, dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    engine
        .journal()
        .append("2026-08-08", &started("s1"))
        .unwrap();
    engine
        .journal()
        .append("2026-11-06", &started("s2"))
        .unwrap();
    let removed = engine.rotate_journal().unwrap();
    assert_eq!(removed, vec!["2026-08-08"]);
    assert!(Path::new(&dir.path().join("agent/journal/2026-11-06.jsonl")).is_file());
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
        workspace_name: Some("baobao-chat-72ab07a9e501bc35".into()),
        ..ev.clone()
    };
    let proj_json = serde_json::to_string(&proj).unwrap();
    assert!(proj_json.contains(r#""scope":"project""#));
    assert!(proj_json.contains(r#""workspaceName":"baobao-chat-72ab07a9e501bc35""#));
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

#[test]
fn report_daily_payload_roundtrip_nested_camel_case() {
    let (engine, _clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    engine.record(&started("s1")).unwrap();
    engine
        .record(&ActivityEvent::SessionEnded {
            session: "s1".into(),
            summary: None,
            duration_ms: 8_040_000,
        })
        .unwrap();
    let report = engine.on_session_end().unwrap().unwrap();
    let event = report.to_event();

    let json = serde_json::to_string(&event).unwrap();
    // 顶层 camelCase + 嵌套 stats 自带 camelCase（rename_all 不随结构传导，逐字锁定）
    assert!(json.starts_with(r#"{"date":"2026-11-06","path":""#));
    assert!(json.contains(r#""stats":{"date":"2026-11-06""#));
    assert!(json.contains(r#""totalDurationMs":8040000"#));
    assert!(json.contains(r#""memorySaved":[]"#));
    assert!(json.contains(r#""filesChanged":0"#));
    assert!(!json.contains("total_duration_ms"));
    // roundtrip
    assert_eq!(
        serde_json::from_str::<ReportDailyEvent>(&json).unwrap(),
        event
    );
}
