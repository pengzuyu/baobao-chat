//! bbrt-sec：BaobaoChat Agent Runtime 的安全与沙箱 crate
//!（D11 §2.5 文件级结构；门控/审计语义权威=09 篇，OS 沙箱权威=D13 Part B）。
//!
//! 模块地图（本期落地范围；policy.rs / audit.rs / injection.rs 按 D11 排期后续补齐）：
//!
//! | 模块 | 职责 | 设计依据 |
//! |---|---|---|
//! | [`errors`] | 沙箱错误码常量 8020–8026（引用的 8002/8006 一并集中） | 09 §6.4 |
//! | [`gate`] | permission_gate()：①策略②权限点③矩阵④记忆⑤不可信⑥confirm | 09 §4.1 + D13-A2 |
//! | [`danger_rules`] | 危险命令规则库（内置 20 条 + 租户热更） | 09 §4.4 + D13-A5 |
//! | [`memory`] | 三级授权记忆 once/session/permanent（**权限记忆**，非知识记忆） | 09 §4.2 |
//! | [`masking`] | 打码模式库（AK/SK、JWT、password=、私钥块）+ args_digest | 09 §7.2 |
//! | [`sandbox`] | L2 路径/网络校验 + L4 rlimit + L3/L5 Seatbelt 执行器 + violation | D13-B9/B10 |
//!
//! 逃逸测试套件（D13-B12 全表 9 用例）在 `tests/escape_suite.rs`，真实执行。
//!
//! 硬约束：仅 serde/serde_json/thiserror + 标准库（信号/rlimit 经 extern "C" 声明，
//! libc 随 std 链接，不新增依赖）；全部同步 API，禁止 tokio。

#![deny(unsafe_code)]
// 例外：sandbox/resource.rs 与 sandbox/launcher.rs 需 pre_exec/kill/setpgid FFI，
// 模块内已 `#![allow(unsafe_code)]` 并逐处标注 SAFETY（其余模块保持零 unsafe）。

pub mod danger_rules;
pub mod errors;
pub mod gate;
pub mod masking;
pub mod memory;
pub mod sandbox;
pub mod shell_readonly;

pub use danger_rules::{DangerRuleSet, Rule, RuleCategory, RuleHit};
pub use errors::{
    CODE_NETWORK_NOT_ALLOWED, CODE_NO_PERMISSION_POINT, CODE_RESOURCE_LIMIT, CODE_SANDBOX_DENIED,
    CODE_SENSITIVE_READ, CODE_SYMLINK_ESCAPE, CODE_TIMEOUT, CODE_TOOL_DISABLED,
};
pub use gate::{
    permission_gate, ActionCategory, AllowSource, Decision, GateCtx, PermissionMode, ToolCall,
    ToolPolicy, PERM_FULL_AUTO, PERM_RUN_COMMAND,
};
pub use masking::{args_digest, mask, mask_and_digest};
pub use memory::{Grant, GrantMatch, GrantScope, GrantStore, MemoryError};
pub use shell_readonly::is_readonly_command;
pub use sandbox::{
    Cidr, ExitResult, JsonlViolationSink, MemoryViolationSink, NetPolicy, NetworkError, PathError,
    PathIntent, PathPolicy, ResourceLimits, RunOpts, RunSpec, SandboxLauncher, Violation,
    ViolationKind, ViolationSink,
};
