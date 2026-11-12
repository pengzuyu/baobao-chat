//! 插件本地落盘命令层（D22 §5.1/§5.2 / 批次 L2）：
//! 前端 fflate 解压后逐文件 base64 传输；本层只做**路径安全与落盘**——
//! zip slip 防线（../·绝对路径·反斜杠全拒 + 目录注入字符校验）、总量上限、
//! plugin-state.json（enabled/activeVersion）与 config.json 管理。
//! 完整组件校验在服务端发布时（Go 校验器）；装配（skills/MCP）随 L3。
//!
//! 落盘布局（D22 §5.1）：
//!   {dataDir}/eco/plugins/{plugin_id}/{version}/...   版本目录（多版本共存）
//!   {dataDir}/eco/plugins/{plugin_id}/plugin-state.json
//!   {dataDir}/eco/plugins/{plugin_id}/config.json     用户配置（卸载默认保留）

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::agent_bridge::AgentHost;

type Host<'a> = State<'a, AgentHost>;

/// 包体上限（与服务端 Go 校验器一致，D22 §3.1）
const PLUGIN_MAX_BYTES: usize = 10 << 20;
/// 单文件上限（SKILL.md/命令/专家/server.js 均远小于此）
const PLUGIN_FILE_MAX_BYTES: usize = 4 << 20;

/// 前端传输单元（content_b64 = 文件内容 base64）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    path: String,
    content_b64: String,
}

/// id 合法性（与服务端 rePluginID 同口径：小写字母数字 . _ -，字母数字开头 ≤64）
fn valid_plugin_id(id: &str) -> bool {
    let n = id.len();
    if n == 0 || n > 64 {
        return false;
    }
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-')
}

/// 语义化版本（x.y.z 数字段）
fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty() && p.len() <= 8 && p.chars().all(|c| c.is_ascii_digit())
        })
}

/// 条目内路径安全（zip slip 三拒 + 长度）
fn safe_rel_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 255
        && !p.starts_with('/')
        && !p.contains("..")
        && !p.contains('\\')
}

fn plugin_root(host: &Host, plugin_id: &str) -> Result<PathBuf, String> {
    if !valid_plugin_id(plugin_id) {
        return Err(format!("plugin_id 非法: {plugin_id}"));
    }
    Ok(host.data_dir().join("eco").join("plugins").join(plugin_id))
}

fn read_state(root: &PathBuf) -> Value {
    match fs::read_to_string(root.join("plugin-state.json")) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

fn write_state(root: &PathBuf, state: &Value) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("目录创建失败: {e}"))?;
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(root.join("plugin-state.json"), body).map_err(|e| format!("state 写入失败: {e}"))
}

/// 写入一个版本的全部文件并激活（D22 §5.2 安装/更新：先落版本目录、
/// 全部成功才切 activeVersion——中途失败 state 不动，旧版不受影响）。
/// finalize=false 只写文件（大批次分传的中间批）；缺省 true=写完切版。
#[tauri::command]
pub fn plugin_write_files(
    host: Host,
    plugin_id: String,
    version: String,
    files: Vec<PluginFile>,
    finalize: Option<bool>,
) -> Result<(), String> {
    if !valid_version(&version) {
        return Err(format!("version 非法（x.y.z）: {version}"));
    }
    if files.is_empty() {
        return Err("文件清单为空".into());
    }
    let mut total = 0usize;
    for f in &files {
        if !safe_rel_path(&f.path) {
            return Err(format!("包内路径非法（zip slip）: {}", f.path));
        }
        total += f.content_b64.len();
    }
    if total > PLUGIN_MAX_BYTES * 2 {
        return Err(format!("包体超限（>{})", PLUGIN_MAX_BYTES >> 20) + "MB");
    }
    let root = plugin_root(&host, &plugin_id)?;
    let ver_dir = root.join(&version);
    fs::create_dir_all(&ver_dir).map_err(|e| format!("版本目录创建失败: {e}"))?;
    for f in files {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&f.content_b64)
            .map_err(|e| format!("文件 {} base64 解码失败: {e}", f.path))?;
        if bytes.len() > PLUGIN_FILE_MAX_BYTES {
            return Err(format!("单文件超限（>{}MB）: {}", PLUGIN_FILE_MAX_BYTES >> 20, f.path));
        }
        let dest = ver_dir.join(&f.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("目录创建失败 {}: {e}", f.path))?;
        }
        fs::write(&dest, &bytes).map_err(|e| format!("文件写入失败 {}: {e}", f.path))?;
    }
    // 全量落盘成功 → 激活该版（enabled 不动；保留 config）
    if finalize.unwrap_or(true) {
        let mut state = read_state(&root);
        state["activeVersion"] = json!(version);
        if state.get("enabled").is_none() {
            state["enabled"] = json!(true);
        }
        write_state(&root, &state)?;
    }
    Ok(())
}

/// 卸载：删插件整目录（keep_config=true 保留 config.json 与 state 骨架）
#[tauri::command]
pub fn plugin_remove_local(host: Host, plugin_id: String, keep_config: bool) -> Result<(), String> {
    let root = plugin_root(&host, &plugin_id)?;
    if !root.exists() {
        return Ok(()); // 幂等
    }
    let config = if keep_config {
        fs::read_to_string(root.join("config.json")).ok()
    } else {
        None
    };
    fs::remove_dir_all(&root).map_err(|e| format!("目录删除失败: {e}"))?;
    if let Some(c) = config {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        fs::write(root.join("config.json"), c).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 启用/禁用（禁用=装配剔除，L3 消费；目录与配置不动）
#[tauri::command]
pub fn plugin_set_enabled(host: Host, plugin_id: String, enabled: bool) -> Result<(), String> {
    let root = plugin_root(&host, &plugin_id)?;
    if !root.exists() {
        return Err("插件未安装".into());
    }
    let mut state = read_state(&root);
    state["enabled"] = json!(enabled);
    write_state(&root, &state)
}

/// 本地态（已安装页对照：版本线/激活版/启禁/config 值）
#[tauri::command]
pub fn plugin_local_state(host: Host, plugin_id: String) -> Result<Value, String> {
    let root = plugin_root(&host, &plugin_id)?;
    if !root.exists() {
        return Ok(Value::Null);
    }
    let state = read_state(&root);
    let mut versions: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(&root) {
        for entry in rd.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    if valid_version(name) {
                        versions.push(name.to_string());
                    }
                }
            }
        }
    }
    versions.sort();
    let config = fs::read_to_string(root.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(json!({}));
    Ok(json!({
        "enabled": state.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "activeVersion": state.get("activeVersion").and_then(Value::as_str).unwrap_or(""),
        "versions": versions,
        "config": config,
    }))
}

/// 写用户配置（L4 钥匙串接入前，secret 暂同存 config.json——登记）
#[tauri::command]
pub fn plugin_write_config(
    host: Host,
    plugin_id: String,
    values: HashMap<String, String>,
) -> Result<(), String> {
    let root = plugin_root(&host, &plugin_id)?;
    fs::create_dir_all(&root).map_err(|e| format!("目录创建失败: {e}"))?;
    let mut merged = fs::read_to_string(root.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(json!({}));
    let obj = merged.as_object_mut().ok_or("config.json 损坏")?;
    for (k, v) in values {
        obj.insert(k, json!(v));
    }
    let body = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    fs::write(root.join("config.json"), body).map_err(|e| format!("config 写入失败: {e}"))
}
