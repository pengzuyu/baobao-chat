//! 租户策略过滤（D14 §6.1：可按 mcp.{server}.* 通配管控）。
//!
//! v0.1 本地缓存态：禁用 server 名单（10 篇 §4.6 注册表规则的数量/
//! 冲突校验在 bbrt-tools 注入时执行，此处只做来源过滤）。

use crate::discovery::ToolEntry;

/// 策略过滤器（bin 装配：从租户策略缓存构造；策略更新经 tools.reload）
#[derive(Debug, Clone, Default)]
pub struct PolicyFilter {
    /// 禁用的 server 名单（命名空间段，非全名）
    disabled_servers: Vec<String>,
}

impl PolicyFilter {
    pub fn new(disabled_servers: Vec<String>) -> Self {
        Self { disabled_servers }
    }

    /// server 是否被禁用
    pub fn disabled(&self, server: &str) -> bool {
        self.disabled_servers.iter().any(|s| s == server)
    }

    /// 过滤工具条目（发现后注入注册表前）
    pub fn filter_tools(&self, tools: Vec<ToolEntry>) -> Vec<ToolEntry> {
        tools
            .into_iter()
            .filter(|t| !self.disabled(&t.server))
            .collect()
    }
}
