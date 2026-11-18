//! `CodingBackend` trait（D11 §8.1 方法表）+ `BackendRegistry` + 委派会话句柄。
//!
//! §8.1 方法表（权威，同步 API）：
//!
//! | 方法 | 入参 | 出参/行为 |
//! |---|---|---|
//! | detect() | — | BackendProbe{installed, path, version, capabilities} |
//! | probe_health() | — | ok / 降级原因（版本不符 8031 / 未登录 / 冒烟失败） |
//! | launch(task_brief, opts{mode, workspace, env_allow}) | 简报+权限映射 | 子进程（新进程组）+ 会话句柄 |
//! | stream_events() | — | 归一化事件（§8.3；本实现为逐事件拉取式） |
//! | send_input(text) | 追加指令 | —（17 模式 C 续接基础） |
//! | cancel(graceful) | bool | §8.4 取消协议 |
//! | finalize() | — | {summary, changed_files, session_ref}（续接句柄） |
//!
//! 会话模型：launch 产出 [`DelegateSession`]（内部持有受管子进程 + 行解析器），
//! trait 方法以 `&DelegateSession` 操作（内部可变），使"流式读取线程 + 取消线程"
//! 可并发（§8.4 的使用形态）。stream_events 语义：**逐事件拉取**——每次调用
//! 返回下一条归一化事件；子进程退出并收割后返回 [`NormalizedEvent::Exit`]，
//! 之后返回 None（流终止；Exit 由上层转 delegate.end）。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bbrt_protocol::{PermissionMode, TaskBrief};
use serde::{Deserialize, Serialize};

use crate::normalize::{LineParser, NormalizedEvent, MAX_LINE_BYTES};
use crate::procmgr::{CancelOutcome, ChildProcess, ExitRecord};
use crate::{
    CODE_BACKEND_MISSING, CODE_CHILD_ABNORMAL_EXIT, CODE_DELEGATE_TIMEOUT, CODE_WORKSPACE_BUSY,
};

/// finalize 汇总上限（summary 字符数；17 §7 result_summary 轻量口径）
const SUMMARY_MAX_CHARS: usize = 2000;

/// 原始输出尾部行数留存（finalize 诊断/summary 兜底）
const RAW_TAIL_LINES: usize = 32;

/// 会话内累积的 assistant 文本上限（防内存放大）
const SUMMARY_BUF_MAX_CHARS: usize = 64 * 1024;

/// stderr 聚合转发最小间隔（防刷屏：API 重试风暴/进度条类输出每行都转事件会淹卡片）
const STDERR_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// stderr 缓冲行数上限（环形丢弃最旧）
const STDERR_BUF_LINES: usize = 16;

/// 单次 stderr Warning 事件聚合的行数上限
const STDERR_EVT_LINES: usize = 4;

/// 单行 stderr 截断字符数
const STDERR_LINE_MAX_CHARS: usize = 400;

// ---------------------------------------------------------------------------
// 探测/健康/启动/收尾结构
// ---------------------------------------------------------------------------

/// 后端探测结果（17 §3.1 detect()：installed/path/version/capabilities）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendProbe {
    /// 后端 id（claude/zcode/generic/builtin/自定义）
    pub backend_id: String,
    /// 是否已安装且可执行
    pub installed: bool,
    /// 解析到的可执行路径（未安装为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 版本（--version 提取）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 能力标签（如 "stream-json"/"resume"/"line-protocol"）
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// 健康降级原因（probe_health；ok=false 时必有）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthIssue {
    /// 未安装（8030）
    NotInstalled,
    /// 版本低于矩阵最低要求（8031）
    VersionTooLow {
        found: Option<String>,
        required: String,
    },
    /// 未登录（各 CLI 凭据检测；v0.1 占位未实现，登记）
    NotLoggedIn(String),
    /// 最小 headless 冒烟失败
    SmokeFailed(String),
}

/// 健康检查报告（17 §3.1 probe_health：ok / 降级原因）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthReport {
    pub ok: bool,
    pub degraded: Option<HealthIssue>,
}

impl HealthReport {
    /// 健康
    pub fn healthy() -> Self {
        Self {
            ok: true,
            degraded: None,
        }
    }

    /// 降级（附原因）
    pub fn degraded(issue: HealthIssue) -> Self {
        Self {
            ok: false,
            degraded: Some(issue),
        }
    }
}

/// 启动选项（D11 §8.1 launch 入参：简报+工作区+权限映射+env_allow）
#[derive(Debug, Clone)]
pub struct LaunchOpts {
    /// 委派任务 ID（delegate_task 表主键；审计/事件路由）
    pub delegate_task_id: String,
    /// 父编排会话 ID（17 §5.3 审计字段）
    pub parent_session_id: String,
    /// 权限模式（§8.2 映射为各后端启动参数）
    pub mode: PermissionMode,
    /// 工作区（子进程 cwd；17 §5.1 委派边界）
    pub workspace: PathBuf,
    /// 附加环境变量白名单透传
    pub env_allow: Vec<(String, String)>,
    /// 续接句柄（模式 C：claude `--resume <session>` 等价）
    pub resume: Option<String>,
}

impl LaunchOpts {
    /// 最小构造（env_allow/resume 缺省空）
    pub fn new(
        delegate_task_id: impl Into<String>,
        parent_session_id: impl Into<String>,
        mode: PermissionMode,
        workspace: impl Into<PathBuf>,
    ) -> Self {
        Self {
            delegate_task_id: delegate_task_id.into(),
            parent_session_id: parent_session_id.into(),
            mode,
            workspace: workspace.into(),
            env_allow: Vec::new(),
            resume: None,
        }
    }
}

/// 收尾报告（D11 §8.1 finalize：summary/changed_files/session_ref）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalReport {
    /// 结果摘要（累积 assistant 文本截断）
    pub summary: String,
    /// 改动文件清单（从 Edit/Write 类 tool_use 提取；diff 审查卡数据源之一）
    pub changed_files: Vec<String>,
    /// 续接句柄（模式 C `--resume` 数据源）
    pub session_ref: Option<String>,
    /// 退出记录（异常退出→上层映射 8033）
    pub exit: ExitRecord,
}

// ---------------------------------------------------------------------------
// 错误（8030-8035 语义集中；8032 策略禁用由上层判定不在此列）
// ---------------------------------------------------------------------------

/// 委派错误（错误码语义见 [`crate`] 根常量；8030/8031/8033/8034/8035 由本枚举承载）
#[derive(Debug, thiserror::Error)]
pub enum DelegateError {
    /// 8030 后端未安装或路径无效
    #[error("后端未安装或路径无效（8030）: {0}")]
    BackendUnavailable(String),
    /// 8031 后端版本不满足最低要求
    #[error("后端版本不满足最低要求（8031）: 找到 {found:?}，要求 {required}")]
    VersionTooLow {
        found: Option<String>,
        required: String,
    },
    /// 权限模式不被后端映射表支持（§8.2：子智能体自主性不得超过用户授权档位）
    #[error("后端 {backend} 不支持权限模式 {mode}（映射表拒绝）")]
    ModeUnsupported { backend: String, mode: String },
    /// 8033 子进程异常退出
    #[error("子进程异常退出（8033）: {0}")]
    ChildAbnormal(String),
    /// 8034 委派超时已终止
    #[error("委派超时已终止（8034）: {0}")]
    Timeout(String),
    /// 8035 工作区被其他委派任务占用
    #[error("工作区被其他委派任务占用（8035）: {0}")]
    WorkspaceBusy(String),
    /// v0.1 未实现（登记：builtin 后端真实循环在编排层进程内）
    #[error("未实现（v0.1 登记）: {0}")]
    NotImplemented(String),
    /// 子进程 IO 错误
    #[error("子进程 IO 错误: {0}")]
    Io(#[from] std::io::Error),
    /// 事件行协议解析失败（超长行等）
    #[error("事件行解析失败: {0}")]
    Parse(String),
    /// 会话状态错误（未启动即操作/未退出即 finalize 等）
    #[error("委派会话状态错误: {0}")]
    InvalidState(String),
}

impl DelegateError {
    /// 协议错误码（可映射 8xxx 的变体）
    pub fn error_code(&self) -> Option<u32> {
        match self {
            DelegateError::BackendUnavailable(_) => Some(CODE_BACKEND_MISSING),
            DelegateError::VersionTooLow { .. } => Some(crate::CODE_BACKEND_VERSION_LOW),
            DelegateError::ChildAbnormal(_) => Some(CODE_CHILD_ABNORMAL_EXIT),
            DelegateError::Timeout(_) => Some(CODE_DELEGATE_TIMEOUT),
            DelegateError::WorkspaceBusy(_) => Some(CODE_WORKSPACE_BUSY),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// 委派会话（launch 产物；内部可变以支持读流/取消并发）
// ---------------------------------------------------------------------------

/// 读线程转发消息（stdout/stderr 行；读线程独占管道读端，
/// 消费侧在 SessionInner 锁外 recv——2026-11-18 修复：此前 next_event
/// 持锁阻塞 read_line，子进程静默期 cancel/finalize 的锁获取被卡死）
enum LineMsg {
    Line(String),
    /// 管道 EOF（读线程终止前最后一条）
    Eof,
    /// 行级错误（超长行跳过继续读；IO 错误读线程随后终止）
    Fail(String),
}

/// stdout/stderr 行转发线程：独占读端逐行投递（EOF/错误也走通道）
fn spawn_line_reader<R: std::io::Read + Send + 'static>(out: R) -> Receiver<LineMsg> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("bbc-delegate-reader".into())
        .spawn(move || {
            let mut reader = BufReader::new(out);
            let mut buf = String::new();
            loop {
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) => {
                        let _ = tx.send(LineMsg::Eof);
                        break;
                    }
                    Ok(_) => {
                        let line = buf.trim_end_matches(['\r', '\n']).to_string();
                        if line.len() > MAX_LINE_BYTES {
                            // 超长行：报错后跳过继续读（原语义 Err 上抛、流继续）
                            let _ = tx.send(LineMsg::Fail(format!(
                                "事件行超长（{} 字节 > 上限 {}）",
                                line.len(),
                                MAX_LINE_BYTES
                            )));
                            continue;
                        }
                        if tx.send(LineMsg::Line(line)).is_err() {
                            break; // 消费侧已放弃
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(LineMsg::Fail(e.to_string()));
                        let _ = tx.send(LineMsg::Eof);
                        break;
                    }
                }
            }
        })
        .expect("委派读线程启动失败");
    rx
}

/// 带超时拉取的结果（pump 轮询用：Idle=超时无行，可回旋处理宿主指令/心跳）
#[derive(Debug, Clone, PartialEq)]
pub enum EventWait {
    Ready(NormalizedEvent),
    Idle,
    Ended,
}

/// 会话内部状态（Mutex 保护；**不含**行通道——等待必须在锁外进行）
struct SessionInner {
    parser: Box<dyn LineParser>,
    /// 一行多事件时的待吐队列（如 claude assistant 消息含 text+tool_use 多块）
    pending: VecDeque<NormalizedEvent>,
    /// Exit 事件是否已产出（产出后流终止）
    exit_emitted: bool,
    /// 收割后的退出记录
    exited: Option<ExitRecord>,
    /// 累积 assistant 文本（finalize summary 源）
    summary_text: String,
    /// 改动文件（Edit/Write 类 tool_use 提取）
    changed_files: Vec<String>,
    /// 续接句柄（meta 事件携带）
    session_ref: Option<String>,
    /// 原始输出尾部（诊断）
    raw_tail: VecDeque<String>,
    /// stderr 行缓冲（读线程投递；限频聚合为 Warning 事件外发）
    stderr_buf: VecDeque<String>,
    /// 上次 stderr Warning 外发时刻（限频基准）
    last_stderr_evt: Option<Instant>,
}

/// 委派会话句柄：持有受管子进程与行解析器；线程安全（Send+Sync）。
/// 生命周期：launch →（stream_events/send_input/cancel）* → 退出 → finalize。
pub struct DelegateSession {
    backend_id: String,
    delegate_task_id: String,
    started_at: Instant,
    proc: ChildProcess,
    inner: Mutex<SessionInner>,
    /// stdout 行通道（读线程 → 消费侧；独立于 inner 锁）
    lines: Mutex<Receiver<LineMsg>>,
    /// stderr 行通道（None=无 stderr 管道）
    err_lines: Mutex<Option<Receiver<LineMsg>>>,
}

impl DelegateSession {
    /// 组装（适配器 launch 内部调用；stdout/stderr 来自 [`crate::procmgr::spawn`])
    pub(crate) fn new(
        backend_id: impl Into<String>,
        delegate_task_id: impl Into<String>,
        proc: ChildProcess,
        stdout: ChildStdout,
        stderr: Option<ChildStderr>,
        parser: Box<dyn LineParser>,
    ) -> Self {
        let err_lines = stderr.map(spawn_line_reader);
        Self {
            backend_id: backend_id.into(),
            delegate_task_id: delegate_task_id.into(),
            started_at: Instant::now(),
            proc,
            inner: Mutex::new(SessionInner {
                parser,
                pending: VecDeque::new(),
                exit_emitted: false,
                exited: None,
                summary_text: String::new(),
                changed_files: Vec::new(),
                session_ref: None,
                raw_tail: VecDeque::new(),
                stderr_buf: VecDeque::new(),
                last_stderr_evt: None,
            }),
            lines: Mutex::new(spawn_line_reader(stdout)),
            err_lines: Mutex::new(err_lines),
        }
    }

    /// 后端 id
    pub fn backend_id(&self) -> &str {
        &self.backend_id
    }

    /// 委派任务 id
    pub fn delegate_task_id(&self) -> &str {
        &self.delegate_task_id
    }

    /// 进程组 id（§8.4；排查用）
    pub fn pgid(&self) -> i32 {
        self.proc.pgid
    }

    /// 已运行毫秒
    pub fn elapsed_ms(&self) -> u128 {
        self.started_at.elapsed().as_millis()
    }

    /// 退出记录（尚未收割为 None）
    pub fn exit_record(&self) -> Option<ExitRecord> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).exited
    }

    /// 原始输出尾部快照（诊断）
    pub fn raw_tail(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .raw_tail
            .iter()
            .cloned()
            .collect()
    }

    /// 拉取下一条归一化事件（阻塞直至一行可用/EOF）。
    /// 返回 Ok(None) = 流已终止（Exit 已产出）。EOF 时收割子进程并产出 Exit 事件。
    pub fn next_event(&self) -> Result<Option<NormalizedEvent>, DelegateError> {
        match self.next_event_wait(None)? {
            EventWait::Ready(ev) => Ok(Some(ev)),
            EventWait::Idle => Ok(None), // 阻塞模式不会 Idle（防御语义：视同终止）
            EventWait::Ended => Ok(None),
        }
    }

    /// 带超时拉取下一条归一化事件（timeout=None 为阻塞语义）。
    /// 关键路径：stdout 行等待在 SessionInner 锁外进行——子进程静默期
    /// cancel()/finalize() 的锁获取不再被阻塞的 read_line 卡死；
    /// 超时返回 Idle 供调用方回旋（drain 宿主指令/空闲心跳）。
    pub fn next_event_wait(
        &self,
        timeout: Option<Duration>,
    ) -> Result<EventWait, DelegateError> {
        loop {
            // 1) stderr 聚合 + pending 出队（短临界区）
            {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                Self::drain_stderr(&self.err_lines, &mut inner);
                Self::flush_stderr_warning(&mut inner);
                if inner.exit_emitted && inner.pending.is_empty() {
                    return Ok(EventWait::Ended);
                }
                if let Some(ev) = inner.pending.pop_front() {
                    Self::note_side_effects(&mut inner, &ev);
                    return Ok(EventWait::Ready(ev));
                }
            }
            // 2) 锁外等 stdout 行
            let msg = {
                let rx = self.lines.lock().unwrap_or_else(|p| p.into_inner());
                match timeout {
                    Some(t) => match rx.recv_timeout(t) {
                        Ok(m) => Some(m),
                        Err(mpsc::RecvTimeoutError::Timeout) => return Ok(EventWait::Idle),
                        // 读线程已终止且通道排空：视同 EOF（幂等，见下）
                        Err(mpsc::RecvTimeoutError::Disconnected) => Some(LineMsg::Eof),
                    },
                    None => match rx.recv() {
                        Ok(m) => Some(m),
                        Err(_) => Some(LineMsg::Eof),
                    },
                }
            };
            match msg {
                Some(LineMsg::Line(line)) => {
                    let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                    if inner.raw_tail.len() >= RAW_TAIL_LINES {
                        inner.raw_tail.pop_front();
                    }
                    inner.raw_tail.push_back(line.clone());
                    let events = inner.parser.parse_line(&line);
                    inner.pending.extend(events);
                }
                Some(LineMsg::Fail(text)) => return Err(DelegateError::Parse(text)),
                Some(LineMsg::Eof) => {
                    // EOF：收割（孙进程持管道场景由 reap_after_eof 兜底强杀）。
                    // 幂等：Disconnected 也映射到 Eof，已收割时 exited 已置位直接跳过
                    let already = {
                        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                        inner.exit_emitted
                    };
                    if !already {
                        let rec = self.proc.reap_after_eof()?;
                        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                        // 末班 stderr 尽力排空（读线程可能仍在投递）
                        Self::drain_stderr(&self.err_lines, &mut inner);
                        inner.exited = Some(rec);
                        inner.exit_emitted = true;
                        inner.pending.push_back(NormalizedEvent::Exit {
                            exit_code: rec.exit_code,
                            signal: rec.signal,
                        });
                    }
                }
                None => unreachable!("msg 构造必为 Some"),
            }
        }
    }

    /// stderr 通道非阻塞排空 → 缓冲（环形丢弃最旧；单行截断）
    fn drain_stderr(err_lines: &Mutex<Option<Receiver<LineMsg>>>, inner: &mut SessionInner) {
        let mut guard = err_lines.lock().unwrap_or_else(|p| p.into_inner());
        let Some(rx) = guard.as_mut() else { return };
        while let Ok(m) = rx.try_recv() {
            let line = match m {
                LineMsg::Line(l) => l,
                LineMsg::Fail(e) => format!("[stderr 读失败] {e}"),
                LineMsg::Eof => {
                    *guard = None;
                    break;
                }
            };
            let line = truncate_chars(&line, STDERR_LINE_MAX_CHARS);
            inner.stderr_buf.push_back(line);
            if inner.stderr_buf.len() > STDERR_BUF_LINES {
                inner.stderr_buf.pop_front();
            }
        }
    }

    /// stderr 缓冲限频聚合为 Warning 事件（≥[`STDERR_MIN_INTERVAL`] 一次，至多
    /// [`STDERR_EVT_LINES`] 行；未到期的行留待下轮）
    fn flush_stderr_warning(inner: &mut SessionInner) {
        if inner.stderr_buf.is_empty() {
            return;
        }
        let due = inner
            .last_stderr_evt
            .map_or(true, |t| t.elapsed() >= STDERR_MIN_INTERVAL);
        if !due {
            return;
        }
        let take = inner.stderr_buf.len().min(STDERR_EVT_LINES);
        let joined = inner
            .stderr_buf
            .drain(..take)
            .collect::<Vec<_>>()
            .join("\n");
        inner.last_stderr_evt = Some(Instant::now());
        inner
            .pending
            .push_back(NormalizedEvent::Warning { text: format!("[stderr] {joined}") });
    }

    /// 事件副作用入账：summary 累积 / session_ref 捕获 / changed_files 提取
    fn note_side_effects(inner: &mut SessionInner, ev: &NormalizedEvent) {
        match ev {
            NormalizedEvent::Delta { text, .. } => {
                if inner.summary_text.len() < SUMMARY_BUF_MAX_CHARS {
                    inner.summary_text.push_str(text);
                }
            }
            NormalizedEvent::Meta {
                session_ref: Some(r),
                ..
            } => {
                inner.session_ref = Some(r.clone());
            }
            NormalizedEvent::ToolUse { tool, args, .. } => {
                // §8.3 审批联动的数据源之一：Edit/Write 类工具的目标文件
                let t = tool.to_ascii_lowercase();
                let editish = matches!(
                    t.as_str(),
                    "edit"
                        | "write"
                        | "write_file"
                        | "multiedit"
                        | "notebookedit"
                        | "applypatch"
                        | "apply_patch"
                );
                if editish {
                    let target = args
                        .get("file_path")
                        .or_else(|| args.get("path"))
                        .or_else(|| args.get("notebook_path"))
                        .and_then(|v| v.as_str());
                    if let Some(p) = target {
                        if !inner.changed_files.iter().any(|c| c == p) {
                            inner.changed_files.push(p.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// 追加输入（模式 C 续接基础；写入子进程 stdin 一行）
    pub fn send_input(&self, text: &str) -> Result<(), DelegateError> {
        self.proc.write_line(text).map_err(DelegateError::Io)
    }

    /// 取消（§8.4 委托 procmgr）；收割结果回填会话（finalize 可立即进行）
    pub fn cancel(&self, graceful: bool) -> Result<CancelOutcome, DelegateError> {
        let outcome = self.proc.cancel(graceful).map_err(DelegateError::Io)?;
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.exited.is_none() {
            inner.exited = Some(outcome.record);
        }
        Ok(outcome)
    }

    /// 收尾（D11 §8.1 finalize：summary/changed_files/session_ref）。
    /// 要求子进程已退出（流读完或已取消），否则 InvalidState。
    pub fn finalize(&self) -> Result<FinalReport, DelegateError> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // 兜底：cancel 已收割但 next_event 尚未跑 EOF 分支时，从 proc 侧取退出记录
        // （wait 后 try_wait 返回缓存状态；锁方向 inner→child 单向，无死锁）
        if inner.exited.is_none() {
            if let Ok(Some(st)) = self.proc.try_wait() {
                inner.exited = Some(ExitRecord::from_status(&st));
            }
        }
        let Some(exit) = inner.exited else {
            return Err(DelegateError::InvalidState(
                "子进程尚未退出：先消费完 stream_events 或 cancel 后再 finalize".into(),
            ));
        };
        let summary = truncate_chars(&inner.summary_text, SUMMARY_MAX_CHARS);
        Ok(FinalReport {
            summary,
            changed_files: inner.changed_files.clone(),
            session_ref: inner.session_ref.clone(),
            exit,
        })
    }
}

/// 按字符数截断（utf-8 边界安全：char 索引收集）
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

// ---------------------------------------------------------------------------
// CodingBackend trait（D11 §8.1）
// ---------------------------------------------------------------------------

/// 编码后端统一接口（17 §3.1；编排层只依赖此抽象）。
/// 同步 API；实现需 Send+Sync（registry 存储/多线程探测）。
pub trait CodingBackend: Send + Sync {
    /// 后端标识（registry 键；"claude"/"zcode"/"generic"/"builtin" 或自定义）
    fn id(&self) -> &'static str;

    /// 探测安装与能力（--version）
    fn detect(&self) -> BackendProbe;

    /// 会话前健康检查（版本/登录态/冒烟；降级原因含 8031 语义）
    fn probe_health(&self) -> HealthReport;

    /// 权限模式 → 启动参数映射声明（§8.2：启动前由编排层校验；
    /// 不支持的模式返回 Err——如 generic 对 ask 的拒绝）
    fn mode_args(&self, mode: PermissionMode) -> Result<Vec<String>, DelegateError>;

    /// headless 启动：新进程组子进程 + 会话句柄（17 §3.2 各后端启动形态）
    fn launch(
        &self,
        brief: &TaskBrief,
        opts: &LaunchOpts,
    ) -> Result<DelegateSession, DelegateError>;

    /// 拉取下一条归一化事件（None = 流终止；Exit 之后终止）
    fn stream_events(
        &self,
        session: &DelegateSession,
    ) -> Result<Option<NormalizedEvent>, DelegateError>;

    /// 追加指令（子进程 stdin）
    fn send_input(&self, session: &DelegateSession, text: &str) -> Result<(), DelegateError>;

    /// 取消（§8.4：SIGINT→3s→SIGKILL 进程树 / 直接强杀）
    fn cancel(
        &self,
        session: &DelegateSession,
        graceful: bool,
    ) -> Result<CancelOutcome, DelegateError>;

    /// 收尾：summary/changed_files/session_ref（异常退出时上层映射 8033）
    fn finalize(&self, session: &DelegateSession) -> Result<FinalReport, DelegateError>;
}

// ---------------------------------------------------------------------------
// BackendRegistry（注册/按 id 查询/detect_all 并行探测）
// ---------------------------------------------------------------------------

/// 后端注册表：编排层按用户指定/项目配置/默认策略选择后端的查询面（17 §4）
#[derive(Default)]
pub struct BackendRegistry {
    backends: Vec<Arc<dyn CodingBackend>>,
}

impl BackendRegistry {
    /// 空注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册（id 重复返回既有 id 报错）
    pub fn register(&mut self, backend: Arc<dyn CodingBackend>) -> Result<(), DelegateError> {
        let id = backend.id();
        if self.backends.iter().any(|b| b.id() == id) {
            return Err(DelegateError::InvalidState(format!(
                "后端 {id} 已注册（重复注册拒绝）"
            )));
        }
        self.backends.push(backend);
        Ok(())
    }

    /// 注册的后端数量
    pub fn len(&self) -> usize {
        self.backends.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.backends.is_empty()
    }

    /// 全部后端 id
    pub fn ids(&self) -> Vec<&'static str> {
        self.backends.iter().map(|b| b.id()).collect()
    }

    /// 按 id 查询
    pub fn get(&self, id: &str) -> Option<Arc<dyn CodingBackend>> {
        self.backends.iter().find(|b| b.id() == id).cloned()
    }

    /// 并行探测全部后端（std::thread::scope；返回顺序与注册顺序一致）。
    /// 单个 detect 慢（如 --version 探测超时）不阻塞其他后端的注册时序。
    pub fn detect_all(&self) -> Vec<BackendProbe> {
        if self.backends.is_empty() {
            return Vec::new();
        }
        let slices: Vec<Arc<dyn CodingBackend>> = self.backends.clone();
        let results: Vec<BackendProbe> = std::thread::scope(|s| {
            let handles: Vec<_> = slices.iter().map(|b| s.spawn(move || b.detect())).collect();
            handles
                .into_iter()
                .map(|h| {
                    h.join().unwrap_or_else(|_| BackendProbe {
                        backend_id: "?".to_string(),
                        installed: false,
                        path: None,
                        version: None,
                        capabilities: Vec::new(),
                    })
                })
                .collect()
        });
        results
    }
}

/// 校验工作区存在（launch 前置；简报校验之外的环境检查）
pub(crate) fn ensure_workspace(workspace: &Path) -> Result<(), DelegateError> {
    if !workspace.is_dir() {
        return Err(DelegateError::BackendUnavailable(format!(
            "工作区目录不存在: {}",
            workspace.display()
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin::BuiltinBackend;
    use crate::generic::GenericCliBackend;
    use crate::testing;

    #[test]
    fn registry_register_lookup_and_duplicate_rejected() {
        let mut reg = BackendRegistry::new();
        assert!(reg.is_empty());
        reg.register(Arc::new(BuiltinBackend)).unwrap();
        let dir = testing::temp_dir("reg");
        let stub = testing::write_script(&dir, "v.sh", "#!/bin/sh\nexit 0\n");
        reg.register(Arc::new(GenericCliBackend::new(
            stub.to_string_lossy().into_owned(),
        )))
        .unwrap();
        assert_eq!(reg.len(), 2);
        assert_eq!(reg.ids(), vec!["builtin", "generic"]);

        assert!(reg.get("builtin").is_some());
        assert!(reg.get("generic").is_some());
        assert!(reg.get("nope").is_none());

        let err = reg.register(Arc::new(BuiltinBackend)).unwrap_err();
        assert!(err.to_string().contains("已注册"));
    }

    #[test]
    fn registry_detect_all_runs_in_parallel_and_keeps_order() {
        let mut reg = BackendRegistry::new();
        let dir = testing::temp_dir("detall");
        let stub = testing::write_script(
            &dir,
            "ver.sh",
            "#!/bin/sh\ncase \"$1\" in --version) echo 'stub-generic 1.4.2';; esac\nexit 0\n",
        );
        reg.register(Arc::new(BuiltinBackend)).unwrap();
        reg.register(Arc::new(GenericCliBackend::new(
            stub.to_string_lossy().into_owned(),
        )))
        .unwrap();
        let probes = reg.detect_all();
        assert_eq!(
            probes
                .iter()
                .map(|p| p.backend_id.as_str())
                .collect::<Vec<_>>(),
            vec!["builtin", "generic"]
        );
        assert!(probes[0].installed);
        assert_eq!(probes[1].version.as_deref(), Some("1.4.2"));
    }

    #[test]
    fn finalize_before_exit_is_invalid_state() {
        let dir = testing::temp_dir("fin");
        let stub = testing::write_script(&dir, "hang.sh", "#!/bin/sh\nsleep 60\n");
        let backend = GenericCliBackend::new(stub.to_string_lossy().into_owned());
        let ws = dir.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let brief = crate::testing::testing_brief(&ws);
        let opts = LaunchOpts::new("d-1", "s-1", PermissionMode::AutoEdit, &ws);
        let session = backend.launch(&brief, &opts).unwrap();
        let err = backend.finalize(&session).unwrap_err();
        assert!(matches!(err, DelegateError::InvalidState(_)));
        session.cancel(false).unwrap();
        // 取消后收割完成，可 finalize
        let report = backend.finalize(&session).unwrap();
        assert!(!report.exit.ok());
    }

    /// next_wait 三态：子进程静默期 Idle（超时返回）→ Ready（行事件）→
    /// Ready(Exit)（EOF 收割）→ Ended（流终止）
    #[test]
    fn next_wait_idle_then_events_then_ended() {
        let dir = testing::temp_dir("idlew");
        let stub = testing::write_script(&dir, "slow.sh", "#!/bin/sh\nsleep 1\necho hi\n");
        let backend = GenericCliBackend::new(stub.to_string_lossy().into_owned());
        let ws = dir.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let brief = crate::testing::testing_brief(&ws);
        let opts = LaunchOpts::new("d-1", "s-1", PermissionMode::AutoEdit, &ws);
        let session = backend.launch(&brief, &opts).unwrap();
        // 1s 静默期内 50ms 超时 → Idle（不阻塞不报错）
        assert!(matches!(
            session.next_event_wait(Some(Duration::from_millis(50))).unwrap(),
            EventWait::Idle
        ));
        // 阻塞取行 → Ready（generic 无前缀行 → 文本 Delta）
        match session.next_event_wait(None).unwrap() {
            EventWait::Ready(NormalizedEvent::Delta { text, .. }) => assert_eq!(text, "hi"),
            other => panic!("应为 Delta 事件: {other:?}"),
        }
        // EOF → Exit；再取 → Ended
        match session.next_event_wait(None).unwrap() {
            EventWait::Ready(NormalizedEvent::Exit { .. }) => {}
            other => panic!("应为 Exit 事件: {other:?}"),
        }
        assert!(matches!(session.next_event_wait(None).unwrap(), EventWait::Ended));
    }

    /// stderr 捕获：stderr 行聚合为 [stderr] Warning 事件（限频——短窗内多条只出一条）
    #[test]
    fn stderr_lines_become_rate_limited_warnings() {
        let dir = testing::temp_dir("stderr");
        let stub = testing::write_script(
            &dir,
            "noisy.sh",
            "#!/bin/sh\necho boom-1 1>&2\necho boom-2 1>&2\necho ok\n",
        );
        let backend = GenericCliBackend::new(stub.to_string_lossy().into_owned());
        let ws = dir.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let brief = crate::testing::testing_brief(&ws);
        let opts = LaunchOpts::new("d-2", "s-2", PermissionMode::AutoEdit, &ws);
        let session = backend.launch(&brief, &opts).unwrap();
        let mut stderr_warns = 0usize;
        let mut saw_ok_delta = false;
        loop {
            match session.next_event_wait(Some(Duration::from_secs(5))).unwrap() {
                EventWait::Ready(NormalizedEvent::Delta { text, .. }) => {
                    if text == "ok" {
                        saw_ok_delta = true;
                    }
                }
                EventWait::Ready(NormalizedEvent::Warning { text }) => {
                    if text.starts_with("[stderr]") {
                        assert!(text.contains("boom"), "{text}");
                        stderr_warns += 1;
                    }
                }
                EventWait::Ready(_) => {}
                EventWait::Idle => {}
                EventWait::Ended => break,
            }
        }
        assert!(saw_ok_delta, "stdout 行应照常产出 Delta");
        assert_eq!(stderr_warns, 1, "限频下多条 stderr 只聚合一条 Warning");
    }

    #[test]
    fn delegate_error_codes_map_to_8xxx() {
        assert_eq!(
            DelegateError::BackendUnavailable("x".into()).error_code(),
            Some(8030)
        );
        assert_eq!(
            DelegateError::VersionTooLow {
                found: None,
                required: "1.0.0".into()
            }
            .error_code(),
            Some(8031)
        );
        assert_eq!(
            DelegateError::ChildAbnormal("x".into()).error_code(),
            Some(8033)
        );
        assert_eq!(DelegateError::Timeout("x".into()).error_code(), Some(8034));
        assert_eq!(
            DelegateError::WorkspaceBusy("x".into()).error_code(),
            Some(8035)
        );
        assert_eq!(
            DelegateError::ModeUnsupported {
                backend: "g".into(),
                mode: "ask".into()
            }
            .error_code(),
            None
        );
    }

    #[test]
    fn truncate_chars_respects_char_boundary() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        let s = "中文四字".repeat(10); // 40 chars
        assert_eq!(truncate_chars(&s, 5).chars().count(), 5);
    }
}
