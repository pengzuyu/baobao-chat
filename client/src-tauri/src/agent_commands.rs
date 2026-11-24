//! Agent IPC 命令层（D08 §5.1 命令表的 Tauri 实现）：
//! 前端 bridge/tauri.ts 的 invoke 全表（参数 camelCase 由 Tauri 自动映射 snake_case 形参）。
//! 全部声明 `(async)`（2026-11-23 登录整窗卡死修复）：Tauri 无该属性的同步命令在
//! WebView2 WebResourceRequested（主线程）内联执行——request() 阻塞等回执（15s）+
//! ensure_running 握手（10s）会冻结整个窗口；带属性后函数体进 async_runtime 线程池。
//! 事件回流：agent_bridge 事件泵 → app.emit("agent://event", payload)（setup 装配注入）。

use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

use crate::agent_bridge::AgentHost;

type Host<'a> = State<'a, Arc<AgentHost>>;

/// 会话列表（宿主缓存镜像；协议无查询消息）
#[tauri::command(async)]
pub fn session_list(host: Host) -> Result<Value, String> {
    Ok(json!({ "items": host.list_sessions() }))
}

/// 会话历史（RT session.history 直读 WAL 透传：user/assistant 原文+工具摘要；
/// 工作台打开会话加载聊天记录——含 IM embedded 同一会话的跨端历史）
#[tauri::command(async)]
pub fn session_history(host: Host, session_id: String) -> Result<Value, String> {
    host.request("session.history", json!({ "sessionId": session_id }))
}

/// run 历史（D33：RT run.history 直读 WAL 透传——子 agent 侧栏过程回放，
/// agent_event 按 run_id 过滤投影：spawn→User / trace→Assistant·Tool）
#[tauri::command(async)]
pub fn run_history(host: Host, run_id: String) -> Result<Value, String> {
    host.request("run.history", json!({ "runId": run_id }))
}

/// 新建会话：宿主生成 sessionId → session.start（等 session.ready 回执）。
/// title 可选初始标题（IM embedded 会话来源名；缺省=「会话 n」占位，
/// 前端首条用户消息后经 agent_rename 派生）
#[tauri::command(async)]
pub fn agent_start_session(
    host: Host,
    workspace_id: String,
    mode: String,
    model_policy: String,
    model: Option<String>,
    title: Option<String>,
    origin: Option<String>,
    conv_id: Option<String>,
    conv_type: Option<String>,
) -> Result<Value, String> {
    let sid = host.start_session(
        &workspace_id,
        &mode,
        &model_policy,
        model.as_deref(),
        title.as_deref(),
        false,
        None,
        origin.as_deref(),
        conv_id.as_deref(),
        conv_type.as_deref(),
    )?;
    Ok(json!({ "session_id": sid }))
}

/// 用户输入（回执=session.state running/queued；命令返回 ok 而非透传协议回执）。
/// thinking 思考三档（2026-11-11 轮级生效）：low/medium/high，缺省 None=medium
#[tauri::command(async)]
pub fn agent_input(
    host: Host,
    session_id: String,
    text: String,
    thinking: Option<String>,
) -> Result<Value, String> {
    let rep = host.request(
        "user.message",
        json!({ "sessionId": session_id, "text": text, "attachments": [], "thinking": thinking }),
    )?;
    // RT 错误回执必须外抛（2026-11-16 幽灵会话事故：回执 type=error 被静默吞成
    // Ok——上层 agentFlow 全链无感知）。注意幽灵会话的「会话不存在」是异步
    // error 事件（ack 仍 queued），前端另有映射自愈兜底
    if rep["type"] == "error" {
        return Err(format!(
            "消息被拒：{}",
            rep["message"].as_str().unwrap_or("runtime error")
        ));
    }
    Ok(json!({ "ok": true }))
}

/// 会话内切换模型（model=直达引用 p:<id>:<model>；回执 model.switched 事件驱动 UI）
#[tauri::command(async)]
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

/// 权限模式切换：本地会话行 + session.set_mode 下发 runtime（中途切档即时生效；
/// 原协议缺口=仅本地记录，门控恒按 session.start 时的模式）
#[tauri::command(async)]
pub fn agent_set_mode(host: Host, session_id: String, mode: String) -> Result<(), String> {
    host.set_mode(&session_id, &mode)
}

/// 中断当前轮（2026-11-11 取代旧 agent_pause/resume——暂停按钮已移除，
/// 「停止」=中断当前回答、会话保留可继续；置旗即回，收口以 session.state idle 上行）
#[tauri::command(async)]
pub fn agent_interrupt(host: Host, session_id: String) -> Result<Value, String> {
    host.request("session.interrupt", json!({ "sessionId": session_id }))?;
    Ok(json!({ "ok": true }))
}

/// 会话重命名（标题派生/手动改名；RT 落库 + 宿主缓存行同步）
#[tauri::command(async)]
pub fn agent_rename(host: Host, session_id: String, title: String) -> Result<Value, String> {
    host.rename_session(&session_id, &title)
}

#[tauri::command(async)]
pub fn agent_stop(host: Host, session_id: String, reason: String) -> Result<Value, String> {
    host.request("session.end", json!({ "sessionId": session_id, "reason": if reason.is_empty() { "normal".into() } else { reason } }))?;
    Ok(json!({ "ok": true }))
}

/// 紧急停止：杀 Runtime 进程组（D09 §4.6；killed/cancelled 由宿主拼装）
#[tauri::command(async)]
pub fn agent_emergency_stop(host: Host) -> Result<Value, String> {
    Ok(host.emergency_stop())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn agent_reject(host: Host, request_id: String) -> Result<(), String> {
    host.fire(
        "permission.response",
        json!({ "requestId": request_id, "decision": "deny", "scope": "once" }),
    )
}

/// D20 澄清回答（clarify.response；camelCase 键——协议侧按 camelCase 反序列化）
#[tauri::command(async)]
pub fn agent_clarify_respond(
    host: Host,
    question_id: String,
    answers: Vec<String>,
    free_text: Option<String>,
) -> Result<(), String> {
    host.fire(
        "clarify.response",
        json!({
            "questionId": question_id, "answers": answers, "freeText": free_text,
        }),
    )
}

/// 知识记忆列表（REQ→memory.list.result；条目键名转 snake 供 FE MemoryRow）。
/// D19 作用域参数：scope="project" + workspace_path=项目路径 → 该项目分区
#[tauri::command(async)]
pub fn memory_list(
    host: Host,
    scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    let result = host.request(
        "memory.list",
        json!({ "limit": 200, "scope": scope, "workspacePath": workspace_path }),
    )?;
    Ok(json!({ "items": result["items"].clone() }))
}

/// 记忆删除（D19 作用域参数同上；缺省=用户级，旧口径兼容）
#[tauri::command(async)]
pub fn memory_delete(
    host: Host,
    name: String,
    scope: Option<String>,
    workspace_path: Option<String>,
) -> Result<Value, String> {
    host.request(
        "memory.delete",
        json!({ "name": name, "scope": scope, "workspacePath": workspace_path }),
    )?;
    Ok(json!({ "ok": true }))
}

/// 公共层记忆移除（D23 §3.5/M3：USER.md 条目撤销——条目粒度 tombstone，
/// 返回被移除清单；项目知识条目仍走 memory_delete）
#[tauri::command(async)]
pub fn memory_forget(host: Host, memory_type: String, contains: String) -> Result<Value, String> {
    let result = host.request(
        "memory.forget",
        json!({ "memoryType": memory_type, "contains": contains }),
    )?;
    Ok(json!({ "removed": result["removed"].clone() }))
}

/// D19 项目登记（workspace.register → workspace.registered；realpath upsert）
#[tauri::command(async)]
pub fn workspace_register(host: Host, path: String, name: Option<String>) -> Result<Value, String> {
    host.register_workspace(&path, name.as_deref())
}

/// D19 项目列表（last_opened_at 倒序；camelCase 直出）
#[tauri::command(async)]
pub fn workspace_list(host: Host) -> Result<Value, String> {
    Ok(json!({ "items": host.list_workspaces()? }))
}

/// D19 项目移除登记（只删登记行；会话/记忆分区不动）
#[tauri::command(async)]
pub fn workspace_forget(host: Host, id: String) -> Result<Value, String> {
    let ok = host.forget_workspace(&id)?;
    Ok(json!({ "ok": ok }))
}

/// 取消后台 run（run.cancel：terminal 后台命令/探查/专家在跑任务统一入口；
/// RT 侧 hub 按 run_id 定向路由，未命中报 NotFound）
#[tauri::command(async)]
pub fn agent_run_cancel(host: Host, run_id: String) -> Result<(), String> {
    host.fire("run.cancel", json!({ "runId": run_id, "graceful": true }))
}

/// run 清单（D16 §3.1：runs.list REQ → agent_run 行 camelCase 投影；
/// session_id 缺省=全部会话。run 面板/审计检索数据源）
#[tauri::command(async)]
pub fn agent_runs_list(host: Host, session_id: Option<String>) -> Result<Value, String> {
    let result = host.request("runs.list", json!({ "sessionId": session_id }))?;
    Ok(json!({ "items": result["items"].clone() }))
}

/// 登录/刷新成功后下发 token（D28 批0/Q0-2：宿主持 access 试签 OBO → obo.token
/// 下发 RT 的 OboCache；obo.renew 由桥真换签）。user_id/user_name（D22/L4）：
/// 装配器静态替换 ${BBC_USER_ID}/${BBC_USER_NAME} 用——换账号触发装配重推（stdio
/// env 是 spawn 快照）；did/perms：OBO agent_session_id 归因前缀与 scope（先于 token）
#[tauri::command(async)]
pub fn auth_set_token(
    host: Host,
    token: String,
    expires_at: i64,
    user_id: Option<String>,
    user_name: Option<String>,
    did: Option<String>,
    perms: Option<Vec<String>>,
) -> Result<(), String> {
    if let Some(d) = did {
        host.set_device(&d, perms.as_deref().unwrap_or(&[]));
    }
    let r = host.set_access_token(token, expires_at);
    if let (Some(id), Some(name)) = (user_id, user_name) {
        let _ = host.set_user(&id, &name); // 失败仅告警（重登自愈）
    }
    r
}

/// 登出清 token 缓存（D28 批0/Q0-3）：Rust 侧 Shared.token/user 归零——
/// 此前登出无清理命令，缓存残留至下次登录
#[tauri::command(async)]
pub fn auth_clear_token(host: Host) -> Result<(), String> {
    host.clear_token();
    Ok(())
}
