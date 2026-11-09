//! Agent IPC 命令层（D08 §5.1 命令表的 Tauri 实现）：
//! 前端 bridge/tauri.ts 的 invoke 全表（参数 camelCase 由 Tauri 自动映射 snake_case 形参）。
//! 同步命令（跑独立线程池）——内部 request() 阻塞等回执，15s 超时。
//! 事件回流：agent_bridge 事件泵 → app.emit("agent://event", payload)（setup 装配注入）。

use serde_json::{json, Value};
use tauri::State;

use crate::agent_bridge::AgentHost;

type Host<'a> = State<'a, AgentHost>;

/// 会话列表（宿主缓存镜像；协议无查询消息）
#[tauri::command]
pub fn session_list(host: Host) -> Result<Value, String> {
    Ok(json!({ "items": host.list_sessions() }))
}

/// 新建会话：宿主生成 sessionId → session.start（等 session.ready 回执）
#[tauri::command]
pub fn agent_start_session(
    host: Host,
    workspace_id: String,
    mode: String,
    model_policy: String,
    model: Option<String>,
) -> Result<Value, String> {
    let sid = host.start_session(&workspace_id, &mode, &model_policy, model.as_deref())?;
    Ok(json!({ "session_id": sid }))
}

/// 用户输入（回执=session.state running/queued；命令返回 ok 而非透传协议回执）
#[tauri::command]
pub fn agent_input(host: Host, session_id: String, text: String) -> Result<Value, String> {
    host.request(
        "user.message",
        json!({ "sessionId": session_id, "text": text, "attachments": [] }),
    )?;
    Ok(json!({ "ok": true }))
}

/// 会话内切换模型（model=直达引用 p:<id>:<model>；回执 model.switched 事件驱动 UI）
#[tauri::command]
pub fn agent_switch_model(
    host: Host,
    session_id: String,
    to: String,
    model: Option<String>,
) -> Result<(), String> {
    host.fire(
        "model.switch",
        json!({ "sessionId": session_id, "to": to, "model": model, "reason": "user" }),
    )
}

/// 权限模式（协议缺口：宿主本地记录）
#[tauri::command]
pub fn agent_set_mode(host: Host, session_id: String, mode: String) -> Result<(), String> {
    host.set_mode(&session_id, &mode);
    Ok(())
}

#[tauri::command]
pub fn agent_pause(host: Host, session_id: String) -> Result<Value, String> {
    host.request("session.pause", json!({ "sessionId": session_id }))?;
    Ok(json!({ "ok": true }))
}

/// RT 侧 session.resume 尚未实现（回执缺失）——fire-and-forget 乐观返回
#[tauri::command]
pub fn agent_resume(host: Host, session_id: String) -> Result<Value, String> {
    host.fire("session.resume", json!({ "sessionId": session_id }))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn agent_stop(host: Host, session_id: String, reason: String) -> Result<Value, String> {
    host.request("session.end", json!({ "sessionId": session_id, "reason": if reason.is_empty() { "normal".into() } else { reason } }))?;
    Ok(json!({ "ok": true }))
}

/// 紧急停止：杀 Runtime 进程组（D09 §4.6；killed/cancelled 由宿主拼装）
#[tauri::command]
pub fn agent_emergency_stop(host: Host) -> Result<Value, String> {
    Ok(host.emergency_stop())
}

#[tauri::command]
pub fn agent_approve(
    host: Host,
    request_id: String,
    scope: String,
    edited_args: Option<Value>,
) -> Result<(), String> {
    host.fire(
        "permission.response",
        json!({
            "requestId": request_id, "decision": "allow", "scope": scope, "editedArgs": edited_args,
        }),
    )
}

#[tauri::command]
pub fn agent_reject(host: Host, request_id: String) -> Result<(), String> {
    host.fire(
        "permission.response",
        json!({ "requestId": request_id, "decision": "deny", "scope": "once" }),
    )
}

/// 知识记忆列表（REQ→memory.list.result；条目键名转 snake 供 FE MemoryRow）
#[tauri::command]
pub fn memory_list(host: Host) -> Result<Value, String> {
    let result = host.request("memory.list", json!({ "limit": 200 }))?;
    Ok(json!({ "items": result["items"].clone() }))
}

#[tauri::command]
pub fn memory_delete(host: Host, name: String) -> Result<Value, String> {
    host.request("memory.delete", json!({ "name": name }))?;
    Ok(json!({ "ok": true }))
}

/// 日报列表（REQ→report.list.result；stats 键对齐 FE ReportStats）
#[tauri::command]
pub fn report_list(host: Host, limit: Option<u32>) -> Result<Value, String> {
    let result = host.request("report.list", json!({ "limit": limit.unwrap_or(30) }))?;
    Ok(json!({ "items": result["items"].clone() }))
}

/// 日报正文：直接读 {dataDir}/agent/reports/{date}.md（协议无正文查询消息）
#[tauri::command]
pub fn report_get(host: Host, date: String) -> Result<Value, String> {
    // 日期白名单（防路径穿越）
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("非法日期".into());
    }
    let path = host
        .data_dir()
        .join("agent")
        .join("reports")
        .join(format!("{date}.md"));
    let markdown = std::fs::read_to_string(&path).map_err(|_| format!("日报不存在: {date}"))?;
    Ok(json!({ "markdown": markdown }))
}

/// 确认委派启动（delegate.launch；D16 §5 简报阶段——run 尚未后台化，
/// RT 按 sessionId 定向投递 runner 通道）。task_brief=None=沿用模型原稿
/// （确认不改稿是主路径；编辑稿随 P1 简报编辑器）。mode/workspace 为协议
/// 必填字段，从会话缓存回填（RT dispatch 侧忽略）。
#[tauri::command]
pub fn agent_delegate_launch(
    host: Host,
    session_id: String,
    delegate_task_id: String,
    backend: String,
    task_brief: Option<Value>,
) -> Result<(), String> {
    let (mode, workspace) = host
        .list_sessions()
        .iter()
        .find(|s| s["id"].as_str() == Some(session_id.as_str()))
        .map(|s| {
            (
                s["mode"].as_str().unwrap_or("ask").to_string(),
                s["workspace"].as_str().unwrap_or("").to_string(),
            )
        })
        .unwrap_or_else(|| ("ask".into(), String::new()));
    host.fire(
        "delegate.launch",
        json!({
            "sessionId": session_id, "delegateTaskId": delegate_task_id, "backend": backend,
            "taskBrief": task_brief, "mode": mode, "workspace": workspace,
        }),
    )
}

/// 委派追加指令（模式 C 续问；17 §8 send_input）
#[tauri::command]
pub fn agent_delegate_input(
    host: Host,
    delegate_task_id: String,
    text: String,
) -> Result<(), String> {
    host.fire(
        "delegate.input",
        json!({ "delegateTaskId": delegate_task_id, "text": text }),
    )
}

/// 取消委派（SIGINT→3s→SIGKILL 进程组；后台/简报期均可）
#[tauri::command]
pub fn agent_delegate_cancel(host: Host, delegate_task_id: String) -> Result<(), String> {
    host.fire(
        "delegate.cancel",
        json!({ "delegateTaskId": delegate_task_id, "graceful": true }),
    )
}

/// 委派审查结论（delegate.review；后台 run 经 hub 按 run_id 定向路由）
#[tauri::command]
pub fn agent_delegate_review(
    host: Host,
    delegate_task_id: String,
    accept: bool,
) -> Result<(), String> {
    host.fire(
        "delegate.review",
        json!({ "delegateTaskId": delegate_task_id, "decision": if accept { "accept" } else { "reject" } }),
    )
}

/// run 清单（D16 §3.1：runs.list REQ → agent_run 行 camelCase 投影；
/// session_id 缺省=全部会话。run 面板/审计检索数据源）
#[tauri::command]
pub fn agent_runs_list(host: Host, session_id: Option<String>) -> Result<Value, String> {
    let result = host.request("runs.list", json!({ "sessionId": session_id }))?;
    Ok(json!({ "items": result["items"].clone() }))
}

/// 登录/刷新成功后下发 token（obo.token → RT 的 OboCache；obo.renew 由桥应答）
#[tauri::command]
pub fn auth_set_token(host: Host, token: String, expires_at: i64) -> Result<(), String> {
    host.set_token(token, expires_at)
}
