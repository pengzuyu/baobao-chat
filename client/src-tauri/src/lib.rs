// BaobaoWork 客户端 Rust 壳（Tauri 2）
//
// 职责规划（02 篇 §2，阶段一仅落骨架）：
// - 持有 WSS/REST 连接（UI 重载不断线）、本地 SQLite 缓存与 outbox
// - 窗口/托盘/文件系统等本地能力（命令命名 `模块_动作`，D01 §12.3）
// 当前环境无 Rust 工具链：本文件按 Tauri 2 正确写法落盘，待 cargo 就绪后 `npm run tauri dev` 验证。

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
        .invoke_handler(tauri::generate_handler![
            sys_open_url,
            http_get_stub,
            win_minimize
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
