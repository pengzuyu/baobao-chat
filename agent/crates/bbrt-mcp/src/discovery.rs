//! 工具发现：list_tools 结果 → `mcp.{server}.{tool}` 命名空间条目。
//!
//! 风险级：server 清单可经 tool.annotations["x-bbw-risk"] 声明
//! （low|medium|high），缺失默认 **Medium**（D14 §6.1：MCP 工具风险级
//! 默认"中"，治理属性仍以 09 篇 §3.1 表为权威源）。

use bbrt_protocol::RiskLevel;

/// 发现到的工具条目（供 bbrt-tools 注册表注入：ToolDef 的 mcp 来源）
#[derive(Debug, Clone, PartialEq)]
pub struct ToolEntry {
    /// 全名 mcp.{server}.{tool}
    pub full_name: String,
    pub server: String,
    /// server 侧原工具名
    pub name: String,
    pub description: String,
    /// jsonschema inputSchema
    pub input_schema: serde_json::Value,
    pub risk: RiskLevel,
}

impl ToolEntry {
    /// MCP tools/list 条目 → 命名空间化 ToolEntry
    pub fn from_mcp(server: &str, tool: &serde_json::Value) -> Self {
        let name = tool
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let risk = tool
            .get("annotations")
            .and_then(|a| a.get("x-bbw-risk"))
            .and_then(|v| v.as_str())
            .map(|s| match s {
                "low" => RiskLevel::Low,
                "high" => RiskLevel::High,
                _ => RiskLevel::Medium,
            })
            .unwrap_or(RiskLevel::Medium);
        Self {
            full_name: format!("mcp.{server}.{name}"),
            server: server.to_string(),
            name,
            description: tool
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            input_schema: tool
                .get("inputSchema")
                .cloned()
                .unwrap_or(serde_json::json!({"type": "object"})),
            risk,
        }
    }
}
