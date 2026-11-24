//! 连接管理：initialize 握手（协议版本协商·宽容收下 server 版本）、
//! initialized 通知、工具发现入口。传输经 [`Transport`] trait 双形态：
//! stdio 子进程 / 远程 HTTP 网关（Http 传输持 TokenProvider 逐请求注入 Bearer）。

use std::time::Duration;

use crate::call::TokenProvider;
use crate::discovery::ToolEntry;
use crate::transport::{
    HttpTransport, McpServerConfig, StdioTransport, Transport, TransportConfig,
};
use crate::McpError;

/// 单 server 连接（握手后复用；非 Clone——经 McpClient 的 Mutex 表共享；
/// 请求需要 &mut，由持锁方保证串行）
pub struct McpConnection {
    server: String,
    transport: Box<dyn Transport>,
    /// server 回报的协议版本（宽容：客户端按 2024-11-05 请求，收下其回报）
    protocol_version: String,
    server_name: String,
}

/// MCP 握手/发现调用的统一超时
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

impl McpConnection {
    /// 构建传输 + initialize 握手 + initialized 通知
    /// （tokens：Http 传输注入 Authorization；stdio 传输身份走 params._meta）
    pub fn connect(cfg: &McpServerConfig, tokens: TokenProvider) -> Result<Self, McpError> {
        let mut transport: Box<dyn Transport> = match &cfg.transport {
            TransportConfig::Stdio { .. } => Box::new(StdioTransport::spawn(&cfg.transport)?),
            TransportConfig::Http {
                base_url,
                headers,
                audience,
            } => Box::new(HttpTransport::new(
                base_url,
                headers.clone(),
                audience.clone(),
                tokens,
            )?),
        };
        let result = transport.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "bbrt", "version": env!("CARGO_PKG_VERSION") },
            }),
            CALL_TIMEOUT,
        )?;
        let protocol_version = result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("2024-11-05")
            .to_string();
        let server_name = result
            .get("serverInfo")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        transport.notify("notifications/initialized", serde_json::json!({}))?;
        Ok(Self {
            server: cfg.name.clone(),
            transport,
            protocol_version,
            server_name,
        })
    }

    /// server 回报的协议版本（诊断/健康面板用）
    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    /// serverInfo.name（与配置命名空间段可能不同；展示用）
    pub fn server_info_name(&self) -> &str {
        &self.server_name
    }

    /// tools/list → 命名空间化条目（mcp.{server}.{tool}）
    pub fn list_tools(&mut self) -> Result<Vec<ToolEntry>, McpError> {
        let result = self
            .transport
            .request("tools/list", serde_json::json!({}), CALL_TIMEOUT)?;
        let tools = result
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(tools
            .into_iter()
            .map(|t| ToolEntry::from_mcp(&self.server, &t))
            .collect())
    }

    /// tools/call（工具名已在 params.name；由 call::call_tool 组装完整参数）
    pub fn request_call(
        &mut self,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, McpError> {
        self.transport.request("tools/call", params, CALL_TIMEOUT)
    }
}
