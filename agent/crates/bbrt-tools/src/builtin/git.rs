//! git 工具：git_status / git_diff（经沙箱跑 git 命令）；
//! git_commit / git_push 注册但 v0.1 拒绝（8028 语义：钥匙串/凭据未接，D11 §2.4）。
//!
//! 只读两工具在 workspace 下经 SandboxLauncher 执行真实 git（只读类矩阵全档 ✅，
//! 但执行仍走沙箱——门控放行≠脱离沙箱，D13-B9 分层）；提交/推送涉及凭据
//! （钥匙串 OBO、远端凭据），v0.1 未接 hostapi 钥匙串，统一 8028 拒绝。

use serde_json::{json, Value};

use super::cmd::{base_run_opts, resolve_program, run_with_launcher};
use super::{deny, str_arg, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 钥匙串未接拒绝码（09 §6.4：8028 钥匙串访问被拒绝/超时）
const CODE_KEYCHAIN: u32 = 8028;

/// git 超时收紧（只读操作不应长跑）
const GIT_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// 只读：git_status / git_diff
// ---------------------------------------------------------------------------

/// git_status 实现：`git status --porcelain=v1 --branch`（沙箱内执行）
pub(crate) fn git_status(env: &ExecEnv, _args: &Value) -> Result<ExecOutput, ToolBlock> {
    run_git(env, &["status", "--porcelain=v1", "--branch"])
}

/// git_diff 实现：`git diff --stat` + `git diff`（工作区与暂存差异；沙箱内执行）
pub(crate) fn git_diff(env: &ExecEnv, args: &Value) -> Result<ExecOutput, ToolBlock> {
    // path 限定可选（默认整个工作区）
    let scope = str_arg(args, "path");
    let mut summary = String::new();
    let stat_args = build_git_args(&["diff", "--stat"], scope.as_deref());
    let out = run_git(env, &stat_args)?;
    summary.push_str(&out.summary);
    if !summary.is_empty() {
        summary.push('\n');
    }
    let full_args = build_git_args(&["diff"], scope.as_deref());
    let full = run_git(env, &full_args)?;
    summary.push_str(&full.summary);
    Ok(ExecOutput {
        summary,
        truncated: out.truncated || full.truncated,
        exit_code: full.exit_code,
        duration_ms: out.duration_ms + full.duration_ms,
    })
}

/// 组装 git 子命令（可带 path 限定）
fn build_git_args(sub: &[&str], scope: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = sub.iter().map(|s| s.to_string()).collect();
    if let Some(p) = scope {
        args.push("--".into());
        args.push(p.to_string());
    }
    args
}

/// 在工作区经沙箱执行 git 子命令
fn run_git(env: &ExecEnv, args: &[impl AsRef<str>]) -> Result<ExecOutput, ToolBlock> {
    let args: Vec<String> = args.iter().map(|s| s.as_ref().to_string()).collect();
    let spec = bbrt_sec::sandbox::launcher::RunSpec {
        program: resolve_program("git"),
        args,
        cwd: Some(env.workspace.clone()),
        env: Vec::new(),
    };
    let mut opts = base_run_opts(env);
    opts.timeout_secs = GIT_TIMEOUT_SECS;
    run_with_launcher(env, spec, opts)
}

// ---------------------------------------------------------------------------
// v0.1 拒绝：git_commit / git_push
// ---------------------------------------------------------------------------

/// git_commit 实现：v0.1 未接钥匙串（提交需 user.name/email 与凭据），8028 拒绝
pub(crate) fn git_commit(_env: &ExecEnv, _args: &Value) -> Result<ExecOutput, ToolBlock> {
    Err(deny(
        CODE_KEYCHAIN,
        "git_commit 暂不可用（8028）：v0.1 未接入钥匙串/提交凭据（D11 §2.4 排期）",
    ))
}

/// git_push 实现：v0.1 未接钥匙串（push 需远端凭据），8028 拒绝
pub(crate) fn git_push(_env: &ExecEnv, _args: &Value) -> Result<ExecOutput, ToolBlock> {
    Err(deny(
        CODE_KEYCHAIN,
        "git_push 暂不可用（8028）：v0.1 未接入钥匙串/远端凭据（D11 §2.4 排期）",
    ))
}

// ---------------------------------------------------------------------------
// ToolDef 导出
// ---------------------------------------------------------------------------

/// git_status 工具定义（D13-A2 行 1：只读，全档自动）
pub fn git_status_def() -> ToolDef {
    ToolDef {
        name: "git_status".into(),
        description: "查看工作区 git 状态（porcelain v1 + 分支头；沙箱内执行）".into(),
        input_schema: json!({"type": "object", "properties": {}}),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// git_diff 工具定义（只读）
pub fn git_diff_def() -> ToolDef {
    ToolDef {
        name: "git_diff".into(),
        description: "查看工作区 git 差异（--stat 摘要 + 全量 diff；可传 path 限定范围）".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "限定差异范围的路径（可选）"}
            }
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// git_commit 工具定义（D13-A2 行 2：文件编辑档；v0.1 执行层拒绝 8028）
pub fn git_commit_def() -> ToolDef {
    ToolDef {
        name: "git_commit".into(),
        description: "提交暂存区（v0.1 未接钥匙串，暂返回 8028 不可用）".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "提交信息"}
            },
            "required": ["message"]
        }),
        risk: RiskLevel::Medium,
        category: bbrt_sec::gate::ActionCategory::FileEdit,
    }
}

/// git_push 工具定义（D13-A2 行 8：永不全自动；v0.1 执行层拒绝 8028）
pub fn git_push_def() -> ToolDef {
    ToolDef {
        name: "git_push".into(),
        description: "推送远端（v0.1 未接钥匙串，暂返回 8028 不可用）".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "remote": {"type": "string", "description": "远端名（默认 origin）"},
                "branch": {"type": "string", "description": "分支（默认当前分支）"}
            }
        }),
        risk: RiskLevel::High,
        category: bbrt_sec::gate::ActionCategory::GitPush,
    }
}

// ---------------------------------------------------------------------------
// 单元测试：v0.1 拒绝语义（纯逻辑；沙箱真实执行在 tests/ 集成层）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> ExecEnv {
        use std::sync::Arc;
        ExecEnv {
            workspace: std::env::temp_dir(),
            path_policy: bbrt_sec::sandbox::path::PathPolicy::new(),
            net_policy: bbrt_sec::sandbox::network::NetPolicy::new(),
            launcher: bbrt_sec::sandbox::launcher::SandboxLauncher::new(),
            memory: None,
            journal_hook: None,
            sink: Arc::new(bbrt_sec::sandbox::launcher::MemoryViolationSink::new()),
        }
    }

    #[test]
    fn git_commit_与_git_push_v01_拒绝_8028() {
        let e = env();
        for out in [
            git_commit(&e, &json!({"message": "x"})),
            git_push(&e, &json!({})),
        ] {
            match out {
                Err(ToolBlock { code, message }) => {
                    assert_eq!(code, 8028);
                    assert!(message.contains("钥匙串"));
                }
                other => panic!("应 8028 拒绝，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn git_参数组装() {
        assert_eq!(build_git_args(&["diff"], None), vec!["diff".to_string()]);
        assert_eq!(
            build_git_args(&["diff", "--stat"], Some("src")),
            vec![
                "diff".to_string(),
                "--stat".to_string(),
                "--".to_string(),
                "src".to_string()
            ]
        );
    }
}
