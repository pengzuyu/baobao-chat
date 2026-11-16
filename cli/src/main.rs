//! bbw CLI（D30 批2）：外部智能体接入面的第三客户端——把打开中的
//! BaobaoChat agent 当子智能体调用。
//!
//! 用法：
//!   bbw ask "查一下XX"                    # 新会话一轮问答
//!   bbw ask --session <id> "追问…"        # 续聊（id 来自上一轮输出）
//!   bbw ask --json "…"                    # 机器可读（终态 task JSON）
//!   bbw status                            # 探活（agent card 无鉴权）
//!
//! 发现链：BBW_EXT_AGENT_URL > BBW_EXT_AGENT_PORT > 状态文件
//! {appData}/agent-runtime/external-agent.json（端口冲突 +1 重试的兜底）；
//! token：BBW_EXT_AGENT_TOKEN > {appData}/agent-runtime/external-agent-token。
//! App 未打开 → 连接失败，口径「BaobaoChat 未运行（接入面随 App 生命周期）」。
//!
//! HTTP 为手写回环裸 TCP（与 bbrt-mcp/bbrt-aigw v0.1 口径一致：不引 HTTP 库；
//! 壳侧 tiny_http 定长响应，无需 chunked）。阻塞轮询 1s/次至终态或超时。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};

const DEFAULT_PORT: u16 = 8791;
const DEFAULT_TIMEOUT_SECS: u64 = 600;

fn main() {
    let code = run();
    std::process::exit(code);
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("ask") => cmd_ask(&args[1..]),
        Some("status") => cmd_status(),
        Some("--help" | "-h" | "help") | None => {
            print_help();
            0
        }
        Some(other) => {
            eprintln!("未知子命令：{other}（bbw --help 查看）");
            2
        }
    }
}

fn print_help() {
    println!(
        "bbw —— 把打开中的 BaobaoChat agent 当子智能体调用（D30）\n\
         \n\
         用法：\n\
         \x20 bbw ask [选项] <文本…>          发起/续聊一轮 agent 会话\n\
         \x20 bbw status                       接入面探活\n\
         \n\
         选项：\n\
         \x20 --session <id>   续聊既有会话（新会话省略）\n\
         \x20 --timeout <秒>   等待终态超时（缺省 600；到达即退出，会话仍在 App 内跑）\n\
         \x20 --json           终态 task JSON 输出 stdout（供脚本消费）\n\
         \x20 --port <端口>    覆盖端口（缺省发现链：BBW_EXT_AGENT_URL/PORT > 状态文件）\n\
         \n\
         环境变量：BBW_EXT_AGENT_URL / BBW_EXT_AGENT_PORT / BBW_EXT_AGENT_TOKEN"
    );
}

struct Endpoint {
    base: String,
    token: String,
}

/// 发现接入面：URL > PORT > 状态文件；token 同目录伴生文件
fn discover(port_override: Option<u16>) -> Result<Endpoint, String> {
    if let Ok(url) = std::env::var("BBW_EXT_AGENT_URL") {
        if !url.is_empty() {
            return Ok(Endpoint {
                base: url.trim_end_matches('/').to_string(),
                token: std::env::var("BBW_EXT_AGENT_TOKEN").unwrap_or_default(),
            });
        }
    }
    let port = port_override
        .or_else(|| std::env::var("BBW_EXT_AGENT_PORT").ok().and_then(|p| p.parse().ok()))
        .or_else(|| read_status_port())
        .unwrap_or(DEFAULT_PORT);
    let dir = app_data_dir()?;
    let token = std::env::var("BBW_EXT_AGENT_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
        .or_else(|| std::fs::read_to_string(dir.join("external-agent-token")).ok())
        .map(|t| t.trim().to_string())
        .unwrap_or_default();
    Ok(Endpoint {
        base: format!("http://127.0.0.1:{port}"),
        token,
    })
}

/// 平台 appData 目录（tauri identifier；更名史 42c3bd3：com.baobaowork.client
/// → com.baobaochat.client——新优先、旧兜底，存量安装不搬家）
fn app_data_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "macos")]
    let base = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Application Support");
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::path::PathBuf::from(std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
        format!("{}/.local/share", std::env::var("HOME").unwrap_or_default())
    }));
    #[cfg(windows)]
    let base = std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default());
    for id in ["com.baobaochat.client", "com.baobaowork.client"] {
        let dir = base.join(id).join("agent-runtime");
        if dir.exists() {
            return Ok(dir);
        }
    }
    Err(format!(
        "未找到 BaobaoChat 数据目录（{}/com.baobaochat.client/agent-runtime）——请先打开 BaobaoChat",
        base.display()
    ))
}

fn read_status_port() -> Option<u16> {
    let dir = app_data_dir().ok()?;
    let txt = std::fs::read_to_string(dir.join("external-agent.json")).ok()?;
    serde_json::from_str::<Value>(&txt).ok()?["port"].as_u64().map(|p| p as u16)
}

/// 单次 POST 交换（回环裸 TCP；Content-Length 定长解 body）
fn post_json(base: &str, path: &str, token: &str, body: &Value) -> Result<(u16, String), String> {
    let host_port = base.trim_start_matches("http://").trim_start_matches("https://");
    let payload = body.to_string();
    let head = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {host_port}\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n",
        len = payload.len(),
    );
    let mut stream = TcpStream::connect(host_port)
        .map_err(|_| "BaobaoChat 未运行（接入面随 App 生命周期，请先打开 BaobaoChat）".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(payload.as_bytes()))
        .and_then(|_| stream.flush())
        .map_err(|e| format!("写入失败: {e}"))?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| format!("读取失败: {e}"))?;
    let split = find(raw.as_slice(), b"\r\n\r\n").ok_or("响应头不完整")?;
    let head_txt = String::from_utf8_lossy(&raw[..split]).to_string();
    let status = head_txt
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("状态行不可解析")?;
    let body_bytes = &raw[split + 4..];
    let body = if let Some(n) = content_length(&head_txt) {
        String::from_utf8_lossy(&body_bytes[..n.min(body_bytes.len())]).into_owned()
    } else {
        String::from_utf8_lossy(body_bytes).into_owned()
    };
    Ok((status, body))
}

fn get_text(base: &str, path: &str) -> Result<(u16, String), String> {
    let host_port = base.trim_start_matches("http://").trim_start_matches("https://");
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n"
    );
    let mut stream = TcpStream::connect(host_port)
        .map_err(|_| "BaobaoChat 未运行（请先打开 BaobaoChat）".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("写入失败: {e}"))?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| format!("读取失败: {e}"))?;
    let split = find(raw.as_slice(), b"\r\n\r\n").ok_or("响应头不完整")?;
    let head_txt = String::from_utf8_lossy(&raw[..split]).to_string();
    let status = head_txt
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("状态行不可解析")?;
    let body_bytes = &raw[split + 4..];
    let body = if let Some(n) = content_length(&head_txt) {
        String::from_utf8_lossy(&body_bytes[..n.min(body_bytes.len())]).into_owned()
    } else {
        String::from_utf8_lossy(body_bytes).into_owned()
    };
    Ok((status, body))
}

fn content_length(head: &str) -> Option<usize> {
    head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("content-length")
            .then(|| v.trim().parse().ok())?
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn rpc(base: &str, token: &str, id: u64, method: &str, params: Value) -> Result<Value, String> {
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let (status, resp) = post_json(base, "/", token, &body)?;
    match status {
        401 => return Err("鉴权失败（401）：token 失效或未配置——App 设置→外部 Agent 接入 重新查看".into()),
        200 => {}
        s => return Err(format!("http {s}: {resp}")),
    }
    let v: Value = serde_json::from_str(&resp).map_err(|e| format!("响应非 JSON: {e}"))?;
    if let Some(err) = v.get("error") {
        return Err(format!(
            "rpc 错误 [{}]: {}",
            err["code"].as_i64().unwrap_or(0),
            err["message"].as_str().unwrap_or("?")
        ));
    }
    Ok(v["result"].clone())
}

fn cmd_status() -> i32 {
    let ep = match discover(None) {
        Ok(ep) => ep,
        Err(e) => {
            eprintln!("✗ {e}");
            return 1;
        }
    };
    match get_text(&ep.base, "/.well-known/agent-card.json") {
        Ok((200, body)) => {
            let name = serde_json::from_str::<Value>(&body).ok()
                .and_then(|v| v["name"].as_str().map(str::to_string))
                .unwrap_or_default();
            let authed = !ep.token.is_empty()
                && rpc(&ep.base, &ep.token, 1, "tasks/get", json!({ "id": "__probe__" })).is_err();
            // __probe__ 任务必不存在：401→token 无效；rpc 错误[-32602]→token 有效
            println!("✓ 在线 {}/（{}）token {}", ep.base, name, if authed { "有效" } else { "无效" });
            0
        }
        Ok((s, _)) => {
            eprintln!("✗ 接入面响应异常 http {s}");
            1
        }
        Err(e) => {
            eprintln!("✗ {e}");
            1
        }
    }
}

fn cmd_ask(args: &[String]) -> i32 {
    let mut session: Option<String> = None;
    let mut timeout = DEFAULT_TIMEOUT_SECS;
    let mut json_out = false;
    let mut port: Option<u16> = None;
    let mut text_parts: Vec<String> = vec![];
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--session" => session = it.next().cloned(),
            "--timeout" => timeout = it.next().and_then(|v| v.parse().ok()).unwrap_or(timeout),
            "--json" => json_out = true,
            "--port" => port = it.next().and_then(|v| v.parse().ok()),
            _ => text_parts.push(a.clone()),
        }
    }
    let text = text_parts.join(" ");
    if text.trim().is_empty() {
        eprintln!("用法：bbw ask [--session <id>] [--timeout 秒] [--json] <文本…>");
        return 2;
    }
    let ep = match discover(port) {
        Ok(ep) => ep,
        Err(e) => {
            eprintln!("✗ {e}");
            return 1;
        }
    };
    if ep.token.is_empty() {
        eprintln!("✗ 未找到本机 token（{}）——请先打开 BaobaoChat", "App 设置→外部 Agent 接入");
        return 1;
    }
    // message/send（续聊带 taskId）
    let mut message = json!({
        "role": "user",
        "parts": [{ "kind": "text", "text": text }],
        "metadata": {},
    });
    if let Some(sid) = &session {
        message["taskId"] = json!(sid);
    }
    let task = match rpc(&ep.base, &ep.token, 1, "message/send", json!({ "message": message })) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("✗ 发送失败：{e}");
            return 1;
        }
    };
    let sid = task["id"].as_str().unwrap_or_default().to_string();
    let sid_short = sid.split('-').take(2).collect::<Vec<_>>().join("-");
    eprintln!("→ 会话 {sid_short} 已受理（完整 id 见 --json 或 App 会话列表）");
    // 轮询至终态
    let started = std::time::Instant::now();
    let mut last_state = String::new();
    let mut rid = 2u64;
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let task = match rpc(&ep.base, &ep.token, rid, "tasks/get", json!({ "id": sid })) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("✗ 轮询失败：{e}");
                return 1;
            }
        };
        rid += 1;
        let state = task["status"]["state"].as_str().unwrap_or("").to_string();
        if state != last_state {
            match state.as_str() {
                "input-required" => eprintln!("⏳ {}", task["status"]["message"]["parts"][0]["text"].as_str().unwrap_or("等待 App 内人工确认")),
                "working" if last_state.is_empty() => {}
                other => eprintln!("… {other}"),
            }
            last_state = state.clone();
        }
        if matches!(state.as_str(), "completed" | "failed" | "canceled") {
            if json_out {
                println!("{}", serde_json::to_string_pretty(&task).unwrap_or_default());
                return if state == "completed" { 0 } else { 3 };
            }
            return finish_human(&task, &sid);
        }
        if started.elapsed().as_secs() >= timeout {
            eprintln!("⏱ 等待超时（{timeout}s）——会话仍在 App 内运行，稍后 bbw ask --session {sid} 续查");
            return 4;
        }
    }
}

fn finish_human(task: &Value, sid: &str) -> i32 {
    match task["status"]["state"].as_str().unwrap_or("") {
        "completed" => {
            let answer = task["artifacts"][0]["parts"][0]["text"]
                .as_str()
                .unwrap_or("");
            if answer.is_empty() {
                eprintln!("（本轮无文本回复——{}）", task["status"]["message"]["parts"][0]["text"].as_str().unwrap_or("可能仅工具调用"));
            } else {
                println!("{answer}");
            }
            eprintln!("\n[会话 {sid} · bbw ask --session {sid} 可续聊]");
            0
        }
        state => {
            eprintln!(
                "✗ 终态 {state}：{}",
                task["status"]["message"]["parts"][0]["text"].as_str().unwrap_or("")
            );
            3
        }
    }
}
