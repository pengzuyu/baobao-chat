//! 崩溃恢复重放测试（D11 §9.2）：SQLite WAL 真实写入后 recover() 重建。

use bbrt_session::recovery::recover;
use bbrt_session::state::SessionState;
use bbrt_store::Store;

fn wal(store: &Store, sid: &str, seq: i64, t: &str, payload: &str) {
    store.append_event(sid, seq, t, payload).unwrap();
}

#[test]
fn recover_happy_turn_then_idle() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("t.db")).unwrap();
    let sid = "sess-r1";
    store.insert_session(&row(sid)).unwrap();
    wal(&store, sid, 1, "session.start", r#"{"workspace":"/w"}"#);
    wal(&store, sid, 2, "turn.start", r#"{"text_len":5}"#);
    wal(&store, sid, 3, "user.text", "读一下 foo.txt");
    wal(
        &store,
        sid,
        4,
        "assistant.done",
        r#"{"text_len":0,"finish":"tool_calls"}"#,
    );
    wal(
        &store,
        sid,
        5,
        "tool.call",
        r#"{"call_id":"c1","tool":"read_file"}"#,
    );
    wal(
        &store,
        sid,
        6,
        "tool.result",
        r#"{"call_id":"c1","summary":"1 hello"}"#,
    );
    wal(
        &store,
        sid,
        7,
        "assistant.done",
        r#"{"text_len":10,"finish":"stop"}"#,
    );
    wal(&store, sid, 8, "turn.end", "{}");

    let rep = recover(&store, sid);
    assert!(rep.found);
    assert_eq!(rep.replayed_events, 8);
    assert_eq!(rep.broken, 0);
    assert_eq!(rep.final_state, SessionState::Idle);
    assert!(rep.in_flight_tools.is_empty());
    assert!(rep.void_permissions.is_empty());
    // 历史重建：user + assistant + tool + assistant
    assert_eq!(rep.history.len(), 4);
    assert!(
        matches!(&rep.history[0], bbrt_context::Round::User { content, .. } if content.contains("foo.txt"))
    );
    assert!(
        matches!(&rep.history[2], bbrt_context::Round::Tool { summary, .. } if summary.contains("hello"))
    );
}

#[test]
fn recover_crash_mid_tool_and_pending_permission() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("t.db")).unwrap();
    let sid = "sess-r2";
    store.insert_session(&row(sid)).unwrap();
    wal(&store, sid, 1, "session.start", "{}");
    wal(&store, sid, 2, "turn.start", "{}");
    wal(&store, sid, 3, "user.text", "跑个命令");
    wal(
        &store,
        sid,
        4,
        "assistant.done",
        r#"{"text_len":0,"finish":"tool_calls"}"#,
    );
    wal(
        &store,
        sid,
        5,
        "tool.call",
        r#"{"call_id":"c1","tool":"run_command"}"#,
    );
    wal(
        &store,
        sid,
        6,
        "permission.request",
        r#"{"request_id":"pr-c1"}"#,
    );
    // 崩溃：无 permission.resolved / 无 tool.result / 无 turn.end

    let rep = recover(&store, sid);
    assert_eq!(rep.replayed_events, 6);
    // 未决工具与作废审批
    assert_eq!(rep.in_flight_tools.len(), 1);
    assert_eq!(rep.in_flight_tools[0].name, "run_command");
    assert_eq!(rep.void_permissions, vec!["pr-c1".to_string()]);
    // 中断 turn → paused（可续跑）
    assert_eq!(rep.final_state, SessionState::Paused);
    // 用户输入不丢
    assert!(
        matches!(rep.history.first(), Some(bbrt_context::Round::User { content, .. }) if content == "跑个命令")
    );
}

#[test]
fn recover_broken_seq_counts_and_continues() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("t.db")).unwrap();
    let sid = "sess-r3";
    store.insert_session(&row(sid)).unwrap();
    wal(&store, sid, 1, "session.start", "{}");
    wal(&store, sid, 3, "turn.start", "{}"); // seq=2 缺失
    wal(&store, sid, 4, "user.text", "hi");

    let rep = recover(&store, sid);
    assert_eq!(rep.broken, 1);
    // 断裂行本身不计重放；其后连续事件继续重放（1 与 4）
    assert_eq!(rep.replayed_events, 2);
}

#[test]
fn recover_ended_and_not_found() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("t.db")).unwrap();
    let sid = "sess-r4";
    store.insert_session(&row(sid)).unwrap();
    wal(&store, sid, 1, "session.start", "{}");
    wal(&store, sid, 2, "session.ended", "{}");
    let rep = recover(&store, sid);
    assert_eq!(rep.final_state, SessionState::Ended);

    let none = recover(&store, "sess-ghost");
    assert!(!none.found);
    assert_eq!(none.replayed_events, 0);
}

fn row(id: &str) -> bbrt_store::SessionRow {
    bbrt_store::SessionRow {
        id: id.into(),
        workspace_id: None,
        title: "t".into(),
        form: "workbench".into(),
        mode: "ask".into(),
        model_policy: "fast".into(),
        model_override: None,
        status: "idle".into(),
        share_enabled: false,
        created_at: 0,
        updated_at: 0,
        ended_at: None,
        summary: None,
        conv_id: None,
    }
}
