//! 传输层：stdio（子进程行式）与远程 HTTP（公司域 MCP 网关）双形态，
//! 经 [`Transport`] trait 统一——conn/call 对传输无感。
//!
//! stdio：子进程 stdin/stdout 每行一个 JSON-RPC 2.0 消息；读线程 + 行流
//! channel，request 按 id 配对（乱序/通知行进 stray 缓冲），recv_timeout
//! 实现调用超时。
//!
//! HTTP：单请求单连接 POST（`Connection: close`）；**主体令牌（OBO）每请求
//! 现取注入 Authorization: Bearer**（D14 §6.2 ②——`call.rs` 的
//! `_meta.bbcObo` 同时随行，服务端双通道任收）。
//!
//! Streamable HTTP 客户端合规面（2026-11-25）：请求 id 真递增配对（SSE 应答
//! 帧按 id 取响应——流中可能先夹 notification）；应答按 Content-Type 分派，
//! JSON 走原路径、`text/event-stream` 逐事件块提 `data:` 帧；`Mcp-Session-Id`
//! 应答头存下、后续请求回带。无会话态公司网关（mcpgw）不受影响：其应答
//! 无 session 头、id 配对恒命中。不做 GET 监听流（单请求交换用不上）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::call::TokenProvider;
use crate::http::{parse_url, post_json, HttpResponse, ParsedUrl};
use crate::McpError;

/// server 来源元数据（list_plugins 自省面；wire.meta 透传——装配层填，
/// Runtime 只透传不解释）
#[derive(Debug, Clone, PartialEq)]
pub struct ServerMeta {
    /// corp / local / plugin / personal
    pub source: String,
    pub plugin_id: Option<String>,
    pub plugin_name: Option<String>,
    pub version: Option<String>,
}

/// server 配置（bin 从环境/eco 通道装载）
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerConfig {
    /// 命名空间段：工具全名 mcp.{name}.{tool}
    pub name: String,
    pub transport: TransportConfig,
    /// 统一身份受众（D38 单票制）：该 server 的 agent 票 audience（宿主装配期
    /// 从 x-bbc-auth/旧 TOKEN 归一显式填入；std 传输恒 None——令牌不进子进程）。
    /// call 层按它查 OboCache；None=匿名调用不注入身份
    pub audience: Option<String>,
    /// 来源元数据（list_plugins 自省面；None=env 兜底启动的 server）
    pub meta: Option<ServerMeta>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TransportConfig {
    /// 本地子进程（个人 MCP / 本地网关代理）
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    /// 远程网关（公司域 MCP 网关，如 http://127.0.0.1:8080/mcp/corp；
    /// 主体令牌经 TokenProvider 按受众逐请求注入——装配时与 McpClient 同源）。
    /// headers：插件外部系统自定义头（D22 §6.1/L4）——值中 `${BBC_USER_TOKEN}`
    /// 调用层动态替换；自定义 Authorization 覆盖自动 Bearer
    Http {
        base_url: String,
        headers: Vec<(String, String)>,
        /// 统一身份受众（None=无声明不注入 Bearer——匿名调用）
        audience: Option<String>,
    },
}

/// 传输抽象（conn 持有 Box<dyn Transport>；请求-响应/通知两原语）
pub trait Transport: Send {
    /// 发请求并等配对响应（超时即 Err(Timeout)）
    fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, McpError>;
    /// 发通知（无 id，不等响应）
    fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), McpError>;
}

/// stdio JSON-RPC 传输（行式；请求-响应按 id 配对）
pub struct StdioTransport {
    child: Child,
    stdin: ChildStdin,
    /// 读线程产物（死通道 = 进程退出/读端关闭）
    lines: Receiver<String>,
    next_id: u64,
    /// 乱序到达的响应暂存（下个 request 先查这里）
    stray: HashMap<u64, serde_json::Value>,
}

impl StdioTransport {
    /// 拉起子进程（stderr 继承——server 日志走宿主 stderr）
    pub fn spawn(cfg: &TransportConfig) -> Result<Self, McpError> {
        let TransportConfig::Stdio { command, args, env } = cfg else {
            return Err(McpError::Unsupported(
                "远程 HTTP 传输 v0.1 未实现（网关端点就绪后接入）".into(),
            ));
        };
        let mut cmd = Command::new(command);
        cmd.args(args)
            .envs(env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = cmd
            .spawn()
            .map_err(|e| McpError::Connect(format!("MCP server 启动失败（{command}）: {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::Connect("stdin 不可用".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::Connect("stdout 不可用".into()))?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            lines: rx,
            next_id: 0,
            stray: HashMap::new(),
        })
    }

    /// 发请求并等配对响应（超时即 Err(Timeout)；乱序响应入 stray）
    pub fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, McpError> {
        self.next_id += 1;
        let id = self.next_id;
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&frame)
            .map_err(|e| McpError::Protocol(format!("请求序列化失败: {e}")))?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| McpError::Connect(format!("MCP server 写入失败: {e}")))?;

        let deadline = std::time::Instant::now() + timeout;
        loop {
            let wait = deadline.saturating_duration_since(std::time::Instant::now());
            if wait.is_zero() {
                return Err(McpError::Timeout(format!("{method} 响应超时")));
            }
            let line = self.lines.recv_timeout(wait).map_err(|e| match e {
                RecvTimeoutError::Timeout => McpError::Timeout(format!("{method} 响应超时")),
                RecvTimeoutError::Disconnected => {
                    McpError::Connect("MCP server 已退出/连接断开".into())
                }
            })?;
            let v: serde_json::Value = serde_json::from_str(&line)
                .map_err(|e| McpError::Protocol(format!("响应行非法 JSON: {e}")))?;
            match v.get("id").and_then(|x| x.as_u64()) {
                Some(rid) if rid == id => {
                    if let Some(err) = v.get("error") {
                        return Err(McpError::Call(err.to_string()));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
                }
                Some(rid) => {
                    self.stray.insert(rid, v);
                }
                None => { /* 通知/服务端请求：v0.1 忽略（对齐 hostapi 未知 type 计数语义） */
                }
            }
        }
    }

    /// 发通知（无 id，不等响应）
    pub fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), McpError> {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&frame)
            .map_err(|e| McpError::Protocol(format!("通知序列化失败: {e}")))?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| McpError::Connect(format!("MCP server 写入失败: {e}")))
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        // 先关 stdin（EOF 优雅退出）再 kill 兜底（进程组语义收口口径）
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Transport for StdioTransport {
    fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, McpError> {
        StdioTransport::request(self, method, params, timeout)
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), McpError> {
        StdioTransport::notify(self, method, params)
    }
}

/// 远程 HTTP 传输（公司域 MCP 网关 / 插件 HTTP server / 通用 Streamable HTTP
/// server）：单请求单连接，agent 票按受众逐请求注入 Bearer（D38 单票制）；
/// 插件自定义头（D22 §6.1/L4）值中 `${BBC_USER_TOKEN}` 逐请求动态替换
/// （token 轮换不静态化），自带 Authorization 时覆盖自动 Bearer。
/// Streamable HTTP 客户端面：id 递增配对 + SSE 应答解析 + Mcp-Session-Id 回带。
pub struct HttpTransport {
    url: ParsedUrl,
    tokens: TokenProvider,
    audience: Option<String>,
    headers: Vec<(String, String)>,
    /// 请求 id 递增（SSE 应答按 id 配对；无会话态网关同样无害——每请求
    /// 独立连接，id 只要请求期内唯一即可）
    next_id: u64,
    /// server 在 initialize 应答下发的 Mcp-Session-Id（后续请求回带，防 404）
    session_id: Option<String>,
}

impl HttpTransport {
    /// base_url 为网关端点全路径（含 /mcp/corp 等）；令牌提供者与 McpClient 同源，
    /// audience=该 server 的统一身份受众（None=匿名不注入）
    pub fn new(
        base_url: &str,
        headers: Vec<(String, String)>,
        audience: Option<String>,
        tokens: TokenProvider,
    ) -> Result<Self, McpError> {
        Ok(Self {
            url: parse_url(base_url)?,
            tokens,
            audience,
            headers,
            next_id: 0,
            session_id: None,
        })
    }

    /// 最终头表：自定义头值替换 ${BBC_USER_TOKEN}（当前票现取——按受众查）；
    /// 自带 authorization → 自动 Bearer 压掉（覆盖语义）
    fn effective(&self) -> (Option<String>, Vec<(String, String)>) {
        let token = self
            .audience
            .as_deref()
            .and_then(|aud| (self.tokens)(aud))
            .filter(|t| !t.is_empty());
        let mut extra = Vec::with_capacity(self.headers.len());
        let mut custom_auth = false;
        for (k, v) in &self.headers {
            let val = match token.as_deref() {
                Some(t) => v.replace("${BBC_USER_TOKEN}", t),
                None => v.replace("${BBC_USER_TOKEN}", ""),
            };
            if k.trim().eq_ignore_ascii_case("authorization") {
                custom_auth = true;
            }
            extra.push((k.clone(), val));
        }
        let bearer = if custom_auth { None } else { token };
        (bearer, extra)
    }

    fn exchange(
        &self,
        frame: &serde_json::Value,
        timeout: Duration,
    ) -> Result<HttpResponse, McpError> {
        let (bearer, extra) = self.effective();
        post_json(
            &self.url,
            bearer.as_deref(),
            &extra,
            self.session_id.as_deref(),
            &frame.to_string(),
            timeout,
        )
    }
}

/// SSE（`text/event-stream`）应答解析：逐事件块提 `data:` 行（块内多行 data
/// 以 `\n` 拼接——SSE 规范语义），整块 JSON 解析为 JSON-RPC 帧。
/// 注释行（`:` 开头，常见 heartbeat `: ping`）与 event:/id:/retry: 字段忽略；
/// data 非 JSON 的块跳过（防御异常 server；规范上 data 恒为 JSON-RPC 消息）。
/// 返回流中全部成功解析的帧，配对（按 id 取响应）由调用方做。
fn parse_sse_frames(body: &str) -> Vec<serde_json::Value> {
    // 行终止归一（SSE 允许 CRLF/LF/CR 三态，块分隔相应为空行）
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut frames = Vec::new();
    for block in normalized.split("\n\n") {
        let mut data: Vec<&str> = Vec::new();
        for line in block.split('\n') {
            if let Some(rest) = line.strip_prefix("data:") {
                // 冒号后至多一个可选空格属于语法分隔，剥离一次
                data.push(rest.strip_prefix(' ').unwrap_or(rest));
            }
        }
        if data.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str(&data.join("\n")) {
            frames.push(v);
        }
    }
    frames
}

impl Transport for HttpTransport {
    fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, McpError> {
        self.next_id += 1;
        let id = self.next_id;
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let resp = self.exchange(&frame, timeout)?;
        if !(200..=299).contains(&resp.status) {
            return Err(McpError::Connect(format!(
                "MCP 网关 HTTP {}: {}",
                resp.status, resp.body
            )));
        }
        // server 下发会话 id 即存（initialize 应答头；后续请求 exchange 回带）
        if let Some(sid) = resp.session_id {
            self.session_id = Some(sid);
        }
        // 202 = 服务器按通知/纯响应处理，无应答体——对带 id 请求是协议错
        if resp.status == 202 {
            return Err(McpError::Protocol(format!(
                "MCP server 对请求 {method} 回 202（无响应体）"
            )));
        }
        let v = if resp.content_type.as_deref() == Some("text/event-stream") {
            // SSE 应答：流中可能先夹 notification/心跳再来响应帧，按 id 配对
            parse_sse_frames(&resp.body)
                .into_iter()
                .find(|f| f.get("id").and_then(|x| x.as_u64()) == Some(id))
                .ok_or_else(|| {
                    McpError::Protocol(format!(
                        "SSE 应答未含 id={id} 的响应帧（method={method}）: {}",
                        truncate_for_error(&resp.body)
                    ))
                })?
        } else {
            // 纯 JSON 应答（公司网关现状；Content-Type 缺席同走——与旧行为等价）
            serde_json::from_str(&resp.body)
                .map_err(|e| McpError::Protocol(format!("响应非法 JSON: {e}")))?
        };
        if let Some(err) = v.get("error") {
            return Err(McpError::Call(err.to_string()));
        }
        Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), McpError> {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        // 通知不配对响应：HTTP 2xx（202 Accepted）即送达
        let resp = self.exchange(&frame, Duration::from_secs(30))?;
        if !(200..=299).contains(&resp.status) {
            return Err(McpError::Connect(format!(
                "MCP 网关通知 HTTP {}",
                resp.status
            )));
        }
        Ok(())
    }
}

/// 错误信息里 body 截断（1MB 上限下防错误刷屏；SSE 无配对帧时给排障线索）
fn truncate_for_error(s: &str) -> String {
    const MAX: usize = 200;
    if s.len() <= MAX {
        s.to_string()
    } else {
        let mut end = MAX;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…（截断）", &s[..end])
    }
}

#[cfg(test)]
mod http_header_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    fn transport(headers: Vec<(String, String)>, token: Option<&str>) -> HttpTransport {
        transport_aud(headers, Some("aud-1".into()), token)
    }

    fn transport_aud(
        headers: Vec<(String, String)>,
        audience: Option<String>,
        token: Option<&str>,
    ) -> HttpTransport {
        let t = token.map(str::to_string);
        let counter = Arc::new(AtomicUsize::new(0));
        let _ = counter; // 闭包按需构造，不计数
        let provider: TokenProvider = Arc::new(move |aud: &str| {
            // 受众匹配：只有声明受众的票可取（键控缓存语义）
            if aud == "aud-1" {
                t.clone()
            } else {
                None
            }
        });
        HttpTransport::new("http://127.0.0.1:1/mcp", headers, audience, provider).unwrap()
    }

    /// 无自定义头：自动 Bearer（统一身份缺省链路）
    #[test]
    fn effective_default_bearer() {
        let tr = transport(vec![], Some("tok-1"));
        let (bearer, extra) = tr.effective();
        assert_eq!(bearer.as_deref(), Some("tok-1"));
        assert!(extra.is_empty());
    }

    /// 无受众声明（None）→ 不注入 Bearer（匿名调用——D38 个人/插件未声明统一身份）
    #[test]
    fn effective_no_audience_no_bearer() {
        let tr = transport_aud(vec![], None, Some("tok-1"));
        let (bearer, extra) = tr.effective();
        assert!(bearer.is_none(), "无受众不应注入任何票");
        assert!(extra.is_empty());
    }

    /// 自定义 Authorization → 覆盖自动 Bearer（外部系统自带鉴权头）
    #[test]
    fn effective_custom_auth_overrides_bearer() {
        let tr = transport(
            vec![("Authorization".into(), "Private-Token abc".into())],
            Some("tok-1"),
        );
        let (bearer, extra) = tr.effective();
        assert!(bearer.is_none(), "自动 Bearer 应压掉");
        assert_eq!(extra[0].1, "Private-Token abc");
    }

    /// ${BBC_USER_TOKEN} 动态替换（票按受众现取——轮换后无需重配）
    #[test]
    fn effective_replaces_user_token() {
        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let c = captured.clone();
        let provider: TokenProvider = Arc::new(move |_: &str| c.lock().unwrap().clone());
        let tr = HttpTransport::new(
            "http://127.0.0.1:1/mcp",
            vec![("Authorization".into(), "Bearer ${BBC_USER_TOKEN}".into())],
            Some("aud-1".into()),
            provider,
        )
        .unwrap();
        *captured.lock().unwrap() = Some("fresh-tok".into());
        let (bearer, extra) = tr.effective();
        assert!(bearer.is_none());
        assert_eq!(extra[0].1, "Bearer fresh-tok");
        // 票过期/未登录 → 空值（外部系统 401 诚实反馈）
        *captured.lock().unwrap() = None;
        let (_, extra) = tr.effective();
        assert_eq!(extra[0].1, "Bearer ");
    }

    /// 非鉴权自定义头（如 X-Api-Key）与自动 Bearer 并存
    #[test]
    fn effective_extra_header_keeps_bearer() {
        let tr = transport(
            vec![("X-Api-Key".into(), "k-${BBC_USER_TOKEN}".into())],
            Some("tok-2"),
        );
        let (bearer, extra) = tr.effective();
        assert_eq!(bearer.as_deref(), Some("tok-2"));
        assert_eq!(extra[0].1, "k-tok-2");
    }
}

/// Streamable HTTP 客户端面端到端（本地假服务器）：Accept 双列 / SSE 应答
/// 按 id 配对 / 纯 JSON 回归 / Mcp-Session-Id 回带。
#[cfg(test)]
mod streamable_http_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::sync::Arc;

    fn http_transport(port: u16) -> HttpTransport {
        let provider: TokenProvider = Arc::new(|_: &str| None);
        HttpTransport::new(
            &format!("http://127.0.0.1:{port}/mcp"),
            vec![],
            None,
            provider,
        )
        .unwrap()
    }

    /// 读一个完整 HTTP 请求（按头部结束 + Content-Length 定界；客户端不发
    /// FIN，不能读到 EOF），应答原文经 channel 送回测试断言
    fn read_request(s: &mut std::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        loop {
            let n = s.read(&mut tmp).unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..p]).to_ascii_lowercase();
                let cl = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if buf.len() >= p + 4 + cl {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    /// 假服务器：按序消费 responses（每连接一条），请求原文进 channel
    fn serve(responses: Vec<String>) -> (u16, mpsc::Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for resp in responses {
                let Ok((mut s, _)) = listener.accept() else {
                    break;
                };
                let req = read_request(&mut s);
                let _ = tx.send(req);
                let _ = s.write_all(resp.as_bytes());
                let _ = s.flush();
                // drop：关连接（Connection: close 语义，客户端读 EOF 收尾）
            }
        });
        (port, rx)
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn chunked_sse_response(frames: &str) -> String {
        // 单块 chunked（真实 SSE server 常态：Transfer-Encoding: chunked + 流式事件）
        let payload = format!("{:x}\r\n{}\r\n0\r\n\r\n", frames.len(), frames);
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{payload}"
        )
    }

    /// 纯 JSON 应答（公司网关现状回归）+ 请求面：Accept 双列、带递增 id
    #[test]
    fn plain_json_and_accept_header() {
        let (port, rx) = serve(vec![json_response(
            r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#,
        )]);
        let mut tr = http_transport(port);
        let v = tr
            .request("tools/list", serde_json::json!({}), Duration::from_secs(5))
            .unwrap();
        assert_eq!(v, serde_json::json!({"ok": true}));
        let req = rx.recv().unwrap();
        assert!(
            req.contains("Accept: application/json, text/event-stream"),
            "{req}"
        );
        assert!(req.contains(r#""id":1"#), "{req}");
    }

    /// SSE 应答：心跳注释 + notification 帧在前，按 id 配对取响应帧
    #[test]
    fn sse_response_pairs_by_id() {
        let sse = ": ping\n\n\
             event: message\n\
             data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\n\n\
             data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"search\"}]}}\n\n";
        let (port, _rx) = serve(vec![chunked_sse_response(sse)]);
        let mut tr = http_transport(port);
        let v = tr
            .request("tools/list", serde_json::json!({}), Duration::from_secs(5))
            .unwrap();
        assert_eq!(v, serde_json::json!({"tools": [{"name": "search"}]}));
    }

    /// SSE 应答只含 notification（无配对帧）→ Protocol 错误；CRLF 行终止同测
    #[test]
    fn sse_missing_frame_is_protocol_error() {
        let sse = ": ping\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\r\n\r\n";
        let (port, _rx) = serve(vec![chunked_sse_response(sse)]);
        let mut tr = http_transport(port);
        let err = tr
            .request("tools/list", serde_json::json!({}), Duration::from_secs(5))
            .unwrap_err();
        assert!(matches!(err, McpError::Protocol(_)), "{err:?}");
        assert!(err.to_string().contains("id=1"), "{err}");
    }

    /// SSE 应答里配对帧带 JSON-RPC error → Call（MCP 业务错，非协议错）
    #[test]
    fn sse_error_frame_maps_to_call() {
        let sse = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"no such tool\"}}\n\n";
        let (port, _rx) = serve(vec![chunked_sse_response(sse)]);
        let mut tr = http_transport(port);
        let err = tr
            .request("tools/call", serde_json::json!({}), Duration::from_secs(5))
            .unwrap_err();
        assert!(matches!(err, McpError::Call(_)), "{err:?}");
    }

    /// Mcp-Session-Id：initialize 应答头下发后，后续请求回带（防 server 404）
    #[test]
    fn session_id_roundtrip() {
        let init = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: sid-7f2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{}}}}",
            r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.len()
        );
        let (port, rx) = serve(vec![
            init,
            json_response(r#"{"jsonrpc":"2.0","id":2,"result":{"done":true}}"#),
        ]);
        let mut tr = http_transport(port);
        let _ = tr
            .request("initialize", serde_json::json!({}), Duration::from_secs(5))
            .unwrap();
        let first = rx.recv().unwrap();
        assert!(!first.contains("Mcp-Session-Id"), "{first}");
        let v = tr
            .request("tools/list", serde_json::json!({}), Duration::from_secs(5))
            .unwrap();
        assert_eq!(v, serde_json::json!({"done": true}));
        let second = rx.recv().unwrap();
        assert!(second.contains("Mcp-Session-Id: sid-7f2"), "{second}");
        assert!(second.contains(r#""id":2"#), "{second}");
    }

    /// 请求收到 202（server 按通知处理，无响应体）→ 协议错误如实报
    #[test]
    fn accepted_202_for_request_is_error() {
        let resp = "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (port, _rx) = serve(vec![resp.to_string()]);
        let mut tr = http_transport(port);
        let err = tr
            .request("tools/list", serde_json::json!({}), Duration::from_secs(5))
            .unwrap_err();
        assert!(matches!(err, McpError::Protocol(_)), "{err:?}");
    }
}
