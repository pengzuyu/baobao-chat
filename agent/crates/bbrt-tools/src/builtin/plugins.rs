//! list_plugins 工具（D22/D26 自省面收口）：agent 感知"自己装了什么"的唯一通道。
//!
//! 背景：MCP 工具以 `mcp.{server}.{tool}` 进模型 tools 数组，但 server 从哪来
//! （哪个插件/什么版本/启停与连接态）模型无从得知——本工具读 `McpClient::
//! inventory()`（纯内存快照，零网络）回答。只读 Low/ReadOnly：全档自动放行。

use serde_json::json;

use crate::registry::{RiskLevel, ToolDef};

pub fn list_plugins_def() -> ToolDef {
    ToolDef {
        name: "list_plugins".into(),
        description: "List installed plugins and MCP servers with their source (corp gateway / \
                      local host / plugin with version / personal config) and connection status. \
                      Use when the user asks what plugins, extensions or MCP servers you have, or \
                      before claiming a capability might be missing. MCP tools appear as \
                      mcp.{server}.{tool} in your tools list"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {}
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// 执行：inventory 快照 → 紧凑文本清单。未装配（单测/嵌入式）降级不阻断。
pub(crate) fn list_plugins(
    mcp: Option<&std::sync::Arc<bbrt_mcp::McpClient>>,
    _args: &serde_json::Value,
) -> Result<crate::builtin::ExecOutput, crate::builtin::ToolBlock> {
    let Some(mcp) = mcp else {
        return Ok(crate::builtin::ExecOutput {
            summary: "MCP not assembled (embedded mode); no plugins or MCP servers".into(),
            truncated: false,
            exit_code: Some(1),
            duration_ms: 0,
        });
    };
    let info = mcp.inventory();
    if info.is_empty() {
        return Ok(crate::builtin::ExecOutput {
            summary: "No plugins or MCP servers installed (only built-in tools are available)."
                .into(),
            truncated: false,
            exit_code: None,
            duration_ms: 0,
        });
    }
    let mut lines = vec![format!("MCP servers: {}", info.len())];
    for s in &info {
        let origin = match &s.meta {
            Some(m) => match (m.source.as_str(), &m.plugin_id) {
                ("plugin", Some(pid)) => match (&m.plugin_name, &m.version) {
                    (Some(name), Some(ver)) => format!("plugin {pid} ({name} v{ver})"),
                    (Some(name), None) => format!("plugin {pid} ({name})"),
                    _ => format!("plugin {pid}"),
                },
                (src, _) => src.to_string(),
            },
            None => "unknown (env boot)".to_string(),
        };
        lines.push(format!(
            "- {} [{}] {} {}",
            s.name,
            origin,
            s.transport,
            if s.connected { "connected" } else { "disconnected" }
        ));
    }
    lines.push(
        "Tools from these servers are named mcp.{server}.{tool} in your tools list.".into(),
    );
    Ok(crate::builtin::ExecOutput {
        summary: lines.join("\n"),
        truncated: false,
        exit_code: None,
        duration_ms: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未装配降级：Ok + exit_code=1（非阻断），文案可引导
    #[test]
    fn 未装配_降级不阻断() {
        let out = list_plugins(None, &serde_json::json!({})).unwrap();
        assert_eq!(out.exit_code, Some(1));
        assert!(out.summary.contains("MCP not assembled"));
    }

    /// 空清单：Ok 正常返回（exit_code=None），文案明确"仅内建"
    #[test]
    fn 空清单_明确无插件() {
        let (client, _) = bbrt_mcp::McpClient::connect(&[], bbrt_mcp::no_token());
        let out = list_plugins(Some(&std::sync::Arc::new(client)), &serde_json::json!({})).unwrap();
        assert_eq!(out.exit_code, None);
        assert!(out.summary.contains("No plugins or MCP servers"));
    }

    /// 有 server：逐条 origin/transport/连接态 + 尾行命名提示
    #[test]
    fn 清单_含来源与连接态() {
        use bbrt_mcp::{McpServerConfig, ServerMeta, TransportConfig};
        let cfg = McpServerConfig {
            name: "gitlab".into(),
            transport: TransportConfig::Http {
                base_url: "https://gitlab.example.com/api/mcp".into(),
                headers: vec![],
                audience: None,
            },
            audience: None,
            meta: Some(ServerMeta {
                source: "plugin".into(),
                plugin_id: Some("deploy-helper".into()),
                plugin_name: Some("发版流程助手".into()),
                version: Some("1.2.0".into()),
            }),
        };
        let (client, _) = bbrt_mcp::McpClient::connect(&[], bbrt_mcp::no_token());
        client.reconfigure(vec![cfg]);
        let out = list_plugins(Some(&std::sync::Arc::new(client)), &serde_json::json!({})).unwrap();
        assert!(out.summary.contains("MCP servers: 1"));
        assert!(out.summary.contains("- gitlab [plugin deploy-helper (发版流程助手 v1.2.0)]"));
        assert!(out.summary.contains("http disconnected"));
        assert!(out.summary.contains("mcp.{server}.{tool}"));
    }

    /// 工具定义：只读低危，注册名 list_plugins
    #[test]
    fn 定义_只读低危() {
        let def = list_plugins_def();
        assert_eq!(def.name, "list_plugins");
        assert_eq!(def.risk, RiskLevel::Low);
        assert_eq!(def.category, bbrt_sec::gate::ActionCategory::ReadOnly);
    }
}
