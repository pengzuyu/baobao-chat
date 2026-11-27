//! spawn_subagents 薄门面（2026-11-26）：子 agent 的通用派发入口——要不要派、
//! 每个任务用哪种类型，全由主 Agent 自己判断。何时判断、什么情况该派、任务
//! 怎么写、有哪些类型，都写在工具描述里（描述与类型登记表在 bbrt-session 的
//! subagent 模块单源渲染）。
//!
//! 仅注册可发现性：执行由 session 循环专用路径承接（loop_runner::run_tool →
//! subagent::fanout_probes），pipeline 的 execute 不会收到本工具——子 Agent 的
//! 工具面剔除它（防嵌套派发）。原「每条消息先跑一次隐藏模型调用判定要不要
//! 拆」的前置 planner 已退役：判定藏在主请求之前，用户只见「正在处理」，
//! 首字平白多等一次完整往返。

use serde_json::json;

use crate::registry::{RiskLevel, ToolDef};

pub fn spawn_subagents_def() -> ToolDef {
    ToolDef {
        name: bbrt_session::SPAWN_SUBAGENTS_TOOL.into(),
        description: bbrt_session::subagent::spawn_subagents_description(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "description": "Subagent kind for this task (one of the kinds listed above)"
                            },
                            "task": {
                                "type": "string",
                                "description": "Self-contained task: the goal, where to look, and what to report back"
                            }
                        },
                        "required": ["kind", "task"]
                    },
                    "description": "Tasks to delegate, one subagent each (1-3)"
                }
            },
            "required": ["tasks"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::Subagent,
    }
}
