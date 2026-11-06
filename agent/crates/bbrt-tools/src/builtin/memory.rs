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
