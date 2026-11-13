// BaobaoWork 客户端 Rust 壳（Tauri 2）
//
// 职责规划（02 篇 §2）：
// - 持有 WSS/REST 连接（UI 重载不断线）、本地 SQLite 缓存与 outbox（阶段二）
// - Agent 宿主桥：拉起 bbrt sidecar + IPC 命令层 + 事件泵（08 篇 §3.1/D11 §3）
// - 窗口/托盘/文件系统等本地能力（命令命名 `模块_动作`，D01 §12.3）

pub mod agent_bridge;
pub mod agent_commands;
pub mod plugin_commands;
pub mod mcp_commands;

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
    // updater 条件注册（16 篇 §5.1）：plugins.updater.pubkey 未填（signer 密钥未生成）
    // 时禁用自动更新而非启动失败——正式密钥由 CI 注入后 conf 填公钥即启用
    let context = tauri::generate_context!();
    let updater_pubkey = context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // 目录/文件选择（D13）
        .plugin(tauri_plugin_dialog::init())
        // relaunch（D21：更新装完一键重启；无条件注册——updater 禁用时前端不调即无感）
        .plugin(tauri_plugin_process::init());
    if updater_pubkey.is_empty() {
        eprintln!(
            "[bbw] updater 未配置签名公钥（tauri.conf.json plugins.updater.pubkey），自动更新禁用；\
             npm run tauri signer generate 生成密钥后填入启用（16 篇 §5.1）"
        );
    } else {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(|app| {
            // TEMP 排错仪表（2026-11-11 泵静默死亡排查，验收后移除）：任意线程 panic
            // 落 stderr（tauri dev 日志）——事件泵线程 panic 后进程不死但事件全断
            std::panic::set_hook(Box::new(|info| {
                eprintln!("[bbw-panic] {info}");
            }));
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
            agent_commands::session_history,
            agent_commands::agent_start_session,
            agent_commands::agent_input,
            agent_commands::agent_switch_model,
            agent_commands::agent_set_mode,
            agent_commands::agent_interrupt,
            agent_commands::agent_rename,
            agent_commands::agent_stop,
            agent_commands::agent_emergency_stop,
            agent_commands::agent_approve,
            agent_commands::agent_reject,
            agent_commands::agent_clarify_respond,
            agent_commands::agent_delegate_launch,
            agent_commands::agent_delegate_input,
            agent_commands::agent_delegate_cancel,
            agent_commands::agent_delegate_review,
            agent_commands::agent_runs_list,
            agent_commands::memory_list,
            agent_commands::memory_delete,
            agent_commands::memory_forget,
            agent_commands::report_list,
            agent_commands::report_get,
            agent_commands::auth_set_token,
            agent_commands::workspace_register,
            agent_commands::workspace_list,
            agent_commands::workspace_forget,
            plugin_commands::plugin_write_files,
            plugin_commands::plugin_remove_local,
            plugin_commands::plugin_set_enabled,
            plugin_commands::plugin_local_state,
            plugin_commands::plugin_write_config,
            plugin_commands::plugin_commands_list,
            mcp_commands::mcp_personal_list,
            mcp_commands::mcp_personal_upsert,
            mcp_commands::mcp_personal_remove,
            mcp_commands::mcp_personal_set_enabled,
            mcp_commands::mcp_test_connection
        ])
        .run(context)
        .expect("Tauri 应用启动失败");
}
