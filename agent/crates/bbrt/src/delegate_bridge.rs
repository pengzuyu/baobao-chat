//! bin 侧委派装配：BackendRegistry + 工作区锁 → session 的 DelegateLauncher 适配。
//! 会话→bbrt-delegate 的枚举镜像映射也集中于此（依赖倒置的另一半）。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bbrt_delegate::backend::{BackendRegistry, CodingBackend, DelegateSession, LaunchOpts};
use bbrt_delegate::normalize::NormalizedEvent;
use bbrt_delegate::workspace_lock::{acquire_workspace_lock, WorkspaceLockGuard};
use bbrt_delegate::{BuiltinBackend, ClaudeBackend, GenericCliBackend, ZcodeBackend};
use bbrt_protocol::RiskLevel;

use bbrt_session::delegation::{
    DelegateChannel, DelegateEvt, DelegateFinal, DelegateLaunchReq, DelegateLauncher,
    DelegateStream,
};

/// 装配：注册三真实后端 + builtin 占位（可用性由 detect 决定）
pub fn bin_delegate_launcher() -> Arc<RegistryLauncher> {
    let mut reg = BackendRegistry::new();
    let _ = reg.register(Arc::new(ClaudeBackend::new()));
    let _ = reg.register(Arc::new(ZcodeBackend::new()));
    let _ = reg.register(Arc::new(GenericCliBackend::new("codex"))); // 通用 CLI 示例注册
    let _ = reg.register(Arc::new(BuiltinBackend));
    Arc::new(RegistryLauncher {
        registry: Mutex::new(reg),
    })
}

/// registry 启动器：launch 内完成 锁获取 → 健康检查 → 启动
pub struct RegistryLauncher {
    registry: Mutex<BackendRegistry>,
}

impl DelegateLauncher for RegistryLauncher {
    fn backends(&self) -> Vec<String> {
        self.registry
            .lock()
            .unwrap()
            .detect_all()
            .into_iter()
            .map(|p| p.backend_id)
            .collect()
    }

    fn launch(&self, req: &DelegateLaunchReq) -> Result<Box<dyn DelegateStream>, String> {
        let reg = self.registry.lock().unwrap();
        let backend = reg
            .get(&req.backend)
            .ok_or_else(|| format!("后端未注册(8030): {}", req.backend))?;
        // 工作区互斥（17 §5.1；占用→8035 语义）
        let ws = PathBuf::from(&req.brief.workspace);
        let lock = acquire_workspace_lock(&ws).map_err(|e| e.to_string())?;
        // 健康检查（未安装/版本不符 → 8030/8031 文案）
        let health = backend.probe_health();
        if !health.ok {
            return Err(format!("后端不可用(8030/8031): {:?}", health.degraded));
        }
        let mode = match req.mode {
            bbrt_sec::gate::PermissionMode::Ask => bbrt_protocol::PermissionMode::Ask,
            bbrt_sec::gate::PermissionMode::AutoEdit => bbrt_protocol::PermissionMode::AutoEdit,
            bbrt_sec::gate::PermissionMode::FullAuto => bbrt_protocol::PermissionMode::FullAuto,
        };
        let opts = LaunchOpts::new(
            req.delegate_task_id.clone(),
            parent_session_of(req),
            mode,
            ws,
        );
        let session = backend
            .launch(&req.brief, &opts)
            .map_err(|e| e.to_string())?;
        Ok(Box::new(SessionStream {
            backend,
            session,
            _lock: lock,
        }))
    }
}

/// parent_session_id：session 契约未带（会话内隐式），审计关联由事件流 session_id 承担
fn parent_session_of(_req: &DelegateLaunchReq) -> String {
    String::new()
}

/// 单会话事件流适配：NormalizedEvent → DelegateEvt 镜像（持锁至流销毁）
struct SessionStream {
    backend: Arc<dyn CodingBackend>,
    session: DelegateSession,
    _lock: WorkspaceLockGuard,
}

impl DelegateStream for SessionStream {
    fn next(&mut self) -> Option<DelegateEvt> {
        match self.backend.stream_events(&self.session) {
            Ok(Some(evt)) => Some(map_event(evt)),
            Ok(None) => None,
            Err(e) => Some(DelegateEvt::Warning {
                text: e.to_string(),
            }),
        }
    }

    fn cancel(&mut self, graceful: bool) {
        let _ = self.backend.cancel(&self.session, graceful);
    }

    fn finalize(&mut self) -> DelegateFinal {
        match self.backend.finalize(&self.session) {
            Ok(rep) => DelegateFinal {
                summary: rep.summary,
                changed_files: rep.changed_files,
                session_ref: rep.session_ref,
                exit_code: rep.exit.exit_code,
            },
            Err(e) => DelegateFinal {
                summary: e.to_string(),
                changed_files: vec![],
                session_ref: None,
                exit_code: Some(-1),
            },
        }
    }
}

/// 归一化事件映射（risk 枚举转字符串标签）
fn map_event(evt: NormalizedEvent) -> DelegateEvt {
    match evt {
        NormalizedEvent::Meta { text, session_ref } => DelegateEvt::Meta { text, session_ref },
        NormalizedEvent::Delta { channel, text } => DelegateEvt::Delta {
            channel: match channel {
                bbrt_protocol::StreamChannel::Text => DelegateChannel::Text,
                _ => DelegateChannel::Reasoning,
            },
            text,
        },
        NormalizedEvent::ToolUse {
            call_id,
            tool,
            args,
            risk,
        } => DelegateEvt::ToolUse {
            call_id,
            tool,
            args,
            risk: match risk {
                RiskLevel::Low => "low",
                RiskLevel::Medium => "medium",
                RiskLevel::High => "high",
            },
        },
        NormalizedEvent::ToolResult {
            call_id,
            ok,
            summary,
        } => DelegateEvt::ToolResult {
            call_id,
            ok,
            summary,
        },
        NormalizedEvent::Warning { text } => DelegateEvt::Warning { text },
        NormalizedEvent::Exit { exit_code, signal } => DelegateEvt::Exit { exit_code, signal },
    }
}
