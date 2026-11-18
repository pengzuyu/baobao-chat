//! 进程组管理（D11 §8.4 取消协议；17 §9 "子进程卡死/失控"）。
//!
//! - 启动：新进程组（pre_exec `setpgid(0,0)`，效果等价 setsid 建组的委派场景：
//!   子进程自成组长，pgid==pid，杀组即杀树）+ 环境标记 `BBC_SANDBOX=1`；
//! - 取消：graceful=true → `SIGINT(pgid)` → 等 3s → 未退出 `SIGKILL` 整组；
//!   graceful=false → 直接 `SIGKILL` 整组；主进程收割后防御性补杀组内残留
//!   （nohup/后台子进程场景，同 bbrt-sec/sandbox/launcher.rs 做法）；
//! - 遗留进程扫描清理：Runtime 启动时扫"带 BBC_SANDBOX=1 标记且父进程已死"的
//!   进程并清理（09 §4.6）。v0.1 实现：
//!   - Linux：读 `/proc/<pid>/environ` 精确匹配标记（首选，已实现）；
//!   - macOS：`ps -E` 实测不暴露环境（darwin 25.5），退化为 `ps -eo pid,pgid,ppid,command`
//!     解析 + ppid==1/父已死 + 调用方命令过滤（cmd_filter）双重条件，防止误杀
//!     launchd 代理；"ps 带 env 视图 /Linux /proc 批量扫描"已实现或登记于 crate 注释。
//!
//! stderr 处置：v0.1 重定向 /dev/null（防后端海量 stderr 填满管道阻塞子进程）；
//! 登记偏差：后续参照 bbrt-sec launcher 改临时文件捕获供诊断。

#![allow(unsafe_code)]

use std::io::{self, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 进程组沙箱标记（D11 §8.4；与 bbrt-sec 命名一致，遗留进程扫描按此识别）
pub const ENV_SANDBOX_MARK: &str = "BBC_SANDBOX";

/// graceful 取消的宽限时长（D11 §8.4：SIGINT → 3s → SIGKILL）
pub const CANCEL_GRACE_SECS: u64 = 3;

/// stdout EOF 后等待主进程退出的宽限（孙进程持管道场景），超时强杀组
const REAP_GRACE_AFTER_EOF: Duration = Duration::from_secs(2);

/// 轮询间隔（try_wait 循环）
const POLL_INTERVAL: Duration = Duration::from_millis(20);

// ---------------------------------------------------------------------------
// libc 符号（进程组信号；不引 libc crate，做法同 bbrt-sec/sandbox/launcher.rs）
// ---------------------------------------------------------------------------

/// SIGINT 信号值（darwin/linux 一致）
const SIGINT: i32 = 2;
/// SIGKILL 信号值
const SIGKILL: i32 = 9;

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn setpgid(pid: i32, pgid: i32) -> i32;
    fn getpgrp() -> i32;
}

/// kill(2)：对负 pid 语义为进程组
fn kill_raw(pid: i32, sig: i32) -> i32 {
    // SAFETY: kill(2) 纯 syscall；返回值仅用于 ESRCH 判断（已死进程视为已送达）
    unsafe { kill(pid, sig) }
}

// ---------------------------------------------------------------------------
// 退出记录
// ---------------------------------------------------------------------------

/// 子进程退出记录（exit_code 与 signal 互斥：信号死亡无退出码）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ExitRecord {
    /// 退出码（信号死亡为 None）
    pub exit_code: Option<i32>,
    /// 致死信号（正常退出为 None；SIGKILL=9 为强杀标记）
    pub signal: Option<i32>,
}

impl ExitRecord {
    /// 从 ExitStatus 提取（unix）
    pub fn from_status(st: &ExitStatus) -> Self {
        if let Some(sig) = st.signal() {
            Self {
                exit_code: None,
                signal: Some(sig),
            }
        } else {
            Self {
                exit_code: st.code(),
                signal: None,
            }
        }
    }

    /// 正常成功退出（exit_code==0）
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }

    /// 异常退出（非零退出码或信号死亡；上层映射 8033，17 §8）
    pub fn abnormal(&self) -> bool {
        !self.ok()
    }
}

/// 取消结果（§8.4）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CancelOutcome {
    /// 是否走了 graceful 路径（SIGINT 先行）
    pub graceful: bool,
    /// 是否升级到 SIGKILL（graceful 宽限超时，或直接强杀）
    pub escalated_to_kill: bool,
    /// 主进程退出记录
    pub record: ExitRecord,
    /// 取消耗时（毫秒）
    pub waited_ms: u128,
}

// ---------------------------------------------------------------------------
// 受管子进程
// ---------------------------------------------------------------------------

/// 受管子进程：新进程组启动 + BBC_SANDBOX=1 标记 + §8.4 取消协议。
/// `child`/`stdin` 各持 Mutex——stream_events 阻塞读 stdout 期间，其他线程可
/// 并发 send_input/cancel（两把锁不嵌套获取，无死锁路径）。
#[derive(Debug)]
pub struct ChildProcess {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    /// 进程组 id（== 主进程 pid；pre_exec setpgid(0,0) 保证）
    pub pgid: i32,
    /// 启动程序（诊断用）
    pub program: String,
}

/// 启动受管子进程：返回 (进程句柄, stdout, stderr)。stdin 由句柄持有（send_input 用）。
/// 环境注入 BBC_SANDBOX=1（遗留扫描依据）+ 调用方附加 envs（简报 forbidden 等）。
/// stderr 改管道捕获（2026-11-18：claude 卡死排查时 stderr 全不可见——API 重试/
/// 权限/网络报错直接丢失；调用方经 DelegateSession 读线程转发为 warning 事件）。
pub fn spawn(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(String, String)],
) -> io::Result<(ChildProcess, ChildStdout, ChildStderr)> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env(ENV_SANDBOX_MARK, "1");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // 新进程组：pre_exec setpgid(0,0)——子进程成为组长（pgid==pid），杀组即杀树。
    // SAFETY: pre_exec 回调内仅调用 async-signal-safe 的 setpgid(2)；失败不阻断
    // exec（进程仍在继承组，杀树退化为杀主进程，尽力语义同 bbrt-sec launcher）
    unsafe {
        cmd.pre_exec(|| {
            let _ = setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    let pgid = child.id() as i32;
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("stdout 管道未创建"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("stderr 管道未创建"))?;
    Ok((
        ChildProcess {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pgid,
            program: program.to_string(),
        },
        stdout,
        stderr,
    ))
}

impl ChildProcess {
    /// 主进程 pid（== pgid）
    pub fn pid(&self) -> i32 {
        self.child.lock().unwrap_or_else(|p| p.into_inner()).id() as i32
    }

    /// 向 stdin 写一行（send_input；末尾补 \n）。stdin 已关闭/对端退出 → Err。
    pub fn write_line(&self, line: &str) -> io::Result<()> {
        let mut guard = self.stdin.lock().unwrap_or_else(|p| p.into_inner());
        let Some(w) = guard.as_mut() else {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "子进程 stdin 已关闭",
            ));
        };
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
        w.flush()
    }

    /// 关闭 stdin（部分后端以 EOF 为结束信号；显式丢弃即关闭 fd）
    pub fn close_stdin(&self) {
        let mut guard = self.stdin.lock().unwrap_or_else(|p| p.into_inner());
        *guard = None;
    }

    /// 向整进程组发信号（kill(-pgid)）
    pub fn signal_group(&self, sig: i32) {
        let _ = kill_raw(-self.pgid, sig);
    }

    /// 是否已退出（非收割探测）
    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        self.child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .try_wait()
    }

    /// 阻塞收割主进程（**不杀组**——区别于 cancel/reap_after_eof 的防御性补杀；
    /// 用于"子进程应存活于组内"的场景，如遗留进程扫描测试的孤儿制造器）
    pub fn wait(&self) -> io::Result<ExitStatus> {
        self.child.lock().unwrap_or_else(|p| p.into_inner()).wait()
    }

    fn lock_child(&self) -> MutexGuard<'_, Child> {
        self.child.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 限期内轮询等待退出（true=已退出；收割由调用方 wait 完成）
    fn wait_until_exited(&self, dur: Duration) -> bool {
        let deadline = Instant::now() + dur;
        loop {
            match self.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) => {}
                Err(_) => return true, // waitpid 失败按已退出处理，走兜底杀组
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// 取消（§8.4）：
    /// - graceful=true：SIGINT(组) → 宽限 [`CANCEL_GRACE_SECS`] 秒 → 未退出 SIGKILL(组)；
    /// - graceful=false：直接 SIGKILL(组)。
    ///
    /// 收尾防御性补杀组内残留并 wait 收割主进程（防僵尸）。
    pub fn cancel(&self, graceful: bool) -> io::Result<CancelOutcome> {
        let started = Instant::now();
        let mut escalated = true;
        if graceful {
            self.signal_group(SIGINT);
            escalated = !self.wait_until_exited(Duration::from_secs(CANCEL_GRACE_SECS));
        }
        if escalated {
            self.signal_group(SIGKILL);
        }
        let st = {
            let mut child = self.lock_child();
            child.wait()?
        };
        // 防御性补杀组内残留（主进程退出后仍存的后台子进程）
        self.signal_group(SIGKILL);
        Ok(CancelOutcome {
            graceful,
            escalated_to_kill: escalated,
            record: ExitRecord::from_status(&st),
            waited_ms: started.elapsed().as_millis(),
        })
    }

    /// stdout EOF 后收割：限期等待主进程退出（孙进程持管道场景），超时强杀组；
    /// 返回退出记录；组内残留防御性补杀。
    pub fn reap_after_eof(&self) -> io::Result<ExitRecord> {
        let st = if self.wait_until_exited(REAP_GRACE_AFTER_EOF) {
            {
                let mut child = self.lock_child();
                child.wait()?
            }
        } else {
            self.signal_group(SIGKILL);
            let mut child = self.lock_child();
            child.wait()?
        };
        self.signal_group(SIGKILL);
        Ok(ExitRecord::from_status(&st))
    }
}

// ---------------------------------------------------------------------------
// 遗留进程扫描清理（09 §4.6：Runtime 启动时清理"带标记且父已死"的进程）
// ---------------------------------------------------------------------------

/// 遗留进程信息
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrphanInfo {
    pub pid: i32,
    pub pgid: i32,
    pub ppid: i32,
    /// 命令行（ps 输出原样）
    pub command: String,
    /// BBC_SANDBOX=1 标记是否经 /proc 精确验证（macOS 上恒 false：ps 无 env 视图）
    pub marker_verified: bool,
}

/// ps 行（`ps -eo pid=,pgid=,ppid=,command=` 输出）
#[derive(Debug, Clone, PartialEq, Eq)]
struct PsRow {
    pid: i32,
    pgid: i32,
    ppid: i32,
    command: String,
}

/// 获取进程表（macOS/Linux 通用 ps 子集；失败返回空表）
fn process_table() -> Vec<PsRow> {
    let out = Command::new("ps")
        .args(["-eo", "pid=,pgid=,ppid=,command="])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows = Vec::new();
    for line in text.lines() {
        let mut it = line.split_ascii_whitespace();
        let (Some(pid), Some(pgid), Some(ppid)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let (Ok(pid), Ok(pgid), Ok(ppid)) =
            (pid.parse::<i32>(), pgid.parse::<i32>(), ppid.parse::<i32>())
        else {
            continue;
        };
        let command = it.collect::<Vec<_>>().join(" ");
        rows.push(PsRow {
            pid,
            pgid,
            ppid,
            command,
        });
    }
    rows
}

/// Linux：读 /proc/<pid>/environ 精确验证 BBC_SANDBOX=1。
/// 返回 None = 平台无 /proc（macOS）→ 标记不可验证。
fn env_marker_verified(pid: i32) -> Option<bool> {
    let environ = Path::new("/proc").join(pid.to_string()).join("environ");
    match std::fs::read(&environ) {
        Ok(bytes) => {
            let marker = format!("{}=1", ENV_SANDBOX_MARK);
            Some(bytes.split(|b| *b == 0).any(|kv| kv == marker.as_bytes()))
        }
        Err(_) => {
            if Path::new("/proc").exists() {
                // 读失败（非本用户进程等）：视为无标记
                Some(false)
            } else {
                // macOS：无 /proc，ps 亦无 env 视图 → 不可验证
                None
            }
        }
    }
}

/// 本进程组 id（防自杀过滤）
fn own_pgid() -> i32 {
    // SAFETY: getpgrp(2) 纯 syscall，无副作用
    unsafe { getpgrp() }
}

/// 扫描遗留委派进程（带 BBC_SANDBOX=1 标记且父已死）。
///
/// 识别条件（全部满足）：
/// 1. 排除本进程、自身进程组与 pid/pgid<=1（防自杀/防杀 launchd 组）；
/// 2. 父已死：ppid==1（reparent 到 launchd/init）或 ppid 不在进程表；
/// 3. 标记验证：Linux /proc 可验则必须含 BBC_SANDBOX=1；macOS 无法验证时
///    **必须**提供 cmd_filter 且命令行命中（防误杀用户 launchd 代理，登记）；
/// 4. cmd_filter 给出时命令行还需命中过滤串。
pub fn scan_orphans(cmd_filter: Option<&str>) -> Vec<OrphanInfo> {
    let table = process_table();
    let our_pid = std::process::id() as i32;
    let our_pgid = own_pgid();
    let alive = |pid: i32| table.iter().any(|r| r.pid == pid);
    let mut found = Vec::new();
    for row in &table {
        if row.pid == our_pid || row.pid <= 1 || row.pgid == our_pgid || row.pgid <= 1 {
            continue;
        }
        let parent_dead = row.ppid == 1 || !alive(row.ppid);
        if !parent_dead {
            continue;
        }
        let marker_verified = match env_marker_verified(row.pid) {
            Some(true) => true,
            // 明确无标记（/proc 可验且不含 BBC_SANDBOX=1）
            Some(false) => continue,
            None => match cmd_filter {
                // macOS：env 不可验证 → 必须有 cmd_filter 且命中才纳入
                Some(f) if row.command.contains(f) => false,
                _ => continue,
            },
        };
        if let Some(f) = cmd_filter {
            if !row.command.contains(f) {
                continue;
            }
        }
        found.push(OrphanInfo {
            pid: row.pid,
            pgid: row.pgid,
            ppid: row.ppid,
            command: row.command.clone(),
            marker_verified,
        });
    }
    found
}

/// 扫描并清理遗留进程（SIGKILL 进程组 + 单进程兜底；非子进程无法 wait，由 init 回收）。
/// 返回被清理的进程列表（Runtime 启动时调用，09 §4.6）。
pub fn cleanup_orphans(cmd_filter: Option<&str>) -> Vec<OrphanInfo> {
    let targets = scan_orphans(cmd_filter);
    for o in &targets {
        // SAFETY: kill(2)——先杀组（覆盖其子进程），组已回收时单进程兜底
        let _ = kill_raw(-o.pgid, SIGKILL);
        let _ = kill_raw(o.pid, SIGKILL);
    }
    targets
}

// ---------------------------------------------------------------------------
// 单元测试（真实进程；集成级场景在 tests/）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;
    use std::io::{BufRead, BufReader};

    #[test]
    fn spawn_creates_own_process_group_with_sandbox_mark() {
        // pgid==pid（pre_exec setpgid(0,0)）
        let (proc, _stdout, _stderr) = spawn("/bin/sleep", &["5".into()], None, &[]).unwrap();
        assert_eq!(proc.pgid, proc.pid());
        let _ = proc.cancel(false).unwrap();

        // BBC_SANDBOX=1 标记经子进程自身回显验证（走我们的 spawn 路径）
        let dir = testing::temp_dir("mark");
        let script = testing::write_script(&dir, "mark.sh", "#!/bin/sh\nprintenv BBC_SANDBOX\n");
        let script_str = script.to_string_lossy().into_owned();
        let (proc, stdout, _stderr) = spawn("/bin/sh", &[script_str], None, &[]).unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "1");
        let _ = proc.reap_after_eof().unwrap();
    }

    #[test]
    fn write_line_roundtrip_through_cat() {
        let (proc, stdout, _stderr) = spawn("/bin/cat", &[], None, &[]).unwrap();
        proc.write_line("hello-procmgr").unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line.trim_end(), "hello-procmgr");
        proc.close_stdin();
        let rec = proc.reap_after_eof().unwrap();
        assert!(rec.ok());
    }

    #[test]
    fn force_cancel_kills_stubborn_process() {
        let (proc, _stdout, _stderr) = spawn("/bin/sleep", &["120".into()], None, &[]).unwrap();
        let outcome = proc.cancel(false).unwrap();
        assert!(outcome.escalated_to_kill);
        assert!(!outcome.graceful);
        assert_eq!(outcome.record.signal, Some(9));
        // 已收割：再探测不阻塞
        assert!(proc.try_wait().unwrap().is_some());
    }

    #[test]
    fn write_line_after_exit_reports_broken_pipe() {
        let dir = testing::temp_dir("epipe");
        let script = testing::write_script(&dir, "quick.sh", "#!/bin/sh\nexit 0\n");
        let script_str = script.to_string_lossy().into_owned();
        let (proc, stdout, _stderr) = spawn("/bin/sh", &[script_str], None, &[]).unwrap();
        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        while reader.read_line(&mut buf).unwrap_or(0) > 0 {
            buf.clear();
        }
        let _ = proc.reap_after_eof().unwrap();
        assert!(proc.write_line("late").is_err());
    }

    #[test]
    fn exit_record_semantics() {
        let ok = ExitRecord {
            exit_code: Some(0),
            signal: None,
        };
        assert!(ok.ok() && !ok.abnormal());
        let bad = ExitRecord {
            exit_code: Some(7),
            signal: None,
        };
        assert!(!bad.ok() && bad.abnormal());
        let killed = ExitRecord {
            exit_code: None,
            signal: Some(9),
        };
        assert!(!killed.ok() && killed.abnormal());
    }
}
