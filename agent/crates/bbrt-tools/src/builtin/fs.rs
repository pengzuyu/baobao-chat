//! 文件工具：read_file / list_dir / write_file / edit_file（D11 §2.4 builtin/fs.rs）。
//!
//! - read_file：`context::excerpt` 摘录（默认 400 行/32KB 先到为准、行号前缀、
//!   offset 分页续读）+ 敏感拒读 8026（bbrt-context 名单与 bbrt-sec PathPolicy
//!   双检，后者带软链改名防御）；
//! - write_file/edit_file：工作区白名单外 8020 / 软链逃逸 8024（PathPolicy.validate
//!   Write 意图）；修改前先发 journal 字符串事件回调（file.changed，喂被动轨）。
//!
//! v0.1 收紧口径：读操作也限制在工作区 ∪ 例外可写目录内（B10 为"全盘可读+敏感
//! 拒读"，此处取更严一档——agent 工作场景以工作区为主，宁可多拦）。

use std::fs;
use std::path::{Path, PathBuf};

use bbrt_context::excerpt::{excerpt, is_sensitive_path};
use bbrt_sec::errors::{CODE_SANDBOX_DENIED, CODE_SENSITIVE_READ};
use bbrt_sec::sandbox::launcher::ViolationKind;
use bbrt_sec::sandbox::path::{PathError, PathIntent};
use serde_json::json;

use super::{deny, resolve_against, str_arg, timed, usize_arg, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 单个工具参数错误统一 8002（工具未授权/不可执行族；14 篇 8xxx 表）
const CODE_TOOL_ARGS: u32 = 8002;

/// 目录列表条数上限（超出截断标注）
const LIST_DIR_MAX: usize = 500;

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

/// read_file 实现：敏感拒读（8026）→ 读边界（8020，v0.1 收紧）→ 摘录
pub(crate) fn read_file(env: &ExecEnv, args: &serde_json::Value) -> Result<ExecOutput, ToolBlock> {
    let path =
        str_arg(args, "path").ok_or_else(|| deny(CODE_TOOL_ARGS, "read_file 缺少 path 参数"))?;
    let offset = usize_arg(args, "offset").unwrap_or(0);
    let limit = usize_arg(args, "limit").unwrap_or(0);

    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        // 8026 双检之一：context 名单（D11 §5.3）
        if is_sensitive_path(&path) {
            env.record_violation(
                ViolationKind::Rule,
                CODE_SENSITIVE_READ,
                format!("read_file 命中默认拒读清单: {path}"),
            );
            return Err(deny(
                CODE_SENSITIVE_READ,
                format!("敏感文件拒读（8026）: {path} 命中默认拒读清单"),
            ));
        }
        // 8026 双检之二：sec PathPolicy（软链改名绕过防御，09 §7.2）；
        // 相对路径以工作区根为基准（不随进程 cwd 漂移）
        let path_buf = resolve_against(&env.workspace, &path);
        let resolved = match env.path_policy.validate(&path_buf, PathIntent::Read) {
            Ok(p) => p,
            Err(PathError::SensitiveRead { code, pattern, .. }) => {
                env.record_violation(
                    ViolationKind::Rule,
                    code,
                    format!("read_file 命中拒读清单 {pattern}: {path}"),
                );
                return Err(deny(
                    code,
                    format!("敏感文件拒读（8026）: {path} 命中 {pattern}"),
                ));
            }
            Err(e) => return Err(deny(CODE_SANDBOX_DENIED, e.to_string())),
        };
        // v0.1 收紧：读限制在工作区 ∪ 例外目录（越界 8020）
        ensure_inside_roots(env, &resolved, "read_file")?;
        let content = fs::read_to_string(&resolved).map_err(|e| {
            deny(
                CODE_TOOL_ARGS,
                format!("读取失败 {path}: {e}（文件不存在或非 UTF-8 文本）"),
            )
        })?;
        // 摘录（D11 §5.3：默认 400 行/32KB 先到为准，行号前缀，offset 分页）
        let ex = excerpt(&content, offset, limit);
        Ok(ExecOutput {
            summary: ex.body,
            truncated: ex.truncated,
            exit_code: None,
            duration_ms: 0,
        })
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

/// list_dir 实现：读边界校验后列目录（d/f 前缀，≤500 条截断标注）
pub(crate) fn list_dir(env: &ExecEnv, args: &serde_json::Value) -> Result<ExecOutput, ToolBlock> {
    let path =
        str_arg(args, "path").ok_or_else(|| deny(CODE_TOOL_ARGS, "list_dir 缺少 path 参数"))?;
    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let path_buf = resolve_against(&env.workspace, &path);
        let resolved = match env.path_policy.validate(&path_buf, PathIntent::Read) {
            Ok(p) => p,
            Err(PathError::SensitiveRead { code, pattern, .. }) => {
                return Err(deny(
                    code,
                    format!("敏感路径拒访问（8026）: {path} 命中 {pattern}"),
                ))
            }
            Err(e) => return Err(deny(CODE_SANDBOX_DENIED, e.to_string())),
        };
        ensure_inside_roots(env, &resolved, "list_dir")?;
        let entries = fs::read_dir(&resolved)
            .map_err(|e| deny(CODE_TOOL_ARGS, format!("列目录失败 {path}: {e}")))?;
        let mut lines: Vec<String> = Vec::new();
        let mut truncated = false;
        for entry in entries.flatten() {
            if lines.len() >= LIST_DIR_MAX {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let prefix = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                "d"
            } else {
                "f"
            };
            lines.push(format!("{prefix} {name}"));
        }
        lines.sort();
        let mut summary = lines.join("\n");
        if truncated {
            summary.push_str(&format!("\n[truncated, showing {LIST_DIR_MAX}]"));
        }
        Ok(ExecOutput {
            summary,
            truncated,
            exit_code: None,
            duration_ms: 0,
        })
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

// ---------------------------------------------------------------------------
// write_file / edit_file
// ---------------------------------------------------------------------------

/// write_file 实现：Write 意图校验（8020/8024）→ journal 事件 → 落盘
pub(crate) fn write_file(env: &ExecEnv, args: &serde_json::Value) -> Result<ExecOutput, ToolBlock> {
    let path =
        str_arg(args, "path").ok_or_else(|| deny(CODE_TOOL_ARGS, "write_file 缺少 path 参数"))?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "write_file 缺少 content 参数"))?;

    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let resolved = validate_write(env, &path)?;
        emit_file_changed(env, "write_file", &resolved, content.len());
        // 父目录随路径创建（路径已通过白名单校验，父目录必在工作区内）
        if let Some(parent) = resolved.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&resolved, &content)
            .map_err(|e| deny(CODE_SANDBOX_DENIED, format!("写入失败 {path}: {e}")))?;
        Ok(ExecOutput {
            summary: format!("已写入 {}（{} 字节）", resolved.display(), content.len()),
            truncated: false,
            exit_code: None,
            duration_ms: 0,
        })
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

/// edit_file 实现：精确替换 old→new（all=true 全量；默认首处）；未命中 8002
pub(crate) fn edit_file(env: &ExecEnv, args: &serde_json::Value) -> Result<ExecOutput, ToolBlock> {
    let path =
        str_arg(args, "path").ok_or_else(|| deny(CODE_TOOL_ARGS, "edit_file 缺少 path 参数"))?;
    let old = args
        .get("old")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "edit_file 缺少 old 参数"))?;
    let new = args
        .get("new")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "edit_file 缺少 new 参数"))?;
    let replace_all = args.get("all").and_then(|v| v.as_bool()).unwrap_or(false);

    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let resolved = validate_write(env, &path)?;
        let content = fs::read_to_string(&resolved)
            .map_err(|e| deny(CODE_TOOL_ARGS, format!("读取失败 {path}: {e}")))?;
        if !content.contains(&old) {
            return Err(deny(
                CODE_TOOL_ARGS,
                format!("old_string 未在 {path} 中命中，未做任何修改"),
            ));
        }
        let (updated, count) = if replace_all {
            (content.replace(&old, &new), content.matches(&old).count())
        } else {
            // 首处替换
            let mut out = String::with_capacity(content.len() + new.len());
            match content.find(&old) {
                Some(i) => {
                    out.push_str(&content[..i]);
                    out.push_str(&new);
                    out.push_str(&content[i + old.len()..]);
                    (out, 1)
                }
                None => unreachable!("contains 已确认命中"),
            }
        };
        emit_file_changed(env, "edit_file", &resolved, updated.len());
        fs::write(&resolved, &updated)
            .map_err(|e| deny(CODE_SANDBOX_DENIED, format!("写回失败 {path}: {e}")))?;
        Ok(ExecOutput {
            summary: format!("已替换 {count} 处：{}", resolved.display()),
            truncated: false,
            exit_code: None,
            duration_ms: 0,
        })
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

// ---------------------------------------------------------------------------
// 公共辅助
// ---------------------------------------------------------------------------

/// 写意图校验：PathPolicy.validate(Write) → 8020/8024 + violation 记录；
/// 相对路径以工作区根为基准解析
fn validate_write(env: &ExecEnv, path: &str) -> Result<PathBuf, ToolBlock> {
    let path_buf = resolve_against(&env.workspace, path);
    match env.path_policy.validate(&path_buf, PathIntent::Write) {
        Ok(resolved) => Ok(resolved),
        Err(e) => {
            let code = path_error_code(&e);
            env.record_violation(ViolationKind::Path, code, format!("写路径越界: {e}"));
            Err(deny(code, e.to_string()))
        }
    }
}

/// 读边界（v0.1 收紧）：解析后路径 ∈ 工作区根 ∪ 例外可写目录，否则 8020
fn ensure_inside_roots(env: &ExecEnv, resolved: &Path, tool: &str) -> Result<(), ToolBlock> {
    let inside = env
        .path_policy
        .workspace_roots
        .iter()
        .chain(env.path_policy.writable_exceptions.iter())
        .any(|r| resolved.starts_with(fs::canonicalize(r).unwrap_or_else(|_| r.clone())));
    if inside {
        Ok(())
    } else {
        env.record_violation(
            ViolationKind::Path,
            CODE_SANDBOX_DENIED,
            format!("{tool} 读路径越界: {}", resolved.display()),
        );
        Err(deny(
            CODE_SANDBOX_DENIED,
            format!(
                "路径越界（8020）: {} 不在工作区白名单内",
                resolved.display()
            ),
        ))
    }
}

/// 修改前 journal 字符串事件（file.changed；bin 侧转 ActivityEvent 喂被动轨）
fn emit_file_changed(env: &ExecEnv, tool: &str, resolved: &Path, bytes: usize) {
    let event = json!({
        "event": "file.changed",
        "tool": tool,
        "path": resolved.display().to_string(),
        "bytes": bytes,
    })
    .to_string();
    env.emit_journal(&event);
}

/// PathError → 错误码
fn path_error_code(e: &PathError) -> u32 {
    match e {
        PathError::OutsideWorkspace { code, .. }
        | PathError::SymlinkEscape { code, .. }
        | PathError::SensitiveRead { code, .. } => *code,
    }
}

// ---------------------------------------------------------------------------
// ToolDef 导出
// ---------------------------------------------------------------------------

/// read_file 工具定义（D13-A2 行 1：只读，全档自动）
pub fn read_file_def() -> ToolDef {
    ToolDef {
        name: "read_file".into(),
        description: "Read a text file in the workspace: returns a numbered excerpt (default 400 lines \
                      or 32KB, whichever comes first); when truncated, continue paging with \
                      offset/limit; sensitive files (.env/secrets) are denied by default"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path (inside the workspace)"},
                "offset": {"type": "integer", "description": "Starting line (1-based, default 1)"},
                "limit": {"type": "integer", "description": "Number of lines to read (default 400)"}
            },
            "required": ["path"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// list_dir 工具定义（只读）
pub fn list_dir_def() -> ToolDef {
    ToolDef {
        name: "list_dir".into(),
        description: "List directory contents (d/f prefixes mark types; at most 500 entries, truncated with a marker beyond that)".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path (inside the workspace; defaults to the workspace root)"}
            },
            "required": ["path"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// write_file 工具定义（D13-A2 行 2：ask 逐次确认，auto-edit+ 自动）
pub fn write_file_def() -> ToolDef {
    ToolDef {
        name: "write_file".into(),
        description: "Write a file (full-file overwrite; writable only inside the workspace allowlist; a change event is recorded before modifying)".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Target path (inside the workspace)"},
                "content": {"type": "string", "description": "Full file content"}
            },
            "required": ["path", "content"]
        }),
        risk: RiskLevel::Medium,
        category: bbrt_sec::gate::ActionCategory::FileEdit,
    }
}

/// edit_file 工具定义（文件编辑；old/new 精确替换）
pub fn edit_file_def() -> ToolDef {
    ToolDef {
        name: "edit_file".into(),
        description: "Edit a file: exact replacement of old with new (first occurrence by default; all=true replaces every occurrence)".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Target file (inside the workspace)"},
                "old": {"type": "string", "description": "Text to be replaced (non-empty)"},
                "new": {"type": "string", "description": "Replacement text"},
                "all": {"type": "boolean", "description": "true = replace every occurrence (default: first occurrence only)"}
            },
            "required": ["path", "old", "new"]
        }),
        risk: RiskLevel::Medium,
        category: bbrt_sec::gate::ActionCategory::FileEdit,
    }
}
