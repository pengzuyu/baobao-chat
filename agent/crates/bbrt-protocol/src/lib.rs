//! bbrt-protocol：宿主 ↔ Runtime stdio JSONL 协议（D11 §2.1、§4 全消息表）。
//! 仅依赖 serde/serde_json/thiserror，不含任何业务逻辑（D11 §1.2：protocol ← 所有 crate）。

#![forbid(unsafe_code)]

pub mod codec;
pub mod envelope;

pub use codec::{read_message, write_message, MAX_LINE_BYTES};
pub use envelope::{
    Blocked, BriefContextItem, CheckpointReason, CompactionPhase, Decision, DelegateEventKind,
    EndReason, Envelope, FileChange, GrantScope, HostToRuntime, ModelPolicy, ModelSwitchReason,
    PermissionMode, Preview, ProtocolError, RenewReason, ReviewDecision, RiskLevel, RuntimeToHost,
    SessionState, StreamChannel, SubagentPhase, SubagentResult, TaskBrief, ToolSource,
    ToolsReloadReason, Usage, PROTOCOL_VERSION,
};
// CodecError 定义于 codec 模块（envelope 内不再重复导出）
pub use codec::CodecError;
