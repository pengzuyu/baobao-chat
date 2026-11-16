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

// ── 登录态钥匙串托管（D28 批0/Q0-1）─────────────────────────────────────────
// refresh token 唯一落盘点：服务端只存哈希、本机只存 OS 钥匙串（禁止 localStorage，
// D01 §12.2-5）。「长期登录」= 30 天滑动窗口内启动免密（03 §2.3）；一次性轮换下
// 收到新值即由前端第一时间回写——轮换后崩溃的极小窗口会触发服务端重放检测（全下线
// 重登），属既定安全语义而非缺陷。

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.baobaochat.auth", "refresh-token")
        .map_err(|e| format!("钥匙串不可用: {e}"))
}

/// 登录/刷新成功后保存 refresh token（与插件/MCP 钥匙串 service 分离，互不影响）
#[tauri::command]
pub fn auth_save_login(refresh_token: String) -> Result<(), String> {
    keyring_entry()?
        .set_password(&refresh_token)
        .map_err(|e| format!("写入失败: {e}"))
}

/// 启动恢复读取（无凭据返回 None；钥匙串不可用等错误显式上抛）
#[tauri::command]
pub fn auth_load_login() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(v) if !v.is_empty() => Ok(Some(v)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取失败: {e}")),
    }
}

/// 登出弃凭据（显式登出调用；恢复失败也由前端调用——过期/吊销/重放均弃）
#[tauri::command]
pub fn auth_clear_login() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // 无凭据视为已清
        Err(e) => Err(format!("清除失败: {e}")),
    }
}
