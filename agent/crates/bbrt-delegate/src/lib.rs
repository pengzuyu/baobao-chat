//! bbrt-delegate：17 篇委派体系——把编码任务委派给用户本地编码智能体
//! （Claude Code / zcode / 通用 CLI）的可插拔后端 crate（D11 §2.6/§8）。
//!
//! 模块地图（D11 §2.6 文件级结构）：
//!
//! | 模块 | 职责 | 设计依据 |
//! |---|---|---|
//! | [`backend`] | `CodingBackend` trait（§8.1 方法表）+ `BackendRegistry` + 会话句柄 | 17 §3.1 |
//! | [`claude`] | Claude Code 适配器（stream-json 行解析、§8.2 参数映射） | 17 §3.2 |
//! | [`zcode`] | zcode 适配器（假定 `--mode` headless + 行文本协议，差异隔离于此） | 17 §11.1 |
//! | [`generic`] | 通用 CLI 适配器（`##BBC:EVT:` 行协议；仅 auto-edit+ 可委派） | 17 §3.2 |
//! | [`builtin`] | 内置后端桥（注册占位；真实循环在编排层进程内，17 §5.2 模式 D） | 17 §5.2 |
//! | [`normalize`] | 子进程原始事件行 → 归一化事件（§8.3 映射表） | 17 §3.3 |
//! | [`procmgr`] | 进程组：新 pgid + BBC_SANDBOX=1 标记；§8.4 取消协议；遗留进程扫描清理 | D11 §8.4 |
//! | [`health`] | detect（`<bin> --version` 5s 超时）+ 版本能力矩阵占位（8031 语义） | D11 §8.5 |
//! | [`workspace_lock`] | 同工作区互斥文件锁（flock；8035 由上层映射） | 17 §5.1 |
//! | [`brief`] | TaskBrief 校验/渲染（forbidden → BBC_BRIEF_FORBIDDEN 环境注入） | 17 §4 |
//!
//! v0.1 务实口径（取舍均登记在各模块注释与本表）：
//! - 对 D11 §1.2 依赖方向（delegate 还应依赖 sec/store）的刻意偏差：本 crate 只依赖
//!   bbrt-protocol——审计落盘（§8.3 "同步写审计"）与 delegate_task/coding_backend 表
//!   由编排层（bbrt-session 装配）经 [`backend::CodingBackend`] 消费归一化事件完成，
//!   保持本 crate 可独立单测（与 bbrt-session 对 hostapi 的倒置同思路）。
//! - probe_health 的"最小 headless 冒烟（30s×3）"默认不自动执行（避免每次健康检查
//!   拉起真实 CLI），提供 [`health::smoke`] 供编排层按需调用（D11 §8.5 登记）。
//! - 登录态探测（未登录降级）依赖各 CLI 私有凭据位置，v0.1 不实现，枚举占位。
//! - 遗留进程扫描：macOS `ps` 不暴露环境变量（实测 darwin 25.5 `ps -E` 无效），
//!   BBC_SANDBOX=1 标记在 macOS 上无法经 ps 验证——退化为 ppid==1/父死 + 命令过滤；
//!   Linux 上读 /proc/<pid>/environ 精确匹配标记（v0.1 已实现，ps 路径为兜底）。
//!
//! 硬约束：仅 serde/serde_json/thiserror + bbrt-protocol；标准库进程/信号/文件锁经
//! libc 符号直连（extern "C"，逐处 SAFETY 注释，做法同 bbrt-sec/sandbox/launcher.rs）；
//! 全部同步 API，禁止 tokio。

#![deny(unsafe_code)]
// 例外：procmgr.rs（setpgid/kill FFI）与 workspace_lock.rs（flock FFI）需要 unsafe，
// 模块内 `#![allow(unsafe_code)]` 并逐处标注 SAFETY（其余模块保持零 unsafe）。

pub mod backend;
pub mod brief;
pub mod builtin;
pub mod claude;
pub mod generic;
pub mod health;
pub mod normalize;
pub mod procmgr;
pub mod workspace_lock;
pub mod zcode;

// ---------------------------------------------------------------------------
// 错误码登记（17 §8：本篇占用 8030-8035；8032 为租户策略侧，由上层映射）
// ---------------------------------------------------------------------------

/// 8030 后端未安装或路径无效
pub const CODE_BACKEND_MISSING: u32 = 8030;
/// 8031 后端版本不满足最低要求
pub const CODE_BACKEND_VERSION_LOW: u32 = 8031;
/// 8032 后端被租户策略禁用（策略在编排层/服务端判定，本 crate 仅登记码值）
pub const CODE_BACKEND_POLICY_DISABLED: u32 = 8032;
/// 8033 子进程异常退出
pub const CODE_CHILD_ABNORMAL_EXIT: u32 = 8033;
/// 8034 委派超时已终止
pub const CODE_DELEGATE_TIMEOUT: u32 = 8034;
/// 8035 工作区被其他委派任务占用
pub const CODE_WORKSPACE_BUSY: u32 = 8035;

pub use backend::{
    BackendProbe, BackendRegistry, CodingBackend, DelegateError, DelegateSession, FinalReport,
    HealthIssue, HealthReport, LaunchOpts,
};
pub use brief::{child_env, forbidden_env_value, render, validate, BriefError, ENV_FORBIDDEN};
pub use builtin::BuiltinBackend;
pub use claude::ClaudeBackend;
pub use generic::GenericCliBackend;
pub use health::{
    capability_matrix, check_version, compare_versions, probe_version, CapabilityMatrix,
    VersionInfo, SMOKE_TIMEOUT_SECS, VERSION_PROBE_TIMEOUT_SECS,
};
pub use normalize::{
    exit_to_delegate_end, parse_prefixed_line, payload_to_events, to_runtime_message, tool_risk,
    EventCtx, EventPayload, LineParser, NormalizedEvent, GENERIC_EVT_PREFIX, ZCODE_EVT_PREFIX,
};
pub use procmgr::{
    cleanup_orphans, scan_orphans, CancelOutcome, ChildProcess, ExitRecord, OrphanInfo,
    CANCEL_GRACE_SECS, ENV_SANDBOX_MARK,
};
pub use workspace_lock::{
    acquire_workspace_lock, WorkspaceLockError, WorkspaceLockGuard, LOCK_FILE_REL,
};
pub use zcode::ZcodeBackend;

/// 单元/集成测试共用的临时目录工具（仅测试编译；集成测试各自内联同款助手）
#[cfg(test)]
pub(crate) mod testing {
    use bbrt_protocol::TaskBrief;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 创建唯一临时目录（调用方负责清理；返回带随机后缀避免并行测试互踩）
    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "bbc-delegate-{tag}-{}-{seq}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("临时目录创建失败");
        dir
    }

    /// 写入可执行 sh 桩脚本，返回绝对路径
    pub(crate) fn write_script(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).expect("桩脚本写入失败");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("桩脚本 chmod 失败");
        path
    }

    /// 标准测试简报（workspace 指定；含 forbidden 两条）
    pub(crate) fn testing_brief(workspace: &std::path::Path) -> TaskBrief {
        TaskBrief {
            task: "给 utils/math.go 增加 Abs 函数".into(),
            workspace: workspace.display().to_string(),
            constraints: vec!["遵循现有代码风格".into()],
            context: vec![],
            acceptance: vec!["go test ./... 通过".into()],
            forbidden: vec!["修改 go.mod".into(), "修改 .github/ 目录".into()],
        }
    }
}
