//! 传输层：stdio（子进程行式）与远程 HTTP（公司域 MCP 网关）双形态，
//! 经 [`Transport`] trait 统一——conn/call 对传输无感。
//!
//! stdio：子进程 stdin/stdout 每行一个 JSON-RPC 2.0 消息；读线程 + 行流
//! channel，request 按 id 配对（乱序/通知行进 stray 缓冲），recv_timeout
//! 实现调用超时。
//!
//! HTTP：单请求单连接 POST（`Connection: close`，无会话态网关端 D14 §6.1
//! 与此口径互锁）；**主体令牌（OBO）每请求现取注入 Authorization: Bearer**
//! （D14 §6.2 ②——`call.rs` 的 `_meta.bbcObo` 同时随行，服务端双通道任收）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::call::TokenProvider;
use crate::http::{parse_url, post_json, ParsedUrl};
use crate::McpError;

/// server 配置（bin 从环境/eco 通道装载）
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerConfig {
    /// 命名空间段：工具全名 mcp.{name}.{tool}
    pub name: String,
    pub transport: TransportConfig,
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
    /// 主体令牌经 TokenProvider 逐请求注入——装配时与 McpClient 同源）。
    /// headers：插件外部系统自定义头（D22 §6.1/L4）——值中 `${BBC_USER_TOKEN}`
    /// 调用层动态替换；自定义 Authorization 覆盖自动 Bearer
    Http {
        base_url: String,
        headers: Vec<(String, String)>,
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

/// 远程 HTTP 传输（公司域 MCP 网关 / 插件 HTTP server）：单请求单连接，
/// OBO 逐请求注入 Bearer；插件自定义头（D22 §6.1/L4）值中
/// `${BBC_USER_TOKEN}` 逐请求动态替换（token 轮换不静态化），
/// 自带 Authorization 时覆盖自动 Bearer。
pub struct HttpTransport {
    url: ParsedUrl,
    tokens: TokenProvider,
    headers: Vec<(String, String)>,
}

impl HttpTransport {
    /// base_url 为网关端点全路径（含 /mcp/corp 等）；令牌提供者与 McpClient 同源。
    pub fn new(
        base_url: &str,
        headers: Vec<(String, String)>,
        tokens: TokenProvider,
    ) -> Result<Self, McpError> {
        Ok(Self {
            url: parse_url(base_url)?,
            tokens,
            headers,
        })
    }

    /// 最终头表：自定义头值替换 ${BBC_USER_TOKEN}（当前 token 现取）；
    /// 自带 authorization → 自动 Bearer 压掉（覆盖语义）
    fn effective(&self) -> (Option<String>, Vec<(String, String)>) {
        let token = (self.tokens)().filter(|t| !t.is_empty());
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
    ) -> Result<(u16, String), McpError> {
        let (bearer, extra) = self.effective();
        post_json(
            &self.url,
            bearer.as_deref(),
            &extra,
            &frame.to_string(),
            timeout,
        )
    }
}

impl Transport for HttpTransport {
    fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, McpError> {
        // 无会话态网关：id 仅形式（每请求独立连接，无需配对）
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let (status, body) = self.exchange(&frame, timeout)?;
        if !(200..=299).contains(&status) {
            return Err(McpError::Connect(format!("MCP 网关 HTTP {status}: {body}")));
        }
        let v: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| McpError::Protocol(format!("响应非法 JSON: {e}")))?;
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
        let (status, _) = self.exchange(&frame, Duration::from_secs(30))?;
        if !(200..=299).contains(&status) {
            return Err(McpError::Connect(format!("MCP 网关通知 HTTP {status}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod http_header_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    fn transport(headers: Vec<(String, String)>, token: Option<&str>) -> HttpTransport {
        let t = token.map(str::to_string);
        let counter = Arc::new(AtomicUsize::new(0));
        let _ = counter; // 闭包按需构造，不计数
        let provider: TokenProvider = Arc::new(move || t.clone());
        HttpTransport::new("http://127.0.0.1:1/mcp", headers, provider).unwrap()
    }

    /// 无自定义头：自动 Bearer（生态服务缺省链路）
    #[test]
    fn effective_default_bearer() {
        let tr = transport(vec![], Some("tok-1"));
        let (bearer, extra) = tr.effective();
        assert_eq!(bearer.as_deref(), Some("tok-1"));
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

    /// ${BBC_USER_TOKEN} 动态替换（token 现取——轮换后无需重配）
    #[test]
    fn effective_replaces_user_token() {
        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let c = captured.clone();
        let provider: TokenProvider = Arc::new(move || c.lock().unwrap().clone());
        let tr = HttpTransport::new(
            "http://127.0.0.1:1/mcp",
            vec![("Authorization".into(), "Bearer ${BBC_USER_TOKEN}".into())],
            provider,
        )
        .unwrap();
        *captured.lock().unwrap() = Some("fresh-tok".into());
        let (bearer, extra) = tr.effective();
        assert!(bearer.is_none());
        assert_eq!(extra[0].1, "Bearer fresh-tok");
        // token 过期/未登录 → 空值（外部系统 401 诚实反馈）
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
