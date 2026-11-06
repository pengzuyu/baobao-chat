//! stdio 传输（D11 §2.9 stdio.rs）：包装任意 Read+Write 底层（测试注入 UnixStream）。
//!
//! - 读侧：复用 bbrt-protocol codec 的行式语义（255KB 上限、半行/超长行/坏行兜底），
//!   经 BufReader 做行缓冲；解码失败属单行级错误，整行丢弃后可继续。
//! - 写侧：每条消息单行 JSON + '\n' 并尽力落底 flush（逐行可见性优先于吞吐）；
//!   对端消费停滞时待写字节累积，超过 8MB 上限 → Err(Backpressure) fatal 熔断。

use std::io::{BufReader, ErrorKind, Read, Write};

use bbrt_protocol::{codec, Envelope, ProtocolError};

use crate::HostError;

/// 写缓冲上限：8MB（D11 §2.9 背压熔断阈值）
pub const MAX_PENDING_WRITE_BYTES: usize = 8 * 1024 * 1024;

/// 接收侧错误二分：
/// - Io：底层故障（fatal，主循环退出）；
/// - Line：单行解码失败（codec 已丢弃整行，回 error(9001,false) 后可继续读）。
#[derive(Debug, thiserror::Error)]
pub enum RecvError {
    #[error("底层 IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("行解码失败（已丢弃该行）: {0}")]
    Line(String),
}

/// stdio 传输：单一 T 同时充当读写底层（BufReader 持有 T 收读，写经 get_mut 透传）。
/// 单线程同步阻塞模型；测试可用 `UnixStream::pair()` 的任一端注入。
pub struct StdioTransport<T: Read + Write> {
    reader: BufReader<T>,
    /// 尚未成功落底的待写字节（非阻塞底层/对端停滞时累积，每次 send 尽力排空）
    pending: Vec<u8>,
}

impl<T: Read + Write> StdioTransport<T> {
    pub fn new(io: T) -> Self {
        Self {
            reader: BufReader::new(io),
            pending: Vec::new(),
        }
    }

    /// 读一条信封；Ok(None) 表示流正常结束（EOF）。
    /// 半行、超长行、非 UTF-8、坏 JSON 由 codec 兜底为 RecvError::Line。
    pub fn recv(&mut self) -> Result<Option<Envelope>, RecvError> {
        match codec::read_message(&mut self.reader) {
            Ok(env) => Ok(env),
            Err(codec::CodecError::Io(e)) => Err(RecvError::Io(e)),
            Err(e) => Err(RecvError::Line(e.to_string())),
        }
    }

    /// 写一条信封（单行 JSON + '\n'）并逐条 flush。
    /// 先尽力排空（阻塞底层通常一次写净）；排空后仍滞留超过 8MB
    /// → Err(Backpressure)（fatal：继续写只会让缓冲无限膨胀）。
    pub fn send(&mut self, env: &Envelope) -> Result<(), HostError> {
        let mut line = serde_json::to_vec(env)
            .map_err(|e| HostError::Protocol(ProtocolError::Serialize(e.to_string())))?;
        line.push(b'\n');
        self.pending.extend_from_slice(&line);
        if let Err(e) = self.drain_pending() {
            // WouldBlock/TimedOut 仅出现在带读/写超时或非阻塞底层：保留缓冲待下次续写
            if !matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) {
                return Err(HostError::Io(e));
            }
        }
        if self.pending.len() > MAX_PENDING_WRITE_BYTES {
            return Err(HostError::Backpressure);
        }
        Ok(())
    }

    /// 当前未落底字节数（观测/测试用）
    pub fn pending_bytes(&self) -> usize {
        self.pending.len()
    }

    /// 尽力排空待写缓冲并 flush；支持底层部分写（Ok(n) < 请求长度）。
    fn drain_pending(&mut self) -> Result<(), std::io::Error> {
        let inner = self.reader.get_mut();
        while !self.pending.is_empty() {
            match inner.write(&self.pending) {
                Ok(0) => {
                    return Err(std::io::Error::new(ErrorKind::WriteZero, "底层写入 0 字节"));
                }
                Ok(n) => {
                    self.pending.drain(..n);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        inner.flush()
    }
}
