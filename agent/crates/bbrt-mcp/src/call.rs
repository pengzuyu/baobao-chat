//! 受控调用：tools/call + 主体身份（OBO）逐请求注入（D14 §6.2）。
//!
//! stdio 传输无 HTTP 头可放——身份进 JSON-RPC params._meta：
//! `{"bbwObo": "...", "bbwAct": "..."}`；远程 HTTP 网关接入后改
//! Authorization/X-BBW-* 头（传输层差异，调用方无感）。

use std::sync::Arc;

use crate::conn::McpConnection;
use crate::McpError;

/// 主体令牌提供者（bin 装配闭包：OboCache 现取——逐请求传播，不缓存到连接）
pub type TokenProvider = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// tools/call 结果（MCP 语义：isError=true 是**结果**而非 JSON-RPC error——
/// 工具业务失败照样回传给模型自行处置）
#[derive(Debug, Clone, PartialEq)]
pub struct McpCallResult {
    /// content[] 中 type=text 的拼接（v0.1 只取文本通道）
    pub text: String,
    pub is_error: bool,
}

/// 调用 server 工具（obo 为空则省 _meta.bbwObo；act 归因身份：agent 会话/
/// expert:{personaId}:{activationId}，仅审计不影响权限）
pub fn call_tool(
    conn: &mut McpConnection,
    tool: &str,
    args: serde_json::Value,
    obo: &str,
    act: &str,
) -> Result<McpCallResult, McpError> {
    let mut meta = serde_json::Map::new();
    if !obo.is_empty() {
        meta.insert("bbwObo".into(), serde_json::json!(obo));
    }
    if !act.is_empty() {
        meta.insert("bbwAct".into(), serde_json::json!(act));
    }
    let params = serde_json::json!({
        "name": tool,
        "arguments": args,
        "_meta": meta,
    });
    let result = conn.request_call(params)?;
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let text = result
        .get("content")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    Ok(McpCallResult { text, is_error })
}
