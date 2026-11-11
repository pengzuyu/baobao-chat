//! 状态机迁移表测试（D11 §3）：20 条合法迁移全过 + 非法迁移抽样拒绝。
//! 状态机为纯函数：超时/计数场景由调用方判定后驱动，测试中直接给定终态输入。

use bbrt_session::state::{
    accept_user_message, begin, begin_delegation, begin_fanout, clarify_resolved,
    complete_delegation, complete_round, end, fail_delegation, fail_initialization,
    fail_unrecoverable, initialized, join_subagents, pause, permission_exhausted,
    permission_resolved, request_clarify, request_permission, request_review, resolve_review,
    resume, retry_from_error,
};
use bbrt_session::{SessionState, TransitionError};

const ALL: [SessionState; 11] = [
    SessionState::Starting,
    SessionState::Idle,
    SessionState::Running,
    SessionState::WaitingPermission,
    SessionState::WaitingClarify,
    SessionState::WaitingReview,
    SessionState::SubagentFanout,
    SessionState::Delegating,
    SessionState::Paused,
    SessionState::Error,
    SessionState::Ended,
];

/// 断言合法：迁移成功且到达目标态
fn ok(result: Result<SessionState, TransitionError>, want: SessionState) {
    assert_eq!(result, Ok(want));
}

/// 断言非法：返回 Illegal 且 from 记录实际当前态
fn illegal(result: Result<SessionState, TransitionError>, actual: SessionState) {
    match result {
        Err(TransitionError::Illegal { from, .. }) => assert_eq!(from, actual),
        other => panic!("期望非法迁移，实际: {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// 合法迁移：D11 §3 全迁移表 #1..#20 逐条
// ---------------------------------------------------------------------------

#[test]
fn row_1_new_to_starting() {
    assert_eq!(begin(), SessionState::Starting);
}

#[test]
fn row_2_starting_to_idle() {
    ok(initialized(SessionState::Starting), SessionState::Idle);
}

#[test]
fn row_3_starting_to_error() {
    ok(
        fail_initialization(SessionState::Starting),
        SessionState::Error,
    );
}

#[test]
fn row_4_idle_to_running() {
    ok(
        accept_user_message(SessionState::Idle),
        SessionState::Running,
    );
}

#[test]
fn row_5_running_to_idle() {
    ok(complete_round(SessionState::Running), SessionState::Idle);
}

#[test]
fn row_6_running_to_waiting_permission() {
    ok(
        request_permission(SessionState::Running),
        SessionState::WaitingPermission,
    );
}

#[test]
fn row_7_waiting_permission_to_running() {
    ok(
        permission_resolved(SessionState::WaitingPermission),
        SessionState::Running,
    );
}

#[test]
fn row_8_waiting_permission_to_paused() {
    ok(
        permission_exhausted(SessionState::WaitingPermission),
        SessionState::Paused,
    );
}

/// D20 #6b/#7b：running↔waiting_clarify（无超时，答/停即回 running）
#[test]
fn row_6b_7b_running_waiting_clarify() {
    ok(
        request_clarify(SessionState::Running),
        SessionState::WaitingClarify,
    );
    ok(
        clarify_resolved(SessionState::WaitingClarify),
        SessionState::Running,
    );
    // 非法：非源态不得进入（如 idle 直接等澄清 / waiting_permission 直接回 running）
    illegal(request_clarify(SessionState::Idle), SessionState::Idle);
    illegal(
        clarify_resolved(SessionState::WaitingPermission),
        SessionState::WaitingPermission,
    );
}

#[test]
fn row_9_running_to_subagent_fanout() {
    ok(
        begin_fanout(SessionState::Running),
        SessionState::SubagentFanout,
    );
}

#[test]
fn row_10_subagent_fanout_to_running() {
    ok(
        join_subagents(SessionState::SubagentFanout),
        SessionState::Running,
    );
}

#[test]
fn row_11_running_to_delegating() {
    ok(
        begin_delegation(SessionState::Running),
        SessionState::Delegating,
    );
}

#[test]
fn row_12_delegating_to_running() {
    ok(
        complete_delegation(SessionState::Delegating),
        SessionState::Running,
    );
}

#[test]
fn row_13_delegating_to_error() {
    ok(
        fail_delegation(SessionState::Delegating),
        SessionState::Error,
    );
}

#[test]
fn row_14_running_to_waiting_review() {
    ok(
        request_review(SessionState::Running),
        SessionState::WaitingReview,
    );
}

#[test]
fn row_15_waiting_review_to_running() {
    ok(
        resolve_review(SessionState::WaitingReview),
        SessionState::Running,
    );
}

#[test]
fn row_16_running_to_paused() {
    ok(pause(SessionState::Running), SessionState::Paused);
}

#[test]
fn row_17_paused_to_running() {
    ok(resume(SessionState::Paused), SessionState::Running);
}

#[test]
fn row_18_running_to_error() {
    ok(
        fail_unrecoverable(SessionState::Running),
        SessionState::Error,
    );
}

#[test]
fn row_19_any_to_ended() {
    for st in ALL {
        assert_eq!(end(st), SessionState::Ended, "任意态→ended: {st}");
    }
    // 幂等
    assert_eq!(end(SessionState::Ended), SessionState::Ended);
}

#[test]
fn row_20_error_to_paused() {
    ok(retry_from_error(SessionState::Error), SessionState::Paused);
}

// ---------------------------------------------------------------------------
// 非法迁移抽样拒绝（每个迁移函数的源态约束 + 易混淆路径）
// ---------------------------------------------------------------------------

#[test]
fn illegal_initialization_paths() {
    illegal(initialized(SessionState::Running), SessionState::Running);
    illegal(initialized(SessionState::Idle), SessionState::Idle);
    illegal(fail_initialization(SessionState::Idle), SessionState::Idle);
}

#[test]
fn illegal_input_paths() {
    // running/paused 下不接受"新输入"迁移（paused 恢复必须走 resume）
    illegal(
        accept_user_message(SessionState::Running),
        SessionState::Running,
    );
    illegal(
        accept_user_message(SessionState::Paused),
        SessionState::Paused,
    );
    illegal(
        accept_user_message(SessionState::Ended),
        SessionState::Ended,
    );
    // 任务完成只发生在 running
    illegal(complete_round(SessionState::Idle), SessionState::Idle);
    illegal(
        complete_round(SessionState::WaitingPermission),
        SessionState::WaitingPermission,
    );
}

#[test]
fn illegal_permission_paths() {
    // 权限请求只从 running 进入
    illegal(request_permission(SessionState::Idle), SessionState::Idle);
    illegal(
        request_permission(SessionState::WaitingReview),
        SessionState::WaitingReview,
    );
    // 回填/升级只从 waiting_permission
    illegal(
        permission_resolved(SessionState::Running),
        SessionState::Running,
    );
    illegal(
        permission_resolved(SessionState::Paused),
        SessionState::Paused,
    );
    illegal(
        permission_exhausted(SessionState::Running),
        SessionState::Running,
    );
}

#[test]
fn illegal_fanout_paths() {
    illegal(begin_fanout(SessionState::Idle), SessionState::Idle);
    illegal(
        begin_fanout(SessionState::SubagentFanout),
        SessionState::SubagentFanout,
    );
    illegal(join_subagents(SessionState::Running), SessionState::Running);
    illegal(
        join_subagents(SessionState::Delegating),
        SessionState::Delegating,
    );
}

#[test]
fn illegal_delegation_paths() {
    illegal(begin_delegation(SessionState::Idle), SessionState::Idle);
    illegal(
        begin_delegation(SessionState::Delegating),
        SessionState::Delegating,
    );
    illegal(
        complete_delegation(SessionState::Running),
        SessionState::Running,
    );
    illegal(
        fail_delegation(SessionState::Running),
        SessionState::Running,
    );
    // 注意：delegating 不允许直连 waiting_review（按权威迁移表 #14，须先回 running）
    illegal(
        request_review(SessionState::Delegating),
        SessionState::Delegating,
    );
}

#[test]
fn illegal_review_paths() {
    illegal(resolve_review(SessionState::Running), SessionState::Running);
    illegal(
        resolve_review(SessionState::Delegating),
        SessionState::Delegating,
    );
}

#[test]
fn illegal_pause_resume_paths() {
    illegal(pause(SessionState::Idle), SessionState::Idle);
    illegal(
        pause(SessionState::WaitingPermission),
        SessionState::WaitingPermission,
    );
    illegal(pause(SessionState::Paused), SessionState::Paused);
    illegal(pause(SessionState::Ended), SessionState::Ended);
    illegal(resume(SessionState::Running), SessionState::Running);
    illegal(resume(SessionState::Error), SessionState::Error);
    illegal(resume(SessionState::Ended), SessionState::Ended);
}

#[test]
fn illegal_error_paths() {
    illegal(fail_unrecoverable(SessionState::Idle), SessionState::Idle);
    illegal(
        fail_unrecoverable(SessionState::Paused),
        SessionState::Paused,
    );
    illegal(retry_from_error(SessionState::Paused), SessionState::Paused);
    illegal(
        retry_from_error(SessionState::Running),
        SessionState::Running,
    );
}

// ---------------------------------------------------------------------------
// 端到端生命周期串联（迁移表组合使用）
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_normal_round_with_permission() {
    let s = begin();
    let s = initialized(s).unwrap();
    let s = accept_user_message(s).unwrap(); // running
    let s = request_permission(s).unwrap(); // waiting_permission
    let s = permission_resolved(s).unwrap(); // running（单次超时=拒绝也走此迁移）
    let s = complete_round(s).unwrap(); // idle
    assert_eq!(s, SessionState::Idle);
    assert_eq!(end(s), SessionState::Ended);
}

#[test]
fn lifecycle_permission_timeout_escalation() {
    let s = begin();
    let s = initialized(s).unwrap();
    let s = accept_user_message(s).unwrap();
    let s = request_permission(s).unwrap();
    // 调用方计数：前两次超时=拒绝回填（回 running 再入等待）
    let s = permission_resolved(s).unwrap();
    let s = request_permission(s).unwrap();
    // 第 3 次：累计 ≥3 → paused
    let s = permission_exhausted(s).unwrap();
    assert_eq!(s, SessionState::Paused);
    let s = resume(s).unwrap(); // 用户恢复
    assert_eq!(complete_round(s).unwrap(), SessionState::Idle);
}

#[test]
fn lifecycle_subagent_then_delegation_then_review() {
    let s = begin();
    let s = initialized(s).unwrap();
    let s = accept_user_message(s).unwrap();
    let s = begin_fanout(s).unwrap();
    let s = join_subagents(s).unwrap(); // running
    let s = begin_delegation(s).unwrap(); // delegating
    let s = complete_delegation(s).unwrap(); // running（#12）
    let s = request_review(s).unwrap(); // waiting_review（#14，running 出发）
    let s = resolve_review(s).unwrap(); // running
    assert_eq!(complete_round(s).unwrap(), SessionState::Idle);
}

#[test]
fn lifecycle_error_retry_loop() {
    let s = begin();
    let s = initialized(s).unwrap();
    let s = accept_user_message(s).unwrap();
    let s = pause(s).unwrap(); // 8011 暂停
    let s = resume(s).unwrap();
    let s = fail_unrecoverable(s).unwrap(); // 8010 → error
    let s = retry_from_error(s).unwrap(); // 用户重试 → paused
    let s = resume(s).unwrap(); // → running
    assert_eq!(s, SessionState::Running);
}

#[test]
fn lifecycle_delegation_failure() {
    let s = begin();
    let s = initialized(s).unwrap();
    let s = accept_user_message(s).unwrap();
    let s = begin_delegation(s).unwrap();
    let s = fail_delegation(s).unwrap(); // 8033/8034 → error
    assert_eq!(s, SessionState::Error);
    assert_eq!(end(s), SessionState::Ended);
}

// ---------------------------------------------------------------------------
// 错误类型契约
// ---------------------------------------------------------------------------

#[test]
fn transition_error_impl_std_error() {
    fn assert_error<E: std::error::Error>() {}
    assert_error::<TransitionError>();
    let e = TransitionError::Illegal {
        from: SessionState::Idle,
        to: SessionState::Running,
        reason: "test",
    };
    assert!(e.to_string().contains("idle"));
    assert!(e.to_string().contains("running"));
}

#[test]
fn session_state_enum_is_shared_with_protocol() {
    // 状态枚举权威在 bbrt-protocol（session.state 消息契约）；serde 线路名断言见
    // bbrt-protocol/tests/roundtrip.rs 的 golden_session_state_report_names，
    // 此处只验证 re-export 一致与名称往返。
    for st in ALL {
        assert_eq!(SessionState::parse(&st.to_string()), Some(st));
    }
    assert_eq!(
        SessionState::parse("delegating"),
        Some(SessionState::Delegating)
    );
    assert_eq!(SessionState::parse("active"), None); // 08 篇旧枚举不得出现
}
