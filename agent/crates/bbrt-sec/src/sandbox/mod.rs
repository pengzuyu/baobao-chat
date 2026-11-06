//! 沙箱子模块（D11 §2.5 sandbox/；OS 原生实现与降级矩阵以 D13 Part B 为权威）。
//!
//! 分层对应 D13-B9：
//! - path.rs：L2 工具层路径校验（白名单/realpath 逃逸/敏感拒读）
//! - network.rs：L2/L3 出站白名单纯逻辑
//! - resource.rs：L4 资源限制（rlimit，尽力而为）
//! - launcher.rs：L3 OS 包装（Seatbelt/Baseline）+ L5 生命周期 + violation 记录

pub mod launcher;
pub mod network;
pub mod path;
pub mod resource;

pub use launcher::{
    detect, DegradedInfo, ExitResult, JsonlViolationSink, MemoryViolationSink, RunOpts, RunSpec,
    SandboxLauncher, SandboxLevel, SandboxProbe, Violation, ViolationKind, ViolationSink,
};
pub use network::{Cidr, NetPolicy, NetworkError};
pub use path::{PathError, PathIntent, PathPolicy};
pub use resource::ResourceLimits;
