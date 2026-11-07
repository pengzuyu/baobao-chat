//! bbrt-session：会话生命周期、状态机与核心循环（D11 §2.2）。
//!
//! 模块地图：
//! - state.rs      纯函数状态机（D11 §3 全 20 条迁移）
//! - events.rs     会话对外事件（SessionSink；D11 §4 会话子集 + D15 记忆/日报）
//! - executor.rs   工具执行契约（依赖倒置：session 定义、bbrt-tools 实现）
//! - loop_runner.rs 核心循环（08 §4.1 可执行化：组装→流式→工具轮→审批）
//! - manager.rs    多会话管理（≤3 活跃、存储生命周期、审批路由）
//!
//! 对 D11 §1.2 依赖方向的刻意偏差：session 不直接依赖 bbrt-tools/hostapi
//! （工具经 executor trait 倒置、宿主经 sink trait 倒置），使本 crate 可
//! 独立单测；bin 装配时对接。wal 复用 bbrt-store 的 agent_event 表
//! （EventLog trait 适配）。

#![forbid(unsafe_code)]

pub mod events;
pub mod executor;
pub mod loop_runner;
pub mod manager;
pub mod recovery;
pub mod state;

pub use events::{ModelTier, NullSink, SessionEvent, SessionSink, StreamChannel};
pub use executor::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome, ToolPreview};
pub use loop_runner::{
    EventLog, LoopDeps, NoopEventLog, PermissionDecision, PermissionResponse, SessionRunner,
    TurnReport, MAX_CONSECUTIVE_FAILURES, MAX_STEPS, PERMISSION_TIMEOUT,
};
pub use manager::{ManagerError, SessionManager, StartParams};
pub use recovery::{recover, InFlightTool, ReplayReport};
pub use state::{
    accept_user_message, begin, begin_delegation, begin_fanout, complete_delegation,
    complete_round, end, fail_delegation, fail_initialization, fail_unrecoverable, initialized,
    join_subagents, pause, permission_exhausted, permission_resolved, request_permission,
    request_review, resolve_review, resume, retry_from_error, SessionState, TransitionError,
};
