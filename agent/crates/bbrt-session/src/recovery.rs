//! 崩溃恢复（D11 §9.2 重放协议）：
//! 事件镜像（agent_event）顺序重放 → 重建状态终态与上下文时间线；
//! 未决工具调用视为失败回填；未决 permission.request 全部作废。
//!
//! 口径：WAL 双写里的 SQLite 侧是唯一重放源（JSONL 侧仅人读镜像，
//! D11 开放问题 6 已登记单写收敛方向）。

use bbrt_context::Round;
use bbrt_protocol::{HistoryItem, Usage};
use bbrt_store::{EventRow, Store};

use crate::events::SessionEvent;
use crate::state::{self, SessionState};

/// 重放产物
#[derive(Debug)]
pub struct ReplayReport {
    /// 会话不存在时 None
    pub found: bool,
    /// 重放事件条数（seq 连续性校验通过的事件）
    pub replayed_events: u32,
    /// seq 断裂/缺失行数（>0 视为损坏 → 8012 语义，调用方降级只读快照）
    pub broken: u32,
    /// 重建出的会话终态
    pub final_state: SessionState,
    /// 重建出的历史轮次（user/assistant/tool；工具事件仅以摘要重建）
    pub history: Vec<Round>,
    /// 未决工具调用（执行中断定失败，回填理由后由调用方入 history）
    pub in_flight_tools: Vec<InFlightTool>,
    /// 恢复期作废的未决审批 id
    pub void_permissions: Vec<String>,
    /// 恢复期置 interrupted 的子 Agent run 条数（D16 §3.2；会话无 run 恒 0）
    pub interrupted_runs: u32,
}

impl Default for ReplayReport {
    fn default() -> Self {
        Self {
            found: false,
            replayed_events: 0,
            broken: 0,
            final_state: SessionState::Idle,
            history: vec![],
            in_flight_tools: vec![],
            void_permissions: vec![],
            interrupted_runs: 0,
        }
    }
}

/// 执行中的工具调用（重放时遇 tool.call 后无配对 tool.result）
#[derive(Debug, Clone)]
pub struct InFlightTool {
    pub call_id: String,
    pub name: String,
}

/// 重放协议（D11 §9.2）：
/// 1) 完整性校验（seq 从 1 连续递增；断裂计数）
/// 2) 状态机重放（turn.start→running、stop/idle、permission.request→waiting、…）
/// 3) 上下文时间线重建（user.message 原文 / stream.done 的 usage / tool 摘要）
/// 4) 未决处理（in-flight 工具→失败回填；permission.request 无 response→作废）
pub fn recover(store: &Store, session_id: &str) -> ReplayReport {
    let mut report = ReplayReport::default();
    let Some(_row) = store.get_session(session_id).unwrap_or(None) else {
        return report;
    };
    report.found = true;
    report.final_state = SessionState::Idle;

    let events = store
        .events_after(session_id, 0, 10_000)
        .unwrap_or_default();
    // 惰性历史：user.message 记原文；tool.call/tool.result 记摘要；assistant 以
    // stream.done 落 presence（原文在 JSONL 镜像，摘要级重建即可续会话）
    let mut open_tools: Vec<InFlightTool> = vec![];
    let mut last_seq = 0i64;
    let mut in_turn = false;
    let mut pending_user: Option<String> = None;
    let mut pending_permission: Option<String> = None;

    for ev in events {
        // ① seq 连续性
        if ev.seq != last_seq + 1 {
            report.broken += 1;
            last_seq = ev.seq; // 断裂后继续重放（计数上报，不中断）
            continue;
        }
        last_seq = ev.seq;
        report.replayed_events += 1;

        // ②③ 状态与时间线（按 loop_runner 的 WAL 写入点对应）
        match ev.type_.as_str() {
            "session.start" => {
                report.final_state = SessionState::Idle;
            }
            "turn.start" => {
                in_turn = true;
                report.final_state = SessionState::Running;
            }
            "user.text" => {
                // payload: {"text":"..."}（loop_runner 写入契约）；解析失败退回裸 payload
                let text = serde_json::from_str::<serde_json::Value>(&ev.payload)
                    .ok()
                    .and_then(|v| v.get("text").and_then(|x| x.as_str()).map(str::to_string))
                    .unwrap_or_else(|| ev.payload.clone());
                pending_user = Some(text);
            }
            "assistant.done" => {
                // 一轮模型输出完成（含纯文本轮）：入 assistant 轮（摘要级）
                if in_turn {
                    if let Some(text) = pending_user.take() {
                        report.history.push(Round::User { content: text });
                    }
                    report.history.push(Round::Assistant {
                        content: String::new(),
                        tool_calls: vec![],
                    });
                }
            }
            "tool.call" => {
                // payload: {"call_id":"..","tool":".."}
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.payload) {
                    open_tools.push(InFlightTool {
                        call_id: v
                            .get("call_id")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        name: v
                            .get("tool")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    });
                }
                report.final_state = SessionState::Running;
            }
            "tool.result" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.payload) {
                    let call_id = v
                        .get("call_id")
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let idx = open_tools.iter().position(|t| t.call_id == call_id);
                    if let Some(i) = idx {
                        let tool = open_tools.remove(i);
                        report.history.push(Round::Tool {
                            call_id: tool.call_id,
                            name: tool.name,
                            summary: v
                                .get("summary")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                        });
                    }
                }
            }
            "permission.request" => {
                report.final_state = SessionState::WaitingPermission;
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.payload) {
                    pending_permission = Some(
                        v.get("request_id")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    );
                }
            }
            "permission.resolved" => {
                pending_permission = None;
                report.final_state = SessionState::Running;
            }
            // D20：崩溃时未决提问与审批同口径作废（重放只还原状态，不重挂提问卡）
            "clarify.request" => {
                report.final_state = SessionState::WaitingClarify;
            }
            "clarify.resolved" => {
                report.final_state = SessionState::Running;
            }
            "turn.end" => {
                in_turn = false;
                if let Some(text) = pending_user.take() {
                    report.history.push(Round::User { content: text });
                }
                report.final_state = SessionState::Idle;
            }
            "session.ended" => {
                report.final_state = SessionState::Ended;
            }
            _ => {}
        }
    }

    // ④ 未决处理
    report.in_flight_tools = open_tools;
    if let Some(pid) = pending_permission {
        report.void_permissions.push(pid);
    }
    // 中断的 turn：残留 pending_user 一并入历史（用户输入不丢）
    if in_turn {
        if let Some(text) = pending_user.take() {
            report.history.push(Round::User { content: text });
        }
        if matches!(
            report.final_state,
            SessionState::Running | SessionState::WaitingPermission | SessionState::WaitingClarify
        ) {
            report.final_state =
                state::pause(SessionState::Running).unwrap_or(SessionState::Paused);
        }
    }
    // ⑤ 子 Agent run 收口（D16 §3.2）：进程已死，running 态 run 一律置
    // interrupted（幂等；不做 run 级断点续跑——一次性语义，可重发）
    report.interrupted_runs = store.interrupt_running_runs(session_id).unwrap_or(0) as u32;
    report
}

/// 恢复后的 SessionReady 事件构造（bin 装配：session.start 带 historyRef 时）
pub fn ready_event(session_id: &str, report: &ReplayReport) -> SessionEvent {
    SessionEvent::SessionReady {
        session_id: session_id.to_string(),
        restored: report.found,
        replayed_events: report.replayed_events,
    }
}

/// WAL → 会话历史条目（session.history 回执投影，与 recover 同一数据源）。
/// user.text/assistant.done 落原文；tool.call+tool.result 按 call_id 配对
/// （ok/summary 旧行可缺 → name-only）。审批/澄清卡是即时交互不入历史。
/// turn.start/end 行的 created_at 配对盖 user 条目 ts/turnDoneAt——折叠统计行
/// 冻结用时回放还原；assistant.thinking → Reasoning（D33 思考回放批次）。
pub fn wal_history(events: &[EventRow]) -> Vec<HistoryItem> {
    let mut items: Vec<HistoryItem> = Vec::new();
    let mut turn_started_at: Option<i64> = None;
    for ev in events {
        let payload: serde_json::Value = match serde_json::from_str(&ev.payload) {
            Ok(v) => v,
            Err(_) => continue, // 坏行跳过（历史加载不因单行损坏整体失败）
        };
        let str_field = |key: &str| {
            payload
                .get(key)
                .and_then(|x| x.as_str())
                .map(str::to_string)
        };
        match ev.type_.as_str() {
            "turn.start" => turn_started_at = Some(ev.created_at),
            "user.text" => {
                if let Some(text) = str_field("text") {
                    items.push(HistoryItem::User {
                        text,
                        ts: turn_started_at,
                        turn_done_at: None,
                    });
                }
            }
            // 思考全文（D33 思考回放：置于 assistant.done 前，回放顺序=直播顺序）
            "assistant.thinking" => {
                if let Some(text) = str_field("text") {
                    if !text.is_empty() {
                        items.push(HistoryItem::Reasoning { text });
                    }
                }
            }
            // 旧 WAL 行无 text → 跳过（无法渲染的空 assistant 轮）
            "assistant.done" => {
                if let Some(text) = str_field("text") {
                    if !text.is_empty() {
                        items.push(HistoryItem::Assistant { text });
                    }
                }
            }
            "tool.call" => items.push(HistoryItem::Tool {
                call_id: str_field("call_id").unwrap_or_default(),
                tool: str_field("tool").unwrap_or_default(),
                ok: None,
                summary: None,
                // D33 §3.4：脱敏参数透传（旧 WAL 行无此字段 → None 降级）
                args: str_field("args"),
            }),
            "tool.result" => {
                let call_id = str_field("call_id").unwrap_or_default();
                // 从尾向找同 call_id 未配对的 tool 行（同 call_id 不会重复出现）
                if let Some(HistoryItem::Tool { ok, summary, .. }) =
                    items.iter_mut().rev().find(|it| matches!(it, HistoryItem::Tool { call_id: c, ok: None, .. } if *c == call_id))
                {
                    *ok = payload.get("ok").and_then(|x| x.as_bool());
                    *summary = str_field("summary");
                }
            }
            // 收口时刻回填最后一个 user 条目（与直播收口盖 turnDoneAt 同口径）
            "turn.end" => {
                if let Some(HistoryItem::User { turn_done_at, .. }) =
                    items.iter_mut().rev().find(|it| matches!(it, HistoryItem::User { .. }))
                {
                    *turn_done_at = Some(ev.created_at);
                }
            }
            _ => {}
        }
    }
    items
}

/// WAL → 最近一次模型调用用量（D36：session.history.lastUsage，重启后输入框状态条恢复）。
/// 数据源=倒序找最后一条带 usage_in 的 assistant.done（cached_tokens/model 旧行缺省=未知）。
pub fn wal_last_usage(events: &[EventRow]) -> Option<Usage> {
    for ev in events.iter().rev() {
        if ev.type_ != "assistant.done" {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&ev.payload) else {
            continue; // 坏行跳过（不影响历史加载）
        };
        let Some(in_tokens) = payload.get("usage_in").and_then(|x| x.as_u64()) else {
            continue; // 旧行缺 usage → 继续往前找
        };
        return Some(Usage {
            in_tokens,
            out_tokens: payload
                .get("usage_out")
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
            cached_tokens: payload.get("cached_tokens").and_then(|x| x.as_u64()),
            model: payload
                .get("model")
                .and_then(|x| x.as_str())
                .map(str::to_string),
        });
    }
    None
}

/// WAL → run 历史条目（D33 §3.3 run.history 回执投影，侧栏子 agent 过程回放）。
/// 数据源=events_by_run 过滤行：subagent.spawn→User
/// （payload.task 摘要——回放有任务种子）、
/// subagent.trace 的 text→Assistant / tool_call+tool_result 按 call_id 配对→Tool
/// （args=脱敏原文）。其余 run 行（input/cancel/join 等）
/// 忽略——侧栏只要过程流。
pub fn wal_run_history(events: &[EventRow]) -> Vec<HistoryItem> {
    let mut items: Vec<HistoryItem> = Vec::new();
    for ev in events {
        let payload: serde_json::Value = match serde_json::from_str(&ev.payload) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let str_field = |key: &str| {
            payload
                .get(key)
                .and_then(|x| x.as_str())
                .map(str::to_string)
        };
        match ev.type_.as_str() {
            "subagent.spawn" => {
                if let Some(task) = str_field("task") {
                    if !task.is_empty() && !items.iter().any(|it| matches!(it, HistoryItem::User { .. })) {
                        items.push(HistoryItem::User {
                            text: task,
                            // run 级行无 turn.start/end——侧栏回放不带冻结用时
                            ts: None,
                            turn_done_at: None,
                        });
                    }
                }
            }
            "subagent.trace" => {
                // payload=SubagentTraceItem 序列化（tag=kind、字段 camelCase——与 wire 同构）
                match payload.get("kind").and_then(|x| x.as_str()) {
                    Some("text") => {
                        let text = str_field("text").unwrap_or_default();
                        if !text.is_empty() {
                            items.push(HistoryItem::Assistant { text });
                        }
                    }
                    Some("tool_call") => items.push(HistoryItem::Tool {
                        call_id: str_field("callId").unwrap_or_default(),
                        tool: str_field("tool").unwrap_or_default(),
                        ok: None,
                        summary: None,
                        args: str_field("argsMasked"),
                    }),
                    Some("tool_result") => {
                        let call_id = str_field("callId").unwrap_or_default();
                        if let Some(HistoryItem::Tool { ok, summary, .. }) = items
                            .iter_mut()
                            .rev()
                            .find(|it| matches!(it, HistoryItem::Tool { call_id: c, ok: None, .. } if *c == call_id))
                        {
                            *ok = payload.get("ok").and_then(|x| x.as_bool());
                            *summary = str_field("summary");
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    items
}

#[cfg(test)]
mod history_tests {
    use super::*;

    /// run 回放投影：subagent.spawn 带 task → User 种子；
    /// 过程 subagent.trace tool_call/tool_result 配对 → Tool（args=脱敏原文）
    #[test]
    fn run_history_projects_spawn_seed_and_trace() {
        let events = vec![
            ev(1, "subagent.spawn", r#"{"run_id":"r-1","eta_hint_ms":1000,"task":"修复登录 bug"}"#),
            ev(2, "subagent.trace", r#"{"kind":"tool_call","callId":"t1","tool":"Bash","argsMasked":"{\"command\":\"cargo test\"}","risk":"low"}"#),
            ev(3, "subagent.trace", r#"{"kind":"tool_result","callId":"t1","ok":true,"summary":"51 passed","durationMs":1200}"#),
        ];
        let items = wal_run_history(&events);
        assert_eq!(items.len(), 2);
        match &items[0] {
            HistoryItem::User { text, .. } => assert_eq!(text, "修复登录 bug"),
            other => panic!("首条应为 User: {other:?}"),
        }
        match &items[1] {
            HistoryItem::Tool { tool, ok, args, .. } => {
                assert_eq!(tool, "Bash");
                assert_eq!(*ok, Some(true));
                assert!(args.as_deref().unwrap_or_default().contains("cargo test"));
            }
            other => panic!("次条应为 Tool: {other:?}"),
        }
    }

    fn ev(seq: i64, type_: &str, payload: &str) -> EventRow {
        ev_at(seq, 0, type_, payload)
    }

    fn ev_at(seq: i64, created_at: i64, type_: &str, payload: &str) -> EventRow {
        EventRow {
            id: seq,
            session_id: "sess-1".into(),
            seq,
            type_: type_.into(),
            payload: payload.into(),
            created_at,
            run_id: String::new(),
        }
    }

    #[test]
    fn wal_history_projects_roundtrip_items() {
        let events = vec![
            ev(1, "session.start", r#"{"workspace":""}"#),
            ev_at(2, 1_000, "turn.start", r#"{"text_len":6}"#),
            ev(3, "user.text", r#"{"text":"修复登录"}"#),
            ev(4, "tool.call", r#"{"call_id":"c1","tool":"read_file"}"#),
            ev(
                5,
                "tool.result",
                r#"{"call_id":"c1","ok":true,"summary":"42 行"}"#,
            ),
            ev(
                6,
                "assistant.done",
                r#"{"finish":"stop","usage_in":10,"usage_out":5,"text":"已修复"}"#,
            ),
            ev_at(
                7,
                8_000,
                "turn.end",
                r#"{"steps":1,"paused":false,"interrupted":false}"#,
            ),
        ];
        assert_eq!(
            wal_history(&events),
            vec![
                // turn.start/end 行 created_at 配对盖 ts/turnDoneAt（冻结用时还原）
                HistoryItem::User {
                    text: "修复登录".into(),
                    ts: Some(1_000),
                    turn_done_at: Some(8_000),
                },
                HistoryItem::Tool {
                    call_id: "c1".into(),
                    tool: "read_file".into(),
                    ok: Some(true),
                    summary: Some("42 行".into()),
                    args: None,
                },
                HistoryItem::Assistant {
                    text: "已修复".into()
                },
            ]
        );
    }

    /// D33 思考回放：assistant.thinking → Reasoning（置于正文前，回放顺序=
    /// 直播顺序）；空思考行跳过
    #[test]
    fn wal_history_projects_thinking() {
        let events = vec![
            ev_at(1, 1_000, "turn.start", r#"{"text_len":4}"#),
            ev(2, "user.text", r#"{"text":"查下日志"}"#),
            ev(3, "assistant.thinking", r#"{"text":"先 grep error 再看时间线"}"#),
            ev(
                4,
                "assistant.done",
                r#"{"finish":"stop","usage_in":9,"usage_out":3,"text":"结论如下"}"#,
            ),
            ev_at(5, 5_000, "turn.end", r#"{"steps":1,"paused":false,"interrupted":false}"#),
            // 空思考不落条目
            ev(6, "assistant.thinking", r#"{"text":""}"#),
        ];
        assert_eq!(
            wal_history(&events),
            vec![
                HistoryItem::User {
                    text: "查下日志".into(),
                    ts: Some(1_000),
                    turn_done_at: Some(5_000),
                },
                HistoryItem::Reasoning {
                    text: "先 grep error 再看时间线".into()
                },
                HistoryItem::Assistant {
                    text: "结论如下".into()
                },
            ]
        );
    }

    #[test]
    fn wal_history_degrades_gracefully_on_legacy_rows() {
        // 旧 WAL：assistant.done 无 text、tool.result 无 ok/summary → 跳过/name-only
        let events = vec![
            ev(1, "user.text", r#"{"text":"旧会话问题"}"#),
            ev(
                2,
                "assistant.done",
                r#"{"finish":"stop","usage_in":1,"usage_out":1}"#,
            ),
            ev(3, "tool.call", r#"{"call_id":"c9","tool":"bash"}"#),
            ev(4, "tool.result", r#"{"call_id":"c9"}"#),
            ev(
                5,
                "assistant.done",
                r#"{"finish":"stop","usage_in":1,"usage_out":1,"text":""}"#,
            ),
            ev(6, "not.a.type", "{bad json"),
        ];
        assert_eq!(
            wal_history(&events),
            vec![
                // 无 turn.start/end 行 → 时间戳降级 None（折叠行不带冻结用时）
                HistoryItem::User {
                    text: "旧会话问题".into(),
                    ts: None,
                    turn_done_at: None,
                },
                HistoryItem::Tool {
                    call_id: "c9".into(),
                    tool: "bash".into(),
                    ok: None,
                    summary: None,
                    args: None,
                },
            ]
        );
    }

    /// D33 §3.4：tool.call 行带 args（脱敏原文）→ HistoryItem.Tool.args 透传
    #[test]
    fn wal_history_passes_tool_args() {
        let events = vec![
            ev(1, "user.text", r#"{"text":"跑测试"}"#),
            ev(
                2,
                "tool.call",
                r#"{"call_id":"c2","tool":"run_command","args":"{\"command\":\"cargo test\"}"}"#,
            ),
            ev(
                3,
                "tool.result",
                r#"{"call_id":"c2","ok":true,"summary":"12 passed"}"#,
            ),
        ];
        assert_eq!(
            wal_history(&events),
            vec![
                HistoryItem::User {
                    text: "跑测试".into(),
                    ts: None,
                    turn_done_at: None,
                },
                HistoryItem::Tool {
                    call_id: "c2".into(),
                    tool: "run_command".into(),
                    ok: Some(true),
                    summary: Some("12 passed".into()),
                    args: Some("{\"command\":\"cargo test\"}".into()),
                },
            ]
        );
    }

    /// D33 §3.3：run 级行投影——spawn→User（task）、trace text→Assistant、
    /// tool_call+tool_result 按 call_id 配对→Tool（args=args_masked）；
    /// input/cancel 等其余 run 行忽略；重复 spawn 不重复 User
    #[test]
    fn wal_run_history_projects_trace_rows() {
        let events = vec![
            EventRow {
                id: 1,
                run_id: "r-9".into(),
                ..ev(11, "subagent.spawn", r#"{"run_id":"r-9","eta_hint_ms":0,"task":"定位超时来源"}"#)
            },
            EventRow {
                id: 2,
                run_id: "r-9".into(),
                ..ev(12, "subagent.trace", r#"{"kind":"tool_call","callId":"c1","tool":"read_file","argsMasked":"{\"path\":\"a.rs\"}","risk":"low"}"#)
            },
            EventRow {
                id: 3,
                run_id: "r-9".into(),
                ..ev(13, "subagent.trace", r#"{"kind":"tool_result","callId":"c1","ok":true,"summary":"42 行","durationMs":18}"#)
            },
            EventRow {
                id: 4,
                run_id: "r-9".into(),
                ..ev(14, "subagent.trace", r#"{"kind":"text","text":"已定位问题"}"#)
            },
            EventRow {
                id: 5,
                run_id: "r-9".into(),
                ..ev(15, "subagent.input", r#"{"run_id":"r-9","text":"补充"}"#)
            },
        ];
        assert_eq!(
            wal_run_history(&events),
            vec![
                HistoryItem::User {
                    text: "定位超时来源".into(),
                    ts: None,
                    turn_done_at: None,
                },
                HistoryItem::Tool {
                    call_id: "c1".into(),
                    tool: "read_file".into(),
                    ok: Some(true),
                    summary: Some("42 行".into()),
                    args: Some("{\"path\":\"a.rs\"}".into()),
                },
                HistoryItem::Assistant { text: "已定位问题".into() },
            ]
        );
    }

    /// D36：session.history.lastUsage 取最后一条带 usage_in 的 assistant.done；
    /// 旧行缺 cached_tokens/model → None 降级（不臆造 0）。
    #[test]
    fn last_usage_reads_latest_assistant_done() {
        let events = vec![
            ev(
                1,
                "assistant.done",
                r#"{"finish":"stop","usage_in":10,"usage_out":2,"text":"a"}"#,
            ),
            ev(2, "user.text", r#"{"text":"b"}"#),
            ev(
                3,
                "assistant.done",
                r#"{"finish":"stop","usage_in":1200,"usage_out":300,"cached_tokens":900,"model":"glm-4.6","text":"b"}"#,
            ),
        ];
        let usage = wal_last_usage(&events).expect("应有用量");
        assert_eq!(usage.in_tokens, 1200);
        assert_eq!(usage.out_tokens, 300);
        assert_eq!(usage.cached_tokens, Some(900));
        assert_eq!(usage.model.as_deref(), Some("glm-4.6"));

        let old = wal_last_usage(&events[..1]).expect("旧行也有 in/out");
        assert_eq!(old.in_tokens, 10);
        assert_eq!(old.cached_tokens, None);
        assert_eq!(old.model, None);
    }
}
