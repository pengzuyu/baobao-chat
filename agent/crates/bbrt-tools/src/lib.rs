//! bbrt-tools：工具注册表与执行管线（D11 §2.4 / §6）。
//!
//! 职责：
//! - [`registry`]：工具注册表（内置，每条 ToolDef 携带 D13-A2 动作类别与风险级；
//!   2026-11-27 工具面改造：search×1→glob_files+grep_files 拆分，git×4 整域退役
//!   ——git 统一经 run_command 通道，门禁在命令层表达）；
//! - [`pipeline`]：[`PipelineExecutor`] 实现 `bbrt_session::ToolExecutor` 契约
//!   （check/execute/record_grant/tool_specs），对应 D11 §6 九步管线的
//!   ①注册查询→②permission_gate→③确认卡→④沙箱校验→⑤执行→⑥脱敏；
//! - [`builtin`]：内置工具实现（read_file 摘录/敏感拒读、write/edit 白名单、
//!   glob_files/grep_files 检索、run_command 沙箱执行、http_fetch
//!   白名单+沙箱 curl、memory_save 直通 MemoryEngine）；
//! - [`config`]：[`ToolsConfig`]（工作区/例外可写/网络白名单/沙箱执行器/记忆引擎/
//!   journal 回调）与 violation → SQLite 适配器。
//!
//! 硬约束：同步 API（无 tokio）；错误码口径 09 §6.4（8002/8020-8026/8028）；
//! 与 session 的依赖方向：session 定义 `ToolExecutor` trait，本 crate 实现
//! （依赖倒置，D11 §2.2 executor.rs 注释）。

pub mod builtin;
pub mod config;
pub mod pipeline;
pub mod registry;
pub mod whitelist;

pub use config::{StoreViolationSink, ToolsConfig};
pub use pipeline::PipelineExecutor;
pub use registry::{RiskLevel, ToolDef, ToolRegistry};
pub use whitelist::parse_agents_whitelist;

// bbrt-protocol 目前为预登记依赖（wire 层消息由 session/hostapi 使用；
// 本 crate 的 stdio 事件经由 session sink 发射）。
