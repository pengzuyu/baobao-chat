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
use std::sync::Arc;
use tauri::State;

use crate::agent_bridge::AgentHost;

type Host<'a> = State<'a, Arc<AgentHost>>;

/// 包体上限（与服务端 Go 校验器一致，D22 §3.1）
const PLUGIN_MAX_BYTES: usize = 10 << 20;
/// 单文件上限（SKILL.md/命令/专家/server.js 均远小于此）
const PLUGIN_FILE_MAX_BYTES: usize = 4 << 20;
/// 本机 README 读取上限（与服务端 PluginMaxReadmeBytes 一致，D39：超限不读不截断）
const PLUGIN_README_MAX_BYTES: usize = 64 << 10;

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
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 8 && p.chars().all(|c| c.is_ascii_digit()))
}

/// 条目内路径安全（zip slip 三拒 + 长度）
fn safe_rel_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 255 && !p.starts_with('/') && !p.contains("..") && !p.contains('\\')
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
#[tauri::command(async)]
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
            return Err(format!(
                "单文件超限（>{}MB）: {}",
                PLUGIN_FILE_MAX_BYTES >> 20,
                f.path
            ));
        }
        let dest = ver_dir.join(&f.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("目录创建失败 {}: {e}", f.path))?;
        }
        fs::write(&dest, &bytes).map_err(|e| format!("文件写入失败 {}: {e}", f.path))?;
    }
    // 全量落盘成功 → 激活该版（enabled 不动；保留 config）→ 装配推送（L3：
    // mcp.config 全量 + tools.reload{plugin}；失败仅告警——落盘已成功，
    // RT 侧重启后由 ready 重推兜底）→ 专家翻译同步（L5：agents/*.md →
    // eco/experts/plugin_{id}_*.yaml）
    if finalize.unwrap_or(true) {
        let mut state = read_state(&root);
        state["activeVersion"] = json!(version);
        if state.get("enabled").is_none() {
            state["enabled"] = json!(true);
        }
        write_state(&root, &state)?;
        sync_plugin_experts(&root, &plugin_id);
        if let Err(e) = host.push_mcp_assembly() {
            eprintln!("[bbc-plugin] 装配推送失败（降级，重启会话后生效）: {e}");
        }
    }
    Ok(())
}

/// 卸载：删插件整目录（keep_config=true 保留 config.json 与 state 骨架）
#[tauri::command(async)]
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
    remove_plugin_experts(&host, &plugin_id);
    if let Err(e) = host.push_mcp_assembly() {
        eprintln!("[bbc-plugin] 装配推送失败（降级，重启会话后生效）: {e}");
    }
    Ok(())
}

/// 启用/禁用（禁用=装配剔除与专家翻译移除；目录与配置不动）
#[tauri::command(async)]
pub fn plugin_set_enabled(host: Host, plugin_id: String, enabled: bool) -> Result<(), String> {
    let root = plugin_root(&host, &plugin_id)?;
    if !root.exists() {
        return Err("插件未安装".into());
    }
    let mut state = read_state(&root);
    state["enabled"] = json!(enabled);
    write_state(&root, &state)?;
    if enabled {
        sync_plugin_experts(&root, &plugin_id);
    } else {
        remove_plugin_experts(&host, &plugin_id);
    }
    if let Err(e) = host.push_mcp_assembly() {
        eprintln!("[bbc-plugin] 装配推送失败（降级，重启会话后生效）: {e}");
    }
    Ok(())
}

/// 本机已装版本目录名（x.y.z 升序；local_state 与已装清单共用）
fn installed_versions(root: &std::path::Path) -> Vec<String> {
    let mut versions: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(root) {
        for entry in rd.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                if valid_version(name) {
                    versions.push(name.to_string());
                }
            }
        }
    }
    versions.sort();
    versions
}

/// 本地态（已安装页对照：版本线/激活版/启禁/config 值——secret 经钥匙串回读）
#[tauri::command(async)]
pub fn plugin_local_state(host: Host, plugin_id: String) -> Result<Value, String> {
    let root = plugin_root(&host, &plugin_id)?;
    if !root.exists() {
        return Ok(Value::Null);
    }
    let state = read_state(&root);
    let versions = installed_versions(&root);
    let config = Value::Object(read_plugin_config(&root));
    let active_version = state.get("activeVersion").and_then(Value::as_str).unwrap_or("");
    let (discovered, servers) = (!active_version.is_empty())
        .then(|| crate::agent_bridge::read_plugin_mcp_doc(&root.join(active_version)))
        .flatten()
        .map(|doc| discover_config_keys(&doc))
        .unwrap_or((json!([]), json!([])));
    Ok(json!({
        "enabled": state.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "activeVersion": active_version,
        "versions": versions,
        "config": config,
        // 配置项自动发现（2026-11-25 拍板）：mcp 定义实际引用的 ${CONFIG:key}
        // ——清单未声明 configKeys 的插件也有配置入口（详情抽屉合并渲染）
        "discoveredConfigKeys": discovered,
        // MCP server 概览（身份开关可见性判定 + 目的地展示）
        "mcpServers": servers,
        "useIdentity": state.get("useIdentity").and_then(Value::as_bool).unwrap_or(false),
    }))
}

/// 本机已装插件清单（已安装页对账）：Agent 装配只认本机安装目录
/// （agent_bridge::assemble_mcp_servers），服务端安装记录可能缺失——数据
/// 重置、换账号、记录被清除后的本机遗留照样对 Agent 生效。页面拿本清单与
/// /eco/plugins/mine 做并集，「仅本机」条目据此可见、可禁用、可卸载。
/// 纯本地只读，不访问服务端
#[tauri::command(async)]
pub fn plugin_list_local(host: Host) -> Result<Value, String> {
    Ok(Value::Array(scan_local_plugins(
        &host.data_dir().join("eco/plugins"),
    )))
}

/// 扫描 eco/plugins：合法 id 目录升序；未安装态（见 local_plugin_summary）剔除
fn scan_local_plugins(plugins_dir: &std::path::Path) -> Vec<Value> {
    let Ok(rd) = fs::read_dir(plugins_dir) else {
        return vec![];
    };
    let mut ids: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|id| valid_plugin_id(id))
        .collect();
    ids.sort();
    ids.iter()
        .filter_map(|id| local_plugin_summary(&plugins_dir.join(id), id))
        .collect()
}

/// 单个本机插件概览：activeVersion 为空=未安装（卸载保留配置的骨架目录、
/// state 缺失或损坏）→ None。版本目录缺失仍算已装（Agent 装配不上，但用户
/// 要能看见并有入口清掉）——清单/README 降级空值
fn local_plugin_summary(root: &PathBuf, plugin_id: &str) -> Option<Value> {
    let state = read_state(root);
    let active = state
        .get("activeVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    if active.is_empty() {
        return None;
    }
    let ver_dir = root.join(active);
    Some(json!({
        "pluginId": plugin_id,
        "enabled": state.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "activeVersion": active,
        "versions": installed_versions(root),
        "manifest": local_manifest(&ver_dir, plugin_id, active),
        "readme": read_local_readme(&ver_dir),
    }))
}

/// 清单所在目录（三目录名规范，首个带 plugin.json 者）
fn manifest_dir(ver_dir: &std::path::Path) -> Option<&'static str> {
    [".bbc-plugin", ".claude-plugin", ".zcode-plugin"]
        .into_iter()
        .find(|dir| ver_dir.join(dir).join("plugin.json").is_file())
}

/// 插件清单原文（manifest_dir/plugin.json；缺失或损坏=None）
fn read_plugin_json(ver_dir: &std::path::Path) -> Option<Value> {
    let dir = manifest_dir(ver_dir)?;
    let text = fs::read_to_string(ver_dir.join(dir).join("plugin.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// 字符串字段（非空才取）
fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// 组件目录：清单声明路径优先，缺省约定目录（同 Go 校验器 join 口径）
fn component_dir(raw: &Value, key: &str, default: &str) -> String {
    non_empty(raw.get(key)).unwrap_or_else(|| default.to_string())
}

/// bbc.config 条目的 key
fn config_key(c: &Value) -> &str {
    c.get("key").and_then(Value::as_str).unwrap_or("")
}

/// 目录内文件计数（keep 判定文件名；max_depth=向下递归的目录层数，0=只认
/// 顶层）。目录不存在=0
fn count_dir_files(dir: &std::path::Path, max_depth: usize, keep: &dyn Fn(&str) -> bool) -> usize {
    let mut n = 0;
    let Ok(rd) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if max_depth > 0 {
                n += count_dir_files(&path, max_depth - 1, keep);
            }
        } else if entry.file_name().to_str().is_some_and(keep) {
            n += 1;
        }
    }
    n
}

fn is_skill_md(name: &str) -> bool {
    name == "SKILL.md"
}

fn is_md(name: &str) -> bool {
    name.ends_with(".md")
}

/// 盘上清单 → 服务端 PluginManifest 同形状（已安装页「仅本机」条目直接当
/// PluginEntry.manifest 用）。组件计数与 Go 校验器同口径：skills=SKILL.md
/// （顶层或一层子目录）、commands/agents=顶层 *.md、mcpServers=server 数、
/// hooks=声明文件或 hooks/hooks.json；身份=声明 x-bbc-auth 或引用
/// ${BBC_USER_*} 变量（authAudiences 仅取 x-bbc-auth 的 http server url）。
/// 空值字段不下发（omitempty 同语义）
fn local_manifest(ver_dir: &std::path::Path, plugin_id: &str, fallback_version: &str) -> Value {
    let raw = read_plugin_json(ver_dir).unwrap_or(Value::Null);
    let bbc = raw.get("bbc");
    let mcp_doc = crate::agent_bridge::read_plugin_mcp_doc(ver_dir);
    let servers = mcp_doc
        .as_ref()
        .and_then(|d| d.get("mcpServers"))
        .and_then(Value::as_object);
    let mcp_servers = servers.map_or(0, |m| m.len());
    let mut auth_audiences: Vec<String> = servers
        .into_iter()
        .flat_map(|m| m.values())
        .filter(|def| def.get("x-bbc-auth").is_some_and(|a| !a.is_null()))
        .filter_map(|def| non_empty(def.get("url")))
        .collect();
    auth_audiences.sort();
    let mcp_text = mcp_doc.map(|d| d.to_string()).unwrap_or_default();
    let uses_identity = !auth_audiences.is_empty()
        || ["${BBC_USER_TOKEN}", "${BBC_USER_ID}", "${BBC_USER_NAME}"]
            .iter()
            .any(|v| mcp_text.contains(v));
    let hooks = match non_empty(raw.get("hooks")) {
        Some(rel) => ver_dir.join(rel.trim_start_matches("./")).exists(),
        None => ver_dir.join("hooks/hooks.json").exists(),
    };
    let config: Vec<&Value> = bbc
        .and_then(|b| b.get("config"))
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let config_keys: Vec<&str> = config
        .iter()
        .map(|c| config_key(c))
        .filter(|k| !k.is_empty())
        .collect();
    let config_secrets: Vec<&str> = config
        .iter()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("secret"))
        .map(|c| config_key(c))
        .collect();
    let skills_dir = ver_dir.join(component_dir(&raw, "skills", "skills"));
    let commands_dir = ver_dir.join(component_dir(&raw, "commands", "commands"));
    let agents_dir = ver_dir.join(component_dir(&raw, "agents", "agents"));
    let skills = count_dir_files(&skills_dir, 1, &is_skill_md);
    let commands = count_dir_files(&commands_dir, 0, &is_md);
    let agents = count_dir_files(&agents_dir, 0, &is_md);
    let mut m = json!({
        "name": non_empty(raw.get("name")).unwrap_or_else(|| plugin_id.to_string()),
        "version": non_empty(raw.get("version"))
            .unwrap_or_else(|| fallback_version.to_string()),
        "description": non_empty(raw.get("description")).unwrap_or_default(),
        "components": {
            "skills": skills,
            "mcpServers": mcp_servers,
            "commands": commands,
            "agents": agents,
            "hooks": hooks,
        },
        "usesIdentity": uses_identity,
    });
    for key in ["risk", "category"] {
        if let Some(v) = non_empty(bbc.and_then(|b| b.get(key))) {
            m[key] = json!(v);
        }
    }
    if let Some(v) = bbc
        .and_then(|b| b.get("netAllow"))
        .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
    {
        m["netAllow"] = v.clone();
    }
    if !config_keys.is_empty() {
        m["configKeys"] = json!(config_keys);
        m["configSecrets"] = json!(config_secrets);
    }
    if !auth_audiences.is_empty() {
        m["authAudiences"] = json!(auth_audiences);
    }
    m
}

/// 本机 README（D39 同口径：包根优先、清单目录次之，命中即止；超限不读
/// 不截断；CRLF→LF 归一）
fn read_local_readme(ver_dir: &std::path::Path) -> Option<String> {
    let mut candidates = vec![ver_dir.join("README.md")];
    if let Some(dir) = manifest_dir(ver_dir) {
        candidates.push(ver_dir.join(dir).join("README.md"));
    }
    for path in candidates {
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        if bytes.len() > PLUGIN_README_MAX_BYTES {
            return None;
        }
        return Some(String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));
    }
    None
}

/// mcp 定义扫描（配置项自动发现 + server 概览）：
/// - `${CONFIG:key}` 占位递归收集；出现在 headers → secret=true（值进请求头），
///   其余（env/args/url）secret=false；同名取并集
/// - server 概览：name/kind/url（stdio 缺 url——command 不是网络目的地）
fn discover_config_keys(doc: &Value) -> (Value, Value) {
    let mut keys: Vec<Value> = Vec::new();
    let mut servers: Vec<Value> = Vec::new();
    let Some(map) = doc.get("mcpServers").and_then(Value::as_object) else {
        return (Value::Array(vec![]), Value::Array(vec![]));
    };
    for (name, def) in map {
        let kind = if def.get("url").is_some() { "http" } else { "stdio" };
        // 身份已声明（装配层恒注入统一身份，无需用户开关）：显式 x-bbc-auth
        // 或 headers 含 ${BBC_USER_TOKEN} 占位（配置值引用经装配归一的等价形态
        // 同样算——装配后 headers 落盘态由 discover 复扫，此处看作者原始声明）
        let auth_declared = def.get("x-bbc-auth").is_some()
            || def
                .get("headers")
                .and_then(Value::as_object)
                .is_some_and(|m| {
                    m.values()
                        .any(|v| v.to_string().contains("${BBC_USER_TOKEN}"))
                });
        servers.push(json!({
            "name": name,
            "kind": kind,
            "url": def.get("url").cloned().unwrap_or(Value::Null),
            "authDeclared": auth_declared,
        }));
        // headers 值先收（secret=true），其余值后收（secret=false）——同名 headers 优先
        for (secret, node) in [
            (true, def.get("headers")),
            (false, Some(def)),
        ] {
            let Some(node) = node else { continue };
            collect_config_keys(node, secret, &mut keys);
        }
    }
    (Value::Array(keys), Value::Array(servers))
}

/// 递归收集字符串值中的 `${CONFIG:key}`（BTreeMap 语义由后续排序保证稳定；
/// 同 key 以首次写入的 secret 标记为准——headers 分支先扫即优先）
fn collect_config_keys(node: &Value, secret: bool, out: &mut Vec<Value>) {
    match node {
        Value::String(text) => {
            let mut rest = text.as_str();
            while let Some(start) = rest.find("${CONFIG:") {
                let after = &rest[start + "${CONFIG:".len()..];
                let Some(end) = after.find('}') else { break };
                let key = &after[..end];
                if !key.is_empty() && !out.iter().any(|k| k["key"] == Value::String(key.into())) {
                    out.push(json!({ "key": key, "secret": secret }));
                }
                rest = &after[end + 1..];
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_config_keys(item, secret, out);
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                collect_config_keys(v, secret, out);
            }
        }
        _ => {}
    }
}

/// 用户侧身份开关（2026-11-25 拍板）：useIdentity 写 plugin-state.json +
/// 装配重推（HTTP server 注入统一身份；前端开启时已弹身份确认）
#[tauri::command(async)]
pub fn plugin_set_use_identity(host: Host, plugin_id: String, enabled: bool) -> Result<(), String> {
    let root = plugin_root(&host, &plugin_id)?;
    if !root.exists() {
        return Err("插件未安装".into());
    }
    let mut state = read_state(&root);
    state["useIdentity"] = json!(enabled);
    write_state(&root, &state)?;
    if let Err(e) = host.push_mcp_assembly() {
        eprintln!("[bbc-plugin] 身份开关装配重推失败（降级，重启会话后生效）: {e}");
    }
    Ok(())
}

/// 钥匙串条目（service 固定；account={plugin_id}/{key}——卸载保留=钥匙串
/// 不删，重装即复用；D22 §5.2 keepConfig 语义）
fn keyring_entry(plugin_id: &str, key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.baobaochat.plugins", &format!("{plugin_id}/{key}"))
        .map_err(|e| format!("钥匙串不可用: {e}"))
}

/// 读插件配置（装配器与 local_state 共用）：config.json 全量 + 空串键查
/// 钥匙串（secret 真值只在钥匙串，config.json 存空串占位——D22 §6.1/L4）
pub fn read_plugin_config(root: &std::path::Path) -> serde_json::Map<String, Value> {
    let mut cfg = fs::read_to_string(root.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let plugin_id = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let keys: Vec<String> = cfg
        .iter()
        .filter(|(_, v)| v.as_str() == Some(""))
        .map(|(k, _)| k.clone())
        .collect();
    for k in keys {
        if let Ok(entry) = keyring_entry(&plugin_id, &k) {
            if let Ok(v) = entry.get_password() {
                cfg.insert(k, Value::String(v));
            }
        }
    }
    cfg
}

/// 写用户配置（D22 §6.1/L4：secret_keys 分流钥匙串——config.json 只存空串
/// 占位，真值不落盘；非 secret 直写 config.json）
#[tauri::command(async)]
pub fn plugin_write_config(
    host: Host,
    plugin_id: String,
    values: HashMap<String, String>,
    secret_keys: Option<Vec<String>>,
) -> Result<(), String> {
    let root = plugin_root(&host, &plugin_id)?;
    fs::create_dir_all(&root).map_err(|e| format!("目录创建失败: {e}"))?;
    let secrets = secret_keys.unwrap_or_default();
    let mut merged = fs::read_to_string(root.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(json!({}));
    let obj = merged.as_object_mut().ok_or("config.json 损坏")?;
    for (k, v) in values {
        if secrets.contains(&k) && !v.is_empty() {
            // secret：真值入钥匙串，config.json 空串占位（真值不落盘）
            keyring_entry(&plugin_id, &k)?
                .set_password(&v)
                .map_err(|e| format!("钥匙串写入失败（{k}）: {e}"))?;
            obj.insert(k, json!(""));
        } else {
            obj.insert(k, json!(v));
        }
    }
    let body = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    fs::write(root.join("config.json"), body).map_err(|e| format!("config 写入失败: {e}"))?;
    // 配置变更 → 装配重推（CONFIG:* 已静态进 wire）
    if let Err(e) = host.push_mcp_assembly() {
        eprintln!("[bbc-plugin] 配置变更装配重推失败（降级，重启会话后生效）: {e}");
    }
    Ok(())
}

// ── L5：命令清单与专家翻译（D22 §2）──

/// 解析 `---` 围栏 frontmatter（行级键值；与 bbrt skills.rs 同取向）。
/// 返回 (键值表, 正文)；无围栏=(空表, 全文)
fn split_frontmatter(text: &str) -> (Vec<(String, String)>, String) {
    let t = text.trim_start_matches('\u{feff}').trim();
    let Some(rest) = t.strip_prefix("---") else {
        return (vec![], t.to_string());
    };
    let Some((fm, after)) = rest.trim_start_matches('\n').split_once("\n---") else {
        return (vec![], t.to_string());
    };
    let kvs = fm
        .lines()
        .filter_map(|ln| ln.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    (kvs, after.trim_start_matches('\n').trim().to_string())
}

fn fm_get<'a>(kvs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    kvs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// 命令清单（已启用插件 activeVersion 的 commands/*.md：name/description/
/// 模板正文——前端 `/` 渲染 $ARGUMENTS/$1..$9）。非 Tauri 宿主返回空。
#[tauri::command(async)]
pub fn plugin_commands_list(host: Host) -> Result<Value, String> {
    let plugins_dir = host.data_dir().join("eco/plugins");
    let Ok(rd) = fs::read_dir(&plugins_dir) else {
        return Ok(json!([]));
    };
    let mut out = vec![];
    let mut ids: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    ids.sort();
    for id in ids {
        let base = plugins_dir.join(&id);
        let Ok(state) = fs::read_to_string(base.join("plugin-state.json")) else {
            continue;
        };
        let Ok(sv) = serde_json::from_str::<Value>(&state) else {
            continue;
        };
        if !sv.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
            continue;
        }
        let Some(ver) = sv.get("activeVersion").and_then(Value::as_str) else {
            continue;
        };
        let cmd_dir = base.join(ver).join("commands");
        let Ok(files) = fs::read_dir(&cmd_dir) else {
            continue;
        };
        let mut names: Vec<String> = files
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .collect();
        names.sort();
        for fname in names {
            let Ok(text) = fs::read_to_string(cmd_dir.join(&fname)) else {
                continue;
            };
            let (kvs, template) = split_frontmatter(&text);
            let name = fm_get(&kvs, "name")
                .map(str::to_string)
                .unwrap_or_else(|| fname.trim_end_matches(".md").to_string());
            if name.is_empty() || name.contains(char::is_whitespace) {
                continue; // 命令名须单词（/name args 解析依赖）
            }
            out.push(json!({
                "pluginId": id,
                "name": name,
                "description": fm_get(&kvs, "description").unwrap_or(""),
                "template": template,
            }));
        }
    }
    Ok(Value::Array(out))
}

/// 专家翻译（D22 §2/L5）：agents/*.md（Claude frontmatter：name/description/
/// tools/model）→ 专家 Persona Manifest 落 {dataDir}/eco/experts/
/// plugin_{plugin_id}_{name}.yaml（走 ExpertIndex::scan 既有装配链——
/// manifest ∩ 注册表 ∩ 租户策略交集，超集剔除标灰）。
/// tools 分拣：`mcp.*` 进 mcp 白名单、其余进 builtin。专家恒走公司默认档
/// （2026-11-26 单档化：frontmatter 的 model 档位声明失效，不再翻译 tier）。
/// 单条翻译失败跳过（降级语义同生态装载）。幂等：先清本插件旧翻译再写。
fn sync_plugin_experts(root: &std::path::Path, plugin_id: &str) {
    // root = {dataDir}/eco/plugins/{id} → experts = {dataDir}/eco/experts
    // （plugins → eco → join experts）
    let Some(experts_dir) = root
        .parent()
        .and_then(std::path::Path::parent)
        .map(|eco| eco.join("experts"))
    else {
        return;
    };
    if fs::create_dir_all(&experts_dir).is_err() {
        return;
    }
    // 幂等：清旧
    let prefix = format!("plugin_{plugin_id}_");
    if let Ok(rd) = fs::read_dir(&experts_dir) {
        for e in rd.flatten() {
            if e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(&prefix))
            {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let Ok(state) = fs::read_to_string(root.join("plugin-state.json")) else {
        return;
    };
    let Ok(sv) = serde_json::from_str::<Value>(&state) else {
        return;
    };
    if !sv.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
        return;
    }
    let Some(ver) = sv.get("activeVersion").and_then(Value::as_str) else {
        return;
    };
    let agents_dir = root.join(ver).join("agents");
    let Ok(files) = fs::read_dir(&agents_dir) else {
        return;
    };
    let mut names: Vec<String> = files
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    names.sort();
    for fname in names {
        let Ok(text) = fs::read_to_string(agents_dir.join(&fname)) else {
            continue;
        };
        let (kvs, body) = split_frontmatter(&text);
        let name = fm_get(&kvs, "name")
            .map(str::to_string)
            .unwrap_or_else(|| fname.trim_end_matches(".md").to_string());
        if name.is_empty() {
            continue;
        }
        // tools 分拣（宽松分隔：逗号/空格）
        let mut builtin = vec![];
        let mut mcp = vec![];
        if let Some(tools) = fm_get(&kvs, "tools") {
            let cleaned = tools.trim_start_matches('[').trim_end_matches(']');
            for t in cleaned.split(|c: char| c == ',' || c.is_whitespace()) {
                let t = t.trim();
                if t.is_empty() {
                    continue;
                }
                if t.starts_with("mcp.") {
                    mcp.push(t);
                } else {
                    builtin.push(t);
                }
            }
        }
        let display = fm_get(&kvs, "description").unwrap_or(&name).to_string();
        // persona 块标量：正文按两空格缩进（expert.rs take_block 按 dedent 处理）
        let persona_block: String = body
            .lines()
            .map(|ln| format!("  {ln}"))
            .collect::<Vec<_>>()
            .join("\n");
        let yaml = format!(
            "id: plugin.{plugin_id}.{name}\ntype: local\nversion: {ver}\ndisplay: {display}\nicon: plug\npersona: |\n{persona_block}\ntools:\n  builtin: [{}]\n  apps: []\n  mcp: [{}]\n",
            builtin.join(", "),
            mcp.join(", "),
        );
        let dest = experts_dir.join(format!("{prefix}{name}.yaml"));
        if let Err(e) = fs::write(&dest, &yaml) {
            eprintln!("[bbc-plugin] 专家翻译写入失败 {dest:?}: {e}");
        }
    }
}

/// 移除本插件全部专家翻译（卸载/禁用）
fn remove_plugin_experts(host: &Host, plugin_id: &str) {
    let experts_dir = host.data_dir().join("eco/experts");
    let prefix = format!("plugin_{plugin_id}_");
    if let Ok(rd) = fs::read_dir(&experts_dir) {
        for e in rd.flatten() {
            if e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(&prefix))
            {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时目录树：{tmp}/bbc-plugin-test-{pid}/{name}（用例自建 eco/plugins 层级）
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("bbc-plugin-test-{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn put(path: &std::path::Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    /// .md 组件正文（计数只看文件名，内容无关）
    const MD: &str = "---\nname: x\n---\n";

    /// 盘上事实 → 服务端清单同形状（组件计数/身份/配置键/README 各一项）
    #[test]
    fn 仅本机清单_镜像服务端清单形状() {
        let plugins = scratch("mirror");
        let ver = plugins.join("demo-helper/1.2.3");
        put(
            &ver.join(".bbc-plugin/plugin.json"),
            r#"{"name":"demo-helper","version":"1.2.3","description":"演示","skills":"./skills","bbc":{"risk":"low","category":"devops","netAllow":["10.0.0.1"],"config":[{"key":"api_key","type":"secret"},{"key":"base_url","type":"string"}]}}"#,
        );
        put(
            &ver.join(".mcp.json"),
            r#"{"mcpServers":{"a":{"url":"https://a.example.com/mcp","x-bbc-auth":{"type":"obo"}},"b":{"command":"node","env":{"T":"${BBC_USER_TOKEN}"}}}}"#,
        );
        put(&ver.join("skills/SKILL.md"), MD);
        put(&ver.join("skills/nested/SKILL.md"), MD);
        put(&ver.join("skills/deep/x/SKILL.md"), MD); // 二层子目录不计
        put(&ver.join("commands/deploy.md"), "# deploy");
        put(&ver.join("commands/notes.txt"), "not md"); // 非 .md 不计
        put(&ver.join("agents/reviewer.md"), MD);
        put(&ver.join("README.md"), "hello\r\nworld");
        put(
            &plugins.join("demo-helper/plugin-state.json"),
            r#"{"activeVersion":"1.2.3","enabled":false}"#,
        );

        let list = scan_local_plugins(&plugins);
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s["pluginId"], "demo-helper");
        assert_eq!(s["enabled"], false);
        assert_eq!(s["activeVersion"], "1.2.3");
        assert_eq!(s["versions"], json!(["1.2.3"]));
        assert_eq!(s["readme"], "hello\nworld");
        let m = &s["manifest"];
        assert_eq!(
            m["components"],
            json!({"skills": 2, "mcpServers": 2, "commands": 1, "agents": 1, "hooks": false})
        );
        assert_eq!(m["risk"], "low");
        assert_eq!(m["category"], "devops");
        assert_eq!(m["netAllow"], json!(["10.0.0.1"]));
        assert_eq!(m["configKeys"], json!(["api_key", "base_url"]));
        assert_eq!(m["configSecrets"], json!(["api_key"]));
        assert_eq!(m["usesIdentity"], true);
        assert_eq!(m["authAudiences"], json!(["https://a.example.com/mcp"]));
        let _ = fs::remove_dir_all(&plugins);
    }

    /// 未安装态剔除（卸载保留配置的骨架/非法 id）；版本目录缺失仍列出（要能看见并清掉）
    #[test]
    fn 仅本机清单_未安装态剔除_残缺目录仍列出() {
        let plugins = scratch("skip");
        put(&plugins.join("kept/config.json"), r#"{"k":"v"}"#); // 无 activeVersion
        put(
            &plugins.join("Bad_ID/plugin-state.json"),
            r#"{"activeVersion":"1.0.0"}"#,
        ); // 非法 id
        put(
            &plugins.join("broken/plugin-state.json"),
            r#"{"activeVersion":"9.9.9"}"#,
        ); // 版本目录不存在
        put(
            &plugins.join("plain/0.1.0/.zcode-plugin/plugin.json"),
            r#"{"name":"plain","version":"0.1.0","description":"缺省目录约定"}"#,
        );
        put(
            &plugins.join("plain/0.1.0/.mcp.json"),
            r#"{"mcpServers":{"x":{"url":"http://127.0.0.1:9/mcp"}}}"#,
        );
        put(&plugins.join("plain/0.1.0/skills/SKILL.md"), MD);
        put(&plugins.join("plain/0.1.0/hooks/hooks.json"), "{}");
        put(
            &plugins.join("plain/plugin-state.json"),
            r#"{"activeVersion":"0.1.0"}"#,
        );

        let list = scan_local_plugins(&plugins);
        let ids: Vec<&str> = list
            .iter()
            .map(|s| s["pluginId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["broken", "plain"]);
        // 残缺：清单缺失回退 id/版本号，缺省启用，README 无
        assert_eq!(list[0]["enabled"], true);
        assert_eq!(list[0]["manifest"]["name"], "broken");
        assert_eq!(list[0]["manifest"]["version"], "9.9.9");
        assert_eq!(list[0]["versions"], json!([]));
        assert!(list[0]["readme"].is_null());
        // 缺省目录约定 + hooks.json；未声明身份/风险 → 空值字段不下发（omitempty）
        assert_eq!(
            list[1]["manifest"]["components"],
            json!({"skills": 1, "mcpServers": 1, "commands": 0, "agents": 0, "hooks": true})
        );
        assert_eq!(list[1]["manifest"]["usesIdentity"], false);
        assert!(list[1]["manifest"].get("risk").is_none());
        assert!(list[1]["manifest"].get("authAudiences").is_none());
        let _ = fs::remove_dir_all(&plugins);
    }
}
