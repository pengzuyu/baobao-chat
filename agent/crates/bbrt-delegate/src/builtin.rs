//! 内置后端桥（17 §5.2 模式 D：无外部后端时的兜底；D11 §2.6 builtin.rs）。
//!
//! v0.1 口径（登记）：内置后端是**进程内** 08 篇自研编码循环（天然归一化事件、
//! 09 篇权限矩阵原生生效、会话文件续接），由编排层（bbrt-session 装配）直连，
//! **不经子进程适配器**。本类型仅作为 registry 的 backend 类型注册占位：
//! - detect 恒可用（17 §1.3 "无依赖，永远可用"）→ 探测/设置页展示与自动降级选择；
//! - launch 返回"未实现"错误（避免调用方误以为存在可用子进程后端——误导防护）。

use bbrt_protocol::{PermissionMode, TaskBrief};

use crate::backend::{
    BackendProbe, CodingBackend, DelegateError, DelegateSession, FinalReport, HealthReport,
    LaunchOpts,
};
use crate::normalize::NormalizedEvent;
use crate::procmgr::CancelOutcome;
use std::sync::Arc;

/// 内置后端桥（注册占位；真实循环在编排层进程内，见模块注释）
#[derive(Debug, Clone, Copy, Default)]
pub struct BuiltinBackend;

impl BuiltinBackend {
    /// 未实现说明（错误信息统一口径）
    const NOT_IMPLEMENTED: &'static str = concat!(
        "内置后端不走子进程适配器：由编排层进程内直连 08 篇编码循环",
        "（17 §5.2 模式 D / 17 §1.3 兜底）；本桥仅用于 registry 注册占位与 detect 恒可用，",
        "避免调用方误解为可 spawn 的后端"
    );

    /// 统一未实现错误
    fn not_implemented() -> DelegateError {
        DelegateError::NotImplemented(Self::NOT_IMPLEMENTED.into())
    }
}

impl CodingBackend for BuiltinBackend {
    fn id(&self) -> &'static str {
        "builtin"
    }

    fn detect(&self) -> BackendProbe {
        BackendProbe {
            backend_id: "builtin".into(),
            installed: true,
            path: None,
            version: None,
            capabilities: vec!["in-process".into(), "always-available".into()],
        }
    }

    fn probe_health(&self) -> HealthReport {
        // 进程内后端无外部依赖：恒健康（降级判断不存在）
        HealthReport::healthy()
    }

    fn mode_args(&self, _mode: PermissionMode) -> Result<Vec<String>, DelegateError> {
        // 09 篇权限矩阵原生生效（无启动参数映射）；空表声明"全部支持"
        Ok(Vec::new())
    }

    fn launch(
        &self,
        _brief: &TaskBrief,
        _opts: &LaunchOpts,
    ) -> Result<DelegateSession, DelegateError> {
        Err(Self::not_implemented())
    }

    fn stream_events(
        &self,
        _session: &DelegateSession,
    ) -> Result<Option<NormalizedEvent>, DelegateError> {
        Err(Self::not_implemented())
    }

    fn cancel(
        &self,
        _session: &DelegateSession,
        _graceful: bool,
    ) -> Result<CancelOutcome, DelegateError> {
        Err(Self::not_implemented())
    }

    fn finalize(&self, _session: &DelegateSession) -> Result<FinalReport, DelegateError> {
        Err(Self::not_implemented())
    }
}

impl From<BuiltinBackend> for Arc<dyn CodingBackend> {
    fn from(b: BuiltinBackend) -> Self {
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
    fn detect_always_available() {
        let b = BuiltinBackend;
        let probe = b.detect();
        assert_eq!(probe.backend_id, "builtin");
        assert!(probe.installed);
        assert!(probe.capabilities.contains(&"always-available".to_string()));
        assert!(b.probe_health().ok);
        assert!(b.mode_args(PermissionMode::Ask).is_ok());
    }

    #[test]
    fn launch_returns_not_implemented_with_registry_note() {
        // DelegateSession 无 Debug（含管道/解析器），用 match 断言而非 unwrap_err
        match BuiltinBackend.launch(&fake_brief(), &fake_opts()) {
            Err(DelegateError::NotImplemented(msg)) => {
                assert!(msg.contains("进程内") && msg.contains("17 §5.2"))
            }
            Err(other) => panic!("期望 NotImplemented，实际 {other}"),
            Ok(_) => panic!("内置后端 launch 不应成功"),
        }
    }

    fn fake_brief() -> TaskBrief {
        TaskBrief {
            task: "t".into(),
            workspace: "/tmp".into(),
            constraints: vec![],
            context: vec![],
            acceptance: vec![],
            forbidden: vec![],
        }
    }

    fn fake_opts() -> LaunchOpts {
        LaunchOpts::new("d-1", "s-1", PermissionMode::AutoEdit, "/tmp")
    }
}
