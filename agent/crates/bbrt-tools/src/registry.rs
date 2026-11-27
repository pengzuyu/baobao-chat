//! 工具注册表（D11 §2.4 registry.rs；10 篇 §4.6 内置 + app.* + 技能合并的静态子集）。
//!
//! 职责：ToolDef 的注册/查询/清单导出。每条 ToolDef 携带 D13-A2 的动作类别
//! （矩阵行）与风险级（D11 §6 步骤 1 的 risk 展示字段）；`run_command` 的实际
//! 类别依赖 args（白名单/任意/高危），注册表中登记为展示用的默认档。
//!
//! 未注册工具在管线第 1 步被拒（8002，D11 §6 伪码"未注册 → 拒绝 8002"）。

use std::collections::BTreeMap;

use bbrt_aigw::ToolSpec;
use bbrt_sec::gate::ActionCategory;

/// 风险级（09 §3.1 工具目录三档；展示与审批卡样式用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskLevel {
    /// 低危：只读/记忆类
    Low,
    /// 中危：文件编辑/网络出站
    Medium,
    /// 高危：任意命令/git push
    High,
}

impl RiskLevel {
    /// 展示名（审批卡与 tool.call 事件的 risk 字段）
    pub fn as_str(self) -> &'static str {
        match self {
            RiskLevel::Low => "low",
            RiskLevel::Medium => "medium",
            RiskLevel::High => "high",
        }
    }
}

/// 一条工具定义（注册表条目）
#[derive(Debug, Clone)]
pub struct ToolDef {
    /// 工具名（registry 注册名，如 run_command / memory_save）
    pub name: String,
    /// 工具描述（注入模型 tools 列表）
    pub description: String,
    /// 输入 JSON Schema（注入模型 tools 列表）
    pub input_schema: serde_json::Value,
    /// 风险级（D11 §6 步骤 1）
    pub risk: RiskLevel,
    /// 动作类别（D13-A2 矩阵行；run_command 为 args 依赖的展示默认档）
    pub category: ActionCategory,
}

/// 工具注册表：注册/查询/specs 导出（BTreeMap 保持名称字典序稳定）
#[derive(Debug, Clone, Default)]
pub struct ToolRegistry {
    defs: BTreeMap<String, ToolDef>,
}

impl ToolRegistry {
    /// 空注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 内置工具全集（D11 §2.4 builtin/ 清单：fs/search/cmd/git/http/memory）
    pub fn builtin() -> Self {
        let mut reg = Self::new();
        crate::builtin::register_all(&mut reg);
        reg
    }

    /// 注册（同名覆盖）。返回被覆盖的旧定义（首次注册返回 None）。
    pub fn register(&mut self, def: ToolDef) -> Option<ToolDef> {
        self.defs.insert(def.name.clone(), def)
    }

    /// 按名查询
    pub fn get(&self, name: &str) -> Option<&ToolDef> {
        self.defs.get(name)
    }

    /// 风险级查询（D11 §6 步骤 1：risk = registry.risk(tool)）
    pub fn risk(&self, name: &str) -> Option<RiskLevel> {
        self.defs.get(name).map(|d| d.risk)
    }

    /// 导出模型 tools 列表（assemble 注入用；名称字典序）
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.defs
            .values()
            .map(|d| ToolSpec {
                name: d.name.clone(),
                description: d.description.clone(),
                input_schema: d.input_schema.clone(),
            })
            .collect()
    }

    /// 全部工具名（字典序；测试/诊断）
    pub fn names(&self) -> Vec<&str> {
        self.defs.keys().map(|k| k.as_str()).collect()
    }

    /// 条目数
    pub fn len(&self) -> usize {
        self.defs.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.defs.is_empty()
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(name: &str) -> ToolDef {
        ToolDef {
            name: name.to_string(),
            description: format!("{name} 描述"),
            input_schema: json!({"type": "object"}),
            risk: RiskLevel::Low,
            category: ActionCategory::ReadOnly,
        }
    }

    #[test]
    fn 注册_查询_同名覆盖() {
        let mut reg = ToolRegistry::new();
        assert!(reg.is_empty());
        assert!(reg.register(def("x")).is_none());
        assert!(reg.register(def("y")).is_none());
        assert_eq!(reg.len(), 2);
        assert_eq!(reg.get("x").unwrap().risk, RiskLevel::Low);
        // 覆盖注册返回旧定义
        let old = reg.register(def("x")).unwrap();
        assert_eq!(old.name, "x");
        assert_eq!(reg.len(), 2);
        assert_eq!(reg.names(), vec!["x", "y"]);
    }

    #[test]
    fn specs_按名导出_toolspec形态() {
        let reg = ToolRegistry::builtin();
        let specs = reg.specs();
        // 内置 11 个工具（fs4 + search1 + cmd1 + git4 + http1 + memory1）……实际按清单断言
        assert_eq!(specs.len(), reg.len());
        assert!(specs.iter().any(|s| s.name == "run_command"));
        let rc = specs.iter().find(|s| s.name == "run_command").unwrap();
        assert!(rc.input_schema.get("properties").is_some());
        // 字典序稳定
        let mut names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        names.dedup();
        assert_eq!(names.len(), specs.len());
    }

    #[test]
    fn 内置清单_风险级与类别映射() {
        let reg = ToolRegistry::builtin();
        // D13-A2 行 1：只读
        for name in ["read_file", "list_dir", "glob_files", "grep_files"] {
            let d = reg.get(name).unwrap_or_else(|| panic!("{name} 未注册"));
            assert_eq!(d.category, ActionCategory::ReadOnly, "{name}");
            assert_eq!(d.risk, RiskLevel::Low, "{name}");
        }
        // 行 2：文件编辑
        for name in ["write_file", "edit_file", "memory_forget"] {
            let d = reg.get(name).unwrap();
            assert_eq!(d.category, ActionCategory::FileEdit, "{name}");
        }
        // 行 4：任意命令（args 依赖的展示默认档）/ 行 6 网络出站 / 行 8 git push
        assert_eq!(
            reg.get("run_command").unwrap().category,
            ActionCategory::ArbitraryCommand
        );
        assert_eq!(
            reg.get("http_fetch").unwrap().category,
            ActionCategory::NetworkEgress
        );
        // git 四件 2026-11-27 整域退役：push 门禁语义由 shell 命令层表达
        //（run_command git push 跟档、force 进危险规则库；外名防御在 gate.static_category）
        // 记忆写入：低风险（gate 未知工具兜底任意命令档，见 pipeline 注释）
        assert_eq!(reg.get("memory_save").unwrap().risk, RiskLevel::Low);
        // 未注册
        assert!(reg.get("nope").is_none());
        assert!(reg.risk("nope").is_none());
    }
}
