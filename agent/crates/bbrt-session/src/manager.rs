//! 多会话管理（D11 §2.2 manager.rs）：
//! 活跃会话 ≤3（超出拒绝）；session.start/end 的存储生命周期；
//! 宿主消息分发入口（bin 装配调用；turn 在独立线程跑，
//! 审批回执经 permission_tx 路由表注入——sender 在 start 时克隆入表，
//! receiver 随 runner 被 turn 线程取走，二者互不阻塞）。

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use bbrt_store::Store;

use bbrt_sec::gate::PermissionMode;
use bbrt_store::SessionRow;

use crate::events::{ModelTier, SessionEvent};
use crate::loop_runner::{LoopDeps, PermissionResponse, SessionRunner};
use crate::state::SessionState;

/// 管理错误（bin 映射为 error 协议消息）
#[derive(Debug, thiserror::Error)]
pub enum ManagerError {
    #[error("活跃会话已达上限（3），请先结束旧会话")]
    TooManyActive,
    #[error("会话不存在: {0}")]
    NotFound(String),
    #[error("会话 {0} 正在处理上一条输入")]
    Busy(String),
    #[error("存储错误: {0}")]
    Store(String),
}

/// 启动结果摘要（session.ready 回执口径）
#[derive(Debug, Clone, Copy)]
pub struct RestoredSummary {
    pub restored: bool,
    pub replayed_events: u32,
}

/// 会话启动参数（宿主 session.start 载荷子集）
pub struct StartParams {
    pub workspace: String,
    pub mode: PermissionMode,
    pub model_policy: ModelTier,
    pub title: String,
    /// 崩溃恢复产物（session.start 带 historyRef 时由装配层先行 recover；
    /// None=全新会话）
    pub restored: Option<crate::recovery::ReplayReport>,
}

struct ManagedSession {
    /// turn 线程取走执行、结束归还（None=进行中）
    runner: Mutex<Option<SessionRunner>>,
    state: Mutex<SessionState>,
}

/// SessionManager：装配件（模型/工具/记忆/WAL/sink）+ 会话表 + 审批路由
pub struct SessionManager {
    pub deps: LoopDeps,
    /// rusqlite !Sync → Mutex 包裹跨线程共享（bin 装配构造一次）
    store: Option<Arc<Mutex<Store>>>,
    sessions: Mutex<HashMap<String, Arc<ManagedSession>>>,
    /// 审批回执路由（session_id → runner channel sender）
    permission_tx: Mutex<HashMap<String, Sender<PermissionResponse>>>,
}

impl SessionManager {
    pub fn new(deps: LoopDeps, store: Option<Arc<Mutex<Store>>>) -> Self {
        Self {
            deps,
            store,
            sessions: Mutex::new(HashMap::new()),
            permission_tx: Mutex::new(HashMap::new()),
        }
    }

    /// session.start（D11 §3 #1/#2）：建档 + WAL 起点 + 审批路由 + session.ready
    /// 启动；Ok 携带恢复摘要（restored/replayed_events，未恢复为 false/0）
    pub fn start(
        &self,
        session_id: String,
        p: StartParams,
    ) -> Result<RestoredSummary, ManagerError> {
        let mut guard = self.sessions.lock().unwrap();
        if guard.len() >= 3 && !guard.contains_key(&session_id) {
            return Err(ManagerError::TooManyActive);
        }
        let now = now_ms();
        if let Some(store) = &self.store {
            let store = store.lock().unwrap();
            // 恢复路径：会话行已存在（首启动时落库），改插为更防唯一键冲突
            let is_restore = p.restored.as_ref().is_some_and(|r| r.found);
            if is_restore {
                let _ = store.update_session(&session_id, "idle", None);
            }
            let row = SessionRow {
                id: session_id.clone(),
                workspace_id: None,
                title: p.title.clone(),
                form: "workbench".into(),
                mode: format!("{:?}", p.mode).to_lowercase(),
                backend: None,
                model_policy: format!("{:?}", p.model_policy).to_lowercase(),
                status: "idle".into(),
                share_enabled: false,
                created_at: now as i64,
                updated_at: now as i64,
                ended_at: None,
                summary: None,
            };
            if is_restore {
                // 状态已更新，跳过插入（行已存在）
            } else {
                store
                    .insert_session(&row)
                    .map_err(|e| ManagerError::Store(e.to_string()))?;
            }
        }
        let mut runner = SessionRunner::new(
            session_id.clone(),
            p.workspace.clone(),
            p.mode,
            p.model_policy,
        );
        self.permission_tx
            .lock()
            .unwrap()
            .insert(session_id.clone(), runner.permission_sender());
        self.deps.wal.append(
            &session_id,
            "session.start",
            &format!("{{\"workspace\":\"{}\"}}", p.workspace),
        );
        let (restored, replayed) = match &p.restored {
            Some(rep) if rep.found => (true, rep.replayed_events),
            _ => (false, 0),
        };
        // 恢复注入：重放出的历史时间线交还 runner（续会话不丢上下文，D11 §9.2-2）
        if let Some(rep) = &p.restored {
            runner.restore_history(rep.history.clone());
        }
        self.deps.sink.emit(SessionEvent::SessionReady {
            session_id: session_id.clone(),
            restored,
            replayed_events: replayed,
        });
        let summary = RestoredSummary {
            restored,
            replayed_events: replayed,
        };
        guard.insert(
            session_id,
            Arc::new(ManagedSession {
                runner: Mutex::new(Some(runner)),
                state: Mutex::new(SessionState::Idle),
            }),
        );
        Ok(summary)
    }

    /// user.message：取走 runner 在调用线程跑一轮（bin 侧自行 spawn 线程）
    pub fn run_turn(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<crate::loop_runner::TurnReport, ManagerError> {
        let entry = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| ManagerError::NotFound(session_id.into()))?;
        let mut runner = entry
            .runner
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| ManagerError::Busy(session_id.into()))?;
        let report = runner.run_turn(text, &self.deps);
        *entry.state.lock().unwrap() = runner.state();
        *entry.runner.lock().unwrap() = Some(runner);
        Ok(report)
    }

    /// permission.response 路由（router 持有的 sender 克隆即时投递）
    pub fn respond_permission(
        &self,
        session_id: &str,
        resp: PermissionResponse,
    ) -> Result<(), ManagerError> {
        let tx = self
            .permission_tx
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| ManagerError::NotFound(session_id.into()))?;
        tx.send(resp)
            .map_err(|_| ManagerError::NotFound(session_id.into()))
    }

    /// session.end：runner 收口 + 存档 + WAL 闭合 + 路由清理。
    /// 竞态容忍：turn 线程尚未归还 runner 时短轮询等待（turn 已至收尾，≤2s）
    pub fn end(&self, session_id: &str, summary: &str) -> Result<(), ManagerError> {
        let entry = self.sessions.lock().unwrap().get(session_id).cloned();
        let Some(entry) = entry else { return Ok(()) };
        let runner = {
            let mut waited = 0u64;
            loop {
                if let Some(r) = entry.runner.lock().unwrap().take() {
                    break Some(r);
                }
                if waited >= 2000 {
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
                waited += 20;
            }
        };
        if let Some(mut r) = runner {
            r.end(&self.deps, summary);
        }
        if let Some(store) = &self.store {
            let _ = store.lock().unwrap().update_session(
                session_id,
                "ended",
                if summary.is_empty() {
                    None
                } else {
                    Some(summary)
                },
            );
        }
        self.sessions.lock().unwrap().remove(session_id);
        self.permission_tx.lock().unwrap().remove(session_id);
        Ok(())
    }

    /// 活跃会话数（runtime.ready 上报）
    pub fn active_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    /// 暂停/紧急停止旗标（循环在事件/步间检查；未决权限作废由超时兜底）
    pub fn interrupt(&self, session_id: &str) -> Result<(), ManagerError> {
        let guard = self.sessions.lock().unwrap();
        let entry = guard
            .get(session_id)
            .ok_or_else(|| ManagerError::NotFound(session_id.into()))?;
        if let Some(r) = entry.runner.lock().unwrap().as_ref() {
            r.interrupted
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
