//! bbrt-mcp HTTP 传输集成测试：进程内假网关（std TcpListener，行为镜像
//! 服务端 mcpgw——JSON-RPC 2.0 / Content-Length / Bearer 鉴权 / x-bbc-risk
//! 注记），全链路验证 connect→discover→call 与身份双通道（Authorization 头 +
//! _meta.bbcObo）。两侧契约由 server/internal/mcpgw/server_test.go 共同冻结。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use bbrt_mcp::{McpClient, McpServerConfig, PolicyFilter, TransportConfig};

/// 假网关观测面
#[derive(Default, Clone)]
struct Seen {
    auth_headers: Arc<Mutex<Vec<String>>>,
    /// tools/call 收到的 _meta.bbcObo（服务端双通道兜底来源）
    obo_meta: Arc<Mutex<Vec<String>>>,
}

/// 拉起假网关：每连接读一帧请求 → 回一帧响应（Connection: close）。
/// chunked=true 时响应按 chunked 编码（覆盖客户端解码分支）。
fn spawn_fake_gateway(chunked: bool) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().unwrap();
    let seen = Seen::default();
    let seen2 = seen.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut stream) = conn else { break };
            let s = seen2.clone();
            std::thread::spawn(move || {
                if let Some((req, auth)) = read_request(&mut stream) {
                    if let Some(resp) = respond(&req, auth, &s) {
                        let body = resp;
                        let head = if chunked {
                            let mid = body.len() / 2;
                            let (a, b) = body.split_at(mid);
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                                a.len(), a, b.len(), b
                            )
                        } else {
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(), body
                            )
                        };
                        let _ = stream.write_all(head.as_bytes());
                    } else {
                        // 通知：202 无 body
                        let _ =
                            stream.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n");
                    }
                }
            });
        }
    });
    (format!("http://{addr}/mcp/corp"), seen)
}

/// 读一整个 HTTP 请求（头 + Content-Length body）→ (帧, Authorization 值)
fn read_request(stream: &mut TcpStream) -> Option<(serde_json::Value, String)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    // 读完头部
    loop {
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..pos]).into_owned();
            let cl = head
                .lines()
                .find_map(|l| {
                    let (n, v) = l.split_once(':')?;
                    n.trim()
                        .eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while buf.len() < pos + 4 + cl {
                match stream.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    Err(_) => return None,
                }
            }
            let body = &buf[pos + 4..pos + 4 + cl];
            let auth = head
                .lines()
                .find_map(|l| {
                    let (n, v) = l.split_once(':')?;
                    n.trim()
                        .eq_ignore_ascii_case("authorization")
                        .then_some(v.trim().to_string())
                })
                .unwrap_or_default();
            let frame = serde_json::from_slice(body).ok()?;
            return Some((frame, auth));
        }
        match stream.read(&mut tmp) {
            Ok(0) => return None,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return None,
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 帧分发：Some(响应体) / None（通知）
fn respond(req: &serde_json::Value, auth: String, seen: &Seen) -> Option<String> {
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_default();
    let id = req.get("id").cloned()?;
    seen.auth_headers.lock().unwrap().push(auth.clone());
    // 镜像 Go 端口径：所有请求都要求主体令牌，_meta.bbcObo 为兜底通道（双通道任收）
    //（通知无 id 已在 ? 处返回 None——客户端 notify 不等响应，等效静默）
    let meta_obo = params
        .get("_meta")
        .and_then(|m| m.get("bbcObo"))
        .and_then(|o| o.as_str())
        .unwrap_or_default();
    if auth.is_empty() && meta_obo.is_empty() {
        return Some(error_frame(id, -32001, "缺少主体令牌"));
    }
    let result = match method {
        "initialize" => serde_json::json!({
            "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(serde_json::json!("2024-11-05")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "bbc-corp", "version": "0.1.0" },
        }),
        "tools/list" => serde_json::json!({
            "tools": [
                {
                    "name": "kb_query",
                    "description": "知识库混合检索",
                    "inputSchema": { "type": "object", "properties": { "keyword": { "type": "string" } }, "required": ["keyword"] },
                    "annotations": { "x-bbc-risk": "low" },
                },
                {
                    "name": "doc_read",
                    "description": "读在线文档",
                    "inputSchema": { "type": "object", "properties": { "doc_id": { "type": "integer" } }, "required": ["doc_id"] },
                    "annotations": { "x-bbc-risk": "low" },
                },
            ],
        }),
        "tools/call" => {
            let obo = params
                .get("_meta")
                .and_then(|m| m.get("bbcObo"))
                .and_then(|o| o.as_str())
                .unwrap_or_default()
                .to_string();
            seen.obo_meta.lock().unwrap().push(obo.clone());
            serde_json::json!({
                "content": [{ "type": "text", "text": format!("ok auth={auth} obo={obo}") }],
                "isError": false,
            })
        }
        "ping" => serde_json::json!({}),
        _ => return Some(error_frame(id.clone(), -32601, "未知方法")),
    };
    Some(format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{}}}",
        id, result
    ))
}

fn error_frame(id: serde_json::Value, code: i32, msg: &str) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"code\":{code},\"message\":\"{msg}\"}}}}",
        id
    )
}

/// 全链路：握手→发现（kb_query/doc_read 命名空间化 + low 风险）→调用
/// （Authorization 头与 _meta.bbcObo 双通道均达服务端）。
#[test]
fn http_gateway_discover_and_call_with_bearer() {
    let (base, seen) = spawn_fake_gateway(false);
    // D38 单票制：audience=bbc-corp → call 层按受众查票注入（Bearer + _meta 双通道）
    let cfg = McpServerConfig {
        name: "corp".into(),
        transport: TransportConfig::Http {
            base_url: base,
            headers: vec![],
            audience: Some("bbc-corp".into()),
        },
        audience: Some("bbc-corp".into()),
        meta: None,
    };
    let tokens: bbrt_mcp::TokenProvider = Arc::new(|_: &str| Some("obo-token-7".into()));
    let (client, results) = McpClient::connect(&[cfg], tokens);
    assert!(results[0].1.is_ok(), "握手应成功: {:?}", results);

    let tools = client.list_tools(&PolicyFilter::default());
    let names: Vec<&str> = tools.iter().map(|t| t.full_name.as_str()).collect();
    assert_eq!(names, vec!["mcp.corp.kb_query", "mcp.corp.doc_read"]);
    assert_eq!(
        tools[0].risk,
        bbrt_protocol::RiskLevel::Low,
        "x-bbc-risk=low 应生效"
    );

    let out = client
        .call("mcp.corp.kb_query", serde_json::json!({"keyword": "架构"}))
        .unwrap();
    assert!(!out.is_error);
    assert!(
        out.text.contains("auth=Bearer obo-token-7"),
        "Bearer 头应达网关: {}",
        out.text
    );
    assert!(
        out.text.contains("obo=obo-token-7"),
        "_meta.bbcObo 应随行: {}",
        out.text
    );
    // 每请求都带了头（initialize/list/call 至少 3 帧全有 Bearer）
    let auths = seen.auth_headers.lock().unwrap();
    assert!(
        auths.iter().all(|a| a == "Bearer obo-token-7"),
        "全部请求应携带 Bearer: {auths:?}"
    );
}

/// 无令牌：网关镜像鉴权拒绝（JSON-RPC -32001）→ 连接降级（不 panic）。
#[test]
fn http_gateway_no_token_degrades_to_call_error() {
    let (base, _) = spawn_fake_gateway(false);
    let cfg = McpServerConfig {
        name: "corp".into(),
        transport: TransportConfig::Http {
            base_url: base,
            headers: vec![],
            audience: None,
        },
        audience: None,
        meta: None,
    };
    let (_, results) = McpClient::connect(&[cfg], bbrt_mcp::no_token());
    assert!(
        matches!(results[0].1, Err(bbrt_mcp::McpError::Call(ref e)) if e.contains("-32001")),
        "无令牌应收到 JSON-RPC 鉴权错误: {:?}",
        results[0].1
    );
}

/// chunked 响应解码：发现结果经 chunked 编码仍正确解析。
#[test]
fn http_gateway_chunked_response_decodes() {
    let (base, _) = spawn_fake_gateway(true);
    let cfg = McpServerConfig {
        name: "corp".into(),
        transport: TransportConfig::Http {
            base_url: base,
            headers: vec![],
            audience: Some("bbc-corp".into()),
        },
        audience: Some("bbc-corp".into()),
        meta: None,
    };
    let tokens: bbrt_mcp::TokenProvider = Arc::new(|_: &str| Some("t".into()));
    let (client, results) = McpClient::connect(&[cfg], tokens);
    assert!(results[0].1.is_ok(), "chunked 下握手应成功: {:?}", results);
    let tools = client.list_tools(&PolicyFilter::default());
    assert_eq!(tools.len(), 2, "chunked 解码后发现应完整");
}
