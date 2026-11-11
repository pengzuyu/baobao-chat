//! bbrt-hostapi 集成测试：`UnixStream::pair()` 两端真实跑全链路
//! （握手/版本协商/ping-pong/REQ-NTF 派发/未知 type 计数/error(9001)/D15 回执/
//!   EOF 优雅退出/8MB 背压）。半行与超长行的兜底由 bbrt-protocol codec 既有
//! roundtrip 测试覆盖，此处只补传输层衔接路径。

use std::io::{BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::Duration;

use bbrt_hostapi::{
    serve_on, HostError, RecvError, RuntimeHandler, ServeStats, StdioTransport,
    MAX_PENDING_WRITE_BYTES,
};
use bbrt_protocol::{
    read_message, write_message, CodecError, DailyStatsLite, DelegateEventKind, Envelope,
    HostToRuntime, MemoryListItem, ReportListItem, RuntimeToHost, SessionState, PROTOCOL_VERSION,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// 测试用处理器与宿主侧工具
// ---------------------------------------------------------------------------

/// 测试处理器：记录派发到的消息（type#id），对 REQ 按表回复，NTF 不回复
struct TestHandler {
    seen: mpsc::Sender<String>,
}

impl TestHandler {
    fn spawn() -> (Self, Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        (Self { seen: tx }, rx)
    }
}

impl RuntimeHandler for TestHandler {
    fn handle(&mut self, msg: HostToRuntime, env: &Envelope) -> Option<RuntimeToHost> {
        let _ = self.seen.send(format!("{}#{}", env.msg_type, env.id));
        match msg {
            HostToRuntime::UserMessage {
                session_id, text, ..
            } => Some(RuntimeToHost::SessionStateReport {
                session_id,
                state: SessionState::Running,
                reason: text,
            }),
            HostToRuntime::MemoryList { .. } => Some(RuntimeToHost::MemoryListResult {
                items: vec![MemoryListItem {
                    name: "gitee-remote".into(),
                    title: "Gitee 远端".into(),
                    memory_type: "knowledge".into(),
                    updated_at: 1_790_000_000_000,
                    hook: "记住.*远端".into(),
                    scope: None,
                    workspace_name: None,
                }],
            }),
            HostToRuntime::MemoryDelete { name, .. } => Some(RuntimeToHost::MemoryDeleteResult {
                ok: name != "missing",
            }),
            HostToRuntime::ReportList { .. } => Some(RuntimeToHost::ReportListResult {
                items: vec![ReportListItem {
                    date: "2026-11-06".into(),
                    stats: DailyStatsLite {
                        sessions: 3,
                        tools: 47,
                        blocked: 2,
                        files_changed: 12,
                        memory_saved: 3,
                    },
                }],
            }),
            _ => None, // NTF 通常无回复
        }
    }

    fn capabilities(&self) -> Vec<String> {
        vec!["stdio".into(), "memory.v1".into()]
    }
}

/// 宿主侧连接：写走 sock、读走 try_clone 的 BufReader
struct HostSide {
    sock: UnixStream,
    reader: BufReader<UnixStream>,
}

/// 拉起 Runtime 侧 serve_on 线程（5s 读超时兜底：用例缺陷时不至于永久挂起），
/// 返回宿主侧连接、handler 见闻通道与线程句柄
fn spawn_runtime() -> (
    HostSide,
    Receiver<String>,
    JoinHandle<Result<ServeStats, HostError>>,
) {
    let (handler, rx) = TestHandler::spawn();
    let (sock, rt) = UnixStream::pair().expect("pair");
    rt.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let handle = std::thread::spawn(move || serve_on(rt, handler));
    let reader = BufReader::new(sock.try_clone().unwrap());
    let host = HostSide { sock, reader };
    (host, rx, handle)
}

impl HostSide {
    fn send(&mut self, env: &Envelope) {
        write_message(&mut self.sock, env).expect("宿主写出");
    }

    /// 直写原始字节（构造坏行/未知 type）
    fn send_raw(&mut self, bytes: &[u8]) {
        self.sock.write_all(bytes).unwrap();
        self.sock.flush().unwrap();
    }

    fn recv(&mut self) -> Envelope {
        read_message(&mut self.reader)
            .unwrap()
            .expect("期待一条消息")
    }

    /// 短窗内不应有任何消息（超时视作静默）
    fn expect_silence(&mut self) {
        self.sock
            .set_read_timeout(Some(Duration::from_millis(150)))
            .unwrap();
        let r = read_message(&mut self.reader);
        self.sock.set_read_timeout(None).unwrap();
        match r {
            Ok(Some(env)) => panic!("预期静默，却收到: {env:?}"),
            Ok(None) => panic!("预期静默，却收到 EOF"),
            Err(CodecError::Io(_)) => {} // 读超时=无消息
            Err(e) => panic!("预期静默，却报错: {e}"),
        }
    }

    /// 半关闭写方向：Runtime 侧读到 EOF 正常退出
    fn close(&mut self) {
        self.sock.shutdown(Shutdown::Write).unwrap();
    }
}

fn initialize_env(protocol_version: u32) -> Envelope {
    Envelope::wrap(
        PROTOCOL_VERSION,
        "h-init",
        &HostToRuntime::Initialize {
            protocol_version,
            capabilities: vec!["ui.report".into()],
            data_dir: "/tmp/bbw-agent".into(),
            proxy_config: None,
        },
    )
    .unwrap()
}

fn ping_env(id: &str) -> Envelope {
    Envelope::wrap(PROTOCOL_VERSION, id, &HostToRuntime::Ping).unwrap()
}

// ---------------------------------------------------------------------------
// 握手
// ---------------------------------------------------------------------------

#[test]
fn handshake_initialize_result_then_runtime_ready() {
    let (mut host, rx, handle) = spawn_runtime();
    host.send(&initialize_env(1));

    // 回执一：initialize.result（REQ 成对，reply_to 指回）
    let result = host.recv();
    assert_eq!(result.msg_type, "initialize.result");
    assert_eq!(result.reply_to.as_deref(), Some("h-init"));
    assert_eq!(result.v, PROTOCOL_VERSION);
    assert_eq!(result.payload["runtimeVersion"], json!("0.1.0"));
    assert_eq!(
        result.payload["capabilities"],
        json!(["stdio", "memory.v1"])
    );

    // 回执二：runtime.ready（NTF，无 reply_to）
    let ready = host.recv();
    assert_eq!(ready.msg_type, "runtime.ready");
    assert_eq!(ready.reply_to, None);
    assert_eq!(
        ready.payload,
        json!({"runtimeVersion":"0.1.0","activeSessions":0,"walHealthy":true})
    );

    // EOF 优雅退出：握手不计入服务统计
    host.close();
    let stats = handle.join().unwrap().expect("serve_on 应 Ok");
    assert_eq!(
        stats,
        ServeStats {
            envelopes: 0,
            unknown_types: 0
        }
    );
    drop(rx);
}

#[test]
fn handshake_first_message_not_initialize_is_fatal() {
    let (mut host, _rx, handle) = spawn_runtime();
    host.send(&ping_env("h-1"));

    let err = host.recv();
    assert_eq!(err.msg_type, "error");
    assert_eq!(err.payload["code"], json!(9003));
    assert_eq!(err.payload["fatal"], json!(true));

    let res = handle.join().unwrap();
    assert!(matches!(res, Err(HostError::Handshake(_))), "实际: {res:?}");
}

#[test]
fn handshake_minor_version_difference_continues() {
    // major=v/1000 约定下 2 与 1 同属大版本 0 → 小版本差异，继续服务
    let (mut host, _rx, handle) = spawn_runtime();
    host.send(&initialize_env(2));

    assert_eq!(host.recv().msg_type, "initialize.result");
    assert_eq!(host.recv().msg_type, "runtime.ready");

    host.send(&ping_env("h-9"));
    let pong = host.recv();
    assert_eq!(pong.msg_type, "pong");
    assert_eq!(pong.reply_to.as_deref(), Some("h-9"));

    host.close();
    handle.join().unwrap().expect("小版本差异应继续服务");
}

#[test]
fn handshake_major_version_difference_is_fatal() {
    let (mut host, _rx, handle) = spawn_runtime();
    host.send(&initialize_env(1001));

    let err = host.recv();
    assert_eq!(err.msg_type, "error");
    assert_eq!(err.payload["code"], json!(9002));
    assert_eq!(err.payload["fatal"], json!(true));

    let res = handle.join().unwrap();
    let err = res.expect_err("大版本不兼容应 Err");
    assert!(
        matches!(
            err,
            HostError::VersionMismatch {
                host: 1001,
                runtime: 1
            }
        ),
        "实际: {err:?}"
    );
}

#[test]
fn handshake_timeout_when_no_initialize_arrives() {
    // socket 底层设读超时 → 等不到 initialize 时硬中止（D11 §2.9 的 10s 上限路径）
    let (_host, rt) = UnixStream::pair().unwrap();
    rt.set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let handle = std::thread::spawn(move || serve_on(rt, TestHandler::spawn().0));
    let res = handle.join().unwrap();
    assert!(
        matches!(res, Err(HostError::HandshakeTimeout(_))),
        "实际: {res:?}"
    );
}

// ---------------------------------------------------------------------------
// 服务循环
// ---------------------------------------------------------------------------

#[test]
fn ping_gets_pong_with_reply_to() {
    let (mut host, rx, handle) = spawn_runtime();
    host.send(&initialize_env(1));
    assert_eq!(host.recv().msg_type, "initialize.result");
    assert_eq!(host.recv().msg_type, "runtime.ready");

    host.send(&ping_env("h-42"));
    let pong = host.recv();
    assert_eq!(pong.msg_type, "pong");
    assert_eq!(pong.id, "r-3"); // r-1=initialize.result, r-2=runtime.ready
    assert_eq!(pong.reply_to.as_deref(), Some("h-42"));

    // ping 在 codec 层应答，不进 handler
    assert!(rx.try_recv().is_err());

    host.close();
    let stats = handle.join().unwrap().unwrap();
    assert_eq!(stats.envelopes, 1);
}

#[test]
fn req_dispatched_to_handler_reply_carries_reply_to() {
    let (mut host, rx, handle) = spawn_runtime();
    host.send(&initialize_env(1));
    host.recv();
    host.recv();

    host.send(
        &Envelope::wrap(
            PROTOCOL_VERSION,
            "h-u1",
            &HostToRuntime::UserMessage {
                session_id: "sess-1".into(),
                text: "修复登录超时".into(),
                attachments: vec![],
                slash: None,
                thinking: None,
            },
        )
        .unwrap(),
    );
    let reply = host.recv();
    assert_eq!(reply.msg_type, "session.state");
    assert_eq!(reply.reply_to.as_deref(), Some("h-u1"));
    assert_eq!(reply.payload["state"], json!("running"));
    assert_eq!(reply.payload["reason"], json!("修复登录超时"));

    // handler 收到的是解码后的消息与原信封
    assert_eq!(rx.recv().unwrap(), "user.message#h-u1");

    host.close();
    let stats = handle.join().unwrap().unwrap();
    assert_eq!(
        stats,
        ServeStats {
            envelopes: 1,
            unknown_types: 0
        }
    );
}

#[test]
fn ntf_gets_no_reply_but_loop_stays_alive() {
    let (mut host, _rx, handle) = spawn_runtime();
    host.send(&initialize_env(1));
    host.recv();
    host.recv();

    // obo.token 是 NTF：无回复
    host.send(
        &Envelope::wrap(
            PROTOCOL_VERSION,
            "h-t1",
            &HostToRuntime::OboToken {
                token: "tok-xyz".into(),
                exp: 1_790_000_000,
                scopes: vec!["kb:read".into()],
            },
        )
        .unwrap(),
    );
    host.expect_silence();

    // 循环仍存活：ping 立即得到 pong
    host.send(&ping_env("h-9"));
    assert_eq!(host.recv().msg_type, "pong");

    host.close();
    let stats = handle.join().unwrap().unwrap();
    assert_eq!(
        stats,
        ServeStats {
            envelopes: 2,
            unknown_types: 0
        }
    );
}

#[test]
fn unknown_type_counted_and_ignored_not_fatal() {
    let (mut host, rx, handle) = spawn_runtime();
    host.send(&initialize_env(1));
    host.recv();
    host.recv();

    // 未来版本的新消息：不回复、不退出
    host.send_raw(b"{\"v\":1,\"id\":\"h-x1\",\"type\":\"future.thing\",\"payload\":{\"a\":1}}\n");
    host.expect_silence();

    host.send(&ping_env("h-9"));
    assert_eq!(host.recv().msg_type, "pong");

    host.close();
    let stats = handle.join().unwrap().expect("未知 type 不得导致退出");
    assert_eq!(
        stats,
        ServeStats {
            envelopes: 2,
            unknown_types: 1
        }
    );
    assert!(rx.try_recv().is_err(), "未知 type 不应进 handler");
}

#[test]
fn invalid_payload_answers_error_9001_non_fatal() {
    let (mut host, _rx, handle) = spawn_runtime();
    host.send(&initialize_env(1));
    host.recv();
    host.recv();

    // 已知 type 但缺必填字段（workspace/mode/modelPolicy）
    host.send_raw(
        b"{\"v\":1,\"id\":\"h-bad\",\"type\":\"session.start\",\"payload\":{\"sessionId\":\"s\"}}\n",
    );
    let err = host.recv();
    assert_eq!(err.msg_type, "error");
    assert_eq!(err.payload["code"], json!(9001));
    assert_eq!(err.payload["fatal"], json!(false));

    // 回复完错误继续服务
    host.send(&ping_env("h-9"));
    assert_eq!(host.recv().msg_type, "pong");

    host.close();
    let stats = handle.join().unwrap().unwrap();
    assert_eq!(
        stats,
        ServeStats {
            envelopes: 2,
            unknown_types: 0
        }
    );
}

#[test]
fn d15_memory_and_report_requests_get_paired_replies() {
    let (mut host, rx, handle) = spawn_runtime();
    host.send(&initialize_env(1));
    host.recv();
    host.recv();

    // memory.list → memory.list.result（条目 wire 名逐字：type / updated_at）
    host.send(
        &Envelope::wrap(
            PROTOCOL_VERSION,
            "h-m1",
            &HostToRuntime::MemoryList {
                limit: Some(7),
                scope: None,
                workspace_path: None,
            },
        )
        .unwrap(),
    );
    let r1 = host.recv();
    assert_eq!(r1.msg_type, "memory.list.result");
    assert_eq!(r1.reply_to.as_deref(), Some("h-m1"));
    assert_eq!(
        r1.payload,
        json!({"items":[{"name":"gitee-remote","title":"Gitee 远端","type":"knowledge",
                         "updated_at":1790000000000u64,"hook":"记住.*远端"}]})
    );

    // memory.delete → {ok}
    host.send(
        &Envelope::wrap(
            PROTOCOL_VERSION,
            "h-m2",
            &HostToRuntime::MemoryDelete {
                scope: None,
                workspace_path: None,
                name: "gitee-remote".into(),
            },
        )
        .unwrap(),
    );
    let r2 = host.recv();
    assert_eq!(r2.msg_type, "memory.delete.result");
    assert_eq!(r2.reply_to.as_deref(), Some("h-m2"));
    assert_eq!(r2.payload, json!({"ok":true}));

    // report.list → 条目 stats 嵌套 camelCase（filesChanged/memorySaved）
    host.send(
        &Envelope::wrap(
            PROTOCOL_VERSION,
            "h-m3",
            &HostToRuntime::ReportList { limit: None },
        )
        .unwrap(),
    );
    let r3 = host.recv();
    assert_eq!(r3.msg_type, "report.list.result");
    assert_eq!(r3.reply_to.as_deref(), Some("h-m3"));
    assert_eq!(
        r3.payload,
        json!({"items":[{"date":"2026-11-06","stats":{"sessions":3,"tools":47,
                         "blocked":2,"filesChanged":12,"memorySaved":3}}]})
    );

    assert_eq!(rx.recv().unwrap(), "memory.list#h-m1");
    assert_eq!(rx.recv().unwrap(), "memory.delete#h-m2");
    assert_eq!(rx.recv().unwrap(), "report.list#h-m3");

    host.close();
    let stats = handle.join().unwrap().unwrap();
    assert_eq!(
        stats,
        ServeStats {
            envelopes: 3,
            unknown_types: 0
        }
    );
}

// ---------------------------------------------------------------------------
// 传输层直测（不经 serve 线程）
// ---------------------------------------------------------------------------

#[test]
fn transport_line_error_then_continue_then_eof() {
    // codec 兜底衔接：坏行报 Line 错误且整行已丢弃，后续消息不受影响；EOF 返回 None
    let (mut host, rt) = UnixStream::pair().unwrap();
    let mut tp = StdioTransport::new(rt);

    let env1 = Envelope::wrap(1, "h-1", &HostToRuntime::Ping).unwrap();
    write_message(&mut host, &env1).unwrap();
    host.write_all(b"{broken json\n").unwrap();
    let env2 = Envelope::wrap(1, "h-2", &HostToRuntime::Pong).unwrap();
    write_message(&mut host, &env2).unwrap();
    host.flush().unwrap();

    assert_eq!(tp.recv().unwrap(), Some(env1));
    assert!(matches!(tp.recv(), Err(RecvError::Line(_))));
    assert_eq!(tp.recv().unwrap(), Some(env2));

    drop(host);
    assert_eq!(tp.recv().unwrap(), None, "EOF 应返回 None");
}

#[test]
fn transport_write_backpressure_beyond_8mb() {
    // 对端停滞（非阻塞写 + 宿主不读）：待写缓冲越过 8MB 上限 → Backpressure fatal
    let (_host, rt) = UnixStream::pair().unwrap();
    rt.set_nonblocking(true).unwrap();
    let mut tp = StdioTransport::new(rt);

    // 每条信封约 0.9MB：需累计超过 8MB 才可能熔断
    let big = "x".repeat(900 * 1024);
    let mut attempts = 0usize;
    let outcome = loop {
        attempts += 1;
        let env = Envelope::wrap(
            PROTOCOL_VERSION,
            "r-1",
            &RuntimeToHost::DelegateEvent {
                session_id: "sess-1".into(),
                delegate_task_id: "dt-1".into(),
                kind: DelegateEventKind::Meta,
                payload: json!({ "blob": big }),
            },
        )
        .unwrap();
        match tp.send(&env) {
            Ok(()) if attempts < 100 => {}
            Ok(()) => panic!("写满 100 次仍未熔断，用例失效"),
            Err(e) => break e,
        }
    };
    assert!(
        matches!(outcome, HostError::Backpressure),
        "实际: {outcome:?}"
    );
    assert!(
        tp.pending_bytes() > MAX_PENDING_WRITE_BYTES,
        "熔断时待写字节必须已越过上限"
    );
    assert!(attempts >= 8, "至少写入数 MB 才熔断，实际 {attempts} 次");
}
