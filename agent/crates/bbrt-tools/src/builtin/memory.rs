//! memory_save 工具（D11 §2.4 builtin/memory.rs；D15 §2 主动轨 W1 模型写入路径；
//! D23 §3.6 十类直通路由）。
//!
//! 直通 `bbrt_memory::MemoryEngine`：
//! - type=十类（画像/偏好/风格/习惯/禁止/授权/人际/术语/目标/教训）→ **公共层**
//!   journal+USER.md（单条 ≤80 字、密钥特征拒写、同题去重、目标过期自清）；
//! - type=user/project/feedback/reference → 知识记忆（项目分区/回落公共层，
//!   引擎内路由——user 恒公共层画像、日常会话三类回落，D23 落地修订 A）；
//! - journal 落 `memory.saved` 事件由 MemoryEngine 自记（被动轨同源）；
//! - 注册为低风险（知识写入经脱敏约束）。

use bbrt_memory::{GlobalType, MemoryType, SaveInput};
use serde_json::{json, Value};

use super::{deny, str_arg, timed, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 工具参数/装配错误码（14 篇：8002）
const CODE_TOOL_ARGS: u32 = 8002;

/// memory_save 实现：type 十类直通公共层；四类走引擎分级路由。
pub(crate) fn save(
    env: &ExecEnv,
    args: &Value,
    session_id: &str,
    ws: Option<&std::path::Path>,
) -> Result<ExecOutput, ToolBlock> {
    let title = str_arg(args, "title")
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "memory_save 缺少 title 参数"))?;
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let type_str = str_arg(args, "type").unwrap_or_else(|| "user".to_string());
    let links = args
        .get("links")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let engine = env.memory.as_ref().ok_or_else(|| {
            deny(
                CODE_TOOL_ARGS,
                "memory_save 不可用（8002）：MemoryEngine 未装配",
            )
        })?;
        // D23 §3.6：十类 → 公共层直通（title(+body 首行) 拼单条文本）
        if let Some(gtype) = GlobalType::parse(&type_str) {
            let text = bbrt_memory::global_line(&title, &body);
            return match engine.save_global(gtype, &text, session_id) {
                Ok(outcome) => {
                    let verb = if outcome.saved.updated {
                        "更新"
                    } else {
                        "写入"
                    };
                    let budget = engine.global().budget_left();
                    let budget_label = if budget < 0 {
                        "（USER.md 超限待压实）".to_string()
                    } else {
                        format!("（USER.md 余量 {budget} 字）")
                    };
                    Ok(ExecOutput {
                        summary: format!(
                            "公共记忆已{verb}：[{type_str}] {}{budget_label}",
                            outcome.saved.title
                        ),
                        truncated: false,
                        exit_code: None,
                        duration_ms: 0,
                    })
                }
                Err(e) => Err(deny(CODE_TOOL_ARGS, format!("公共记忆写入被拒：{e}"))),
            };
        }
        let mtype = MemoryType::parse(&type_str).ok_or_else(|| {
            deny(
                CODE_TOOL_ARGS,
                format!(
                    "type 必须是 画像/偏好/风格/习惯/禁止/授权/人际/术语/目标/教训（公共层）\
                     或 user/project/feedback/reference（项目知识），收到 {type_str}"
                ),
            )
        })?;
        // D37：项目进度台账唯一写入方=W3 会话结束合并——手工写入拒绝
        // （防绕过 status.rs 的加法合并/去重/拒识护栏整篇覆盖台账）
        if mtype == MemoryType::Status {
            return Err(deny(
                CODE_TOOL_ARGS,
                "type=status 是项目进度台账（每次会话结束自动更新），不支持手工写入",
            ));
        }
        let input = SaveInput {
            title,
            mtype,
            body,
            session: session_id.to_string(),
            links,
        };
        // 引擎内 D23 路由：user 恒公共层；项目会话三类落分区；日常三类回落公共层
        match engine.save_memory_scoped(ws, &input) {
            Ok(outcome) => {
                let verb = if outcome.saved.updated {
                    "更新"
                } else {
                    "写入"
                };
                let scope_label = if outcome.saved.scope == "project" {
                    format!(
                        "，项目分区={}",
                        outcome.saved.workspace_name.unwrap_or_default()
                    )
                } else if let Some(g) = &outcome.saved.global_type {
                    format!("，公共层[{g}]")
                } else {
                    String::new()
                };
                Ok(ExecOutput {
                    summary: format!(
                        "记忆已{verb}：{}（name={}，type={}{}）",
                        outcome.saved.title, outcome.saved.name, type_str, scope_label
                    ),
                    truncated: false,
                    exit_code: None,
                    duration_ms: 0,
                })
            }
            // 含 D15 §4 脱敏拒写（SensitiveContent）与公共层 80 字上限等
            Err(e) => Err(deny(CODE_TOOL_ARGS, format!("记忆写入被拒：{e}"))),
        }
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

/// memory_save 工具定义（D23：双枚举——公共层十类+项目知识四类；
/// 采集话术即写入门禁，随描述下发）
pub fn memory_save_def() -> ToolDef {
    ToolDef {
        name: "memory_save".into(),
        description: "Save a long-term memory. Ask yourself before writing: does it still hold \
                      in a different project? Will it still hold tomorrow? Either no → do not \
                      write to the global layer (write project knowledge instead, or skip). \
                      Global layer (user-wide USER.md, ≤3000 chars) — pass the enum value \
                      verbatim: 画像=stable facts about who the user is / 偏好=content & \
                      process choices / 风格=presentation form / 习惯=periodic behavior / \
                      禁止=hard prohibition (lifted only explicitly) / 授权=standing \
                      permission / 人际=collaboration facts about a specific person / 术语=\
                      private vocabulary / 目标=phase-scoped direction (auto-expires past \
                      its deadline) / 教训=generalized failure patterns. Project knowledge \
                      (project sessions): project=project facts / feedback=lessons / \
                      reference=external pointers (one fact per file + MEMORY.md index, \
                      same-topic writes update in place; casual sessions fall back to the \
                      global layer automatically). Keep each item to one crisp line."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "One-line title (global layer: the item's main sentence; ≤40 chars)"},
                "type": {"type": "string",
                         "enum": ["画像", "偏好", "风格", "习惯", "禁止", "授权",
                                  "人际", "术语", "目标", "教训",
                                  "user", "project", "feedback", "reference"],
                         "description": "Pick the value verbatim from the enum. Ten Chinese types → global USER.md (≤80 chars per item); four English types → project knowledge / fallback (default user)"},
                "body": {"type": "string", "description": "Supplementary body (global layer: first line merges into the single line; knowledge memories ≤4KB)"},
                "links": {"type": "array", "items": {"type": "string"},
                          "description": "Related memory slugs (project knowledge only; optional)"}
            },
            "required": ["title", "body"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::FileEdit,
    }
}

/// memory_forget 实现（D23 §3.5 更正第一步）：公共层条目 tombstone+重投影。
pub(crate) fn forget(
    env: &ExecEnv,
    args: &Value,
    session_id: &str,
) -> Result<ExecOutput, ToolBlock> {
    let type_str = str_arg(args, "type")
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "memory_forget 缺少 type 参数"))?;
    let contains = str_arg(args, "contains")
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "memory_forget 缺少 contains 参数"))?;
    let gtype = GlobalType::parse(&type_str).ok_or_else(|| {
        deny(
            CODE_TOOL_ARGS,
            format!("type 必须是十类公共层类型（画像/偏好/风格/习惯/禁止/授权/人际/术语/目标/教训），收到 {type_str}"),
        )
    })?;
    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let engine = env.memory.as_ref().ok_or_else(|| {
            deny(
                CODE_TOOL_ARGS,
                "memory_forget 不可用（8002）：MemoryEngine 未装配",
            )
        })?;
        match engine.forget_global(gtype, &contains, session_id) {
            Ok(removed) => {
                let summary = if removed.is_empty() {
                    format!("无匹配条目（[{type_str}] 中不含「{contains}」——可能已移除）")
                } else {
                    let lines: Vec<String> = removed
                        .iter()
                        .map(|t| format!("[{type_str}] {t}"))
                        .collect();
                    format!(
                        "已移除 {} 条：\n{}\n（journal 留审计；误删可用 memory_save 重写）",
                        removed.len(),
                        lines.join("\n")
                    )
                };
                Ok(ExecOutput {
                    summary,
                    truncated: false,
                    exit_code: None,
                    duration_ms: 0,
                })
            }
            Err(e) => Err(deny(CODE_TOOL_ARGS, format!("记忆移除被拒：{e}"))),
        }
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

/// memory_read 实现（D23 §4.2）：项目分区单条正文 + touch last_used。
pub(crate) fn read(
    env: &ExecEnv,
    args: &Value,
    _session_id: &str,
    ws: Option<&std::path::Path>,
) -> Result<ExecOutput, ToolBlock> {
    let name =
        str_arg(args, "name").ok_or_else(|| deny(CODE_TOOL_ARGS, "memory_read 缺少 name 参数"))?;
    let in_project = ws.is_some_and(|w| !w.as_os_str().is_empty());
    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        if !in_project {
            return Err(deny(
                CODE_TOOL_ARGS,
                "日常会话无项目记忆（公共层 USER.md 已全文注入无需读取；项目记忆请切到项目会话）",
            ));
        }
        let engine = env.memory.as_ref().ok_or_else(|| {
            deny(
                CODE_TOOL_ARGS,
                "memory_read 不可用（8002）：MemoryEngine 未装配",
            )
        })?;
        match engine.read_scoped_entry(ws, &name) {
            Some(body) => Ok(ExecOutput {
                summary: body,
                truncated: false,
                exit_code: None,
                duration_ms: 0,
            }),
            None => Err(deny(
                CODE_TOOL_ARGS,
                format!("项目记忆条目不存在：{name}（slug 见注入的项目记忆索引）"),
            )),
        }
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

/// memory_forget 工具定义（更正/解除第一步；随后 memory_save 写新事实完成更正）
pub fn memory_forget_def() -> ToolDef {
    ToolDef {
        name: "memory_forget".into(),
        description: "Remove matching entries from the global memory (USER.md) — step one of the \
                      two-step correction flow: first forget the old fact, then write the new \
                      one with memory_save (e.g. a rename: forget(画像, old-name) + \
                      save(画像, new-name)). Lifting hard constraints (禁止/授权) also goes \
                      through here. Entry-granular matching (same type + substring) prevents \
                      same-name collateral damage; returns the removed list so a wrong \
                      removal can be rewritten immediately."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "type": {"type": "string",
                         "enum": ["画像", "偏好", "风格", "习惯", "禁止", "授权",
                                  "人际", "术语", "目标", "教训"],
                         "description": "Entry type (pick the enum value verbatim)"},
                "contains": {"type": "string", "description": "Match substring (all entries of that type containing it are removed)"}
            },
            "required": ["type", "contains"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::FileEdit,
    }
}

/// memory_read 工具定义（项目记忆正文按需拉取；touch last_used）
pub fn memory_read_def() -> ToolDef {
    ToolDef {
        name: "memory_read".into(),
        description: "Read one project-memory entry body (slugs are listed in the injected \
                      project memory index MEMORY.md; index lines are routing info only — \
                      fetch bodies on demand via this tool). The global USER.md is already \
                      injected in full and needs no reading; casual sessions have no \
                      project memory."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Memory slug (the file-name stem in the index line's parentheses)"}
            },
            "required": ["name"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// subagent.adjust 薄门面（D16 决策⑧：运行中子任务补充指令——探查/专家/
/// 后台命令通用；执行由 session 循环专用路径经 hub 定向下发，execute 不会收到）
pub fn subagent_adjust_def() -> ToolDef {
    ToolDef {
        name: "subagent.adjust".into(),
        description: "Send a follow-up instruction to a running subtask (probe/expert/background \
                      command; run_id is shown on the in-session subtask card or in the run \
                      log) to adjust its direction; takes effect on its next round. Finished \
                      runs cannot be adjusted (just dispatch a new one)"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "description": "Target task id (agent-/terminal- prefixed)"},
                "instruction": {"type": "string", "description": "Follow-up/adjustment instruction (one sentence)"}
            },
            "required": ["run_id", "instruction"]
        }),
        risk: RiskLevel::Medium,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// task.wait 薄门面（统一后台任务体系 2026-11-18：等待任意后台任务终态并取回
/// 结果——子 agent（agent-）/terminal 后台命令（terminal-）；
/// 执行由 session 循环专用路径承接，execute 不会收到）
pub fn task_wait_def() -> ToolDef {
    ToolDef {
        name: "task.wait".into(),
        description: "Wait for a background task to finish and return its result summary — works \
                      for subagents (agent- prefixed ids) and background commands (terminal-). \
                      After starting any background task asynchronously, call this when you \
                      need its output to proceed; finished tasks return immediately; on \
                      timeout it returns 'still running' (call again to keep waiting, or \
                      handle other matters first)"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "description": "目标任务 id（agent-/terminal- 前缀）"},
                "timeout_secs": {"type": "integer", "description": "Max wait in seconds (default 600, cap 3600)"}
            },
            "required": ["run_id"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// subagent.cancel 薄门面（后台任务取消；同上专用路径承接）
pub fn subagent_cancel_def() -> ToolDef {
    ToolDef {
        name: "subagent.cancel".into(),
        description: "Cancel a running background task (subagents/background commands alike; \
                      graceful cancel — partial results already produced are kept)"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "description": "目标任务 id（agent-/terminal- 前缀）"}
            },
            "required": ["run_id"]
        }),
        risk: RiskLevel::Medium,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}
