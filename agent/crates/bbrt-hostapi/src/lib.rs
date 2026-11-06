//! bbrt-hostapi：Runtime 与宿主（Tauri）之间的 stdio 传输 crate（D11 §2.9、§10）。
//!
//! 职责边界（不含业务逻辑）：
//! - 行式 JSONL 传输与 8MB 写缓冲背压（transport）；
//! - initialize 握手与 protocolVersion 协商（handshake）；
//! - OBO 令牌缓存与续签判定（obo）；
//! - ping→pong 心跳应答（20s 周期由宿主发起，本侧只应答）；
//! - serve 主循环：未知 type 忽略+计数、payload 校验失败回 error(9001, fatal=false)、
//!   stdin EOF 优雅退出；业务处理经 [`RuntimeHandler`] 注入。
//!
//! 模型：同步阻塞、零业务依赖；模块划分对应 D11 §2.9（stdio→transport.rs，
//! heartbeat 并入主循环的 ping 分支，不再单文件）。

#![forbid(unsafe_code)]

pub mod handshake;
pub mod obo;
pub mod transport;

use std::io::{Read, Write};

use bbrt_protocol::{Envelope, HostToRuntime, ProtocolError, RuntimeToHost, PROTOCOL_VERSION};

pub use handshake::{HandshakeOutcome, HANDSHAKE_TIMEOUT};
pub use obo::{OboCache, RENEW_WINDOW};
pub use transport::{RecvError, StdioTransport, MAX_PENDING_WRITE_BYTES};

/// 传输层错误（serve 返回 Err 时进程应退出；fatal=true 的 error NTF 已尽力发出）
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    /// 写缓冲超 8MB（对端消费停滞）——fatal：继续写只会无限膨胀
    #[error("写缓冲超过 8MB 上限（对端消费停滞），背压熔断")]
    Backpressure,
    #[error("握手失败: {0}")]
    Handshake(String),
    #[error("等待 initialize 超时（上限 {0:?}）")]
    HandshakeTimeout(std::time::Duration),
    #[error("协议大版本不兼容: 宿主 v{host} / Runtime v{runtime}")]
    VersionMismatch { host: u32, runtime: u32 },
    #[error("消息序列化失败: {0}")]
    Protocol(#[from] ProtocolError),
}

/// Runtime 业务处理器：serve 主循环在握手完成后把宿主消息派发到这里。
pub trait RuntimeHandler: Send {
    /// 收到 REQ/NTF（已过握手）；返回 0..1 条回复（REQ 必须回，NTF 通常 None）。
    /// 回复由主循环自动打上 reply_to=请求信封 id。
    fn handle(&mut self, msg: HostToRuntime, env: &Envelope) -> Option<RuntimeToHost>;
    /// initialize.result.capabilities 用
    fn capabilities(&self) -> Vec<String>;
    /// initialize.result / runtime.ready 的 runtimeVersion 用
    fn runtime_version(&self) -> String {
        "0.1.0".into()
    }
}

/// 服务统计（serve_on 返回时带回；serve 忽略）
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ServeStats {
    /// 服务循环收到的信封总数（含未知 type；不含握手期的 initialize）
    pub envelopes: u64,
    /// 未知 type 计数（忽略不退出，D11 §4 前向兼容）
    pub unknown_types: u64,
}

/// 出站信封 id 生成器（r- 前缀，D11 §4 信封约定）
#[derive(Debug, Default)]
pub struct IdGen {
    next: u64,
}

impl IdGen {
    pub fn new() -> Self {
        Self { next: 1 }
    }

    pub fn next_id(&mut self) -> String {
        let id = format!("r-{}", self.next);
        self.next += 1;
        id
    }
}

/// 宿主→Runtime 已知 type 全集：用于区分"未知 type（忽略+计数）"与
/// "payload 校验失败（error 9001）"两条路径（D11 §4）。须与 bbrt-protocol
/// 的 HostToRuntime 枚举 serde 名同步维护。
const KNOWN_HOST_TYPES: &[&str] = &[
    "initialize",
    "session.start",
    "user.message",
    "permission.response",
    "checkpoint.create",
    "checkpoint.restore",
    "delegate.launch",
    "delegate.input",
    "delegate.cancel",
    "delegate.review",
    "session.pause",
    "session.resume",
    "session.end",
    "obo.token",
    "tools.reload",
    "ping",
    "pong",
    // D15 §2.4/§3.3 追加
    "memory.list",
    "memory.delete",
    "report.list",
];

fn is_known_host_type(t: &str) -> bool {
    KNOWN_HOST_TYPES.contains(&t)
}

/// 发送协议级 error NTF（不带回执）
pub(crate) fn send_error<T: Read + Write>(
    transport: &mut StdioTransport<T>,
    ids: &mut IdGen,
    code: u32,
    message: &str,
    fatal: bool,
) -> Result<(), HostError> {
    let err = RuntimeToHost::Error {
        code,
        message: message.to_string(),
        fatal,
        session_id: None,
    };
    transport.send(&Envelope::wrap(PROTOCOL_VERSION, ids.next_id(), &err)?)
}

/// 真实端口：stdin/stdout（阻塞直至 EOF 或致命错误；统计被忽略）。
/// StdinLock/StdoutLock 是 !Send 的可重入锁守卫，故直连内部循环而不经 serve_on 的 Send 约束。
pub fn serve<R: RuntimeHandler>(handler: R) -> Result<(), HostError> {
    serve_impl(StdioPorts::new(), handler).map(|_| ())
}

/// 注入端口的 serve 主循环（测试用 `UnixStream::pair()` 两端驱动）。
/// 成功（EOF）返回服务统计；失败返回 HostError。
pub fn serve_on<R: RuntimeHandler, T: Read + Write + Send>(
    io: T,
    handler: R,
) -> Result<ServeStats, HostError> {
    serve_impl(io, handler)
}

/// 主循环实现（serve/serve_on 共用；不带 Send 约束以容纳 stdin/stdout 锁）
fn serve_impl<R: RuntimeHandler, T: Read + Write>(
    io: T,
    mut handler: R,
) -> Result<ServeStats, HostError> {
    let mut transport = StdioTransport::new(io);
    let mut ids = IdGen::new();

    // 1) 握手：initialize → initialize.result + runtime.ready（D11 §10.2）
    handshake::handshake(&mut transport, &handler, &mut ids)?;

    // 2) 服务循环
    let mut stats = ServeStats::default();
    loop {
        let env = match transport.recv() {
            Ok(Some(env)) => env,
            // stdin EOF：正常退出
            Ok(None) => return Ok(stats),
            Err(RecvError::Io(e)) => return Err(HostError::Io(e)),
            Err(RecvError::Line(msg)) => {
                // 半行/超长行/坏行：codec 已丢弃整行，回 error(9001,false) 后继续（D11 §4）
                send_error(
                    &mut transport,
                    &mut ids,
                    handshake::CODE_PAYLOAD_INVALID,
                    &msg,
                    false,
                )?;
                continue;
            }
        };
        stats.envelopes += 1;

        // 未知 type → 忽略+计数（不 reply 不退出，前向兼容）
        if !is_known_host_type(&env.msg_type) {
            stats.unknown_types += 1;
            continue;
        }

        let msg = match env.unwrap::<HostToRuntime>() {
            Ok(msg) => msg,
            Err(e) => {
                // 已知 type 但 payload 校验失败 → error(9001, fatal=false)，不退出
                send_error(
                    &mut transport,
                    &mut ids,
                    handshake::CODE_PAYLOAD_INVALID,
                    &e.to_string(),
                    false,
                )?;
                continue;
            }
        };

        // ping→pong：codec 层 REQ 回执，不进 handler（20s 周期由宿主发起，本侧只应答）
        if matches!(msg, HostToRuntime::Ping) {
            let pong = Envelope::wrap(PROTOCOL_VERSION, ids.next_id(), &RuntimeToHost::Pong)?
                .with_reply_to(env.id.clone());
            transport.send(&pong)?;
            continue;
        }

        if let Some(reply) = handler.handle(msg, &env) {
            let out = Envelope::wrap(PROTOCOL_VERSION, ids.next_id(), &reply)?
                .with_reply_to(env.id.clone());
            transport.send(&out)?;
        }
    }
}

/// stdin/stdout 适配为单一 Read+Write 端口（serve 专用；读走 stdin、写走 stdout）
struct StdioPorts {
    stdin: std::io::StdinLock<'static>,
    stdout: std::io::StdoutLock<'static>,
}

impl StdioPorts {
    fn new() -> Self {
        Self {
            stdin: std::io::stdin().lock(),
            stdout: std::io::stdout().lock(),
        }
    }
}

impl Read for StdioPorts {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.stdin.read(buf)
    }
}

impl Write for StdioPorts {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.stdout.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stdout.flush()
    }
}
