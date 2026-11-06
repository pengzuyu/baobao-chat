//! initialize 握手与版本协商（D11 §10.2、§2.9 handshake.rs）。
//!
//! 流程：宿主进程拉起后首条必须是 `initialize`（10s 超时）→
//! Runtime 回 `initialize.result`（REQ 成对，reply_to 指回）→
//! 随即发 `runtime.ready`（NTF，宿主以此为可接收 session.start 的信号）。
//!
//! 版本协商：`protocolVersion` 大版本不同 → 回 error(fatal=true) 并以
//! HostError::VersionMismatch 退出；小版本差异 → 继续运行（前向兼容由
//! "未知字段忽略、未知 type 跳过并计数"保证）。

use std::io::{ErrorKind, Read, Write};
use std::time::{Duration, Instant};

use bbrt_protocol::{Envelope, HostToRuntime, RuntimeToHost, PROTOCOL_VERSION};

use crate::transport::{RecvError, StdioTransport};
use crate::{send_error, HostError, IdGen, RuntimeHandler};

/// 握手等待 initialize 的超时（D11 §2.9）。
/// 硬中止依赖底层读超时（socket 类底层可设；stdin 无该语义时退化为迟到拒绝）。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// 协议错误码（D11 §4：9001=payload 校验失败；9002/9003 为握手阶段的约定扩展）
pub const CODE_PAYLOAD_INVALID: u32 = 9001;
pub const CODE_VERSION_MISMATCH: u32 = 9002;
pub const CODE_NOT_INITIALIZE: u32 = 9003;

/// 版本拆分：major = v / 1000，minor = v % 1000。
/// D11 §10.2 只定义"大版本不同→fatal、小版本→继续"，未定编码；本 crate 约定如上
/// （当前 PROTOCOL_VERSION=1 即 0.001：宿主发 2 视为小版本可继续，1001 起视为大版本升级）。
fn major_of(v: u32) -> u32 {
    v / 1000
}

/// 握手结果（供会话装配消费；传输层自身只使用版本协商结论）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeOutcome {
    /// 宿主声明的 protocolVersion（小版本差异时本侧仍按 PROTOCOL_VERSION 运行）
    pub host_protocol_version: u32,
    /// 宿主能力集（initialize.capabilities）
    pub capabilities: Vec<String>,
    /// 数据目录（initialize.dataDir）
    pub data_dir: String,
}

/// 执行握手；成功返回时 `initialize.result` 与 `runtime.ready` 均已写出。
pub fn handshake<T: Read + Write>(
    transport: &mut StdioTransport<T>,
    handler: &impl RuntimeHandler,
    ids: &mut IdGen,
) -> Result<HandshakeOutcome, HostError> {
    let started = Instant::now();
    let env = match transport.recv() {
        Ok(Some(env)) => env,
        Ok(None) => return Err(HostError::Handshake("握手前流即关闭（EOF）".into())),
        Err(RecvError::Io(e))
            if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
        {
            return Err(HostError::HandshakeTimeout(HANDSHAKE_TIMEOUT));
        }
        Err(RecvError::Io(e)) => return Err(HostError::Io(e)),
        Err(RecvError::Line(msg)) => {
            let detail = format!("首条消息行解码失败: {msg}");
            send_error(transport, ids, CODE_PAYLOAD_INVALID, &detail, true)?;
            return Err(HostError::Handshake(detail));
        }
    };
    // 迟到拒绝：initialize 到达即超过 10s 上限（硬中止见 HANDSHAKE_TIMEOUT 文档）
    if started.elapsed() > HANDSHAKE_TIMEOUT {
        return Err(HostError::HandshakeTimeout(HANDSHAKE_TIMEOUT));
    }

    let (protocol_version, capabilities, data_dir) = match env.unwrap::<HostToRuntime>() {
        Ok(HostToRuntime::Initialize {
            protocol_version,
            capabilities,
            data_dir,
            ..
        }) => (protocol_version, capabilities, data_dir),
        Ok(_) => {
            let detail = format!("首条消息必须是 initialize，实际为 {}", env.msg_type);
            send_error(transport, ids, CODE_NOT_INITIALIZE, &detail, true)?;
            return Err(HostError::Handshake(detail));
        }
        Err(e) => {
            let detail = format!("首条消息 payload 校验失败: {e}");
            send_error(transport, ids, CODE_PAYLOAD_INVALID, &detail, true)?;
            return Err(HostError::Handshake(detail));
        }
    };

    // 版本协商（D11 §10.2）：大版本不同 → error(fatal) + 退出；小版本 → 继续
    if major_of(protocol_version) != major_of(PROTOCOL_VERSION) {
        let detail = format!(
            "协议大版本不兼容：宿主 protocolVersion={protocol_version}，Runtime={PROTOCOL_VERSION}"
        );
        send_error(transport, ids, CODE_VERSION_MISMATCH, &detail, true)?;
        return Err(HostError::VersionMismatch {
            host: protocol_version,
            runtime: PROTOCOL_VERSION,
        });
    }

    // 回 initialize.result（REQ 成对结果；本侧版本号经信封 v 字段表达）
    let runtime_version = handler.runtime_version();
    let result = RuntimeToHost::InitializeResult {
        runtime_version: runtime_version.clone(),
        tools: Vec::new(),
        capabilities: handler.capabilities(),
    };
    transport.send(
        &Envelope::wrap(PROTOCOL_VERSION, ids.next_id(), &result)?.with_reply_to(env.id.clone()),
    )?;

    // 发 runtime.ready NTF（D11 §10.2：握手后、进入服务态前；宿主以此为就绪信号）
    let ready = RuntimeToHost::RuntimeReady {
        runtime_version,
        active_sessions: 0,
        wal_healthy: true,
    };
    transport.send(&Envelope::wrap(PROTOCOL_VERSION, ids.next_id(), &ready)?)?;

    Ok(HandshakeOutcome {
        host_protocol_version: protocol_version,
        capabilities,
        data_dir,
    })
}
