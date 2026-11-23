//! 进程树管理平台层（L5 的 OS 原语；2026-11-23 Windows 移植新增）：
//! unix=POSIX 进程组（pre_exec setpgid + kill(-pgid)），windows=Job Object
//! （CREATE_NEW_PROCESS_GROUP + Assign + TerminateJobObject）。
//!
//! 语义契约（两平台一致，launcher 只面向本层编程）：
//! - [`ProcGroup::configure`]：spawn 前给 Command 挂组/Job 参数（杀树单位=整树）
//! - [`ProcGroup::adopt`]：spawn 后收纳（windows 建 Job 并 Assign 子进程）
//! - [`ProcGroup::signal`]：发信号——SIGINT(2)=温和打断（unix SIGINT / win
//!   CTRL_BREAK_EVENT，宽限后必跟 SIGKILL 兜底，响应差异由 kill_hard 收口）、
//!   SIGKILL(9)=硬杀整树（unix kill(-pgid) / win TerminateJobObject）
//! - [`ProcGroup::rss_bytes`]：组 RSS 尽力查询（unix=ps 按组求和；windows=主进程
//!   WorkingSetSize——近似，与 macOS「尽力而为」监控档同口径 D13-B10）
//! - [`ProcGroup::group_id`]：[`crate::sandbox::launcher::ExitResult`] 的 pgid
//!   契约值（unix=pgid==pid；windows=pid——残留进程排查用）
//!
//! windows 实现注：KILL_ON_JOB_CLOSE 兜底（本层句柄全关后进程树也终结，防泄漏逃逸）；
//! 内存上限沿用 launcher 的 RSS 看门狗轮询+signal(SIGKILL) 路径（保持 8022 violation
//! 语义），不在 Job 上设内核硬限。

#![allow(unsafe_code)]
// SAFETY 说明：unix 侧 unsafe 仅限 extern "C"（kill/setpgid，libc 随 std 链接）与
// pre_exec 回调内的系统调用；windows 侧为 windows-sys FFI 调用——均逐处标注。

/// 温和打断信号值（跨平台契约；unix=SIGINT）
pub(crate) const SIGINT: i32 = 2;
/// 硬杀信号值（跨平台契约；unix=SIGKILL）
pub(crate) const SIGKILL: i32 = 9;

// ---------------------------------------------------------------------------
// unix：POSIX 进程组
// ---------------------------------------------------------------------------

#[cfg(unix)]
pub(crate) struct ProcGroup {
    pgid: i32,
}

#[cfg(unix)]
mod imp {
    use super::ProcGroup;
    use std::process::{Child, Command};

    // SAFETY 说明：本模块 unsafe 仅限 extern "C"（kill/setpgid，libc 随 std 链接）与
    // pre_exec 回调内的系统调用，均为 async-signal-safe 纯 syscall。
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
        fn setpgid(pid: i32, pgid: i32) -> i32;
    }

    impl ProcGroup {
        /// 给命令挂「新进程组」：pre_exec setpgid(0,0)——子进程成为组长（pgid==pid）
        pub(crate) fn configure(cmd: &mut Command) {
            use std::os::unix::process::CommandExt;
            // SAFETY: 回调内仅调用 async-signal-safe 的 setpgid(2)
            unsafe {
                cmd.pre_exec(|| {
                    if setpgid(0, 0) != 0 {
                        // 已有组或被信号打断：进程仍在自身组，杀树退化为杀主进程（尽力）
                    }
                    Ok(())
                });
            }
        }

        /// 收纳：unix 无需额外动作（pgid==pid）
        pub(crate) fn adopt(child: &Child, _mem_cap: Option<u64>) -> ProcGroup {
            ProcGroup {
                pgid: child.id() as i32,
            }
        }

        /// 对整组发信号（kill(-pgid, sig)）
        pub(crate) fn signal(&self, sig: i32) {
            // SAFETY: kill(2) 对负 pid 语义为进程组；返回值无需处理（ESRCH=已死）
            unsafe {
                kill(-self.pgid, sig);
            }
        }

        /// 查询进程组总 RSS（ps -axo pgid=,rss=；单位 KB→B）。失败返回 None（尽力监控）；
        /// 个别行解析异常跳过（ps 表头/僵尸行），不影响本轮求和
        pub(crate) fn rss_bytes(&self, _child: &Child) -> Option<u64> {
            let out = Command::new("/bin/ps")
                .args(["-axo", "pgid=,rss="])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let mut total: u64 = 0;
            for line in text.lines() {
                let mut it = line.split_ascii_whitespace();
                let (Some(g), Some(rss_kb)) = (it.next(), it.next()) else {
                    continue;
                };
                let Ok(g) = g.parse::<i32>() else {
                    continue;
                };
                let rss_kb: u64 = rss_kb.parse().unwrap_or(0);
                if g == self.pgid {
                    total += rss_kb * 1024;
                }
            }
            Some(total)
        }

        pub(crate) fn group_id(&self) -> i32 {
            self.pgid
        }
    }

    /// 从 ExitStatus 提取 (code, signal)（unix）
    pub(crate) fn exit_and_signal(st: &std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = st.signal() {
            (None, Some(sig))
        } else {
            (st.code(), None)
        }
    }
}

// ---------------------------------------------------------------------------
// windows：Job Object
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 平台公共出口（launcher 消费；各平台各取一支）
// ---------------------------------------------------------------------------
pub(crate) use imp::exit_and_signal;

#[cfg(windows)]
pub(crate) struct ProcGroup {
    /// 主进程 id（组标识契约；CTRL_BREAK 事件按组路由也用它）
    pid: u32,
    /// Job 句柄（KILL_ON_JOB_CLOSE；Drop 关闭=兜底终结）
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
mod imp {
    use super::ProcGroup;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, ExitStatus};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;

    /// CREATE_NEW_PROCESS_GROUP：让 CTRL_BREAK_EVENT 可按 pid 路由到该组
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    impl ProcGroup {
        pub(crate) fn configure(cmd: &mut Command) {
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }

        /// 收纳：建 Job（KILL_ON_JOB_CLOSE）并 Assign 子进程——此后整树进 Job，
        /// TerminateJobObject 一次终结（含孙进程；cmd /c 再起的管道进程都算）
        pub(crate) fn adopt(child: &Child, _mem_cap: Option<u64>) -> ProcGroup {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job == INVALID_HANDLE_VALUE || job.is_null() {
                    // Job 建不成（罕见）：退化为只杀主进程（child.kill 由调用方兜底）
                    return ProcGroup {
                        pid: child.id(),
                        job: std::ptr::null_mut(),
                    };
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                // Assign 需要的最小权限 std 的 raw handle 通常已含（PROCESS_ALL_ACCESS）；
                // PROCESS_SET_QUOTA 仅在设了 limit 时需要——这里显式声明意图
                let _ = PROCESS_SET_QUOTA;
                let assigned = ok != 0 && AssignProcessToJobObject(job, child.as_raw_handle()) != 0;
                if !assigned {
                    CloseHandle(job);
                    return ProcGroup {
                        pid: child.id(),
                        job: std::ptr::null_mut(),
                    };
                }
                ProcGroup {
                    pid: child.id(),
                    job,
                }
            }
        }

        /// 对组发信号：SIGINT→CTRL_BREAK_EVENT（windows 控制台组事件，程序可捕获退出；
        /// 不响应者由宽限后的 SIGKILL 兜底）；SIGKILL→TerminateJobObject
        pub(crate) fn signal(&self, sig: i32) {
            unsafe {
                if sig == super::SIGKILL {
                    if !self.job.is_null() {
                        windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
                    }
                } else if sig == super::SIGINT {
                    // 事件按进程组路由（CREATE_NEW_PROCESS_GROUP 前提）
                    let _ = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, self.pid);
                }
            }
        }

        /// 主进程 WorkingSetSize（近似组 RSS；看门狗尽力口径，同 macOS 档）
        pub(crate) fn rss_bytes(&self, child: &Child) -> Option<u64> {
            unsafe {
                let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
                let ok = GetProcessMemoryInfo(
                    child.as_raw_handle(),
                    &mut counters,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                );
                if ok == 0 {
                    return None;
                }
                Some(counters.WorkingSetSize as u64)
            }
        }

        pub(crate) fn group_id(&self) -> i32 {
            self.pid as i32
        }
    }

    impl Drop for ProcGroup {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE：句柄关闭=组内未亡进程一并终结（防泄漏逃逸）
            unsafe {
                if !self.job.is_null() {
                    CloseHandle(self.job);
                }
            }
        }
    }

    /// windows 无信号概念：恒 (code, None)（退出码 1=被 Terminate/内存崩等非零死）
    pub(crate) fn exit_and_signal(st: &ExitStatus) -> (Option<i32>, Option<i32>) {
        (st.code(), None)
    }

    // 消未用 import 警告（PROCESS_SET_QUOTA 仅为意图注释保留）
    #[allow(unused_imports)]
    use super::*;
}
