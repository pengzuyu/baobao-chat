//! 进程级端到端：mock 网关（SSE）驱动 bbrt 二进制走通
//! 握手→会话→工具调用（真实文件读取）→记忆启发式→日报→结束全链路。
//! 权威：D11 §4 消息表、D15 双轨、08 §4.1 循环。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use bbrt_protocol::{Envelope, HostToRuntime};

/// 收到的信封行（线程泵出的 stdout 行）
fn spawn_line_pump<R: Read + Send + 'static>(r: R) -> receiver::LineRx {
    let (tx, rx) = channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(r);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    receiver::LineRx { rx }
}
mod receiver {
    use super::*;
    pub struct LineRx {
        pub rx: std::sync::mpsc::Receiver<String>,
    }
    impl LineRx {
        /// 读下一条合法信封（跳过空行；5s 超时失败）
        pub fn next_envelope(&self, ctx: &str) -> Envelope {
            let deadline = Duration::from_secs(5);
            let start = std::time::Instant::now();
            loop {
                let remain = deadline
                    .checked_sub(start.elapsed())
                    .unwrap_or(Duration::from_millis(1));
                match self.rx.recv_timeout(remain) {
                    Ok(line) => {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Envelope>(line) {
                            Ok(env) => return env,
                            Err(e) => panic!("{ctx}: 非法信封行 {line:?}: {e}"),
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => panic!("{ctx}: 等信封超时"),
                    Err(RecvTimeoutError::Disconnected) => panic!("{ctx}: stdout 已关闭"),
                }
            }
        }
    }
}

/// 等 type 出现（收集途中其它信封供断言）
fn until(rx: &receiver::LineRx, want: &str, seen: &mut Vec<Envelope>) -> Envelope {
    for _ in 0..64 {
        let env = rx.next_envelope(&format!("等 {want}"));
        if env.msg_type == want {
            return env;
        }
        seen.push(env);
    }
    panic!(
        "64 条信封内未见 {want}（已见: {:?}）",
        seen.iter().map(|e| e.msg_type.clone()).collect::<Vec<_>>()
    );
}

// ---- mock 网关 ----

fn serve_mock_gateway(listener: TcpListener, script: Arc<Mutex<Vec<String>>>) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let Some(resp) = script.lock().unwrap().pop() else {
                break;
            };
            let mut s = stream;
            if read_http_request(&mut s).is_err() {
                continue;
            }
            write_sse(&mut s, &resp);
        }
    });
}

/// 读掉请求头+体（Content-Length）
fn read_http_request(s: &mut TcpStream) -> Result<usize, String> {
    s.set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    let mut head_end = 0;
    while !buf.ends_with(b"\r\n\r\n") {
        match s.read(&mut byte) {
            Ok(0) => return Err("eof".into()),
            Ok(_) => {
                buf.push(byte[0]);
                head_end += 1;
                if head_end > 65536 {
                    return Err("head too big".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let head = String::from_utf8_lossy(&buf);
    // 修复：先过滤出 Content-Length 头再取值（原写法 .and(Some(l)) 对任意头都 Some，恒解析失败归 0）
    let len: usize = head
        .lines()
        .find(|l| {
            l.split(':')
                .next()
                .map(|k| k.trim().eq_ignore_ascii_case("content-length"))
                .unwrap_or(false)
        })
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    s.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(len)
}

/// 写 SSE 响应（Content-Length 一次体，非 chunked——客户端两种都支持）
fn write_sse(s: &mut TcpStream, events_json: &str) {
    let body = events_json.as_bytes();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
    let _ = s.flush();
}

fn sse_line(data: &str) -> String {
    format!("data: {data}\n\n")
}

/// fanout 判定轮（FastPlanner 首个 bbw-fast 请求的响应：不分解）
fn planner_noop() -> String {
    format!(
        "{}{}{}",
        sse_line(r#"{"choices":[{"delta":{"content":"{\"complex\": false}"}}]}"#),
        sse_line(
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}"#
        ),
        sse_line("[DONE]")
    )
}

#[test]
fn e2e_full_runtime_process() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("foo.txt"), "hello runtime").unwrap();

    // 剧本（栈：pop 顺序与请求相反；先压第二轮再第一轮）
    let round1 = format!(
        "{}{}{}{}",
        sse_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":""}}]}}]}"#
        ),
        sse_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\"foo.txt\"}"}}]}}]}"#
        ),
        sse_line(
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":42,"completion_tokens":7}}"#
        ),
        sse_line("[DONE]")
    );
    let round2 = format!(
        "{}{}{}",
        sse_line(r#"{"choices":[{"delta":{"content":"文件内容是 hello runtime"}}]}"#),
        sse_line(
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":12}}"#
        ),
        sse_line("[DONE]")
    );
    let script = Arc::new(Mutex::new(vec![round2, round1, planner_noop()]));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    serve_mock_gateway(listener, script);

    let mut child: Child = Command::new(env!("CARGO_BIN_EXE_bbrt"))
        .env("BBW_RT_DATA_DIR", tmp.path())
        .env("BBW_RT_GATEWAY", format!("http://127.0.0.1:{port}"))
        .env("BBW_RT_TOKEN", "e2e-token")
        .current_dir(tmp.path()) // 工作区=进程 cwd（bin v0.1 workspace 解析口径）
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("拉起 bbrt 进程");

    let stdin = child.stdin.take().unwrap();
    let mut stdin = stdin;
    let pump = spawn_line_pump(child.stdout.take().unwrap());
    let mut seen: Vec<Envelope> = vec![];

    // ① 握手
    send_msg(
        &mut stdin,
        "h-1",
        &HostToRuntime::Initialize {
            protocol_version: 1,
            capabilities: vec!["session".into()],
            data_dir: tmp.path().to_string_lossy().into_owned(),
            proxy_config: None,
        },
    );
    let init = until(&pump, "initialize.result", &mut seen);
    assert!(init.payload.get("capabilities").is_some());
    let _ready = until(&pump, "runtime.ready", &mut seen);

    // ② 会话
    send_msg(
        &mut stdin,
        "h-2",
        &HostToRuntime::SessionStart {
            session_id: "sess-e2e".into(),
            workspace: tmp.path().to_string_lossy().into_owned(),
            mode: bbrt_protocol::PermissionMode::Ask,
            model_policy: bbrt_protocol::ModelPolicy::Strong,
            model: None,
            skills: vec![],
            history_ref: None,
            backend_hint: None,
        },
    );
    let _sr = until(&pump, "session.ready", &mut seen);

    // ③ 用户输入（含"记住"触发主动轨启发式）
    send_msg(
        &mut stdin,
        "h-3",
        &HostToRuntime::UserMessage {
            session_id: "sess-e2e".into(),
            text: "读一下 foo.txt，并记住内容是 hello runtime".into(),
            attachments: vec![],
            slash: None,
        },
    );

    // ④ 断言链：state(running) → delta → tool.call(read_file) → tool.result(ok, 含文件内容) → memory.saved → stream.done → state(idle)
    let running = until(&pump, "session.state", &mut seen);
    assert_eq!(
        running.payload.get("state").and_then(|s| s.as_str()),
        Some("running")
    );
    // memory.saved 在 turn 起点发（早于工具轮），须先于 tool.call 断言
    let _mem = until(&pump, "memory.saved", &mut seen);
    let tc = until(&pump, "tool.call", &mut seen);
    assert_eq!(
        tc.payload.get("tool").and_then(|t| t.as_str()),
        Some("read_file")
    );
    let tr = until(&pump, "tool.result", &mut seen);
    assert_eq!(
        tr.payload.get("ok").and_then(|o| o.as_bool()),
        Some(true),
        "读文件应成功: {}",
        tr.payload
    );
    let summary = tr
        .payload
        .get("summary")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    assert!(
        summary.contains("hello runtime"),
        "工具结果应含文件内容: {summary}"
    );
    let done = until(&pump, "stream.done", &mut seen);
    assert_eq!(
        done.payload.get("finishReason").and_then(|f| f.as_str()),
        Some("stop")
    );
    let idle = until(&pump, "session.state", &mut seen);
    assert_eq!(
        idle.payload.get("state").and_then(|s| s.as_str()),
        Some("idle")
    );

    // ⑤ 结束 → 日报（journal 含 session.started/tool.executed/memory.saved）
    send_msg(
        &mut stdin,
        "h-4",
        &HostToRuntime::SessionEnd {
            session_id: "sess-e2e".into(),
            reason: bbrt_protocol::EndReason::Normal,
        },
    );
    // 事件序：report.daily(r-evt) → session.ended(事件) → session.ended(ack)；按发生序断言
    let daily = until(&pump, "report.daily", &mut seen);
    let _ended = until(&pump, "session.ended", &mut seen);
    assert!(
        daily
            .payload
            .get("stats")
            .and_then(|s| s.get("tools"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0)
            >= 1,
        "日报应含工具计数"
    );

    // 产物落盘核验：记忆 md + 日报 md + SQLite WAL
    let agent_dir = tmp.path().join("agent");
    assert!(
        agent_dir.join("memory").join("MEMORY.md").exists(),
        "MEMORY.md 应存在"
    );
    assert!(
        agent_dir.join("reports").read_dir().unwrap().count() >= 1,
        "日报产物应存在"
    );
    assert!(tmp.path().join("runtime.db").exists(), "SQLite 应存在");

    let _ = child.kill();
    let _ = child.wait();
}

fn send_msg<W: Write>(w: &mut W, id: &str, msg: &HostToRuntime) {
    let env = Envelope::wrap(1, id, msg).expect("打包信封");
    let mut buf = Vec::new();
    bbrt_protocol::codec::write_message(&mut buf, &env).expect("序列化");
    w.write_all(&buf).expect("写 stdin");
    w.flush().expect("flush stdin");
}

// ---- 委派全链路（D11 §3 #11-13）：fake generic CLI 经真实 bbrt 进程 ----

#[test]
fn e2e_delegate_via_generic_cli() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("a.rs"), "fn main() {}\n").unwrap();

    // fake codex：--version 探测 + 无参启动读 stdin 简报 → ##BBW:EVT 事件流
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let codex = bin.join("codex");
    // 行协议事件字面量（事件 JSON 无嵌套引号，字面量安全；带嵌套的参数帧才需 serde 构造）
    let meta = r#"##BBW:EVT:{"kind":"meta","text":"fake codex ready","session_ref":"fake-sess-1"}"#;
    let output = r#"##BBW:EVT:{"kind":"output","text":"正在修复构建"}"#;
    let tool_use =
        r#"##BBW:EVT:{"kind":"tool_use","call_id":"t1","tool":"Edit","args":{"file":"a.rs"}}"#;
    let tool_result =
        r#"##BBW:EVT:{"kind":"tool_result","call_id":"t1","ok":true,"summary":"已编辑 a.rs"}"#;
    // 桩不读 stdin（后端写简报入管道缓冲、退出后 EPIPE 由后端容忍——generic.rs 注释口径）
    std::fs::write(
        &codex,
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo \"codex-fake 1.2.3\"; exit 0; fi\n\
             echo '{meta}'\n\
             echo '{output}'\n\
             echo '{tool_use}'\n\
             echo '{tool_result}'\n\
             exit 0\n"
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // mock 网关：round1 = coding.delegate 工具调用；round2 = 收尾文本
    // 参数帧的嵌套 JSON 用 serde 构造（手拼转义两度踩坑：帧不合法→流中断→委派不触发）
    let args_json = serde_json::json!({"task": "修复构建", "forbidden": ["git push"]}).to_string();
    let args_frame = serde_json::json!({
        "choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": args_json}}]}}]
    })
    .to_string();
    let round1 = format!(
        "{}{}{}",
        sse_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-d1","function":{"name":"coding.delegate","arguments":""}}]}}]}"#
        ),
        sse_line(&args_frame),
        sse_line(
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":30,"completion_tokens":9}}"#
        ),
    ) + &sse_line("[DONE]");
    let round2 = format!(
        "{}{}",
        sse_line(r#"{"choices":[{"delta":{"content":"委派完成收到"}}]}"#),
        sse_line(
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":60,"completion_tokens":8}}"#
        ),
    ) + &sse_line("[DONE]");
    let script = Arc::new(Mutex::new(vec![round2, round1, planner_noop()]));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    serve_mock_gateway(listener, script);

    let path_env = std::env::var("PATH").unwrap_or_default();
    let mut child = Command::new(env!("CARGO_BIN_EXE_bbrt"))
        .env("BBW_RT_DATA_DIR", tmp.path())
        .env("BBW_RT_GATEWAY", format!("http://127.0.0.1:{port}"))
        .env("BBW_RT_TOKEN", "e2e-token")
        .env("PATH", format!("{}:{}", bin.display(), path_env)) // detect 命中 fake codex
        .current_dir(&ws)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("拉起 bbrt");

    let mut stdin = child.stdin.take().unwrap();
    let pump = spawn_line_pump(child.stdout.take().unwrap());
    let mut seen: Vec<Envelope> = vec![];

    send_msg(
        &mut stdin,
        "h-1",
        &HostToRuntime::Initialize {
            protocol_version: 1,
            capabilities: vec!["session".into()],
            data_dir: tmp.path().to_string_lossy().into_owned(),
            proxy_config: None,
        },
    );
    let _ = until(&pump, "initialize.result", &mut seen);
    let _ = until(&pump, "runtime.ready", &mut seen);

    send_msg(
        &mut stdin,
        "h-2",
        &HostToRuntime::SessionStart {
            session_id: "sess-dlg".into(),
            workspace: ws.to_string_lossy().into_owned(),
            mode: bbrt_protocol::PermissionMode::AutoEdit, // generic 后端 ask 被拒
            model_policy: bbrt_protocol::ModelPolicy::Strong,
            model: None,
            skills: vec![],
            history_ref: None,
            backend_hint: None,
        },
    );
    let _ = until(&pump, "session.ready", &mut seen);

    send_msg(
        &mut stdin,
        "h-3",
        &HostToRuntime::UserMessage {
            session_id: "sess-dlg".into(),
            text: "帮我委派修复构建".into(),
            attachments: vec![],
            slash: None,
        },
    );

    // 工具调用展示 + 简报待确认信号（delegate.event kind=meta brief_pending）
    let tc = until(&pump, "tool.call", &mut seen);
    assert_eq!(
        tc.payload.get("tool").and_then(|t| t.as_str()),
        Some("coding.delegate")
    );
    let brief_sig = until(&pump, "delegate.event", &mut seen);
    assert!(
        brief_sig
            .payload
            .get("payload")
            .and_then(|p| p.get("brief_pending"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        "应收到简报待确认信号: {}",
        brief_sig.payload
    );

    // 宿主确认：delegate.launch（backend=generic + 完整简报）
    send_msg(
        &mut stdin,
        "h-4",
        &HostToRuntime::DelegateLaunch {
            session_id: "sess-dlg".into(),
            delegate_task_id: "dt-call-d1".into(),
            backend: "generic".into(),
            task_brief: bbrt_protocol::TaskBrief {
                task: "修复构建".into(),
                workspace: ws.to_string_lossy().into_owned(),
                constraints: vec![],
                context: vec![],
                acceptance: vec![],
                forbidden: vec!["git push".into()],
            },
            mode: bbrt_protocol::PermissionMode::AutoEdit,
            workspace: ws.to_string_lossy().into_owned(),
        },
    );

    // 事件流：output/tool_use/tool_result 至 delegate.end(exit 0)
    let mut kinds = vec![];
    loop {
        let env = until(&pump, "delegate.event", &mut seen);
        if let Some(k) = env.payload.get("kind").and_then(|k| k.as_str()) {
            kinds.push(k.to_string());
        }
        if kinds.len() >= 3 {
            break;
        }
    }
    assert!(
        kinds.iter().any(|k| k == "output"),
        "应有 output 事件: {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "tool_use"),
        "应有 tool_use: {kinds:?}"
    );
    let end = until(&pump, "delegate.end", &mut seen);
    assert_eq!(
        end.payload.get("exitCode").and_then(|c| c.as_i64()),
        Some(0),
        "fake codex 应正常退出: {}",
        end.payload
    );

    // 审查：accept → 后续轮收尾文本 → idle
    send_msg(
        &mut stdin,
        "h-5",
        &HostToRuntime::DelegateReview {
            delegate_task_id: "dt-call-d1".into(),
            decision: bbrt_protocol::ReviewDecision::Accept,
            rejected_hunks: None,
        },
    );
    let delta = until(&pump, "stream.delta", &mut seen);
    assert!(delta
        .payload
        .get("delta")
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .contains("委派完成收到"));
    let idle = until(&pump, "session.state", &mut seen);
    assert_eq!(
        idle.payload.get("state").and_then(|s| s.as_str()),
        Some("idle")
    );

    let _ = child.kill();
    let _ = child.wait();
}
