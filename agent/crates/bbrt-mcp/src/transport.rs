//! stdio 传输（MCP 规范：子进程 stdin/stdout 每行一个 JSON-RPC 2.0 消息）。
//!
//! 读线程 + 行流 channel：request 按 id 配对（乱序/通知行进 stray 缓冲），
//! recv_timeout 实现调用超时。远程 HTTP·SSE 网关传输 v0.1 未实现
//! （帧式与重连经验复用 bbrt-aigw，接入时补）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::McpError;

/// server 配置（bin 从环境/eco 通道装载）
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    /// 命名空间段：工具全名 mcp.{name}.{tool}
    pub name: String,
    pub transport: TransportConfig,
}

#[derive(Debug, Clone)]
pub enum TransportConfig {
    /// 本地子进程（个人 MCP / 本地网关代理）
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    /// 远程网关（公司域 MCP 网关；v0.1 占位——HTTP+SSE 复用 aigw 经验后接入）
    Http { base_url: String },
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
        // 先关 stdin（EOF 优雅退出）再 kill 兜底（进程组语义对齐 delegate procmgr 的收口）
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
