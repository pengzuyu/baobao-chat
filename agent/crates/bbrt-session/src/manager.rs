//! 多会话管理（D11 §2.2 manager.rs）：
//! 活跃会话 ≤3（超出拒绝）；session.start/end 的存储生命周期；
//! 宿主消息分发入口（bin 装配调用；turn 在独立线程跑，
//! 审批回执经 permission_tx 路由表注入——sender 在 start 时克隆入表，
//! receiver 随 runner 被 turn 线程取走，二者互不阻塞）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, RwLock};

use bbrt_store::Store;

use bbrt_sec::gate::PermissionMode;
use bbrt_store::SessionRow;

use crate::events::{ModelTier, SessionEvent};
use crate::loop_runner::{LoopDeps, PermissionResponse, SessionRunner};
use crate::state::SessionState;

/// D19 会话工作区表（bin 装配共享给 tools 管线做按会话沙箱路由）：
/// session_id → Some(项目目录) / None(日常对话)。克隆共享同一底层表。
#[derive(Clone, Default)]
pub struct SessionWorkspaces(std::sync::Arc<Mutex<HashMap<String, Option<std::path::PathBuf>>>>);

impl SessionWorkspaces {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记/更新会话工作目录（None=日常）
    pub fn set(&self, session_id: &str, ws: Option<std::path::PathBuf>) {
        self.0.lock().unwrap().insert(session_id.to_string(), ws);
    }

    /// 会话移除（session.end）
    pub fn remove(&self, session_id: &str) {
        self.0.lock().unwrap().remove(session_id);
    }

    /// 查询：None=未登记（工具层回落兜底工作区，兼容无装配测试）；
    /// Some(None)=日常；Some(Some(path))=项目会话
    pub fn get(&self, session_id: &str) -> Option<Option<std::path::PathBuf>> {
        self.0.lock().unwrap().get(session_id).cloned()
    }
}

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
    /// 会话级模型直达引用（0023：p:<provider_id>:<model>；None=档位别名）
    pub model_override: Option<String>,
    pub title: String,
    /// 崩溃恢复产物（session.start 带 historyRef 时由装配层先行 recover；
    /// None=全新会话）
    pub restored: Option<crate::recovery::ReplayReport>,
    /// D35 定时任务：无人值守（禁 ask_user + 提示词约束）
    pub unattended: bool,
    /// D35 定时任务：审批等待秒数（None=默认 120s；Some(0)=不超时）
    pub approval_timeout_secs: Option<u64>,
    /// 会话场景（2026-11-23 三区块场景提示词）：创建方判定（workspace 非空=
    /// Project / origin=embedded=Embedded{conv_id} / 其余=Task）。落库 form+
    /// conv_id 供复活还原；注入 runner 拼 SYSTEM_PROMPT 场景段
    pub scene: crate::loop_runner::Scene,
}

struct ManagedSession {
    /// turn 线程取走执行、结束归还（None=进行中）
    runner: Mutex<Option<SessionRunner>>,
    /// 中断旗（与 runner.interrupted 同一 Arc 单独存）：回合进行中 runner 被
    /// turn 线程取走（runner=None），interrupt() 若只对 runner 置旗则永远置
    /// 不上——停止按钮全链路回执"成功"却无效果。持 Arc 才能穿透取走窗口
    interrupt_flag: Arc<AtomicBool>,
    /// 权限模式（与 runner.mode 同一 RwLock 单独存，同中断旗理由）：
    /// session.set_mode 中途切档即时生效，不依赖 runner 归还
    mode: Arc<RwLock<PermissionMode>>,
    state: Mutex<SessionState>,
    /// 工作区路径（手动检查点/恢复时 bin 解析 workspace 用；runner 可能被 turn 线程取走故单独存）
    workspace: String,
}

/// SessionManager：装配件（模型/工具/记忆/WAL/sink）+ 会话表 + 审批路由
pub struct SessionManager {
    pub deps: LoopDeps,
    /// rusqlite !Sync → Mutex 包裹跨线程共享（bin 装配构造一次）
    store: Option<Arc<Mutex<Store>>>,
    sessions: Mutex<HashMap<String, Arc<ManagedSession>>>,
    /// 审批回执路由（session_id → runner channel sender）
    permission_tx: Mutex<HashMap<String, Sender<PermissionResponse>>>,
    /// 澄清回执路由表（D20 ask_user）
    clarify_tx: Mutex<HashMap<String, Sender<crate::loop_runner::ClarifyAnswer>>>,
    /// 后台任务中枢（D16 §5：探查/专家超窗与终端后台命令的取消
    /// 路由 + join parking；start 时注入 runner 共享）
    hub: Arc<crate::bg_hub::BgHub>,
    /// D19 会话工作区表（bin 装配时与 tools 管线共享同一实例；start/end 维护）
    pub workspaces: SessionWorkspaces,
}

impl SessionManager {
    pub fn new(deps: LoopDeps, store: Option<Arc<Mutex<Store>>>) -> Self {
        Self {
            deps,
            store,
            sessions: Mutex::new(HashMap::new()),
            permission_tx: Mutex::new(HashMap::new()),
            clarify_tx: Mutex::new(HashMap::new()),
            hub: Arc::new(crate::bg_hub::BgHub::new()),
            workspaces: SessionWorkspaces::new(),
        }
    }

    /// session.start（D11 §3 #1/#2）：建档 + WAL 起点 + 审批路由 + session.ready
    /// 启动；Ok 携带恢复摘要（restored/replayed_events，未恢复为 false/0）。
    /// D19：workspace 非空 → realpath 归一 + upsert agent_workspace + 回填
    /// workspace_id（修 D11 既留缺口）；空串=日常对话（不挂工作区）。
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
        // D19 workspace realpath 归一（runner/沙箱/记忆分区/WAL 全链同一规范路径；
        // 空串=日常对话原样保留）
        let workspace_real = if p.workspace.is_empty() {
            String::new()
        } else {
            std::fs::canonicalize(&p.workspace)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| p.workspace.clone())
        };
        // D19 项目登记（workspace 非空）：realpath 归一后 upsert——
        // 同目录重复打开不换身份；is_repo=.git 探测；trusted=注册即信任
        // （目录选择对话框是显式动作，D08 §4.4 精细信任确认登记阶段二）
        let workspace_id = if workspace_real.is_empty() {
            None
        } else {
            self.store.as_ref().map(|store| {
                let store = store.lock().unwrap();
                register_workspace(&store, &workspace_real, None, now as i64)
            })
        };
        // D19 会话工作区表登记（tools 管线按会话路由沙箱；None=日常）
        self.workspaces.set(
            &session_id,
            if workspace_real.is_empty() {
                None
            } else {
                Some(std::path::PathBuf::from(&workspace_real))
            },
        );
        if let Some(store) = &self.store {
            let store = store.lock().unwrap();
            // 恢复路径：会话行已存在（首启动时落库），改插为更防唯一键冲突
            let is_restore = p.restored.as_ref().is_some_and(|r| r.found);
            if is_restore {
                let _ = store.update_session(&session_id, "idle", None);
            }
            let row = SessionRow {
                id: session_id.clone(),
                workspace_id: workspace_id.clone(),
                title: p.title.clone(),
                // form 场景取值（2026-11-23）：embedded=日常对话（conv_id 列带
                // IM 来源）；其余落 workbench（表 CHECK 约束 IN('embedded','workbench')，
                // 不重建表）——复活判定：workspace 非空=项目 / form=embedded=日常 /
                // workbench+空 workspace=任务
                form: match &p.scene {
                    crate::loop_runner::Scene::Embedded { .. } => "embedded".into(),
                    _ => "workbench".into(),
                },
                mode: match p.mode {
                    bbrt_sec::gate::PermissionMode::Ask => "ask",
                    bbrt_sec::gate::PermissionMode::AutoEdit => "auto-edit",
                    bbrt_sec::gate::PermissionMode::FullAuto => "full-auto",
                }
                .to_string(),
                model_policy: format!("{:?}", p.model_policy).to_lowercase(),
                model_override: p.model_override.clone(),
                status: "idle".into(),
                share_enabled: false,
                created_at: now as i64,
                updated_at: now as i64,
                ended_at: None,
                summary: None,
                conv_id: match &p.scene {
                    crate::loop_runner::Scene::Embedded { conv_id, .. } => Some(conv_id.clone()),
                    _ => None,
                },
            };
            if is_restore {
                // 状态已更新，跳过插入（行已存在）；恢复路径顺带回填最新归属
                if let Some(ws_id) = &workspace_id {
                    let _ = store.set_session_workspace(&session_id, Some(ws_id));
                }
            } else {
                store
                    .insert_session(&row)
                    .map_err(|e| ManagerError::Store(e.to_string()))?;
            }
        }
        let mut runner = SessionRunner::new(
            session_id.clone(),
            workspace_real.clone(),
            p.mode,
            p.model_policy,
            p.model_override.clone(),
        );
        // 后台任务中枢注入（D16 §5：经 manager 的会话恒可后台；
        // raw runner（测试/嵌入式）保持 None=退化）
        runner.bg_hub = Some(self.hub.clone());
        // D35 定时任务：无人值守 + 审批等待窗口（None=默认 120s；0=不超时）
        runner.unattended = p.unattended;
        // 场景注入（2026-11-23）：SYSTEM_PROMPT 末尾场景段由 runner 消费
        runner.scene = p.scene.clone();
        if let Some(secs) = p.approval_timeout_secs {
            runner.permission_timeout = if secs == 0 {
                // recv_timeout 不支持无限：一年近似“不超时”，用户仍可「取消运行」
                std::time::Duration::from_secs(365 * 24 * 3600)
            } else {
                std::time::Duration::from_secs(secs.min(7 * 24 * 3600))
            };
        }
        self.permission_tx
            .lock()
            .unwrap()
            .insert(session_id.clone(), runner.permission_sender());
        self.clarify_tx
            .lock()
            .unwrap()
            .insert(session_id.clone(), runner.clarify_sender());
        self.deps.wal.append(
            &session_id,
            "session.start",
            &format!(
                "{{\"workspace\":\"{workspace_real}\",\"scene\":\"{}\"}}",
                match &p.scene {
                    crate::loop_runner::Scene::Project => "project".to_string(),
                    crate::loop_runner::Scene::Embedded { conv_id, .. } => {
                        // conv_id 转义（数字 ID 常态，防御性处理）
                        format!("embedded:{conv_id}")
                    }
                    crate::loop_runner::Scene::Task => "task".to_string(),
                }
            ),
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
        // 中断旗句柄：runner move 进会话表前克隆（interrupt() 经此置旗，
        // 不依赖可能被 turn 线程取走的 runner）
        let interrupt_handle = runner.interrupted.clone();
        // 模式句柄：同上（set_mode 经此改写，与 runner.mode 同一 RwLock）
        let mode_handle = runner.mode_handle();
        guard.insert(
            session_id,
            Arc::new(ManagedSession {
                runner: Mutex::new(Some(runner)),
                // 中断旗与 runner.interrupted 同一 Arc（run_turn 开头清旗同一实例，
                // 新一轮不受上一轮中断影响）
                interrupt_flag: interrupt_handle.clone(),
                mode: mode_handle.clone(),
                state: Mutex::new(SessionState::Idle),
                workspace: workspace_real.clone(),
            }),
        );
        Ok(summary)
    }

    /// 会话工作区（bin 手动检查点/恢复解析 workspace 用）
    pub fn workspace_of(&self, session_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.workspace.clone())
    }

    /// user.message：取走 runner 在调用线程跑一轮（bin 侧自行 spawn 线程）
    pub fn run_turn(
        &self,
        session_id: &str,
        text: &str,
        thinking: Option<bbrt_protocol::ThinkingLevel>,
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
        // 后台产物注入（D16 §5：超窗探查/专家的摘要在此回填主上下文，
        // 以 subagent.join/expert.join 轮次参与本轮组装）
        for join in self.hub.drain_joins(session_id) {
            runner.inject_bg_join(&join.run_id, &join.name, &join.summary);
        }
        let report = runner.run_turn(text, &self.deps, thinking);
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

    /// clarify.response 路由（D20；ask_user 阻塞等待的回执注入）
    pub fn respond_clarify(
        &self,
        session_id: &str,
        answer: crate::loop_runner::ClarifyAnswer,
    ) -> Result<(), ManagerError> {
        let tx = self
            .clarify_tx
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| ManagerError::NotFound(session_id.into()))?;
        tx.send(answer)
            .map_err(|_| ManagerError::NotFound(session_id.into()))
    }

    /// 后台 run 指令定向路由（P0-2②：run_id 精确命中注册表；未命中报
    /// NotFound——run 已结束/未知 id，不静默）。宿主 run.cancel 与模型侧
    /// subagent.adjust（经 loop_runner 内 hub 直连）互补。
    pub fn respond_run_cancel(
        &self,
        run_id: &str,
        msg: crate::loop_runner::BgHostMsg,
    ) -> Result<(), ManagerError> {
        if self.hub.route(run_id, &msg) {
            return Ok(());
        }
        Err(ManagerError::NotFound(format!("后台 run {run_id}")))
    }

    /// model.switch（D11 §4 ModelSwitched 产生方）：空闲会话档位切换 →
    /// 事件 + WAL。turn 进行中（runner 被取走）返回 Busy——排队切换随
    /// 阶段二登记（切换通常发生在空闲的设置面板场景，v0.1 空闲即切）。
    /// session_id None=全部活跃会话；同档幂等不产生事件。
    pub fn switch_model(
        &self,
        session_id: Option<&str>,
        to: crate::events::ModelTier,
        model_override: Option<&str>,
        reason: &str,
    ) -> Result<usize, ManagerError> {
        let entries: Vec<(String, Arc<ManagedSession>)> = {
            let sessions = self.sessions.lock().unwrap();
            match session_id {
                Some(id) => {
                    let e = sessions
                        .get(id)
                        .cloned()
                        .ok_or_else(|| ManagerError::NotFound(id.into()))?;
                    vec![(id.to_string(), e)]
                }
                None => sessions
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            }
        };
        let mut switched = 0usize;
        for (sid, entry) in entries {
            let mut guard = entry.runner.lock().unwrap();
            let Some(runner) = guard.as_mut() else {
                continue; // turn 中：跳过该会话（广播语义尽力而为）
            };
            let from = runner.model_policy;
            if from == to && runner.model_override.as_deref() == model_override {
                continue; // 同档且同 override：幂等
            }
            runner.model_policy = to;
            runner.model_override = model_override.map(str::to_string);
            drop(guard);
            // 持久化（修既有缺陷：此前切换不回写 agent_session，重启即丢）
            if let Some(store) = &self.store {
                let _ = store.lock().unwrap().update_session_model(
                    &sid,
                    &format!("{to:?}").to_lowercase(),
                    model_override,
                );
            }
            self.deps
                .sink
                .emit(crate::events::SessionEvent::ModelSwitched {
                    session_id: sid.clone(),
                    from,
                    to,
                    model_override: model_override.map(str::to_string),
                    reason: reason.to_string(),
                });
            self.deps.wal.append(
                &sid,
                "model.switched",
                &format!(
                    "{{\"from\":\"{from:?}\",\"to\":\"{to:?}\",\"model\":{},\"reason\":\"{}\"}}",
                    match model_override {
                        Some(m) => format!("\"{m}\""),
                        None => "null".to_string(),
                    },
                    reason
                ),
            );
            switched += 1;
        }
        Ok(switched)
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
        // D19：会话工作区表同步移除（工具管线不再路由到该会话）
        self.workspaces.remove(session_id);
        // 后台任务收口（会话结束=本会话全部后台 run 优雅取消；
        // 线程自注销不阻塞收口）
        self.hub.cancel_session(session_id);
        Ok(())
    }

    /// run 清单（D16 §3.1：runs.list REQ 数据源；None=全部会话）。
    /// agent_run 行 camelCase 序列化直出（协议 payload 口径）
    pub fn list_runs(&self, session_id: Option<&str>) -> Vec<serde_json::Value> {
        let Some(store) = &self.store else {
            return vec![];
        };
        let store = store.lock().unwrap();
        let rows = match session_id {
            Some(sid) => store.runs_of(sid).unwrap_or_default(),
            None => store.runs_all().unwrap_or_default(),
        };
        rows.into_iter()
            .filter_map(|r| serde_json::to_value(&r).ok())
            .collect()
    }

    /// 活跃会话数（runtime.ready 上报）
    pub fn active_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    /// 暂停/紧急停止旗标（循环在事件/步间检查；未决审批作废由等待循环轮询旗收口）。
    /// 对 entry.interrupt_flag 置旗而非 runner——回合进行中 runner 被 turn 线程
    /// 取走（旧实现静默跳过=点停止全链路回执成功却无效果）
    pub fn interrupt(&self, session_id: &str) -> Result<(), ManagerError> {
        let guard = self.sessions.lock().unwrap();
        let entry = guard
            .get(session_id)
            .ok_or_else(|| ManagerError::NotFound(session_id.into()))?;
        entry.interrupt_flag.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// 会话中途切权限模式（session.set_mode；补协议缺口——此前模式只随
    /// session.start 进 runtime，中途切档 UI 已变、门控仍按旧模式审批）。
    /// 经 entry.mode（与 runner.mode 同一 RwLock）改写：回合进行中 runner
    /// 被取走也即时生效，下一个工具调用按新模式门控
    pub fn set_mode(&self, session_id: &str, mode: PermissionMode) -> Result<(), ManagerError> {
        let guard = self.sessions.lock().unwrap();
        let entry = guard
            .get(session_id)
            .ok_or_else(|| ManagerError::NotFound(session_id.into()))?;
        *entry.mode.write().unwrap() = mode;
        Ok(())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 工作区 id 序列（ws-<ms>-<n>；进程内单调）
static WS_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// D19 工作区登记（协议 workspace.register 与 session.start 自动挂靠共用）：
/// realpath 归一（别名同身份）→ 查既有行保 id/created_at → upsert。
/// 返回登记后的 workspace id。name 缺省=目录名；is_repo=.git 探测；
/// trusted=true（目录选择即显式信任，D08 §4.4 精细确认阶段二）。
pub fn register_workspace(
    store: &bbrt_store::Store,
    path: &str,
    name: Option<&str>,
    now: i64,
) -> String {
    let raw = std::path::PathBuf::from(path);
    let real = std::fs::canonicalize(&raw).unwrap_or(raw);
    let path_str = real.to_string_lossy().into_owned();
    let default_name = real
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("项目")
        .to_string();
    let name = name.map(str::to_string).unwrap_or(default_name);
    let is_repo = real.join(".git").exists();
    let existing = store.get_workspace_by_path(&path_str).ok().flatten();
    let (id, created_at) = existing.map(|w| (w.id, w.created_at)).unwrap_or_else(|| {
        let seq = WS_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        (format!("ws-{now}-{seq}"), now)
    });
    let _ = store.upsert_workspace(&bbrt_store::Workspace {
        id: id.clone(),
        path: path_str,
        name,
        is_repo,
        trusted: true,
        extra_dirs: None,
        last_opened_at: now,
        created_at,
    });
    id
}
