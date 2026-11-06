//! bbrt-session（骨架）：会话生命周期与状态机（D11 §2.2）。
//! 首期只落 state.rs（纯函数状态机，D11 §3 全 20 条迁移）；
//! manager / loop_runner / pending / wal / recovery / emitter / interrupt / types
//! 按 README 排期后续补齐，落码时保持依赖方向 protocol ← session。

#![forbid(unsafe_code)]

pub mod state;

pub use state::{
    accept_user_message, begin, begin_delegation, begin_fanout, complete_delegation,
    complete_round, end, fail_delegation, fail_initialization, fail_unrecoverable, initialized,
    join_subagents, pause, permission_exhausted, permission_resolved, request_permission,
    request_review, resolve_review, resume, retry_from_error, SessionState, TransitionError,
};
