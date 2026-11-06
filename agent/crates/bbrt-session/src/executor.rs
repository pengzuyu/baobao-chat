//! 工具执行契约（依赖倒置：session 定义、bbrt-tools 实现）。
//! 对齐 D11 §6 工具执行管线的三段：检查（门控）→ 执行 → 结果；
//! 权限审批的等待/120s 超时由 loop_runner 承担，本 trait 只承担单步判定与执行。

use bbrt_sec::gate::PermissionMode;
use bbrt_sec::memory::GrantScope;
use serde::{Deserialize, Serialize};

/// 一次工具调用（args 为模型产出的 JSON 字符串）
#[derive(Debug, Clone)]
pub struct ToolInvocation {
    pub call_id: String,
    pub name: String,
    pub args_json: String,
    /// 触发会话（审计/journal 关联）
    pub session_id: String,
}

/// 审批卡预览（D11 §4 permission.request.preview）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPreview {
    /// command | diff | none
    pub kind: String,
    /// 命令文本（可编辑回传）或差异摘要
    pub content: String,
}

/// 门控检查结论（管线第 0-4 步浓缩）
#[derive(Debug, Clone)]
pub enum CheckOutcome {
    /// 直接放行（只读/矩阵命中/记忆命中；source 入审计）
    Allow { source: String },
    /// 需用户确认（含理由与预览）
    NeedConfirm {
        reason: String,
        preview: ToolPreview,
        options: Vec<String>,
    },
    /// 直接拒绝（策略/权限点/危险命令不可放行类）
    Deny { code: u32, message: String },
}

/// 执行结果（管线第 6-8 步浓缩；脱敏在实现侧完成）
#[derive(Debug, Clone)]
pub enum ToolOutcome {
    Ok {
        summary: String,
        truncated: bool,
        exit_code: Option<i32>,
        duration_ms: u64,
    },
    Blocked {
        code: u32,
        summary: String,
    },
}

/// 工具执行器：bbrt-tools 的 ToolRegistry 实现本 trait
pub trait ToolExecutor: Send + Sync {
    /// 门控判定（不执行、不发审批；mode 来自会话当前档位）
    fn check(&self, mode: PermissionMode, call: &ToolInvocation) -> CheckOutcome;
    /// 执行（调用方已保证权限路径走通）
    fn execute(&self, mode: PermissionMode, call: &ToolInvocation) -> ToolOutcome;
    /// 审批通过后落记忆（once/session/permanent）
    fn record_grant(
        &self,
        mode: PermissionMode,
        call: &ToolInvocation,
        scope: GrantScope,
    ) -> Result<(), String>;
    /// 工具清单（assemble 时注入模型 tools 参数）
    fn tool_specs(&self) -> Vec<bbrt_aigw::ToolSpec>;
}
