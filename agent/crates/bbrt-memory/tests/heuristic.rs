//! 启发式集成测试（D15 §6"启发"行全表）：
//! "记住…"模式命中；连续同错 2 次→教训；开关关闭无副作用。
//! 另含 W2 候选 → KnowledgeStore 落盘的联动验证（feedback 格式）。

use std::sync::Arc;

use bbrt_memory::{detect_memory_hint, ErrorTracker, Heuristic, KnowledgeStore, MemoryType};

// ---------------------------------------------------------------------------
// W2①："记住…"模式命中
// ---------------------------------------------------------------------------

#[test]
fn hint_hits_remember_style_messages() {
    for msg in [
        "记住：端口用 8090",
        "以后记得先跑测试再提交",
        "下次注意不要直接改 dist",
        "别忘了周五发版",
        "以后要走 gitee 镜像",
        "下次记得带上 --locked",
    ] {
        let title = detect_memory_hint(msg).unwrap_or_else(|| panic!("应命中: {msg}"));
        assert!(title.contains("8090") || title.contains("记住") || !title.is_empty());
    }
}

#[test]
fn hint_misses_plain_messages() {
    for msg in ["今天天气不错", "帮我看下这个报错", "", "   "] {
        assert!(detect_memory_hint(msg).is_none(), "不应命中: {msg}");
    }
}

#[test]
fn hint_candidate_title_is_first_40_chars() {
    let msg = format!("开头{}结尾——记住这件事", "水".repeat(50));
    let title = detect_memory_hint(&msg).unwrap();
    assert_eq!(title.chars().count(), 40);
    assert!(title.starts_with('开'));
}

// ---------------------------------------------------------------------------
// W2②：连续同错 → feedback 教训
// ---------------------------------------------------------------------------

#[test]
fn consecutive_same_error_produces_lesson_at_second_hit() {
    let mut tracker = ErrorTracker::new(true);
    assert!(
        tracker
            .record_failure("run_command", "exit 127: command not found")
            .is_none(),
        "第 1 次不产出"
    );
    let lesson = tracker
        .record_failure("run_command", "exit 127: command not found")
        .expect("第 2 次产出教训");
    // 标题稳定（工具+错误，不含次数）→ 重复候选可同题更新去重；超 40 字截断
    assert_eq!(lesson.title.chars().count(), 40);
    assert!(lesson
        .title
        .starts_with("工具 run_command 失败：exit 127: command not"));
    assert!(lesson
        .body
        .contains("**Why:** run_command 连续 2 次返回同一错误：exit 127: command not found"));
    assert!(lesson.body.contains("**How to apply:**"));
    // 第 3 次继续产出：标题不变，正文中次数更新
    let again = tracker
        .record_failure("run_command", "exit 127: command not found")
        .unwrap();
    assert_eq!(again.title, lesson.title);
    assert!(again.body.contains("连续 3 次"));
}

#[test]
fn different_error_or_tool_resets_streak() {
    let mut tracker = ErrorTracker::new(true);
    assert!(tracker.record_failure("run_command", "err A").is_none());
    // 换错误 → 重新起算
    assert!(tracker.record_failure("run_command", "err B").is_none());
    assert!(tracker.record_failure("run_command", "err B").is_some());
    // 换工具 → 重新起算
    let mut tracker2 = ErrorTracker::new(true);
    tracker2.record_failure("edit_file", "err A");
    assert!(tracker2.record_failure("run_command", "err A").is_none());
}

#[test]
fn success_breaks_streak_of_same_tool_only() {
    let mut tracker = ErrorTracker::new(true);
    tracker.record_failure("run_command", "err A");
    tracker.record_success("run_command"); // 成功清零
    assert!(
        tracker.record_failure("run_command", "err A").is_none(),
        "成功后重新起算"
    );
    // 其他工具的成功不打断在跟踪的连击
    let mut tracker2 = ErrorTracker::new(true);
    tracker2.record_failure("run_command", "err A");
    tracker2.record_success("edit_file");
    assert!(
        tracker2.record_failure("run_command", "err A").is_some(),
        "无关工具成功不打断"
    );
}

// ---------------------------------------------------------------------------
// 开关关闭（memory.heuristic=off）→ 全部 no-op
// ---------------------------------------------------------------------------

#[test]
fn disabled_heuristic_is_full_noop() {
    let mut heur = Heuristic::new(false);
    assert!(!heur.enabled());
    assert!(
        heur.detect_memory_hint("记住端口 8090").is_none(),
        "① 不产候选"
    );
    assert!(heur.record_tool_failure("run_command", "err").is_none());
    assert!(
        heur.record_tool_failure("run_command", "err").is_none(),
        "② 不产教训"
    );
    heur.record_tool_success("run_command");
    assert!(heur.record_tool_failure("run_command", "err").is_none());
    // 开启后同样输入立即恢复产出
    let mut on = Heuristic::new(true);
    assert!(on.detect_memory_hint("记住端口 8090").is_some());
    on.record_tool_failure("run_command", "err");
    assert!(on.record_tool_failure("run_command", "err").is_some());
}

// ---------------------------------------------------------------------------
// W2 联动：教训候选落盘为 feedback 记忆（同题更新去重）
// ---------------------------------------------------------------------------

#[test]
fn lesson_candidate_saves_as_feedback_memory_once() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(bbrt_memory::FixedClock::new(
        "2026-11-06T10:00:00+08:00",
        "2026-11-06",
    ));
    let store = KnowledgeStore::new(dir.path().join("memory"), clock).unwrap();

    let mut heur = Heuristic::new(true);
    let _ = heur.record_tool_failure("run_command", "exit 127");
    let lesson = heur.record_tool_failure("run_command", "exit 127").unwrap();
    // 第 3 次同错失败 → 标题相同、次数更新的重复候选
    let repeat = heur.record_tool_failure("run_command", "exit 127").unwrap();
    assert_eq!(lesson.title, repeat.title);

    let r1 = store
        .save(&bbrt_memory::SaveInput {
            title: lesson.title.clone(),
            mtype: MemoryType::Feedback,
            body: lesson.body.clone(),
            session: "sess-1".to_string(),
            links: vec![],
        })
        .unwrap();
    assert!(!r1.updated, "首存为新增");
    let r2 = store
        .save(&bbrt_memory::SaveInput {
            title: repeat.title.clone(),
            mtype: MemoryType::Feedback,
            body: repeat.body.clone(),
            session: "sess-1".to_string(),
            links: vec![],
        })
        .unwrap();
    assert!(r2.updated, "重复教训走同题更新");
    assert_eq!(r1.name, r2.name);

    assert_eq!(store.list().len(), 1, "重复教训不重复落盘");
    let saved = store.get(&r1.name).unwrap().unwrap();
    assert_eq!(saved.mtype, MemoryType::Feedback);
    assert!(saved.body.contains("**Why:**"));
    assert!(saved.body.contains("连续 3 次"), "正文更新为最新次数");
}
