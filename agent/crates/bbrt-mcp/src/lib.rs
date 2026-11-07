//! bbrt-mcp：MCP client（D11 §2.10，2026-11-07 裁决新增）。
//!
//! 公司域能力统一经 MCP 网关/外部 server 供给（D14 §6.1）：本 crate 负责
//! 连接管理（stdio 子进程 / 远程 HTTP·SSE）、initialize 握手、
//! list_tools 动态发现（注入 `mcp.{server}.{tool}` 命名空间）与
//! tools/call 受控调用——**主体身份（OBO）逐请求注入**（D14 §6.2
//! 三层身份：连接凭证归传输层，sub=用户的 OBO 每次调用随行）。
//!
//! 与沙箱/管线的关系：发现的工具进 bbrt-tools 注册表后走同一九步管线
//! （gate→审批→脱敏）；本 crate 只做传输与命名空间，不做门控。
//!
//! 依赖方向：protocol（RiskLevel）；不依赖 session（连接随宿主进程，
//! 非会话级）。被 tools 依赖（网关工具执行转发）。

#![forbid(unsafe_code)]

pub mod call;
pub mod conn;
pub mod discovery;
pub mod http;
pub mod policy;
pub mod transport;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use call::{call_tool, McpCallResult, TokenProvider};
pub use conn::McpConnection;
pub use discovery::ToolEntry;
pub use policy::PolicyFilter;
pub use transport::{HttpTransport, McpServerConfig, StdioTransport, Transport, TransportConfig};

/// MCP client 错误（调用方映射协议错误码：未注册/断连标灰 → 8002；
/// 连接失败 → 8047 语义位，暂由调用方文案承载）
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("连接失败: {0}")]
    Connect(String),
    #[error("协议违规: {0}")]
    Protocol(String),
    #[error("调用失败: {0}")]
    Call(String),
    #[error("超时: {0}")]
    Timeout(String),
    #[error("不支持: {0}")]
    Unsupported(String),
}

/// 各 server 连接结果（单条失败不阻塞其余）
pub type ConnectResults = Vec<(String, Result<(), McpError>)>;

/// 多 server 聚合客户端（bin 装配持有；连接生命周期与进程一致）
pub struct McpClient {
    conns: Mutex<HashMap<String, McpConnection>>,
    /// 主体令牌提供者（OboCache 闭包；每次调用现取——逐请求传播）
    tokens: TokenProvider,
}

impl McpClient {
    /// 连接全部配置的 server（单条失败不阻塞其余——降级语义 D11 §2.10：
    /// 断连 server 的工具标灰，不拖垮其它来源）；返回 (client, 各 server 结果)。
    /// tokens 同时供 Http 传输（Authorization 头）与 call 层（_meta.bbwObo）逐请求取用
    pub fn connect(configs: &[McpServerConfig], tokens: TokenProvider) -> (Self, ConnectResults) {
        let mut conns = HashMap::new();
        let mut results = vec![];
        for cfg in configs {
            match McpConnection::connect(cfg, tokens.clone()) {
                Ok(c) => {
                    conns.insert(cfg.name.clone(), c);
                    results.push((cfg.name.clone(), Ok(())));
                }
                Err(e) => results.push((cfg.name.clone(), Err(e))),
            }
        }
        (
            Self {
                conns: Mutex::new(conns),
                tokens,
            },
            results,
        )
    }

    /// 聚合发现全部工具（policy 过滤后；供 bbrt-tools 注册表注入）
    pub fn list_tools(&self, policy: &PolicyFilter) -> Vec<ToolEntry> {
        let mut all = vec![];
        if let Ok(mut conns) = self.conns.lock() {
            for (name, conn) in conns.iter_mut() {
                if policy.disabled(name) {
                    continue;
                }
                if let Ok(tools) = conn.list_tools() {
                    all.extend(tools);
                }
            }
        }
        policy.filter_tools(all)
    }

    /// 受控调用（full_name = mcp.{server}.{tool}；OBO 从 tokens 现取注入 _meta）
    pub fn call(
        &self,
        full_name: &str,
        args: serde_json::Value,
    ) -> Result<McpCallResult, McpError> {
        let mut it = full_name.splitn(3, '.');
        match (it.next(), it.next(), it.next()) {
            (Some("mcp"), Some(server), Some(tool)) => {
                let mut conns = self
                    .conns
                    .lock()
                    .map_err(|_| McpError::Protocol("连接表锁中毒".into()))?;
                let conn = conns.get_mut(server).ok_or_else(|| {
                    McpError::Call(format!("MCP server 未连接: {server}（标灰）"))
                })?;
                let obo = (self.tokens)().unwrap_or_default();
                call_tool(conn, tool, args, &obo, "agent")
            }
            _ => Err(McpError::Call(format!("非法 MCP 工具名: {full_name}"))),
        }
    }

    /// 归因身份（act）扩展位：专家装配器接线时替换默认 "agent"
    pub fn call_as(
        &self,
        full_name: &str,
        args: serde_json::Value,
        act: &str,
    ) -> Result<McpCallResult, McpError> {
        let mut it = full_name.splitn(3, '.');
        match (it.next(), it.next(), it.next()) {
            (Some("mcp"), Some(server), Some(tool)) => {
                let mut conns = self
                    .conns
                    .lock()
                    .map_err(|_| McpError::Protocol("连接表锁中毒".into()))?;
                let conn = conns.get_mut(server).ok_or_else(|| {
                    McpError::Call(format!("MCP server 未连接: {server}（标灰）"))
                })?;
                let obo = (self.tokens)().unwrap_or_default();
                call_tool(conn, tool, args, &obo, act)
            }
            _ => Err(McpError::Call(format!("非法 MCP 工具名: {full_name}"))),
        }
    }
}

/// 默认空令牌提供者（无 OBO 环境的本地 server 用）
pub fn no_token() -> TokenProvider {
    Arc::new(|| None)
}
