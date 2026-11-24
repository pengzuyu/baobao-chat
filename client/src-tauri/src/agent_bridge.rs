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
//! 已知协议缺口（登记）：emergency_stop=杀进程（D09 §4.6）。旧
//! session.pause/resume 用户通道已随 2026-11-11「停止=中断当前轮」口径移除
//! （session.interrupt 取代，收口 idle）；agent_set_mode 原缺口（仅宿主本地
//! 记录）已由 session.set_mode 协议消息补齐（中途切档即时生效）。

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
    /// D35 定时任务：审批等待秒数（None=普通会话 120s；Some(0)=不超时）。
    /// 前端据此设置审批卡倒计时（否则定时任务 30 分钟窗口会被 120s 误判超时）。
    pub approval_timeout_secs: Option<u64>,
}

impl SessionCache {
    fn to_row(&self) -> Value {
        json!({
            "id": self.id, "title": self.title, "workspace": self.workspace,
            "mode": self.mode, "model_policy": self.model_policy,
            "model_override": self.model_override, "status": self.status,
            "created_at": self.created_at, "updated_at": self.updated_at,
            "approval_timeout_secs": self.approval_timeout_secs,
        })
    }
}

/// OBO 下发 exp 余量（D28 批0）：服务端 OBOTTL=15min，按 now+14min 交付（RT 提前调度续签）
const OBO_EXP_MARGIN: u64 = 840;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// REQ 回执载荷（读泵投递给等待方前调用）：信封层 type 回填进 payload 副本。
/// 等待方只拿 payload，而 `Envelope::wrap` 把 type 提升到信封层（payload 内无
/// type）——不回填则各调用点 `rep["type"] == "error"` 恒假：RT 的拒绝回执（如
/// 8001 活跃会话超限）被当成功，宿主留下库里不存在的幽灵会话，之后每条消息都
/// 被异步 8001「会话不存在（库中无行）」拒（2026-11-24 用户报修根因）
fn reply_payload(env: &Value) -> Value {
    let mut payload = env["payload"].clone();
    if let Some(msg_type) = env["type"].as_str() {
        if payload.is_null() {
            payload = json!({});
        }
        if let Some(map) = payload.as_object_mut() {
            map.insert("type".into(), Value::String(msg_type.to_string()));
        }
    }
    payload
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
    /// OBO 签发上下文（D28 批0/Q0-2）：did=agent_session_id 归因前缀；
    /// obo_scopes=用户权限集（/auth/obo/token 子集校验用）；gateway=auth 端点基址
    did: Mutex<String>,
    obo_scopes: Mutex<Vec<String>>,
    gateway: String,
    /// 当前登录用户（工号/姓名）——插件装配器静态替换 ${BBC_USER_ID}/${BBC_USER_NAME}
    /// 用（D22 §6.1/L4；换账号=set_user 后重推装配，stdio env 是 spawn 快照）
    user: Mutex<(String, String)>,
    /// 初始化互斥（2026-11-23 命令并发化修复）：命令声明 (async) 后不再被主线程
    /// 天然串行——auth_set_token 与 session_list 可同时 ensure_running，原 TOCTOU
    /// 检查会双 spawn 且后者覆盖 stdin 令前者泄漏成孤儿；持锁全程初始化，
    /// 并发方排队等握手完成后走双检查直接返回。锁序恒 spawn_lock→proc，无反向
    spawn_lock: Mutex<()>,
    /// 紧急停止后抑制惰性重启（下一次显式命令重新拉起）
    halted: AtomicBool,
    /// 统一身份受众集合（D38 批5）：最近一次装配的全部 (audience, scope)——
    /// 批量换票请求源；装配重推时更新（没装就没受众，票根本不存在）
    audiences: Mutex<Vec<(String, Vec<String>)>>,
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

    /// RT 侧 obo.renew 应答（D38 拍板 9/6：票据代整代全量重签；失败**不发票不回落**——
    /// 主令牌绝不进 MCP 请求头，续签失败 → 票自然过期 → 调用 401 诚实降级）。
    /// HTTP 走独立线程——事件泵绝不被 5s 超时卡住
    fn answer_renew(self: &Arc<Self>, reply_to: String) {
        let token = self.token.lock().unwrap().clone();
        let Some((access, _)) = token else {
            return; // 无 token 可续（未登录/已登出）：RT 侧 needs_renew 空缓存不请求，理论不达
        };
        let shared = Arc::clone(self);
        std::thread::spawn(move || {
            let (tokens, exp) = match shared.issue_agent_tickets(&access) {
                Ok(t) => t,
                Err(e) => {
                    // D38 拍板 6：降级为不发票（旧「回落主 access」是凭证外泄通道，已删）
                    eprintln!("[bbc-bridge] agent 票续签失败，降级不发票（调用将 401）: {e}");
                    return;
                }
            };
            let _ = exp;
            let mut env = json!({
                "v": 1, "id": "h-renew", "type": "obo.token",
                "payload": { "tokens": tokens }
            });
            env["reply_to"] = Value::String(reply_to);
            let mut p = shared.proc.lock().unwrap();
            if let Some(stdin) = p.stdin.as_mut() {
                let mut line = env.to_string();
                line.push('\n');
                let _ = stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush());
            }
        });
    }

    /// 批量签发 agent 票（D38 §3.3）：POST /api/v1/auth/obo/token——
    /// agent_session_id=desktop-{did} 归因前缀；audiences=当前装配受众集合
    /// （{aud, scope}——scope 空数组=服务端按用户全量签）；一次往返换整代
    /// → 返回 obo.token 载荷 tokens 数组与统一 exp（unix 秒）
    fn issue_agent_tickets(&self, access: &str) -> Result<(Value, u64), String> {
        let did = self.did.lock().unwrap().clone();
        let audiences: Vec<Value> = {
            let a = self.audiences.lock().unwrap();
            a.iter()
                .map(|(aud, scope)| {
                    json!({ "aud": aud, "scope": scope })
                })
                .collect()
        };
        if audiences.is_empty() {
            return Err("无统一身份受众（装配未含任何声明）".into());
        }
        let url = format!(
            "{}/api/v1/auth/obo/token",
            self.gateway.trim_end_matches('/')
        );
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let resp: Value = client
            .post(&url)
            .bearer_auth(access)
            .json(&json!({
                "agent_session_id": format!("desktop-{did}"),
                "audiences": audiences,
            }))
            .send()
            .map_err(|e| format!("agent 票端点不可达: {e}"))?
            .json()
            .map_err(|e| format!("agent 票响应解析失败: {e}"))?;
        if resp["code"].as_i64() != Some(0) {
            return Err(format!(
                "agent 票签发被拒 (code={} message={})",
                resp["code"], resp["message"]
            ));
        }
        let tickets = resp["data"]["tokens"]
            .as_array()
            .ok_or_else(|| "agent 票响应缺 tokens".to_string())?
            .clone();
        let exp = tickets
            .first()
            .and_then(|t| t["exp"].as_u64())
            .unwrap_or_else(|| now_secs() + OBO_EXP_MARGIN);
        Ok((json!(tickets), exp))
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
    /// B3：本地工具面 hub（attach_ext_hub 注入；push_mcp_assembly 时轮换
    /// local token 并供给 /mcp/local——schedule_* 壳本地工具）
    ext_hub: Mutex<Option<std::sync::Arc<crate::ext_agent::ExtHub>>>,
}

impl AgentHost {
    pub fn new(data_dir: PathBuf, emit: EventSink) -> Self {
        let bin = resolve_bbrt_bin();
        // 网关缺省链（D21）：进程 env BBC_RT_GATEWAY（dev/手工覆盖）>
        // 编译期注入 BBC_DEFAULT_GATEWAY（发布打包由 BBC_PUBLIC_URL 带 build.rs 注入，
        // 打包应用无 env 可设）> 本地服务端默认口 127.0.0.1:8080（与 config.go
        // HTTPAddr 同源；旧 8090 是「独立网关进程」时代口径，网关并入单体后失配）。
        let gateway = std::env::var("BBC_RT_GATEWAY")
            .ok()
            .filter(|g| !g.is_empty())
            .or_else(|| option_env!("BBC_DEFAULT_GATEWAY").map(str::to_string))
            .unwrap_or_else(|| "http://127.0.0.1:8080".into());
        let static_token = std::env::var("BBC_RT_TOKEN").ok().filter(|t| !t.is_empty());
        Self {
            ext_hub: Mutex::new(None),
            shared: Arc::new(Shared {
                proc: Mutex::new(ProcState {
                    child: None,
                    stdin: None,
                    pending: HashMap::new(),
                    ready: false,
                }),
                sessions: Mutex::new(Vec::new()),
                token: Mutex::new(None),
                did: Mutex::new(String::new()),
                obo_scopes: Mutex::new(Vec::new()),
                gateway: gateway.clone(),
                user: Mutex::new((String::new(), String::new())),
                spawn_lock: Mutex::new(()),
                halted: AtomicBool::new(false),
            audiences: Mutex::new(Vec::new()),
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

    /// D35：日历同步用——当前 access token（未登录 None）
    pub fn access_token(&self) -> Option<String> {
        self.shared
            .token
            .lock()
            .unwrap()
            .as_ref()
            .map(|(t, _)| t.clone())
    }

    /// D35：日历同步用——网关基址（不含 /api/v1）
    pub fn gateway(&self) -> &str {
        &self.gateway
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

    /// 登录/刷新成功后下发 agent 票（D38 批5）：缓存主 access（续签源）→
    /// 按当前装配受众集合批量换票 → obo.token{tokens[]} 整代下发。
    /// **失败降级为不发票**（D38 拍板 6：主令牌绝不进 MCP 请求头；RT 侧票缓存
    /// 空/过期 → 调用 401 诚实反馈，等下次登录/装配重推/续签窗口重试）
    pub fn set_access_token(&self, token: String, exp_ms: i64) -> Result<(), String> {
        *self.shared.token.lock().unwrap() = Some((token.clone(), (exp_ms / 1000).max(0) as u64));
        self.refresh_agent_tickets();
        Ok(())
    }

    /// 按受众集合批量换票并下发整代（D38 §3.2 触发点 1/2/4 共用）：
    /// 未登录/无受众静默跳过；失败仅告警不发票（拍板 6）
    fn refresh_agent_tickets(&self) {
        let Some((access, _)) = self.shared.token.lock().unwrap().clone() else {
            return;
        };
        let has_aud = !self.shared.audiences.lock().unwrap().is_empty();
        if !has_aud {
            return; // 装配未含统一身份声明——无受众即无票（D38 §3.1）
        }
        match self.shared.issue_agent_tickets(&access) {
            Ok((tokens, _exp)) => {
                if let Err(e) = self.fire("obo.token", json!({ "tokens": tokens })) {
                    eprintln!("[bbc-bridge] agent 票下发失败（RT 未起？ready 重推兜底）: {e}");
                }
            }
            Err(e) => {
                eprintln!("[bbc-bridge] agent 票换签失败，降级不发票（调用将 401）: {e}");
            }
        }
    }

    /// OBO 签发上下文注入（did=归因前缀，perms=权限集）——须先于 set_access_token
    pub fn set_device(&self, did: &str, perms: &[String]) {
        *self.shared.did.lock().unwrap() = did.to_string();
        *self.shared.obo_scopes.lock().unwrap() = perms.to_vec();
    }

    /// 登出清缓存（D28 批0/Q0-3）：token 与用户归零。RT 侧已持有的 token 靠
    /// ≤15min 自然过期（协议无 obo.token 空值语义，不新增）；此后 obo.renew
    /// 因无缓存不答——RT needs_renew 空缓存不请求，理论不达
    pub fn clear_token(&self) {
        *self.shared.token.lock().unwrap() = None;
        *self.shared.user.lock().unwrap() = (String::new(), String::new());
    }

    /// 登录用户信息（D22/L4）：装配器替换 ${BBC_USER_ID}/${BBC_USER_NAME} 用；
    /// 更新后重推装配（换账号 → stdio env 随新 spawn 生效；HTTP 的 TOKEN 是
    /// RT 动态替换不受影响）。失败仅告警（装配重推自愈）
    pub fn set_user(&self, user_id: &str, user_name: &str) -> Result<(), String> {
        {
            let mut u = self.shared.user.lock().unwrap();
            if u.0 == user_id && u.1 == user_name {
                return Ok(()); // 未变不重推
            }
            *u = (user_id.to_string(), user_name.to_string());
        }
        if let Err(e) = self.push_mcp_assembly() {
            eprintln!("[bbc-bridge] 用户变更装配重推失败（降级）: {e}");
        }
        Ok(())
    }

    /// 当前登录用户（工号/姓名；未登录空串）
    pub fn current_user(&self) -> (String, String) {
        self.shared.user.lock().unwrap().clone()
    }

    // ---- 生命周期 ----

    /// 惰性拉起：清理上次半死进程 → spawn → initialize（必须首条）→ runtime.ready → 置位；
    /// 紧急停止后由下一次显式命令重新拉起。快路径无锁读 ready；初始化全程持
    /// spawn_lock（双检查防重入——命令并发化后登录/列表可同瞬到达，见 Shared 注释）
    pub fn ensure_running(&self) -> Result<(), String> {
        {
            let p = self.shared.proc.lock().unwrap();
            if p.ready && p.child.is_some() {
                return Ok(());
            }
        }
        let _guard = self.shared.spawn_lock.lock().unwrap();
        {
            // 双检查：排队等锁期间别的线程已完成初始化
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
                // MCP 装配持久性（D22 §5.3/L3）：spawn 后重推全量（系统级 corp
                // env 已注入，插件级/个人级必须经 mcp.config——RT 重启不丢）。
                // 失败仅告警不阻断（插件/个人降级标灰，corp 链路不受影响）
                if let Err(e) = self.push_mcp_assembly_inner() {
                    eprintln!("[bbc-bridge] MCP 装配推送失败（降级）: {e}");
                }
                Ok(())
            }
            Err(_) => Err("bbrt 握手超时（未收到 runtime.ready）".into()),
        }
    }

    /// B3：注入外部接入 hub（lib.rs setup 调用，hub 先于 host 构造故 setter 注入）
    pub fn attach_ext_hub(&self, hub: std::sync::Arc<crate::ext_agent::ExtHub>) {
        *self.ext_hub.lock().unwrap() = Some(hub);
    }

    /// MCP 装配推送（对外入口：ensure_running 前置）——装配变更后调用
    /// （D26：三源全量=corp+插件+个人，插件/个人命令层共用）
    pub fn push_mcp_assembly(&self) -> Result<(), String> {
        self.ensure_running()?;
        self.push_mcp_assembly_inner()
    }

    /// 全量装配 → mcp.config（NTF）+ tools.reload{plugin}（skills 多根重扫）
    fn push_mcp_assembly_inner(&self) -> Result<(), String> {
        let user = self.current_user();
        // B3：本地工具面——每次装配轮换 token（旧 runtime 已死，新 runtime 独占）
        let mut local = None;
        if let Some(hub) = self.ext_hub.lock().unwrap().as_ref() {
            if hub.is_online() {
                let token = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                hub.set_local_token(token.clone());
                local = Some((hub.bound_port(), token));
            }
        }
        let servers = assemble_mcp_servers(&self.data_dir, &self.gateway, &user, local);
        // 受众集合随装配更新（D38 §3.1：没装就没受众；卸载/禁用即消失）
        {
            let mut auds = Vec::new();
            for srv in &servers {
                if let (Some(aud), scope) = (
                    srv["transport"]["auth"]["audience"].as_str(),
                    srv["transport"]["auth"]["scope"].as_array(),
                ) {
                    let sc: Vec<String> = scope
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    auds.push((aud.to_string(), sc));
                }
            }
            *self.shared.audiences.lock().unwrap() = auds;
        }
        self.fire_inner("mcp.config", json!({ "servers": servers }))?;
        self.fire_inner("tools.reload", json!({ "reason": "plugin" }))?;
        // D38 §3.2 触发点 2/4：装配变更/RT 重启 ready 兜底——已登录即换票下发
        // （登录先于 RT 起的时序由此补票）；未登录跳过（无票 → 调用 401）
        self.refresh_agent_tickets();
        Ok(())
    }

    fn spawn_child(&self) -> Result<mpsc::Receiver<()>, String> {
        if self.shared.halted.load(Ordering::SeqCst) {
            // 紧急停止后的首次命令=显式恢复
            self.shared.halted.store(false, Ordering::SeqCst);
        }
        std::fs::create_dir_all(&self.data_dir).map_err(|e| format!("数据目录创建失败: {e}"))?;
        if !self.bin.exists() {
            return Err(format!(
                "bbrt 二进制不存在（{}）；先 cargo build -p bbrt 或设 BBC_RT_BIN",
                self.bin.display()
            ));
        }
        // stderr 落盘（append）：Runtime 告警/panic 可观测（2026-11-10 内嵌卡
        // 卡死排查——inherit 在桌面形态无处可看；stdout 是协议通道不能动）
        let mut err_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_dir.join("bbrt.log"));
        // 落一行装配快照：网关打错口这类失配桌面形态无处可看（2026-11-23
        // 8090/8080 失配排查的根因就是看不到实际注入值），bbrt.log 即观测点
        if let Ok(ref mut f) = err_log {
            use std::io::Write as _;
            let _ = writeln!(
                f,
                "── spawn: gateway={} bin={}",
                self.gateway,
                self.bin.display()
            );
        }
        let mut child = Command::new(&self.bin);
        child
            .env("BBC_RT_DATA_DIR", &self.data_dir)
            .env("BBC_RT_GATEWAY", &self.gateway)
            // 公司域 MCP 网关（D18 §3.5：agent 经 im_history 自读会话上下文等
            // 公司域能力；命名 corp → 工具命名空间 mcp.corp.*）
            .env(
                "BBC_RT_MCP_SERVERS",
                format!("corp={}/mcp/corp", self.gateway.trim_end_matches('/')),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(match err_log {
                Ok(f) => Stdio::from(f),
                Err(_) => Stdio::inherit(),
            });
        // Windows：GUI 父进程（windows_subsystem）启动控制台子进程，系统默认给
        // 子进程新开一个控制台窗口——登录即拉起 RT 后桌面会弹「bbrt.exe shell」
        // （2026-11-24 用户报修）。bbrt 三路 IO 全接管（stdin/stdout JSONL 管道 +
        // stderr 落 bbrt.log），窗口纯属多余——CREATE_NO_WINDOW 显式压掉
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            child.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = child
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
        // 事件泵：行读 → obo.renew 应答 / reply_to 关联 / UNT → 键名归一 → 会话缓存 → emit。
        // stream.delta 合批（2026-11-11 卡顿修复）：每 token 一条 delta emit 进
        // WebView ≈100 次/s——IPC 风暴致主线程饱和（点击无响应）且事件过载丢帧
        // （回复不完整）。同 (session, channel) 拼接文本，80ms 窗口合并 emit；
        // 非 delta 事件先 flush 保序（stream.done 后于该会话全部 delta）。
        let shared = self.shared.clone();
        let emit = self.emit.clone();
        std::thread::spawn(move || {
            const DELAY_BATCH_MS: u64 = 80;
            let mut pending: Vec<(String, String, String, u64)> = vec![]; // (sid, channel, text, seq)
            let mut last_flush = std::time::Instant::now();
            macro_rules! flush_deltas {
                () => {
                    if !pending.is_empty() {
                        pending.sort_by_key(|(_, _, _, seq)| *seq);
                        let flushed = pending.len(); // TEMP 排错：flush 计数
                        for (sid, ch, text, seq) in pending.drain(..) {
                            emit(normalize_event(
                                "stream.delta",
                                json!({ "sessionId": sid, "delta": text, "seq": seq, "channel": ch }),
                            ));
                        }
                        eprintln!("[pump] flush {flushed}"); // TEMP 排错（验收后移除）
                        last_flush = std::time::Instant::now();
                    }
                };
            }
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        // TEMP 排错（泵静默死亡排查，验收后移除）：读错误此前静默 break
                        eprintln!("[pump] EXIT read-err {e}");
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                let env: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue, // 非 JSON 行（RT 侧异常输出）忽略
                };
                let msg_type = env["type"].as_str().unwrap_or("").to_string();
                // TEMP 排错：泵逐事件日志（非 delta）——泵若卡死/死亡此处停止打印
                if !msg_type.is_empty() && msg_type != "stream.delta" {
                    eprintln!("[pump] evt {msg_type}");
                }
                if msg_type == "runtime.ready" {
                    shared.mark_ready();
                    let _ = ready_tx.send(());
                }
                if msg_type == "obo.renew" {
                    shared.answer_renew(env["id"].as_str().unwrap_or("").to_string());
                    continue;
                }
                if let Some(reply_to) = env["reply_to"].as_str() {
                    // type 在信封层——回填后等待方才判得出 RT 拒绝（见 reply_payload）
                    if shared.complete_req(reply_to, reply_payload(&env)) {
                        continue; // REQ 回执已投递
                    }
                }
                if msg_type == "stream.delta" {
                    let p = &env["payload"];
                    let sid = p["sessionId"].as_str().unwrap_or("").to_string();
                    let ch = p["channel"].as_str().unwrap_or("text").to_string();
                    let seq = p["seq"].as_u64().unwrap_or(0);
                    let text = p["delta"].as_str().unwrap_or("").to_string();
                    if let Some(slot) = pending
                        .iter_mut()
                        .find(|(s, c, _, _)| *s == sid && *c == ch)
                    {
                        slot.2.push_str(&text);
                        slot.3 = seq;
                    } else {
                        pending.push((sid, ch, text, seq));
                    }
                    if last_flush.elapsed().as_millis() as u64 >= DELAY_BATCH_MS {
                        flush_deltas!();
                    }
                    continue;
                }
                // 非 delta 事件：先冲刷缓冲保序，再喂缓存与 emit
                flush_deltas!();
                shared.apply_session_event(&msg_type, &env["payload"]);
                emit(normalize_event(&msg_type, env["payload"].clone()));
            }
            flush_deltas!();
            // EOF：Runtime 退出——标记 down + 壳自产 runtime.state（前端未知类型忽略）
            eprintln!("[pump] EXIT eof（bbrt stdout 关闭）"); // TEMP 排错
            shared.mark_down();
            emit(
                json!({ "type": "runtime.state", "session_id": null, "state": "down", "reason": "process-exited" }),
            );
        });
        Ok(ready_rx) // runtime.ready 由 ensure_running 在 initialize 发出后等待
    }

    /// REQ：ensure 运行 + 写 stdin + 等 reply_to 回执（同步阻塞——调用方均为
    /// 声明 (async) 的 Tauri 命令，跑在 async_runtime 线程池，不占主线程）
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

    /// fire-and-forget（model.switch 等无成对回执）
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

    /// 新建会话（协议口径：sessionId 由宿主生成传入）。title 可选初始标题，
    /// 缺省=「会话 {n}」占位（前端首条用户消息后 rename 派生真标题）。
    /// origin/conv_id/conv_type（2026-11-23 场景提示词）：embedded 会话带
    /// "embedded"+聊天来源，runtime 按 scene 在 SYSTEM_PROMPT 末尾注入场景段
    pub fn start_session(
        &self,
        workspace: &str,
        mode: &str,
        model_policy: &str,
        model: Option<&str>,
        title: Option<&str>,
        unattended: bool,
        approval_timeout_secs: Option<u64>,
        origin: Option<&str>,
        conv_id: Option<&str>,
        conv_type: Option<&str>,
    ) -> Result<String, String> {
        self.ensure_running()?;
        let n = self.seq_session.fetch_add(1, Ordering::SeqCst) + 1;
        // ID 口径对齐 zcode（2026-11-20 用户拍板）：sess_ + UUID v4（复用 D28 设备号
        // 已引入的 uuid 依赖）；进程内 seq 只留给默认标题「会话 {n}」占位编号
        let sid = format!("sess_{}", uuid::Uuid::new_v4());
        let now = now_ms();
        // workspace 与 RT 同口径归一（std::fs::canonicalize + 失败回落原串，
        // 对齐 bbrt-session manager::start）：缓存行若存对话框原始路径，而
        // session.list「缓存行优先」，FE 会拿到原始串 ≠ workspace.list 的
        // realpath → 左栏同项目裂成「目录名+绝对路径」两组（2026-11-23
        // 用户报修）。RT 端幂等 canonicalize，改传归一串不改变其行为。
        let workspace_norm = if workspace.is_empty() {
            workspace.to_string()
        } else {
            std::fs::canonicalize(workspace)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| workspace.to_string())
        };
        self.shared.sessions.lock().unwrap().push(SessionCache {
            id: sid.clone(),
            title: title
                .filter(|t| !t.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("会话 {n}")),
            workspace: workspace_norm.clone(),
            mode: mode.to_string(),
            model_policy: model_policy.to_string(),
            model_override: model.map(str::to_string),
            status: "starting".into(),
            created_at: now,
            updated_at: now,
            approval_timeout_secs,
        });
        let payload = json!({
            "sessionId": sid, "workspace": workspace_norm, "mode": mode,
            "modelPolicy": model_policy, "model": model, "skills": [],
            "title": title,
            // D35 定时任务：无人值守 + 审批等待窗口（普通会话 false/缺省）
            "unattended": unattended,
            "approvalTimeoutSecs": approval_timeout_secs,
            // 场景来源（2026-11-23）：embedded=IM 唤起（conv_id/conv_type 常驻
            // 场景段）；任务/项目缺省（workspace 判定）
            "origin": origin,
            "convId": conv_id,
            "convType": conv_type,
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
        // 回执即 session.ready——RT 会话已就绪（Idle）。同步翻缓存行（与泵的
        // UNT session.ready 幂等双路径），避免并发 session_list 读到 starting
        {
            let mut sessions = self.shared.sessions.lock().unwrap();
            if let Some(row) = sessions.iter_mut().find(|s| s.id == sid) {
                row.status = "idle".into();
                row.updated_at = now_ms();
            }
        }
        Ok(sid)
    }

    /// 会话重命名（session.rename REQ 落库 + 宿主缓存行同步——
    /// list_sessions 缓存行优先，不同步会盖掉库内新标题）
    pub fn rename_session(&self, session_id: &str, title: &str) -> Result<Value, String> {
        let rep = self.request(
            "session.rename",
            json!({ "sessionId": session_id, "title": title }),
        )?;
        if rep["type"] == "error" {
            let msg = rep["message"].as_str().unwrap_or("runtime error");
            return Err(format!("重命名失败：{msg}"));
        }
        let final_title = rep["title"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| title.trim().to_string());
        let now = now_ms();
        if let Some(row) = self
            .shared
            .sessions
            .lock()
            .unwrap()
            .iter_mut()
            .find(|s| s.id == session_id)
        {
            row.title = final_title.clone();
            row.updated_at = now;
        }
        Ok(json!({ "ok": true, "title": final_title }))
    }

    /// 会话删除（2026-11-24 工作台需求）：session.delete REQ + 宿主缓存行移除
    /// （list_sessions 缓存行优先于持久列表——不清则重启前列表仍见该行）
    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let rep = self.request("session.delete", json!({ "sessionId": session_id }))?;
        if rep["type"] == "error" {
            let msg = rep["message"].as_str().unwrap_or("runtime error");
            return Err(format!("删除失败：{msg}"));
        }
        self.shared
            .sessions
            .lock()
            .unwrap()
            .retain(|s| s.id != session_id);
        Ok(())
    }

    /// 权限模式切换：本地会话行即时更新（UI 一致性）+ session.set_mode 下发
    /// runtime（补协议缺口——此前只本地记录，门控恒按 session.start 时的模式，
    /// 中途切档不生效）。mode 先校验，非法值不落本地也不下发
    pub fn set_mode(&self, session_id: &str, mode: &str) -> Result<(), String> {
        if !matches!(mode, "ask" | "auto-edit" | "full-auto") {
            return Err(format!("未知权限模式: {mode}"));
        }
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
        self.fire(
            "session.set_mode",
            json!({ "sessionId": session_id, "mode": mode }),
        )
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

/// bbrt 二进制解析：BBC_RT_BIN → 生产 exe 同目录 sidecar（externalBin 命名
/// bbrt-<target-triple>[.exe]）→ workspace 内 target/{debug,release} → bundle binaries/
fn resolve_bbrt_bin() -> PathBuf {
    if let Ok(p) = std::env::var("BBC_RT_BIN") {
        return PathBuf::from(p);
    }
    // 生产：Tauri externalBin 把 sidecar 随 main exe 同目录分发。NSIS 安装落名
    // 剥 triple（实测 E:\BaobaoChat\bbrt.exe），带 triple 名兜底（.app bundle 等）；
    // 都没有再走 dev 路径，由 exists 检查给出引导
    if let Ok(exe) = std::env::current_exe() {
        let exe_ext = if cfg!(windows) { ".exe" } else { "" };
        let dir = exe.parent().unwrap_or(Path::new("."));
        let plain = dir.join(format!("bbrt{exe_ext}"));
        if plain.exists() {
            return plain;
        }
        let sidecar = dir.join(sidecar_file_name());
        if sidecar.exists() {
            return sidecar;
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // client/src-tauri
    // Windows 产物带 .exe（与 sidecar_file_name 同规则）；不补后缀 exists 恒 false，
    // Windows 移植后 dev 路径实际可用，漏后缀会误报「二进制不存在」
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    for rel in [
        "../../agent/target/debug/bbrt",
        "../../agent/target/release/bbrt",
        "binaries/bbrt",
    ] {
        let p = manifest.join(format!("{rel}{exe_ext}"));
        if p.exists() {
            return p;
        }
    }
    manifest.join(format!("../../agent/target/debug/bbrt{exe_ext}"))
}

/// externalBin 打包产物名（build.rs 注入 triple；Windows 再补 .exe 后缀）
fn sidecar_file_name() -> String {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    format!("bbrt-{}{}", env!("BBC_TARGET_TRIPLE"), ext)
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

// ── MCP 装配器（D22 §5.3 / L3 + D26 §4 个人第三源）──
//
// 三源合并产出 mcp.config 全量 wire（camelCase，与协议 McpServerWire 对齐）：
//   1. 系统级：corp（HTTP 网关，env 同源口径——RT 启动 env 兜底，本装配覆盖）；
//   2. 插件级：各启用插件 activeVersion 目录的 .mcp.json（或 plugin.json 内联
//      mcpServers——string 路径/内联对象双形态，与服务端 Go 校验器同口径）；
//   3. 个人级（D26）：用户自配 eco/mcp/personal.json（stdio/HTTP 双形态，
//      secret 值钥匙串合并——mcp_commands::read_personal_servers）。
// `${PLUGIN_ROOT}` 替换为版本目录绝对路径（装配时静态替换）；身份变量
// （${BBC_USER_TOKEN}/${CONFIG:*}）随 L4 在 RT 调用层动态注入——HTTP
// headers 本层暂丢弃（TransportConfig::Http 尚无自定义头，登记 L4）。
// server 名冲突：系统级 > 插件级 > 个人级，同名跳过（防劫持 corp 命名空间、
// 防个人顶替插件）。

fn assemble_mcp_servers(
    data_dir: &std::path::Path,
    gateway: &str,
    user: &(String, String),
    local: Option<(u16, String)>,
) -> Vec<Value> {
    let mut out = vec![json!({
        "name": "corp",
        "transport": {
            "kind": "http",
            "baseUrl": format!("{}/mcp/corp", gateway.trim_end_matches('/')),
            // D38 单票制：corp 收编保留逻辑受众（与服务端 platform/agentjwt 同值）
            "auth": { "type": "obo", "audience": "bbc-corp", "scope": [] }
        }
    })];
    let mut taken: Vec<String> = vec!["corp".into()];
    // B3：系统级第二位=壳本地工具面（/mcp/local，schedule_*）；token 每次
    // 装配轮换，独立于 D30 外部 token——插件/个人不得顶替 local 命名空间
    if let Some((port, token)) = local {
        out.push(json!({
            "name": "local",
            "transport": {
                "kind": "http",
                "baseUrl": format!("http://127.0.0.1:{port}/mcp/local"),
                "headers": { "Authorization": format!("Bearer {token}") }
            }
        }));
        taken.push("local".into());
    }

    let plugins_dir = data_dir.join("eco/plugins");
    let Ok(rd) = std::fs::read_dir(&plugins_dir) else {
        append_personal(data_dir, &mut out, &mut taken, user);
        return out;
    };
    let mut ids: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    ids.sort();
    for id in ids {
        let base = plugins_dir.join(&id);
        let Ok(state) = std::fs::read_to_string(base.join("plugin-state.json")) else {
            continue;
        };
        let Ok(sv) = serde_json::from_str::<Value>(&state) else {
            continue;
        };
        if !sv.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
            continue;
        }
        let Some(ver) = sv.get("activeVersion").and_then(Value::as_str) else {
            continue;
        };
        if ver.is_empty() {
            continue;
        }
        let ver_dir = base.join(ver);
        let Some(mcp_doc) = read_plugin_mcp_doc(&ver_dir) else {
            continue;
        };
        let Some(servers) = mcp_doc.get("mcpServers").and_then(Value::as_object) else {
            continue;
        };
        let root = ver_dir.display().to_string();
        let config = crate::plugin_commands::read_plugin_config(&base);
        for (name, def) in servers {
            if taken.contains(name) {
                eprintln!("[bbc-bridge] 插件 {id} MCP server 名 '{name}' 与系统级/先到冲突，跳过");
                continue;
            }
            match mcp_server_wire(name, def, &root, user, &config) {
                Some(w) => {
                    taken.push(name.clone());
                    out.push(w);
                }
                None => eprintln!(
                    "[bbc-bridge] 插件 {id} MCP server '{name}' 定义非法（缺 command/url），跳过"
                ),
            }
        }
    }
    append_personal(data_dir, &mut out, &mut taken, user);
    out
}

/// 个人第三源（D26 §4）：启用的自配 server 追加（corp>插件>个人——同名
/// 跳过防顶替）；`${BBC_USER_ID/NAME}` 经 mcp_server_wire 照常静态替换、
/// TOKEN 留 RT 动态（无 PLUGIN_ROOT/CONFIG 语义——个人面不使用）
fn append_personal(
    data_dir: &std::path::Path,
    out: &mut Vec<Value>,
    taken: &mut Vec<String>,
    user: &(String, String),
) {
    for (name, def) in crate::mcp_commands::read_personal_servers(data_dir) {
        if taken.contains(&name) {
            eprintln!("[bbc-bridge] 个人 MCP server 名 '{name}' 与系统级/插件级冲突，跳过");
            continue;
        }
        match mcp_server_wire(&name, &def, "", user, &serde_json::Map::new()) {
            Some(w) => {
                taken.push(name.clone());
                out.push(w);
            }
            None => {
                eprintln!("[bbc-bridge] 个人 MCP server '{name}' 定义非法（缺 command/url），跳过")
            }
        }
    }
}

/// 插件 MCP 定义读取：.mcp.json 文件优先；缺省回落 plugin.json（三目录名）
/// 的 mcpServers 字段（string=路径 → 读该文件；object=内联——包一层
/// {"mcpServers": ...} 归一）
fn read_plugin_mcp_doc(ver_dir: &std::path::Path) -> Option<Value> {
    if let Ok(text) = std::fs::read_to_string(ver_dir.join(".mcp.json")) {
        return serde_json::from_str(&text).ok();
    }
    for dir in [".bbc-plugin", ".claude-plugin", ".zcode-plugin"] {
        let Ok(text) = std::fs::read_to_string(ver_dir.join(dir).join("plugin.json")) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match v.get("mcpServers") {
            Some(Value::String(rel)) => {
                let p = ver_dir.join(rel.trim_start_matches("./"));
                if let Ok(t) = std::fs::read_to_string(&p) {
                    return serde_json::from_str(&t).ok();
                }
            }
            Some(obj @ Value::Object(_)) => return Some(json!({ "mcpServers": obj })),
            _ => {}
        }
    }
    None
}

/// 单 server 定义 → wire（D22 §6.1/L4 变量族——装配层静态替换：
/// `${PLUGIN_ROOT}` 版本目录 / `${BBC_USER_ID}`·`${BBC_USER_NAME}` 当前登录
/// 用户 / `${CONFIG:key}` 插件配置（config.json+钥匙串合并）。
/// **统一身份（D38 §5）**：`x-bbc-auth:{type:"obo"[,scope]}` 声明 → wire 带
/// auth（audience=该 server url，宿主显式填、RT 不推导）；**旧写法归一**（拍板 12）：
/// headers 含 `${BBC_USER_TOKEN}` 等价统一身份（headers 原样保留——RT 调用层
/// 按受众票替换该占位，效果与自动 Bearer 等价）。**stdio 声明统一身份 → 拒装**
/// （拍板 8：管道内无验证方，令牌不进子进程）。个人面（D26 §6）复用：
/// plugin_root 传空串、config 传空表）
pub(crate) fn mcp_server_wire(
    name: &str,
    def: &Value,
    plugin_root: &str,
    user: &(String, String),
    config: &serde_json::Map<String, Value>,
) -> Option<Value> {
    let subst_static = |s: &str| -> String {
        let mut out = s.replace("${PLUGIN_ROOT}", plugin_root);
        out = out.replace("${BBC_USER_ID}", &user.0);
        out = out.replace("${BBC_USER_NAME}", &user.1);
        // CONFIG:key（缺省保留占位符——外部系统收到 401 比伪值诚实）
        if out.contains("${CONFIG:") {
            let mut replaced = out.clone();
            for (k, v) in config {
                let pat = format!("${{CONFIG:{k}}}");
                if let Some(vs) = v.as_str() {
                    replaced = replaced.replace(&pat, vs);
                }
            }
            out = replaced;
        }
        // stdio 约定：TOKEN 不进子进程 env（HTTP-only）
        out.replace("${BBC_USER_TOKEN}", "")
    };
    // D38 拍板 8：stdio 永不需要令牌——声明统一身份直接拒装（发布校验双保险，
    // 装配器为最后一道）
    if def.get("command").is_some() && def.get("x-bbc-auth").is_some() {
        eprintln!(
            "[bbc-bridge] MCP server '{name}' 为 stdio 形态却声明 x-bbc-auth（D38：stdio 永不需要令牌），拒装"
        );
        return None;
    }
    if let Some(cmd) = def.get("command").and_then(Value::as_str) {
        let args: Vec<String> = def
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(&subst_static)
                    .collect()
            })
            .unwrap_or_default();
        let env = match def.get("env").and_then(Value::as_object) {
            Some(m) => m
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        Value::String(subst_static(&v.to_string().trim_matches('"'))),
                    )
                })
                .collect::<serde_json::Map<String, Value>>(),
            None => serde_json::Map::new(),
        };
        return Some(json!({
            "name": name,
            "transport": { "kind": "stdio", "command": subst_static(cmd), "args": args, "env": env }
        }));
    }
    if let Some(url) = def.get("url").and_then(Value::as_str) {
        // headers：CONFIG 静态替换，${BBC_USER_TOKEN} 保留（RT 调用层动态替换）
        let headers = match def.get("headers").and_then(Value::as_object) {
            Some(m) => m
                .iter()
                .map(|(k, v)| {
                    let raw = v.to_string().trim_matches('"').to_string();
                    let val = if raw.contains("${BBC_USER_TOKEN}") {
                        raw // 保留给 RT
                    } else {
                        subst_static(&raw)
                    };
                    (k.clone(), Value::String(val))
                })
                .collect::<serde_json::Map<String, Value>>(),
            None => serde_json::Map::new(),
        };
        // 统一身份（D38 §5）：显式 x-bbc-auth 优先；旧 headers TOKEN 写法归一（拍板 12）。
        // 受众=该 server url（目的地即受众）；scope 声明透传（空=服务端按用户全量签）
        let legacy = headers
            .values()
            .any(|v| v.as_str().map_or(false, |s| s.contains("${BBC_USER_TOKEN}")));
        let auth = def.get("x-bbc-auth").map(|a| {
            let scope = a
                .get("scope")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({ "type": "obo", "audience": url, "scope": scope })
        });
        let auth = match auth {
            Some(a) => Some(a),
            None if legacy => {
                // 拍板 12 归一：旧插件零修改升级（headers 原样保留——RT 按受众票替换占位）
                Some(json!({ "type": "obo", "audience": url, "scope": [] }))
            }
            None => None,
        };
        let mut transport = json!({ "kind": "http", "baseUrl": url, "headers": headers });
        if let Some(a) = auth {
            transport["auth"] = a;
        }
        return Some(json!({
            "name": name,
            "transport": transport
        }));
    }
    None
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
                approval_timeout_secs: None,
            }]),
            token: Mutex::new(None),
            // 并发防重入锁（ensure_running 双检查用；测试不经并发路径，空锁即可）
            spawn_lock: Mutex::new(()),
            // D22 L4：Shared.user（换账号重推装配）——测试补齐缺省空身份
            user: Mutex::new((String::new(), String::new())),
            // D28 Q0：设备号/OBO 权限集/网关基址（测试缺省空 + 本地兜底）
            did: Mutex::new(String::new()),
            obo_scopes: Mutex::new(Vec::new()),
            gateway: "http://127.0.0.1:8080".into(),
            halted: AtomicBool::new(false),
            // D38 批5：统一身份受众集合（测试缺省空——无受众即无票）
            audiences: Mutex::new(Vec::new()),
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

    // ── D38 批5：统一身份装配（x-bbc-auth 解析/旧写法归一/stdio 拒装/受众=目的地）──

    #[test]
    fn wire_explicit_auth_audience_is_url() {
        let def = json!({
            "url": "https://oa.company.internal/mcp",
            "x-bbc-auth": { "type": "obo", "scope": ["oa:read"] }
        });
        let w = mcp_server_wire("oa", &def, "", &(String::new(), String::new()), &Default::default())
            .expect("声明统一身份应出 wire");
        let auth = &w["transport"]["auth"];
        assert_eq!(auth["type"], "obo");
        assert_eq!(auth["audience"], "https://oa.company.internal/mcp", "受众=目的地");
        assert_eq!(auth["scope"][0], "oa:read");
    }

    #[test]
    fn wire_legacy_token_header_normalized() {
        // 拍板 12：旧 headers ${BBC_USER_TOKEN} 写法归一为统一身份（headers 原样保留给 RT）
        let def = json!({
            "url": "https://hr.company.internal/mcp",
            "headers": { "Authorization": "Bearer ${BBC_USER_TOKEN}" }
        });
        let w = mcp_server_wire("hr", &def, "", &(String::new(), String::new()), &Default::default())
            .expect("旧写法应归一出 wire");
        assert_eq!(w["transport"]["auth"]["audience"], "https://hr.company.internal/mcp");
        assert_eq!(
            w["transport"]["headers"]["Authorization"],
            "Bearer ${BBC_USER_TOKEN}",
            "headers 占位保留——RT 按受众票替换"
        );
    }

    #[test]
    fn wire_plain_http_has_no_auth() {
        let def = json!({
            "url": "https://gitlab.company.com/api/mcp",
            "headers": { "Private-Token": "${CONFIG:gitlab_token}" }
        });
        let w = mcp_server_wire(
            "gitlab",
            &def,
            "",
            &(String::new(), String::new()),
            &serde_json::Map::from_iter([("gitlab_token".into(), json!("secret-x"))]),
        )
        .expect("普通外部系统应出 wire");
        assert!(w["transport"]["auth"].is_null(), "无声明=匿名不注入");
        assert_eq!(w["transport"]["headers"]["Private-Token"], "secret-x");
    }

    #[test]
    fn wire_stdio_with_auth_rejected() {
        // 拍板 8：stdio 永不需要令牌——声明 x-bbc-auth 拒装
        let def = json!({
            "command": "node",
            "args": ["server.mjs"],
            "x-bbc-auth": { "type": "obo" }
        });
        assert!(
            mcp_server_wire("local", &def, "", &(String::new(), String::new()), &Default::default())
                .is_none(),
            "stdio + x-bbc-auth 应拒装"
        );
    }

    #[test]
    fn audiences_extracted_from_assembly() {
        // 受众集合提取： corp 恒在 + 插件声明者入集（没装就没受众——D38 §3.1）
        let assembly = vec![
            json!({ "name": "corp", "transport": { "kind": "http", "baseUrl": "http://x/mcp/corp",
                "auth": { "type": "obo", "audience": "bbc-corp", "scope": [] } } }),
            json!({ "name": "oa", "transport": { "kind": "http", "baseUrl": "https://oa.internal/mcp",
                "auth": { "type": "obo", "audience": "https://oa.internal/mcp", "scope": ["oa:read"] } } }),
            json!({ "name": "gitlab", "transport": { "kind": "http", "baseUrl": "https://gl/api" } }),
        ];
        let mut auds = Vec::new();
        for srv in &assembly {
            if let (Some(aud), scope) = (
                srv["transport"]["auth"]["audience"].as_str(),
                srv["transport"]["auth"]["scope"].as_array(),
            ) {
                let sc: Vec<String> = scope
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                auds.push((aud.to_string(), sc));
            }
        }
        assert_eq!(auds.len(), 2, "无 auth 的 server 不进受众集合");
        assert_eq!(auds[0].0, "bbc-corp");
        assert_eq!(auds[1].0, "https://oa.internal/mcp");
        assert_eq!(auds[1].1, vec!["oa:read".to_string()]);
    }

    /// 回执载荷须携带信封层 type（2026-11-24 幽灵会话根因：Envelope::wrap 把 type
    /// 提升出 payload，等待方只拿 payload → 调用点 `rep["type"] == "error"` 恒假，
    /// RT 拒绝建会话被当成功）。样例=真机抓包（彼时活跃上限 3 的第 4 个
    /// session.start；上限已于同日解除，样例仅作信封格式回归）
    #[test]
    fn reply_payload_carries_envelope_type() {
        let env = json!({
            "v": 1, "id": "r-7", "reply_to": "h-5", "type": "error",
            "payload": { "code": 8001, "fatal": false,
                         "message": "活跃会话已达上限（3），请先结束旧会话", "sessionId": "diag-4" }
        });
        assert!(
            env["payload"].get("type").is_none(),
            "前提：线上回执 payload 本身不带 type"
        );
        let rep = reply_payload(&env);
        assert_eq!(rep["type"], "error");
        assert_eq!(rep["code"], 8001);
        assert_eq!(rep["message"], "活跃会话已达上限（3），请先结束旧会话");
        assert_eq!(rep["sessionId"], "diag-4", "其余字段原样保留");

        // 正常回执同理；原信封不被改动
        let ok = json!({ "type": "session.ready", "reply_to": "h-2", "payload": { "sessionId": "s1" } });
        let rep = reply_payload(&ok);
        assert_eq!(rep["type"], "session.ready");
        assert_eq!(rep["sessionId"], "s1");
        assert!(ok["payload"].get("type").is_none());

        // 无字段回执（payload 缺省=Null）不得 panic
        assert_eq!(reply_payload(&json!({ "type": "pong" }))["type"], "pong");
    }

    /// 读泵投递路径：经 complete_req 送达等待方的回执带 type（等待方据此判 RT 拒绝）；
    /// 无等待方（超时后迟到）返回 false 不投递
    #[test]
    fn complete_req_delivers_typed_reply() {
        let (shared, _) = shared_with_starting_session();
        let (tx, rx) = mpsc::channel();
        shared.proc.lock().unwrap().pending.insert("h-5".into(), tx);
        let env = json!({ "reply_to": "h-5", "type": "error", "payload": { "code": 8001, "message": "拒" } });
        assert!(shared.complete_req("h-5", reply_payload(&env)));
        let rep = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(rep["type"], "error");
        assert_eq!(rep["message"], "拒");
        assert!(
            !shared.complete_req("h-late", reply_payload(&env)),
            "无等待方=不投递"
        );
    }
}
