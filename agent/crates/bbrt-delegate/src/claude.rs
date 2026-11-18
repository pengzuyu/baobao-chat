//! Claude Code 适配器（17 §3.2/§5.2；D11 §8.2 参数映射表——权威在此锁定）。
//!
//! 固定参数：`claude -p "<渲染简报>" --output-format stream-json --verbose`（cwd=工作区）。
//!
//! §8.2 权限模式映射表：
//!
//! | 本产品模式 | claude 参数 | 效果 |
//! |---|---|---|
//! | ask | `--permission-mode plan` + `--disallowedTools "Edit,Write,NotebookEdit,Bash"` | 只读探查+产出方案 |
//! | auto-edit | `--permission-mode acceptEdits` + `--allowedTools "Read,Edit,Write,Glob,Grep"` + `--disallowedTools "Bash"` | 编辑放行、任意命令禁止 |
//! | full-auto | `--permission-mode bypassPermissions` + `--allowedTools "Bash(cargo build:*),Bash(cargo test:*)"` | 编辑+白名单命令 |
//!
//! 会话续接（模式 C）：`--resume <session_ref>`（session_ref 来自 stream-json
//! system/init 或 result 消息的 session_id，解析时捕获）。
//!
//! stream-json 行解析（样例行在单测锁定；真实 CLI 存在与否经 detect 探测）：
//! - `{"type":"system","subtype":"init",...}` → Meta（捕获 session_id）
//! - `{"type":"assistant","message":{"content":[{type:text|tool_use,...}]}}` → Delta/ToolUse
//! - `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}` → ToolResult
//! - `{"type":"result",...}` → Delta(result 文本) + Meta（捕获 session_id）
//! - system 子类含 "permission"（headless 下不应出现的权限询问）→ Warning（§8.3）
//! - 非 JSON 行 → 文本 delta 降级（17 §3.2 "缺字段则降级文本行"）

use bbrt_protocol::{PermissionMode, StreamChannel, TaskBrief};
use serde_json::Value;

use crate::backend::{
    ensure_workspace, BackendProbe, CodingBackend, DelegateError, DelegateSession, FinalReport,
    HealthIssue, HealthReport, LaunchOpts,
};
use crate::brief;
use crate::health::{
    capability_matrix, check_version, probe_version, CapabilityMatrix, VERSION_PROBE_TIMEOUT_SECS,
};
use crate::normalize::{tool_risk, LineParser, NormalizedEvent};
use crate::procmgr::{self, CancelOutcome};
use std::sync::Arc;

/// claude 二进制默认名
pub const CLAUDE_BIN: &str = "claude";

/// Claude Code 适配器（bin 可注入桩脚本路径供测试）
#[derive(Debug, Clone)]
pub struct ClaudeBackend {
    bin: String,
}

impl ClaudeBackend {
    /// 以默认 `claude` 构造
    pub fn new() -> Self {
        Self {
            bin: CLAUDE_BIN.into(),
        }
    }

    /// 指定二进制（绝对路径/名字；测试桩注入点）
    pub fn with_bin(bin: impl Into<String>) -> Self {
        Self { bin: bin.into() }
    }

    /// 目标二进制
    pub fn bin(&self) -> &str {
        &self.bin
    }
}

impl Default for ClaudeBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// 组装启动参数（§8.2 固定参数 + 模式映射 + 续接）
pub fn build_args(brief: &TaskBrief, mode: PermissionMode, resume: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        brief::render(brief),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
    args.extend(mode_args(mode));
    if let Some(session_ref) = resume {
        args.push("--resume".to_string());
        args.push(session_ref.to_string());
    }
    args
}

/// §8.2 权限模式 → 参数（映射表权威实现；pub 供编排层启动前校验展示）
pub fn mode_args(mode: PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::Ask => vec![
            "--permission-mode".into(),
            "plan".into(),
            "--disallowedTools".into(),
            "Edit,Write,NotebookEdit,Bash".into(),
        ],
        PermissionMode::AutoEdit => vec![
            "--permission-mode".into(),
            "acceptEdits".into(),
            "--allowedTools".into(),
            "Read,Edit,Write,Glob,Grep".into(),
            "--disallowedTools".into(),
            "Bash".into(),
        ],
        PermissionMode::FullAuto => vec![
            "--permission-mode".into(),
            "bypassPermissions".into(),
            "--allowedTools".into(),
            "Bash(cargo build:*),Bash(cargo test:*)".into(),
        ],
    }
}

impl CodingBackend for ClaudeBackend {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn detect(&self) -> BackendProbe {
        match probe_version(
            &self.bin,
            std::time::Duration::from_secs(VERSION_PROBE_TIMEOUT_SECS),
        ) {
            Some(info) => BackendProbe {
                backend_id: "claude".into(),
                installed: true,
                path: Some(info.path),
                version: Some(info.version),
                capabilities: vec![
                    "stream-json".into(),
                    "resume".into(),
                    "permission-mode".into(),
                ],
            },
            None => BackendProbe {
                backend_id: "claude".into(),
                installed: false,
                path: None,
                version: None,
                capabilities: Vec::new(),
            },
        }
    }

    fn probe_health(&self) -> HealthReport {
        let Some(info) = probe_version(
            &self.bin,
            std::time::Duration::from_secs(VERSION_PROBE_TIMEOUT_SECS),
        ) else {
            return HealthReport::degraded(HealthIssue::NotInstalled);
        };
        // 版本能力矩阵（8031 语义；矩阵占位见 health.rs）
        if let Some(matrix) = capability_matrix("claude") {
            if let Err(issue) = check_version(&matrix, Some(&info.version)) {
                return HealthReport::degraded(issue);
            }
        }
        // 登录态/冒烟探测 v0.1 未实现（crate 级登记）：installed + 版本达标即健康
        HealthReport::healthy()
    }

    fn mode_args(&self, mode: PermissionMode) -> Result<Vec<String>, DelegateError> {
        Ok(mode_args(mode))
    }

    fn launch(
        &self,
        brief: &TaskBrief,
        opts: &LaunchOpts,
    ) -> Result<DelegateSession, DelegateError> {
        brief::validate(brief).map_err(|e| DelegateError::InvalidState(e.to_string()))?;
        ensure_workspace(&opts.workspace)?;
        let args = build_args(brief, opts.mode, opts.resume.as_deref());
        let mut envs = brief::child_env(brief);
        envs.extend(opts.env_allow.iter().cloned());
        let (proc, stdout, stderr) = procmgr::spawn(&self.bin, &args, Some(&opts.workspace), &envs)?;
        // 简报经 -p 参数传入；stdin 保留给 send_input（模式 C 追问）
        Ok(DelegateSession::new(
            "claude",
            &opts.delegate_task_id,
            proc,
            stdout,
            Some(stderr),
            Box::new(ClaudeStreamParser),
        ))
    }

    fn stream_events(
        &self,
        session: &DelegateSession,
    ) -> Result<Option<NormalizedEvent>, DelegateError> {
        session.next_event()
    }

    fn send_input(&self, session: &DelegateSession, text: &str) -> Result<(), DelegateError> {
        session.send_input(text)
    }

    fn cancel(
        &self,
        session: &DelegateSession,
        graceful: bool,
    ) -> Result<CancelOutcome, DelegateError> {
        session.cancel(graceful)
    }

    fn finalize(&self, session: &DelegateSession) -> Result<FinalReport, DelegateError> {
        session.finalize()
    }
}

impl From<ClaudeBackend> for Arc<dyn CodingBackend> {
    fn from(b: ClaudeBackend) -> Self {
        Arc::new(b)
    }
}

// ---------------------------------------------------------------------------
// stream-json 行解析
// ---------------------------------------------------------------------------

/// stream-json 行解析器（无跨行状态；tool_use↔tool_result 经 call_id 关联）
#[derive(Debug, Default)]
pub struct ClaudeStreamParser;

impl LineParser for ClaudeStreamParser {
    fn parse_line(&mut self, line: &str) -> Vec<NormalizedEvent> {
        parse_claude_line(line)
    }
}

/// 解析一行 stream-json（样例行见单测；非 JSON 行降级文本 delta）
pub fn parse_claude_line(line: &str) -> Vec<NormalizedEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![NormalizedEvent::Delta {
            channel: StreamChannel::Text,
            text: line.to_string(),
        }];
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") => parse_system(&v),
        Some("assistant") => parse_assistant(&v),
        Some("user") => parse_user(&v),
        Some("result") => parse_result(&v),
        _ => vec![NormalizedEvent::Warning {
            text: format!("未知 stream-json 消息类型: {}", brief_type(&v)),
        }],
    }
}

fn brief_type(v: &Value) -> String {
    v.get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("<missing>")
        .to_string()
}

/// system 消息：init → Meta（session_id 续接句柄）；权限询问 → Warning（§8.3）
fn parse_system(v: &Value) -> Vec<NormalizedEvent> {
    let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
    let session_ref = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    if subtype == "init" {
        let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("unknown");
        return vec![NormalizedEvent::Meta {
            text: format!("session init（model={model}）"),
            session_ref,
        }];
    }
    if subtype.contains("permission") {
        // headless 下不应出现（17 §3.3）：终止+建议改参数组合由上层执行
        return vec![NormalizedEvent::Warning {
            text: format!(
                "headless 模式下出现权限询问（system/{subtype}），建议改用支持非交互模式的参数组合"
            ),
        }];
    }
    vec![NormalizedEvent::Meta {
        text: format!("system/{subtype}"),
        session_ref,
    }]
}

/// assistant 消息：content 数组内 text 块 → Delta；tool_use 块 → ToolUse
fn parse_assistant(v: &Value) -> Vec<NormalizedEvent> {
    let mut events = Vec::new();
    let blocks = v
        .pointer("/message/content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                if !text.is_empty() {
                    events.push(NormalizedEvent::Delta {
                        channel: StreamChannel::Text,
                        text: text.to_string(),
                    });
                }
            }
            Some("tool_use") => {
                let id = block.get("id").and_then(|t| t.as_str()).unwrap_or("");
                let name = block.get("name").and_then(|t| t.as_str()).unwrap_or("");
                let args = block.get("input").cloned().unwrap_or(Value::Null);
                let risk = tool_risk(name);
                events.push(NormalizedEvent::ToolUse {
                    call_id: id.to_string(),
                    tool: name.to_string(),
                    args,
                    risk,
                });
            }
            _ => {} // thinking 等其他块：v0.1 忽略（登记：可映射 reasoning 通道）
        }
    }
    events
}

/// user 消息：content 内 tool_result 块 → ToolResult（call_id=tool_use_id）
fn parse_user(v: &Value) -> Vec<NormalizedEvent> {
    let mut events = Vec::new();
    let blocks = v
        .pointer("/message/content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
            let call_id = block
                .get("tool_use_id")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            let is_error = block
                .get("is_error")
                .and_then(|e| e.as_bool())
                .unwrap_or(false);
            // content 可为字符串或块数组：统一取可读摘要
            let summary = content_to_summary(block.get("content"));
            events.push(NormalizedEvent::ToolResult {
                call_id: call_id.to_string(),
                ok: !is_error,
                summary,
            });
        }
    }
    events
}

/// result 消息：结果文本 delta + Meta（session_id 续接句柄）
fn parse_result(v: &Value) -> Vec<NormalizedEvent> {
    let mut events = Vec::new();
    if let Some(text) = v.get("result").and_then(|r| r.as_str()) {
        if !text.is_empty() {
            events.push(NormalizedEvent::Delta {
                channel: StreamChannel::Text,
                text: text.to_string(),
            });
        }
    }
    let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
    let session_ref = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    events.push(NormalizedEvent::Meta {
        text: format!("result/{subtype}"),
        session_ref,
    });
    events
}

/// tool_result content → 摘要（字符串直取；块数组取 text 拼接；截断 2k）
fn content_to_summary(content: Option<&Value>) -> String {
    let mut out = String::new();
    match content {
        Some(Value::String(s)) => out.push_str(s),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
        }
        _ => {}
    }
    if out.chars().count() > 2000 {
        out.chars().take(2000).collect()
    } else {
        out
    }
}

/// 矩阵访问（probe_health 内部用；单独暴露便于测试）
pub fn matrix() -> Option<CapabilityMatrix> {
    capability_matrix("claude")
}

// ---------------------------------------------------------------------------
// 单元测试（§8.2 参数表 + stream-json 样例行锁定）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;
    use bbrt_protocol::RiskLevel;

    fn sample_brief() -> TaskBrief {
        testing::testing_brief(std::path::Path::new("/Users/dev/repos/order-svc"))
    }

    #[test]
    fn mode_args_locked_to_design_table() {
        assert_eq!(
            mode_args(PermissionMode::Ask),
            vec![
                "--permission-mode",
                "plan",
                "--disallowedTools",
                "Edit,Write,NotebookEdit,Bash",
            ]
        );
        assert_eq!(
            mode_args(PermissionMode::AutoEdit),
            vec![
                "--permission-mode",
                "acceptEdits",
                "--allowedTools",
                "Read,Edit,Write,Glob,Grep",
                "--disallowedTools",
                "Bash",
            ]
        );
        assert_eq!(
            mode_args(PermissionMode::FullAuto),
            vec![
                "--permission-mode",
                "bypassPermissions",
                "--allowedTools",
                "Bash(cargo build:*),Bash(cargo test:*)",
            ]
        );
    }

    #[test]
    fn build_args_fixed_prefix_and_resume() {
        let brief = sample_brief();
        let args = build_args(&brief, PermissionMode::AutoEdit, None);
        assert_eq!(args[0], "-p");
        assert!(args[1].contains("task: 给 utils/math.go 增加 Abs 函数"));
        assert!(args[1].contains("forbidden:"));
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--verbose".to_string()));
        assert!(!args.contains(&"--resume".to_string()));

        let args = build_args(&brief, PermissionMode::FullAuto, Some("sess-42"));
        let i = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[i + 1], "sess-42");
    }

    #[test]
    fn parse_system_init_and_permission() {
        let evs = parse_claude_line(
            r#"{"type":"system","subtype":"init","session_id":"abc-1","model":"claude-x"}"#,
        );
        assert_eq!(
            evs,
            vec![NormalizedEvent::Meta {
                text: "session init（model=claude-x）".into(),
                session_ref: Some("abc-1".into()),
            }]
        );
        // headless 权限询问 → Warning（§8.3：不应出现）
        let evs =
            parse_claude_line(r#"{"type":"system","subtype":"permission_request","tool":"Bash"}"#);
        match &evs[0] {
            NormalizedEvent::Warning { text } => {
                assert!(text.contains("权限询问") && text.contains("参数组合"))
            }
            other => panic!("期望 Warning，实际 {other:?}"),
        }
    }

    #[test]
    fn parse_assistant_text_and_tool_use_blocks() {
        let evs = parse_claude_line(
            r#"{"type":"assistant","message":{"content":[
                {"type":"text","text":"我先看下文件"},
                {"type":"tool_use","id":"toolu_01","name":"Edit","input":{"file_path":"src/a.rs"}},
                {"type":"tool_use","id":"toolu_02","name":"Bash","input":{"command":"cargo build"}}
            ]}}"#,
        );
        assert_eq!(evs.len(), 3);
        assert_eq!(
            evs[0],
            NormalizedEvent::Delta {
                channel: StreamChannel::Text,
                text: "我先看下文件".into()
            }
        );
        assert_eq!(
            evs[1],
            NormalizedEvent::ToolUse {
                call_id: "toolu_01".into(),
                tool: "Edit".into(),
                args: serde_json::json!({"file_path": "src/a.rs"}),
                risk: RiskLevel::Medium,
            }
        );
        assert_eq!(
            evs[2],
            NormalizedEvent::ToolUse {
                call_id: "toolu_02".into(),
                tool: "Bash".into(),
                args: serde_json::json!({"command": "cargo build"}),
                risk: RiskLevel::High,
            }
        );
    }

    #[test]
    fn parse_user_tool_result_blocks() {
        let evs = parse_claude_line(
            r#"{"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"toolu_01","content":"应用补丁成功","is_error":false},
                {"type":"tool_result","tool_use_id":"toolu_02","content":[{"type":"text","text":"build failed"}],"is_error":true}
            ]}}"#,
        );
        assert_eq!(
            evs,
            vec![
                NormalizedEvent::ToolResult {
                    call_id: "toolu_01".into(),
                    ok: true,
                    summary: "应用补丁成功".into(),
                },
                NormalizedEvent::ToolResult {
                    call_id: "toolu_02".into(),
                    ok: false,
                    summary: "build failed".into(),
                }
            ]
        );
    }

    #[test]
    fn parse_result_message_and_unknown_types() {
        let evs = parse_claude_line(
            r#"{"type":"result","subtype":"success","result":"已完成退款接口","session_id":"abc-1"}"#,
        );
        assert_eq!(evs.len(), 2);
        assert_eq!(
            evs[0],
            NormalizedEvent::Delta {
                channel: StreamChannel::Text,
                text: "已完成退款接口".into()
            }
        );
        assert_eq!(
            evs[1],
            NormalizedEvent::Meta {
                text: "result/success".into(),
                session_ref: Some("abc-1".into())
            }
        );
        // 未知类型 → Warning；非 JSON 行 → delta 降级
        let evs = parse_claude_line(r#"{"type":"whatever"}"#);
        assert!(matches!(evs[0], NormalizedEvent::Warning { .. }));
        let evs = parse_claude_line("plain stdout fallback");
        assert!(matches!(evs[0], NormalizedEvent::Delta { .. }));
    }

    #[test]
    fn matrix_placeholder_exists() {
        let m = matrix().unwrap();
        assert_eq!(m.backend_id, "claude");
        assert!(m.supports_resume);
    }
}
