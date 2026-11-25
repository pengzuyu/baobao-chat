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
pub use transport::{
    HttpTransport, McpServerConfig, ServerMeta, StdioTransport, Transport, TransportConfig,
};

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

/// server 清单条目（`McpClient::inventory` 产出；list_plugins 自省面）
#[derive(Debug, Clone)]
pub struct McpServerInfo {
    pub name: String,
    /// "stdio" | "http"
    pub transport: String,
    /// 连接表在册=已连接（懒补连前/降级=false）
    pub connected: bool,
    /// 来源元数据（None=env 兜底启动）
    pub meta: Option<ServerMeta>,
}

/// 多 server 聚合客户端（bin 装配持有；连接生命周期与进程一致）
pub struct McpClient {
    conns: Mutex<HashMap<String, McpConnection>>,
    /// 已连接 server 的配置快照（reconfigure 判断「同名但配置变了」用——
    /// McpConnection 自身不保留配置）
    active: Mutex<HashMap<String, McpServerConfig>>,
    /// 主体令牌提供者（OboCache 闭包；每次调用现取——逐请求传播）
    tokens: TokenProvider,
    /// 全量配置（懒重连用：启动失败/无令牌降级的 server，登录后首次使用时补连；
    /// mcp.config 动态重配可替换——D22 §5.3/L3）
    configs: Mutex<Vec<McpServerConfig>>,
}

impl McpClient {
    /// 连接全部配置的 server（单条失败不阻塞其余——降级语义 D11 §2.10：
    /// 断连 server 的工具标灰，不拖垮其它来源）；返回 (client, 各 server 结果)。
    /// tokens 同时供 Http 传输（Authorization 头）与 call 层（_meta.bbcObo）逐请求取用
    pub fn connect(configs: &[McpServerConfig], tokens: TokenProvider) -> (Self, ConnectResults) {
        let mut conns = HashMap::new();
        let mut active = HashMap::new();
        let mut results = vec![];
        for cfg in configs {
            match McpConnection::connect(cfg, tokens.clone()) {
                Ok(c) => {
                    active.insert(cfg.name.clone(), cfg.clone());
                    conns.insert(cfg.name.clone(), c);
                    results.push((cfg.name.clone(), Ok(())));
                }
                Err(e) => results.push((cfg.name.clone(), Err(e))),
            }
        }
        (
            Self {
                conns: Mutex::new(conns),
                active: Mutex::new(active),
                tokens,
                configs: Mutex::new(configs.to_vec()),
            },
            results,
        )
    }

    /// 全量重配（D22 §5.3：宿主 mcp.config 下发后调用）：
    /// - 名字与配置（PartialEq）都未变的连接**原样保留**（不打断在用 server）；
    /// - 同名但配置变化 → 断开旧连接（插件更新换版本目录场景），随懒补连重建；
    /// - 不在新配置中的连接断开移除（卸载/禁用）；
    /// - 新增 server **不立即连接**——走既有懒补连（下次 list_tools/call 入口），
    ///   失败降级语义与启动路径一致。
    pub fn reconfigure(&self, configs: Vec<McpServerConfig>) {
        let mut conns = match self.conns.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut active = match self.active.lock() {
            Ok(a) => a,
            Err(_) => return,
        };
        conns.retain(|name, _| {
            match active.get(name) {
                Some(cur) => configs.iter().any(|c| c == cur), // 未变保留；变了/被移除 → 断开
                None => false,
            }
        });
        active.retain(|name, cur| configs.iter().any(|c| c == cur && &c.name == name));
        if let Ok(mut c) = self.configs.lock() {
            *c = configs;
        }
    }

    /// 按名取该 server 的统一身份受众（D38 单票制：call 层据此查票；
    /// 快照缺该 server → None=匿名）
    fn audience_of(&self, server: &str) -> Option<String> {
        self.active
            .lock()
            .ok()
            .and_then(|a| a.get(server).and_then(|c| c.audience.clone()))
    }

    /// 懒补连（2026-11-10 真机事故修复）：启动时 corp 常因用户未登录（无 OBO）
    /// 而 tools/list 401 降级——此前降级即永久标灰。登录后 tokens 现取有值，
    /// 在 list_tools/call 入口先补连缺失 server，自愈无需重启。
    fn ensure_connected(&self) {
        let mut conns = match self.conns.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let all = match self.configs.lock() {
            Ok(c) => c.clone(),
            Err(_) => return,
        };
        let missing: Vec<&McpServerConfig> = all
            .iter()
            .filter(|c| !conns.contains_key(&c.name))
            .collect();
        for cfg in missing {
            match McpConnection::connect(cfg, self.tokens.clone()) {
                Ok(c) => {
                    eprintln!("[bbrt] MCP server '{}' 懒补连成功", cfg.name);
                    if let Ok(mut a) = self.active.lock() {
                        a.insert(cfg.name.clone(), cfg.clone());
                    }
                    conns.insert(cfg.name.clone(), c);
                }
                Err(_) => continue, // 仍无令牌/不可达：保持降级，不阻断后续 server（降级语义 D11 §2.10）
            }
        }
    }

    /// 聚合发现全部工具（policy 过滤后；供 bbrt-tools 注册表注入）
    pub fn list_tools(&self, policy: &PolicyFilter) -> Vec<ToolEntry> {
        self.ensure_connected();
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

    /// server 清单快照（list_plugins 自省面；D26 OQ-3 同批）：配置表 × 连接态
    /// 求交，纯内存零网络——工具清单不在此列（模型 tools 数组已可见全量工具，
    /// 再发现一轮是无谓的调用期 roundtrip）。降级/未连 server 照列（connected=false）
    pub fn inventory(&self) -> Vec<McpServerInfo> {
        let configs = match self.configs.lock() {
            Ok(c) => c.clone(),
            Err(_) => return vec![],
        };
        let conns = match self.conns.lock() {
            Ok(c) => c,
            Err(_) => return vec![],
        };
        configs
            .iter()
            .map(|cfg| McpServerInfo {
                name: cfg.name.clone(),
                transport: match cfg.transport {
                    TransportConfig::Stdio { .. } => "stdio".into(),
                    TransportConfig::Http { .. } => "http".into(),
                },
                connected: conns.contains_key(&cfg.name),
                meta: cfg.meta.clone(),
            })
            .collect()
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
                self.ensure_connected();
                let audience = self.audience_of(server);
                let mut conns = self
                    .conns
                    .lock()
                    .map_err(|_| McpError::Protocol("连接表锁中毒".into()))?;
                let conn = conns.get_mut(server).ok_or_else(|| {
                    McpError::Call(format!("MCP server 未连接: {server}（标灰）"))
                })?;
                let obo = audience
                    .as_deref()
                    .and_then(|a| (self.tokens)(a))
                    .unwrap_or_default();
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
                self.ensure_connected();
                let audience = self.audience_of(server);
                let mut conns = self
                    .conns
                    .lock()
                    .map_err(|_| McpError::Protocol("连接表锁中毒".into()))?;
                let conn = conns.get_mut(server).ok_or_else(|| {
                    McpError::Call(format!("MCP server 未连接: {server}（标灰）"))
                })?;
                let obo = audience
                    .as_deref()
                    .and_then(|a| (self.tokens)(a))
                    .unwrap_or_default();
                call_tool(conn, tool, args, &obo, act)
            }
            _ => Err(McpError::Call(format!("非法 MCP 工具名: {full_name}"))),
        }
    }
}

/// 默认空令牌提供者（无票环境的本地 server 用；D38：按受众查恒 None）
pub fn no_token() -> TokenProvider {
    Arc::new(|_: &str| None)
}
