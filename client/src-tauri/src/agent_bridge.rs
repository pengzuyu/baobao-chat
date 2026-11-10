//! Agent 宿主桥（08 篇 §3.1「Agent 管理器」/D11 §3 宿主侧）：
//! 拉起 bbrt 子进程（stdio JSONL 信封）+ REQ↔RES 关联（reply_to）+ 事件泵
//! （UNT → emit 回调）+ 会话缓存（session_list 数据源——协议无查询消息，D08 §6 口径）。
//!
//! 与 tauri 解耦（emit 闭包注入）：examples/agent_smoke.rs 可脱离窗口做端到端冒烟。
//!
//! 协议口径（bbrt-protocol/envelope.rs）：
//! - 信封 {v,id,reply_to?,type,payload}；payload 字段 **camelCase**
//! - REQ 回执靠 reply_to 指回请求 id（session.start→session.ready、user.message→session.state…）
//! - obo.token 是 token 唯一下行通道；RT 侧 obo.renew REQ 由宿主应答
//! - 握手硬约束：首条必须 initialize（10s 窗口）→ initialize.result → runtime.ready
//!
//! 已知协议缺口（登记）：session.resume RT 未实现（fire-and-forget）；
//! agent_set_mode 无协议消息（宿主本地记录）；emergency_stop=杀进程（D09 §4.6）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

const REQ_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// UNT 事件回执（已键名转 snake + risk 归一），宿主粘合层注入 app.emit
pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;

/// 会话缓存行（agent_session 镜像子集；宿主重启后为空，阶段二演进为壳侧 SQLite）
#[derive(Clone)]
pub struct SessionCache {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub mode: String,
    pub model_policy: String,
    pub model_override: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl SessionCache {
    fn to_row(&self) -> Value {
        json!({
            "id": self.id, "title": self.title, "workspace": self.workspace,
            "mode": self.mode, "model_policy": self.model_policy,
            "model_override": self.model_override, "status": self.status,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

struct ProcState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// REQ id → 回执投递通道
    pending: HashMap<String, mpsc::Sender<Value>>,
    ready: bool,
}

/// 宿主与读线程共享态（读线程持有 Arc，与 AgentHost 同寿）
struct Shared {
    proc: Mutex<ProcState>,
    sessions: Mutex<Vec<SessionCache>>,
    /// (token, exp unix 秒)——auth_set_token 缓存，obo.renew 应答源
    token: Mutex<Option<(String, u64)>>,
    /// 紧急停止后抑制惰性重启（下一次显式命令重新拉起）
    halted: AtomicBool,
}

impl Shared {
    fn complete_req(&self, reply_to: &str, payload: Value) -> bool {
        let mut p = self.proc.lock().unwrap();
        match p.pending.remove(reply_to) {
            Some(tx) => {
                let _ = tx.send(payload);
                true
            }
            None => false,
        }
    }

    fn mark_ready(&self) {
        self.proc.lock().unwrap().ready = true;
    }

    fn mark_down(&self) {
        let mut p = self.proc.lock().unwrap();
        p.child = None;
        p.stdin = None;
        p.ready = false;
        for (_, tx) in p.pending.drain() {
            // 通道 drop 即让等待方收到 Disconnected
            drop(tx);
        }
    }

    /// RT 侧 obo.renew 应答：用缓存 token 重发 obo.token（带 reply_to 关联）
    fn answer_renew(&self, reply_to: String) {
        let token = self.token.lock().unwrap().clone();
        let mut env = match token {
            Some((t, exp)) => json!({
                "v": 1, "id": "h-renew", "type": "obo.token",
                "payload": { "token": t, "exp": exp, "scopes": [] }
            }),
            None => return, // 无 token 可续（未登录）：RT 侧 needs_renew 空缓存不请求，理论不达
        };
        env["reply_to"] = Value::String(reply_to);
        let mut p = self.proc.lock().unwrap();
        if let Some(stdin) = p.stdin.as_mut() {
            let mut line = env.to_string();
            line.push('\n');
            let _ = stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush());
        }
    }

    /// UNT 事件喂会话缓存（camel 原始 payload 取字段；pre=转换前，post=转换后）
    fn apply_session_event(&self, msg_type: &str, pre: &Value) {
        let sid = pre["sessionId"].as_str().unwrap_or("").to_string();
        if sid.is_empty() {
            return;
        }
        let now = now_ms();
        let mut sessions = self.sessions.lock().unwrap();
        let Some(row) = sessions.iter_mut().find(|s| s.id == sid) else {
            return;
        };
        row.updated_at = now;
        match msg_type {
            "session.state" => {
                if let Some(st) = pre["state"].as_str() {
                    row.status = st.to_string();
                }
            }
            // RT 建会话即 Idle、只发 session.ready（无 starting→idle 迁移事件）：
            // 缓存须在此翻 idle，否则列表永久"启动中"（mock 桥自补 idle 曾掩盖此缺口）
            "session.ready" => {
                row.status = "idle".into();
            }
            "model.switched" => {
                if let Some(to) = pre["to"].as_str() {
                    row.model_policy = to.to_string();
                }
                row.model_override = pre["model"].as_str().map(str::to_string);
            }
            "session.ended" => {
                row.status = "ended".into();
            }
            _ => {}
        }
    }
}

/// bbrt 宿主
pub struct AgentHost {
    shared: Arc<Shared>,
    bin: PathBuf,
    data_dir: PathBuf,
    gateway: String,
    static_token: Option<String>,
    emit: EventSink,
    seq: AtomicU64,
    seq_session: AtomicU64,
}

impl AgentHost {
    pub fn new(data_dir: PathBuf, emit: EventSink) -> Self {
        let bin = resolve_bbrt_bin();
        let gateway =
            std::env::var("BBW_RT_GATEWAY").unwrap_or_else(|_| "http://127.0.0.1:8090".into());
        let static_token = std::env::var("BBW_RT_TOKEN").ok().filter(|t| !t.is_empty());
        Self {
            shared: Arc::new(Shared {
                proc: Mutex::new(ProcState {
                    child: None,
                    stdin: None,
                    pending: HashMap::new(),
                    ready: false,
                }),
                sessions: Mutex::new(Vec::new()),
                token: Mutex::new(None),
                halted: AtomicBool::new(false),
            }),
            bin,
            data_dir,
            gateway,
            static_token,
            emit,
            seq: AtomicU64::new(0),
            seq_session: AtomicU64::new(0),
        }
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    /// 会话列表快照（updated_at 倒序；FE 期望 snake_case 行）。
    /// D19 起数据源=RT 持久列表（session.list，agent_session JOIN agent_workspace，
    /// 宿主重启可恢复）+ 宿主缓存叠加（活跃状态/本地模型切换最新）；
    /// RT 拉起失败/请求失败回落纯缓存（旧行为）。
    pub fn list_sessions(&self) -> Vec<Value> {
        let cache_rows: Vec<Value> = self
            .shared
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.to_row())
            .collect();
        // 持久列表（camelCase → snake_case 归一供 FE mapSession）
        let durable: Vec<Value> = self
            .ensure_running()
            .ok()
            .and_then(|_| self.request("session.list", json!({ "limit": 200 })).ok())
            .and_then(|rep| rep["items"].as_array().cloned())
            .map(|items| items.iter().map(camel_to_snake_session).collect())
            .unwrap_or_default();
        // 缓存行优先；持久行只补缓存没有的（历史会话）
        let cache_ids: Vec<String> = cache_rows
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_string))
            .collect();
        let mut rows = cache_rows;
        rows.extend(durable.into_iter().filter(|r| {
            r["id"]
                .as_str()
                .map_or(true, |id| !cache_ids.contains(&id.to_string()))
        }));
        rows.sort_by(|a, b| b["updated_at"].as_i64().cmp(&a["updated_at"].as_i64()));
        rows
    }

    /// D19 项目登记（workspace.register → workspace.registered）
    pub fn register_workspace(&self, path: &str, name: Option<&str>) -> Result<Value, String> {
        self.ensure_running()?;
        let rep = self.request("workspace.register", json!({ "path": path, "name": name }))?;
        Ok(rep["item"].clone())
    }

    /// D19 项目列表（workspace.list → workspace.listed）
    pub fn list_workspaces(&self) -> Result<Vec<Value>, String> {
        self.ensure_running()?;
        let rep = self.request("workspace.list", json!({}))?;
        Ok(rep["items"].as_array().cloned().unwrap_or_default())
    }

    /// D19 项目移除登记（workspace.forget → workspace.forgot{ok}）
    pub fn forget_workspace(&self, id: &str) -> Result<bool, String> {
        self.ensure_running()?;
        let rep = self.request("workspace.forget", json!({ "id": id }))?;
        Ok(rep["ok"].as_bool().unwrap_or(false))
    }

    /// 登录/刷新成功后下发 token（exp 毫秒 → 协议秒）
    pub fn set_token(&self, token: String, exp_ms: i64) -> Result<(), String> {
        *self.shared.token.lock().unwrap() = Some((token.clone(), (exp_ms / 1000).max(0) as u64));
        self.fire(
            "obo.token",
            json!({ "token": token, "exp": exp_ms / 1000, "scopes": [] }),
        )
    }

    // ---- 生命周期 ----

    /// 惰性拉起：清理上次半死进程 → spawn → initialize（必须首条）→ runtime.ready → 置位；
    /// 紧急停止后由下一次显式命令重新拉起
    pub fn ensure_running(&self) -> Result<(), String> {
        {
            let p = self.shared.proc.lock().unwrap();
            if p.ready && p.child.is_some() {
                return Ok(());
            }
        }
        {
            // 上次握手失败的残留进程：先清（bbrt 等首条 initialize 有 10s 窗口，超时自杀）
            let mut p = self.shared.proc.lock().unwrap();
            if let Some(mut c) = p.child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            p.stdin = None;
            p.ready = false;
            for (_, tx) in p.pending.drain() {
                drop(tx);
            }
        }
        let ready_rx = self.spawn_child()?;
        // initialize 必须是首条（协议硬约束）；dataDir 字段与 env 双通道（RT 当前只认 env）
        let init = json!({ "protocolVersion": 1, "capabilities": ["session", "tools", "memory", "reports"], "dataDir": self.data_dir.display().to_string() });
        self.request_inner("initialize", init)?;
        // 静态 token 兜底（dev-token 联调；正式 token 经 auth_set_token → obo.token）
        if let Some(t) = &self.static_token {
            let _ = self.fire_inner("obo.token", json!({ "token": t, "exp": 0, "scopes": [] }));
        }
        match ready_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(()) => {
                self.shared.proc.lock().unwrap().ready = true;
                Ok(())
            }
            Err(_) => Err("bbrt 握手超时（未收到 runtime.ready）".into()),
        }
    }

    fn spawn_child(&self) -> Result<mpsc::Receiver<()>, String> {
        if self.shared.halted.load(Ordering::SeqCst) {
            // 紧急停止后的首次命令=显式恢复
            self.shared.halted.store(false, Ordering::SeqCst);
        }
        std::fs::create_dir_all(&self.data_dir).map_err(|e| format!("数据目录创建失败: {e}"))?;
        if !self.bin.exists() {
            return Err(format!(
                "bbrt 二进制不存在（{}）；先 cargo build -p bbrt 或设 BBW_RT_BIN",
                self.bin.display()
            ));
        }
        // stderr 落盘（append）：Runtime 告警/panic 可观测（2026-11-10 内嵌卡
        // 卡死排查——inherit 在桌面形态无处可看；stdout 是协议通道不能动）
        let err_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_dir.join("bbrt.log"));
        let mut child = Command::new(&self.bin)
            .env("BBW_RT_DATA_DIR", &self.data_dir)
            .env("BBW_RT_GATEWAY", &self.gateway)
            // 公司域 MCP 网关（D18 §3.5：agent 经 im_history 自读会话上下文等
            // 公司域能力；命名 corp → 工具命名空间 mcp.corp.*）
            .env(
                "BBW_RT_MCP_SERVERS",
                format!("corp={}/mcp/corp", self.gateway.trim_end_matches('/')),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(match err_log {
                Ok(f) => Stdio::from(f),
                Err(_) => Stdio::inherit(),
            })
            .spawn()
            .map_err(|e| format!("bbrt 启动失败: {e}"))?;
        let stdin = child.stdin.take().ok_or("stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("stdout 不可用")?;
        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        {
            let mut p = self.shared.proc.lock().unwrap();
            p.child = Some(child);
            p.stdin = Some(stdin);
            p.ready = false;
        }
        // 事件泵：行读 → obo.renew 应答 / reply_to 关联 / UNT → 键名归一 → 会话缓存 → emit
        let shared = self.shared.clone();
        let emit = self.emit.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim().is_empty() {
                    continue;
                }
                let env: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue, // 非 JSON 行（RT 侧异常输出）忽略
                };
                let msg_type = env["type"].as_str().unwrap_or("").to_string();
                if msg_type == "runtime.ready" {
                    shared.mark_ready();
                    let _ = ready_tx.send(());
                }
                if msg_type == "obo.renew" {
                    shared.answer_renew(env["id"].as_str().unwrap_or("").to_string());
                    continue;
                }
                if let Some(reply_to) = env["reply_to"].as_str() {
                    if shared.complete_req(reply_to, env["payload"].clone()) {
                        continue; // REQ 回执已投递
                    }
                }
                // UNT/NTF：先喂会话缓存（camel 原文），再键名归一（snake + risk mid）emit
                shared.apply_session_event(&msg_type, &env["payload"]);
                emit(normalize_event(&msg_type, env["payload"].clone()));
            }
            // EOF：Runtime 退出——标记 down + 壳自产 runtime.state（前端未知类型忽略）
            shared.mark_down();
            emit(
                json!({ "type": "runtime.state", "session_id": null, "state": "down", "reason": "process-exited" }),
            );
        });
        Ok(ready_rx) // runtime.ready 由 ensure_running 在 initialize 发出后等待
    }

    /// REQ：ensure 运行 + 写 stdin + 等 reply_to 回执（同步阻塞；Tauri 同步命令跑独立线程池）
    pub fn request(&self, msg_type: &str, payload: Value) -> Result<Value, String> {
        self.ensure_running()?;
        self.request_inner(msg_type, payload)
    }

    fn request_inner(&self, msg_type: &str, payload: Value) -> Result<Value, String> {
        let id = format!("h-{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1);
        let (tx, rx): (mpsc::Sender<Value>, Receiver<Value>) = mpsc::channel();
        self.shared
            .proc
            .lock()
            .unwrap()
            .pending
            .insert(id.clone(), tx);
        if let Err(e) = self.write_envelope(&id, msg_type, &payload) {
            self.shared.proc.lock().unwrap().pending.remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(REQ_TIMEOUT) {
            Ok(payload) => Ok(payload),
            Err(RecvTimeoutError::Timeout) => {
                self.shared.proc.lock().unwrap().pending.remove(&id);
                Err(format!("Runtime 响应超时: {msg_type}"))
            }
            Err(RecvTimeoutError::Disconnected) => Err("Runtime 已退出".into()),
        }
    }

    /// fire-and-forget（model.switch/session.resume 等无成对回执）
    pub fn fire(&self, msg_type: &str, payload: Value) -> Result<(), String> {
        self.ensure_running()?;
        self.fire_inner(msg_type, payload)
    }

    fn fire_inner(&self, msg_type: &str, payload: Value) -> Result<(), String> {
        let id = format!("h-{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1);
        self.write_envelope(&id, msg_type, &payload)
    }

    fn write_envelope(&self, id: &str, msg_type: &str, payload: &Value) -> Result<(), String> {
        let env = json!({ "v": 1, "id": id, "type": msg_type, "payload": payload });
        let mut line = serde_json::to_string(&env).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut p = self.shared.proc.lock().unwrap();
        match p.stdin.as_mut() {
            Some(stdin) => stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.flush())
                .map_err(|e| format!("写入 Runtime 失败: {e}")),
            None => Err("Runtime 未运行".into()),
        }
    }

    /// 新建会话（协议口径：sessionId 由宿主生成传入）
    pub fn start_session(
        &self,
        workspace: &str,
        mode: &str,
        model_policy: &str,
        model: Option<&str>,
    ) -> Result<String, String> {
        self.ensure_running()?;
        let n = self.seq_session.fetch_add(1, Ordering::SeqCst) + 1;
        let sid = format!("sess-{}-{}", now_ms(), n);
        let now = now_ms();
        self.shared.sessions.lock().unwrap().push(SessionCache {
            id: sid.clone(),
            title: format!("会话 {n}"),
            workspace: workspace.to_string(),
            mode: mode.to_string(),
            model_policy: model_policy.to_string(),
            model_override: model.map(str::to_string),
            status: "starting".into(),
            created_at: now,
            updated_at: now,
        });
        let payload = json!({
            "sessionId": sid, "workspace": workspace, "mode": mode,
            "modelPolicy": model_policy, "model": model, "skills": [],
        });
        // REQ 失败（超时/握手）或 RT 错误回执（type=error，如 8001 活跃会话超限）
        // 都须回滚缓存行——否则列表留永久 starting 幽灵行且白占 RT 名额
        let rep = match self.request("session.start", payload) {
            Ok(v) => v,
            Err(e) => {
                self.shared.sessions.lock().unwrap().retain(|s| s.id != sid);
                return Err(e);
            }
        };
        if rep["type"] == "error" {
            self.shared.sessions.lock().unwrap().retain(|s| s.id != sid);
            let msg = rep["message"].as_str().unwrap_or("runtime error");
            return Err(format!("会话创建失败：{msg}"));
        }
        Ok(sid)
    }

    /// 权限模式本地切换（协议缺口：HostToRuntime 无 mode 设置消息，登记）
    pub fn set_mode(&self, session_id: &str, mode: &str) {
        let now = now_ms();
        if let Some(row) = self
            .shared
            .sessions
            .lock()
            .unwrap()
            .iter_mut()
            .find(|s| s.id == session_id)
        {
            row.mode = mode.to_string();
            row.updated_at = now;
        }
    }

    /// 紧急停止：杀 Runtime + 未决 REQ 全部失败（D09 §4.6）
    pub fn emergency_stop(&self) -> Value {
        let mut p = self.shared.proc.lock().unwrap();
        let killed = if p.child.as_mut().is_some_and(|c| c.kill().is_ok()) {
            1u64
        } else {
            0
        };
        let cancelled = p.pending.len() as u64;
        p.child = None;
        p.stdin = None;
        p.ready = false;
        drop(p);
        self.shared.halted.store(true, Ordering::SeqCst);
        json!({ "killed_pids": killed, "cancelled_requests": cancelled })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// D19 session.list 持久行 camelCase → FE snake_case（mapSession 口径）：
/// modelPolicy→model_policy 等五个复合键重命名，其余原样透传
fn camel_to_snake_session(row: &Value) -> Value {
    let mut out = row.clone();
    for (from, to) in [
        ("modelPolicy", "model_policy"),
        ("modelOverride", "model_override"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("endedAt", "ended_at"),
    ] {
        if let Some(v) = row.get(from) {
            out[to] = v.clone();
        }
        out.as_object_mut().map(|m| m.remove(from));
    }
    out
}

/// bbrt 二进制解析：BBW_RT_BIN → 生产 exe 同目录 sidecar（externalBin 命名
/// bbrt-<target-triple>[.exe]）→ workspace 内 target/{debug,release} → bundle binaries/
fn resolve_bbrt_bin() -> PathBuf {
    if let Ok(p) = std::env::var("BBW_RT_BIN") {
        return PathBuf::from(p);
    }
    // 生产：Tauri externalBin 把 sidecar 随 main exe 同目录分发（macOS/Linux 包；
    // Windows 侧 bbrt 编不过不随包，走 dev 路径后由 exists 检查给出引导）
    if let Ok(exe) = std::env::current_exe() {
        let sidecar = exe
            .parent()
            .unwrap_or(Path::new("."))
            .join(sidecar_file_name());
        if sidecar.exists() {
            return sidecar;
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // client/src-tauri
    for rel in [
        "../../agent/target/debug/bbrt",
        "../../agent/target/release/bbrt",
        "binaries/bbrt",
    ] {
        let p = manifest.join(rel);
        if p.exists() {
            return p;
        }
    }
    manifest.join("../../agent/target/debug/bbrt")
}

/// externalBin 打包产物名（build.rs 注入 triple；Windows 再补 .exe 后缀）
fn sidecar_file_name() -> String {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    format!("bbrt-{}{}", env!("BBW_TARGET_TRIPLE"), ext)
}

/// UNT payload 键名归一（协议 camelCase → FE agent://event 期望 snake_case；
/// risk wire 枚举 low|medium|high → FE low|mid|high）。type 顶层补挂。
pub fn normalize_event(msg_type: &str, payload: Value) -> Value {
    let mut out = snake_keys(payload);
    if let Some(obj) = out.as_object_mut() {
        obj.insert("type".into(), Value::String(msg_type.to_string()));
        if let Some(risk) = obj.get_mut("risk") {
            if risk.as_str() == Some("medium") {
                *risk = Value::String("mid".into());
            }
        }
    }
    out
}

/// 递归 camelCase → snake_case（sessionId→session_id/filesChanged→files_changed）
pub fn snake_keys(v: Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                out.insert(camel_to_snake(&k), snake_keys(val));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(snake_keys).collect()),
        other => other,
    }
}

fn camel_to_snake(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for (i, ch) in s.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_keys_recursive() {
        let v = json!({ "sessionId": "s1", "nested": { "finishReason": "stop", "kept": 1 }, "arr": [{ "callId": "c1" }] });
        let out = snake_keys(v);
        assert_eq!(out["session_id"], "s1");
        assert_eq!(out["nested"]["finish_reason"], "stop");
        assert_eq!(out["arr"][0]["call_id"], "c1");
    }

    #[test]
    fn normalize_event_type_and_risk() {
        let out = normalize_event(
            "permission.request",
            json!({ "sessionId": "s1", "risk": "medium" }),
        );
        assert_eq!(out["type"], "permission.request");
        assert_eq!(out["session_id"], "s1");
        assert_eq!(out["risk"], "mid");
        let ok = normalize_event("tool.call", json!({ "risk": "high" }));
        assert_eq!(ok["risk"], "high");
    }

    #[test]
    fn camel_to_snake_cases() {
        assert_eq!(camel_to_snake("sessionId"), "session_id");
        assert_eq!(camel_to_snake("id"), "id");
        assert_eq!(camel_to_snake("modelPolicy"), "model_policy");
        assert_eq!(camel_to_snake("replayedEvents"), "replayed_events");
    }

    #[test]
    fn sidecar_file_name_matches_externalbin_convention() {
        // Tauri externalBin 打包命名：bbrt-<target-triple>[.exe]（非 Windows 无后缀）
        let name = sidecar_file_name();
        assert!(name.starts_with("bbrt-"), "缺 triple 前缀: {name}");
        if cfg!(windows) {
            assert!(name.ends_with(".exe"), "Windows sidecar 须 .exe: {name}");
            assert!(name.len() > "bbrt-.exe".len(), "triple 为空: {name}");
        } else {
            assert!(!name.contains('.'), "Unix sidecar 不带后缀: {name}");
            assert!(name.len() > "bbrt-".len(), "triple 为空: {name}");
        }
    }

    fn shared_with_starting_session() -> (Arc<Shared>, String) {
        let shared = Arc::new(Shared {
            proc: Mutex::new(ProcState {
                child: None,
                stdin: None,
                pending: HashMap::new(),
                ready: false,
            }),
            sessions: Mutex::new(vec![SessionCache {
                id: "s1".into(),
                title: "会话 1".into(),
                workspace: "~/code".into(),
                mode: "ask".into(),
                model_policy: "auto".into(),
                model_override: None,
                status: "starting".into(),
                created_at: 0,
                updated_at: 0,
            }]),
            token: Mutex::new(None),
            halted: AtomicBool::new(false),
        });
        (shared, "s1".into())
    }

    #[test]
    fn session_ready_flips_cache_to_idle() {
        // RT 建会话只发 session.ready（无 starting→idle 迁移事件）——缓存必须翻 idle
        let (shared, sid) = shared_with_starting_session();
        shared.apply_session_event(
            "session.ready",
            &json!({ "sessionId": sid, "restored": false }),
        );
        assert_eq!(shared.sessions.lock().unwrap()[0].status, "idle");
    }

    #[test]
    fn session_ready_for_unknown_session_ignored() {
        let (shared, _) = shared_with_starting_session();
        shared.apply_session_event(
            "session.ready",
            &json!({ "sessionId": "ghost", "restored": false }),
        );
        assert_eq!(shared.sessions.lock().unwrap()[0].status, "starting");
    }
}
