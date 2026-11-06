//! bbrt-protocol 集成测试：
//! 1) 全消息类型 serde roundtrip（HostToRuntime 17 变体 + RuntimeToHost 23 变体）；
//! 2) JSON 字符串 → 枚举 → JSON 的黄金样本断言（字段名/可选性/枚举值逐项对齐 D11 §4）；
//! 3) 信封 wrap/unwrap 与 codec 行式读写。

use std::io::Cursor;

use bbrt_protocol::{
    Blocked, BriefContextItem, CheckpointReason, CodecError, CompactionPhase, Decision,
    DelegateEventKind, EndReason, Envelope, FileChange, GrantScope, HostToRuntime, ModelPolicy,
    ModelSwitchReason, PROTOCOL_VERSION, PermissionMode, Preview, ProtocolError, RenewReason,
    ReviewDecision, RiskLevel, RuntimeToHost, SessionState, StreamChannel, SubagentPhase,
    SubagentResult, TaskBrief, ToolSource, ToolsReloadReason, Usage, read_message, write_message,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// 构造样本
// ---------------------------------------------------------------------------

fn task_brief() -> TaskBrief {
    TaskBrief {
        task: "修复登录超时并跑通测试".into(),
        workspace: "~/code/bbw-server".into(),
        constraints: vec!["不修改 migrations/".into()],
        context: vec![BriefContextItem {
            source: "src/auth.rs:L42".into(),
            excerpt: "db.wait(30s)".into(),
        }],
        acceptance: vec!["cargo test --lib 全绿".into()],
        forbidden: vec!["git push".into()],
    }
}

fn all_host_to_runtime() -> Vec<HostToRuntime> {
    vec![
        HostToRuntime::Initialize {
            protocol_version: 1,
            capabilities: vec!["stdio".into()],
            data_dir: "/data/agent".into(),
            proxy_config: Some(json!({"host": "127.0.0.1", "port": 7890})),
        },
        HostToRuntime::SessionStart {
            session_id: "sess-1".into(),
            workspace: "~/code/bbw".into(),
            mode: PermissionMode::AutoEdit,
            model_policy: ModelPolicy::Auto,
            skills: vec!["sql-review".into()],
            history_ref: None,
            backend_hint: Some("zcode".into()),
        },
        HostToRuntime::UserMessage {
            session_id: "sess-1".into(),
            text: "修复登录超时 bug".into(),
            attachments: vec!["file-9".into()],
            slash: Some("/strong".into()),
        },
        HostToRuntime::PermissionResponse {
            request_id: "req-1".into(),
            decision: Decision::Allow,
            scope: GrantScope::Session,
            edited_args: Some(json!({"cmd": "cargo test"})),
            accepted_hunks: None,
        },
        HostToRuntime::CheckpointCreate {
            session_id: "sess-1".into(),
            reason: "manual".into(),
        },
        HostToRuntime::CheckpointRestore {
            checkpoint_id: "cp-1".into(),
        },
        HostToRuntime::DelegateLaunch {
            session_id: "sess-1".into(),
            delegate_task_id: "dt-1".into(),
            backend: "claude".into(),
            task_brief: task_brief(),
            mode: PermissionMode::FullAuto,
            workspace: "~/code/bbw".into(),
        },
        HostToRuntime::DelegateInput {
            delegate_task_id: "dt-1".into(),
            text: "补一条单测".into(),
        },
        HostToRuntime::DelegateCancel {
            delegate_task_id: "dt-1".into(),
            graceful: true,
        },
        HostToRuntime::DelegateReview {
            delegate_task_id: "dt-1".into(),
            decision: ReviewDecision::Reject,
            rejected_hunks: Some(vec!["hunk-2".into()]),
        },
        HostToRuntime::SessionPause {
            session_id: "sess-1".into(),
        },
        HostToRuntime::SessionResume {
            session_id: "sess-1".into(),
        },
        HostToRuntime::SessionEnd {
            session_id: "sess-1".into(),
            reason: EndReason::Logout,
        },
        HostToRuntime::OboToken {
            token: "tok-xyz".into(),
            exp: 1_730_000_000,
            scopes: vec!["kb:read".into()],
        },
        HostToRuntime::ToolsReload {
            reason: ToolsReloadReason::Skill,
        },
        HostToRuntime::Ping,
        HostToRuntime::Pong,
    ]
}

fn all_runtime_to_host() -> Vec<RuntimeToHost> {
    vec![
        RuntimeToHost::InitializeResult {
            runtime_version: "0.1.0".into(),
            tools: vec!["read_file".into(), "run_command".into()],
            capabilities: vec!["stdio".into()],
        },
        RuntimeToHost::RuntimeReady {
            runtime_version: "0.1.0".into(),
            active_sessions: 0,
            wal_healthy: true,
        },
        RuntimeToHost::SessionReady {
            session_id: "sess-1".into(),
            restored: true,
            replayed_events: Some(42),
            warnings: vec!["压缩退化为截断".into()],
        },
        RuntimeToHost::StreamDelta {
            session_id: "sess-1".into(),
            delta: "正在定位".into(),
            seq: 7,
            channel: StreamChannel::Text,
        },
        RuntimeToHost::StreamDone {
            session_id: "sess-1".into(),
            finish_reason: "stop".into(),
            usage: Usage {
                in_tokens: 1200,
                out_tokens: 300,
            },
        },
        RuntimeToHost::ToolCall {
            call_id: "call-1".into(),
            session_id: "sess-1".into(),
            tool: "run_command".into(),
            args: json!({"cmd": "cargo test"}),
            risk: RiskLevel::High,
            parallel: false,
            source: ToolSource::Local,
        },
        RuntimeToHost::ToolResult {
            call_id: "call-1".into(),
            ok: false,
            summary: "被危险命令规则阻断".into(),
            truncated: false,
            exit_code: None,
            blocked: Some(Blocked {
                rule: "rm -rf".into(),
                kind: "danger-cmd".into(),
            }),
            duration_ms: Some(12),
        },
        RuntimeToHost::PermissionRequest {
            request_id: "req-1".into(),
            tool: "run_command".into(),
            risk: RiskLevel::High,
            args: json!({"cmd": "cargo build"}),
            reason: "高危命令需确认".into(),
            preview: Some(Preview::Command {
                command: "cargo build".into(),
            }),
            options: vec![GrantScope::Once, GrantScope::Session, GrantScope::Permanent],
        },
        RuntimeToHost::CheckpointCreated {
            checkpoint_id: "cp-1".into(),
            session_id: "sess-1".into(),
            files_changed: vec![FileChange {
                path: "src/main.rs".into(),
                add: 8,
                del: 4,
            }],
            reason: CheckpointReason::PreEdit,
            git_ref: Some("refs/bbw-agent/sess-1/cp-1".into()),
        },
        RuntimeToHost::CompactionEvent {
            session_id: "sess-1".into(),
            phase: CompactionPhase::Done,
            freed_tokens: Some(42_000),
            kept_rounds: Some(6),
        },
        RuntimeToHost::ModelSwitched {
            session_id: "sess-1".into(),
            from: ModelPolicy::Fast,
            to: ModelPolicy::Strong,
            reason: ModelSwitchReason::Auto,
        },
        RuntimeToHost::SubagentSpawn {
            session_id: "sess-1".into(),
            sub_id: "sub-1".into(),
            task_digest: "定位超时来源".into(),
            tool_subset: vec!["read_file".into(), "search_files".into()],
        },
        RuntimeToHost::SubagentEvent {
            sub_id: "sub-1".into(),
            phase: SubagentPhase::Delta,
            summary: Some("已读 3 个文件".into()),
        },
        RuntimeToHost::SubagentJoin {
            session_id: "sess-1".into(),
            results: vec![SubagentResult {
                sub_id: "sub-1".into(),
                ok: true,
                summary: "超时源于 30s 数据库等待".into(),
            }],
        },
        RuntimeToHost::DelegateBrief {
            session_id: "sess-1".into(),
            brief: task_brief(),
            backend_suggestion: "zcode".into(),
        },
        RuntimeToHost::DelegateEvent {
            delegate_task_id: "dt-1".into(),
            kind: DelegateEventKind::ToolUse,
            payload: json!({"tool": "Edit", "file": "src/auth.rs"}),
        },
        RuntimeToHost::DelegateEnd {
            delegate_task_id: "dt-1".into(),
            exit_code: 0,
            summary: "完成修复".into(),
            changed_files: vec!["src/auth.rs".into()],
            checkpoint_id: Some("cp-2".into()),
            child_session_ref: Some("cs-9".into()),
        },
        RuntimeToHost::SessionStateReport {
            session_id: "sess-1".into(),
            state: SessionState::WaitingPermission,
            reason: "门控第⑥步 confirm".into(),
        },
        RuntimeToHost::SessionEnded {
            session_id: "sess-1".into(),
            summary: "修复登录超时并跑通测试".into(),
        },
        RuntimeToHost::OboRenew {
            scopes: vec!["kb:read".into()],
            reason: RenewReason::Expiring,
        },
        RuntimeToHost::Ping,
        RuntimeToHost::Pong,
        RuntimeToHost::Error {
            code: 8011,
            message: "ai-gateway 不可用".into(),
            fatal: false,
            session_id: Some("sess-1".into()),
        },
    ]
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

fn roundtrip<M>(msg: &M)
where
    M: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let s = serde_json::to_string(msg).expect("serialize");
    let back: M = serde_json::from_str(&s).expect("deserialize");
    assert_eq!(&back, msg, "roundtrip 不一致，线路形态: {s}");
}

fn golden<T: Serialize>(msg: &T, expected: Value) {
    assert_eq!(serde_json::to_value(msg).expect("serialize"), expected);
}

// ---------------------------------------------------------------------------
// 全类型 roundtrip
// ---------------------------------------------------------------------------

#[test]
fn roundtrip_all_host_to_runtime() {
    let all = all_host_to_runtime();
    assert_eq!(all.len(), 17, "D11 §4 宿主→RT 15 类型 + 双向 ping/pong");
    for msg in &all {
        roundtrip(msg);
    }
}

#[test]
fn roundtrip_all_runtime_to_host() {
    let all = all_runtime_to_host();
    assert_eq!(all.len(), 23, "D11 §4 RT→宿主 21 类型 + 双向 ping/pong");
    for msg in &all {
        roundtrip(msg);
    }
}

// ---------------------------------------------------------------------------
// 黄金样本：JSON → 枚举 → JSON
// ---------------------------------------------------------------------------

#[test]
fn golden_session_start() {
    // Option 字段缺席不出现（historyRef/backendHint）
    golden(
        &HostToRuntime::SessionStart {
            session_id: "sess-1".into(),
            workspace: "~/code/bbw".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelPolicy::Fast,
            skills: vec!["sql-review".into()],
            history_ref: None,
            backend_hint: None,
        },
        json!({
            "type": "session.start",
            "sessionId": "sess-1",
            "workspace": "~/code/bbw",
            "mode": "ask",
            "modelPolicy": "fast",
            "skills": ["sql-review"]
        }),
    );
    // 反向：JSON 字符串 → 枚举
    let m: HostToRuntime = serde_json::from_str(
        r#"{"type":"session.start","sessionId":"s","workspace":"w","mode":"full-auto","modelPolicy":"auto","skills":[]}"#,
    )
    .unwrap();
    assert!(matches!(
        m,
        HostToRuntime::SessionStart {
            mode: PermissionMode::FullAuto,
            ..
        }
    ));
}

#[test]
fn golden_stream_channels() {
    for (channel, name) in [
        (StreamChannel::Text, "text"),
        (StreamChannel::Reasoning, "reasoning"),
        (StreamChannel::Tool, "tool"),
    ] {
        golden(
            &RuntimeToHost::StreamDelta {
                session_id: "s".into(),
                delta: "x".into(),
                seq: 1,
                channel,
            },
            json!({"type":"stream.delta","sessionId":"s","delta":"x","seq":1,"channel":name}),
        );
    }
}

#[test]
fn golden_tool_call_and_result() {
    golden(
        &RuntimeToHost::ToolCall {
            call_id: "c1".into(),
            session_id: "s".into(),
            tool: "edit_file".into(),
            args: json!({"path": "a.rs"}),
            risk: RiskLevel::Medium,
            parallel: false,
            source: ToolSource::Backend,
        },
        json!({
            "type":"tool.call","callId":"c1","sessionId":"s","tool":"edit_file",
            "args":{"path":"a.rs"},"risk":"medium","parallel":false,"source":"backend"
        }),
    );
    golden(
        &RuntimeToHost::ToolResult {
            call_id: "c1".into(),
            ok: false,
            summary: "命令被阻断".into(),
            truncated: false,
            exit_code: Some(9),
            blocked: Some(Blocked {
                rule: "sudo".into(),
                kind: "rule".into(),
            }),
            duration_ms: None,
        },
        json!({
            "type":"tool.result","callId":"c1","ok":false,"summary":"命令被阻断",
            "truncated":false,"exitCode":9,"blocked":{"rule":"sudo","kind":"rule"}
        }),
    );
}

#[test]
fn golden_permission_request_and_response() {
    golden(
        &RuntimeToHost::PermissionRequest {
            request_id: "req-9".into(),
            tool: "run_command".into(),
            risk: RiskLevel::High,
            args: json!({"cmd": "cargo build"}),
            reason: "高危命令需确认".into(),
            preview: Some(Preview::Command {
                command: "cargo build".into(),
            }),
            options: vec![GrantScope::Once, GrantScope::Session, GrantScope::Permanent],
        },
        json!({
            "type":"permission.request","requestId":"req-9","tool":"run_command",
            "risk":"high","args":{"cmd":"cargo build"},"reason":"高危命令需确认",
            "preview":{"kind":"command","command":"cargo build"},
            "options":["once","session","permanent"]
        }),
    );
    golden(
        &HostToRuntime::PermissionResponse {
            request_id: "req-9".into(),
            decision: Decision::Deny,
            scope: GrantScope::Once,
            edited_args: None,
            accepted_hunks: None,
        },
        json!({
            "type":"permission.response","requestId":"req-9",
            "decision":"deny","scope":"once"
        }),
    );
}

#[test]
fn golden_checkpoint_created() {
    golden(
        &RuntimeToHost::CheckpointCreated {
            checkpoint_id: "cp-3".into(),
            session_id: "s".into(),
            files_changed: vec![FileChange {
                path: "src/auth.rs".into(),
                add: 8,
                del: 4,
            }],
            reason: CheckpointReason::PreCommand,
            git_ref: None,
        },
        json!({
            "type":"checkpoint.created","checkpointId":"cp-3","sessionId":"s",
            "filesChanged":[{"path":"src/auth.rs","add":8,"del":4}],
            "reason":"pre-command"
        }),
    );
}

#[test]
fn golden_compaction_and_model_switched() {
    golden(
        &RuntimeToHost::CompactionEvent {
            session_id: "s".into(),
            phase: CompactionPhase::Start,
            freed_tokens: None,
            kept_rounds: None,
        },
        json!({"type":"compaction.event","sessionId":"s","phase":"start"}),
    );
    golden(
        &RuntimeToHost::ModelSwitched {
            session_id: "s".into(),
            from: ModelPolicy::Strong,
            to: ModelPolicy::Fast,
            reason: ModelSwitchReason::Downgrade,
        },
        json!({"type":"model.switched","sessionId":"s","from":"strong","to":"fast","reason":"downgrade"}),
    );
}

#[test]
fn golden_subagent_join() {
    golden(
        &RuntimeToHost::SubagentJoin {
            session_id: "s".into(),
            results: vec![
                SubagentResult {
                    sub_id: "sub-1".into(),
                    ok: true,
                    summary: "命中 3 处".into(),
                },
                SubagentResult {
                    sub_id: "sub-2".into(),
                    ok: false,
                    summary: "超步自杀，部分结果".into(),
                },
            ],
        },
        json!({
            "type":"subagent.join","sessionId":"s",
            "results":[
                {"subId":"sub-1","ok":true,"summary":"命中 3 处"},
                {"subId":"sub-2","ok":false,"summary":"超步自杀，部分结果"}
            ]
        }),
    );
}

#[test]
fn golden_delegate_brief_launch_end_review() {
    let brief = RuntimeToHost::DelegateBrief {
        session_id: "s".into(),
        brief: task_brief(),
        backend_suggestion: "zcode".into(),
    };
    golden(
        &brief,
        json!({
            "type":"delegate.brief","sessionId":"s","backendSuggestion":"zcode",
            "brief":{
                "task":"修复登录超时并跑通测试","workspace":"~/code/bbw-server",
                "constraints":["不修改 migrations/"],
                "context":[{"source":"src/auth.rs:L42","excerpt":"db.wait(30s)"}],
                "acceptance":["cargo test --lib 全绿"],
                "forbidden":["git push"]
            }
        }),
    );
    golden(
        &HostToRuntime::DelegateReview {
            delegate_task_id: "dt-1".into(),
            decision: ReviewDecision::Accept,
            rejected_hunks: None,
        },
        json!({"type":"delegate.review","delegateTaskId":"dt-1","decision":"accept"}),
    );
    golden(
        &RuntimeToHost::DelegateEvent {
            delegate_task_id: "dt-1".into(),
            kind: DelegateEventKind::ToolResult,
            payload: json!({"ok": true}),
        },
        json!({"type":"delegate.event","delegateTaskId":"dt-1","kind":"tool_result","payload":{"ok":true}}),
    );
}

#[test]
fn golden_stream_done_usage_and_error() {
    golden(
        &RuntimeToHost::StreamDone {
            session_id: "s".into(),
            finish_reason: "tool_calls".into(),
            usage: Usage {
                in_tokens: 10,
                out_tokens: 20,
            },
        },
        json!({"type":"stream.done","sessionId":"s","finishReason":"tool_calls","usage":{"in":10,"out":20}}),
    );
    golden(
        &RuntimeToHost::Error {
            code: 8011,
            message: "ai-gateway 不可用".into(),
            fatal: false,
            session_id: None,
        },
        json!({"type":"error","code":8011,"message":"ai-gateway 不可用","fatal":false}),
    );
}

#[test]
fn golden_ping_empty_payload() {
    golden(&HostToRuntime::Ping, json!({"type":"ping"}));
    golden(&HostToRuntime::Pong, json!({"type":"pong"}));
    golden(&RuntimeToHost::Ping, json!({"type":"ping"}));
    golden(&RuntimeToHost::Pong, json!({"type":"pong"}));
}

#[test]
fn golden_session_state_report_names() {
    // D11 §3 枚举线路名逐一核对（snake_case）
    let names = [
        ("starting", SessionState::Starting),
        ("idle", SessionState::Idle),
        ("running", SessionState::Running),
        ("waiting_permission", SessionState::WaitingPermission),
        ("waiting_review", SessionState::WaitingReview),
        ("subagent_fanout", SessionState::SubagentFanout),
        ("delegating", SessionState::Delegating),
        ("paused", SessionState::Paused),
        ("error", SessionState::Error),
        ("ended", SessionState::Ended),
    ];
    for (name, st) in names {
        assert_eq!(serde_json::to_value(st).unwrap(), json!(name));
        assert_eq!(SessionState::parse(name), Some(st));
        assert_eq!(st.to_string(), name);
        golden(
            &SessionStateReport {
                session_id: "s".into(),
                state: st,
                reason: "test".into(),
            },
            json!({"type":"session.state","sessionId":"s","state":name,"reason":"test"}),
        );
    }
    assert_eq!(SessionState::parse("active"), None); // 08 篇旧枚举不得再出现
}

// ---------------------------------------------------------------------------
// 前向兼容
// ---------------------------------------------------------------------------

#[test]
fn unknown_message_type_fails_decode_but_not_panics() {
    // D11 §4：未知 type → 忽略+计数上报（调用方决策）。此处仅保证可判别不 panic。
    let res: Result<HostToRuntime, _> =
        serde_json::from_str(r#"{"type":"future.thing","x":1}"#);
    assert!(res.is_err());
    let res: Result<RuntimeToHost, _> =
        serde_json::from_str(r#"{"type":"another.future"}"#);
    assert!(res.is_err());
}

#[test]
fn unknown_fields_are_tolerated() {
    // 前向兼容：不开 deny_unknown_fields，新版本宿主多带字段不报错
    let m: HostToRuntime = serde_json::from_str(
        r#"{"type":"session.start","sessionId":"s","workspace":"w","mode":"ask",
            "modelPolicy":"auto","skills":[],"futureField":{"a":1}}"#,
    )
    .unwrap();
    assert_eq!(
        m,
        HostToRuntime::SessionStart {
            session_id: "s".into(),
            workspace: "w".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelPolicy::Auto,
            skills: vec![],
            history_ref: None,
            backend_hint: None,
        }
    );
}

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

#[test]
fn envelope_wrap_unwrap_roundtrip() {
    let msg = HostToRuntime::SessionStart {
        session_id: "sess-1".into(),
        workspace: "~/code/bbw".into(),
        mode: PermissionMode::Ask,
        model_policy: ModelPolicy::Auto,
        skills: vec![],
        history_ref: None,
        backend_hint: None,
    };
    let env = Envelope::wrap(PROTOCOL_VERSION, "h-1", &msg).expect("wrap");
    assert_eq!(env.msg_type, "session.start");
    assert_eq!(
        env.payload,
        json!({"sessionId":"sess-1","workspace":"~/code/bbw","mode":"ask","modelPolicy":"auto","skills":[]})
    );
    // 线路形态：type 在信封层、payload 嵌套，reply_to/ts 缺席
    assert_eq!(
        serde_json::to_value(&env).unwrap(),
        json!({
            "v":1,"id":"h-1","type":"session.start",
            "payload":{"sessionId":"sess-1","workspace":"~/code/bbw","mode":"ask","modelPolicy":"auto","skills":[]}
        })
    );
    let back: HostToRuntime = env.unwrap().expect("unwrap");
    assert_eq!(back, msg);

    // reply_to / ts 注入
    let env = env.with_reply_to("r-9").with_ts(1_730_000_000);
    let shape = serde_json::to_value(&env).unwrap();
    assert_eq!(shape["reply_to"], json!("r-9"));
    assert_eq!(shape["ts"], json!(1_730_000_000));
}

#[test]
fn envelope_unwrap_ping_without_payload() {
    // ping 无字段：信封可无 payload 键
    let env: Envelope =
        serde_json::from_str(r#"{"v":1,"id":"h-7","type":"ping"}"#).unwrap();
    assert_eq!(env.payload, Value::Null);
    assert_eq!(env.unwrap::<HostToRuntime>().unwrap(), HostToRuntime::Ping);
}

#[test]
fn envelope_unwrap_payload_must_be_object() {
    let env: Envelope =
        serde_json::from_str(r#"{"v":1,"id":"h-7","type":"session.start","payload":[1,2]}"#).unwrap();
    assert!(matches!(
        env.unwrap::<HostToRuntime>(),
        Err(ProtocolError::PayloadNotObject)
    ));
}

// ---------------------------------------------------------------------------
// codec 行式读写
// ---------------------------------------------------------------------------

#[test]
fn codec_write_read_roundtrip() {
    let mut buf = Vec::new();
    let env1 = Envelope::wrap(PROTOCOL_VERSION, "h-1", &HostToRuntime::Ping).unwrap();
    let env2 = Envelope::wrap(PROTOCOL_VERSION, "r-2", &RuntimeToHost::Error {
        code: 8010,
        message: "压缩后仍超限".into(),
        fatal: false,
        session_id: None,
    })
    .unwrap();
    write_message(&mut buf, &env1).unwrap();
    write_message(&mut buf, &env2).unwrap();
    assert_eq!(buf.iter().filter(|b| **b == b'\n').count(), 2); // 每行一条

    let mut cur = Cursor::new(buf);
    assert_eq!(read_message(&mut cur).unwrap(), Some(env1));
    assert_eq!(read_message(&mut cur).unwrap(), Some(env2));
    assert_eq!(read_message(&mut cur).unwrap(), None); // EOF
}

#[test]
fn codec_tolerates_bom_and_blank_lines() {
    let data = "\u{feff}{\"v\":1,\"id\":\"h-1\",\"type\":\"ping\"}\n\n{\"v\":1,\"id\":\"h-2\",\"type\":\"pong\"}\n";
    let mut cur = Cursor::new(data.as_bytes().to_vec());
    let m1 = read_message(&mut cur).unwrap().unwrap();
    let m2 = read_message(&mut cur).unwrap().unwrap();
    assert_eq!(m1.id, "h-1");
    assert_eq!(m2.id, "h-2");
    assert_eq!(read_message(&mut cur).unwrap(), None);
}

#[test]
fn codec_rejects_oversize_line() {
    let big = format!("{}{}", "\"", "x".repeat(256 * 1024)); // > 255KB
    let mut cur = Cursor::new(format!("{}\n", big).into_bytes());
    assert!(matches!(
        read_message(&mut cur),
        Err(CodecError::LineTooLong)
    ));
}

#[test]
fn codec_rejects_malformed_json_and_bad_utf8() {
    let mut cur = Cursor::new(b"{not json}\n".to_vec());
    assert!(matches!(
        read_message(&mut cur),
        Err(CodecError::MalformedJson(_))
    ));
    let mut cur = Cursor::new(vec![0xff, b'\n']);
    assert!(matches!(read_message(&mut cur), Err(CodecError::InvalidUtf8)));
}

// ---------------------------------------------------------------------------
// 错误类型实现 std::error::Error（编译期断言）
// ---------------------------------------------------------------------------

#[test]
fn error_types_impl_std_error() {
    fn assert_error<E: std::error::Error>() {}
    assert_error::<CodecError>();
    assert_error::<ProtocolError>();
    let e = TransitionProbe::Illegal {
        from: SessionState::Idle,
        to: SessionState::Running,
    };
    assert!(!e.to_string().is_empty());
}

// 本地探针：验证 thiserror 风格错误可 Display（bbrt-session TransitionError 的等价形态在
// 其自身测试中断言；这里只覆盖 protocol crate 的两个错误类型）
#[derive(Debug, thiserror::Error)]
#[error("非法状态迁移: {from:?} → {to:?}")]
enum TransitionProbe {
    Illegal {
        from: SessionState,
        to: SessionState,
    },
}
