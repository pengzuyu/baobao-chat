//! 外部智能体接入面（D30）：打开中的壳对外长出本机回环 A2A server 面。
//!
//! 一个内核两张脸：A2A 正身（本模块，批1）+ MCP 方言脸（批3，同监听器
//! POST /mcp）；`bbw ask` CLI 为第三客户端（批2）。会话执行完全复用
//! AgentHost（agent_start_session → user.message → 事件泵，零改动），
//! D14 不破——服务端照旧不跑 agent 会话。
//!
//! 任务生命周期映射（D30 §3）：task.id = bbw sessionId（续聊天然）；
//! working ← user.message；input-required ← permission.request/clarify.question
//! （卡照弹 App 内，人点后自动回 working）；completed ← session.state idle
//! （首次 tasks/get 触发 session.history 提取最后一条 assistant 原文）；
//! failed ← runtime down / session.ended（working 中）。
//!
//! 鉴权（D30 §5）：除 agent card 外全端点要求 Authorization: Bearer 本机
//! token（0600 落 {dataDir}/external-agent-token；撤销=regenerate）。
//! 防环（拍板4）：外部会话集合见 ExtHub，agent_delegate_launch 命令层拦截。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Response, Server};

use crate::agent_bridge::AgentHost;

/// 缺省端口（D30 §2）；env BBW_EXT_AGENT_PORT 可覆盖；占用时 +1 重试至 +9
pub const DEFAULT_PORT: u16 = 8791;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 单个外部任务（对一会话；状态按「最新一轮」口径，续聊即新一轮重置）
#[derive(Clone)]
struct ExtTask {
    state: String, // working | input-required | completed | failed | canceled
    answer: Option<String>,
    note: Option<String>,
    updated_at: i64,
}

/// 外部接入共享态：任务表 + 本机 token（授权卡 regenerate 即时生效）。
/// 事件泵 emit fan-out 喂 dispatch()；agent_delegate_launch 查 is_external 防环。
pub struct ExtHub {
    tasks: Mutex<HashMap<String, ExtTask>>,
    token: Mutex<String>,
    /// 实际绑定端口（agent card url 用；冲突回落时≠DEFAULT_PORT）
    port: std::sync::atomic::AtomicU16,
    /// 监听线程是否已起（授权卡在线状态）
    online: std::sync::atomic::AtomicBool,
}

impl ExtHub {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            token: Mutex::new(String::new()), // start() 装载/生成后非空
            port: std::sync::atomic::AtomicU16::new(DEFAULT_PORT),
            online: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// 事件喂入（normalize 后 snake_case 事件，含顶层 type/session_id）
    pub fn dispatch(&self, evt: &Value) {
        let typ = evt["type"].as_str().unwrap_or("");
        let sid = evt["session_id"].as_str().unwrap_or("").to_string();
        let mut tasks = self.tasks.lock().unwrap();
        match typ {
            // 状态机只认四类事件；delta 等高频事件早退（锁开销零）
            "session.state" | "permission.request" | "clarify.question" | "session.ended" => {}
            "runtime.state" => {
                // Runtime 退出：全部在途任务判 failed（壳自产事件，无 session_id）
                if evt["state"].as_str() == Some("down") {
                    let now = now_ms();
                    for t in tasks.values_mut() {
                        if t.state == "working" || t.state == "input-required" {
                            t.state = "failed".into();
                            t.note = Some("Runtime 已退出".into());
                            t.updated_at = now;
                        }
                    }
                }
                return;
            }
            _ => return,
        }
        let Some(t) = tasks.get_mut(&sid) else { return };
        let now = now_ms();
        t.updated_at = now;
        match typ {
            "session.state" => {
                match evt["state"].as_str().unwrap_or("") {
                    // 新一轮开跑：清上一轮答案（续聊 send 侧也重置，双保险）
                    "running" if t.state != "canceled" && t.state != "failed" => {
                        t.state = "working".into();
                        t.answer = None;
                        t.note = None;
                    }
                    // 该轮收口（working/input-required → completed；答案惰性提取）
                    "idle" if t.state == "working" || t.state == "input-required" => {
                        t.state = "completed".into();
                        t.note = None;
                    }
                    _ => {}
                }
            }
            // 审批/澄清卡已在 App 内弹出——调用方只见状态翻转，人点后自动回 working
            "permission.request" | "clarify.question" => {
                if t.state == "working" {
                    t.state = "input-required".into();
                    t.note = Some("等待在 BaobaoChat 内确认审批/澄清卡".into());
                }
            }
            "session.ended" => {
                if t.state == "working" || t.state == "input-required" {
                    t.state = "failed".into();
                    t.note = Some("会话已被结束".into());
                }
            }
            _ => {}
        }
    }

    /// 防环（拍板4）：该会话是否外部接入创建（任务表命中即外部；
    /// 壳重启后历史外部会话靠标题前缀兜底识别）
    pub fn is_external(&self, host: &AgentHost, session_id: &str) -> bool {
        if self.tasks.lock().unwrap().contains_key(session_id) {
            return true;
        }
        host.list_sessions().iter().any(|s| {
            s["id"].as_str() == Some(session_id)
                && s["title"]
                    .as_str()
                    .is_some_and(|t| t.starts_with(EXTERNAL_TITLE_PREFIX))
        })
    }

    fn upsert_sent(&self, sid: &str) {
        self.tasks.lock().unwrap().insert(
            sid.to_string(),
            ExtTask {
                state: "working".into(),
                answer: None,
                note: None,
                updated_at: now_ms(),
            },
        );
    }

    fn snapshot(&self, sid: &str) -> Option<ExtTask> {
        self.tasks.lock().unwrap().get(sid).cloned()
    }

    fn check_token(&self, presented: &str) -> bool {
        let tok = self.token.lock().unwrap();
        !tok.is_empty() && presented == tok.as_str()
    }

    fn set_token(&self, token: String) {
        *self.token.lock().unwrap() = token;
    }

    /// 答案惰性提取：completed 且未取过 → session.history 最后一条 assistant
    /// 原文（REQ 回执为协议 camelCase，不经 normalize）
    fn ensure_answer(&self, host: &AgentHost, sid: &str, task: &mut ExtTask) {
        if task.state != "completed" || task.answer.is_some() {
            return;
        }
        task.answer = Some(String::new()); // 先占位防重入
        let extracted = host
            .request("session.history", json!({ "sessionId": sid }))
            .ok()
            .and_then(|rep| {
                rep["items"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .rev()
                    .find(|it| it["kind"] == "assistant")
                    .and_then(|it| it["text"].as_str().map(str::to_string))
            });
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(t) = tasks.get_mut(sid) {
            t.answer = extracted.filter(|s| !s.is_empty());
            if t.answer.is_none() {
                t.note = Some("本轮无文本回复（可能仅工具调用）".into());
            }
        }
    }
}

const EXTERNAL_TITLE_PREFIX: &str = "外部智能体";

/// 装载/生成本机 token（0600 落盘；uuid v4 ×2 拼接≈244bit 熵，零新依赖）
fn load_or_create_token(data_dir: &Path) -> String {
    let path = data_dir.join("external-agent-token");
    if let Ok(tok) = std::fs::read_to_string(&path) {
        let tok = tok.trim().to_string();
        if tok.len() >= 32 {
            return tok;
        }
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let _ = std::fs::write(&path, &token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    token
}

/// 状态文件（CLI 动态发现端口用；D30 §9 端口冲突兜底）
fn write_status_file(data_dir: &Path, port: u16) {
    let _ = std::fs::write(
        data_dir.join("external-agent.json"),
        json!({ "port": port, "version": 1, "online": true }).to_string(),
    );
}

/// 启动接入面（lib.rs setup 调用）：装 token → 绑定（冲突 +1 重试至 +9，
/// env BBW_EXT_AGENT_PORT 起点可覆盖）→ 状态文件 → 监听线程。
/// App 关闭即面消失（D30 前提=打开状态）。
pub fn start(app: AppHandle, hub: Arc<ExtHub>, data_dir: PathBuf) {
    hub.set_token(load_or_create_token(&data_dir));
    let base = std::env::var("BBW_EXT_AGENT_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let mut server = None;
    let mut bound = base;
    for off in 0..10 {
        match Server::http(("127.0.0.1", base + off)) {
            Ok(s) => {
                server = Some(s);
                bound = base + off;
                break;
            }
            Err(_) => continue,
        }
    }
    let Some(server) = server else {
        eprintln!("[bbw-ext] 外部接入面端口 {base}~{} 全部占用，未启动", base + 9);
        return;
    };
    if bound != base {
        eprintln!("[bbw-ext] 端口 {base} 被占用，回落 {bound}");
    }
    hub.port
        .store(bound, std::sync::atomic::Ordering::SeqCst);
    write_status_file(&data_dir, bound);
    eprintln!("[bbw-ext] 外部智能体接入面在线: http://127.0.0.1:{bound}/");
    hub.online.store(true, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = app.clone();
            let hub = hub.clone();
            std::thread::spawn(move || handle(request, app, hub));
        }
    });
}

// ---------------------------------------------------------------------------
// 授权卡命令层（D30 批4）：状态查询 / token 重发（撤销=重新生成即旧失效）
// ---------------------------------------------------------------------------

/// 接入面状态（设置页「外部 Agent 接入」卡数据源）
#[tauri::command]
pub fn ext_agent_status(hub: tauri::State<'_, Arc<ExtHub>>) -> Result<Value, String> {
    Ok(json!({
        "online": hub.online.load(std::sync::atomic::Ordering::SeqCst),
        "port": hub.port.load(std::sync::atomic::Ordering::SeqCst),
        "token": hub.token.lock().unwrap().clone(),
    }))
}

/// 重新生成本机 token（=撤销既有授权：旧 token 立即 401；0600 重落盘）
#[tauri::command]
pub fn ext_agent_token_regen(
    hub: tauri::State<'_, Arc<ExtHub>>,
    host: tauri::State<'_, AgentHost>,
) -> Result<Value, String> {
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let path = host.data_dir().join("external-agent-token");
    std::fs::write(&path, &token).map_err(|e| format!("token 写入失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    hub.set_token(token.clone());
    Ok(json!({ "token": token }))
}

fn handle(mut request: tiny_http::Request, app: AppHandle, hub: Arc<ExtHub>) {
    let url = request.url().split('?').next().unwrap_or("/").to_string();
    let method = request.method().clone();
    // agent card 无鉴权（可发现性，D30 §3）；其余端点一律 Bearer
    let path = url.as_str();
    if method == Method::Get && (path == "/.well-known/agent-card.json" || path == "/agent-card.json") {
        respond_json(
            request,
            200,
            json!({
                "name": "BaobaoChat Agent",
                "description": "BaobaoChat agent 会话（知识检索/记忆/专家/工具）——外部智能体经 A2A 当子智能体调用",
                "url": format!("http://127.0.0.1:{}/", hub.port.load(std::sync::atomic::Ordering::SeqCst)),
                "version": "0.1.0",
                "capabilities": { "streaming": false },
                "defaultInputModes": ["text"],
                "defaultOutputModes": ["text"],
                "skills": [{
                    "id": "chat", "name": "智能体对话",
                    "description": "发起/续聊一轮 bbw agent 会话（task.id=sessionId 可续）；知识检索走本人权限"
                }]
            }),
        );
        return;
    }
    if path == "/mcp" && method != Method::Post {
        // streamable HTTP：server 主动 SSE 不做（stateless），GET/DELETE 一律 405
        respond_json(request, 405, json!({ "error": "method not allowed" }));
        return;
    }
    if method != Method::Post || path != "/" {
        respond_json(request, 404, json!({ "error": "not found" }));
        return;
    }
    if !hub.check_token(&bearer_of(&request)) {
        respond_json(
            request,
            401,
            json!({ "error": "unauthorized", "hint": "设置 → 外部 Agent 接入 查看本机 token" }),
        );
        return;
    }
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        respond_json(request, 400, json!({ "error": "bad request" }));
        return;
    }
    let rpc: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            respond_json(request, 200, rpc_error(Value::Null, -32700, &format!("parse error: {e}")));
            return;
        }
    };
    // MCP 方言脸（批3）：翻译到同一 A2A 任务内核
    if path == "/mcp" {
        match mcp_dispatch(&app, &hub, &rpc) {
            McpReply::Json(v) => respond_json(request, 200, v),
            McpReply::Accepted => respond_json(request, 202, json!(null)),
        }
        return;
    }
    let id = rpc["id"].clone();
    // A2A 即 JSON-RPC：成功响应必须 {"jsonrpc","id","result"} 信封包裹——裸 task
    // 对象会被调用方按 result 解包拿到 Null（2026-11-16 bbw ask 轮询
    // 「params.id 缺失」事故：send 响应 task.id 解析为空）
    let reply = match rpc["method"].as_str().unwrap_or("") {
        "message/send" => match handle_send(&app, &hub, rpc["params"].clone()) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, msg)) => rpc_error(id.clone(), code, &msg),
        },
        "tasks/get" => match handle_get(&app, &hub, rpc["params"].clone()) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, msg)) => rpc_error(id.clone(), code, &msg),
        },
        "tasks/cancel" => match handle_cancel(&app, &hub, rpc["params"].clone()) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, msg)) => rpc_error(id.clone(), code, &msg),
        },
        other => rpc_error(id.clone(), -32601, &format!("method not found: {other}")),
    };
    respond_json(request, 200, reply);
}

// ---------------------------------------------------------------------------
// MCP 方言脸（D30 §4）：stateless streamable HTTP——initialize / ping /
// tools/list / tools/call + notifications 202；单工具 bbw_agent_chat 内联
// 等待终态（对 A2A 任务内核的纯翻译，无第二套实现）
// ---------------------------------------------------------------------------

enum McpReply {
    Json(Value),
    Accepted,
}

fn mcp_dispatch(app: &AppHandle, hub: &ExtHub, rpc: &Value) -> McpReply {
    let id = rpc["id"].clone();
    let method = rpc["method"].as_str().unwrap_or("");
    // 通知（无 id）：202 空应答（notifications/initialized 等）
    if id.is_null() {
        return McpReply::Accepted;
    }
    let result = match method {
        "initialize" => Ok(json!({
            // 回显客户端协议版本（不识别回落 2025-03-26 基线）
            "protocolVersion": rpc["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "bbw-agent", "version": "0.1.0" }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [tool_def()] })),
        "tools/call" => mcp_tool_call(app, hub, &rpc["params"]),
        other => Err((-32601, format!("method not found: {other}"))),
    };
    match result {
        Ok(v) => McpReply::Json(json!({ "jsonrpc": "2.0", "id": id, "result": v })),
        Err((code, msg)) => McpReply::Json(rpc_error(id, code, &msg)),
    }
}

fn tool_def() -> Value {
    json!({
        "name": "bbw_agent_chat",
        "description": "把打开中的 BaobaoChat agent 当子智能体调用：发起/续聊一轮完整 agent 会话\
（知识检索/记忆/专家/公司工具，按当前登录用户权限）。返回本轮最终回答；\
审批/澄清卡会弹在 BaobaoChat 窗口内等待人工确认，调用侧自动等待。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "用户消息/任务指令" },
                "session_id": { "type": "string", "description": "续聊会话 id（首轮省略；来自上次返回）" },
                "timeout_secs": { "type": "integer", "description": "等待终态超时（缺省 600）" }
            },
            "required": ["prompt"]
        }
    })
}

/// bbw_agent_chat：message/send → 内联轮询 ExtHub 至终态 → content 文本
fn mcp_tool_call(app: &AppHandle, hub: &ExtHub, params: &Value) -> Result<Value, (i64, String)> {
    if params["name"].as_str() != Some("bbw_agent_chat") {
        return Err((-32602, format!("unknown tool: {}", params["name"].as_str().unwrap_or("?"))));
    }
    let args = &params["arguments"];
    let prompt = args["prompt"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| (-32602, "arguments.prompt 缺失".to_string()))?;
    let timeout = args["timeout_secs"].as_u64().unwrap_or(600);
    let mut message = json!({
        "role": "user",
        "parts": [{ "kind": "text", "text": prompt }],
        "metadata": {},
    });
    if let Some(sid) = args["session_id"].as_str().filter(|s| !s.is_empty()) {
        message["taskId"] = json!(sid);
    }
    let task = handle_send(app, hub, json!({ "message": message }))?;
    let sid = task["id"].as_str().unwrap_or_default().to_string();
    let started = std::time::Instant::now();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(700));
        let task = handle_get(app, hub, json!({ "id": sid }))?;
        match task["status"]["state"].as_str().unwrap_or("") {
            "completed" => {
                let answer = task["artifacts"][0]["parts"][0]["text"].as_str().unwrap_or("");
                let text = if answer.is_empty() {
                    format!(
                        "（本轮无文本回复——{}）\n[session {sid}]",
                        task["status"]["message"]["parts"][0]["text"].as_str().unwrap_or("可能仅工具调用")
                    )
                } else {
                    format!("{answer}\n[session {sid} · 传 session_id 可续聊]")
                };
                return Ok(json!({ "content": [{ "type": "text", "text": text }] }));
            }
            "failed" | "canceled" => {
                let msg = task["status"]["message"]["parts"][0]["text"].as_str().unwrap_or("");
                return Ok(json!({
                    "content": [{ "type": "text", "text": format!("{msg} [session {sid}]") }],
                    "isError": true
                }));
            }
            // working / input-required：审批卡已弹 App 内，继续等
            _ => {
                if started.elapsed().as_secs() >= timeout {
                    return Ok(json!({
                        "content": [{ "type": "text", "text": format!(
                            "等待超时（{timeout}s）——会话仍在 BaobaoChat 内运行；续查：bbw ask --session {sid}"
                        ) }],
                        "isError": true
                    }));
                }
            }
        }
    }
}

/// message/send：text parts 提取 →（metadata.sessionId/taskId 复用 | 新建）
/// → user.message → 登记 working → 立即返回任务（异步轮询模式）
fn handle_send(
    app: &AppHandle,
    hub: &ExtHub,
    params: Value,
) -> Result<Value, (i64, String)> {
    let text: String = params["message"]["parts"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p["kind"].as_str().map_or(true, |k| k == "text"))
        .filter_map(|p| p["text"].as_str().map(str::to_string))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err((-32602, "params.message.parts 无文本".into()));
    }
    let host = app.state::<AgentHost>();
    // 续聊：taskId 或 metadata.sessionId 指向既有会话
    let reuse = params["message"]["taskId"]
        .as_str()
        .or_else(|| params["message"]["metadata"]["sessionId"].as_str())
        .map(str::to_string);
    let sid = match reuse {
        Some(sid) if !sid.is_empty() => sid,
        _ => host
            .start_session(
                "",
                "ask",
                "auto",
                None,
                Some(&format!("{EXTERNAL_TITLE_PREFIX}·{}", truncate(&text, 24))),
            )
            .map_err(|e| (-32603, format!("会话创建失败：{e}")))?,
    };
    let rep = host
        .request("user.message", json!({ "sessionId": sid, "text": text, "attachments": [], "thinking": null }))
        .map_err(|e| (-32603, format!("消息发送失败：{e}")))?;
    if rep["type"] == "error" {
        return Err((-32603, format!("消息被拒：{}", rep["message"].as_str().unwrap_or("runtime error"))));
    }
    hub.upsert_sent(&sid);
    let mut task = task_json(&sid, "working", None, None);
    task["metadata"]["prompt"] = json!(text); // 调试/审计可见（dead 字段消化）
    Ok(task)
}

/// tasks/get：本地态零 RT 往返；completed 首次触发答案提取
fn handle_get(app: &AppHandle, hub: &ExtHub, params: Value) -> Result<Value, (i64, String)> {
    let sid = params["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| (-32602, "params.id 缺失".to_string()))?;
    let mut task = hub
        .snapshot(sid)
        .ok_or_else(|| (-32602, format!("任务不存在: {sid}")))?;
    hub.ensure_answer(&app.state::<AgentHost>(), sid, &mut task);
    Ok(task_json(sid, &task.state, task.answer.as_deref(), task.note.as_deref()))
}

/// tasks/cancel：session.interrupt 中断当前轮（会话保留可续）
fn handle_cancel(app: &AppHandle, hub: &ExtHub, params: Value) -> Result<Value, (i64, String)> {
    let sid = params["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| (-32602, "params.id 缺失".to_string()))?;
    if hub.snapshot(sid).is_none() {
        return Err((-32602, format!("任务不存在: {sid}")));
    }
    let host = app.state::<AgentHost>();
    host.request("session.interrupt", json!({ "sessionId": sid }))
        .map_err(|e| (-32603, format!("中断失败：{e}")))?;
    if let Some(t) = hub.tasks.lock().unwrap().get_mut(sid) {
        if t.state == "working" || t.state == "input-required" {
            t.state = "canceled".into();
            t.note = Some("当前轮已中断，会话可续聊".into());
        }
    }
    Ok(task_json(sid, "canceled", None, Some("当前轮已中断，会话可续聊")))
}

/// A2A Task 形状（宽松子集；completed 附 artifacts）
fn task_json(sid: &str, state: &str, answer: Option<&str>, note: Option<&str>) -> Value {
    let mut status = json!({ "state": state });
    if let Some(n) = note {
        status["message"] = json!({ "role": "agent", "parts": [{ "kind": "text", "text": n }] });
    }
    let mut task = json!({
        "id": sid, "contextId": sid, "status": status,
        "metadata": { "session_id": sid, "kind": "bbw-session" }
    });
    if state == "completed" {
        task["artifacts"] = json!([{ "parts": [{ "kind": "text", "text": answer.unwrap_or("") }] }]);
    }
    task
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn bearer_of(request: &tiny_http::Request) -> String {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .and_then(|h| h.value.as_str().strip_prefix("Bearer ").map(str::to_string))
        .unwrap_or_default()
}

fn respond_json(request: tiny_http::Request, status: u16, body: Value) {
    let payload = body.to_string();
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = request.respond(
        Response::from_string(payload)
            .with_status_code(status)
            .with_header(header),
    );
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
