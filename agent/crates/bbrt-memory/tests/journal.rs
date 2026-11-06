//! 活动日志集成测试（D15 §6"日志"行全表）：
//! 追加/读回；跨日文件切换；坏行容忍（跳过+计数）；90 天保留清理。

use std::fs;
use std::io::Write;

use bbrt_memory::{ActivityEvent, FileChangeKind, Journal, MemoryType};

fn started(session: &str) -> ActivityEvent {
    ActivityEvent::SessionStarted {
        session: session.to_string(),
        workspace: "baobao-work".to_string(),
        mode: "interactive".to_string(),
    }
}

fn tool(session: &str, name: &str, ok: bool) -> ActivityEvent {
    ActivityEvent::ToolExecuted {
        session: session.to_string(),
        tool: name.to_string(),
        ok,
        duration_ms: 10,
        risk: "低".to_string(),
    }
}

// ---------------------------------------------------------------------------
// 追加 / 读回
// ---------------------------------------------------------------------------

#[test]
fn append_and_read_back_same_day() {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("journal")).unwrap();
    let events = vec![
        started("s1"),
        tool("s1", "read_file", true),
        ActivityEvent::ToolBlocked {
            session: "s1".into(),
            tool: "run_command".into(),
            code: 8021,
        },
        ActivityEvent::FileChanged {
            session: "s1".into(),
            path: "src/lib.rs".into(),
            kind: FileChangeKind::Edit,
        },
        ActivityEvent::CheckpointCreated {
            session: "s1".into(),
            reason: "pre-edit".into(),
        },
        ActivityEvent::DelegateLaunched {
            session: "s1".into(),
            backend: "claude".into(),
        },
        ActivityEvent::DelegateEnded {
            session: "s1".into(),
            backend: "claude".into(),
            exit_code: 0,
        },
        ActivityEvent::MemorySaved {
            session: "s1".into(),
            title: "端口 8090 约定".into(),
            memory_type: MemoryType::Project,
        },
        ActivityEvent::SessionEnded {
            session: "s1".into(),
            summary: Some("收尾".into()),
            duration_ms: 8_040_000,
        },
    ];
    for ev in &events {
        journal.append("2026-11-06", ev).unwrap();
    }
    // 文件按行落地（一行一事件）
    let raw = fs::read_to_string(journal.path_for("2026-11-06")).unwrap();
    assert_eq!(raw.lines().count(), 9);
    assert!(raw.contains(r#""type":"session.started""#));
    assert!(raw.contains(r#""type":"session.ended""#));

    // 读回：事件序与写入一致，坏行 0
    let day = journal.read_day("2026-11-06");
    assert_eq!(day.events, events);
    assert_eq!(day.skipped, 0);
}

// ---------------------------------------------------------------------------
// 跨日文件切换
// ---------------------------------------------------------------------------

#[test]
fn cross_day_events_go_to_separate_files() {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("journal")).unwrap();
    journal.append("2026-11-05", &started("s1")).unwrap();
    journal.append("2026-11-06", &started("s2")).unwrap();
    journal
        .append("2026-11-06", &tool("s2", "edit_file", true))
        .unwrap();

    assert!(journal.path_for("2026-11-05").is_file());
    assert!(journal.path_for("2026-11-06").is_file());
    // dates() 升序列出全部日志日；非日期文件不入列
    fs::write(dir.path().join("journal/notes.txt"), "x").unwrap();
    assert_eq!(journal.dates(), vec!["2026-11-05", "2026-11-06"]);

    assert_eq!(journal.read_day("2026-11-05").events, vec![started("s1")]);
    assert_eq!(journal.read_day("2026-11-06").events.len(), 2);
}

// ---------------------------------------------------------------------------
// 坏行容忍（跳过 + 计数）
// ---------------------------------------------------------------------------

#[test]
fn bad_lines_skipped_and_counted() {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("journal")).unwrap();
    journal.append("2026-11-06", &started("s1")).unwrap();
    journal
        .append("2026-11-06", &tool("s1", "read_file", true))
        .unwrap();
    // 手工塞坏行：非 JSON、合法 JSON 但未知事件类型
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(journal.path_for("2026-11-06"))
        .unwrap();
    writeln!(f, "完全不是 json").unwrap();
    writeln!(f, r#"{{"type":"unknown.event"}}"#).unwrap();
    writeln!(f, "   ").unwrap(); // 空白行静默忽略（不计坏行）
    journal
        .append("2026-11-06", &tool("s1", "edit_file", true))
        .unwrap();

    let day = journal.read_day("2026-11-06");
    assert_eq!(day.events.len(), 3, "好行照常读回");
    assert_eq!(day.skipped, 2, "两条坏行跳过并计数");
}

#[test]
fn missing_day_reads_empty() {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("journal")).unwrap();
    let day = journal.read_day("2026-11-06");
    assert!(day.events.is_empty());
    assert_eq!(day.skipped, 0);
    assert!(journal.dates().is_empty());
}

#[test]
fn append_rejects_invalid_date() {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("journal")).unwrap();
    for bad in ["2026-11-6", "not-a-date", "2026-13-01", "../escape"] {
        assert!(
            journal.append(bad, &started("s1")).is_err(),
            "应拒绝: {bad}"
        );
    }
    assert_eq!(journal.dates().len(), 0, "非法日期不落任何文件");
}

// ---------------------------------------------------------------------------
// 90 天保留清理（rotate）
// ---------------------------------------------------------------------------

#[test]
fn rotate_removes_files_beyond_90_days() {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("journal")).unwrap();
    let today = "2026-11-06";
    // 窗口 = [today-89, today]（含今日共 RETENTION_DAYS 天）；锚点经单元测试 shift_date 锁定
    let edge_keep = "2026-08-09"; // today-89，窗口内边界保留
    let edge_drop = "2026-08-08"; // today-90，窗口外删除
    let future = "2026-11-09"; // 未来文件不动
    for date in [edge_keep, edge_drop, today, future] {
        journal.append(date, &started("s1")).unwrap();
    }
    fs::write(dir.path().join("journal/readme.txt"), "不动非日期文件").unwrap();

    let removed = journal.rotate(today).unwrap();
    assert_eq!(removed, vec![edge_drop]);
    assert!(
        journal.path_for(edge_keep).is_file(),
        "90 天窗口内（含边界）保留"
    );
    assert!(!journal.path_for(edge_drop).exists(), "窗口外删除");
    assert!(journal.path_for(today).is_file());
    assert!(journal.path_for(future).is_file(), "未来文件不删");
    assert!(dir.path().join("journal/readme.txt").is_file());
    assert_eq!(journal.dates().len(), 3);

    // 非法 today 拒绝
    assert!(journal.rotate("bad-date").is_err());
}
