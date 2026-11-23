//! 用户 Agent 定时任务（D35）：纯本地调度。
//!
//! 任务定义/调度/执行/历史全在 Tauri 壳（`{appData}/agent-runtime/schedules/`）：
//! - `tasks.json` 任务定义（原子写）
//! - `runs.jsonl` 运行历史（每任务保留最近 50 条）
//! - `calendar-<year>.json` 工作日日历缓存（服务端只读同步）
//! 到点用现有 `session.start`（unattended=true）+ `user.message` 驱动本地 Runtime；
//! 权限审批仍走会话内 D33 内嵌卡（没人点就等 `approvalTimeoutSecs`）。

mod calendar;
mod cron;

pub use calendar::{CalendarCache, CalendarDay, CalendarStore};

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, NaiveDateTime, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent_bridge::AgentHost;

const RUNS_KEEP_PER_TASK: usize = 50;
const RUNS_KEEP_TOTAL: usize = 5000;
const ONCE_GRACE_MS: i64 = 24 * 3600 * 1000;
const MISS_LATE_MS: i64 = 60_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

fn local_to_ms(dt: NaiveDateTime) -> Option<i64> {
    Local
        .from_local_datetime(&dt)
        .single()
        .or_else(|| Local.from_local_datetime(&dt).earliest())
        .map(|d| d.timestamp_millis())
}

fn ms_to_local(ms: i64) -> NaiveDateTime {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.naive_local())
        .unwrap_or_else(|| {
            Local
                .timestamp_millis_opt(0)
                .unwrap()
                .naive_local()
        })
}

fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("目录创建失败：{e}"))?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("json")
    ));
    fs::write(&tmp, data).map_err(|e| format!("写入失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("落盘失败：{e}"))
}

// ── 数据模型 ────────────────────────────────────────────────────────────────

/// 三种互斥调度类型
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScheduleType {
    /// 5 字段 cron（分 时 日 月 周）
    Cron { expr: String },
    /// 一次性（epoch ms；执行后 completed）
    Once { at: i64 },
    /// 每个工作日 HH:mm（查本地日历缓存）
    Workday { time: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub workspace: String,
    pub schedule: ScheduleType,
    #[serde(default = "default_model_policy")]
    pub model_policy: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_approval")]
    pub approval_timeout_secs: u64,
    #[serde(default = "default_status")]
    pub status: String, // active | paused | completed | expired
    #[serde(default)]
    pub next_run_at: Option<i64>,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_model_policy() -> String {
    "auto".into()
}
fn default_mode() -> String {
    "ask".into()
}
fn default_approval() -> u64 {
    1800
}
fn default_status() -> String {
    "active".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub task_id: String,
    pub planned_at: i64,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub finished_at: Option<i64>,
    pub status: String, // running | success | failed | missed | expired | waiting_approval
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct TaskFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    tasks: Vec<Task>,
}

/// 新建/编辑入参（camelCase 与前端一致）
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub workspace: String,
    pub schedule: ScheduleType,
    #[serde(default)]
    pub model_policy: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub approval_timeout_secs: Option<u64>,
}

// ── 存储 ────────────────────────────────────────────────────────────────────

pub struct Store {
    dir: PathBuf,
    tasks: Mutex<Vec<Task>>,
    runs: Mutex<Vec<Run>>,
    wake: Mutex<Option<mpsc::Sender<()>>>,
    pub calendar: CalendarStore,
}

impl Store {
    /// 打开（目录不存在则创建；坏文件按空处理并保留原文件不动）
    pub fn open(dir: PathBuf) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&dir).map_err(|e| format!("schedules 目录创建失败：{e}"))?;
        let tasks = match fs::read_to_string(dir.join("tasks.json")) {
            Ok(raw) => serde_json::from_str::<TaskFile>(&raw)
                .map(|f| f.tasks)
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        let mut runs = Vec::new();
        if let Ok(raw) = fs::read_to_string(dir.join("runs.jsonl")) {
            for line in raw.lines() {
                if let Ok(r) = serde_json::from_str::<Run>(line) {
                    runs.push(r);
                }
            }
        }
        if runs.len() > RUNS_KEEP_TOTAL {
            runs = runs.split_off(runs.len() - RUNS_KEEP_TOTAL);
        }
        Ok(Arc::new(Self {
            calendar: CalendarStore::new(dir.clone()),
            dir,
            tasks: Mutex::new(tasks),
            runs: Mutex::new(runs),
            wake: Mutex::new(None),
        }))
    }

    fn persist_tasks(&self) -> Result<(), String> {
        let file = TaskFile {
            version: 1,
            tasks: self.tasks.lock().unwrap().clone(),
        };
        let raw = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        write_atomic(&self.dir.join("tasks.json"), &raw)
    }

    fn persist_runs(&self) -> Result<(), String> {
        let runs = self.runs.lock().unwrap();
        let mut out = String::new();
        for r in runs.iter() {
            if let Ok(line) = serde_json::to_string(r) {
                out.push_str(&line);
                out.push('\n');
            }
        }
        write_atomic(&self.dir.join("runs.jsonl"), &out)
    }

    pub fn set_wake(&self, tx: mpsc::Sender<()>) {
        *self.wake.lock().unwrap() = Some(tx);
    }

    /// 任务变更唤醒调度线程（发送失败=线程未起，忽略）
    pub fn notify(&self) {
        if let Some(tx) = self.wake.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }

    pub fn tasks(&self) -> Vec<Task> {
        self.tasks.lock().unwrap().clone()
    }

    pub fn get_task(&self, id: &str) -> Option<Task> {
        self.tasks.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }

    pub fn runs_of(&self, task_id: &str, limit: usize) -> Vec<Run> {
        let all = self.runs.lock().unwrap();
        let mut v: Vec<Run> = all
            .iter()
            .filter(|r| r.task_id == task_id)
            .cloned()
            .collect();
        v.sort_by(|a, b| b.planned_at.cmp(&a.planned_at));
        v.truncate(limit);
        v
    }

    fn record_run(&self, run: Run) -> Result<(), String> {
        {
            let mut runs = self.runs.lock().unwrap();
            runs.push(run);
            if runs.len() > RUNS_KEEP_TOTAL {
                let cut = runs.len() - RUNS_KEEP_TOTAL;
                runs.drain(0..cut);
            }
        }
        self.persist_runs()
    }

    fn update_run<F: FnOnce(&mut Run)>(&self, id: &str, f: F) -> Option<Run> {
        let updated = {
            let mut runs = self.runs.lock().unwrap();
            let row = runs.iter_mut().find(|r| r.id == id)?;
            f(row);
            row.clone()
        };
        let _ = self.persist_runs();
        Some(updated)
    }

    fn get_run(&self, id: &str) -> Option<Run> {
        self.runs.lock().unwrap().iter().find(|r| r.id == id).cloned()
    }

    fn replace_task(&self, task: Task) -> Result<(), String> {
        {
            let mut tasks = self.tasks.lock().unwrap();
            if let Some(slot) = tasks.iter_mut().find(|t| t.id == task.id) {
                *slot = task;
            }
        }
        self.persist_tasks()?;
        self.notify();
        Ok(())
    }

    fn wait_ms(&self) -> u64 {
        let now = now_ms();
        let next = self
            .tasks
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.status == "active")
            .filter_map(|t| t.next_run_at)
            .min();
        match next {
            Some(ms) => (ms - now).clamp(1_000, 60_000) as u64,
            None => 60_000,
        }
    }

    /// 上次进程退出时遗留的进行中 run → failed（会话映射随进程丢失，无法再收尾）
    fn close_stale_runs(&self, reason: &str) {
        let mut touched = 0;
        {
            let mut runs = self.runs.lock().unwrap();
            for r in runs.iter_mut() {
                if matches!(r.status.as_str(), "running" | "waiting_approval") {
                    r.status = "failed".into();
                    r.finished_at = Some(now_ms());
                    r.error = Some(reason.into());
                    touched += 1;
                }
            }
        }
        if touched > 0 {
            let _ = self.persist_runs();
        }
    }
}

// ── 校验与下一次触发 ────────────────────────────────────────────────────────

fn validate_input(input: &TaskInput) -> Result<(String, Option<String>, u64), String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("任务名称不能为空".into());
    }
    if input.prompt.trim().is_empty() {
        return Err("提示词不能为空".into());
    }
    if input.name.chars().count() > 60 {
        return Err("任务名称 ≤60 字".into());
    }
    let mode = if input.mode.is_empty() {
        "ask".to_string()
    } else {
        input.mode.clone()
    };
    if !matches!(mode.as_str(), "ask" | "auto-edit" | "full-auto") {
        return Err("执行模式非法（ask/auto-edit/full-auto）".into());
    }
    let policy = if input.model_policy.is_empty() {
        "auto".to_string()
    } else {
        input.model_policy.clone()
    };
    if !matches!(policy.as_str(), "auto" | "fast" | "strong") {
        return Err("模型档位非法（auto/fast/strong）".into());
    }
    match &input.schedule {
        ScheduleType::Cron { expr } => {
            cron::parse(expr)?;
        }
        ScheduleType::Once { at } => {
            if *at <= 0 {
                return Err("一次性时间非法".into());
            }
        }
        ScheduleType::Workday { time } => {
            parse_hhmm(time)?;
        }
    }
    let approval = input.approval_timeout_secs.unwrap_or(1800);
    if approval != 0 && !(60..=7 * 24 * 3600).contains(&approval) {
        return Err("审批等待需为 0（不超时）或 60s–7 天".into());
    }
    Ok((mode, Some(policy).filter(|p| p != "auto"), approval))
}

fn parse_hhmm(s: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").map_err(|_| "时间格式非法（HH:mm）".to_string())
}

fn compute_next(task: &Task, store: &Store, after_ms: i64) -> Option<i64> {
    match &task.schedule {
        ScheduleType::Once { at } => {
            if *at > after_ms {
                Some(*at)
            } else {
                None
            }
        }
        ScheduleType::Cron { expr } => {
            let c = cron::parse(expr).ok()?;
            let dt = ms_to_local(after_ms);
            let next = c.next_after(dt)?;
            local_to_ms(next)
        }
        ScheduleType::Workday { time } => {
            let t = parse_hhmm(time).ok()?;
            let mut date = ms_to_local(after_ms).date();
            for _ in 0..400 {
                if store.calendar.is_workday(date) {
                    let cand = date.and_time(t);
                    if let Some(ms) = local_to_ms(cand) {
                        if ms > after_ms {
                            return Some(ms);
                        }
                    }
                }
                date = date.succ_opt()?;
            }
            None
        }
    }
}

// ── 运行时（命令 + 引擎 + 事件旁路） ─────────────────────────────────────────

pub struct Runtime {
    store: Arc<Store>,
    sessions: Mutex<HashMap<String, String>>, // session_id → run_id
    app: AppHandle,
    engine_running: AtomicBool,
}

impl Runtime {
    /// 任务列表委托（B3：/mcp/local schedule_list 消费）
    pub fn list_tasks(&self) -> Vec<Task> {
        self.store.tasks()
    }

    pub fn new(app: AppHandle, store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            app,
            engine_running: AtomicBool::new(false),
        })
    }

    pub fn set_engine_running(&self, on: bool) {
        self.engine_running.store(on, Ordering::SeqCst);
    }

    fn emit(&self, kind: &str, payload: Value) {
        let mut body = payload;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("kind".into(), Value::String(kind.into()));
        }
        let _ = self.app.emit("schedule://event", body);
    }

    // ── 任务 CRUD ──

    pub fn create(&self, input: TaskInput) -> Result<Task, String> {
        let (mode, policy, approval) = validate_input(&input)?;
        let now = now_ms();
        let mut task = Task {
            id: new_id("sct"),
            name: input.name.trim().to_string(),
            prompt: input.prompt.trim().to_string(),
            workspace: input.workspace.trim().to_string(),
            schedule: input.schedule,
            model_policy: policy.unwrap_or_else(|| "auto".into()),
            model: input.model,
            mode,
            approval_timeout_secs: approval,
            status: "active".into(),
            next_run_at: None,
            last_run_at: None,
            created_at: now,
            updated_at: now,
        };
        task.next_run_at = compute_next(&task, &self.store, now);
        self.store.tasks.lock().unwrap().push(task.clone());
        self.store.persist_tasks()?;
        self.store.notify();
        self.emit("task_changed", json!({ "task": task }));
        Ok(task)
    }

    pub fn update(&self, id: &str, input: TaskInput) -> Result<Task, String> {
        let (mode, policy, approval) = validate_input(&input)?;
        let mut task = self
            .store
            .get_task(id)
            .ok_or_else(|| "任务不存在".to_string())?;
        task.name = input.name.trim().to_string();
        task.prompt = input.prompt.trim().to_string();
        task.workspace = input.workspace.trim().to_string();
        task.schedule = input.schedule;
        task.model_policy = policy.unwrap_or_else(|| "auto".into());
        task.model = input.model;
        task.mode = mode;
        task.approval_timeout_secs = approval;
        task.updated_at = now_ms();
        // 编辑后按当前时间重排下次触发
        task.next_run_at = compute_next(&task, &self.store, now_ms());
        self.store.replace_task(task.clone())?;
        self.emit("task_changed", json!({ "task": task }));
        Ok(task)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        {
            let mut tasks = self.store.tasks.lock().unwrap();
            let before = tasks.len();
            tasks.retain(|t| t.id != id);
            if tasks.len() == before {
                return Err("任务不存在".into());
            }
        }
        self.store.persist_tasks()?;
        self.store.notify();
        self.emit("task_changed", json!({ "deletedId": id }));
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<Task, String> {
        let mut task = self
            .store
            .get_task(id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if enabled {
            task.status = "active".into();
            task.next_run_at = compute_next(&task, &self.store, now_ms());
        } else {
            task.status = "paused".into();
            task.next_run_at = None;
        }
        task.updated_at = now_ms();
        self.store.replace_task(task.clone())?;
        self.emit("task_changed", json!({ "task": task }));
        Ok(task)
    }

    // ── 启动补跑扫描（应用关闭/睡眠错过） ──

    pub fn startup_scan(&self) {
        // 上次进程遗留的 running/waiting_approval → failed（映射已丢）
        self.store
            .close_stale_runs("应用重启，运行中断（可在历史里立即重跑）");
        let now = now_ms();
        let tasks = self.store.tasks();
        for mut t in tasks {
            if t.status != "active" {
                continue;
            }
            match t.schedule.clone() {
                ScheduleType::Once { at } => {
                    if at <= now {
                        if now - at <= ONCE_GRACE_MS {
                            t.next_run_at = Some(at); // 交给 tick 立即补跑
                        } else {
                            t.status = "expired".into();
                            t.next_run_at = None;
                            let _ = self.store.record_run(Run {
                                id: new_id("scr"),
                                task_id: t.id.clone(),
                                planned_at: at,
                                started_at: None,
                                finished_at: Some(now),
                                status: "expired".into(),
                                session_id: None,
                                error: Some("超过 24h 宽限，未补跑".into()),
                                summary: None,
                            });
                        }
                    }
                }
                _ => match t.next_run_at {
                    None => t.next_run_at = compute_next(&t, &self.store, now),
                    Some(next) if next < now - MISS_LATE_MS => {
                        let _ = self.store.record_run(Run {
                            id: new_id("scr"),
                            task_id: t.id.clone(),
                            planned_at: next,
                            started_at: None,
                            finished_at: Some(now),
                            status: "missed".into(),
                            session_id: None,
                            error: Some("应用未运行，已跳过本次".into()),
                            summary: None,
                        });
                        t.next_run_at = compute_next(&t, &self.store, now);
                    }
                    _ => {}
                },
            }
            let _ = self.store.replace_task(t);
        }
    }

    // ── 引擎 tick ──

    pub fn tick(&self, host: &AgentHost) {
        let now = now_ms();
        let tasks = self.store.tasks();
        for task in tasks {
            if task.status != "active" {
                continue;
            }
            let Some(planned) = task.next_run_at else {
                continue;
            };
            if planned > now {
                continue;
            }
            let late = now - planned;
            // workday 防御：日历在 next_run_at 计算后被改（管理端同步新节假日）——到点再查一次
            if matches!(task.schedule, ScheduleType::Workday { .. })
                && !self
                    .store
                    .calendar
                    .is_workday(ms_to_local(planned).date())
            {
                let _ = self.store.record_run(Run {
                    id: new_id("scr"),
                    task_id: task.id.clone(),
                    planned_at: planned,
                    started_at: None,
                    finished_at: Some(now),
                    status: "missed".into(),
                    session_id: None,
                    error: Some("该日已调整为非工作日，跳过".into()),
                    summary: None,
                });
                let mut t = task.clone();
                t.next_run_at = compute_next(&t, &self.store, now);
                t.updated_at = now;
                let _ = self.store.replace_task(t);
                continue;
            }
            match &task.schedule {
                ScheduleType::Once { at } => {
                    if now - at > ONCE_GRACE_MS {
                        let mut t = task.clone();
                        t.status = "expired".into();
                        t.next_run_at = None;
                        t.updated_at = now;
                        let _ = self.store.replace_task(t);
                        let _ = self.store.record_run(Run {
                            id: new_id("scr"),
                            task_id: task.id.clone(),
                            planned_at: *at,
                            started_at: None,
                            finished_at: Some(now),
                            status: "expired".into(),
                            session_id: None,
                            error: Some("超过 24h 宽限，未补跑".into()),
                            summary: None,
                        });
                        continue;
                    }
                    self.fire(host, &task, planned);
                }
                _ => {
                    if late > MISS_LATE_MS {
                        // 应用睡眠/卡顿错过：记 missed 并推进
                        let _ = self.store.record_run(Run {
                            id: new_id("scr"),
                            task_id: task.id.clone(),
                            planned_at: planned,
                            started_at: None,
                            finished_at: Some(now),
                            status: "missed".into(),
                            session_id: None,
                            error: Some("错过触发窗口，已跳过本次".into()),
                            summary: None,
                        });
                        let mut t = task.clone();
                        t.next_run_at = compute_next(&t, &self.store, now);
                        t.updated_at = now;
                        let _ = self.store.replace_task(t);
                        continue;
                    }
                    self.fire(host, &task, planned);
                }
            }
        }
    }

    /// 手动立即执行（调试/补跑；不改调度状态）
    pub fn run_now(&self, host: &AgentHost, id: &str) -> Result<Run, String> {
        let task = self
            .store
            .get_task(id)
            .ok_or_else(|| "任务不存在".to_string())?;
        self.start_run(host, &task, now_ms())
    }

    fn fire(&self, host: &AgentHost, task: &Task, planned_at: i64) {
        // start_run 内部已落 run 记录并 emit（先落库再发消息，避免 RT 事件早到丢状态）
        let _ = self.start_run(host, task, planned_at);

        // 推进调度状态
        let mut t = task.clone();
        t.last_run_at = Some(now_ms());
        t.updated_at = now_ms();
        match &task.schedule {
            ScheduleType::Once { .. } => {
                t.status = "completed".into();
                t.next_run_at = None;
            }
            _ => t.next_run_at = compute_next(&t, &self.store, now_ms()),
        }
        let _ = self.store.replace_task(t);
    }

    /// 起会话并落 run（running 先落库，再发 user.message；失败也留 failed 记录）
    fn start_run(&self, host: &AgentHost, task: &Task, planned_at: i64) -> Result<Run, String> {
        let title = format!("[定时] {}", task.name);
        let sid = match host.start_session(
            &task.workspace,
            &task.mode,
            &task.model_policy,
            task.model.as_deref(),
            Some(&title),
            true,
            Some(task.approval_timeout_secs),
        ) {
            Ok(sid) => sid,
            Err(e) => {
                let run = Run {
                    id: new_id("scr"),
                    task_id: task.id.clone(),
                    planned_at,
                    started_at: Some(now_ms()),
                    finished_at: Some(now_ms()),
                    status: "failed".into(),
                    session_id: None,
                    error: Some(e.clone()),
                    summary: None,
                };
                let _ = self.store.record_run(run.clone());
                self.emit("run_finished", json!({ "run": run }));
                return Err(e);
            }
        };
        let run = Run {
            id: new_id("scr"),
            task_id: task.id.clone(),
            planned_at,
            started_at: Some(now_ms()),
            finished_at: None,
            status: "running".into(),
            session_id: Some(sid.clone()),
            error: None,
            summary: None,
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(sid.clone(), run.id.clone());
        // 先落库：RT 可能在 user.message 回执前就发 session.state
        let _ = self.store.record_run(run.clone());
        self.emit("run_started", json!({ "run": run }));

        let text = format!("【定时任务·无人值守】{}\n\n{}", task.name, task.prompt);
        let rep = match host.request(
            "user.message",
            json!({ "sessionId": sid, "text": text, "attachments": [], "thinking": Value::Null }),
        ) {
            Ok(rep) => rep,
            Err(e) => {
                self.sessions.lock().unwrap().remove(&sid);
                let _ = host.fire("session.end", json!({ "sessionId": sid, "reason": "normal" }));
                self.finish_run(&run.id, "failed", Some(e.clone()));
                return Err(e);
            }
        };
        if rep["type"] == "error" {
            let msg = format!(
                "消息被拒：{}",
                rep["message"].as_str().unwrap_or("runtime error")
            );
            self.sessions.lock().unwrap().remove(&sid);
            let _ = host.fire("session.end", json!({ "sessionId": sid, "reason": "normal" }));
            self.finish_run(&run.id, "failed", Some(msg.clone()));
            return Err(msg);
        }
        Ok(run)
    }

    // ── Runtime 事件旁路（会话状态 → run 状态） ──

    /// 定时会话的审批请求注入真实等待窗口（前端据此设倒计时，避免 120s 误判超时）
    pub fn patch_event(&self, payload: &mut Value) {
        if payload["type"].as_str() != Some("permission.request") {
            return;
        }
        let sid = payload["session_id"].as_str().unwrap_or("");
        if sid.is_empty() {
            return;
        }
        let run_id = match self.sessions.lock().unwrap().get(sid) {
            Some(v) => v.clone(),
            None => return,
        };
        let Some(run) = self.store.get_run(&run_id) else {
            return;
        };
        let secs = self
            .store
            .get_task(&run.task_id)
            .map(|t| t.approval_timeout_secs)
            .unwrap_or(1800);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("approval_timeout_secs".into(), json!(secs));
            obj.insert("unattended".into(), json!(true));
        }
    }

    pub fn dispatch(&self, payload: &Value) {
        let ty = payload["type"].as_str().unwrap_or("");
        if ty != "session.state" && ty != "session.ended" {
            return;
        }
        let sid = payload["session_id"].as_str().unwrap_or("");
        if sid.is_empty() {
            return;
        }
        let run_id = {
            let map = self.sessions.lock().unwrap();
            match map.get(sid) {
                Some(v) => v.clone(),
                None => return,
            }
        };
        let state = payload["state"].as_str().unwrap_or("");
        match ty {
            "session.state" => match state {
                "running" => {
                    self.mark_run(&run_id, "running", None);
                }
                "waiting_permission" => {
                    self.mark_run(&run_id, "waiting_approval", None);
                }
                "idle" => {
                    self.finish_run(&run_id, "success", None);
                }
                "error" => {
                    let reason = payload["reason"].as_str().unwrap_or("会话错误");
                    self.finish_run(&run_id, "failed", Some(reason.into()));
                }
                "ended" => {
                    self.finish_run(&run_id, "failed", Some("会话已结束".into()));
                }
                _ => {}
            },
            "session.ended" => {
                let summary = payload["summary"].as_str().unwrap_or("会话已结束");
                self.finish_run(&run_id, "failed", Some(summary.into()));
            }
            _ => {}
        }
    }

    fn mark_run(&self, run_id: &str, status: &str, error: Option<String>) {
        if let Some(run) = self.store.update_run(run_id, |r| {
            // 等审批后回到 running 属正常；success/failed 为终态不覆盖
            if matches!(r.status.as_str(), "running" | "waiting_approval") {
                r.status = status.to_string();
                if error.is_some() {
                    r.error = error;
                }
            }
        }) {
            self.emit("run_changed", json!({ "run": run }));
        }
    }

    fn finish_run(&self, run_id: &str, status: &str, error: Option<String>) {
        let mut finished = false;
        let run = self.store.update_run(run_id, |r| {
            if matches!(r.status.as_str(), "running" | "waiting_approval") {
                r.status = status.to_string();
                r.finished_at = Some(now_ms());
                if error.is_some() {
                    r.error = error;
                }
                finished = true;
            }
        });
        if finished {
            self.sessions
                .lock()
                .unwrap()
                .retain(|_, rid| rid != run_id);
            if let Some(run) = run {
                self.emit("run_finished", json!({ "run": run }));
            }
        }
    }

    pub fn cancel_run(&self, host: &AgentHost, run_id: &str) -> Result<(), String> {
        let run = self.store.get_run(run_id).ok_or_else(|| "运行不存在".to_string())?;
        if let Some(sid) = &run.session_id {
            // session.interrupt 是事件回执（session.interrupted），不走 REQ→RES 等待
            let _ = host.fire("session.interrupt", json!({ "sessionId": sid }));
        }
        self.finish_run(run_id, "failed", Some("用户取消".into()));
        Ok(())
    }

    // ── 查询 ──

    pub fn list(&self) -> Value {
        json!({
            "tasks": self.store.tasks(),
            "engineRunning": self.engine_running.load(Ordering::SeqCst),
            "calendar": self.store.calendar.status(),
            "calendarYears": {
                "current": self.store.calendar.has_year(ms_to_local(now_ms()).date().year()),
            }
        })
    }

    /// 日历保存后重算 workday 任务的 next_run_at（保证“下次执行”展示准确）
    pub fn after_calendar_saved(&self) {
        let now = now_ms();
        for mut t in self.store.tasks() {
            if t.status != "active" || !matches!(t.schedule, ScheduleType::Workday { .. }) {
                continue;
            }
            t.next_run_at = compute_next(&t, &self.store, now);
            t.updated_at = now;
            let _ = self.store.replace_task(t);
        }
    }

    pub fn runs(&self, task_id: &str) -> Value {
        json!({ "runs": self.store.runs_of(task_id, RUNS_KEEP_PER_TASK) })
    }
}


// ── 单实例锁（原子目录 + 心跳；无第三方依赖） ───────────────────────────────

struct LockGuard {
    dir: PathBuf,
}

impl LockGuard {
    fn acquire(dir: PathBuf) -> Option<Self> {
        for _ in 0..2 {
            match fs::create_dir(&dir) {
                Ok(_) => {
                    let guard = Self { dir };
                    guard.heartbeat();
                    return Some(guard);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let hb = dir.join("heartbeat");
                    let stale = fs::read_to_string(&hb)
                        .ok()
                        .and_then(|s| s.trim().parse::<i64>().ok())
                        .map(|ts| now_ms() - ts > 180_000)
                        .unwrap_or(true); // 读不到心跳视为陈旧
                    if stale {
                        let _ = fs::remove_dir_all(&dir);
                        continue;
                    }
                    return None;
                }
                Err(_) => return None,
            }
        }
        None
    }

    fn heartbeat(&self) {
        let _ = fs::write(self.dir.join("heartbeat"), now_ms().to_string());
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

// ── 引擎启动 ────────────────────────────────────────────────────────────────

/// 启动调度线程；返回 false=另一个实例持有调度锁（本实例不跑，任务仍由另一实例执行）
pub fn start(rt: Arc<Runtime>, host: Arc<AgentHost>) -> bool {
    let Some(lock) = LockGuard::acquire(rt.store.dir.join(".scheduler-lock")) else {
        return false;
    };
    let (tx, rx) = mpsc::channel::<()>();
    rt.store.set_wake(tx);
    rt.set_engine_running(true);
    let engine_rt = rt.clone();
    let spawned = std::thread::Builder::new()
        .name("bbc-schedule".into())
        .spawn(move || {
            let _lock = lock;
            engine_rt.startup_scan();
            loop {
                engine_rt.tick(&host);
                let wait = engine_rt.store.wait_ms();
                match rx.recv_timeout(Duration::from_millis(wait)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                _lock.heartbeat();
            }
        });
    match spawned {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[bbc-schedule] 调度线程启动失败: {e}");
            rt.set_engine_running(false);
            false
        }
    }
}

// ── 日历同步（服务端只读；内网无外网也只用本地缓存） ────────────────────────

/// 同步指定年份（缺省今年）。失败返回错误文案，不影响已有缓存。
pub fn sync_calendar(host: &AgentHost, year: Option<i32>) -> Result<CalendarCache, String> {
    let y = year.unwrap_or_else(|| ms_to_local(now_ms()).date().year());
    let token = host
        .access_token()
        .ok_or_else(|| "未登录（缺少访问令牌）".to_string())?;
    let url = format!(
        "{}/api/v1/workday-calendar?year={}",
        host.gateway().trim_end_matches('/'),
        y
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp: Value = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("日历同步失败（网络）：{e}"))?
        .json()
        .map_err(|e| format!("日历响应解析失败：{e}"))?;
    if resp["code"].as_i64() != Some(0) {
        return Err(format!(
            "日历同步被拒 (code={} message={})",
            resp["code"], resp["message"]
        ));
    }
    let days: Vec<CalendarDay> = serde_json::from_value(resp["data"]["days"].clone())
        .map_err(|e| format!("日历数据格式不符：{e}"))?;
    let cache = CalendarCache {
        year: y,
        fetched_at: now_ms(),
        days,
    };
    Ok(cache)
}

pub fn save_calendar(store: &Store, cache: CalendarCache) -> Result<(), String> {
    store.calendar.save(cache)
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn schedule_list(rt: State<'_, Arc<Runtime>>) -> Result<Value, String> {
    Ok(rt.list())
}

#[tauri::command]
pub fn schedule_runs(rt: State<'_, Arc<Runtime>>, task_id: String) -> Result<Value, String> {
    Ok(rt.runs(&task_id))
}

#[tauri::command]
pub fn schedule_create(rt: State<'_, Arc<Runtime>>, input: TaskInput) -> Result<Value, String> {
    let task = rt.create(input)?;
    Ok(json!({ "task": task }))
}

#[tauri::command]
pub fn schedule_update(
    rt: State<'_, Arc<Runtime>>,
    id: String,
    input: TaskInput,
) -> Result<Value, String> {
    let task = rt.update(&id, input)?;
    Ok(json!({ "task": task }))
}

#[tauri::command]
pub fn schedule_delete(rt: State<'_, Arc<Runtime>>, id: String) -> Result<Value, String> {
    rt.delete(&id)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn schedule_set_enabled(
    rt: State<'_, Arc<Runtime>>,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    let task = rt.set_enabled(&id, enabled)?;
    Ok(json!({ "task": task }))
}

#[tauri::command]
pub fn schedule_run_now(
    rt: State<'_, Arc<Runtime>>,
    host: State<'_, Arc<AgentHost>>,
    id: String,
) -> Result<Value, String> {
    let run = rt.run_now(&host, &id)?;
    Ok(json!({ "run": run }))
}

#[tauri::command]
pub fn schedule_cancel_run(
    rt: State<'_, Arc<Runtime>>,
    host: State<'_, Arc<AgentHost>>,
    run_id: String,
) -> Result<Value, String> {
    rt.cancel_run(&host, &run_id)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn schedule_sync_calendar(
    rt: State<'_, Arc<Runtime>>,
    host: State<'_, Arc<AgentHost>>,
    year: Option<i32>,
) -> Result<Value, String> {
    let cache = sync_calendar(&host, year)?;
    let year = cache.year;
    let fetched_at = cache.fetched_at;
    save_calendar(&rt.store, cache)?;
    rt.after_calendar_saved();
    Ok(json!({ "year": year, "fetchedAt": fetched_at }))
}

#[tauri::command]
pub fn schedule_calendar_status(rt: State<'_, Arc<Runtime>>) -> Result<Value, String> {
    Ok(json!({ "years": rt.store.calendar.status() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, Timelike};

    fn tmp_store() -> (Arc<Store>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bbc-sched-test-{}", uuid::Uuid::new_v4()));
        (Store::open(dir.clone()).unwrap(), dir)
    }

    fn task_with(s: ScheduleType) -> Task {
        Task {
            id: "sct-test".into(),
            name: "t".into(),
            prompt: "p".into(),
            workspace: String::new(),
            schedule: s,
            model_policy: "auto".into(),
            model: None,
            mode: "ask".into(),
            approval_timeout_secs: 1800,
            status: "active".into(),
            next_run_at: None,
            last_run_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn workday_next_skips_weekend_without_calendar() {
        let (store, dir) = tmp_store();
        let task = task_with(ScheduleType::Workday { time: "09:00".into() });
        // 2026-11-20 周五 10:00 → 下周一 09:00（无日历缓存 → 默认规则）
        let base = local_to_ms(
            NaiveDate::from_ymd_opt(2026, 11, 20)
                .unwrap()
                .and_hms_opt(10, 0, 0)
                .unwrap(),
        )
        .unwrap();
        let next = compute_next(&task, &store, base).unwrap();
        assert_eq!(
            ms_to_local(next),
            NaiveDate::from_ymd_opt(2026, 11, 23)
                .unwrap()
                .and_hms_opt(9, 0, 0)
                .unwrap()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn workday_uses_calendar_cache() {
        let (store, dir) = tmp_store();
        // 2026-11-23（周一）标为节假日 → 下一个工作日 11-24
        store
            .calendar
            .save(CalendarCache {
                year: 2026,
                fetched_at: 0,
                days: vec![CalendarDay {
                    date: "2026-11-23".into(),
                    day_type: "holiday".into(),
                    name: "测试假".into(),
                }],
            })
            .unwrap();
        let task = task_with(ScheduleType::Workday { time: "09:00".into() });
        let base = local_to_ms(
            NaiveDate::from_ymd_opt(2026, 11, 20)
                .unwrap()
                .and_hms_opt(10, 0, 0)
                .unwrap(),
        )
        .unwrap();
        let next = compute_next(&task, &store, base).unwrap();
        assert_eq!(
            ms_to_local(next),
            NaiveDate::from_ymd_opt(2026, 11, 24)
                .unwrap()
                .and_hms_opt(9, 0, 0)
                .unwrap()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cron_next_local() {
        let (store, dir) = tmp_store();
        let task = task_with(ScheduleType::Cron {
            expr: "0 9 * * *".into(),
        });
        let base = local_to_ms(
            NaiveDate::from_ymd_opt(2026, 11, 19)
                .unwrap()
                .and_hms_opt(8, 30, 0)
                .unwrap(),
        )
        .unwrap();
        let next = ms_to_local(compute_next(&task, &store, base).unwrap());
        assert_eq!(next.hour(), 9);
        assert_eq!(next.minute(), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn once_in_past_has_no_next() {
        let (store, dir) = tmp_store();
        let task = task_with(ScheduleType::Once { at: 1 });
        assert!(compute_next(&task, &store, 1000).is_none());
        let _ = fs::remove_dir_all(dir);
    }
}
