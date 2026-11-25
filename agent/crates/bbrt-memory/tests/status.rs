//! D37 项目进度台账集成测试（引擎层）：
//! 建/并/召回三段注入；日常拒绝；同名非 status 条目拒绝覆盖；并发合并不丢更新。
//! 全部走 tempfile 临时目录 + FixedClock。

use std::fs;
use std::sync::Arc;
use std::thread;

use bbrt_memory::{FixedClock, MemoryEngine, MemoryType, SaveInput, StatusDelta, STATUS_TITLE};

fn engine(tag: &str) -> (tempfile::TempDir, MemoryEngine) {
    let dir = tempfile::tempdir().expect("临时目录");
    let _ = tag;
    let eng = MemoryEngine::open(
        &dir.path().join("data"),
        Arc::new(FixedClock::new("2026-11-19T10:00:00+08:00", "2026-11-19")),
    )
    .expect("打开引擎");
    (dir, eng)
}

fn delta(done: &[&str], todo: &[&str]) -> StatusDelta {
    StatusDelta {
        done: done.iter().map(|s| s.to_string()).collect(),
        todo: todo.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

#[test]
fn merge_creates_entry_and_recall_injects_progress() {
    let (dir, eng) = engine("create");
    let ws = dir.path().join("proj-a");
    fs::create_dir_all(&ws).unwrap();

    let (outcome, stats) = eng
        .merge_status(
            &ws,
            &delta(&["11-19 D35：批0-4 已推 697707c"], &["D35：真机八项验收"]),
            "sess-1",
        )
        .unwrap()
        .expect("首次合并应落盘");
    assert_eq!(stats.added, 2);
    assert_eq!(outcome.saved.r#type, MemoryType::Status);
    assert_eq!(outcome.saved.scope, "project");
    assert_eq!(outcome.saved.title, STATUS_TITLE);

    // 条目文件 + 索引行真实落盘（分区名取自引擎回执——调用方 canonicalize 过，
    // 直接本地算 scope_key 会因 macOS /tmp→/private/tmp 别名对不上哈希）
    let key = outcome.saved.workspace_name.clone().expect("分区名");
    let entry_path = dir
        .path()
        .join("data/agent/memory/projects")
        .join(&key)
        .join("项目进度台账.md");
    let body = fs::read_to_string(&entry_path).unwrap_or_default();
    assert!(body.contains("批0-4 已推 697707c"), "条目正文：{body}");
    assert!(body.contains("- [ ] D35：真机八项验收"));
    let index = fs::read_to_string(
        dir.path()
            .join("data/agent/memory/projects")
            .join(key)
            .join("MEMORY.md"),
    )
    .unwrap();
    assert!(index.contains(STATUS_TITLE), "索引行：{index}");

    // 召回：项目会话三段（含 [项目进度]）
    let recalled = eng.recall_scoped(Some(&ws), "进度");
    assert!(recalled.contains("[Project Progress]"), "{recalled}");
    assert!(recalled.contains("批0-4 已推 697707c"));
    assert!(
        recalled.contains("[Project Memory ·"),
        "记忆两段仍在：{recalled}"
    );

    // 二次合并：去重不重复落；新条目插段首
    let (_, stats2) = eng
        .merge_status(&ws, &delta(&["11-19 D37：台账落码"], &[]), "sess-2")
        .unwrap()
        .expect("二次合并应落盘");
    assert_eq!(stats2.added, 1);
    let body2 = eng.status_body(&ws).expect("status_body");
    let i_new = body2.find("D37：台账落码").unwrap();
    let i_old = body2.find("批0-4 已推").unwrap();
    assert!(i_new < i_old, "新条目在前（新→旧）：{body2}");
}

#[test]
fn status_rejected_for_daily_sessions() {
    let (_dir, eng) = engine("daily");
    let input = SaveInput {
        title: STATUS_TITLE.to_string(),
        body: "## 已做\n- x\n".to_string(),
        mtype: MemoryType::Status,
        session: "sess-1".to_string(),
        links: vec![],
    };
    let err = eng.save_memory_scoped(None, &input).unwrap_err();
    assert!(
        matches!(err, bbrt_memory::MemoryError::StatusRequiresProject),
        "日常会话应拒绝 status：{err}"
    );
    // 日常召回无进度段
    assert!(!eng.recall_scoped(None, "").contains("[Project Progress]"));
}

#[test]
fn refuses_to_overwrite_same_title_non_status_entry() {
    let (dir, eng) = engine("refuse");
    let ws = dir.path().join("proj-b");
    fs::create_dir_all(&ws).unwrap();
    // 用户先手写了同题的普通项目记忆（type=project）
    eng.save_memory_scoped(
        Some(&ws),
        &SaveInput {
            title: STATUS_TITLE.to_string(),
            body: "我自己写的进度笔记，不是台账格式".to_string(),
            mtype: MemoryType::Project,
            session: "sess-1".to_string(),
            links: vec![],
        },
    )
    .unwrap();

    let out = eng
        .merge_status(&ws, &delta(&["批0 完成"], &[]), "sess-2")
        .unwrap();
    assert!(out.is_none(), "同名非 status 条目应拒绝合并");
    let body = eng.status_body(&ws);
    assert!(body.is_none(), "非 status 条目不冒充台账");
}

#[test]
fn concurrent_merges_do_not_lose_updates() {
    let (dir, eng) = engine("concurrent");
    let ws = dir.path().join("proj-c");
    fs::create_dir_all(&ws).unwrap();
    let eng = Arc::new(eng);

    let mut handles = Vec::new();
    for i in 0..4 {
        let eng = Arc::clone(&eng);
        let ws = ws.clone();
        handles.push(thread::spawn(move || {
            eng.merge_status(
                &ws,
                &delta(&[&format!("批{i} 完成")], &[&format!("待办 {i}")]),
                &format!("sess-{i}"),
            )
            .unwrap()
            .expect("并发合并应各自落盘");
        }));
    }
    for h in handles {
        h.join().expect("线程 panic");
    }

    let body = eng.status_body(&ws).expect("合并结果");
    for i in 0..4 {
        assert!(body.contains(&format!("批{i} 完成")), "丢更新：{body}");
        assert!(body.contains(&format!("待办 {i}")), "丢更新：{body}");
    }
}
