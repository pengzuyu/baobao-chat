//! 认证宿主命令（D28 批0/Q0）：稳定设备号生成与持久化；登录态钥匙串托管（Q0-1）。
//! did 是普通标识非机密 → 存 app 配置目录明文（钥匙串留给 refresh token）。
//! 全部声明 `(async)`（2026-11-23 登录卡死修复）：钥匙串/文件 IO 不占主线程——
//! 同步命令会在 WebView2 主线程内联执行，Credential Manager RPC 慢时整窗冻结。

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
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn auth_save_login(refresh_token: String) -> Result<(), String> {
    keyring_entry()?
        .set_password(&refresh_token)
        .map_err(|e| format!("写入失败: {e}"))
}

/// 启动恢复读取（无凭据返回 None；钥匙串不可用等错误显式上抛）
#[tauri::command(async)]
pub fn auth_load_login() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(v) if !v.is_empty() => Ok(Some(v)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取失败: {e}")),
    }
}

/// 登出弃凭据（显式登出调用；恢复失败也由前端调用——过期/吊销/重放均弃）
#[tauri::command(async)]
pub fn auth_clear_login() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // 无凭据视为已清
        Err(e) => Err(format!("清除失败: {e}")),
    }
}

// ── 登录账号记忆（QQ 式多账号 + 自动登录，2026-11-27）──────────────────────────
// 账号元数据（工号/姓名/最近登录/记住密码/自动登录标记）落机器级明文 JSON——登录前
// 可用、跨账号共享，放 {appData}/agent-runtime/auth-accounts.json（HEAD 上是数据根、
// D40 合入后是纯机器级规范目录，位置两边通用）。口令类机密不入此文件：按账号落
// OS 钥匙串（service 同 refresh token、account 键 login-pwd/{account}）。
// 自动登录全局互斥（只有一个账号生效）：upsert 即重申——本次登录勾了 auto 则独占，
// 没勾则连同其他账号的 auto 一并清掉（最近一次登录意图为准）；显式登出清 auto 但
// 保留账号记忆（登出后下拉仍可选、勾上即可切换自动登录归属）。

/// 单条账号记忆（serde camelCase 直出前端）
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccount {
    pub account: String,
    #[serde(default)]
    pub name: String,
    /// 最近一次登录成功时间（epoch ms，展示「上次登录」用）
    pub last_login_at: i64,
    #[serde(default)]
    pub remember_pwd: bool,
    #[serde(default)]
    pub auto_login: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AccountsFile {
    version: u32,
    #[serde(default)]
    accounts: Vec<AuthAccount>,
}

/// 记忆容量上限：淘汰队尾（最久未登录），淘汰时连带清其钥匙串口令防孤儿密文
const MAX_ACCOUNTS: usize = 8;

/// 读改写串行锁（列表小、频次低，进程内互斥足够；跨进程由单实例语义覆盖）
static ACCOUNTS_IO: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

fn accounts_lock() -> &'static std::sync::Mutex<()> {
    ACCOUNTS_IO.get_or_init(|| std::sync::Mutex::new(()))
}

fn accounts_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("数据目录不可用: {e}"))
        .map(|d| d.join("agent-runtime").join("auth-accounts.json"))
}

fn login_pwd_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.baobaochat.auth", &format!("login-pwd/{account}"))
        .map_err(|e| format!("钥匙串不可用: {e}"))
}

fn delete_login_pwd(account: &str) -> Result<(), String> {
    match login_pwd_entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // 无凭据视为已清
        Err(e) => Err(format!("清除失败: {e}")),
    }
}

/// 读账号列表：文件缺失/损坏按空处理（不动原文件，照 schedule::Store 口径）
fn accounts_read(path: &std::path::Path) -> Vec<AuthAccount> {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<AccountsFile>(&s)
            .map(|f| f.accounts)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn accounts_write(path: &std::path::Path, accounts: &[AuthAccount]) -> Result<(), String> {
    let file = AccountsFile {
        version: 1,
        accounts: accounts.to_vec(),
    };
    let data = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败: {e}"))?;
    crate::schedule::write_atomic(path, &data)
}

/// upsert 核心（路径注入便于测试）：置顶 + 更新元数据 + auto 重申互斥；
/// 返回容量淘汰的账号（调用方连带清其钥匙串口令）
fn accounts_upsert_at(
    path: &std::path::Path,
    account: &str,
    name: &str,
    remember_pwd: bool,
    auto_login: bool,
) -> Result<Vec<String>, String> {
    let mut list = accounts_read(path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    list.retain(|a| a.account != account);
    list.insert(
        0,
        AuthAccount {
            account: account.to_string(),
            name: name.to_string(),
            last_login_at: now,
            remember_pwd,
            auto_login,
        },
    );
    // 登录即重申：其余账号的自动登录标记一律让位（无论本次是否勾选）
    for a in list.iter_mut().skip(1) {
        a.auto_login = false;
    }
    let mut dropped = Vec::new();
    while list.len() > MAX_ACCOUNTS {
        if let Some(a) = list.pop() {
            dropped.push(a.account);
        }
    }
    accounts_write(path, &list)?;
    Ok(dropped)
}

fn accounts_remove_at(path: &std::path::Path, account: &str) -> Result<bool, String> {
    let mut list = accounts_read(path);
    let before = list.len();
    list.retain(|a| a.account != account);
    if list.len() == before {
        return Ok(false);
    }
    accounts_write(path, &list)?;
    Ok(true)
}

/// 账号列表（前端登录页下拉「最近登录」区数据源）
#[tauri::command(async)]
pub fn auth_accounts_list(app: tauri::AppHandle) -> Result<Vec<AuthAccount>, String> {
    let path = accounts_path(&app)?;
    let _guard = accounts_lock().lock().unwrap_or_else(|p| p.into_inner());
    Ok(accounts_read(&path))
}

/// 记录一次登录成功：置顶 + 更新姓名/标记；auto_login=false 时清所有账号的自动登录
#[tauri::command(async)]
pub fn auth_accounts_upsert(
    app: tauri::AppHandle,
    account: String,
    name: String,
    remember_pwd: bool,
    auto_login: bool,
) -> Result<(), String> {
    let account = account.trim().to_string();
    if account.is_empty() {
        return Err("account 必填".into());
    }
    let path = accounts_path(&app)?;
    let dropped = {
        let _guard = accounts_lock().lock().unwrap_or_else(|p| p.into_inner());
        accounts_upsert_at(&path, &account, name.trim(), remember_pwd, auto_login)?
    };
    // 容量淘汰连带清钥匙串口令（失败不阻断登录主链路）
    for a in &dropped {
        let _ = delete_login_pwd(a);
    }
    Ok(())
}

/// 删除账号记忆（登录页下拉 hover ×）：条目 + 其钥匙串口令一并清
#[tauri::command(async)]
pub fn auth_accounts_remove(app: tauri::AppHandle, account: String) -> Result<(), String> {
    let account = account.trim().to_string();
    let path = accounts_path(&app)?;
    {
        let _guard = accounts_lock().lock().unwrap_or_else(|p| p.into_inner());
        accounts_remove_at(&path, &account)?;
    }
    delete_login_pwd(&account)
}

/// 清自动登录标记（登出调用；账号记忆保留）
#[tauri::command(async)]
pub fn auth_accounts_clear_auto(app: tauri::AppHandle) -> Result<(), String> {
    let path = accounts_path(&app)?;
    let _guard = accounts_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut list = accounts_read(&path);
    let mut changed = false;
    for a in &mut list {
        if a.auto_login {
            a.auto_login = false;
            changed = true;
        }
    }
    if changed {
        accounts_write(&path, &list)?;
    }
    Ok(())
}

/// 取账号口令（记住密码回填/自动登录兜底用；无存证=Ok(None)）
#[tauri::command(async)]
pub fn auth_login_password_get(account: String) -> Result<Option<String>, String> {
    match login_pwd_entry(account.trim())?.get_password() {
        Ok(v) if !v.is_empty() => Ok(Some(v)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取失败: {e}")),
    }
}

/// 存账号口令（勾「记住密码」登录成功后）
#[tauri::command(async)]
pub fn auth_login_password_set(account: String, password: String) -> Result<(), String> {
    login_pwd_entry(account.trim())?
        .set_password(&password)
        .map_err(|e| format!("写入失败: {e}"))
}

/// 删账号口令（取消记住密码/口令失效 1001 清理）
#[tauri::command(async)]
pub fn auth_login_password_delete(account: String) -> Result<(), String> {
    delete_login_pwd(account.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bbc-auth-test-{}-{tag}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn upsert_then_list_roundtrip() {
        let path = tmp_path("roundtrip");
        accounts_upsert_at(&path, "8001", "张三", true, false).unwrap();
        accounts_upsert_at(&path, "8002", "李四", false, true).unwrap();
        let list = accounts_read(&path);
        assert_eq!(list.len(), 2);
        // 置顶：最近登录的在队首
        assert_eq!(list[0].account, "8002");
        assert!(list[0].auto_login);
        assert_eq!(list[1].account, "8001");
        assert!(list[1].remember_pwd);
        assert!(!list[1].auto_login);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn upsert_relogin_bumps_and_updates() {
        let path = tmp_path("bump");
        accounts_upsert_at(&path, "8001", "张三", true, true).unwrap();
        accounts_upsert_at(&path, "8002", "李四", false, false).unwrap();
        // 8001 再登录但未勾自动登录：8002 的 auto 也被清（登录即重申=全清）
        accounts_upsert_at(&path, "8001", "张三改名", true, false).unwrap();
        let list = accounts_read(&path);
        assert_eq!(list[0].account, "8001");
        assert_eq!(list[0].name, "张三改名");
        assert!(list.iter().all(|a| !a.auto_login));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn remove_deletes_entry() {
        let path = tmp_path("remove");
        accounts_upsert_at(&path, "8001", "张三", true, true).unwrap();
        assert!(accounts_remove_at(&path, "8001").unwrap());
        assert!(!accounts_remove_at(&path, "8001").unwrap()); // 幂等
        assert!(accounts_read(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_file_tolerated() {
        let path = tmp_path("corrupt");
        std::fs::write(&path, "not json {{{").unwrap();
        assert!(accounts_read(&path).is_empty());
        // 坏文件不阻断后续写
        accounts_upsert_at(&path, "8001", "张三", false, true).unwrap();
        assert_eq!(accounts_read(&path).len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cap_truncates_oldest() {
        let path = tmp_path("cap");
        let mut dropped_all = Vec::new();
        for i in 0..(MAX_ACCOUNTS + 2) {
            dropped_all
                .extend(accounts_upsert_at(&path, &format!("a{i}"), "n", false, false).unwrap());
        }
        let list = accounts_read(&path);
        assert_eq!(list.len(), MAX_ACCOUNTS);
        // 最新留、最旧淘汰（a0/a1 出局）
        assert_eq!(list[0].account, format!("a{}", MAX_ACCOUNTS + 1));
        assert!(dropped_all.contains(&"a0".to_string()) && dropped_all.contains(&"a1".to_string()));
        let _ = std::fs::remove_file(&path);
    }
}
