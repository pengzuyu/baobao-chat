//! memory_save 工具（D11 §2.4 builtin/memory.rs；D15 §2 主动轨 W1 模型写入路径）。
//!
//! 直通 `bbrt_memory::MemoryEngine::save_memory`：
//! - 同题更新不重复（slug/title 相等原地更新）、正文 ≤4KB、密钥特征拒写
//!   （MemoryError 映射回 blocked）、LRU 容量淘汰——全部由 bbrt-memory 内建；
//! - journal 落 `memory.saved` 事件由 MemoryEngine 自记（被动轨同源），本工具
//!   不再经 journal_hook 重复发事件；
//! - 注册为低风险（知识写入经脱敏约束）；门控侧 gate 未登记该工具，走未知工具
//!   兜底档（任意命令 → 逐次确认），待 bbrt-sec static_category 补行后归位。

use bbrt_memory::{MemoryType, SaveInput};
use serde_json::{json, Value};

use super::{deny, str_arg, timed, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 工具参数/装配错误码（14 篇：8002）
const CODE_TOOL_ARGS: u32 = 8002;

/// memory_save 实现：title/type/body → SaveInput → MemoryEngine.save_memory
pub(crate) fn save(env: &ExecEnv, args: &Value, session_id: &str) -> Result<ExecOutput, ToolBlock> {
    let title = str_arg(args, "title")
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "memory_save 缺少 title 参数"))?;
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let type_str = str_arg(args, "type").unwrap_or_else(|| "user".to_string());
    let mtype = MemoryType::parse(&type_str).ok_or_else(|| {
        deny(
            CODE_TOOL_ARGS,
            format!("type 必须是 user/project/feedback/reference 之一，收到 {type_str}"),
        )
    })?;
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
        let input = SaveInput {
            title,
            mtype,
            body,
            session: session_id.to_string(),
            links,
        };
        match engine.save_memory(&input) {
            Ok(outcome) => {
                let verb = if outcome.saved.updated {
                    "更新"
                } else {
                    "写入"
                };
                Ok(ExecOutput {
                    summary: format!(
                        "记忆已{verb}：{}（name={}，type={}）",
                        outcome.saved.title, outcome.saved.name, type_str
                    ),
                    truncated: false,
                    exit_code: None,
                    duration_ms: 0,
                })
            }
            // 含 D15 §4 脱敏拒写（SensitiveContent）与 4KB 上限等
            Err(e) => Err(deny(CODE_TOOL_ARGS, format!("记忆写入被拒：{e}"))),
        }
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

/// memory_save 工具定义（低风险知识写入；见模块注释的门控档说明）
pub fn memory_save_def() -> ToolDef {
    ToolDef {
        name: "memory_save".into(),
        description: "保存长期记忆（一文件一事实，写入用户记忆库并更新 MEMORY.md 索引；\
                      正文 ≤4KB、命中密钥特征拒写、同题更新不重复）"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "一句话标题（≤40 字）"},
                "type": {"type": "string", "enum": ["user", "project", "feedback", "reference"],
                         "description": "记忆类型（默认 user）"},
                "body": {"type": "string", "description": "事实正文（≤4KB）"},
                "links": {"type": "array", "items": {"type": "string"},
                          "description": "关联记忆 slug（可选）"}
            },
            "required": ["title", "body"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::FileEdit,
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
