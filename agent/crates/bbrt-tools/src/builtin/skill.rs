//! skill 工具（D33 §3.1：技能显式加载——Claude Code 同款）。
//!
//! 隐式触发词注入退役后的唯一技能装载通道：模型从 system 组装的技能目录区
//! 看到可用技能（name：description），按名调用本工具 → **结果=SKILL.md 完整
//! 规范正文**（含 allowedTools 提示与 risk 标注），天然注入下轮上下文。
//! 走常规管线：tool.call/toolResult 事件让时间线天然可见（前端 SkillCard）、
//! WAL 自动记录；风险级 Low/ReadOnly（读正文无副作用——技能内的实际操作
//! 由后续工具调用各自过门控）。SkillIndex 经 ToolsConfig 注入（与
//! tools.reload 热重扫共用同一实例，新技能即装即用）。

use serde_json::json;

use crate::registry::{RiskLevel, ToolDef};

pub fn skill_def() -> ToolDef {
    ToolDef {
        name: "skill".into(),
        description: "加载技能：按名获取一项技能的完整执行规范（正文即指令，\
                      获取后按规范执行任务）。当任务与技能目录中某项匹配时，\
                      先调用本工具再动手"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "技能名（技能目录中列出）"}
            },
            "required": ["name"]
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// 执行：按名取正文。未命中不阻断（Ok + 可用清单引导文本，exit 1 供 UI
/// 区分）——模型可自行纠正重试；索引未装配（单测/嵌入式）同口径降级。
pub(crate) fn load(
    skills: Option<&std::sync::Arc<std::sync::Mutex<bbrt_session::skills::SkillIndex>>>,
    args: &serde_json::Value,
) -> Result<crate::builtin::ExecOutput, crate::builtin::ToolBlock> {
    let Some(name) = args.get("name").and_then(|v| v.as_str()) else {
        return Err(crate::builtin::ToolBlock {
            code: bbrt_sec::errors::CODE_NO_PERMISSION_POINT,
            message: "缺少参数 name（8002）".into(),
        });
    };
    let Some(shared) = skills else {
        return Ok(crate::builtin::ExecOutput {
            summary: "技能索引未装配（嵌入式模式），技能不可用".into(),
            truncated: false,
            exit_code: Some(1),
            duration_ms: 0,
        });
    };
    let idx = shared.lock().unwrap_or_else(|p| p.into_inner());
    match idx.render_entry(name) {
        Some(body) => Ok(crate::builtin::ExecOutput {
            summary: body,
            truncated: false,
            exit_code: None,
            duration_ms: 0,
        }),
        None => {
            let names = idx.names().join("、");
            Ok(crate::builtin::ExecOutput {
                summary: format!("技能 {name} 不存在。可用技能：{names}"),
                truncated: false,
                exit_code: Some(1),
                duration_ms: 0,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn idx_with(name: &str) -> Arc<Mutex<bbrt_session::skills::SkillIndex>> {
        let eco = std::env::temp_dir().join(format!("bbc-skill-tool-{}", std::process::id()));
        std::fs::create_dir_all(eco.join("d")).unwrap();
        std::fs::write(
            eco.join("d/SKILL.md"),
            format!("---\nname: {name}\ndescription: 测试技能\n---\n执行规范正文。"),
        )
        .unwrap();
        Arc::new(Mutex::new(bbrt_session::skills::SkillIndex::scan(&eco)))
    }

    /// 命中：结果=完整规范正文（标题行 + 正文）
    #[test]
    fn load_returns_body() {
        let shared = idx_with("报销");
        let out = load(Some(&shared), &json!({"name": "报销"})).unwrap();
        assert!(out.summary.contains("# 技能: 报销"));
        assert!(out.summary.contains("执行规范正文。"));
        assert_eq!(out.exit_code, None);
    }

    /// 未命中：不阻断——Ok + 可用清单 + exit 1（模型可自行纠正）
    #[test]
    fn load_unknown_lists_available() {
        let shared = idx_with("报销");
        let out = load(Some(&shared), &json!({"name": "不存在"})).unwrap();
        assert!(out.summary.contains("不存在"));
        assert!(out.summary.contains("报销"));
        assert_eq!(out.exit_code, Some(1));
    }

    /// 缺参：8002 阻断
    #[test]
    fn load_missing_arg_blocks() {
        let shared = idx_with("报销");
        let err = load(Some(&shared), &json!({})).unwrap_err();
        assert_eq!(err.code, bbrt_sec::errors::CODE_NO_PERMISSION_POINT);
    }
}
