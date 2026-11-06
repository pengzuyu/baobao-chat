//! L4 资源限制（D13-B9 第 4 层；09 §7.1 默认值：CPU ≤ 2 核、内存 ≤ 2 GB、并发命令 ≤ 4）。
//!
//! 应用方式：`ResourceLimits::apply(&mut Command)` 经
//! `std::os::unix::process::CommandExt::pre_exec` 在 fork 后 exec 前调 setrlimit
//! （RLIMIT_CPU / RLIMIT_AS / RLIMIT_NOFILE / RLIMIT_NPROC），不新增 libc 依赖
//! （libc 已随 std 链接，直接 extern 声明所需符号）。
//!
//! darwin/arm64 实测口径（本 crate 开发时探测，2026-11，macOS 26.5 arm64）：
//! setrlimit(RLIMIT_AS/RLIMIT_DATA) 返回 EINVAL——内核不支持地址空间硬限；
//! RLIMIT_CPU 设置成功但**不被内核强制执行**（2s 限制下自旋 80s+ 未被杀）。
//! 因此 macOS 上内存/CPU 的真正执行者是 launcher 的 **RSS 看门狗 + 墙钟超时杀树**
//! （D13-B10 macOS 列"尽力而为 + 监控杀超限（8022）"正是此语义）；本模块的 rlimit
//! 在 Linux 上生效、在 macOS 上尽力设置（失败静默忽略，不阻塞 exec）。

#![allow(unsafe_code)]
// SAFETY 说明：本模块 unsafe 仅限 extern "C" 声明与 pre_exec 回调内的系统调用
// （setrlimit），均为 async-signal-safe 的纯 syscall，不触碰分配器/锁。

use std::os::unix::process::CommandExt;
use std::process::Command;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// libc 符号（不引 libc crate；类型按平台 ABI 手写）
// ---------------------------------------------------------------------------

/// setrlimit(2) 的资源参数结构（rlim_t 在 darwin/linux 均为 u64）
#[repr(C)]
#[derive(Clone, Copy)]
struct RLimit {
    /// 软限
    cur: u64,
    /// 硬限
    max: u64,
}

unsafe extern "C" {
    fn setrlimit(resource: i32, rlim: *const RLimit) -> i32;
}

/// darwin / linux 的 RLIMIT 资源号差异（其余平台编译期报错，当前仅支持 unix 两平台）
#[cfg(target_os = "macos")]
mod platform {
    /// RLIMIT_CPU（CPU 时间秒数）
    pub const RLIMIT_CPU: i32 = 0;
    /// RLIMIT_AS（地址空间字节）
    pub const RLIMIT_AS: i32 = 5;
    /// RLIMIT_NOFILE（文件描述符数）
    pub const RLIMIT_NOFILE: i32 = 9;
    /// RLIMIT_NPROC（进程数）
    pub const RLIMIT_NPROC: i32 = 8;
}

#[cfg(target_os = "linux")]
mod platform {
    /// RLIMIT_CPU（CPU 时间秒数）
    pub const RLIMIT_CPU: i32 = 0;
    /// RLIMIT_AS（地址空间字节）
    pub const RLIMIT_AS: i32 = 9;
    /// RLIMIT_NOFILE（文件描述符数）
    pub const RLIMIT_NOFILE: i32 = 7;
    /// RLIMIT_NPROC（进程数）
    pub const RLIMIT_NPROC: i32 = 6;
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("bbrt-sec resource.rs 仅支持 macOS/Linux");

use platform::{RLIMIT_AS, RLIMIT_CPU, RLIMIT_NOFILE, RLIMIT_NPROC};

/// 资源限制配置（09 §7.1 默认矩阵的结构化承载）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimits {
    /// CPU 秒数上限（RLIMIT_CPU；None=由执行侧按"超时+30s"兜底）。
    /// 注：darwin 上 RLIMIT_CPU 不被强制，CPU 限制实际由墙钟超时杀树兜底。
    pub cpu_seconds: Option<u64>,
    /// 内存字节上限（默认 2 GB）：Linux=RLIMIT_AS；macOS=RSS 看门狗监控杀（8022）
    pub memory_bytes: Option<u64>,
    /// 文件描述符上限（RLIMIT_NOFILE；默认 256）
    pub nofile: Option<u64>,
    /// 进程数上限（RLIMIT_NPROC）。默认 None：darwin 上 NPROC 是 **per-UID** 语义，
    /// 设小会让同 UID 的所有进程（含用户会话）fork 失败，只在显式要求时启用
    pub nproc: Option<u64>,
    /// 并发命令进程数（调度层信号量用，launcher 不消费；09 §7.1 默认 ≤4）
    pub max_concurrent_commands: usize,
}

impl Default for ResourceLimits {
    /// 09 §7.1 默认：CPU ≤ 2 核（换算见字段注释）、内存 ≤ 2 GB、NOFILE 256、并发 4
    fn default() -> Self {
        Self {
            cpu_seconds: None,
            memory_bytes: Some(2 * 1024 * 1024 * 1024),
            nofile: Some(256),
            nproc: None,
            max_concurrent_commands: 4,
        }
    }
}

impl ResourceLimits {
    /// 测试用小配置（内存 256 MB / NOFILE 64），避免大预算拖慢断言
    pub fn for_tests() -> Self {
        Self {
            cpu_seconds: Some(10),
            memory_bytes: Some(256 * 1024 * 1024),
            nofile: Some(64),
            nproc: None,
            max_concurrent_commands: 4,
        }
    }

    /// 经 pre_exec 把 rlimit 应用到目标进程（fork 后 exec 前）。
    /// 全部"尽力而为"：任一 setrlimit 失败（如 darwin 的 RLIMIT_AS EINVAL）静默跳过，
    /// 绝不让 spawn 失败——强执行由监控杀超限（launcher）保证。
    pub fn apply(&self, cmd: &mut Command) {
        let cpu = self.cpu_seconds;
        let mem = self.memory_bytes;
        let nofile = self.nofile;
        let nproc = self.nproc;
        // SAFETY: pre_exec 为 unsafe API；回调内仅调用 async-signal-safe 的
        // setrlimit(2)（见 set_one），不触碰分配器与锁
        unsafe {
            cmd.pre_exec(move || {
                set_one(RLIMIT_CPU, cpu);
                set_one(RLIMIT_AS, mem);
                set_one(RLIMIT_NOFILE, nofile);
                set_one(RLIMIT_NPROC, nproc);
                Ok(())
            });
        }
    }

    /// 内存上限的 MB 表示（日志/UI 展示）
    pub fn memory_mb(&self) -> Option<u64> {
        self.memory_bytes.map(|b| b / (1024 * 1024))
    }
}

/// 单项 setrlimit（软=硬；None 跳过；失败忽略——见 apply 注释）
fn set_one(resource: i32, limit: Option<u64>) {
    if let Some(v) = limit {
        let rlim = RLimit { cur: v, max: v };
        // SAFETY: rlim 是本栈帧上的纯值类型，setrlimit 只读
        unsafe {
            setrlimit(resource, &rlim);
        }
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_design_doc_09_7_1() {
        let d = ResourceLimits::default();
        assert_eq!(d.memory_bytes, Some(2 * 1024 * 1024 * 1024)); // 内存 ≤ 2GB
        assert_eq!(d.memory_mb(), Some(2048));
        assert_eq!(d.nofile, Some(256));
        assert_eq!(d.max_concurrent_commands, 4); // 并发命令 ≤ 4
        assert_eq!(d.nproc, None); // darwin per-UID 语义默认关闭
        assert_eq!(d.cpu_seconds, None); // 由超时兜底
    }

    #[test]
    fn for_tests_is_small_budget() {
        let t = ResourceLimits::for_tests();
        assert_eq!(t.memory_mb(), Some(256));
        assert_eq!(t.nofile, Some(64));
        assert_eq!(t.cpu_seconds, Some(10));
    }

    #[test]
    fn apply_registers_pre_exec_without_error() {
        // 只验证注册不炸（真正 spawn 效果在 escape_suite 集成测试覆盖）
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("ok");
        ResourceLimits::default().apply(&mut cmd);
        ResourceLimits::for_tests().apply(&mut cmd);
    }

    #[test]
    fn serde_camel_case_contract() {
        let j = serde_json::to_string(&ResourceLimits::default()).unwrap();
        assert!(j.contains("\"memoryBytes\""));
        assert!(j.contains("\"maxConcurrentCommands\""));
    }

    #[test]
    fn platform_resource_ids_are_consistent() {
        // darwin: CPU=0 AS=5 NOFILE=9 NPROC=8；linux: 0/9/7/6（开发机为 darwin）
        if cfg!(target_os = "macos") {
            assert_eq!(
                (RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE, RLIMIT_NPROC),
                (0, 5, 9, 8)
            );
        }
        if cfg!(target_os = "linux") {
            assert_eq!(
                (RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE, RLIMIT_NPROC),
                (0, 9, 7, 6)
            );
        }
    }
}
