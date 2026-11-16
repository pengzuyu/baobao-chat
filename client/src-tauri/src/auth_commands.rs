//! 认证宿主命令（D28 批0/Q0）：稳定设备号生成与持久化；登录态钥匙串托管（Q0-1）。
//! did 是普通标识非机密 → 存 app 配置目录明文（钥匙串留给 refresh token）。

use std::fs;
use tauri::Manager;

fn device_id_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("配置目录不可用: {e}"))
        .map(|d| d.join("device-id"))
}

/// 稳定设备号（Q0-3）：首启生成 uuid v4 落 app 配置目录，此后跨启动复用同一值。
/// 三处消费：登录/refresh 的 did 绑定（03 §2.2）、WS 连接认证、OBO agent_session_id 归因前缀。
#[tauri::command]
pub fn device_id(app: tauri::AppHandle) -> Result<String, String> {
    let path = device_id_path(&app)?;
    if let Some(v) = fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Ok(v);
    }
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("目录创建失败: {e}"))?;
    let did = uuid::Uuid::new_v4().to_string();
    fs::write(&path, &did).map_err(|e| format!("写入失败: {e}"))?;
    Ok(did)
}
