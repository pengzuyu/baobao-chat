//! mock 网关集成测试：std::net::TcpListener + 每连接一线程 accept，
//! 手写 HTTP 响应（SSE 流 / 错误 JSON / chunked 编码），走真实 TcpStream 全链路。
//!
//! 覆盖场景：
//! 1. happy path：请求断言（method/path/Bearer/body.model/stream）+ SSE 文本流 + 心跳行忽略；
//! 2. chunked 传输的完整工具调用流 + merge_stream_events 收尾；
//! 3. 429 → 退避重试成功（先 429 再 200；1ms 退避）；
//! 4. 5xx 重试耗尽（1+3 次连接）→ HttpStatus 取网关错误体 code（8051）；
//! 5. 400 不可重试（单次连接）→ HttpStatus 取 9001；
//! 6. 端口不可达 → Unavailable（连接失败重试耗尽）；
//! 7. 已产出事件后服务端断连 → StreamInterrupted；
//! 8. set_base_url 切换目标网关。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use bbrt_aigw::{
    merge_stream_events, AigwClient, AigwError, ChatClient, ChatMessage, ChatRequest, FinishReason,
    MergedTurn, StreamEvent, ToolCallMsg, ToolSpec, Usage,
};

/// 每条连接的处理函数（conn_idx 从 0 起，重试会产生新连接）。
type ConnHandler = Arc<dyn Fn(usize, TcpStream) + Send + Sync>;

/// mock 网关：accept 线程逐连接读完整请求 → 记录 → 交给 handler 回写。
struct MockGateway {
    base_url: String,
    port: u16,
    connections: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl MockGateway {
    fn start(handler: ConnHandler) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地端口");
        let addr = listener.local_addr().expect("本地地址");
        let connections = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let conn_counter = Arc::clone(&connections);
        let req_log = Arc::clone(&requests);
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { break };
                let idx = conn_counter.fetch_add(1, Ordering::SeqCst);
                let request = read_request(&mut stream);
                req_log.lock().unwrap().push(request);
                handler(idx, stream);
            }
        });
        Self {
            base_url: format!("http://{}", addr),
            port: addr.port(),
            connections,
            requests,
        }
    }

    fn connection_count(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    fn request(&self, idx: usize) -> String {
        self.requests.lock().unwrap()[idx].clone()
    }
}

/// 读取一条完整 HTTP 请求（头部 + Content-Length 定长的 body）。
fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("设置 mock 读超时");
    let mut buf: Vec<u8> = Vec::new();
    let head_end = loop {
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos;
        }
        let mut chunk = [0u8; 1024];
        let n = stream.read(&mut chunk).expect("读取客户端请求");
        assert!(n > 0, "客户端连接后未发送请求即关闭");
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let content_length = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.rsplit(':').next())
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while buf.len() < head_end + 4 + content_length {
        let mut chunk = [0u8; 1024];
        let n = stream.read(&mut chunk).expect("读取请求体");
        assert!(n > 0, "请求体不完整");
        buf.extend_from_slice(&chunk[..n]);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 手写 200 + SSE 响应（Content-Length 定长 body）。
fn sse_response(events: &str) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        events.len()
    )
    .into_bytes();
    out.extend_from_slice(events.as_bytes());
    out
}

/// 手写 200 + chunked SSE 响应：每个 frame 一个 chunk，最后 0 长度块收尾。
fn chunked_sse_response(frames: &[&str]) -> Vec<u8> {
    let mut out = String::from(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
    );
    for frame in frames {
        out.push_str(&format!("{:x}\r\n{}\r\n", frame.len(), frame));
    }
    out.push_str("0\r\n\r\n");
    out.into_bytes()
}

/// 手写非 2xx 错误 JSON 响应（OpenAI 风格嵌套错误体）。
fn error_response(status: u16, reason: &str, body: &str) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

fn write_all(stream: &mut TcpStream, bytes: &[u8]) {
    stream.write_all(bytes).expect("mock 写响应");
    stream.flush().expect("mock flush");
}

fn sample_request() -> ChatRequest {
    ChatRequest {
        thinking: None,
        model: "bbc-default".to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: "读取 a.rs".into(),
            tool_calls: vec![],
            tool_call_id: None,
        }],
        tools: vec![ToolSpec {
            name: "read_file".to_string(),
            description: "读取工作区文件".to_string(),
            input_schema: serde_json::json!({"type":"object"}),
        }],
    }
}

/// 测试客户端：1ms 退避（加速重试用例）。
fn fast_client(base_url: &str) -> AigwClient {
    AigwClient::new(base_url, || "test-token-123".to_string())
        .with_backoff_base(Duration::from_millis(1))
}

/// 消费迭代器：Ok 事件收集，首个 Err 后停止。
fn collect_events(
    iter: Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>,
) -> (Vec<StreamEvent>, Option<AigwError>) {
    let mut events = Vec::new();
    let mut error = None;
    for item in iter {
        match item {
            Ok(ev) => events.push(ev),
            Err(e) => {
                error = Some(e);
                break;
            }
        }
    }
    (events, error)
}

/// chat() 的 Ok 值是 dyn Iterator（无 Debug），用本 helper 替代 expect()。
fn expect_stream(
    result: Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError>,
    ctx: &str,
) -> Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send> {
    match result {
        Ok(it) => it,
        Err(e) => panic!("{ctx}：应成功建立流，得到 {e:?}"),
    }
}

/// chat() 应失败：替代 unwrap_err()（Ok 值无 Debug）。
fn expect_chat_err(
    result: Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError>,
    ctx: &str,
) -> AigwError {
    match result {
        Err(e) => e,
        Ok(_) => panic!("{ctx}：应失败却成功建立流"),
    }
}

/// 场景 1：happy path。断言请求形态（method/path/Bearer/body.model/stream:true）
/// 与 SSE 事件产出（心跳/注释行忽略、usage 汇总进 Done）。
#[test]
fn mock_happy_path_sse_with_request_assertions() {
    let sse = concat!(
        ": stream open\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"开始\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"分析\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":5}}\n\n",
        "data: [DONE]\n\n",
    );
    let gw = MockGateway::start(Arc::new(|_idx, mut stream| {
        write_all(&mut stream, &sse_response(sse));
    }));

    // 经 trait 对象调用（session 实际用法），证明对象安全
    let client: Arc<dyn ChatClient> = Arc::new(fast_client(&gw.base_url));
    let iter = client.chat(&sample_request()).expect("应成功建立流");
    let (events, error) = collect_events(iter);
    assert!(error.is_none(), "unexpected error: {error:?}");
    assert_eq!(
        events,
        vec![
            StreamEvent::TextDelta {
                text: "开始".to_string()
            },
            StreamEvent::TextDelta {
                text: "分析".to_string()
            },
            StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage {
                    prompt_tokens: 21,
                    completion_tokens: 5,
                    cached_tokens: None,
                },
                model: None,
            },
        ]
    );

    // 请求断言
    assert_eq!(gw.connection_count(), 1);
    let request = gw.request(0);
    assert!(
        request.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"),
        "请求行不符：{}",
        &request[..request.len().min(60)]
    );
    assert!(request.contains("Authorization: Bearer test-token-123\r\n"));
    assert!(request.contains("Content-Type: application/json\r\n"));
    assert!(request.contains("Accept: text/event-stream\r\n"));
    let body_start = request.find("\r\n\r\n").map(|i| i + 4).expect("应有请求体");
    let body = &request[body_start..];
    assert!(body.contains(r#""model":"bbc-default""#), "body={body}");
    assert!(body.contains(r#""stream":true"#), "body={body}");
    assert!(body.contains("read_file"), "body 应含工具定义：{body}");
}

/// 场景 2：chunked 传输 + 双工具调用流 + merge_stream_events 收尾。
#[test]
fn mock_chunked_tool_call_stream_and_merge() {
    let frames = [
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"c2\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.rs\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"\\\"b.rs\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: {\"usage\":{\"prompt_tokens\":77,\"completion_tokens\":12}}\n\n",
        "data: [DONE]\n\n",
    ];
    let response = chunked_sse_response(&frames);
    let gw = MockGateway::start(Arc::new(move |_idx, mut stream| {
        write_all(&mut stream, &response);
    }));

    let client = fast_client(&gw.base_url);
    let (events, error) =
        collect_events(expect_stream(client.chat(&sample_request()), "chunked 流"));
    assert!(error.is_none(), "unexpected error: {error:?}");

    let merged: MergedTurn = merge_stream_events(events);
    assert_eq!(merged.text, "");
    assert_eq!(
        merged.tool_calls,
        vec![
            ToolCallMsg {
                id: "c1".to_string(),
                name: "read_file".to_string(),
                arguments: "{\"path\":\"a.rs\"}".to_string(),
            },
            ToolCallMsg {
                id: "c2".to_string(),
                name: "read_file".to_string(),
                arguments: "{\"path\":\"b.rs\"}".to_string(),
            },
        ]
    );
    assert_eq!(merged.finish, FinishReason::ToolCalls);
    assert_eq!(merged.usage.prompt_tokens, 77);
    assert_eq!(merged.usage.completion_tokens, 12);
    assert_eq!(gw.connection_count(), 1);
}

/// 场景 3：429 → 退避重试成功（第 2 条连接 200），重发请求体一致（幂等重发）。
#[test]
fn mock_429_then_200_retries_with_backoff() {
    let gw = MockGateway::start(Arc::new(|idx, mut stream| {
        if idx == 0 {
            write_all(
                &mut stream,
                &error_response(
                    429,
                    "Too Many Requests",
                    r#"{"error":{"code":8050,"message":"网关限流"}}"#,
                ),
            );
        } else {
            write_all(&mut stream, &sse_response("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"));
        }
    }));
    let client = fast_client(&gw.base_url);
    let (events, error) = collect_events(expect_stream(client.chat(&sample_request()), "重试后"));
    assert!(error.is_none());
    assert_eq!(
        events,
        vec![StreamEvent::Done {
            finish: FinishReason::Stop,
            usage: Usage::default(),
            model: None,
        }]
    );
    assert_eq!(gw.connection_count(), 2, "429 后应恰好重试 1 次");
    // 幂等重发：两次请求完全一致
    assert_eq!(gw.request(0), gw.request(1));
}

/// 场景 4：5xx 重试耗尽（1+3=4 条连接）→ HttpStatus{code=网关错误体 8051}。
#[test]
fn mock_500_exhausts_retries_then_gateway_code() {
    let gw = MockGateway::start(Arc::new(|_idx, mut stream| {
        write_all(
            &mut stream,
            &error_response(
                503,
                "Service Unavailable",
                r#"{"error":{"code":8051,"message":"供应商不可用"}}"#,
            ),
        );
    }));
    let client = fast_client(&gw.base_url);
    let err = expect_chat_err(client.chat(&sample_request()), "5xx 耗尽");
    match err {
        AigwError::HttpStatus { code } => assert_eq!(code, 8051, "应取网关错误体 code"),
        other => panic!("期望 HttpStatus，得到 {other:?}"),
    }
    assert_eq!(gw.connection_count(), 4, "首发 1 次 + 重试 3 次");
}

/// 场景 5：400 不可重试（单次连接）→ HttpStatus{code=9001}。
#[test]
fn mock_400_not_retried_single_attempt() {
    let gw = MockGateway::start(Arc::new(|_idx, mut stream| {
        write_all(
            &mut stream,
            &error_response(
                400,
                "Bad Request",
                r#"{"error":{"code":9001,"message":"参数非法"}}"#,
            ),
        );
    }));
    let client = fast_client(&gw.base_url);
    let err = expect_chat_err(client.chat(&sample_request()), "400 不可重试");
    match err {
        AigwError::HttpStatus { code } => assert_eq!(code, 9001),
        other => panic!("期望 HttpStatus，得到 {other:?}"),
    }
    assert_eq!(gw.connection_count(), 1, "4xx 不可重试");
}

/// 场景 6：连接不可达（绑定后立即释放的端口）→ Unavailable（连接失败重试耗尽）。
#[test]
fn mock_connect_refused_maps_unavailable() {
    // 找一个几乎必然拒绝连接的端口：绑定 127.0.0.1:0 拿到端口后立即关闭监听
    let probe = TcpListener::bind("127.0.0.1:0").expect("绑定探测端口");
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let client = fast_client(&format!("http://127.0.0.1:{port}"));
    let err = expect_chat_err(client.chat(&sample_request()), "不可达");
    assert!(matches!(err, AigwError::Unavailable), "得到 {err:?}");
}

/// 场景 7：已产出事件后服务端断连（无 [DONE]、无 finish_reason）→ StreamInterrupted。
#[test]
fn mock_mid_stream_close_returns_stream_interrupted() {
    let gw = MockGateway::start(Arc::new(|_idx, mut stream| {
        // 200 + chunked：先发一个完整数据块（含一个文本事件），随后直接断连
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
        let frame = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"部分输出\"},\"finish_reason\":null}]}\n\n";
        write_all(&mut stream, head.as_bytes());
        write_all(
            &mut stream,
            format!("{:x}\r\n{}\r\n", frame.len(), frame).as_bytes(),
        );
        // 不发终止块，直接关闭连接
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }));
    let client = fast_client(&gw.base_url);
    let (events, error) = collect_events(expect_stream(client.chat(&sample_request()), "前半段"));
    assert_eq!(
        events,
        vec![StreamEvent::TextDelta {
            text: "部分输出".to_string()
        }],
        "断连前的事件应已产出"
    );
    assert!(
        matches!(error, Some(AigwError::StreamInterrupted)),
        "得到 {error:?}"
    );
}

/// 场景 8：set_base_url 切换目标网关。
#[test]
fn mock_set_base_url_switches_target() {
    let gw_a = MockGateway::start(Arc::new(|_idx, mut stream| {
        write_all(&mut stream, &sse_response("data: [DONE]\n\n"));
    }));
    let gw_b = MockGateway::start(Arc::new(|_idx, mut stream| {
        write_all(
            &mut stream,
            &sse_response("data: {\"choices\":[{\"delta\":{\"content\":\"B 网关\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"),
        );
    }));

    let mut client = fast_client(&gw_a.base_url);
    client.set_base_url(&gw_b.base_url);
    let (events, error) = collect_events(expect_stream(client.chat(&sample_request()), "切网关后"));
    assert!(error.is_none());
    assert_eq!(
        events,
        vec![
            StreamEvent::TextDelta {
                text: "B 网关".to_string()
            },
            StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage::default(),
                model: None,
            },
        ]
    );
    assert_eq!(gw_a.connection_count(), 0, "不应再命中旧网关");
    assert_eq!(gw_b.connection_count(), 1);
    // 请求 Host 头指向 B
    assert!(gw_b
        .request(0)
        .contains(&format!("Host: 127.0.0.1:{}\r\n", gw_b.port)));
}
