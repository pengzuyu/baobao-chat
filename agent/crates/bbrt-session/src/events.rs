//! 会话对外事件（SessionSink 回调载荷）。
//! 设计：D11 §4 全消息表的会话侧子集 + D15 记忆/日报事件；
//! 独立于 bbrt-protocol（bin/hostapi 装配时映射为 stdio 协议消息，
//! 依赖倒置使 session 可脱离协议层独立测试——对 D11 §1.2 依赖方向的
//! 唯一刻意偏差，登记于代码注释与提交说明）。
//! serde 规则：嵌套 struct 一律自带 rename_all="camelCase"（7698c52 教训）。

use serde::{Deserialize, Serialize};

/// 一轮流式输出的通道（D11 §4 stream.delta.channel）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamChannel {
    Text,
    Reasoning,
}

/// 模型档位（08 §4.3）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelTier {
    Fast,
    Strong,
}

/// 会话事件全集（camelCase；仅枚举变体名蛇形——tag 用 type）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// session.ready（D11 §4：初始化/重放完成）
    SessionReady {
        session_id: String,
        #[serde(rename = "restored")]
        restored: bool,
        replayed_events: u32,
    },
    /// session.state（状态机迁移，D11 §3）
    StateChanged {
        session_id: String,
        state: String,
        reason: String,
    },
    /// stream.delta
    StreamDelta {
        session_id: String,
        delta: String,
        seq: u32,
        #[serde(rename = "channel")]
        channel: StreamChannel,
    },
    /// stream.done
    StreamDone {
        session_id: String,
        finish: String, // stop | tool_calls | length
        usage_in: u64,
        usage_out: u64,
    },
    /// tool.call（参数已脱敏）
    ToolCall {
        session_id: String,
        call_id: String,
        tool: String,
        args_masked: String,
        risk: String, // low | medium | high
    },
    /// tool.result
    ToolResult {
        session_id: String,
        call_id: String,
        ok: bool,
        summary: String,
        truncated: bool,
        #[serde(rename = "exitCode", default)]
        exit_code: Option<i32>,
        duration_ms: u64,
        #[serde(rename = "blockedCode", default)]
        blocked_code: Option<u32>,
    },
    /// permission.request（D11 §4：120s 超时=拒绝）
    PermissionRequest {
        session_id: String,
        request_id: String,
        tool: String,
        risk: String,
        args_masked: String,
        reason: String,
        preview_kind: String, // command | diff | none
        preview: String,      // 命令文本/差异摘要（可编辑回传）
        /// 可选记忆档位（高危不出现 permanent）
        options: Vec<String>, // ["once","session","permanent"] 子集
    },
    /// permission.response 镜像（供 UI 回显）
    PermissionResolved {
        session_id: String,
        request_id: String,
        decision: String, // allow | deny | timeout
        scope: String,    // once | session | permanent
    },
    /// compaction.event
    Compaction {
        session_id: String,
        phase: String, // start | done
        freed_tokens: usize,
        degraded: bool, // 摘要失败退化为截断
    },
    /// model.switched（降档/用户切换）
    ModelSwitched {
        session_id: String,
        from: ModelTier,
        to: ModelTier,
        reason: String,
    },
    /// checkpoint.created（08 §4.4 修改前快照/手动/委派/恢复保护）
    CheckpointCreated {
        session_id: String,
        checkpoint_id: String,
        files_changed: Vec<bbrt_protocol::FileChange>,
        /// pre-edit | pre-command | manual | delegate | pre-restore
        reason: String,
        git_ref: Option<String>,
    },
    /// session.ended
    SessionEnded { session_id: String, summary: String },
    /// D15：记忆写入/更新
    MemorySaved {
        session_id: String,
        name: String,
        title: String,
        #[serde(rename = "memoryType")]
        memory_type: String,
        updated: bool,
    },
    /// D15：容量淘汰
    MemoryEvicted {
        session_id: String,
        name: String,
        reason: String,
    },
    /// D15：当日日报产出/重算
    ReportDaily {
        date: String,
        path: String,
        sessions: u32,
        tools: u32,
        blocked: u32,
        files_changed: u32,
        memory_saved: u32,
    },
    /// delegate.brief：简报待确认（等宿主 delegate.launch）
    DelegateBrief {
        session_id: String,
        delegate_task_id: String,
        backend_suggestion: String,
    },
    /// delegate.event：归一化委派事件
    DelegateEvt {
        session_id: String,
        delegate_task_id: String,
        kind: String, // meta|delta|tool_use|tool_result|warning|exit
        payload: String,
    },
    /// delegate.end：子进程退出（触发审查卡）
    DelegateEnd {
        session_id: String,
        delegate_task_id: String,
        exit_code: i32,
        summary: String,
    },
    /// 审查结论镜像（accept/reject/timeout）
    DelegateReviewResolved {
        session_id: String,
        delegate_task_id: String,
        decision: String,
    },

    /// error（协议级错误镜像；fatal=true 会话终止）
    Error {
        session_id: String,
        code: u32,
        message: String,
        fatal: bool,
    },
}

/// 事件出口（hostapi/bin 装配时实现；测试用收集器）
pub trait SessionSink: Send + Sync {
    fn emit(&self, evt: SessionEvent);
}

/// 丢弃全部事件（静默运行/部分测试）
pub struct NullSink;
impl SessionSink for NullSink {
    fn emit(&self, _evt: SessionEvent) {}
}
