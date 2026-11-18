//! bbrt-protocol 集成测试：
//! 1) 全消息类型 serde roundtrip（HostToRuntime 17 变体 + RuntimeToHost 24 变体）；
//! 2) JSON 字符串 → 枚举 → JSON 的黄金样本断言（字段名/可选性/枚举值逐项对齐 D11 §4）；
//! 3) 信封 wrap/unwrap 与 codec 行式读写。

use std::io::Cursor;

use bbrt_protocol::{
    read_message, write_message, Blocked, BriefContextItem, ClarifyOption,
    CodecError, CompactionPhase, Decision, DelegateEventKind, EndReason, Envelope,
    GrantScope, HostToRuntime, MemoryListItem, MemoryScope, ModelPolicy, ModelSwitchReason,
    PermissionMode, Preview, ProtocolError, RenewReason, ReviewDecision, RiskLevel, RuntimeToHost,
    SessionState, StreamChannel, SubagentPhase, SubagentResult, TaskBrief, ThinkingLevel,
    ToolSource, ToolsReloadReason, Usage, PROTOCOL_VERSION,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// 构造样本
// ---------------------------------------------------------------------------

fn task_brief() -> TaskBrief {
    TaskBrief {
        task: "修复登录超时并跑通测试".into(),
        workspace: "~/code/bbc-server".into(),
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
            workspace: "~/code/bbc".into(),
            mode: PermissionMode::AutoEdit,
            model_policy: ModelPolicy::Auto,
            model: Some("p:1:glm-5.3".into()),
            skills: vec!["sql-review".into()],
            history_ref: None,
            backend_hint: Some("zcode".into()),
            title: None,
        },
        HostToRuntime::UserMessage {
            session_id: "sess-1".into(),
            text: "修复登录超时 bug".into(),
            attachments: vec!["file-9".into()],
            slash: Some("/strong".into()),
            thinking: Some(ThinkingLevel::High),
        },
        HostToRuntime::PermissionResponse {
            request_id: "req-1".into(),
            decision: Decision::Allow,
            scope: GrantScope::Session,
            edited_args: Some(json!({"cmd": "cargo test"})),
            accepted_hunks: None,
        },
        // D20 澄清回答
        HostToRuntime::ClarifyResponse {
            question_id: "q-call-1".into(),
            answers: vec!["加漂移窗口".into()],
            free_text: Some("顺带补一条单测".into()),
        },
        HostToRuntime::DelegateLaunch {
            session_id: "sess-1".into(),
            delegate_task_id: "dt-1".into(),
            backend: "claude".into(),
            task_brief: Some(task_brief()),
            mode: PermissionMode::FullAuto,
            workspace: "~/code/bbc".into(),
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
        HostToRuntime::SessionInterrupt {
            session_id: "sess-1".into(),
        },
        HostToRuntime::SessionRename {
            session_id: "sess-1".into(),
            title: "与张三的对话".into(),
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
        // D15 §2.4/§3.3 追加
        HostToRuntime::MemoryList {
            limit: Some(7),
            scope: None,
            workspace_path: None,
        },
        HostToRuntime::MemoryDelete {
            scope: None,
            workspace_path: None,
            name: "gitee-remote".into(),
        },
        HostToRuntime::ModelSwitch {
            session_id: Some("s1".into()),
            to: bbrt_protocol::ModelPolicy::Fast,
            model: Some("p:2:deepseek-chat".into()),
            reason: Some("user".into()),
        },
        // D33 §3.3：run 历史回放
        HostToRuntime::RunHistory { run_id: "r-9".into() },
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
            session_id: "sess-1".into(),
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
            session_id: "sess-1".into(),
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
        // D20 澄清提问（不超时）
        RuntimeToHost::ClarifyRequest {
            session_id: "sess-1".into(),
            question_id: "q-call-1".into(),
            question: "用哪种方式修复？".into(),
            header: Some("修复方式".into()),
            options: vec![
                ClarifyOption {
                    label: "加漂移窗口".into(),
                    description: Some("±60s 容忍时钟偏移".into()),
                },
                ClarifyOption {
                    label: "对齐 NTP".into(),
                    description: None,
                },
            ],
            multi_select: false,
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
            model: Some("p:1:glm-5.3".into()),
            reason: ModelSwitchReason::Auto,
        },
        RuntimeToHost::SubagentSpawn {
            session_id: "sess-1".into(),
            sub_id: "sub-1".into(),
            task_digest: "定位超时来源".into(),
            tool_subset: vec!["read_file".into(), "search_files".into()],
        },
        RuntimeToHost::SubagentEvent {
            session_id: "sess-1".into(),
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
        // D33 §3.2：probe 过程明细
        RuntimeToHost::SubagentTrace {
            session_id: "sess-1".into(),
            sub_id: "r-9".into(),
            item: bbrt_protocol::SubagentTraceItem::ToolCall {
                call_id: "c1".into(),
                tool: "read_file".into(),
                args_masked: "{\"path\":\"a.rs\"}".into(),
                risk: bbrt_protocol::RiskLevel::Low,
            },
        },
        RuntimeToHost::SubagentTrace {
            session_id: "sess-1".into(),
            sub_id: "r-9".into(),
            item: bbrt_protocol::SubagentTraceItem::Text {
                text: "已定位问题".into(),
            },
        },
        RuntimeToHost::RunHistoryResult {
            run_id: "r-9".into(),
            items: vec![bbrt_protocol::HistoryItem::User {
                text: "定位超时来源".into(),
                ts: None,
                turn_done_at: None,
            }],
        },
        RuntimeToHost::DelegateBrief {
            session_id: "sess-1".into(),
            brief: task_brief(),
            backend_suggestion: "zcode".into(),
        },
        RuntimeToHost::DelegateEvent {
            session_id: "sess-1".into(),
            delegate_task_id: "dt-1".into(),
            kind: DelegateEventKind::ToolUse,
            payload: json!({"tool": "Edit", "file": "src/auth.rs"}),
        },
        RuntimeToHost::DelegateEnd {
            session_id: "sess-1".into(),
            delegate_task_id: "dt-1".into(),
            exit_code: 0,
            summary: "完成修复".into(),
            changed_files: vec!["src/auth.rs".into()],
            child_session_ref: Some("cs-9".into()),
        },
        RuntimeToHost::SessionStateReport {
            session_id: "sess-1".into(),
            state: SessionState::WaitingPermission,
            reason: "门控第⑥步 confirm".into(),
        },
        RuntimeToHost::SessionStateReport {
            session_id: "sess-1".into(),
            state: SessionState::WaitingClarify,
            reason: "ask_user 等待澄清回答".into(),
        },
        RuntimeToHost::SessionEnded {
            session_id: "sess-1".into(),
            summary: "修复登录超时并跑通测试".into(),
        },
        // 2026-11-11 标题/中断回执
        RuntimeToHost::SessionInterrupted {
            session_id: "sess-1".into(),
        },
        RuntimeToHost::SessionRenamed {
            session_id: "sess-1".into(),
            title: "修复登录超时".into(),
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
        // D15 §2.4/§3.3 追加（3 UNT + 3 回执）
        RuntimeToHost::MemorySaved {
            session_id: "sess-1".into(),
            name: "gitee-remote".into(),
            title: "Gitee 远端".into(),
            memory_type: "knowledge".into(),
            updated: true,
            scope: None,
            workspace_name: None,
        },
        RuntimeToHost::MemoryEvicted {
            session_id: None,
            name: "old-note".into(),
            reason: "capacity".into(),
        },
        RuntimeToHost::MemoryListResult {
            items: vec![MemoryListItem {
                name: "gitee-remote".into(),
                title: "Gitee 远端".into(),
                memory_type: "knowledge".into(),
                updated_at: 1_790_000_000_000,
                hook: "记住.*远端".into(),
                scope: None,
                workspace_name: None,
                global_type: None,
            }],
        },
        RuntimeToHost::MemoryDeleteResult { ok: true },
        // D23/M3：公共层移除回执
        RuntimeToHost::MemoryForgetResult {
            removed: vec!["[画像] 用户叫小红".into()],
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
    assert_eq!(
        all.len(),
        19,
        "D11 §4 宿主→RT 15 类型 + D15 追加 3 类型 + model.switch + 双向 ping/pong + D20 clarify.response（delegate.input 已随补充指令退役移除）"
    );
    for msg in &all {
        roundtrip(msg);
    }
}

#[test]
fn roundtrip_all_runtime_to_host() {
    let all = all_runtime_to_host();
    assert_eq!(
        all.len(),
        34,
        "D11 §4 RT→宿主 21 类型 + 双向 ping/pong + 2026-11-11 interrupted/renamed + D20 clarify.request/状态样本 + D23 memory.forget.result"
    );
    for msg in &all {
        roundtrip(msg);
    }
}

// ---------------------------------------------------------------------------
// 黄金样本：JSON → 枚举 → JSON
// ---------------------------------------------------------------------------

#[test]
fn golden_session_start() {
    // Option 字段缺席不出现（historyRef/backendHint/title）
    golden(
        &HostToRuntime::SessionStart {
            session_id: "sess-1".into(),
            workspace: "~/code/bbc".into(),
            mode: PermissionMode::Ask,
            model_policy: ModelPolicy::Fast,
            model: None, // None=缺席不序列化(golden)
            skills: vec!["sql-review".into()],
            history_ref: None,
            backend_hint: None,
            title: None,
        },
        json!({
            "type": "session.start",
            "sessionId": "sess-1",
            "workspace": "~/code/bbc",
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
            session_id: "s".into(),
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
            "type":"tool.result","sessionId":"s","callId":"c1","ok":false,"summary":"命令被阻断",
            "truncated":false,"exitCode":9,"blocked":{"rule":"sudo","kind":"rule"}
        }),
    );
}

#[test]
fn golden_permission_request_and_response() {
    golden(
        &RuntimeToHost::PermissionRequest {
            session_id: "sess-9".into(),
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
            "type":"permission.request","sessionId":"sess-9","requestId":"req-9","tool":"run_command",
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

/// D20 澄清提问双契约（wire 锁定：camelCase 键 + multiSelect 默认缺省 false 不上线路）
#[test]
fn golden_clarify_request_and_response() {
    golden(
        &RuntimeToHost::ClarifyRequest {
            session_id: "sess-9".into(),
            question_id: "q-call-9".into(),
            question: "用哪种方式修复？".into(),
            header: Some("修复方式".into()),
            options: vec![
                ClarifyOption {
                    label: "加漂移窗口".into(),
                    description: Some("±60s 容忍时钟偏移".into()),
                },
                ClarifyOption {
                    label: "对齐 NTP".into(),
                    description: None,
                },
            ],
            multi_select: true,
        },
        json!({
            "type":"clarify.request","sessionId":"sess-9","questionId":"q-call-9",
            "question":"用哪种方式修复？","header":"修复方式",
            "options":[
                {"label":"加漂移窗口","description":"±60s 容忍时钟偏移"},
                {"label":"对齐 NTP"}
            ],
            "multiSelect":true
        }),
    );
    golden(
        &HostToRuntime::ClarifyResponse {
            question_id: "q-call-9".into(),
            answers: vec!["加漂移窗口".into()],
            free_text: None,
        },
        json!({
            "type":"clarify.response","questionId":"q-call-9",
            "answers":["加漂移窗口"]
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
            model: None,
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

/// D33 §3.2：probe 过程明细——item tag=kind 三态；WAL 行 payload 同构
#[test]
fn golden_d33_subagent_trace_and_run_history() {
    golden(
        &RuntimeToHost::SubagentTrace {
            session_id: "s".into(),
            sub_id: "r-9".into(),
            item: bbrt_protocol::SubagentTraceItem::ToolCall {
                call_id: "c1".into(),
                tool: "run_command".into(),
                args_masked: "{\"command\":\"cargo test\"}".into(),
                risk: bbrt_protocol::RiskLevel::High,
            },
        },
        json!({
            "type":"subagent.trace","sessionId":"s","subId":"r-9",
            "item":{
                "kind":"tool_call","callId":"c1","tool":"run_command",
                "argsMasked":"{\"command\":\"cargo test\"}","risk":"high"
            }
        }),
    );
    golden(
        &RuntimeToHost::SubagentTrace {
            session_id: "s".into(),
            sub_id: "r-9".into(),
            item: bbrt_protocol::SubagentTraceItem::ToolResult {
                call_id: "c1".into(),
                ok: true,
                summary: "12 passed".into(),
                duration_ms: 4200,
            },
        },
        json!({
            "type":"subagent.trace","sessionId":"s","subId":"r-9",
            "item":{"kind":"tool_result","callId":"c1","ok":true,"summary":"12 passed","durationMs":4200}
        }),
    );
    golden(
        &RuntimeToHost::SubagentTrace {
            session_id: "s".into(),
            sub_id: "r-9".into(),
            item: bbrt_protocol::SubagentTraceItem::Text {
                text: "已定位问题".into(),
            },
        },
        json!({
            "type":"subagent.trace","sessionId":"s","subId":"r-9",
            "item":{"kind":"text","text":"已定位问题"}
        }),
    );
    golden(
        &HostToRuntime::RunHistory { run_id: "r-9".into() },
        json!({"type":"run.history","runId":"r-9"}),
    );
    golden(
        &RuntimeToHost::RunHistoryResult {
            run_id: "r-9".into(),
            items: vec![bbrt_protocol::HistoryItem::Tool {
                call_id: "c1".into(),
                tool: "read_file".into(),
                ok: Some(true),
                summary: Some("42 行".into()),
                args: Some("{\"path\":\"a.rs\"}".into()),
            }],
        },
        json!({
            "type":"run.history.result","runId":"r-9",
            "items":[{"kind":"tool","callId":"c1","tool":"read_file","ok":true,"summary":"42 行","args":"{\"path\":\"a.rs\"}"}]
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
                "task":"修复登录超时并跑通测试","workspace":"~/code/bbc-server",
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
            session_id: "sess-1".into(),
            delegate_task_id: "dt-1".into(),
            kind: DelegateEventKind::ToolResult,
            payload: json!({"ok": true}),
        },
        json!({"type":"delegate.event","sessionId":"sess-1","delegateTaskId":"dt-1","kind":"tool_result","payload":{"ok":true}}),
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

// ---------------------------------------------------------------------------
// D15 §2.4/§3.3 协议增量：六个消息 + 三个 REQ 回执的逐字断言
// ---------------------------------------------------------------------------

#[test]
fn golden_d15_memory_messages() {
    // memory.saved：变体字段名 memory_type（内部 tag 模式不得与 tag 名 type 同名），线路名 memoryType
    golden(
        &RuntimeToHost::MemorySaved {
            session_id: "sess-1".into(),
            name: "gitee-remote".into(),
            title: "Gitee 远端".into(),
            memory_type: "knowledge".into(),
            updated: false,
            scope: None,
            workspace_name: None,
        },
        json!({
            "type":"memory.saved","sessionId":"sess-1","name":"gitee-remote",
            "title":"Gitee 远端","memoryType":"knowledge","updated":false
        }),
    );
    // memory.evicted：sessionId 可缺省（会话外 LRU 淘汰）
    golden(
        &RuntimeToHost::MemoryEvicted {
            session_id: None,
            name: "old-note".into(),
            reason: "capacity".into(),
        },
        json!({"type":"memory.evicted","name":"old-note","reason":"capacity"}),
    );
    golden(
        &RuntimeToHost::MemoryEvicted {
            session_id: Some("sess-1".into()),
            name: "old-note".into(),
            reason: "capacity".into(),
        },
        json!({"type":"memory.evicted","sessionId":"sess-1","name":"old-note","reason":"capacity"}),
    );
    // 宿主→RT 三个 REQ：limit 可缺省
    golden(
        &HostToRuntime::MemoryList {
            limit: Some(7),
            scope: None,
            workspace_path: None,
        },
        json!({"type":"memory.list","limit":7}),
    );
    golden(
        &HostToRuntime::MemoryList {
            limit: None,
            scope: None,
            workspace_path: None,
        },
        json!({"type":"memory.list"}),
    );
    golden(
        &HostToRuntime::MemoryDelete {
            scope: None,
            workspace_path: None,
            name: "gitee-remote".into(),
        },
        json!({"type":"memory.delete","name":"gitee-remote"}),
    );

    // 三个 REQ 回执：条目 wire 名逐字照 D15（type/updated_at 保留原样）
    golden(
        &RuntimeToHost::MemoryListResult {
            items: vec![MemoryListItem {
                name: "gitee-remote".into(),
                title: "Gitee 远端".into(),
                memory_type: "knowledge".into(),
                updated_at: 1_790_000_000_000,
                hook: "记住.*远端".into(),
                scope: None,
                workspace_name: None,
                // D23/M3：携带=公共层条目（删除走 memory.forget）
                global_type: Some("画像".into()),
            }],
        },
        json!({
            "type":"memory.list.result",
            "items":[{"name":"gitee-remote","title":"Gitee 远端","type":"knowledge",
                      "updated_at":1790000000000u64,"hook":"记住.*远端","globalType":"画像"}]
        }),
    );
    golden(
        &RuntimeToHost::MemoryDeleteResult { ok: true },
        json!({"type":"memory.delete.result","ok":true}),
    );
    golden(
        &RuntimeToHost::MemoryForgetResult {
            removed: vec!["用户叫小红".into()],
        },
        json!({"type":"memory.forget.result","removed":["用户叫小红"]}),
    );

    // 信封路径：memory.saved 打包后 payload 不含 type 键，unwrap 可原样还原
    let saved = RuntimeToHost::MemorySaved {
        session_id: "sess-1".into(),
        name: "gitee-remote".into(),
        title: "Gitee 远端".into(),
        memory_type: "knowledge".into(),
        updated: true,
        scope: None,
        workspace_name: None,
    };
    let env = Envelope::wrap(PROTOCOL_VERSION, "r-1", &saved).expect("wrap");
    assert_eq!(env.msg_type, "memory.saved");
    assert_eq!(
        env.payload,
        json!({"sessionId":"sess-1","name":"gitee-remote","title":"Gitee 远端",
               "memoryType":"knowledge","updated":true})
    );
    assert_eq!(env.unwrap::<RuntimeToHost>().expect("unwrap"), saved);
}

#[test]
fn golden_session_state_report_names() {
    // D11 §3 枚举线路名逐一核对（snake_case）
    let names = [
        ("starting", SessionState::Starting),
        ("idle", SessionState::Idle),
        ("running", SessionState::Running),
        ("waiting_permission", SessionState::WaitingPermission),
        ("waiting_clarify", SessionState::WaitingClarify),
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
            // SessionStateReport 是 RuntimeToHost 的变体（非独立 struct），线路形态即消息 JSON
            &RuntimeToHost::SessionStateReport {
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
    let res: Result<HostToRuntime, _> = serde_json::from_str(r#"{"type":"future.thing","x":1}"#);
    assert!(res.is_err());
    let res: Result<RuntimeToHost, _> = serde_json::from_str(r#"{"type":"another.future"}"#);
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
            model: None,
            skills: vec![],
            history_ref: None,
            backend_hint: None,
            title: None,
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
        workspace: "~/code/bbc".into(),
        mode: PermissionMode::Ask,
        model_policy: ModelPolicy::Auto,
        model: None,
        skills: vec![],
        history_ref: None,
        backend_hint: None,
        title: None,
    };
    let env = Envelope::wrap(PROTOCOL_VERSION, "h-1", &msg).expect("wrap");
    assert_eq!(env.msg_type, "session.start");
    assert_eq!(
        env.payload,
        json!({"sessionId":"sess-1","workspace":"~/code/bbc","mode":"ask","modelPolicy":"auto","skills":[]})
    );
    // 线路形态：type 在信封层、payload 嵌套，reply_to/ts 缺席
    assert_eq!(
        serde_json::to_value(&env).unwrap(),
        json!({
            "v":1,"id":"h-1","type":"session.start",
            "payload":{"sessionId":"sess-1","workspace":"~/code/bbc","mode":"ask","modelPolicy":"auto","skills":[]}
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
    let env: Envelope = serde_json::from_str(r#"{"v":1,"id":"h-7","type":"ping"}"#).unwrap();
    assert_eq!(env.payload, Value::Null);
    assert_eq!(env.unwrap::<HostToRuntime>().unwrap(), HostToRuntime::Ping);
}

#[test]
fn envelope_unwrap_payload_must_be_object() {
    let env: Envelope =
        serde_json::from_str(r#"{"v":1,"id":"h-7","type":"session.start","payload":[1,2]}"#)
            .unwrap();
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
    let env2 = Envelope::wrap(
        PROTOCOL_VERSION,
        "r-2",
        &RuntimeToHost::Error {
            code: 8010,
            message: "压缩后仍超限".into(),
            fatal: false,
            session_id: None,
        },
    )
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
    assert!(matches!(
        read_message(&mut cur),
        Err(CodecError::InvalidUtf8)
    ));
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

// ---------------------------------------------------------------------------
// D19 项目/日常双区协议增量：workspace 三 REQ + session.list + memory 作用域
// ---------------------------------------------------------------------------

#[test]
fn golden_d19_workspace_and_session_list_messages() {
    use bbrt_protocol::{SessionListItem, WorkspaceItem};

    let item = WorkspaceItem {
        id: "ws-1790000000-0".into(),
        path: "/Users/me/code/baobao-chat".into(),
        name: "baobao-chat".into(),
        is_repo: true,
        trusted: true,
        last_opened_at: 1_790_000_000_000,
        created_at: 1_780_000_000_000,
    };
    golden(
        &HostToRuntime::WorkspaceRegister {
            path: "/Users/me/code/baobao-chat".into(),
            name: None,
        },
        json!({"type":"workspace.register","path":"/Users/me/code/baobao-chat"}),
    );
    golden(
        &HostToRuntime::WorkspaceList,
        json!({"type":"workspace.list"}),
    );
    golden(
        &HostToRuntime::WorkspaceForget { id: "ws-1".into() },
        json!({"type":"workspace.forget","id":"ws-1"}),
    );
    golden(
        &HostToRuntime::SessionList { limit: Some(50) },
        json!({"type":"session.list","limit":50}),
    );
    golden(
        &RuntimeToHost::WorkspaceRegistered { item: item.clone() },
        json!({
            "type":"workspace.registered",
            "item":{"id":"ws-1790000000-0","path":"/Users/me/code/baobao-chat","name":"baobao-chat",
                    "isRepo":true,"trusted":true,"lastOpenedAt":1790000000000i64,"createdAt":1780000000000i64}
        }),
    );
    golden(
        &RuntimeToHost::WorkspaceListed { items: vec![item] },
        json!({
            "type":"workspace.listed",
            "items":[{"id":"ws-1790000000-0","path":"/Users/me/code/baobao-chat","name":"baobao-chat",
                      "isRepo":true,"trusted":true,"lastOpenedAt":1790000000000i64,"createdAt":1780000000000i64}]
        }),
    );
    golden(
        &RuntimeToHost::WorkspaceForgot { ok: true },
        json!({"type":"workspace.forgot","ok":true}),
    );
    golden(
        &RuntimeToHost::SessionListed {
            items: vec![SessionListItem {
                id: "sess-1".into(),
                title: "会话 1".into(),
                workspace: "/Users/me/code/baobao-chat".into(),
                mode: "ask".into(),
                model_policy: "auto".into(),
                model_override: None,
                status: "ended".into(),
                created_at: 1_780_000_000_000,
                updated_at: 1_790_000_000_000,
                ended_at: Some(1_790_000_000_500),
                summary: Some("收口".into()),
            }],
        },
        json!({
            "type":"session.listed",
            "items":[{"id":"sess-1","title":"会话 1","workspace":"/Users/me/code/baobao-chat",
                      "mode":"ask","modelPolicy":"auto","status":"ended",
                      "createdAt":1780000000000i64,"updatedAt":1790000000000i64,
                      "endedAt":1790000000500i64,"summary":"收口"}]
        }),
    );
}

#[test]
fn golden_session_history_messages() {
    // 2026-11-11 会话历史：工作台打开会话加载聊天记录（直读 WAL，跨端同会话）
    use bbrt_protocol::HistoryItem;

    golden(
        &HostToRuntime::SessionHistory {
            session_id: "sess-1".into(),
        },
        json!({"type":"session.history","sessionId":"sess-1"}),
    );
    golden(
        &RuntimeToHost::SessionHistoryResult {
            session_id: "sess-1".into(),
            items: vec![
                HistoryItem::User {
                    text: "修复登录超时".into(),
                    ts: Some(1_000),
                    turn_done_at: Some(8_000),
                },
                HistoryItem::Reasoning {
                    text: "先看超时阈值再查连接池".into(),
                },
                HistoryItem::Tool {
                    call_id: "c1".into(),
                    tool: "read_file".into(),
                    ok: Some(true),
                    summary: Some("42 行".into()),
                    args: None,
                },
                HistoryItem::Assistant {
                    text: "已修复".into(),
                },
            ],
        },
        json!({
            "type":"session.history.result",
            "sessionId":"sess-1",
            "items":[
                {"kind":"user","text":"修复登录超时","ts":1000,"turnDoneAt":8000},
                {"kind":"reasoning","text":"先看超时阈值再查连接池"},
                {"kind":"tool","callId":"c1","tool":"read_file","ok":true,"summary":"42 行"},
                {"kind":"assistant","text":"已修复"}
            ]
        }),
    );
    // 旧 WAL 降级行：tool 无 ok/summary（Option 缺席不序列化）
    golden(
        &HistoryItem::Tool {
            call_id: "c9".into(),
            tool: "bash".into(),
            ok: None,
            summary: None,
            args: None,
        },
        json!({"kind":"tool","callId":"c9","tool":"bash"}),
    );
}

#[test]
fn golden_user_message_thinking_levels() {
    // 2026-11-11 思考三档轮级契约：low/medium/high；缺省缺席=medium 兼容旧口径
    golden(
        &HostToRuntime::UserMessage {
            session_id: "sess-1".into(),
            text: "深挖这个问题".into(),
            attachments: vec![],
            slash: None,
            thinking: Some(ThinkingLevel::High),
        },
        json!({"type":"user.message","sessionId":"sess-1","text":"深挖这个问题",
               "attachments":[],"thinking":"high"}),
    );
    golden(
        &HostToRuntime::UserMessage {
            session_id: "sess-1".into(),
            text: "快速回答".into(),
            attachments: vec![],
            slash: None,
            thinking: Some(ThinkingLevel::Low),
        },
        json!({"type":"user.message","sessionId":"sess-1","text":"快速回答",
               "attachments":[],"thinking":"low"}),
    );
    // 旧格式（无 thinking 字段）反序列化 → None
    let m: HostToRuntime = serde_json::from_str(
        r#"{"type":"user.message","sessionId":"s","text":"t","attachments":[]}"#,
    )
    .unwrap();
    assert!(matches!(
        m,
        HostToRuntime::UserMessage { thinking: None, .. }
    ));
}

#[test]
fn golden_session_title_and_interrupt() {
    // 2026-11-11：session.start 带 title / session.rename / session.interrupt 双向契约
    golden(
        &HostToRuntime::SessionStart {
            session_id: "sess-1".into(),
            workspace: String::new(),
            mode: PermissionMode::Ask,
            model_policy: ModelPolicy::Auto,
            model: None,
            skills: vec![],
            history_ref: None,
            backend_hint: None,
            title: Some("与张三的对话".into()),
        },
        json!({
            "type":"session.start","sessionId":"sess-1","workspace":"","mode":"ask",
            "modelPolicy":"auto","skills":[],"title":"与张三的对话"
        }),
    );
    golden(
        &HostToRuntime::SessionInterrupt {
            session_id: "sess-1".into(),
        },
        json!({"type":"session.interrupt","sessionId":"sess-1"}),
    );
    golden(
        &HostToRuntime::SessionRename {
            session_id: "sess-1".into(),
            title: "修复登录超时".into(),
        },
        json!({"type":"session.rename","sessionId":"sess-1","title":"修复登录超时"}),
    );
    golden(
        &RuntimeToHost::SessionInterrupted {
            session_id: "sess-1".into(),
        },
        json!({"type":"session.interrupted","sessionId":"sess-1"}),
    );
    golden(
        &RuntimeToHost::SessionRenamed {
            session_id: "sess-1".into(),
            title: "修复登录超时".into(),
        },
        json!({"type":"session.renamed","sessionId":"sess-1","title":"修复登录超时"}),
    );
}

#[test]
fn golden_d19_memory_scope_fields() {
    // memory.list 带 scope=project + workspacePath；条目带 scope/workspaceName
    golden(
        &HostToRuntime::MemoryList {
            limit: None,
            scope: Some(MemoryScope::Project),
            workspace_path: Some("/Users/me/code/baobao-chat".into()),
        },
        json!({"type":"memory.list","scope":"project","workspacePath":"/Users/me/code/baobao-chat"}),
    );
    golden(
        &HostToRuntime::MemoryDelete {
            scope: Some(MemoryScope::Project),
            workspace_path: Some("/Users/me/code/baobao-chat".into()),
            name: "端口-8090".into(),
        },
        json!({"type":"memory.delete","scope":"project","workspacePath":"/Users/me/code/baobao-chat","name":"端口-8090"}),
    );
    // memory.saved 项目作用域
    golden(
        &RuntimeToHost::MemorySaved {
            session_id: "sess-1".into(),
            name: "端口-8090".into(),
            title: "端口 8090 约定".into(),
            memory_type: "project".into(),
            updated: false,
            scope: Some(MemoryScope::Project),
            workspace_name: Some("baobao-chat-72ab07a9e501bc35".into()),
        },
        json!({
            "type":"memory.saved","sessionId":"sess-1","name":"端口-8090",
            "title":"端口 8090 约定","memoryType":"project","updated":false,
            "scope":"project","workspaceName":"baobao-chat-72ab07a9e501bc35"
        }),
    );
}
