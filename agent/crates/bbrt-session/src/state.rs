//! 会话状态机（D11 §3 迁移表；委派审查迁移 #11-15 已随外部委派域退役
//! 2026-11-18，现存 starting + 7 态）。
//!
//! 不变量：
//! - 纯函数、无 IO、无时钟：超时判定（waiting_permission 120s 视为拒绝；OBO 60s 宽限）与计数（步数>50、连续失败>3、累计超时≥3）全部由调用方判定后
//!   驱动对应迁移函数，状态机只保证"迁移合法性"。
//! - D11 §3 的"transition() 是唯一出口"在此落实为：全部迁移函数收敛到私有 expect()，
//!   后续 emitter/wal（§2.2）在统一出口挂接 WAL 同步与 session.state 上报。
//! - 任意态 → ended 由 end() 覆盖（迁移表 #19）；error → paused 仅用户重试（#20）。

/// 会话状态枚举。权威定义在 bbrt-protocol：它是 session.state 消息的 payload 契约，
/// 依赖方向 protocol ← session（D11 §1.2），此处 re-export 供状态机使用。
pub use bbrt_protocol::SessionState;

/// 非法迁移错误（实现 std::error::Error）
/// Display 用 SessionState 线路名（小写 snake），与日志/消息契约一致
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransitionError {
    #[error("非法状态迁移: {from} → {to}（{reason}）")]
    Illegal {
        from: SessionState,
        to: SessionState,
        reason: &'static str,
    },
}

/// 合法性判定唯一出口：当前态必须等于期望源态，否则报非法迁移
fn expect(
    from: SessionState,
    to: SessionState,
    actual: SessionState,
    reason: &'static str,
) -> Result<SessionState, TransitionError> {
    if actual == from {
        Ok(to)
    } else {
        Err(TransitionError::Illegal {
            from: actual,
            to,
            reason,
        })
    }
}

/// #1 (new)→starting：收到 session.start
pub fn begin() -> SessionState {
    SessionState::Starting
}

/// #2 starting→idle：工作区加载、上下文恢复完成（上报 session.ready）。
/// 恢复重放 >30s 视为失败：调用方改走 fail_initialization（8012）。
pub fn initialized(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Starting,
        SessionState::Idle,
        state,
        "初始化完成（D11 §3 #2）",
    )
}

/// #3 starting→error：工作区无效 / 重放损坏（error 8012, fatal=false）
pub fn fail_initialization(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Starting,
        SessionState::Error,
        state,
        "初始化失败（D11 §3 #3）",
    )
}

/// #4 idle→running：user.message（有效任务文本）
pub fn accept_user_message(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Idle,
        SessionState::Running,
        state,
        "新输入进入循环（D11 §3 #4）",
    )
}

/// #5 running→idle：模型 finish=stop（任务完成，上报 stream.done）
pub fn complete_round(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Running,
        SessionState::Idle,
        state,
        "任务完成（D11 §3 #5）",
    )
}

/// #6 running→waiting_permission：门控第⑥步 confirm（上报 permission.request）。
/// 不变量：单次 120s 超时=拒绝、拒绝理由回填后回 running；该计时与计数由调用方驱动。
pub fn request_permission(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Running,
        SessionState::WaitingPermission,
        state,
        "需用户确认（D11 §3 #6）",
    )
}

/// #7 waiting_permission→running：允许 / 拒绝 / 单次超时（=拒绝，理由回填）
pub fn permission_resolved(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::WaitingPermission,
        SessionState::Running,
        state,
        "权限确认回填（D11 §3 #7）",
    )
}

/// #8 waiting_permission→paused：累计 ≥3 次超时（09 §7.4；计数由调用方维护）
pub fn permission_exhausted(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::WaitingPermission,
        SessionState::Paused,
        state,
        "累计超时升级暂停（D11 §3 #8）",
    )
}

/// #6b running→waiting_clarify：ask_user 工具触发澄清提问（上报 clarify.request）。
/// 不变量：**无超时**——一直等用户（D20；区别于 #6 的 120s）；
/// 用户「停止」中断时由调用方收口（回 running 后走正常中断路径）。
pub fn request_clarify(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Running,
        SessionState::WaitingClarify,
        state,
        "澄清提问（D20 #6b）",
    )
}

/// #7b waiting_clarify→running：收到 clarify.response（answers 回填工具结果）
pub fn clarify_resolved(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::WaitingClarify,
        SessionState::Running,
        state,
        "澄清回答回填（D20 #7b）",
    )
}

/// #9 running→subagent_fanout：主 Agent 调 spawn_subagents 发起子 agent 派发（上报 subagent.spawn×n；
/// 2026-11-26 前为主请求前的快模型判定触发）
pub fn begin_fanout(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Running,
        SessionState::SubagentFanout,
        state,
        "fan-out 并行探查（D11 §3 #9）",
    )
}

/// #10 subagent_fanout→running：join 汇总（失败子任务带失败标注；单子任务 >15 步自杀）
pub fn join_subagents(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::SubagentFanout,
        SessionState::Running,
        state,
        "join 汇总（D11 §3 #10）",
    )
}

/// #16 running→paused：用户暂停 / OBO 到期 60s 续不上 / 8011 / 步数>50 /
/// 连续失败>3 / 休眠>10min / 紧急停止（紧急停止=未决权限作废）
pub fn pause(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Running,
        SessionState::Paused,
        state,
        "暂停（D11 §3 #16）",
    )
}

/// #17 paused→running：session.resume / 续签成功 / 网络恢复重试
pub fn resume(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Paused,
        SessionState::Running,
        state,
        "恢复（D11 §3 #17）",
    )
}

/// #18 running→error：不可恢复错误（压缩后仍超限 8010 等）
pub fn fail_unrecoverable(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Running,
        SessionState::Error,
        state,
        "不可恢复错误（D11 §3 #18）",
    )
}

/// #19 任意→ended：session.end（正常/登出/revoked）；OBO 销毁、进程清理。
/// 幂等：ended 再 end 仍为 ended。
pub fn end(_state: SessionState) -> SessionState {
    SessionState::Ended
}

/// #20 error→paused：用户选择重试（可续跑错误）
pub fn retry_from_error(state: SessionState) -> Result<SessionState, TransitionError> {
    expect(
        SessionState::Error,
        SessionState::Paused,
        state,
        "用户重试（D11 §3 #20）",
    )
}
