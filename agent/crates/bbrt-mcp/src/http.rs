//! 手写 HTTP/1.1 客户端传输原语（v0.1 口径与 bbrt-aigw 一致：std::net::TcpStream，
//! 不引任何 HTTP 库依赖；`https://` 为已登记开放问题——待网关上 TLS 后换 rustls）。
//!
//! 单请求单连接（`Connection: close`）：POST + Bearer + JSON body +
//! Content-Length；响应整读后按 `Content-Length` / `Transfer-Encoding: chunked` /
//! 读到 EOF 三种语义解出 body。公司域 MCP 网关（Go 端 /mcp/corp，server/mcpgw）
//! 小响应走 Content-Length，chunked 分支为兼容通用 MCP server 保留。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::McpError;

/// 解析后的端点 URL（`http://host:port/path`；path 缺省 `/`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedUrl {
    pub host: String,
    pub port: u16,
    pub path: String,
}

/// 解析端点。仅支持 `http://`（`https://` → Protocol，开放问题登记同 aigw）。
pub(crate) fn parse_url(base: &str) -> Result<ParsedUrl, McpError> {
    let trimmed = base.trim();
    let rest = trimmed.strip_prefix("http://").ok_or_else(|| {
        McpError::Protocol(format!(
            "base_url 必须形如 http://127.0.0.1:8090/mcp/corp，得到 {base:?}（https 待网关 TLS）"
        ))
    })?;
    if rest.is_empty() {
        return Err(McpError::Protocol("base_url 缺少主机名".into()));
    }
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => {
            if h.is_empty() || p.is_empty() {
                return Err(McpError::Protocol(format!(
                    "base_url 主机/端口为空：{base:?}"
                )));
            }
            let port = p
                .parse::<u16>()
                .map_err(|_| McpError::Protocol(format!("base_url 端口非法：{base:?}")))?;
            (h.to_string(), port)
        }
        None => (host_port.to_string(), 80),
    };
    Ok(ParsedUrl { host, port, path })
}

/// 单次 POST 交换：返回 (状态码, body 文本)。IO 失败/超时 → Connect。
/// extra_headers：自定义头（D22 §6.1/L4）；同名（如 Authorization）覆盖自动 Bearer。
pub(crate) fn post_json(
    url: &ParsedUrl,
    bearer: Option<&str>,
    extra_headers: &[(String, String)],
    body: &str,
    timeout: Duration,
) -> Result<(u16, String), McpError> {
    let mut stream = TcpStream::connect((url.host.as_str(), url.port)).map_err(|e| {
        McpError::Connect(format!(
            "MCP 网关连接失败（{}:{}）: {e}",
            url.host, url.port
        ))
    })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    // 自动 Bearer 之上叠自定义头；同名 Authorization 覆盖由调用方
    // （HttpTransport::exchange）决定 bearer 传 None 实现，本层不做头去重
    let mut header_lines = String::new();
    if let Some(t) = bearer {
        header_lines.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    for (k, v) in extra_headers {
        let k = k.trim();
        if k.is_empty()
            || k.eq_ignore_ascii_case("host")
            || k.eq_ignore_ascii_case("content-length")
        {
            continue; // 保留字段不可覆盖
        }
        header_lines.push_str(&format!("{k}: {v}\r\n"));
    }
    let head = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {host}:{port}\r\n\
         {header_lines}\
         Content-Type: application/json\r\n\
         Accept: application/json\r\n\
         User-Agent: {ua}\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n",
        path = url.path,
        host = url.host,
        port = url.port,
        ua = concat!("bbrt-mcp/", env!("CARGO_PKG_VERSION")),
        len = body.len(),
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body.as_bytes()))
        .and_then(|_| stream.flush())
        .map_err(|e| McpError::Connect(format!("MCP 网关写入失败: {e}")))?;

    // 整读响应（Connection: close 保证终止；1MB 上限防御异常 server）
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > 1 << 20 {
                    return Err(McpError::Protocol("响应超过 1MB 上限".into()));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(McpError::Connect(format!("MCP 网关读取失败: {e}"))),
        }
    }
    split_response(&raw)
}

/// 拆响应：状态行 + 头部 + body（Content-Length / chunked / 原样兜底）。
/// body 按**字节**截取/解码（chunk 大小是字节计数，中文正文跨块也正确）。
/// GET 文本（Agent 拉取生态分发：专家清单/定义包；http:// 内网口径，
/// https 随 TLS 依赖阶段二登记；Connection: close 单请求单连接惯例同 post_json）
pub fn get_text(url: &str) -> Result<String, String> {
    use std::io::{Read, Write as _};

    let parsed = parse_url(url).map_err(|e| format!("url 非法: {e}"))?;
    let mut stream = std::net::TcpStream::connect((parsed.host.as_str(), parsed.port))
        .map_err(|e| format!("连接失败: {e}"))?;
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: text/yaml, application/json\r\nConnection: close\r\n\r\n",
        parsed.path, parsed.host
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let (status, body) = split_response(&raw).map_err(|e| e.to_string())?;
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(format!("http {status}"))
    }
}

fn split_response(raw: &[u8]) -> Result<(u16, String), McpError> {
    let split_at = find_subslice(raw, b"\r\n\r\n")
        .ok_or_else(|| McpError::Protocol("响应头不完整（无空行终止）".into()))?;
    let head = String::from_utf8_lossy(&raw[..split_at]).into_owned();
    let body_bytes = &raw[split_at + 4..];

    let mut lines = head.lines();
    let status_line = lines
        .next()
        .ok_or_else(|| McpError::Protocol("响应缺少状态行".into()))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| McpError::Protocol(format!("状态码不可解析：{status_line:?}")))?;

    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            if name == "content-length" {
                content_length = value.parse::<usize>().ok();
            } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }
    let body_bytes = if chunked {
        &decode_chunked(body_bytes)?
    } else if let Some(n) = content_length {
        &body_bytes[..n.min(body_bytes.len())]
    } else {
        body_bytes
    };
    Ok((status, String::from_utf8_lossy(body_bytes).into_owned()))
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// chunked 解码（hex 大小行 + 数据块 + 0 终止块；trailer 节丢弃）。
fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, McpError> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    loop {
        let line_end = find_subslice(&body[pos..], b"\r\n")
            .ok_or_else(|| McpError::Protocol("chunked 帧不完整".into()))?
            + pos;
        let line = String::from_utf8_lossy(&body[pos..line_end]).into_owned();
        let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| McpError::Protocol(format!("非法 chunked 大小行：{line:?}")))?;
        pos = line_end + 2;
        if size == 0 {
            break; // 终止块（trailer 节若有已在 body 尾部，随截断丢弃）
        }
        if pos + size > body.len() {
            return Err(McpError::Protocol("chunked 数据块不完整".into()));
        }
        out.extend_from_slice(&body[pos..pos + size]);
        pos += size;
        pos += 2; // 块尾 CRLF
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_with_path_and_default_port() {
        assert_eq!(
            parse_url("http://127.0.0.1:8090/mcp/corp").unwrap(),
            ParsedUrl {
                host: "127.0.0.1".into(),
                port: 8090,
                path: "/mcp/corp".into()
            }
        );
        assert_eq!(
            parse_url("http://localhost").unwrap(),
            ParsedUrl {
                host: "localhost".into(),
                port: 80,
                path: "/".into()
            }
        );
        assert!(parse_url("https://gw").is_err());
        assert!(parse_url("http://").is_err());
    }

    #[test]
    fn split_response_content_length_and_chunked() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{\"x\":1}";
        assert_eq!(split_response(raw).unwrap(), (200, "{\"x\":1}".into()));

        // 两块 chunked：5 "hello" + 1 ","；终止块
        let chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n1\r\n,\r\n0\r\n\r\n";
        assert_eq!(
            split_response(chunked.as_bytes()).unwrap(),
            (200, "hello,".into())
        );
    }
}

#[cfg(test)]
mod get_text_tests {
    use super::*;
    use std::io::{Read, Write};

    /// GET 文本：本地假服务（Content-Length 与 chunked 两形态）
    #[test]
    fn get_text_content_length_and_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let req = String::from_utf8_lossy(&buf);
                if req.contains("/ok") {
                    let body = "id: corp.x\ntype: local\n";
                    let _ = s.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    );
                } else {
                    let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                }
            }
        });
        assert_eq!(
            get_text(&format!("http://127.0.0.1:{port}/ok")).unwrap(),
            "id: corp.x\ntype: local\n"
        );
        assert!(get_text(&format!("http://127.0.0.1:{port}/miss"))
            .unwrap_err()
            .contains("404"));
        handle.join().unwrap();
    }
}
