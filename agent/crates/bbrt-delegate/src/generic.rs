//! 通用 CLI 适配器（17 §3.2 通用 CLI 行；D11 §8.2 末段）。
//!
//! 启动形态：`spawn(bin, args)`，stdin 喂渲染后的简报；无权限细粒度映射 →
//! **仅允许 auto-edit 及以上委派 + 强 diff 审查**（17 §5.2 原则：子智能体自主性
//! 不得超过用户授权档位；ask 模式被 [`GenericCliBackend::mode_args`] 拒绝）。
//!
//! 行协议（约定）：结构化事件行 `##BBW:EVT:{json}`（载荷模式见
//! [`crate::normalize::EventPayload`]）→ 归一化事件；其余行 → 文本 delta。
//! 集成测试全部走本适配器 + sh 桩脚本（任务书约定：fake 后端输出特殊前缀行）。

use bbrt_protocol::{PermissionMode, TaskBrief};

use crate::backend::{
    ensure_workspace, BackendProbe, CodingBackend, DelegateError, DelegateSession, FinalReport,
    HealthIssue, HealthReport, LaunchOpts,
};
use crate::brief;
use crate::health::{probe_version, VERSION_PROBE_TIMEOUT_SECS};
use crate::normalize::{parse_prefixed_line, LineParser, NormalizedEvent, GENERIC_EVT_PREFIX};
use crate::procmgr::{self, CancelOutcome};
use std::sync::Arc;

/// 通用行文本协议解析器（`##BBW:EVT:` 前缀 → 事件；其余 → delta）
#[derive(Debug, Default)]
pub struct GenericLineParser;

impl LineParser for GenericLineParser {
    fn parse_line(&mut self, line: &str) -> Vec<NormalizedEvent> {
        parse_prefixed_line(line, GENERIC_EVT_PREFIX)
    }
}

/// 通用 CLI 适配器（bin 可为名字或绝对路径；测试用桩脚本路径注入）
#[derive(Debug, Clone)]
pub struct GenericCliBackend {
    id: &'static str,
    bin: String,
}

impl GenericCliBackend {
    /// 以二进制构造（registry id 固定 "generic"）
    pub fn new(bin: impl Into<String>) -> Self {
        Self {
            id: "generic",
            bin: bin.into(),
        }
    }

    /// 自定义 id 构造（多后端实例场景，如 "codex"/"gemini" 等扩展点，17 §1.3）
    pub fn with_id(bin: impl Into<String>, id: &'static str) -> Self {
        Self {
            id,
            bin: bin.into(),
        }
    }

    /// 目标二进制
    pub fn bin(&self) -> &str {
        &self.bin
    }
}

impl Default for GenericCliBackend {
    fn default() -> Self {
        Self::new("generic-cli")
    }
}

impl CodingBackend for GenericCliBackend {
    fn id(&self) -> &'static str {
        self.id
    }

    fn detect(&self) -> BackendProbe {
        match probe_version(
            &self.bin,
            std::time::Duration::from_secs(VERSION_PROBE_TIMEOUT_SECS),
        ) {
            Some(info) => BackendProbe {
                backend_id: self.id.to_string(),
                installed: true,
                path: Some(info.path),
                version: Some(info.version),
                capabilities: vec!["line-protocol".into(), "stdin-brief".into()],
            },
            None => BackendProbe {
                backend_id: self.id.to_string(),
                installed: false,
                path: None,
                version: None,
                capabilities: Vec::new(),
            },
        }
    }

    fn probe_health(&self) -> HealthReport {
        // 通用后端无版本能力矩阵（无协议可依赖）——installed 即健康；
        // 版本能力断点由强 diff 审查兜底（17 §5.2）
        match self.detect().installed {
            true => HealthReport::healthy(),
            false => HealthReport::degraded(HealthIssue::NotInstalled),
        }
    }

    fn mode_args(&self, mode: PermissionMode) -> Result<Vec<String>, DelegateError> {
        match mode {
            // 无法表达只读限制 → ask 拒绝（§8.2：仅允许 auto-edit 以上）
            PermissionMode::Ask => Err(DelegateError::ModeUnsupported {
                backend: self.id.to_string(),
                mode: "ask".into(),
            }),
            PermissionMode::AutoEdit | PermissionMode::FullAuto => {
                // 无参数可映射；约束经简报文本 + BBW_BRIEF_FORBIDDEN 注入 + 强审查兜底
                Ok(Vec::new())
            }
        }
    }

    fn launch(
        &self,
        brief: &TaskBrief,
        opts: &LaunchOpts,
    ) -> Result<DelegateSession, DelegateError> {
        brief::validate(brief).map_err(|e| DelegateError::InvalidState(e.to_string()))?;
        ensure_workspace(&opts.workspace)?;
        // 映射表前置校验（ask 拒绝在此生效）
        self.mode_args(opts.mode)?;
        if opts.resume.is_some() {
            // 17 §3.2：通用 CLI 不支持续接则每次新会话——显式拒绝避免静默新开
            return Err(DelegateError::NotImplemented(
                "通用 CLI 后端不支持会话续接（17 §3.2：不支持则每次新会话）".into(),
            ));
        }
        let mut envs = brief::child_env(brief);
        envs.extend(opts.env_allow.iter().cloned());
        let (proc, stdout) = procmgr::spawn(&self.bin, &[], Some(&opts.workspace), &envs)?;
        let session = DelegateSession::new(
            self.id,
            &opts.delegate_task_id,
            proc,
            stdout,
            Box::new(GenericLineParser),
        );
        // stdin 喂简报（17 §3.2 启动形态）；子进程不读 stdin 且退出时可能 EPIPE——
        // 写失败不致命（简报已尽力投递），记录为 raw_tail 不可行（无事件流），静默降级
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

/// 便捷转换：Arc<dyn CodingBackend>
impl From<GenericCliBackend> for Arc<dyn CodingBackend> {
    fn from(b: GenericCliBackend) -> Self {
        Arc::new(b)
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_mode_rejected_others_allowed() {
        let b = GenericCliBackend::new("/usr/local/bin/codex");
        assert!(matches!(
            b.mode_args(PermissionMode::Ask),
            Err(DelegateError::ModeUnsupported { .. })
        ));
        assert_eq!(
            b.mode_args(PermissionMode::AutoEdit).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            b.mode_args(PermissionMode::FullAuto).unwrap(),
            Vec::<String>::new()
        );
        // 错误信息引用 17 §5.2 原则语义
        let err = b.mode_args(PermissionMode::Ask).unwrap_err();
        assert!(err.to_string().contains("映射表拒绝"));
    }

    #[test]
    fn parser_maps_event_lines_and_plain_text() {
        let mut p = GenericLineParser;
        let evs = p.parse_line(r#"##BBW:EVT:{"kind":"meta","text":"init"}"#);
        assert!(matches!(evs[0], NormalizedEvent::Meta { .. }));
        let evs = p.parse_line("just text");
        assert!(matches!(evs[0], NormalizedEvent::Delta { .. }));
    }

    #[test]
    fn custom_id_and_bin_accessors() {
        let b = GenericCliBackend::with_id("/opt/codex/bin/codex", "codex");
        assert_eq!(b.id(), "codex");
        assert_eq!(b.bin(), "/opt/codex/bin/codex");
        assert_eq!(GenericCliBackend::default().id(), "generic");
    }
}
