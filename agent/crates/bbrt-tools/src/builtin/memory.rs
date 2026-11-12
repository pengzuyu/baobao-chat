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
            // 含 D15 §4 脱敏拒写（SensitiveContent）与 4KB/80 字上限等
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
        description: "保存长期记忆。写前自问：换个项目还成立吗？明天还成立吗？\
                      任一否→不记公共层（改记项目知识或不记）。公共层（用户全局，\
                      USER.md ≤3000 字）：画像=我是谁的稳定事实/偏好=内容与流程取舍\
                      /风格=呈现形式/习惯=周期性行为/禁止=硬否定（仅显式解除）\
                      /授权=硬肯定许可/人际=对具体他人的协作事实/术语=私有词汇\
                      /目标=阶段性方向（带截止日期到期自清）/教训=泛化失败规律。\
                      项目知识（项目会话）：project=项目事实/feedback=教训\
                      /reference=外部指针（一文件一事实+MEMORY.md 索引，≤4KB，\
                      同题更新不重复；日常会话自动回落公共层）。单条凝练一句一线。"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "一句话标题（公共层=条目主句；≤40 字）"},
                "type": {"type": "string",
                         "enum": ["画像", "偏好", "风格", "习惯", "禁止", "授权",
                                  "人际", "术语", "目标", "教训",
                                  "user", "project", "feedback", "reference"],
                         "description": "十类→公共层 USER.md（单条 ≤80 字）；四类→项目知识/回落（默认 user）"},
                "body": {"type": "string", "description": "补充正文（公共层取首行并入单条；知识记忆 ≤4KB）"},
                "links": {"type": "array", "items": {"type": "string"},
                          "description": "关联记忆 slug（仅项目知识；可选）"}
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
        description: "移除公共记忆（USER.md）中匹配的条目——更正两步的第一步：\
                      先 forget 旧事实，再用 memory_save 写入新事实（如改名：\
                      forget(画像,旧名)+save(画像,新名)）。硬约束的解除（禁止/授权）\
                      也走这里。条目粒度匹配（同类型+包含串）防同名误伤；\
                      返回移除清单，误删可立即重写。"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "type": {"type": "string",
                         "enum": ["画像", "偏好", "风格", "习惯", "禁止", "授权",
                                  "人际", "术语", "目标", "教训"],
                         "description": "条目类型"},
                "contains": {"type": "string", "description": "匹配串（该类型下文本包含此串的条目全部移除）"}
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
        description: "读取项目记忆单条正文（slug 见注入的项目记忆索引 MEMORY.md；\
                      索引行只是路由信息，正文经本工具按需拉取）。\
                      公共层 USER.md 已全文注入无需读取；日常会话无项目记忆。"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "记忆 slug（索引行括号内的文件名主干）"}
            },
            "required": ["name"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// coding.delegate 薄门面（D11 §2.4 coding.rs：定义 inputSchema/风险级，执行由 session
/// 循环的委派专用路径承接——本 crate 的 execute 不会收到该调用；schema 即模型可发现面）
/// subagent.adjust 薄门面（D16 决策⑧：运行中子任务补充指令——探查/专家/
/// 委派通用；执行由 session 循环专用路径经 hub 定向下发，execute 不会收到）
pub fn subagent_adjust_def() -> ToolDef {
    ToolDef {
        name: "subagent.adjust".into(),
        description: "向正在运行的子任务（探查/专家/委派，run_id 见会话内子任务卡或\
                      运行记录）下发补充指令调整方向；下一轮即生效。\
                      已结束的 run 不可调整（重新派发即可）"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "description": "目标 run（r- 前缀）"},
                "instruction": {"type": "string", "description": "补充/调整指令（一句话）"}
            },
            "required": ["run_id", "instruction"]
        }),
        risk: RiskLevel::Medium,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// subagent.cancel 薄门面（运行中子任务取消；同上专用路径承接）
pub fn subagent_cancel_def() -> ToolDef {
    ToolDef {
        name: "subagent.cancel".into(),
        description: "取消正在运行的子任务（探查/专家/委派通用；优雅取消，\
                      已产出部分结果会保留。）"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "run_id": {"type": "string", "description": "目标 run（r- 前缀）"}
            },
            "required": ["run_id"]
        }),
        risk: RiskLevel::Medium,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

pub fn coding_delegate_def() -> ToolDef {
    ToolDef {
        name: "coding.delegate".into(),
        description: "把编码任务委派给本地编码智能体（Claude Code/zcode/通用 CLI）：\
                      产出任务简报→用户确认→子进程执行→diff 审查。\
                      适合大范围重构/测试修复等可独立交付的编码工作；\
                      简读文件仍用 read_file/search_files 更高效"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "任务目标（一句话，具体可验收）"},
                "constraints": {"type": "array", "items": {"type": "string"},
                                 "description": "约束（如 不改公共 API）"},
                "acceptance": {"type": "array", "items": {"type": "string"},
                                "description": "验收标准（命令/行为描述）"},
                "forbidden": {"type": "array", "items": {"type": "string"},
                               "description": "禁止事项（注入子进程环境；如 git push）"}
            },
            "required": ["task"]
        }),
        risk: RiskLevel::High,
        category: bbrt_sec::gate::ActionCategory::Delegate,
    }
}
