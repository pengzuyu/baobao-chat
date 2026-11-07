//! 同工作区互斥文件锁（17 §5.1：同一项目工作区同时只允许一个委派任务运行；
//! D11 §2.6 workspace_lock.rs）。
//!
//! 实现：`<workspace>/.bbw/delegate.lock` 上 flock(LOCK_EX|LOCK_NB)——占用立即失败
//! （排队策略由上层决定：拒绝并提示/排队）。Err 语义 8035 由上层映射
//! （[`crate::CODE_WORKSPACE_BUSY`]），锁文件内写入持有者 pid 便于排查。
//!
//! SAFETY 策略：flock(2) 经 extern "C" 直连（libc 随 std 链接，不引 libc crate），
//! 逐处注释；fd 关闭时锁自动释放，Drop 内再显式 LOCK_UN 双保险。

#![allow(unsafe_code)]

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use crate::CODE_WORKSPACE_BUSY;

/// 锁文件相对路径（workspace 下）
pub const LOCK_FILE_REL: &str = ".bbw/delegate.lock";

// flock(2) 操作码（BSD/Linux 一致）
const LOCK_EX: i32 = 2; // 排他锁
const LOCK_NB: i32 = 4; // 非阻塞
const LOCK_UN: i32 = 8; // 解锁

unsafe extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

/// 工作区锁错误
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceLockError {
    /// 已被其他委派任务占用（8035）
    #[error("工作区被其他委派任务占用（8035）: {0}")]
    Busy(String),
    /// 锁文件 IO 错误
    #[error("工作区锁 IO 错误: {0}")]
    Io(#[from] std::io::Error),
}

impl WorkspaceLockError {
    /// 协议错误码（Busy → 8035；Io 无专属码，上层按 9000 系处理）
    pub fn error_code(&self) -> Option<u32> {
        match self {
            WorkspaceLockError::Busy(_) => Some(CODE_WORKSPACE_BUSY),
            WorkspaceLockError::Io(_) => None,
        }
    }
}

/// 工作区锁守卫：持有即独占；Drop 解锁（跨进程互斥由内核 flock 保证，
/// 同进程内两个 fd 二次获取同样失败——flock 锁属于 open file description）
#[derive(Debug)]
pub struct WorkspaceLockGuard {
    file: File,
    path: PathBuf,
    workspace: PathBuf,
}

impl WorkspaceLockGuard {
    /// 锁文件路径（排查用）
    pub fn lock_path(&self) -> &Path {
        &self.path
    }

    /// 被锁定的工作区
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
}

impl Drop for WorkspaceLockGuard {
    fn drop(&mut self) {
        // SAFETY: flock(LOCK_UN) 对本进程持有的 fd 解锁；返回值忽略
        // （fd 随 File drop 关闭，锁必然释放，此处仅显式化语义）
        unsafe {
            flock(self.file.as_raw_fd(), LOCK_UN);
        }
    }
}

/// 获取工作区互斥锁（非阻塞）：成功返回守卫；被占用返回
/// [`WorkspaceLockError::Busy`]（上层映射 8035，17 §5.1 "排队或拒绝并提示"）。
pub fn acquire_workspace_lock(workspace: &Path) -> Result<WorkspaceLockGuard, WorkspaceLockError> {
    let dir = workspace.join(".bbw");
    fs::create_dir_all(&dir)?;
    let path = dir.join("delegate.lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)?;
    // SAFETY: flock(2) LOCK_EX|LOCK_NB 非阻塞获取；rc!=0 即未获得（EWOULDBLOCK 等，
    // v0.1 不细分 errno，一律按占用处理——登记：细分 errno 需 errno 线程本地读取）
    let rc = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
    if rc != 0 {
        return Err(WorkspaceLockError::Busy(workspace.display().to_string()));
    }
    // 持有者信息（覆盖写；锁本身由 flock 保证，文件内容仅排查用）
    let mut f = &file;
    let _ = writeln!(f, "pid={}", std::process::id());
    Ok(WorkspaceLockGuard {
        file,
        path,
        workspace: workspace.to_path_buf(),
    })
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;

    #[test]
    fn second_acquire_fails_with_8035_and_release_allows_reacquire() {
        let dir = testing::temp_dir("lock");
        let ws = dir.join("ws");
        fs::create_dir_all(&ws).unwrap();

        let g1 = acquire_workspace_lock(&ws).unwrap();
        // 同进程不同 fd 二次获取：flock 属于 open file description → 失败
        let err = acquire_workspace_lock(&ws).unwrap_err();
        assert!(matches!(err, WorkspaceLockError::Busy(_)));
        assert_eq!(err.error_code(), Some(8035));
        assert!(g1.lock_path().ends_with(LOCK_FILE_REL));

        drop(g1);
        // 释放后可重新获取
        let g2 = acquire_workspace_lock(&ws).unwrap();
        assert_eq!(g2.workspace(), ws.as_path());
    }

    #[test]
    fn lock_file_records_holder_pid() {
        let dir = testing::temp_dir("lockpid");
        let ws = dir.join("ws");
        fs::create_dir_all(&ws).unwrap();
        let g = acquire_workspace_lock(&ws).unwrap();
        let content = fs::read_to_string(g.lock_path()).unwrap();
        assert!(content.contains(&format!("pid={}", std::process::id())));
    }
}
