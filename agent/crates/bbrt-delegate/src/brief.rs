//! TaskBrief 校验/渲染（17 §4 简报格式；D11 §2.6 brief.rs）。
//!
//! 校验：task 非空、workspace 非空且为绝对路径（工作区=委派边界白名单根，17 §5.1，
//! 相对路径无法做边界检查故拒绝）、forbidden 条目不得为空白。
//!
//! 渲染：17 §4 的 YAML 形态文本（claude 经 `-p` 参数、zcode/通用经 stdin 喂给子进程）。
//!
//! forbidden 注入：转成子进程环境变量 `BBC_BRIEF_FORBIDDEN`（JSON 数组字符串），
//! 供受控后端/桩在执行侧自查；同时渲染文本中保留 forbidden 小节（提示模型本身）。

use bbrt_protocol::TaskBrief;
use serde_json::json;

/// forbidden 约束注入子进程的环境变量名（任务书约定）
pub const ENV_FORBIDDEN: &str = "BBC_BRIEF_FORBIDDEN";

/// 简报校验错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BriefError {
    /// task 为空（委派无任务描述无法执行）
    #[error("task 不能为空")]
    EmptyTask,
    /// workspace 为空或相对路径（17 §5.1 委派边界要求绝对路径）
    #[error("workspace 不能为空且必须是绝对路径")]
    InvalidWorkspace,
    /// forbidden 条目为空白（约束无法表达）
    #[error("forbidden 条目不能为空白: {0:?}")]
    BlankForbidden(String),
}

/// 校验简报（launch 前置；不通过则委派不启动）
pub fn validate(brief: &TaskBrief) -> Result<(), BriefError> {
    if brief.task.trim().is_empty() {
        return Err(BriefError::EmptyTask);
    }
    let ws = std::path::Path::new(&brief.workspace);
    if brief.workspace.trim().is_empty() || !ws.is_absolute() {
        return Err(BriefError::InvalidWorkspace);
    }
    for f in &brief.forbidden {
        if f.trim().is_empty() {
            return Err(BriefError::BlankForbidden(f.clone()));
        }
    }
    Ok(())
}

/// 渲染为 17 §4 的 YAML 形态文本（空小节省略；结尾不带换行）
pub fn render(brief: &TaskBrief) -> String {
    let mut out = String::new();
    out.push_str(&format!("task: {}\n", brief.task));
    out.push_str(&format!("workspace: {}", brief.workspace));
    if !brief.constraints.is_empty() {
        out.push_str("\nconstraints:");
        for c in &brief.constraints {
            out.push_str(&format!("\n  - {c}"));
        }
    }
    if !brief.context.is_empty() {
        out.push_str("\ncontext:");
        for item in &brief.context {
            out.push_str(&format!(
                "\n  - 来源: {} → 摘录: {}",
                item.source, item.excerpt
            ));
        }
    }
    if !brief.acceptance.is_empty() {
        out.push_str("\nacceptance:");
        for a in &brief.acceptance {
            out.push_str(&format!("\n  - {a}"));
        }
    }
    if !brief.forbidden.is_empty() {
        out.push_str("\nforbidden:");
        for f in &brief.forbidden {
            out.push_str(&format!("\n  - {f}"));
        }
    }
    out
}

/// forbidden 列表 → 环境变量值（JSON 数组字符串；空表为 `[]`）
pub fn forbidden_env_value(brief: &TaskBrief) -> String {
    json!(brief.forbidden).to_string()
}

/// 构造子进程附加环境变量（v0.1：BBC_BRIEF_FORBIDDEN；后续可扩展 BBC_BRIEF_* 系列）
pub fn child_env(brief: &TaskBrief) -> Vec<(String, String)> {
    vec![(ENV_FORBIDDEN.to_string(), forbidden_env_value(brief))]
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bbrt_protocol::BriefContextItem;

    fn sample() -> TaskBrief {
        TaskBrief {
            task: "在订单服务增加 POST /refunds 退款接口".into(),
            workspace: "/Users/dev/repos/order-svc".into(),
            constraints: vec!["遵循仓库现有分层".into()],
            context: vec![BriefContextItem {
                source: "kb:公司空间/《订单域接口规范v3》".into(),
                excerpt: "错误码/鉴权要求".into(),
            }],
            acceptance: vec!["编译通过（make build）".into()],
            forbidden: vec!["修改 db/migration 目录".into(), "触碰部署脚本".into()],
        }
    }

    #[test]
    fn validate_accepts_sample_and_rejects_bad_briefs() {
        assert!(validate(&sample()).is_ok());

        let mut b = sample();
        b.task = "   ".into();
        assert_eq!(validate(&b), Err(BriefError::EmptyTask));

        let mut b = sample();
        b.workspace = "relative/path".into();
        assert_eq!(validate(&b), Err(BriefError::InvalidWorkspace));

        let mut b = sample();
        b.workspace = String::new();
        assert_eq!(validate(&b), Err(BriefError::InvalidWorkspace));

        let mut b = sample();
        b.forbidden.push("  ".into());
        assert_eq!(validate(&b), Err(BriefError::BlankForbidden("  ".into())));
    }

    #[test]
    fn render_contains_all_sections() {
        let text = render(&sample());
        assert!(text.starts_with("task: 在订单服务增加 POST /refunds 退款接口"));
        assert!(text.contains("workspace: /Users/dev/repos/order-svc"));
        assert!(text.contains("constraints:"));
        assert!(text.contains("  - 遵循仓库现有分层"));
        assert!(text.contains("context:"));
        assert!(text.contains("kb:公司空间/《订单域接口规范v3》"));
        assert!(text.contains("acceptance:"));
        assert!(text.contains("forbidden:"));
        assert!(text.contains("  - 修改 db/migration 目录"));
        // 空小节省略
        let mut b = sample();
        b.constraints.clear();
        let text = render(&b);
        assert!(!text.contains("constraints:"));
    }

    #[test]
    fn forbidden_env_value_is_json_array() {
        let v = forbidden_env_value(&sample());
        let parsed: Vec<String> = serde_json::from_str(&v).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], "修改 db/migration 目录");

        let mut b = sample();
        b.forbidden.clear();
        assert_eq!(forbidden_env_value(&b), "[]");
    }

    #[test]
    fn child_env_carries_forbidden_variable() {
        let envs = child_env(&sample());
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].0, ENV_FORBIDDEN);
        assert!(envs[0].1.contains("db/migration"));
    }
}
