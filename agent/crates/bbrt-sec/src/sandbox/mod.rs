//! 沙箱子模块（D11 §2.5 sandbox/；**D32-2026-11-17：Seatbelt OS 层退场**，见
//! docs/detail/D32——launcher 收缩为进程执行器，词法层 path/network 不变）。
//!
//! 分层对应 D13-B9（D32 修订）：
//! - path.rs：L2 工具层路径校验（白名单/realpath 逃逸/敏感拒读）
//! - network.rs：L2/L3 出站白名单纯逻辑
//! - resource.rs：L4 资源限制（rlimit，尽力而为）
//! - launcher.rs：L5 进程生命周期（超时/杀组/截断/RSS 看门狗）+ violation 记录

pub mod launcher;
pub mod network;
pub mod path;
pub mod resource;

pub use launcher::{
    DetachedCommand, ExitResult, JsonlViolationSink, MemoryViolationSink, RunOpts, RunSpec,
    SandboxLauncher, Violation, ViolationKind, ViolationSink,
};
pub use network::{Cidr, NetPolicy, NetworkError};
pub use path::{PathError, PathIntent, PathPolicy};
pub use resource::ResourceLimits;

/// 默认用户工作区（2026-11-12 ZCode 式口径）：不绑项目的会话——日常对话/任务/
/// IM embedded——共用同一用户级工作空间，不跟随项目走（要操作具体项目=项目会话）。
/// 解析顺序：env `BBC_RT_DEFAULT_WORKSPACE`（测试/运维逃生口）> `~/.baobaochat/workspace`。
/// 只解析路径；目录确保（create_dir_all）由使用侧在首次执行前完成。
pub fn default_user_workspace() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("BBC_RT_DEFAULT_WORKSPACE") {
        let p = p.trim();
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&home).join(".baobaochat/workspace")
}
