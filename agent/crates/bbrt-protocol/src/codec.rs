//! 行式 JSONL 编解码（D11 §2.1 codec.rs：255KB/行上限、BOM/空行容忍）。
//! 半行缓冲、8MB 写缓冲背压属传输层（bbrt-hostapi/stdio.rs），此处只做同步行语义。

use std::io::{BufRead, Write};

use crate::envelope::Envelope;

/// 单行字节上限（D11 §2.1）；超长行整行丢弃并报错
pub const MAX_LINE_BYTES: usize = 255 * 1024;

/// JSONL 行编解码错误（实现 std::error::Error）
#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    /// 数值与 MAX_LINE_BYTES（255 * 1024）保持一致
    #[error("行超过 261120 字节（255KB）上限，已丢弃")]
    LineTooLong,
    #[error("行内容非 UTF-8")]
    InvalidUtf8,
    /// 对应 D11 §4 "payload 校验失败 → error(9001, fatal=false)" 的解码侧信号
    #[error("JSON 解析失败: {0}")]
    MalformedJson(String),
    #[error("消息序列化失败: {0}")]
    Serialize(String),
}

/// 从行式流读取一条信封。
/// 返回 Ok(None) 表示流正常结束（EOF）；空行与首行 BOM 容忍并跳过；
/// 半行（无换行符的尾巴）视作流结束前的不完整写入，由调用方决定丢弃或等待。
pub fn read_message<R: BufRead>(reader: &mut R) -> Result<Option<Envelope>, CodecError> {
    loop {
        let mut raw: Vec<u8> = Vec::new();
        let n = reader.read_until(b'\n', &mut raw)?;
        if n == 0 {
            return Ok(None); // 流结束
        }
        if raw.len() > MAX_LINE_BYTES {
            return Err(CodecError::LineTooLong);
        }
        let line = std::str::from_utf8(&raw).map_err(|_| CodecError::InvalidUtf8)?;
        // 去掉行尾 \r\n；BOM 只可能出现在首行，逐行剥除无害
        let line = line.trim_end_matches(&['\r', '\n'][..]);
        let line = line.strip_prefix('\u{feff}').unwrap_or(line);
        if line.trim().is_empty() {
            continue; // 空行容忍
        }
        let env: Envelope =
            serde_json::from_str(line).map_err(|e| CodecError::MalformedJson(e.to_string()))?;
        return Ok(Some(env));
    }
}

/// 把一条信封写成单行 JSON + '\n'，并立即 flush（逐行可见性优先于吞吐）。
pub fn write_message<W: Write>(writer: &mut W, env: &Envelope) -> Result<(), CodecError> {
    let mut buf = serde_json::to_vec(env).map_err(|e| CodecError::Serialize(e.to_string()))?;
    buf.push(b'\n');
    writer.write_all(&buf)?;
    writer.flush()?;
    Ok(())
}
