// 会议窗口宿主（D17 §4 独立 Tauri 会议窗口，2026-11-10）：
// token 交接走 Rust 侧一次性内存 handoff——不落盘、不经 localStorage（D01 §12.2-5
// 红线），亦无跨窗事件竞态（窗口 JS 启动晚于事件即丢）。
// 流程：主窗 meeting_start_window(handoff) → 存交接数据 + 建 WebviewWindow(meeting.html)
//   → 会议窗口入口 meeting_take_handoff() 取走即焚 → 自治运行（自连 WS/自刷新 token）。
// 同 call_id 幂等：窗口已存在则聚焦返回，不再覆盖 handoff。

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 会议窗口交接载荷（主窗 → 会议窗口一次性传递；字段与前端 MeetingHandoff 对齐）
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct MeetingHandoff {
    pub token: String,
    pub refresh_token: String,
    /// access token 过期时刻（ms epoch；会议窗口过期前自刷新）
    pub expires_at: i64,
    pub uid: String,
    pub display_name: String,
    /// outgoing1v1 | outgoingGroup | accept1v1 | joinGroup
    pub action: String,
    /// 通话幂等键（主窗生成，窗口 label 与之绑定）
    pub call_id: String,
    pub conv_id: String,
    pub video: bool,
    /// 1v1 对端（outgoing1v1/accept1v1 用）
    pub peer_uid: String,
    pub peer_name: String,
}

/// 会议窗口宿主状态（交接信箱：label → handoff，取走即焚）
#[derive(Default)]
pub struct MeetingHost {
    handoffs: Mutex<HashMap<String, MeetingHandoff>>,
}

/// 拉起会议窗口（主窗 invoke）：存 handoff → 动态创建 WebviewWindow。
/// 窗口 label=meeting-{call_id}（call_id 字符集 [A-Za-z0-9-] 天然合法）。
#[tauri::command]
pub fn meeting_start_window(
    app: AppHandle,
    state: tauri::State<MeetingHost>,
    handoff: MeetingHandoff,
) -> Result<String, String> {
    if handoff.call_id.is_empty() {
        return Err("call_id 必填（窗口幂等键）".into());
    }
    let label = format!("meeting-{}", handoff.call_id);
    if let Some(win) = app.get_webview_window(&label) {
        // 同通话重复拉起：聚焦既有窗口，不打断进行中会议
        let _ = win.set_focus();
        return Ok(label);
    }
    state
        .handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), handoff);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("meeting.html".into()))
        .title("BaobaoWork 通话")
        .inner_size(1100.0, 720.0)
        .min_inner_size(760.0, 520.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|e| format!("会议窗口创建失败: {e}"))?;
    Ok(label)
}

/// 取走交接数据（会议窗口入口 invoke；一次性——重复取报错防泄漏）
#[tauri::command]
pub fn meeting_take_handoff(
    state: tauri::State<MeetingHost>,
    window: tauri::Window,
) -> Result<MeetingHandoff, String> {
    let label = window.label().to_string();
    state
        .handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&label)
        .ok_or_else(|| "无待取交接数据（请从主窗发起/加入通话）".to_string())
}
