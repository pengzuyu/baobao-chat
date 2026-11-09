// BaobaoWork 客户端 Rust 壳（Tauri 2）
//
// 职责规划（02 篇 §2）：
// - 持有 WSS/REST 连接（UI 重载不断线）、本地 SQLite 缓存与 outbox（阶段二）
// - Agent 宿主桥：拉起 bbrt sidecar + IPC 命令层 + 事件泵（08 篇 §3.1/D11 §3）
// - 窗口/托盘/文件系统等本地能力（命令命名 `模块_动作`，D01 §12.3）

pub mod agent_bridge;
pub mod agent_commands;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use agent_bridge::AgentHost;

/// 打开外部链接：一律走系统浏览器，禁止 WebView 内打开外域（D01 §10）
#[tauri::command]
async fn sys_open_url(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// HTTP GET 桩：正式版 REST/预签名下载由 Rust 传输引擎统一代理（02 篇），此处仅演示 IPC 结构
#[tauri::command]
async fn http_get_stub(_url: String) -> Result<String, String> {
    Err("尚未实现：等待 Rust 传输引擎接入（02 篇）".into())
}

/// 最小化主窗口（关闭按钮=最小化到托盘的拦截策略在窗口事件中处理，D01 §3，TODO）
#[tauri::command]
fn win_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Agent 宿主桥：数据目录={appData}/agent-runtime；事件泵→WebView（agent://event）
            let handle = app.handle().clone();
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir 不可用: {e}"))?
                .join("agent-runtime");
            let emit = Arc::new(move |payload: serde_json::Value| {
                // 派发失败（无窗口监听）不影响桥运行
                let _ = handle.emit("agent://event", payload);
            });
            app.manage(AgentHost::new(data_dir, emit));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sys_open_url,
            http_get_stub,
            win_minimize,
            agent_commands::session_list,
            agent_commands::agent_start_session,
            agent_commands::agent_input,
            agent_commands::agent_switch_model,
            agent_commands::agent_set_mode,
            agent_commands::agent_pause,
            agent_commands::agent_resume,
            agent_commands::agent_stop,
            agent_commands::agent_emergency_stop,
            agent_commands::agent_approve,
            agent_commands::agent_reject,
            agent_commands::agent_delegate_launch,
            agent_commands::agent_delegate_input,
            agent_commands::agent_delegate_cancel,
            agent_commands::agent_delegate_review,
            agent_commands::memory_list,
            agent_commands::memory_delete,
            agent_commands::report_list,
            agent_commands::report_get,
            agent_commands::auth_set_token
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
