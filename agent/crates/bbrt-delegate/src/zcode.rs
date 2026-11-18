//! zcode 适配器（17 §3.2/§11.1 假定口径；差异全部隔离在本文件）。
//!
//! **假定协议**（17 §11.1 开放问题：zcode headless 确切 CLI 参数与事件格式以
//! 正式文档为准，适配器隔离）：headless 启动 `zcode --headless --mode <m> [--resume <r>]`，
//! 简报经 stdin 投递；输出为行文本：
//! - `##ZCODE:{json}` 结构化事件行（载荷模式同通用协议，见
//!   [`crate::normalize::EventPayload`]；meta 可携带 session_ref）；
//! - 其余行 → 文本 delta 降级（17 §3.2 "缺字段则降级文本行"）。
//!
//! §8.2 对等权限模式映射（`--mode read-only|edit|full`）：
//!
//! | 本产品模式 | zcode 参数 |
//! |---|---|
//! | ask | `--mode read-only` |
//! | auto-edit | `--mode edit` |
//! | full-auto | `--mode full` |

use bbrt_protocol::{PermissionMode, TaskBrief};

use crate::backend::{
    ensure_workspace, BackendProbe, CodingBackend, DelegateError, DelegateSession, FinalReport,
    HealthIssue, HealthReport, LaunchOpts,
};
use crate::brief;
use crate::health::{capability_matrix, check_version, probe_version, VERSION_PROBE_TIMEOUT_SECS};
use crate::normalize::{parse_prefixed_line, LineParser, NormalizedEvent, ZCODE_EVT_PREFIX};
use crate::procmgr::{self, CancelOutcome};
use std::sync::Arc;

/// zcode 二进制默认名
pub const ZCODE_BIN: &str = "zcode";

/// zcode 适配器（bin 可注入桩脚本路径供测试）
#[derive(Debug, Clone)]
pub struct ZcodeBackend {
    bin: String,
}

impl ZcodeBackend {
    /// 以默认 `zcode` 构造
    pub fn new() -> Self {
        Self {
            bin: ZCODE_BIN.into(),
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

impl Default for ZcodeBackend {
    fn default() -> Self {
        Self::new()
    }
}

/// 组装启动参数（假定口径：--headless --mode <m> [--resume <r>]）
pub fn build_args(mode: PermissionMode, resume: Option<&str>) -> Vec<String> {
    let mut args = vec!["--headless".to_string()];
    args.extend(mode_args(mode));
    if let Some(session_ref) = resume {
        args.push("--resume".to_string());
        args.push(session_ref.to_string());
    }
    args
}

/// §8.2 对等映射：ask→read-only / auto-edit→edit / full-auto→full
pub fn mode_args(mode: PermissionMode) -> Vec<String> {
    let mode_name = match mode {
        PermissionMode::Ask => "read-only",
        PermissionMode::AutoEdit => "edit",
        PermissionMode::FullAuto => "full",
    };
    vec!["--mode".to_string(), mode_name.to_string()]
}

/// zcode 行文本解析器（`##ZCODE:` 前缀 → 事件；其余 → delta）
#[derive(Debug, Default)]
pub struct ZcodeLineParser;

impl LineParser for ZcodeLineParser {
    fn parse_line(&mut self, line: &str) -> Vec<NormalizedEvent> {
        parse_prefixed_line(line, ZCODE_EVT_PREFIX)
    }
}

impl CodingBackend for ZcodeBackend {
    fn id(&self) -> &'static str {
        "zcode"
    }

    fn detect(&self) -> BackendProbe {
        match probe_version(
            &self.bin,
            std::time::Duration::from_secs(VERSION_PROBE_TIMEOUT_SECS),
        ) {
            Some(info) => BackendProbe {
                backend_id: "zcode".into(),
                installed: true,
                path: Some(info.path),
                version: Some(info.version),
                capabilities: vec!["line-protocol".into(), "resume".into(), "mode-flag".into()],
            },
            None => BackendProbe {
                backend_id: "zcode".into(),
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
        if let Some(matrix) = capability_matrix("zcode") {
            if let Err(issue) = check_version(&matrix, Some(&info.version)) {
                return HealthReport::degraded(issue);
            }
        }
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
        let args = build_args(opts.mode, opts.resume.as_deref());
        let mut envs = brief::child_env(brief);
        envs.extend(opts.env_allow.iter().cloned());
        let (proc, stdout, stderr) = procmgr::spawn(&self.bin, &args, Some(&opts.workspace), &envs)?;
        let session = DelegateSession::new(
            "zcode",
            &opts.delegate_task_id,
            proc,
            stdout,
            Some(stderr),
            Box::new(ZcodeLineParser),
        );
        // 简报经 stdin 投递（假定口径；对端不读且退出时可能 EPIPE，尽力投递）
        let _ = session.send_input(&brief::render(brief));
        Ok(session)
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

impl From<ZcodeBackend> for Arc<dyn CodingBackend> {
    fn from(b: ZcodeBackend) -> Self {
        Arc::new(b)
    }
}

// ---------------------------------------------------------------------------
// 单元测试（假定协议样例行锁定）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_args_peer_mapping() {
        assert_eq!(mode_args(PermissionMode::Ask), vec!["--mode", "read-only"]);
        assert_eq!(mode_args(PermissionMode::AutoEdit), vec!["--mode", "edit"]);
        assert_eq!(mode_args(PermissionMode::FullAuto), vec!["--mode", "full"]);
    }

    #[test]
    fn build_args_headless_and_resume() {
        let args = build_args(PermissionMode::AutoEdit, None);
        assert_eq!(args, vec!["--headless", "--mode", "edit"]);
        let args = build_args(PermissionMode::Ask, Some("zc-ref"));
        assert_eq!(
            args,
            vec!["--headless", "--mode", "read-only", "--resume", "zc-ref"]
        );
    }

    #[test]
    fn parser_handles_assumed_line_protocol() {
        let mut p = ZcodeLineParser;
        // meta 携带续接句柄
        let evs = p.parse_line(r#"##ZCODE:{"kind":"meta","text":"init","session_ref":"zc-9"}"#);
        assert_eq!(
            evs,
            vec![NormalizedEvent::Meta {
                text: "init".into(),
                session_ref: Some("zc-9".into())
            }]
        );
        // 工具事件（Bash → High）
        let evs = p.parse_line(
            r#"##ZCODE:{"kind":"tool_use","call_id":"z1","tool":"Bash","args":{"command":"make build"}}"#,
        );
        assert!(matches!(
            &evs[0],
            NormalizedEvent::ToolUse { call_id, tool, risk: bbrt_protocol::RiskLevel::High, .. }
            if call_id == "z1" && tool == "Bash"
        ));
        // 工具结果失败
        let evs = p.parse_line(
            r#"##ZCODE:{"kind":"tool_result","call_id":"z1","ok":false,"summary":"build failed"}"#,
        );
        assert!(matches!(
            &evs[0],
            NormalizedEvent::ToolResult { ok: false, summary, .. } if summary == "build failed"
        ));
        // 警告（headless 权限询问）
        let evs = p.parse_line(r#"##ZCODE:{"kind":"warning","text":"permission prompt"}"#);
        assert!(matches!(evs[0], NormalizedEvent::Warning { .. }));
        // 纯文本行 → delta
        let evs = p.parse_line("zcode plain delta");
        assert!(matches!(evs[0], NormalizedEvent::Delta { .. }));
    }
}
