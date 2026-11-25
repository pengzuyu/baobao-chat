// BaobaoChat 客户端 Rust 壳（Tauri 2）
//
// 职责规划（02 篇 §2）：
// - 持有 WSS/REST 连接（UI 重载不断线）、本地 SQLite 缓存与 outbox（阶段二）
// - Agent 宿主桥：拉起 bbrt sidecar + IPC 命令层 + 事件泵（08 篇 §3.1/D11 §3）
// - 窗口/托盘/文件系统等本地能力（命令命名 `模块_动作`，D01 §12.3）

pub mod agent_bridge;
pub mod agent_commands;
pub mod auth_commands;
pub mod brand;
pub mod ext_agent;
pub mod mcp_commands;
pub mod plugin_commands;
pub mod schedule;

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

/// 打开 WebView 调试台（2026-11-23 开发者模式）：DevPanel·环境 Tab 按钮触发；
/// release 可用依赖 Cargo devtools feature（debug 构建默认可用）；浏览器形态前端不走此命令。
/// open_devtools 在 tauri 小版本间签名有差异（() / Result<()>），`let _` 两态兼容，
/// 失败仅静默——feature 已在编译期保证可用性，运行期几乎不存在失败路径。
#[tauri::command]
fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("主窗口不存在".into());
    };
    let _ = win.open_devtools();
    Ok(())
}

/// 主窗口尺寸按显示器工作区收口（2026-11-23 Windows 真机修复）。
///
/// 根因：`tauri.conf.json` 把窗口写死 1280×800 逻辑像素且不随屏幕变化。Windows 上
/// 只要工作区放不下（1366×768 笔记本 100%、1080p 用 125%/150% 缩放都很常见），窗口
/// 就比屏幕高：贴底部的 UI（左侧栏头像）被切到屏幕外，贴边弹出的弹层（头像菜单、弹窗
/// 内的下拉）也只会按 WebView 视口算位置、不认屏幕边界，于是落进不可见区域——用户看到
/// 的就是「点了完全没反应」。这里启动时把内容区尺寸收口到工作区（扣掉标题栏/边框与
/// 四周余量）并重新居中；屏幕放得下时原样返回，零副作用。
fn fit_window_to_monitor(win: &tauri::WebviewWindow) {
    let (Ok(Some(monitor)), Ok(inner)) = (win.current_monitor(), win.inner_size()) else {
        return;
    };
    let Ok(outer) = win.outer_size() else { return };
    let scale = if monitor.scale_factor() > 0.0 {
        monitor.scale_factor()
    } else {
        1.0
    };
    // 标题栏 + 边框 = 外框与内容区之差（Windows 约 32px 高；macOS 无边框为 0）
    let deco_w = outer.width.saturating_sub(inner.width);
    let deco_h = outer.height.saturating_sub(inner.height);
    let margin = (12.0 * scale).round() as u32; // 四周余量：避免贴屏幕边、窗口阴影被裁
    let area = monitor.work_area();
    let max_w = area.size.width.saturating_sub(deco_w + margin * 2);
    let max_h = area.size.height.saturating_sub(deco_h + margin * 2);
    if max_w == 0 || max_h == 0 || (inner.width <= max_w && inner.height <= max_h) {
        return;
    }
    // 最小尺寸同步收口：配置写死的 960×600 在小屏上同样顶出屏幕，不收口 set_size 不生效
    let _ = win.set_min_size(Some(tauri::LogicalSize::new(
        (max_w as f64 / scale).min(960.0),
        (max_h as f64 / scale).min(600.0),
    )));
    let _ = win.set_size(tauri::PhysicalSize::new(
        inner.width.min(max_w),
        inner.height.min(max_h),
    ));
    // 原窗口可能已被系统把标题栏/底边居中到屏幕外，收口后重新居中
    let _ = win.center();
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
        .plugin(tauri_plugin_process::init())
        // 深链 bbc://（D28 批2/Q2b：等待页唤起 desktop 确认卡；scheme 声明在
        // tauri.conf.json plugins.deep-link，dev 形态运行时注册）
        .plugin(tauri_plugin_deep_link::init());
    if updater_pubkey.is_empty() {
        eprintln!(
            "[bbc] updater 未配置签名公钥（tauri.conf.json plugins.updater.pubkey），自动更新禁用；\
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
                eprintln!("[bbc-panic] {info}");
            }));
            // 窗口尺寸按显示器工作区收口（2026-11-23 Windows 真机：窗口高出屏幕导致
            // 贴底 UI 与贴边弹层落到可视区外，表现为「点了没反应」）
            if let Some(main_win) = app.get_webview_window("main") {
                fit_window_to_monitor(&main_win);
            }
            // 深链路由（D28 批2/Q2b）：bbc://auth?req={id} → WebView 事件
            // oidc://confirm-req（确认卡组件监听）。冷启动（链接拉起 App）经
            // get_current 补投；运行中经 deep-link://new-url。dev 形态 macOS 需
            // 运行时 register（发布形态 Info.plist 由构建注入）
            use tauri_plugin_deep_link::DeepLinkExt;
            {
                // dev（tauri debug 构建）运行时注册 scheme；发布形态 Info.plist 由构建注入
                // （scheme 单源自 brand/brand.json 生成——D31，与 tauri.conf/服务端 env 同源）
                #[cfg(debug_assertions)]
                let _ = app.deep_link().register(brand::SCHEME); // 失败仅告警（已注册/无权限不阻断）
                let emit_handle = app.handle().clone();
                let forward = move |urls: Vec<url::Url>| {
                    for u in urls {
                        if u.host_str() == Some("auth") {
                            let req = u
                                .query_pairs()
                                .find(|(k, _)| k == "req")
                                .map(|(_, v)| v.to_string())
                                .unwrap_or_default();
                            if !req.is_empty() {
                                let _ = emit_handle
                                    .emit("oidc://confirm-req", serde_json::json!({ "req": req }));
                            }
                        } else {
                            eprintln!("[bbc-deeplink] 未识别的 {}:// 路径: {u}", brand::SCHEME);
                        }
                    }
                };
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    forward(urls);
                }
                app.deep_link()
                    .on_open_url(move |event| forward(event.urls()));
            }
            // Agent 宿主桥：数据目录={appData}/agent-runtime；事件泵→WebView（agent://event）
            let handle = app.handle().clone();
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir 不可用: {e}"))?
                .join("agent-runtime");
            // 外部智能体接入面（D30 批1）：ExtHub 先建——emit 闭包 fan-out
            // （WebView + ExtHub.dispatch 任务状态机）+ 命令层防环查询共用
            let hub = Arc::new(ext_agent::ExtHub::new());
            let hub_emit = hub.clone();
            // D35 定时任务：本地调度（tasks/runs/calendar）+ 事件旁路（会话状态→run）
            let schedule_store = schedule::Store::open(data_dir.join("schedules"))?;
            let schedule_rt = schedule::Runtime::new(app.handle().clone(), schedule_store);
            let rt_emit = schedule_rt.clone();
            let emit = Arc::new(move |mut payload: serde_json::Value| {
                hub_emit.dispatch(&payload);
                rt_emit.dispatch(&payload);
                // 定时会话的审批请求补真实等待窗口（前端倒计时用）
                rt_emit.patch_event(&mut payload);
                // 派发失败（无窗口监听）不影响桥运行
                let _ = handle.emit("agent://event", payload);
            });
            let host = Arc::new(AgentHost::new(data_dir.clone(), emit));
            host.attach_ext_hub(hub.clone()); // B3：/mcp/local 本地工具面（schedule_*）
            app.manage(host.clone());
            app.manage(hub.clone());
            // 调度线程：抢到单实例锁才跑（双开时只有首个实例执行任务）
            if !schedule::start(schedule_rt.clone(), host.clone()) {
                eprintln!("[bbc-schedule] 另一个实例持有调度锁，本实例不跑定时任务");
            }
            app.manage(schedule_rt);
            ext_agent::start(app.handle().clone(), hub, data_dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sys_open_url,
            http_get_stub,
            win_minimize,
            open_devtools,
            agent_commands::session_list,
            agent_commands::session_history,
            agent_commands::run_history,
            agent_commands::agent_start_session,
            agent_commands::agent_input,
            agent_commands::agent_switch_model,
            agent_commands::agent_set_mode,
            agent_commands::agent_interrupt,
            agent_commands::agent_rename,
            agent_commands::agent_stop,
            agent_commands::agent_delete_session,
            agent_commands::agent_emergency_stop,
            agent_commands::agent_approve,
            agent_commands::agent_reject,
            agent_commands::agent_clarify_respond,
            agent_commands::agent_run_cancel,
            agent_commands::agent_runs_list,
            agent_commands::memory_list,
            agent_commands::memory_delete,
            agent_commands::memory_forget,
            agent_commands::auth_set_token,
            agent_commands::auth_clear_token,
            auth_commands::device_id,
            auth_commands::auth_save_login,
            auth_commands::auth_load_login,
            auth_commands::auth_clear_login,
            agent_commands::workspace_register,
            agent_commands::workspace_list,
            agent_commands::workspace_forget,
            plugin_commands::plugin_write_files,
            plugin_commands::plugin_remove_local,
            plugin_commands::plugin_set_enabled,
            plugin_commands::plugin_local_state,
            plugin_commands::plugin_write_config,
            plugin_commands::plugin_set_use_identity,
            plugin_commands::plugin_commands_list,
            mcp_commands::mcp_personal_list,
            mcp_commands::mcp_personal_upsert,
            mcp_commands::mcp_personal_remove,
            mcp_commands::mcp_personal_set_enabled,
            mcp_commands::mcp_test_connection,
            ext_agent::ext_agent_status,
            ext_agent::ext_agent_token_regen,
            // D35 定时任务（纯本地调度）
            schedule::schedule_list,
            schedule::schedule_runs,
            schedule::schedule_create,
            schedule::schedule_update,
            schedule::schedule_delete,
            schedule::schedule_set_enabled,
            schedule::schedule_run_now,
            schedule::schedule_cancel_run,
            schedule::schedule_sync_calendar,
            schedule::schedule_calendar_status
        ])
        .run(context)
        .expect("Tauri 应用启动失败");
}
