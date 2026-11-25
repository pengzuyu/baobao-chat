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
    /// 用户拒绝/审批超时（2026-11-25 拍板）：流程控制结果而非执行失败——
    /// 不进 W2② 错误教训连击、不计 tool_failures；事件/WAL/历史与 Blocked
    /// 同形（ToolResult ok=false + blocked_code 照发，前端零改动）
    Rejected {
        code: u32,
        summary: String,
    },
}

/// 工具执行器：bbrt-tools 的 ToolRegistry 实现本 trait
/// execute_or_handoff 结果：完成 / 仍在运行（句柄移交转后台）
pub enum CommandHandoff {
    Done(ToolOutcome),
    StillRunning(bbrt_sec::sandbox::DetachedCommand),
}

pub trait ToolExecutor: Send + Sync {
    /// 门控判定（不执行、不发审批；mode 来自会话当前档位）
    fn check(&self, mode: PermissionMode, call: &ToolInvocation) -> CheckOutcome;
    /// 逐调用风险级（tool.call / permission.request 事件的 risk 字段）。
    /// P0 显示层对齐：真实执行器按 gate 分类逐调用判定（bbrt-sec
    /// ActionCategory::risk_level），旧「按工具名静态表」（run_command 一律
    /// 高危、git_status 标中危）退役。default=旧静态表口径（测试桩/非管线
    /// 实现方兜底，行为与退役前一致）。
    fn risk_of_call(&self, call: &ToolInvocation) -> &'static str {
        match call.name.as_str() {
            "read_file" | "list_dir" | "search_files" | "glob" => "low",
            "write_file" | "edit_file" | "git_status" | "git_diff" => "medium",
            _ => "high",
        }
    }
    /// 执行（调用方已保证权限路径走通）
    fn execute(&self, mode: PermissionMode, call: &ToolInvocation) -> ToolOutcome;
    /// 后台 spawn run_command（统一后台任务体系 2026-11-18）：校验/spec 组装
    /// 与同步路径同口径（cwd 白名单/词法预检），spawn 后立即返回句柄——
    /// 收割/取消/落库由 session 侧管理。default=执行器不支持后台命令。
    fn spawn_background(
        &self,
        _call: &ToolInvocation,
    ) -> Result<bbrt_sec::sandbox::DetachedCommand, String> {
        Err("执行器不支持后台命令".into())
    }
    /// hybrid 执行（同步超时自动转后台，2026-11-18 对齐 Claude Code）：
    /// 同步等待至多 wait_secs——完成返回 Done（结果）；未完**不杀**返回
    /// StillRunning（进程句柄移交调用方转后台收割）。default=同步 execute
    /// 回落（不支持转后台的执行器维持旧语义）。
    fn execute_or_handoff(
        &self,
        mode: PermissionMode,
        call: &ToolInvocation,
        _wait_secs: u64,
    ) -> CommandHandoff {
        CommandHandoff::Done(self.execute(mode, call))
    }
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
