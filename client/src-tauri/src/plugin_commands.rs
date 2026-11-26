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

/// 本地态（已安装页对照：版本线/激活版/启禁/config 值——secret 经钥匙串回读）
#[tauri::command(async)]
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
/// tools 分拣：`mcp.*` 进 mcp 白名单、其余进 builtin；model→tier（缺省 strong）。
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
        let tier = match fm_get(&kvs, "model") {
            Some("fast") => "fast",
            _ => "strong",
        };
        let display = fm_get(&kvs, "description").unwrap_or(&name).to_string();
        // persona 块标量：正文按两空格缩进（expert.rs take_block 按 dedent 处理）
        let persona_block: String = body
            .lines()
            .map(|ln| format!("  {ln}"))
            .collect::<Vec<_>>()
            .join("\n");
        let yaml = format!(
            "id: plugin.{plugin_id}.{name}\ntype: local\nversion: {ver}\ndisplay: {display}\nicon: plug\npersona: |\n{persona_block}\ntools:\n  builtin: [{}]\n  apps: []\n  mcp: [{}]\nmodel: {{ tier: {tier} }}\n",
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
