//! 子进程原始事件行 → 归一化事件（D11 §8.3 映射表；17 §3.3）。
//!
//! 映射表（权威）：
//!
//! | 子智能体原始事件 | 归一化（[`NormalizedEvent`]） | 上行消息（bbrt-protocol） | 审批联动 |
//! |---|---|---|---|
//! | system/init 等元信息 | `Meta` | `delegate.event(kind=meta)` | — |
//! | assistant 流式文本 | `Delta` | `stream.delta`（source=backend 语义） | — |
//! | tool_use（编辑/命令） | `ToolUse`（risk 按映射） | `tool.call`（source=backend） | 按权限模式放行/升级审批卡 |
//! | tool_result | `ToolResult` | `tool.result` | — |
//! | 权限询问（headless 下不应出现） | `Warning` | `delegate.event(kind=warning)` | 终止+建议改参数组合 |
//! | 进程退出 | `Exit` | `delegate.end` | 触发 diff 审查卡 |
//!
//! 行协议（两个前缀，载荷共用 [`EventPayload`] JSON 模式）：
//! - 通用/fake 后端：`##BBC:EVT:{json}`（约定；其余行 → 文本 delta）；
//! - zcode（17 §11.1 假定）：`##ZCODE:{json}`（其余行 → 文本 delta）；
//! - claude stream-json 行解析在 [`crate::claude`]（适配器内隔离）。

use bbrt_protocol::{DelegateEventKind, RiskLevel, RuntimeToHost, StreamChannel, ToolSource};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 通用/fake 后端结构化事件行前缀：`##BBC:EVT:{json}`
pub const GENERIC_EVT_PREFIX: &str = "##BBC:EVT:";
/// zcode 假定行文本协议的结构化事件行前缀：`##ZCODE:{json}`（17 §11.1，以正式文档为准）
pub const ZCODE_EVT_PREFIX: &str = "##ZCODE:";

/// 单行原始输出最大字节数（超限视为协议异常，防内存放大；09 篇输出上限精神）
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// 归一化事件（D11 §8.3 中列；上行映射见 [`NormalizedEvent::to_runtime_message`]）
#[derive(Debug, Clone, PartialEq)]
pub enum NormalizedEvent {
    /// system/init 等元信息（session_ref：可续接句柄，如 claude session_id）
    Meta {
        text: String,
        /// 续接句柄（模式 C `--resume` 等价能力的数据源）
        session_ref: Option<String>,
    },
    /// assistant 流式文本（source=backend 的 stream.delta）
    Delta {
        channel: StreamChannel,
        text: String,
    },
    /// 工具调用请求（tool.call，risk 按 [`tool_risk`] 映射）
    ToolUse {
        call_id: String,
        tool: String,
        args: Value,
        risk: RiskLevel,
    },
    /// 工具结果（tool.result）
    ToolResult {
        call_id: String,
        ok: bool,
        summary: String,
    },
    /// 权限询问等异常（delegate.event kind=warning；headless 下不应出现）
    Warning { text: String },
    /// 进程退出（delegate.end；exit_code/signal 二选一必有值）
    Exit {
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
}

impl NormalizedEvent {
    /// 类别名（调试/审计展示；对应 §8.3 左列语义）
    pub fn kind_name(&self) -> &'static str {
        match self {
            NormalizedEvent::Meta { .. } => "meta",
            NormalizedEvent::Delta { .. } => "delta",
            NormalizedEvent::ToolUse { .. } => "tool_use",
            NormalizedEvent::ToolResult { .. } => "tool_result",
            NormalizedEvent::Warning { .. } => "warning",
            NormalizedEvent::Exit { .. } => "exit",
        }
    }
}

/// 上行消息构造上下文（session_id/delegate_task_id/seq 由编排层维护）
#[derive(Debug, Clone)]
pub struct EventCtx {
    /// 父编排会话 ID（stream.delta/tool.call 需要）
    pub session_id: String,
    /// 委派任务 ID（delegate.event/delegate.end 需要）
    pub delegate_task_id: String,
    /// 会话内单调递增序号（stream.delta.seq）
    pub seq: u64,
}

/// 归一化事件 → stdio JSONL 上行消息（§8.3 右列）。
/// `Exit` 变体需 summary/changed_files 等收尾信息，走 [`exit_to_delegate_end`]。
pub fn to_runtime_message(ev: &NormalizedEvent, ctx: &EventCtx) -> Option<RuntimeToHost> {
    let msg = match ev {
        NormalizedEvent::Meta { text, session_ref } => RuntimeToHost::DelegateEvent {
            session_id: ctx.session_id.clone(),
            delegate_task_id: ctx.delegate_task_id.clone(),
            kind: DelegateEventKind::Meta,
            payload: json!({ "text": text, "sessionRef": session_ref }),
        },
        NormalizedEvent::Delta { channel, text } => RuntimeToHost::StreamDelta {
            session_id: ctx.session_id.clone(),
            delta: text.clone(),
            seq: ctx.seq,
            channel: *channel,
        },
        NormalizedEvent::ToolUse {
            call_id,
            tool,
            args,
            risk,
        } => RuntimeToHost::ToolCall {
            call_id: call_id.clone(),
            session_id: ctx.session_id.clone(),
            tool: tool.clone(),
            args: args.clone(),
            risk: *risk,
            parallel: false,
            source: ToolSource::Backend,
        },
        NormalizedEvent::ToolResult {
            call_id,
            ok,
            summary,
        } => RuntimeToHost::ToolResult {
            // 2026-11-12：协议补会话字段（宿主壳路由用——同 bbrt/src/bridge.rs 注记）
            session_id: ctx.session_id.clone(),
            call_id: call_id.clone(),
            ok: *ok,
            summary: summary.clone(),
            truncated: false,
            exit_code: None,
            blocked: None,
            duration_ms: None,
        },
        NormalizedEvent::Warning { text } => RuntimeToHost::DelegateEvent {
            session_id: ctx.session_id.clone(),
            delegate_task_id: ctx.delegate_task_id.clone(),
            kind: DelegateEventKind::Warning,
            payload: json!({ "text": text }),
        },
        // Exit 需要 ExitCtx（summary/changed_files/child_session_ref），单独构造
        NormalizedEvent::Exit { .. } => return None,
    };
    Some(msg)
}

/// 进程退出 → `delegate.end`（§8.3 末行：触发 diff 审查卡）
pub fn exit_to_delegate_end(
    session_id: &str,
    delegate_task_id: &str,
    exit_code: i32,
    summary: String,
    changed_files: Vec<String>,
    child_session_ref: Option<String>,
) -> RuntimeToHost {
    RuntimeToHost::DelegateEnd {
        session_id: session_id.to_string(),
        delegate_task_id: delegate_task_id.to_string(),
        exit_code,
        summary,
        changed_files,
        child_session_ref,
    }
}

/// 工具风险映射（§8.3：tool_use 的 risk 按映射；09 篇风险矩阵对齐的口径待登记）
pub fn tool_risk(tool: &str) -> RiskLevel {
    let t = tool.trim().to_ascii_lowercase();
    match t.as_str() {
        // 只读类
        "read" | "read_file" | "view" | "glob" | "grep" | "search" | "ls" | "list" | "lsdir" => {
            RiskLevel::Low
        }
        // 文件编辑类
        "edit" | "write" | "write_file" | "multiedit" | "notebookedit" | "applypatch"
        | "apply_patch" => RiskLevel::Medium,
        // 命令执行类
        "bash" | "shell" | "sh" | "zsh" | "command" | "run_command" | "exec" | "run" => {
            RiskLevel::High
        }
        _ => RiskLevel::Medium,
    }
}

// ---------------------------------------------------------------------------
// 前缀行协议载荷
// ---------------------------------------------------------------------------

/// `##BBC:EVT:` / `##ZCODE:` 行的 JSON 载荷模式（两协议共用；字段全部可缺省，
/// 由 [`payload_to_events`] 做缺字段防御：缺关键字段降级为 Warning 而非中断流）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EventPayload {
    /// 事件类别（output/tool_use/tool_result/warning/meta；bbrt-protocol 枚举复用）
    pub kind: DelegateEventKind,
    /// 文本（output/meta/warning）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 输出通道（output 可选，默认 text）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<StreamChannel>,
    /// 工具调用 ID（tool_use/tool_result）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// 工具名（tool_use）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// 工具参数（tool_use）
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub args: Value,
    /// 是否成功（tool_result，默认 true）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    /// 结果摘要（tool_result）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 续接句柄（meta 可携带；zcode 假定协议字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
}

/// 载荷 → 归一化事件（缺字段防御：关键字段缺失产出 Warning，不中断事件流）
pub fn payload_to_events(p: EventPayload) -> Vec<NormalizedEvent> {
    match p.kind {
        DelegateEventKind::Meta => vec![NormalizedEvent::Meta {
            text: p.text.unwrap_or_default(),
            session_ref: p.session_ref,
        }],
        DelegateEventKind::Output => vec![NormalizedEvent::Delta {
            channel: p.channel.unwrap_or(StreamChannel::Text),
            text: p.text.unwrap_or_default(),
        }],
        DelegateEventKind::ToolUse => match (p.call_id, p.tool) {
            (Some(call_id), Some(tool)) => {
                let risk = tool_risk(&tool);
                vec![NormalizedEvent::ToolUse {
                    call_id,
                    tool,
                    args: p.args,
                    risk,
                }]
            }
            _ => vec![NormalizedEvent::Warning {
                text: "tool_use 事件缺少 call_id/tool 字段".into(),
            }],
        },
        DelegateEventKind::ToolResult => match p.call_id {
            Some(call_id) => vec![NormalizedEvent::ToolResult {
                call_id,
                ok: p.ok.unwrap_or(true),
                summary: p.summary.unwrap_or_default(),
            }],
            None => vec![NormalizedEvent::Warning {
                text: "tool_result 事件缺少 call_id 字段".into(),
            }],
        },
        DelegateEventKind::Warning => vec![NormalizedEvent::Warning {
            text: p.text.unwrap_or_default(),
        }],
    }
}

/// 解析一行前缀协议输出：命中前缀 → 结构化事件（坏 JSON 降级 Warning）；
/// 未命中 → 纯文本行包装为 Delta（17 §3.2 通用 CLI "仅 stdout 行文本 → stream.delta"）。
pub fn parse_prefixed_line(line: &str, prefix: &str) -> Vec<NormalizedEvent> {
    match line.strip_prefix(prefix) {
        Some(rest) => match serde_json::from_str::<EventPayload>(rest) {
            Ok(p) => payload_to_events(p),
            Err(e) => vec![NormalizedEvent::Warning {
                text: format!("事件行解析失败（{prefix}…）: {e}"),
            }],
        },
        None => vec![NormalizedEvent::Delta {
            channel: StreamChannel::Text,
            text: line.to_string(),
        }],
    }
}

/// 行解析器抽象：适配器各带一个实现（claude 的 stream-json 状态解析在 claude.rs）
pub trait LineParser: Send {
    /// 一行原始输出 → 0..n 归一化事件（如 assistant 消息可含 text+tool_use 多块）
    fn parse_line(&mut self, line: &str) -> Vec<NormalizedEvent>;
}

// ---------------------------------------------------------------------------
// 单元测试（样例行数据锁定映射）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bbrt_protocol::DelegateEventKind;

    #[test]
    fn generic_line_tool_use_maps_with_risk() {
        let evs = parse_prefixed_line(
            r#"##BBC:EVT:{"kind":"tool_use","call_id":"t1","tool":"Edit","args":{"file_path":"a.rs"}}"#,
            GENERIC_EVT_PREFIX,
        );
        assert_eq!(
            evs,
            vec![NormalizedEvent::ToolUse {
                call_id: "t1".into(),
                tool: "Edit".into(),
                args: json!({"file_path": "a.rs"}),
                risk: RiskLevel::Medium,
            }]
        );
        // Bash → High
        let evs = parse_prefixed_line(
            r#"##BBC:EVT:{"kind":"tool_use","call_id":"t2","tool":"Bash","args":{"command":"cargo test"}}"#,
            GENERIC_EVT_PREFIX,
        );
        assert_eq!(
            evs[0],
            NormalizedEvent::ToolUse {
                call_id: "t2".into(),
                tool: "Bash".into(),
                args: json!({"command": "cargo test"}),
                risk: RiskLevel::High,
            }
        );
    }

    #[test]
    fn generic_line_tool_result_and_output_and_meta() {
        let evs = parse_prefixed_line(
            r#"##BBC:EVT:{"kind":"tool_result","call_id":"t1","ok":false,"summary":"boom"}"#,
            GENERIC_EVT_PREFIX,
        );
        assert_eq!(
            evs,
            vec![NormalizedEvent::ToolResult {
                call_id: "t1".into(),
                ok: false,
                summary: "boom".into()
            }]
        );
        let evs = parse_prefixed_line(
            r#"##BBC:EVT:{"kind":"output","text":"hello"}"#,
            GENERIC_EVT_PREFIX,
        );
        assert_eq!(
            evs,
            vec![NormalizedEvent::Delta {
                channel: StreamChannel::Text,
                text: "hello".into()
            }]
        );
        let evs = parse_prefixed_line(
            r#"##BBC:EVT:{"kind":"meta","text":"init","session_ref":"s-9"}"#,
            GENERIC_EVT_PREFIX,
        );
        assert_eq!(
            evs,
            vec![NormalizedEvent::Meta {
                text: "init".into(),
                session_ref: Some("s-9".into())
            }]
        );
    }

    #[test]
    fn generic_plain_line_wraps_as_delta_and_bad_json_degrades_to_warning() {
        let evs = parse_prefixed_line("plain text line", GENERIC_EVT_PREFIX);
        assert_eq!(
            evs,
            vec![NormalizedEvent::Delta {
                channel: StreamChannel::Text,
                text: "plain text line".into()
            }]
        );
        let evs = parse_prefixed_line("##BBC:EVT:{not json", GENERIC_EVT_PREFIX);
        match &evs[0] {
            NormalizedEvent::Warning { text } => assert!(text.contains("事件行解析失败")),
            other => panic!("期望 Warning，实际 {other:?}"),
        }
    }

    #[test]
    fn payload_missing_required_fields_degrades_to_warning() {
        let mk = |kind| EventPayload {
            kind,
            text: None,
            channel: None,
            call_id: None,
            tool: None,
            args: Value::Null,
            ok: None,
            summary: None,
            session_ref: None,
        };
        let evs = payload_to_events(mk(DelegateEventKind::ToolUse));
        assert!(matches!(evs[0], NormalizedEvent::Warning { .. }));
        let evs = payload_to_events(mk(DelegateEventKind::ToolResult));
        assert!(matches!(evs[0], NormalizedEvent::Warning { .. }));
        // tool_result ok 缺省为 true、summary 缺省空串
        let evs = payload_to_events(EventPayload {
            kind: DelegateEventKind::ToolResult,
            call_id: Some("c".into()),
            ..mk(DelegateEventKind::ToolResult)
        });
        assert_eq!(
            evs,
            vec![NormalizedEvent::ToolResult {
                call_id: "c".into(),
                ok: true,
                summary: String::new()
            }]
        );
    }

    #[test]
    fn zcode_prefix_line_maps_via_same_payload() {
        let evs = parse_prefixed_line(
            r#"##ZCODE:{"kind":"warning","text":"permission prompt"}"#,
            ZCODE_EVT_PREFIX,
        );
        assert_eq!(
            evs,
            vec![NormalizedEvent::Warning {
                text: "permission prompt".into()
            }]
        );
        // 通用前缀不误吞 zcode 行：以 zcode 前缀视角看通用行 → 纯文本 delta
        let evs = parse_prefixed_line("##BBC:EVT:{}", ZCODE_EVT_PREFIX);
        assert!(matches!(evs[0], NormalizedEvent::Delta { .. }));
    }

    #[test]
    fn tool_risk_matrix() {
        assert_eq!(tool_risk("Read"), RiskLevel::Low);
        assert_eq!(tool_risk("Grep"), RiskLevel::Low);
        assert_eq!(tool_risk("Edit"), RiskLevel::Medium);
        assert_eq!(tool_risk("Write"), RiskLevel::Medium);
        assert_eq!(tool_risk("Bash"), RiskLevel::High);
        assert_eq!(tool_risk("SomeUnknownTool"), RiskLevel::Medium);
        assert_eq!(tool_risk(" bash "), RiskLevel::High);
    }

    #[test]
    fn normalized_events_map_to_runtime_messages() {
        let ctx = EventCtx {
            session_id: "sess-1".into(),
            delegate_task_id: "d-101".into(),
            seq: 7,
        };
        // Delta → stream.delta
        let m = to_runtime_message(
            &NormalizedEvent::Delta {
                channel: StreamChannel::Text,
                text: "hi".into(),
            },
            &ctx,
        )
        .unwrap();
        assert!(matches!(
            &m,
            RuntimeToHost::StreamDelta { session_id, seq, delta, .. }
            if session_id == "sess-1" && *seq == 7 && delta == "hi"
        ));
        // ToolUse → tool.call source=backend
        let m = to_runtime_message(
            &NormalizedEvent::ToolUse {
                call_id: "c1".into(),
                tool: "Bash".into(),
                args: json!({}),
                risk: RiskLevel::High,
            },
            &ctx,
        )
        .unwrap();
        assert!(matches!(
            &m,
            RuntimeToHost::ToolCall { call_id, tool, source: ToolSource::Backend, risk: RiskLevel::High, .. }
            if call_id == "c1" && tool == "Bash"
        ));
        // Warning → delegate.event kind=warning
        let m = to_runtime_message(&NormalizedEvent::Warning { text: "w".into() }, &ctx).unwrap();
        assert!(matches!(
            &m,
            RuntimeToHost::DelegateEvent { kind: DelegateEventKind::Warning, delegate_task_id, .. }
            if delegate_task_id == "d-101"
        ));
        // Meta → delegate.event kind=meta
        let m = to_runtime_message(
            &NormalizedEvent::Meta {
                text: "init".into(),
                session_ref: None,
            },
            &ctx,
        )
        .unwrap();
        assert!(matches!(
            &m,
            RuntimeToHost::DelegateEvent {
                kind: DelegateEventKind::Meta,
                ..
            }
        ));
        // Exit 不走本函数
        assert!(to_runtime_message(
            &NormalizedEvent::Exit {
                exit_code: Some(0),
                signal: None
            },
            &ctx
        )
        .is_none());
    }

    #[test]
    fn exit_maps_to_delegate_end() {
        let m = exit_to_delegate_end(
            "sess-1",
            "d-101",
            0,
            "完成".into(),
            vec!["src/a.rs".into()],
            Some("child-sess".into()),
        );
        assert!(matches!(
            &m,
            RuntimeToHost::DelegateEnd {
                delegate_task_id, exit_code, summary, changed_files, ..
            }
            if delegate_task_id == "d-101" && *exit_code == 0 && summary == "完成"
                && changed_files.len() == 1
        ));
    }

    #[test]
    fn event_kind_names() {
        let ev = NormalizedEvent::Exit {
            exit_code: None,
            signal: Some(9),
        };
        assert_eq!(ev.kind_name(), "exit");
    }
}
