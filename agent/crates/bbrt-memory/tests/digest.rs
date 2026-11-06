//! 日报集成测试（D15 §6"日报"行全表）：
//! 聚合数字与 journal 一致；幂等重跑；启动回补漏日；空日不出产物。

use std::fs;

use bbrt_memory::digest::DailyStats;
use bbrt_memory::{ActivityEvent, Digest, FileChangeKind, Journal, MemoryType};

/// 造一天贴近 D15 §3.2 示例结构的活动：
/// 2 会话 / 5 工具调用（read×3 edit×1 run×1）/ 拦截 2（8021、8024）/
/// 文件变更 3（edit×2 create×1）/ 检查点 2 / 委派 1（claude exit 0）/
/// 记忆 2（其中 1 条 feedback 教训）
fn seed_day(journal: &Journal, date: &str) {
    let ev = |e: ActivityEvent| journal.append(date, &e).unwrap();
    ev(ActivityEvent::SessionStarted {
        session: "s1".into(),
        workspace: "baobao-work".into(),
        mode: "interactive".into(),
    });
    for tool in ["read_file", "read_file", "read_file", "edit_file"] {
        ev(ActivityEvent::ToolExecuted {
            session: "s1".into(),
            tool: tool.into(),
            ok: true,
            duration_ms: 100,
            risk: "低".into(),
        });
    }
    ev(ActivityEvent::ToolBlocked {
        session: "s1".into(),
        tool: "run_command".into(),
        code: 8021,
    });
    ev(ActivityEvent::FileChanged {
        session: "s1".into(),
        path: "a.rs".into(),
        kind: FileChangeKind::Edit,
    });
    ev(ActivityEvent::FileChanged {
        session: "s1".into(),
        path: "b.rs".into(),
        kind: FileChangeKind::Edit,
    });
    ev(ActivityEvent::FileChanged {
        session: "s1".into(),
        path: "c.md".into(),
        kind: FileChangeKind::Create,
    });
    ev(ActivityEvent::CheckpointCreated {
        session: "s1".into(),
        reason: "pre-edit".into(),
    });
    ev(ActivityEvent::SessionEnded {
        session: "s1".into(),
        summary: None,
        duration_ms: 8_040_000,
    });
    ev(ActivityEvent::SessionStarted {
        session: "s2".into(),
        workspace: "docs-site".into(),
        mode: "interactive".into(),
    });
    ev(ActivityEvent::ToolExecuted {
        session: "s2".into(),
        tool: "run_command".into(),
        ok: false,
        duration_ms: 900,
        risk: "中".into(),
    });
    ev(ActivityEvent::ToolBlocked {
        session: "s2".into(),
        tool: "open_url".into(),
        code: 8024,
    });
    ev(ActivityEvent::CheckpointCreated {
        session: "s2".into(),
        reason: "manual".into(),
    });
    ev(ActivityEvent::DelegateLaunched {
        session: "s2".into(),
        backend: "claude".into(),
    });
    ev(ActivityEvent::DelegateEnded {
        session: "s2".into(),
        backend: "claude".into(),
        exit_code: 0,
    });
    ev(ActivityEvent::MemorySaved {
        session: "s2".into(),
        title: "端口 8090 约定".into(),
        memory_type: MemoryType::Project,
    });
    ev(ActivityEvent::MemorySaved {
        session: "s2".into(),
        title: "run_command 失败教训".into(),
        memory_type: MemoryType::Feedback,
    });
    // s2 未 ended（未结束路径）
}

fn setup() -> (Journal, Digest, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("journal")).unwrap();
    let digest = Digest::new(journal.clone(), dir.path().join("reports")).unwrap();
    (journal, digest, dir)
}

// ---------------------------------------------------------------------------
// 聚合数字与 journal 一致
// ---------------------------------------------------------------------------

#[test]
fn stats_match_journal_events() {
    let (journal, digest, dir) = setup();
    seed_day(&journal, "2026-11-06");

    let report = digest
        .generate("2026-11-06")
        .unwrap()
        .expect("有日志必有产物");
    assert_eq!(report.stats.date, "2026-11-06");
    assert_eq!(report.stats.sessions, 2);
    assert_eq!(report.stats.total_duration_ms, 8_040_000);
    assert_eq!(report.stats.tool_calls, 5);
    assert_eq!(
        report.stats.tools,
        [
            ("edit_file".to_string(), 1u64),
            ("read_file".to_string(), 3),
            ("run_command".to_string(), 1)
        ]
        .into_iter()
        .collect()
    );
    assert_eq!(report.stats.blocked, 2);
    assert_eq!(
        report.stats.blocked_codes,
        [(8021u16, 1u64), (8024, 1)].into_iter().collect()
    );
    assert_eq!(report.stats.files_changed, 3);
    assert_eq!(
        report.stats.file_kinds,
        [("create".to_string(), 1u64), ("edit".to_string(), 2)]
            .into_iter()
            .collect()
    );
    assert_eq!(report.stats.checkpoints, 2);
    assert_eq!(
        report.stats.checkpoint_reasons,
        [("manual".to_string(), 1u64), ("pre-edit".to_string(), 1)]
            .into_iter()
            .collect()
    );
    assert_eq!(report.stats.delegates, 1);
    assert_eq!(report.stats.delegate_exits.len(), 1);
    assert_eq!(report.stats.delegate_exits[0].exit_code, 0);
    assert_eq!(
        report.stats.memory_saved,
        vec!["端口 8090 约定", "run_command 失败教训"]
    );
    assert_eq!(report.stats.feedback_lessons, 1);

    // 会话明细：s1 正常结束带时长；s2 未结束
    let s1 = &report.stats.sessions_detail["s1"];
    assert_eq!(
        (
            s1.workspace.as_str(),
            s1.tools,
            s1.blocked,
            s1.ended,
            s1.duration_ms
        ),
        ("baobao-work", 4, 1, true, 8_040_000)
    );
    let s2 = &report.stats.sessions_detail["s2"];
    assert!((s2.workspace == "docs-site") && !s2.ended && s2.duration_ms == 0);

    // 双产物落盘
    assert!(dir.path().join("reports/2026-11-06.md").is_file());
    assert!(dir.path().join("reports/2026-11-06.json").is_file());
}

#[test]
fn markdown_template_matches_d15_shape() {
    let (journal, digest, dir) = setup();
    seed_day(&journal, "2026-11-06");
    digest.generate("2026-11-06").unwrap();
    let md = fs::read_to_string(dir.path().join("reports/2026-11-06.md")).unwrap();

    assert!(md.starts_with("# 2026-11-06 Agent 日报\n"));
    assert!(md.contains("- 会话 2 个（累计 2h14m）；工作区 baobao-work、docs-site"));
    // Top 工具排行（次数降序）+ 拦截码
    assert!(md.contains(
        "工具调用 5 次：read_file×3 edit_file×1 run_command×1；被拦截 2 次（8021×1 / 8024×1）"
    ));
    assert!(md.contains("文件变更 3：create×1 edit×2；检查点 2（manual×1 pre-edit×1）"));
    assert!(md.contains("委派 1 次（claude，exit 0）；失败教训 1 条"));
    assert!(md.contains("- 今日记忆 +2：「端口 8090 约定」「run_command 失败教训」"));
    // 会话明细表
    assert!(md.contains("## 会话明细"));
    assert!(md.contains("| s1 | baobao-work | 2h14m | 4 | 正常结束 |"));
    assert!(md.contains("| s2 | docs-site | 0s | 1 | 未结束 |"));
}

#[test]
fn json_artifact_is_camel_case_and_roundtrips() {
    let (journal, digest, dir) = setup();
    seed_day(&journal, "2026-11-06");
    let report = digest.generate("2026-11-06").unwrap().unwrap();
    let raw = fs::read_to_string(dir.path().join("reports/2026-11-06.json")).unwrap();
    // 嵌套 struct 自带 camelCase（7698c52 教训）
    for key in [
        "\"date\"",
        "\"sessions\"",
        "\"totalDurationMs\"",
        "\"toolCalls\"",
        "\"tools\"",
        "\"blocked\"",
        "\"blockedCodes\"",
        "\"filesChanged\"",
        "\"fileKinds\"",
        "\"checkpoints\"",
        "\"delegateExits\"",
        "\"memorySaved\"",
        "\"feedbackLessons\"",
        "\"sessionsDetail\"",
        "\"durationMs\"",
        "\"exitCode\"",
    ] {
        assert!(raw.contains(key), "缺 camelCase 键 {key}");
    }
    assert!(!raw.contains("total_duration_ms"));
    // 反序列化回 DailyStats 与内存统计一致
    let parsed: DailyStats = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed, report.stats);
}

// ---------------------------------------------------------------------------
// 幂等重跑
// ---------------------------------------------------------------------------

#[test]
fn regenerate_overwrites_and_reflects_new_events() {
    let (journal, digest, dir) = setup();
    journal
        .append(
            "2026-11-06",
            &ActivityEvent::SessionStarted {
                session: "s1".into(),
                workspace: "w".into(),
                mode: "interactive".into(),
            },
        )
        .unwrap();
    digest.generate("2026-11-06").unwrap().unwrap();
    let md_v1 = fs::read_to_string(dir.path().join("reports/2026-11-06.md")).unwrap();

    // 同日新增事件后重跑 → 覆盖旧产物（不追加、不留副本）
    journal
        .append(
            "2026-11-06",
            &ActivityEvent::MemorySaved {
                session: "s1".into(),
                title: "新记忆".into(),
                memory_type: MemoryType::User,
            },
        )
        .unwrap();
    let report = digest.generate("2026-11-06").unwrap().unwrap();
    let md_v2 = fs::read_to_string(dir.path().join("reports/2026-11-06.md")).unwrap();
    assert_ne!(md_v1, md_v2);
    assert!(md_v2.contains("今日记忆 +1：「新记忆」"));
    assert_eq!(report.stats.memory_saved.len(), 1);
    // reports 目录内同日只有一对产物
    let count = fs::read_dir(dir.path().join("reports")).unwrap().count();
    assert_eq!(count, 2);
}

// ---------------------------------------------------------------------------
// 启动回补漏日
// ---------------------------------------------------------------------------

#[test]
fn backfill_fills_missing_days_only() {
    let (journal, digest, dir) = setup();
    for date in ["2026-11-04", "2026-11-05", "2026-11-06"] {
        journal
            .append(
                date,
                &ActivityEvent::SessionStarted {
                    session: "s1".into(),
                    workspace: "w".into(),
                    mode: "interactive".into(),
                },
            )
            .unwrap();
    }
    // 11-05 已有完整产物（手工预置，内容带标记以验证不被覆盖）
    fs::write(dir.path().join("reports/2026-11-05.md"), "既有日报").unwrap();
    fs::write(dir.path().join("reports/2026-11-05.json"), "{}").unwrap();

    let filled = digest.backfill("2026-11-06").unwrap();
    assert_eq!(
        filled.iter().map(|r| r.date.as_str()).collect::<Vec<_>>(),
        vec!["2026-11-04", "2026-11-06"],
        "只补缺失日，既有日不重算"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("reports/2026-11-05.md")).unwrap(),
        "既有日报"
    );
    assert!(dir.path().join("reports/2026-11-04.md").is_file());
    assert!(dir.path().join("reports/2026-11-06.md").is_file());
    // 再跑一遍：全部齐备 → 空列表（幂等）
    assert!(digest.backfill("2026-11-06").unwrap().is_empty());
}

#[test]
fn backfill_skips_future_journal_dates() {
    let (journal, digest, _dir) = setup();
    journal
        .append(
            "2026-12-25",
            &ActivityEvent::SessionStarted {
                session: "s1".into(),
                workspace: "w".into(),
                mode: "interactive".into(),
            },
        )
        .unwrap();
    let filled = digest.backfill("2026-11-06").unwrap();
    assert!(filled.is_empty(), "未来日期不回补");
}

// ---------------------------------------------------------------------------
// 空日不出产物
// ---------------------------------------------------------------------------

#[test]
fn empty_day_produces_no_artifact() {
    let (_journal, digest, dir) = setup();
    assert!(digest.generate("2026-11-05").unwrap().is_none());
    // 目录存在但没有任何产物文件
    assert_eq!(fs::read_dir(dir.path().join("reports")).unwrap().count(), 0);
    // 空日也不出现在回补结果里
    assert!(digest.backfill("2026-11-06").unwrap().is_empty());
}
