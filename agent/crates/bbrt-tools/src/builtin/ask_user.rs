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
        description: "Ask the user to clarify a pivotal decision (answered via option-card \
                      selection): use only at key points that shape substantial downstream work \
                      — choosing between approaches, confirming destructive operations, or \
                      resolving genuinely ambiguous intent; one question at a time, 2-4 \
                      options; decide on your own whenever reasonable"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The full question (one sentence)"},
                "header": {"type": "string", "description": "Short label, max 12 chars (shown as a UI chip, optional)"},
                "options": {
                    "type": "array",
                    "minItems": 2,
                    "maxItems": 4,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "Short option text"},
                            "description": {"type": "string", "description": "Trade-off explanation (optional)"}
                        },
                        "required": ["label"]
                    },
                    "description": "Option list (2-4 items)"
                },
                "multi_select": {"type": "boolean", "description": "Allow multi-select (default false)"}
            },
            "required": ["question", "options"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}
