//! 手写 HTTP/1.1 传输层（v0.1 口径：std::net::TcpStream，不引任何 HTTP 库）。
//!
//! 覆盖：
//! - base_url 解析（`http://host:port`；`https://` 为开放问题——待网关上 TLS 后换 rustls）；
//! - 请求写（POST /v1/chat/completions + Bearer + JSON body + Content-Length）；
//! - 响应状态行/头部解析；
//! - 三种 body 读法：`Content-Length` 定长 / `Transfer-Encoding: chunked`（手写解码，
//!   支持跨读块边界、chunk 扩展、trailer 节）/ 读到连接关闭（EOF）。
//!
//! 错误映射：IO 失败（含 60s 读超时）与"声明长度未读完即断开"→ [`AigwError::StreamInterrupted`]；
//! 帧格式违规（非法 chunk 大小等）→ [`AigwError::Protocol`]。`client.rs` 在"响应头阶段"
//! 会把 StreamInterrupted 归并为 Unavailable（网关不可达语义）。

use std::io::{self, Read};

use crate::error::AigwError;

/// 读写超时（套接字级，硬约束：60s）。
pub(crate) const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 解析后的 base_url。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedBaseUrl {
    pub host: String,
    pub port: u16,
}

/// 解析 base_url。仅支持 `http://host[:port]`（默认端口 80，允许尾随 `/`）。
/// v0.1 不支持 IPv6 字面量与路径前缀；`https://` 报 Protocol（开放问题：待网关上 TLS）。
pub(crate) fn parse_base_url(base: &str) -> Result<ParsedBaseUrl, AigwError> {
    let trimmed = base.trim();
    let rest = trimmed.trim_end_matches('/');
    let host_port = rest.strip_prefix("http://").ok_or_else(|| {
        if trimmed.starts_with("https://") {
            AigwError::Protocol(
                "v0.1 仅支持 http://（HTTPS 待网关上 TLS 后引入 rustls，已登记开放问题）"
                    .to_string(),
            )
        } else {
            AigwError::Protocol(format!(
                "base_url 必须形如 http://127.0.0.1:8091，得到 {base:?}"
            ))
        }
    })?;
    if host_port.is_empty() {
        return Err(AigwError::Protocol("base_url 缺少主机名".to_string()));
    }
    if let Some((host, port_str)) = host_port.rsplit_once(':') {
        if host.is_empty() || port_str.is_empty() {
            return Err(AigwError::Protocol(format!(
                "base_url 主机/端口为空：{base:?}"
            )));
        }
        let port = port_str
            .parse::<u16>()
            .map_err(|_| AigwError::Protocol(format!("base_url 端口非法：{base:?}")))?;
        Ok(ParsedBaseUrl {
            host: host.to_string(),
            port,
        })
    } else {
        Ok(ParsedBaseUrl {
            host: host_port.to_string(),
            port: 80,
        })
    }
}

/// 构造完整 HTTP/1.1 请求字节流（Connection: close——单请求单连接，无 keep-alive 复用）。
pub(crate) fn build_request_bytes(base: &ParsedBaseUrl, token: &str, body: &str) -> Vec<u8> {
    let head = format!(
        "POST /v1/chat/completions HTTP/1.1\r\n\
         Host: {host}:{port}\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Type: application/json\r\n\
         Accept: text/event-stream\r\n\
         User-Agent: {ua}\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n",
        host = base.host,
        port = base.port,
        token = token,
        ua = concat!("bbrt-aigw/", env!("CARGO_PKG_VERSION")),
        len = body.len(),
    );
    let mut out = head.into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// 响应状态行 + 头部（头部名已转小写便于查找）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResponseHead {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl ResponseHead {
    /// 按名取头部值（不区分大小写——存的时候已小写）。
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    /// 依据头部确定 body 读法。
    pub fn body_mode(&self) -> BodyMode {
        if let Some(te) = self.header("transfer-encoding") {
            if te.to_ascii_lowercase().contains("chunked") {
                return BodyMode::Chunked;
            }
        }
        if let Some(cl) = self.header("content-length") {
            if let Ok(n) = cl.trim().parse::<usize>() {
                return BodyMode::Length { remaining: n };
            }
        }
        // 既无长度也无 chunked：读到连接关闭（错误体常见形态）
        BodyMode::Eof
    }
}

/// body 读法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BodyMode {
    /// Content-Length 定长。
    Length { remaining: usize },
    /// chunked 分块（手写解码）。
    Chunked,
    /// 读到连接关闭。
    Eof,
}

/// chunked 解码内部状态。
#[derive(Debug, Clone, PartialEq, Eq)]
enum ChunkState {
    /// 等待读取下一块的大小行。
    AtHeader,
    /// 当前块剩余字节数。
    InData(usize),
    /// 终止块（0 长度）+ trailer 节已读完。
    Done,
}

/// 带内部缓冲的 body 读取器：先用于读响应头（原始行），切换 `BodyMode` 后按对应
/// 语义逐字节/逐行读 body。泛型 `R` 便于用内存 reader 做单元测试。
pub(crate) struct BodyReader<R: Read> {
    inner: R,
    buf: Vec<u8>,
    pos: usize,
    mode: BodyMode,
    chunk_state: ChunkState,
}

impl<R: Read> BodyReader<R> {
    /// 初始为 Eof 模式（读响应头阶段模式无意义，头部读完务必 `set_mode`）。
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buf: Vec::new(),
            pos: 0,
            mode: BodyMode::Eof,
            chunk_state: ChunkState::AtHeader,
        }
    }

    /// 头部读完之后切换 body 读法。
    pub fn set_mode(&mut self, mode: BodyMode) {
        if mode == BodyMode::Chunked {
            self.chunk_state = ChunkState::AtHeader;
        }
        self.mode = mode;
    }

    /// 从底层读取填充缓冲；返回 false 表示底层干净 EOF。
    fn fill(&mut self) -> Result<bool, AigwError> {
        if self.pos < self.buf.len() {
            return Ok(true);
        }
        self.buf.clear();
        self.pos = 0;
        let mut tmp = [0u8; 4096];
        loop {
            match self.inner.read(&mut tmp) {
                Ok(0) => return Ok(false),
                Ok(n) => {
                    self.buf.extend_from_slice(&tmp[..n]);
                    return Ok(true);
                }
                // EINTR 重试；其余 IO 错误（含读超时 WouldBlock/TimedOut）→ 断流
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(AigwError::StreamInterrupted),
            }
        }
    }

    /// 取下一个原始字节（不经 body 模式语义）；None = 干净 EOF。
    fn next_raw_byte(&mut self) -> Result<Option<u8>, AigwError> {
        if !self.fill()? {
            return Ok(None);
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(Some(b))
    }

    /// 按 body 模式取下一个 body 字节：
    /// - Length：耗尽即 body 结束（Ok(None)）；未耗尽遇 EOF → 断流；
    /// - Chunked：跨块透明续读，0 长度块 + trailer 后结束（Ok(None)）；帧不完整 → 断流；
    /// - Eof：连接关闭即结束（Ok(None)）。
    fn next_body_byte(&mut self) -> Result<Option<u8>, AigwError> {
        match self.mode {
            BodyMode::Eof => self.next_raw_byte(),
            BodyMode::Length { remaining } => {
                if remaining == 0 {
                    return Ok(None);
                }
                let b = self.next_raw_byte()?.ok_or(AigwError::StreamInterrupted)?;
                if let BodyMode::Length { remaining } = &mut self.mode {
                    *remaining -= 1;
                }
                Ok(Some(b))
            }
            BodyMode::Chunked => loop {
                match self.chunk_state {
                    ChunkState::Done => return Ok(None),
                    ChunkState::InData(n) => {
                        if n == 0 {
                            // 上一块数据已读完：吃掉块尾 CRLF（宽容处理，读到行尾即可）
                            self.read_raw_line()?.ok_or(AigwError::StreamInterrupted)?;
                            self.chunk_state = ChunkState::AtHeader;
                        } else {
                            let b = self.next_raw_byte()?.ok_or(AigwError::StreamInterrupted)?;
                            self.chunk_state = ChunkState::InData(n - 1);
                            return Ok(Some(b));
                        }
                    }
                    ChunkState::AtHeader => {
                        let line = self.read_raw_line()?.ok_or(AigwError::StreamInterrupted)?;
                        let size = parse_chunk_size(&line)?;
                        if size == 0 {
                            // 终止块：trailer 节以空行结束
                            loop {
                                let trailer =
                                    self.read_raw_line()?.ok_or(AigwError::StreamInterrupted)?;
                                if trailer.trim().is_empty() {
                                    break;
                                }
                            }
                            self.chunk_state = ChunkState::Done;
                            return Ok(None);
                        }
                        self.chunk_state = ChunkState::InData(size);
                    }
                }
            },
        }
    }

    /// 读一行（原始层：不区分 body 模式，读到底层 `\n` 为止；行内容含 `\n`）。
    /// None = 读取前已干净 EOF；行中途 EOF 视为断流。
    fn read_raw_line(&mut self) -> Result<Option<String>, AigwError> {
        let mut out = Vec::new();
        loop {
            match self.next_raw_byte()? {
                Some(b) => {
                    out.push(b);
                    if b == b'\n' {
                        break;
                    }
                }
                None => {
                    if out.is_empty() {
                        return Ok(None);
                    }
                    // 帧中途断开
                    return Err(AigwError::StreamInterrupted);
                }
            }
        }
        Ok(Some(String::from_utf8_lossy(&out).into_owned()))
    }

    /// 读一行 SSE 数据（经 body 模式语义）。None = body 干净结束；
    /// body 末尾无换行的残留半行也会作为最后一行返回。
    pub fn read_line(&mut self) -> Result<Option<String>, AigwError> {
        let mut out = Vec::new();
        loop {
            match self.next_body_byte()? {
                Some(b) => {
                    out.push(b);
                    if b == b'\n' {
                        break;
                    }
                }
                None => {
                    if out.is_empty() {
                        return Ok(None);
                    }
                    break;
                }
            }
        }
        Ok(Some(String::from_utf8_lossy(&out).into_owned()))
    }

    /// 尽力读取剩余 body 字节（错误体解析用；上限 64KB，出错/截断容忍）。
    pub fn read_body_bytes(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while out.len() < 64 * 1024 {
            match self.next_body_byte() {
                Ok(Some(b)) => out.push(b),
                _ => break,
            }
        }
        out
    }
}

/// 解析 chunk 大小行（"1a\r\n" / "1a;ext=1\r\n"），十六进制。
fn parse_chunk_size(line: &str) -> Result<usize, AigwError> {
    let hex = line.trim().split(';').next().unwrap_or("").trim();
    usize::from_str_radix(hex, 16)
        .map_err(|_| AigwError::Protocol(format!("非法 chunked 大小行：{line:?}")))
}

/// 读取响应状态行 + 头部。头部阶段任何 IO 失败由调用方归并为 Unavailable。
pub(crate) fn read_response_head<R: Read>(
    reader: &mut BodyReader<R>,
) -> Result<ResponseHead, AigwError> {
    let status_line = reader
        .read_raw_line()?
        .ok_or_else(|| AigwError::Protocol("响应提前结束：无状态行".to_string()))?;
    let mut parts = status_line.trim_end().splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/") {
        return Err(AigwError::Protocol(format!(
            "非 HTTP 响应状态行：{status_line:?}"
        )));
    }
    let status = parts
        .next()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .ok_or_else(|| AigwError::Protocol(format!("状态码不可解析：{status_line:?}")))?;
    let mut headers = Vec::new();
    loop {
        let line = reader
            .read_raw_line()?
            .ok_or_else(|| AigwError::Protocol("响应头提前结束".to_string()))?;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    Ok(ResponseHead { status, headers })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模拟 TCP 分段的 reader：每次 read 至多返回 max 字节，
    /// 用于验证 chunked/定长解码在任意读块边界下都正确。
    struct ChunksReader {
        data: Vec<u8>,
        pos: usize,
        max: usize,
    }

    impl ChunksReader {
        fn new(data: &[u8], max: usize) -> Self {
            Self {
                data: data.to_vec(),
                pos: 0,
                max,
            }
        }
    }

    impl Read for ChunksReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let n = out.len().min(self.max).min(self.data.len() - self.pos);
            out[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    #[test]
    fn parse_base_url_variants() {
        assert_eq!(
            parse_base_url("http://127.0.0.1:8091").unwrap(),
            ParsedBaseUrl {
                host: "127.0.0.1".to_string(),
                port: 8091
            }
        );
        // 尾随斜杠容忍；无端口默认 80
        assert_eq!(
            parse_base_url("http://localhost/").unwrap(),
            ParsedBaseUrl {
                host: "localhost".to_string(),
                port: 80
            }
        );
        assert!(matches!(
            parse_base_url("https://gw.example.com"),
            Err(AigwError::Protocol(_))
        ));
        assert!(matches!(
            parse_base_url("127.0.0.1:8091"),
            Err(AigwError::Protocol(_))
        ));
        assert!(matches!(
            parse_base_url("http://127.0.0.1:notaport"),
            Err(AigwError::Protocol(_))
        ));
        assert!(matches!(
            parse_base_url("http://"),
            Err(AigwError::Protocol(_))
        ));
    }

    #[test]
    fn build_request_contains_method_path_headers_and_body() {
        let base = ParsedBaseUrl {
            host: "127.0.0.1".to_string(),
            port: 8091,
        };
        let bytes = build_request_bytes(&base, "tok-xyz", r#"{"model":"bbc-strong"}"#);
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
        assert!(text.contains("Host: 127.0.0.1:8091\r\n"));
        assert!(text.contains("Authorization: Bearer tok-xyz\r\n"));
        assert!(text.contains("Content-Type: application/json\r\n"));
        assert!(text.contains("Accept: text/event-stream\r\n"));
        assert!(text.contains(r#"Content-Length: 22"#));
        assert!(text.ends_with(r#"{"model":"bbc-strong"}"#));
    }

    /// chunked 解码：数据块跨任意读块边界（每次底层 read 仅 1~3 字节）仍正确。
    #[test]
    fn chunked_decode_across_read_boundaries() {
        // 两个数据块：块1 "data: {\"a\"}\n\n"（12B，0xC），块2 "x"（1B），终止块+空 trailer
        let frame1 = "data: {\"a\"}\n\n";
        let frame2 = "x";
        let mut wire = String::new();
        wire.push_str(&format!("{:x}\r\n{}\r\n", frame1.len(), frame1));
        wire.push_str(&format!("{:x}\r\n{}\r\n", frame2.len(), frame2));
        wire.push_str("0\r\n\r\n");

        for max in [1, 2, 3, 4096] {
            let mut reader = BodyReader::new(ChunksReader::new(wire.as_bytes(), max));
            reader.set_mode(BodyMode::Chunked);
            let line = reader.read_line().unwrap().unwrap();
            assert_eq!(line, "data: {\"a\"}\n");
            let blank = reader.read_line().unwrap().unwrap();
            assert_eq!(blank, "\n");
            let tail = reader.read_line().unwrap().unwrap();
            assert_eq!(tail, "x");
            assert!(
                reader.read_line().unwrap().is_none(),
                "max={max} 应干净结束"
            );
        }
    }

    /// chunked：chunk 扩展（";ext=1"）、trailer 节、read_body_bytes 全量读。
    #[test]
    fn chunked_with_extensions_and_trailers() {
        let wire = "5;ext=1\r\nhello\r\n0\r\nX-Trace: t1\r\nX-Trace: t2\r\n\r\n";
        let mut reader = BodyReader::new(ChunksReader::new(wire.as_bytes(), 3));
        reader.set_mode(BodyMode::Chunked);
        assert_eq!(reader.read_body_bytes(), b"hello".to_vec());
        // 终止后不再有数据
        assert!(reader.read_line().unwrap().is_none());
    }

    /// 非法 chunk 大小行 → Protocol。
    #[test]
    fn chunked_bad_size_line_is_protocol_error() {
        let wire = "zz\r\nhello\r\n";
        let mut reader = BodyReader::new(ChunksReader::new(wire.as_bytes(), 8));
        reader.set_mode(BodyMode::Chunked);
        assert!(matches!(reader.read_line(), Err(AigwError::Protocol(_))));
    }

    /// Content-Length：读满即止；声明长度未读完即 EOF → 断流。
    #[test]
    fn content_length_mode_exact_and_premature_eof() {
        let mut reader = BodyReader::new(ChunksReader::new(b"abcde", 2));
        reader.set_mode(BodyMode::Length { remaining: 5 });
        assert_eq!(reader.read_body_bytes(), b"abcde".to_vec());
        assert!(reader.read_line().unwrap().is_none());

        let mut short = BodyReader::new(ChunksReader::new(b"abc", 8));
        short.set_mode(BodyMode::Length { remaining: 5 });
        assert!(matches!(
            short.read_line(),
            Err(AigwError::StreamInterrupted)
        ));
    }

    /// EOF 模式：连接关闭即 body 结束（错误体常见：无 CL、Connection: close）。
    #[test]
    fn eof_mode_reads_until_close() {
        let mut reader = BodyReader::new(ChunksReader::new(b"{\"code\":8050}", 4));
        reader.set_mode(BodyMode::Eof);
        assert_eq!(reader.read_body_bytes(), b"{\"code\":8050}".to_vec());
        assert!(reader.read_line().unwrap().is_none());
    }

    /// 响应头解析 + 头部决定 body 模式。
    #[test]
    fn read_response_head_and_body_mode() {
        let wire = b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: 9\r\n\r\n{\"x\":1}";
        let mut reader = BodyReader::new(ChunksReader::new(wire, 5));
        let head = read_response_head(&mut reader).unwrap();
        assert_eq!(head.status, 429);
        assert_eq!(head.header("content-type"), Some("application/json"));
        assert_eq!(head.body_mode(), BodyMode::Length { remaining: 9 });
        reader.set_mode(head.body_mode());
        assert_eq!(reader.read_body_bytes(), b"{\"x\":1}".to_vec());

        let chunked = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n";
        let mut r2 = BodyReader::new(ChunksReader::new(chunked, 7));
        let h2 = read_response_head(&mut r2).unwrap();
        assert_eq!(h2.status, 200);
        assert_eq!(h2.body_mode(), BodyMode::Chunked);

        let close = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n";
        let mut r3 = BodyReader::new(ChunksReader::new(close, 7));
        let h3 = read_response_head(&mut r3).unwrap();
        assert_eq!(h3.body_mode(), BodyMode::Eof);

        // 状态行损坏 → Protocol
        let mut r4 = BodyReader::new(ChunksReader::new(b"GARBAGE\r\n\r\n", 7));
        assert!(matches!(
            read_response_head(&mut r4),
            Err(AigwError::Protocol(_))
        ));
    }
}
