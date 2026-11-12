//! bin 桥接层：SessionEvent → stdio 协议消息映射 + 审批路由表。

use std::collections::HashMap;
use std::sync::Mutex;

use bbrt_protocol::{
    Blocked, CheckpointReason, CompactionPhase, Envelope, GrantScope, ModelPolicy,
    ModelSwitchReason, Preview, RiskLevel, RuntimeToHost, SessionState, StreamChannel, Usage,
};
use bbrt_session::events::SessionEvent;
use bbrt_session::SessionSink;

/// 事件出口：写协议信封 + 维护审批 request→session 路由表。
/// 写口用全局 std::io::stdout()（内部自锁、跨线程安全；不持有 !Send 的 StdoutLock）
pub struct BrtSink {
    /// request_id → session_id（permission.response 无会话字段，按表路由）
    pub pending: Mutex<HashMap<String, String>>,
    pub seq: Mutex<u64>,
}

impl BrtSink {
    pub fn route_of(&self, request_id: &str) -> Option<String> {
        self.pending.lock().unwrap().get(request_id).cloned()
    }
}

impl SessionSink for BrtSink {
    fn emit(&self, evt: SessionEvent) {
        // 审批路由登记
        if let SessionEvent::PermissionRequest {
            ref request_id,
            ref session_id,
            ..
        } = evt
        {
            self.pending
                .lock()
                .unwrap()
                .insert(request_id.clone(), session_id.clone());
        }
        // 澄清路由登记（D20：clarify.response 同样无会话字段，按表路由）
        if let SessionEvent::ClarifyRequest {
            ref question_id,
            ref session_id,
            ..
        } = evt
        {
            self.pending
                .lock()
                .unwrap()
                .insert(question_id.clone(), session_id.clone());
        }
        let Some(msg) = map_event(&evt) else { return };
        let id = {
            let mut n = self.seq.lock().unwrap();
            *n += 1;
            format!("r-evt-{n}")
        };
        if let Ok(env) = Envelope::wrap(1, id, &msg) {
            let mut out = std::io::stdout();
            let _ = bbrt_protocol::codec::write_message(&mut out, &env);
            use std::io::Write as _;
            let _ = out.flush();
        }
    }
}

fn risk(s: &str) -> RiskLevel {
    match s {
        "low" => RiskLevel::Low,
        "medium" => RiskLevel::Medium,
        _ => RiskLevel::High,
    }
}

/// SessionEvent → RuntimeToHost（未映射的事件返回 None 静默）
pub fn map_event(evt: &SessionEvent) -> Option<RuntimeToHost> {
    Some(match evt {
        SessionEvent::CheckpointCreated {
            session_id,
            checkpoint_id,
            files_changed,
            reason,
            git_ref,
        } => RuntimeToHost::CheckpointCreated {
            session_id: session_id.clone(),
            checkpoint_id: checkpoint_id.clone(),
            files_changed: files_changed.clone(),
            reason: match reason.as_str() {
                "pre-edit" => CheckpointReason::PreEdit,
                "pre-command" => CheckpointReason::PreCommand,
                "delegate" => CheckpointReason::Delegate,
                "pre-restore" => CheckpointReason::PreRestore,
                _ => CheckpointReason::Manual,
            },
            git_ref: git_ref.clone(),
        },
        SessionEvent::SubagentSpawned {
            session_id,
            sub_id,
            task_digest,
            tool_subset,
        } => RuntimeToHost::SubagentSpawn {
            session_id: session_id.clone(),
            sub_id: sub_id.clone(),
            task_digest: task_digest.clone(),
            tool_subset: tool_subset.clone(),
        },
        SessionEvent::SubagentProbeEvt {
            session_id,
            sub_id,
            phase,
            summary,
        } => RuntimeToHost::SubagentEvent {
            session_id: session_id.clone(),
            sub_id: sub_id.clone(),
            phase: match phase.as_str() {
                "spawn" => bbrt_protocol::SubagentPhase::Spawn,
                "delta" => bbrt_protocol::SubagentPhase::Delta,
                "fail" => bbrt_protocol::SubagentPhase::Fail,
                _ => bbrt_protocol::SubagentPhase::Done,
            },
            summary: summary.clone(),
        },
        SessionEvent::SubagentJoined {
            session_id,
            results,
        } => RuntimeToHost::SubagentJoin {
            session_id: session_id.clone(),
            results: results.clone(),
        },
        SessionEvent::SessionReady {
            session_id,
            restored,
            replayed_events,
        } => RuntimeToHost::SessionReady {
            session_id: session_id.clone(),
            restored: *restored,
            replayed_events: Some(*replayed_events),
            warnings: vec![],
        },
        SessionEvent::StateChanged {
            session_id,
            state,
            reason,
        } => RuntimeToHost::SessionStateReport {
            session_id: session_id.clone(),
            state: SessionState::parse(state)?,
            reason: reason.clone(),
        },
        SessionEvent::StreamDelta {
            session_id,
            delta,
            seq,
            channel,
        } => RuntimeToHost::StreamDelta {
            session_id: session_id.clone(),
            delta: delta.clone(),
            seq: *seq as u64,
            channel: match channel {
                bbrt_session::events::StreamChannel::Text => StreamChannel::Text,
                bbrt_session::events::StreamChannel::Reasoning => StreamChannel::Reasoning,
            },
        },
        SessionEvent::StreamDone {
            session_id,
            finish,
            usage_in,
            usage_out,
        } => RuntimeToHost::StreamDone {
            session_id: session_id.clone(),
            finish_reason: finish.clone(),
            usage: Usage {
                in_tokens: *usage_in,
                out_tokens: *usage_out,
            },
        },
        SessionEvent::ToolCall {
            session_id,
            call_id,
            tool,
            args_masked,
            risk: r,
        } => RuntimeToHost::ToolCall {
            call_id: call_id.clone(),
            session_id: session_id.clone(),
            tool: tool.clone(),
            args: serde_json::Value::String(args_masked.clone()),
            risk: risk(r),
            parallel: false,
            source: bbrt_protocol::ToolSource::Local,
        },
        SessionEvent::ToolResult {
            session_id,
            call_id,
            ok,
            summary,
            truncated,
            exit_code,
            duration_ms,
            blocked_code,
        } => RuntimeToHost::ToolResult {
            // 2026-11-12 补：同 permission.request——wire 无会话字段则宿主壳无法
            // 路由，前端工具行永停 running（真机「命令执行完圈圈不停」根因）
            session_id: session_id.clone(),
            call_id: call_id.clone(),
            ok: *ok,
            summary: summary.clone(),
            truncated: *truncated,
            exit_code: *exit_code,
            blocked: if let Some(code) = blocked_code {
                Some(Blocked {
                    rule: format!("sandbox-{code}"),
                    kind: "sandbox".into(),
                })
            } else if *ok {
                None
            } else {
                Some(Blocked {
                    rule: "denied".into(),
                    kind: "gate".into(),
                })
            },
            duration_ms: Some(*duration_ms),
        },
        SessionEvent::PermissionRequest {
            session_id,
            request_id,
            tool,
            risk: r,
            args_masked,
            reason,
            preview_kind,
            preview,
            options,
            ..
        } => {
            RuntimeToHost::PermissionRequest {
                // 2026-11-12：协议补会话字段——原「不带会话字段（D11 §4 原样）」导致
                // 宿主壳无法路由，真机审批弹框永不弹、120s 全超时（request_id 路由表
                // 仅服务下行应答，从未上行告知宿主）
                session_id: session_id.clone(),
                request_id: request_id.clone(),
                tool: tool.clone(),
                risk: risk(r),
                args: serde_json::Value::String(args_masked.clone()),
                reason: reason.clone(),
                preview: Some(match preview_kind.as_str() {
                    "diff" => Preview::Diff {
                        path: preview.clone(),
                    },
                    _ => Preview::Command {
                        command: preview.clone(),
                    },
                }),
                options: options
                    .iter()
                    .filter_map(|o| match o.as_str() {
                        "once" => Some(GrantScope::Once),
                        "session" => Some(GrantScope::Session),
                        "permanent" => Some(GrantScope::Permanent),
                        _ => None,
                    })
                    .collect(),
            }
        }
        SessionEvent::PermissionResolved { .. } => return None, // 镜像事件：宿主自己发的，不回显
        // D20 澄清：question_id 已进路由表（emit 处登记）；2026-11-12 协议补会话字段
        // （同 permission.request——无会话字段则宿主壳无法路由，提问卡永不弹）
        SessionEvent::ClarifyRequest {
            session_id,
            question_id,
            question,
            header,
            options_json,
            multi_select,
            ..
        } => {
            let options: Vec<bbrt_protocol::ClarifyOption> =
                serde_json::from_str(options_json).unwrap_or_default();
            RuntimeToHost::ClarifyRequest {
                session_id: session_id.clone(),
                question_id: question_id.clone(),
                question: question.clone(),
                header: header.clone(),
                options,
                multi_select: *multi_select,
            }
        }
        SessionEvent::ClarifyResolved { .. } => return None, // 镜像事件：宿主自己发的，不回显
        SessionEvent::Compaction {
            session_id,
            phase,
            freed_tokens,
            ..
        } => RuntimeToHost::CompactionEvent {
            session_id: session_id.clone(),
            phase: match phase.as_str() {
                "start" => CompactionPhase::Start,
                _ => CompactionPhase::Done,
            },
            freed_tokens: Some(*freed_tokens as u64),
            kept_rounds: Some(6),
        },
        SessionEvent::ModelSwitched {
            session_id,
            from,
            to,
            model_override,
            reason,
        } => RuntimeToHost::ModelSwitched {
            session_id: session_id.clone(),
            from: tier_policy(*from),
            to: tier_policy(*to),
            model: model_override.clone(),
            reason: match reason.as_str() {
                "user" => ModelSwitchReason::User,
                "downgrade" => ModelSwitchReason::Downgrade,
                _ => ModelSwitchReason::Auto,
            },
        },
        SessionEvent::SessionEnded {
            session_id,
            summary,
        } => RuntimeToHost::SessionEnded {
            session_id: session_id.clone(),
            summary: summary.clone(),
        },
        SessionEvent::MemorySaved {
            session_id,
            name,
            title,
            memory_type,
            updated,
            scope,
            workspace_name,
        } => RuntimeToHost::MemorySaved {
            session_id: session_id.clone(),
            name: name.clone(),
            title: title.clone(),
            memory_type: memory_type.clone(),
            updated: *updated,
            // D19 作用域透传（"project" → 枚举；user 省略=旧口径兼容）
            scope: scope.as_deref().map(|s| match s {
                "project" => bbrt_protocol::MemoryScope::Project,
                _ => bbrt_protocol::MemoryScope::User,
            }),
            workspace_name: workspace_name.clone(),
        },
        SessionEvent::MemoryEvicted {
            session_id,
            name,
            reason,
        } => RuntimeToHost::MemoryEvicted {
            session_id: Some(session_id.clone()),
            name: name.clone(),
            reason: reason.clone(),
        },
        SessionEvent::ReportDaily {
            date,
            path,
            sessions,
            tools,
            blocked,
            files_changed,
            memory_saved,
        } => RuntimeToHost::ReportDaily {
            date: date.clone(),
            path: path.clone(),
            stats: bbrt_protocol::DailyStatsLite {
                sessions: *sessions,
                tools: *tools,
                blocked: *blocked,
                files_changed: *files_changed,
                memory_saved: *memory_saved,
            },
        },
        SessionEvent::DelegateBrief {
            session_id,
            delegate_task_id,
            backend_suggestion,
        } => {
            let delegate_task_id = delegate_task_id.clone();
            // 简报原文在 WAL/上下文；协议侧发待确认信号（编辑稿经 delegate.launch 下发）
            RuntimeToHost::DelegateEvent {
                session_id: session_id.clone(),
                delegate_task_id,
                kind: bbrt_protocol::DelegateEventKind::Meta,
                payload: serde_json::json!({ "brief_pending": true, "backend_suggestion": backend_suggestion }),
            }
        }
        SessionEvent::DelegateEvt {
            session_id,
            delegate_task_id,
            kind,
            payload,
        } => {
            let delegate_task_id = delegate_task_id.clone();
            let k = match kind.as_str() {
                "delta" => bbrt_protocol::DelegateEventKind::Output,
                "tool_use" => bbrt_protocol::DelegateEventKind::ToolUse,
                "tool_result" => bbrt_protocol::DelegateEventKind::ToolResult,
                "warning" => bbrt_protocol::DelegateEventKind::Warning,
                _ => bbrt_protocol::DelegateEventKind::Meta,
            };
            RuntimeToHost::DelegateEvent {
                session_id: session_id.clone(),
                delegate_task_id,
                kind: k,
                payload: serde_json::from_str(payload.as_str())
                    .unwrap_or_else(|_| serde_json::Value::String(payload.clone())),
            }
        }
        SessionEvent::DelegateEnd {
            session_id,
            delegate_task_id,
            exit_code,
            summary,
            changed_files,
            checkpoint_id,
            child_session_ref,
        } => {
            let delegate_task_id = delegate_task_id.clone();
            // P0-2③ 修复：此前三字段置空上行——diff 审查卡（changed_files+
            // checkpoint_id 回滚锚点）与 --resume 续接句柄数据源恢复
            RuntimeToHost::DelegateEnd {
                session_id: session_id.clone(),
                delegate_task_id,
                exit_code: *exit_code,
                summary: summary.clone(),
                changed_files: changed_files.clone(),
                checkpoint_id: checkpoint_id.clone(),
                child_session_ref: child_session_ref.clone(),
            }
        }
        SessionEvent::DelegateReviewResolved {
            session_id,
            delegate_task_id,
            decision,
        } => {
            let delegate_task_id = delegate_task_id.clone();
            RuntimeToHost::DelegateEvent {
                session_id: session_id.clone(),
                delegate_task_id,
                kind: bbrt_protocol::DelegateEventKind::Meta,
                payload: serde_json::json!({ "review": decision }),
            }
        }
        SessionEvent::Error {
            session_id,
            code,
            message,
            fatal,
        } => RuntimeToHost::Error {
            code: *code,
            message: message.clone(),
            fatal: *fatal,
            session_id: Some(session_id.clone()),
        },
    })
}

fn tier_policy(t: bbrt_session::events::ModelTier) -> ModelPolicy {
    match t {
        bbrt_session::events::ModelTier::Fast => ModelPolicy::Fast,
        bbrt_session::events::ModelTier::Strong => ModelPolicy::Strong,
    }
}
