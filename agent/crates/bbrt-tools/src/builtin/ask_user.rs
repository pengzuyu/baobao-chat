//! ask_user 工具定义（D20：ZCode 式提问卡）。
//!
//! **无执行体**：本工具在 bbrt-session loop_runner::run_tool 按名拦截（同
//! 门控内嵌口径）——触发 clarify.request 事件并阻塞等待宿主
//! clarify.response，回答直接作为工具结果回给模型，不走 pipeline 门控/执行。
//! 此处只提供 ToolDef（模型可发现性 + specs 导出）。
//! 低风险 ReadOnly（提问本身无副作用）；不进 WORKSPACE_BOUND_TOOLS——
//! 日常会话（无目录）同样可问。

use serde_json::json;

use crate::registry::{RiskLevel, ToolDef};

pub fn ask_user_def() -> ToolDef {
    ToolDef {
        name: "ask_user".into(),
        description: "向用户提问以澄清关键决策（选项卡点选作答）：仅在方案取舍、\
                      破坏性操作确认、意图实质歧义等影响后续大量工作的关键点使用；\
                      一次一个问题，选项 2-4 个；能合理自决的不要问"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "完整问题（一句）"},
                "header": {"type": "string", "description": "短标签 ≤12 字（界面 chip 展示，可选）"},
                "options": {
                    "type": "array",
                    "minItems": 2,
                    "maxItems": 4,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "选项短文案"},
                            "description": {"type": "string", "description": "取舍说明（可选）"}
                        },
                        "required": ["label"]
                    },
                    "description": "选项列表（2-4 个）"
                },
                "multi_select": {"type": "boolean", "description": "允许多选（默认 false）"}
            },
            "required": ["question", "options"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}
