//! L3/L5 沙箱执行器（D13-B10 macOS 档 + B9 管线 3–5 层；D11 §2.5 sandbox/launcher）。
//!
//! 两条执行路径：
//! - **Seatbelt**（macOS 标准档）：`/usr/bin/sandbox-exec -f profile cmd`，profile 语义
//!   =全盘只读 + 仅工作区/临时目录可写 + 断网（`(deny network*)`，D13-B10 原文）；
//! - **Baseline**（降级档，B11）：不带 sandbox-exec，但保留 rlimit + 进程组 + 超时 +
//!   输出截断 + RSS 看门狗，结果带 `sandbox_level=baseline` 供 UI 徽标展示。
//!
//! 探测：`detect()` 检查 /usr/bin/sandbox-exec 存在 + 最小命令冒烟（profile 执行
//! /bin/echo，2s 超时）；不可用 → Baseline + [`DegradedInfo`]（按 B11：命令逐次确认、
//! 网络类命令一律拒绝、模式上限压到 auto-edit）。
//!
//! 生命周期（L5）：新进程组（pre_exec setpgid(0,0)）→ 墙钟超时（默认 300s，可配 1–600s）
//! → SIGINT → 3s 宽限 → SIGKILL 杀**整组**（kill(-pgid)）；主进程退出后防御性补杀
//! 组内残留（nohup 后台进程场景，B12 行 8）。输出经临时文件捕获（不受残留进程持管道
//! 影响而挂起），累计 1 MB 截断（头尾各 50% + `[truncated, total=N bytes]` 标注）。
//!
//! darwin/arm64 实测注（2026-11，macOS 26.5）：RLIMIT_AS 设置 EINVAL、RLIMIT_CPU 不被
//! 强制 → 内存上限由 **RSS 看门狗**执行（ps 轮询进程组 RSS，超限杀组记 8022），
//! CPU 由墙钟超时兜底——对应 D13-B10 macOS 列"尽力而为 + 监控杀超限"。

#![allow(unsafe_code)]
// SAFETY 说明：本模块 unsafe 仅限 extern "C"（kill/setpgid，libc 随 std 链接）与
// pre_exec 回调内的系统调用，均为 async-signal-safe 纯 syscall。

use std::fs;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::errors::{CODE_RESOURCE_LIMIT, CODE_TIMEOUT};
use crate::sandbox::resource::ResourceLimits;

/// sandbox-exec 二进制路径（macOS 固定位置）
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// 输出捕获上限：1 MB（09 §4.3 管线 [6]），截断保头尾各 50%
pub const OUTPUT_LIMIT: u64 = 1024 * 1024;

/// 默认超时 300s（09 §4.3 [7]）
pub const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// 超时下限/上限（1–600s 可调）
pub const MIN_TIMEOUT_SECS: u64 = 1;
pub const MAX_TIMEOUT_SECS: u64 = 600;

/// SIGINT 之后的宽限时长（D13-B9 L5：SIGINT → 3s → SIGKILL）
const GRACE: Duration = Duration::from_secs(3);

/// RSS 看门狗轮询间隔（macOS 监控杀超限的执行粒度）
const WATCHDOG_INTERVAL: Duration = Duration::from_millis(200);

// ---------------------------------------------------------------------------
// libc 符号（进程组信号；不引 libc crate）
// ---------------------------------------------------------------------------

/// SIGINT 信号值（darwin/linux 一致）
const SIGINT: i32 = 2;
/// SIGKILL 信号值
const SIGKILL: i32 = 9;

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn setpgid(pid: i32, pgid: i32) -> i32;
}

// ---------------------------------------------------------------------------
// Violation 记录（09 §5.1 agent_sandbox_violation）
// ---------------------------------------------------------------------------

/// 违规种类（09 §5.1 kind 列）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViolationKind {
    /// 路径越界/符号链接逃逸
    Path,
    /// 网络出站越白名单
    Network,
    /// 资源超限/超时
    Resource,
    /// 规则库拦截
    Rule,
    /// 危险命令
    DangerCmd,
}

/// 一条沙箱违规记录（UI"被阻止的操作"与审计数据源）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    /// 种类
    pub kind: ViolationKind,
    /// 错误码（8020–8026）
    pub code: u32,
    /// 详情（人读）
    pub detail: String,
    /// 时间戳（epoch 毫秒）
    pub ts_ms: u64,
}

impl Violation {
    /// 便捷构造（取当前时间）
    pub fn now(kind: ViolationKind, code: u32, detail: impl Into<String>) -> Self {
        Self {
            kind,
            code,
            detail: detail.into(),
            ts_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }
}

/// violation 记录出口（内存/JSONL 两个实现；上层可注入 SQLite/审计链实现）
pub trait ViolationSink: Send + Sync {
    /// 追加一条记录（实现需保证线程安全；不允许 panic 影响主流程）
    fn append(&self, violation: Violation);
}

/// 内存实现（测试与 UI 实时展示）
#[derive(Debug, Default)]
pub struct MemoryViolationSink {
    items: Mutex<Vec<Violation>>,
}

impl MemoryViolationSink {
    /// 空 sink
    pub fn new() -> Self {
        Self::default()
    }

    /// 快照
    pub fn snapshot(&self) -> Vec<Violation> {
        self.items.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// 是否存在指定错误码的记录
    pub fn has_code(&self, code: u32) -> bool {
        self.items
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|v| v.code == code)
    }

    /// 清空
    pub fn clear(&self) {
        self.items.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

impl ViolationSink for MemoryViolationSink {
    fn append(&self, violation: Violation) {
        self.items
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(violation);
    }
}

/// JSONL 追加实现（本地 agent/sandbox/violation 落盘形态，一行一条 JSON）
#[derive(Debug)]
pub struct JsonlViolationSink {
    path: PathBuf,
    file: Mutex<fs::File>,
}

impl JsonlViolationSink {
    /// 打开（追加模式创建）指定 JSONL 文件
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path.as_ref())?;
        Ok(Self {
            path: path.as_ref().to_path_buf(),
            file: Mutex::new(file),
        })
    }

    /// 落盘路径
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl ViolationSink for JsonlViolationSink {
    fn append(&self, violation: Violation) {
        // 写失败不 panic（磁盘满等）：violation 是尽力记录，主流程不受影响
        if let Ok(mut f) = self.file.lock() {
            if let Ok(line) = serde_json::to_string(&violation) {
                let _ = writeln!(f, "{line}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 探测与降级（B10/B11）
// ---------------------------------------------------------------------------

/// 沙箱等级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxLevel {
    /// macOS Seatbelt（sandbox-exec profile：全盘只读+白名单可写+断网）
    Seatbelt,
    /// Baseline（仅 rlimit + 门控 + 进程组/超时/截断/看门狗；无 OS 文件/网络隔离）
    Baseline,
}

/// 降级信息（B11 降级矩阵的用户可见面：徽标 + 模式上限 + 网络命令处置）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradedInfo {
    /// 降级原因（徽标 tooltip 展示）
    pub reason: String,
    /// 模式上限压低（"auto-edit"：完全控制不可进，B11 规则）
    pub mode_cap: &'static str,
    /// 网络类命令是否一律拒绝（B11：sandbox-exec 不可用 → 网络命令拒绝）
    pub network_denied: bool,
    /// 命令是否一律逐次确认（等同 ask 档命令语义）
    pub per_confirm: bool,
}

/// 探测结果：等级 + 降级信息（Seatbelt 可用时 degraded=None）
#[derive(Debug, Clone, PartialEq)]
pub struct SandboxProbe {
    /// 探测到的等级
    pub level: SandboxLevel,
    /// 降级信息（level=Baseline 时必有）
    pub degraded: Option<DegradedInfo>,
}

/// 沙箱执行器（detect 一次，run 多次）
#[derive(Debug, Clone)]
pub struct SandboxLauncher {
    probe: SandboxProbe,
}

impl Default for SandboxLauncher {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxLauncher {
    /// 探测并构造（sandbox-exec 存在性 + 2s 冒烟）
    pub fn new() -> Self {
        Self { probe: detect() }
    }

    /// 使用指定探测结果构造（测试注入/缓存复用）
    pub fn from_probe(probe: SandboxProbe) -> Self {
        Self { probe }
    }

    /// 当前等级
    pub fn level(&self) -> SandboxLevel {
        self.probe.level
    }

    /// 降级信息
    pub fn degraded(&self) -> Option<&DegradedInfo> {
        self.probe.degraded.as_ref()
    }

    /// 执行命令（同步；见模块注释的生命周期与截断语义）
    pub fn run(&self, spec: &RunSpec, opts: &RunOpts) -> ExitResult {
        let started = Instant::now();
        let timeout = Duration::from_secs(clamp_timeout(opts.timeout_secs));
        let level = match opts.force_level {
            Some(l) => l,
            None => self.probe.level,
        };

        // 临时目录：输出捕获文件 + Seatbelt profile + 命令 TMPDIR（自管理则不清理）
        let temp_dir = match &opts.temp_dir {
            Some(p) => p.clone(),
            None => unique_temp_dir(),
        };
        if let Err(e) = fs::create_dir_all(&temp_dir) {
            return ExitResult::spawn_fail(&temp_dir, level, &format!("临时目录创建失败: {e}"));
        }
        let _temp_guard = TempDirGuard {
            path: temp_dir.clone(),
            keep: opts.keep_temp || opts.temp_dir.is_some(),
        };

        let mut writable_roots = opts.writable_roots.clone();
        if !writable_roots.contains(&temp_dir) {
            writable_roots.push(temp_dir.clone());
        }

        // 组装命令：Seatbelt 包一层 sandbox-exec -f profile
        let stdout_file = temp_dir.join("stdout.bin");
        let stderr_file = temp_dir.join("stderr.bin");
        let mut argv: Vec<String> = Vec::new();
        let profile_path;
        if level == SandboxLevel::Seatbelt {
            profile_path = temp_dir.join("sb.profile");
            let profile = build_seatbelt_profile(&writable_roots, opts.allow_network);
            if fs::write(&profile_path, &profile).is_err() {
                return ExitResult::spawn_fail(&temp_dir, level, "profile 写入失败");
            }
            argv.push(SANDBOX_EXEC.to_string());
            argv.push("-f".into());
            argv.push(profile_path.to_string_lossy().into_owned());
        }
        argv.push(spec.program.clone());
        argv.extend(spec.args.iter().cloned());

        // 输出重定向到文件（避免残留进程持管道导致读取挂起）
        let out_f = match fs::File::create(&stdout_file) {
            Ok(f) => f,
            Err(e) => {
                return ExitResult::spawn_fail(
                    &temp_dir,
                    level,
                    &format!("stdout 文件创建失败: {e}"),
                )
            }
        };
        let err_f = match fs::File::create(&stderr_file) {
            Ok(f) => f,
            Err(e) => {
                return ExitResult::spawn_fail(
                    &temp_dir,
                    level,
                    &format!("stderr 文件创建失败: {e}"),
                )
            }
        };

        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..])
            .stdout(Stdio::from(out_f))
            .stderr(Stdio::from(err_f))
            .env("BBC_SANDBOX", "1")
            .env("TMPDIR", &temp_dir)
            .env("TMP", &temp_dir);
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        opts.limits.apply(&mut cmd);

        // 新进程组：pre_exec setpgid(0,0)——子进程成为组长，pgid==pid，杀组即杀树
        // SAFETY: pre_exec 回调内仅调用 async-signal-safe 的 setpgid(2)
        unsafe {
            cmd.pre_exec(|| {
                if setpgid(0, 0) != 0 {
                    // 已有组或被信号打断：进程仍在自身组，杀树退化为杀主进程（尽力）
                }
                Ok(())
            });
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return ExitResult::spawn_fail(&temp_dir, level, &format!("spawn 失败: {e}"));
            }
        };
        let pgid = child.id() as i32;

        // ---- 等待/超时/看门狗循环 ----
        let deadline = started + timeout;
        let mut next_watchdog = Instant::now();
        let mut timeout_killed = false;
        let mut resource_killed = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(_) => break, // waitpid 失败按已退出处理，走兜底杀组
            }
            let now = Instant::now();
            if now >= deadline {
                // 超时：SIGINT 组 → 宽限 → SIGKILL 组（8023）。无论 SIGINT 是否已杀掉，
                // 超时事实成立——timeout_killed 先置位再击杀
                timeout_killed = true;
                record(
                    opts,
                    Violation::now(
                        ViolationKind::Resource,
                        CODE_TIMEOUT,
                        format!("进程组 {pgid} 超时（{}s）被终止", timeout.as_secs()),
                    ),
                );
                kill_group(pgid, SIGINT);
                if !wait_grace(&mut child, GRACE) {
                    kill_group(pgid, SIGKILL);
                }
                let _ = child.wait();
                break;
            }
            // RSS 看门狗（macOS 内存上限的执行者；有上限才轮询）
            if let Some(cap) = opts.limits.memory_bytes {
                if now >= next_watchdog {
                    next_watchdog = now + WATCHDOG_INTERVAL;
                    if let Some(rss) = group_rss_bytes(pgid) {
                        if rss > cap {
                            kill_group(pgid, SIGKILL);
                            resource_killed = true;
                            record(
                                opts,
                                Violation::now(
                                    ViolationKind::Resource,
                                    CODE_RESOURCE_LIMIT,
                                    format!("进程组 {pgid} RSS {rss} 超上限 {cap}（8022 监控杀）"),
                                ),
                            );
                            let _ = child.wait();
                            break;
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        // 主进程已退出：防御性补杀组内残留（nohup/后台 & 场景，B12 行 8）
        kill_group(pgid, SIGKILL);
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(100)); // 给内核回收时间

        // 资源死亡推断（非超时的信号死亡：如 darwin 上 exec 后 rlimit 触发的 SIGKILL）
        let status = child.wait();
        let (exit_code, signal) = match status {
            Ok(s) => exit_and_signal(&s),
            Err(_) => (None, None),
        };
        if !timeout_killed && !resource_killed && signal.is_some() {
            resource_killed = true;
            record(
                opts,
                Violation::now(
                    ViolationKind::Resource,
                    CODE_RESOURCE_LIMIT,
                    format!("进程组 {pgid} 被信号 {signal:?} 终止（疑似资源超限 8022）"),
                ),
            );
        }

        let (stdout, stdout_trunc, stdout_total) = read_captured(&stdout_file);
        let (stderr, stderr_trunc, stderr_total) = read_captured(&stderr_file);

        ExitResult {
            exit_code,
            signal,
            ok: exit_code == Some(0),
            duration_ms: started.elapsed().as_millis(),
            stdout,
            stderr,
            truncated: stdout_trunc || stderr_trunc,
            total_output_bytes: stdout_total + stderr_total,
            timeout_killed,
            resource_killed,
            sandbox_level: level,
            pgid,
            temp_dir: temp_dir.clone(),
        }
    }
}

/// 超时收敛到 [1,600]s
fn clamp_timeout(secs: u64) -> u64 {
    secs.clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS)
}

/// 探测：sandbox-exec 存在 + 最小命令冒烟（2s 超时；执行 /bin/echo）
pub fn detect() -> SandboxProbe {
    let baseline = |reason: String| SandboxProbe {
        level: SandboxLevel::Baseline,
        degraded: Some(DegradedInfo {
            reason,
            mode_cap: "auto-edit",
            network_denied: true,
            per_confirm: true,
        }),
    };
    if !Path::new(SANDBOX_EXEC).exists() {
        return baseline(format!("{SANDBOX_EXEC} 不存在"));
    }
    // 冒烟：最小 profile 执行 /bin/echo（inline -p，2s 墙钟超时）
    let spawned = Command::new(SANDBOX_EXEC)
        .args(["-p", "(version 1)(allow default)", "/bin/echo", "ok"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return baseline(format!("{SANDBOX_EXEC} spawn 失败: {e}")),
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => {
                return SandboxProbe {
                    level: SandboxLevel::Seatbelt,
                    degraded: None,
                };
            }
            Ok(Some(st)) => {
                return baseline(format!("冒烟命令非零退出: {st}"));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return baseline("冒烟命令超时（2s）".into());
            }
            Err(e) => return baseline(format!("冒烟 wait 失败: {e}")),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// Seatbelt profile（D13-B10 语义；subpath 匹配需要**规范路径**——macOS 上
/// /var、/tmp 均为符号链接，传入前须 realpath 成 /private/… 前缀）。
/// 规则顺序 = SBPL 后匹配优先：deny file-write* 之后的 allow 覆盖白名单子树。
fn build_seatbelt_profile(writable_roots: &[PathBuf], allow_network: bool) -> String {
    let mut sb = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
    for root in writable_roots {
        let p = fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        sb.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            escape_sbpl(&p.to_string_lossy())
        ));
    }
    // /dev/null 是命令通用出口（2>/dev/null 等），单独放行
    sb.push_str("(allow file-write* (literal \"/dev/null\"))\n");
    if !allow_network {
        sb.push_str("(deny network*)\n");
    }
    sb
}

/// SBPL 字符串字面量转义（反斜杠与双引号）
fn escape_sbpl(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 组装唯一临时目录（$TMPDIR/bbc-sec-run-<pid>-<nanos>）
fn unique_temp_dir() -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "bbc-sec-run-{}-{}-{seq}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
}

/// 临时目录守卫：离开作用域清理（keep=true 或外部指定目录不清理）
struct TempDirGuard {
    path: PathBuf,
    keep: bool,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if !self.keep {
            fs::remove_dir_all(&self.path).ok();
        }
    }
}

/// kill(-pgid, sig)：杀整组
fn kill_group(pgid: i32, sig: i32) {
    // SAFETY: kill(2) 对负 pid 语义为进程组；返回值无需处理（ESRCH=已死）
    unsafe {
        kill(-pgid, sig);
    }
}

/// 宽限期内轮询主进程是否退出（true=已退出）
fn wait_grace(child: &mut std::process::Child, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

/// 查询进程组总 RSS（ps -axo pgid=,rss=；单位 KB→B）。失败返回 None（尽力监控）；
/// 个别行解析异常跳过（ps 表头/僵尸行），不影响本轮求和
fn group_rss_bytes(pgid: i32) -> Option<u64> {
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
        if g == pgid {
            total += rss_kb * 1024;
        }
    }
    Some(total)
}

/// 从 ExitStatus 提取 (code, signal)（unix）
fn exit_and_signal(st: &std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    use std::os::unix::process::ExitStatusExt;
    if let Some(sig) = st.signal() {
        (None, Some(sig))
    } else {
        (st.code(), None)
    }
}

/// 读捕获文件：≤1MB 原样；超限取头 512KB + 尾 512KB + 截断标注。
/// 返回 (内容, 是否截断, 总字节数)
fn read_captured(path: &Path) -> (String, bool, u64) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (String::new(), false, 0),
    };
    let total = meta.len();
    if total <= OUTPUT_LIMIT {
        let bytes = fs::read(path).unwrap_or_default();
        return (String::from_utf8_lossy(&bytes).into_owned(), false, total);
    }
    let half = (OUTPUT_LIMIT / 2) as usize;
    use std::io::{Read, Seek, SeekFrom};
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (format!("[truncated, total={total} bytes]"), true, total),
    };
    let mut head = vec![0u8; half];
    let _ = f.read_exact(&mut head);
    let _ = f.seek(SeekFrom::End(-(half as i64)));
    let mut tail = vec![0u8; half];
    let _ = f.read_exact(&mut tail);
    let marker = format!("\n…[truncated, total={total} bytes]…\n");
    let mut out = String::with_capacity(half * 2 + marker.len());
    out.push_str(&String::from_utf8_lossy(&head));
    out.push_str(&marker);
    out.push_str(&String::from_utf8_lossy(&tail));
    (out, true, total)
}

/// 记录 violation（有 sink 才记）
fn record(opts: &RunOpts, v: Violation) {
    if let Some(sink) = &opts.sink {
        sink.append(v);
    }
}

// ---------------------------------------------------------------------------
// 输入/输出结构
// ---------------------------------------------------------------------------

/// 待执行命令（program+args 形态；shell 命令由调用方转 /bin/zsh -c）
#[derive(Debug, Clone, Default)]
pub struct RunSpec {
    /// 程序（建议绝对路径：Seatbelt 内 PATH 解析受 profile 约束）
    pub program: String,
    /// 参数
    pub args: Vec<String>,
    /// 工作目录（必须已在可写白名单内，否则命令自身写 cwd 会失败）
    pub cwd: Option<PathBuf>,
    /// 附加环境变量（PATH/HOME/LANG 等白名单变量由调用方裁剪后传入）
    pub env: Vec<(String, String)>,
}

/// 执行选项
#[derive(Clone)]
pub struct RunOpts {
    /// 墙钟超时秒数（1–600，默认 300）
    pub timeout_secs: u64,
    /// 资源限制（rlimit + RSS 看门狗）
    pub limits: ResourceLimits,
    /// 强制等级（None=按 launcher 探测结果；测试用 Some(Baseline) 对照）
    pub force_level: Option<SandboxLevel>,
    /// 可写根（工作区；临时目录自动并入）
    pub writable_roots: Vec<PathBuf>,
    /// 外部指定临时目录（指定则不自动清理）
    pub temp_dir: Option<PathBuf>,
    /// 联网例外（B10：白名单命令需要网络时 profile 省略 deny network*）
    pub allow_network: bool,
    /// violation 出口
    pub sink: Option<Arc<dyn ViolationSink>>,
    /// 保留临时目录（调试/测试检查中间产物）
    pub keep_temp: bool,
}

impl Default for RunOpts {
    fn default() -> Self {
        Self {
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            limits: ResourceLimits::default(),
            force_level: None,
            writable_roots: Vec::new(),
            temp_dir: None,
            allow_network: false,
            sink: None,
            keep_temp: false,
        }
    }
}

/// 执行结果（09 §4.3 [8]：exit_code/时长/是否截断回填 + 沙箱档位）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitResult {
    /// 退出码（信号死亡时为 None）
    pub exit_code: Option<i32>,
    /// 致死信号（正常退出为 None）
    pub signal: Option<i32>,
    /// 是否成功（exit_code==0）
    pub ok: bool,
    /// 执行时长（毫秒）
    pub duration_ms: u128,
    /// stdout（截断后）
    pub stdout: String,
    /// stderr（截断后）
    pub stderr: String,
    /// 是否发生截断（stdout 或 stderr 任一）
    pub truncated: bool,
    /// 原始输出总字节（截断前；审计 result_digest 用）
    pub total_output_bytes: u64,
    /// 是否因超时被杀（8023）
    pub timeout_killed: bool,
    /// 是否因资源超限被杀/推断为资源死亡（8022）
    pub resource_killed: bool,
    /// 实际使用的沙箱等级（baseline 时 UI 打"基础门控"徽标）
    pub sandbox_level: SandboxLevel,
    /// 进程组 id（残留进程排查）
    pub pgid: i32,
    /// 本次执行临时目录（keep_temp 时保留可查）
    pub temp_dir: PathBuf,
}

impl ExitResult {
    /// spawn 前置失败的快捷结果
    fn spawn_fail(temp_dir: &Path, level: SandboxLevel, detail: &str) -> Self {
        Self {
            exit_code: None,
            signal: None,
            ok: false,
            duration_ms: 0,
            stdout: String::new(),
            stderr: detail.to_string(),
            truncated: false,
            total_output_bytes: 0,
            timeout_killed: false,
            resource_killed: false,
            sandbox_level: level,
            pgid: 0,
            temp_dir: temp_dir.to_path_buf(),
        }
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时目录守卫（panic 也保证清理）
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bbc-sec-launcher-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &PathBuf {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn timeout_clamped_to_design_range() {
        assert_eq!(clamp_timeout(0), 1);
        assert_eq!(clamp_timeout(300), 300);
        assert_eq!(clamp_timeout(60_000), 600);
    }

    #[test]
    fn seatbelt_profile_contains_roots_deny_network_and_devnull() {
        let p = build_seatbelt_profile(&[PathBuf::from("/private/tmp/ws")], false);
        assert!(p.starts_with("(version 1)"));
        assert!(p.contains("(deny file-write*)"));
        assert!(p.contains("(allow file-write* (subpath \"/private/tmp/ws\"))"));
        assert!(p.contains("(allow file-write* (literal \"/dev/null\"))"));
        assert!(p.contains("(deny network*)"));
        // 联网例外：无 deny network*
        let p2 = build_seatbelt_profile(&[PathBuf::from("/ws")], true);
        assert!(!p2.contains("(deny network*)"));
    }

    #[test]
    fn sbpl_escaping() {
        assert_eq!(escape_sbpl(r#"/a"b\c"#), r#"/a\"b\\c"#);
    }

    #[test]
    fn detect_returns_valid_probe() {
        let probe = detect();
        if Path::new(SANDBOX_EXEC).exists() {
            // 本机存在 sandbox-exec 时冒烟应通过（CI 其他机器可能降级）
            assert_eq!(probe.level, SandboxLevel::Seatbelt);
            assert!(probe.degraded.is_none());
        } else {
            assert_eq!(probe.level, SandboxLevel::Baseline);
            let d = probe.degraded.unwrap();
            assert_eq!(d.mode_cap, "auto-edit");
            assert!(d.network_denied && d.per_confirm);
        }
    }

    #[test]
    fn memory_and_jsonl_violation_sinks() {
        let mem = MemoryViolationSink::new();
        mem.append(Violation::now(ViolationKind::Path, 8020, "x"));
        mem.append(Violation::now(ViolationKind::DangerCmd, 8021, "y"));
        assert!(mem.has_code(8020) && mem.has_code(8021));
        assert_eq!(mem.snapshot().len(), 2);
        mem.clear();
        assert!(mem.snapshot().is_empty());

        let dir = TempDir::new("sink");
        let path = dir.path().join("violations.jsonl");
        let jsonl = JsonlViolationSink::open(&path).unwrap();
        jsonl.append(Violation {
            kind: ViolationKind::Network,
            code: 8025,
            detail: "8.8.8.8".into(),
            ts_ms: 42,
        });
        drop(jsonl);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("\"code\":8025"));
        assert!(content.contains("\"kind\":\"network\""));
        assert!(content.contains("\"tsMs\":42"));
    }

    #[test]
    fn read_captured_truncates_head_tail_with_marker() {
        let dir = TempDir::new("cap");
        let f = dir.path().join("big.bin");
        // 头 1MB 填 'H'，中间 'M'，尾 1MB 填 'T'（总 3MB > 1MB 上限）
        let mut buf: Vec<u8> = vec![b'H'; 1024 * 1024];
        buf.extend_from_slice(&vec![b'M'; 1024 * 1024]);
        buf.extend_from_slice(&vec![b'T'; 1024 * 1024]);
        fs::write(&f, &buf).unwrap();

        let (out, truncated, total) = read_captured(&f);
        assert!(truncated);
        assert_eq!(total, 3 * 1024 * 1024);
        assert!(out.contains("[truncated, total=3145728 bytes]"));
        // 头尾各 50%：开头是 H 区、结尾是 T 区
        assert!(out.starts_with('H'));
        assert!(out.ends_with('T'));
        // 结果长度 ≈ 512KB + marker + 512KB
        assert!(out.len() > 1024 * 1024 && out.len() < 1200 * 1024);

        // 小文件原样
        let small = dir.path().join("small.bin");
        fs::write(&small, b"hello").unwrap();
        let (out2, truncated2, total2) = read_captured(&small);
        assert_eq!((out2.as_str(), truncated2, total2), ("hello", false, 5));
    }

    #[test]
    fn run_echo_under_seatbelt_or_baseline() {
        let launcher = SandboxLauncher::new();
        let ws = TempDir::new("echo");
        let spec = RunSpec {
            program: "/bin/echo".into(),
            args: vec!["hello-sec".into()],
            ..RunSpec::default()
        };
        let opts = RunOpts {
            timeout_secs: 10,
            writable_roots: vec![ws.path().clone()],
            ..RunOpts::default()
        };
        let r = launcher.run(&spec, &opts);
        assert!(r.ok, "stdout={:?} stderr={:?}", r.stdout, r.stderr);
        assert_eq!(r.stdout.trim(), "hello-sec");
        assert!(!r.truncated);
        assert_eq!(r.sandbox_level, launcher.level());
    }
}
