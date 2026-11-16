//! 个人 MCP 接入命令层（D26 §2/§3）：用户自配 MCP server 的存储与装配重推。
//!
//! 存储（纯客户端本地，真值不经服务端——与插件 config 同制 D22 §6.1/L4）：
//!   {dataDir}/eco/mcp/personal.json   server 清单（stdio/HTTP 双形态+enabled/
//!                                     secretKeys；secret 值文件存空串占位）
//!   钥匙串 service com.baobaochat.mcp  account {server名}/{键名}（secret 真值）
//!
//! 写操作后统一走 push_mcp_assembly 全量重推（corp>插件>个人三源合并
//! mcp.config，D26 §4）；同名冲突由装配层跳过（防劫持口径顺延）。
//! 测试连接经 REQ mcp.test 由 RT 一次性连接执行（D26 §6——TLS/TOKEN 动态
//! 注入全走生产代码路径）。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use tauri::State;

use crate::agent_bridge::AgentHost;

type Host<'a> = State<'a, AgentHost>;

/// 钥匙串条目（account={server}/{key}——与插件 config 的 service 分离，
/// 卸载清理互不影响）
fn keyring_entry(server: &str, key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.baobaochat.mcp", &format!("{server}/{key}"))
        .map_err(|e| format!("钥匙串不可用: {e}"))
}

fn personal_path(host: &Host) -> std::path::PathBuf {
    host.data_dir().join("eco/mcp/personal.json")
}

/// 读 personal.json（缺失/损坏降级空表——装配零负担）
fn read_doc(host: &Host) -> Value {
    fs::read_to_string(personal_path(host))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({ "servers": [] }))
}

fn write_doc(host: &Host, doc: &Value) -> Result<(), String> {
    let p = personal_path(host);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("目录创建失败: {e}"))?;
    }
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    fs::write(&p, body).map_err(|e| format!("personal.json 写入失败: {e}"))
}

fn str_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// server 名合法性（与服务端 Go reMcpServerID 同口径：字母数字开头，
/// 字母数字/_/-，≤64）+ 保留名 corp 拒绝（系统级网关命名空间）
fn valid_server_name(name: &str) -> bool {
    if name == "corp" {
        return false;
    }
    let n = name.len();
    if n == 0 || n > 64 {
        return false;
    }
    let first_ok = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    first_ok
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 条目校验（D26 §2）：stdio 须 command；http 须 http(s):// url；
/// env/header 键非空、值为字符串。返回 usesIdentity（任一值引用
/// ${BBW_USER_TOKEN}——UI 警示「将以你的身份调用」）
fn validate_entry(entry: &Value) -> Result<bool, String> {
    let name = entry["name"].as_str().unwrap_or("");
    if !valid_server_name(name) {
        return Err(format!(
            "server 名非法（字母数字开头，字母数字/_/-，≤64，corp 保留）: {name:?}"
        ));
    }
    let mut uses_identity = false;
    for field in ["env", "headers"] {
        if let Some(m) = entry[field].as_object() {
            for (k, v) in m {
                if k.trim().is_empty() {
                    return Err(format!("{field} 键名为空"));
                }
                let Some(vs) = v.as_str() else {
                    return Err(format!("{field}[{k}] 值须为字符串"));
                };
                if vs.contains("${BBW_USER_TOKEN}") {
                    uses_identity = true;
                }
            }
        }
    }
    match entry["kind"].as_str().unwrap_or("") {
        "stdio" => {
            if entry["command"]
                .as_str()
                .is_none_or(|c| c.trim().is_empty())
            {
                return Err("stdio 形态缺少 command".into());
            }
        }
        "http" => {
            let url = entry["url"].as_str().unwrap_or("");
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("HTTP 形态 url 须为 http(s)://…".into());
            }
        }
        other => return Err(format!("kind 须为 stdio 或 http: {other:?}")),
    }
    Ok(uses_identity)
}

/// 单条目 → 可执行定义（keychain secret 值合并回 env/header——空串占位键查
/// 钥匙串，读失败保留占位符「外部系统收到 401 比伪值诚实」同插件口径）。
/// 不判断 enabled（调用方决定：装配跳过禁用，测试允许测禁用条目）。
/// 返回 None=条目缺 name。
fn entry_to_def(e: &Value) -> Option<(String, Value)> {
    let name = e["name"].as_str()?.to_string();
    let secret_keys = str_list(&e["secretKeys"]);
    let mut def = json!({});
    for field in ["env", "headers"] {
        if let Some(m) = e[field].as_object() {
            let mut merged = serde_json::Map::new();
            for (k, v) in m {
                let val = if v.as_str() == Some("") && secret_keys.contains(k) {
                    keyring_entry(&name, k)
                        .ok()
                        .and_then(|en| en.get_password().ok())
                        .map(Value::String)
                        .unwrap_or_else(|| json!(""))
                } else {
                    v.clone()
                };
                merged.insert(k.clone(), val);
            }
            def[field] = Value::Object(merged);
        }
    }
    if e["kind"] == "stdio" {
        def["command"] = e["command"].clone();
        if let Some(a) = e["args"].as_array() {
            def["args"] = Value::Array(a.clone());
        }
    } else {
        def["url"] = e["url"].clone();
    }
    Some((name, def))
}

/// 读启用的个人 servers（装配第三源；agent_bridge 调用）
pub fn read_personal_servers(data_dir: &std::path::Path) -> Vec<(String, Value)> {
    let doc = fs::read_to_string(data_dir.join("eco/mcp/personal.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({ "servers": [] }));
    doc["servers"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|e| e["enabled"].as_bool().unwrap_or(true))
                .filter_map(entry_to_def)
                .collect()
        })
        .unwrap_or_default()
}

/// 清单（secret 值文件本就空串占位——不回显真值；usesIdentity 供 UI 警示）
#[tauri::command]
pub fn mcp_personal_list(host: Host) -> Result<Value, String> {
    Ok(read_doc(&host)["servers"].clone())
}

/// 新增/更新（name 为身份键——改名=新条目，前端编辑禁改 name）。
/// secret_values：secretKeys 对应真值，空串=保持旧值不覆盖（同 plugin config 语义）。
/// 不再 secret / 已删除的旧键 → 钥匙串条目清理。
#[tauri::command]
pub fn mcp_personal_upsert(
    host: Host,
    server: Value,
    secret_values: HashMap<String, String>,
) -> Result<(), String> {
    // 先全量校验（不碰钥匙串/磁盘）
    let uses_identity = validate_entry(&server)?;
    let name = server["name"].as_str().unwrap_or("").to_string();
    let secret_keys = str_list(&server["secretKeys"]);

    let mut doc = read_doc(&host);
    let old = doc["servers"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|e| e["name"].as_str() == Some(name.as_str()))
                .cloned()
        })
        .unwrap_or(Value::Null);

    // secret 真值写钥匙串（提供且非空才写——空串=保持旧值）
    for k in &secret_keys {
        if let Some(v) = secret_values.get(k) {
            if !v.is_empty() {
                keyring_entry(&name, k)?
                    .set_password(v)
                    .map_err(|e| format!("钥匙串写入失败（{k}）: {e}"))?;
            }
        }
    }
    // 旧 secret 键清理：不再列入 secretKeys 或已从 env/headers 删除
    let cur_keys: Vec<String> = ["env", "headers"]
        .iter()
        .flat_map(|f| {
            server[f]
                .as_object()
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .collect();
    for k in str_list(&old["secretKeys"]) {
        if !secret_keys.contains(&k) || !cur_keys.contains(&k) {
            if let Ok(en) = keyring_entry(&name, &k) {
                let _ = en.delete_credential();
            }
        }
    }

    // 文件条目归一：secret 值 → 空串占位（真值不落盘）+ 派生字段
    let mut entry = server.clone();
    for field in ["env", "headers"] {
        if let Some(m) = entry[field].as_object_mut() {
            for (k, v) in m.iter_mut() {
                if secret_keys.contains(k) {
                    *v = json!("");
                }
            }
        }
    }
    entry["usesIdentity"] = json!(uses_identity);
    entry["updatedAt"] = json!(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );

    let arr = doc["servers"].as_array_mut().ok_or("personal.json 损坏")?;
    match arr
        .iter_mut()
        .find(|e| e["name"].as_str() == Some(name.as_str()))
    {
        Some(slot) => *slot = entry,
        None => arr.push(entry),
    }
    write_doc(&host, &doc)?;
    // 装配重推（失败降级告警——重启会话后由 ready 重推兜底，同插件口径）
    if let Err(e) = host.push_mcp_assembly() {
        eprintln!("[bbw-mcp] 个人 MCP 装配推送失败（降级，重启会话后生效）: {e}");
    }
    Ok(())
}

/// 删除（文件条目 + 该 server 全部钥匙串条目）
#[tauri::command]
pub fn mcp_personal_remove(host: Host, name: String) -> Result<(), String> {
    let mut doc = read_doc(&host);
    let arr = doc["servers"].as_array_mut().ok_or("personal.json 损坏")?;
    let old_secrets = arr
        .iter()
        .find(|e| e["name"].as_str() == Some(name.as_str()))
        .map(str_list_on_secret_keys)
        .unwrap_or_default();
    let before = arr.len();
    arr.retain(|e| e["name"].as_str() != Some(name.as_str()));
    if arr.len() == before {
        return Ok(()); // 幂等
    }
    write_doc(&host, &doc)?;
    for k in old_secrets {
        if let Ok(en) = keyring_entry(&name, &k) {
            let _ = en.delete_credential();
        }
    }
    if let Err(e) = host.push_mcp_assembly() {
        eprintln!("[bbw-mcp] 个人 MCP 装配推送失败（降级，重启会话后生效）: {e}");
    }
    Ok(())
}

/// 启用/禁用（定义不动；禁用=装配剔除，同插件启禁语义）
#[tauri::command]
pub fn mcp_personal_set_enabled(host: Host, name: String, enabled: bool) -> Result<(), String> {
    let mut doc = read_doc(&host);
    let arr = doc["servers"].as_array_mut().ok_or("personal.json 损坏")?;
    let slot = arr
        .iter_mut()
        .find(|e| e["name"].as_str() == Some(name.as_str()))
        .ok_or("server 不存在")?;
    slot["enabled"] = json!(enabled);
    write_doc(&host, &doc)?;
    if let Err(e) = host.push_mcp_assembly() {
        eprintln!("[bbw-mcp] 个人 MCP 装配推送失败（降级，重启会话后生效）: {e}");
    }
    Ok(())
}

/// 测试连接（按名测已保存条目——含钥匙串 secret 合并；D26 §6：组 wire 经
/// REQ mcp.test 由 RT 一次性 McpConnection 执行，TLS/TOKEN 动态注入全走
/// 生产路径；stdio 冷启动（node ~1s）由 REQ_TIMEOUT 15s 兜底）。
/// 禁用条目也可测（先验证再启用的用法）。
#[tauri::command]
pub fn mcp_test_connection(host: Host, name: String) -> Result<Value, String> {
    let entry = read_doc(&host)["servers"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|e| e["name"].as_str() == Some(name.as_str()))
                .cloned()
        })
        .ok_or("server 不存在")?;
    let (_, def) = entry_to_def(&entry).ok_or("条目缺 name")?;
    let user = host.current_user();
    let wire = crate::agent_bridge::mcp_server_wire(&name, &def, "", &user, &serde_json::Map::new())
        .ok_or("定义非法（缺 command/url）")?;
    host.request("mcp.test", json!({ "server": wire }))
}

fn str_list_on_secret_keys(e: &Value) -> Vec<String> {
    str_list(&e["secretKeys"])
}
