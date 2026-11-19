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
        /// D36：上游缓存命中 tokens（None=未上报）
        cached_tokens: Option<u64>,
        /// D36：上游实际模型名（None=上游未回）
        model: Option<String>,
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
    /// clarify.request（D20 ask_user 工具触发；不超时，等用户或「停止」中断）
    ClarifyRequest {
        session_id: String,
        question_id: String,
        question: String,
        /// 短标签（≤12 字，UI chip）
        header: Option<String>,
        /// 选项 JSON：[{"label":"..","description":".."}]（description 可缺省）
        options_json: String,
        multi_select: bool,
    },
    /// clarify.response 镜像（供 UI 回显；decision: answered | cancelled）
    ClarifyResolved {
        session_id: String,
        question_id: String,
        decision: String,
        /// 所选 label 逗号拼接（回显用）
        answers: String,
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
        /// 切换后的直达引用（0023；None=档位别名模式）
        model_override: Option<String>,
        reason: String,
    },
    /// subagent.spawn（08 §4.5 探查子 Agent 派生）
    SubagentSpawned {
        session_id: String,
        sub_id: String,
        task_digest: String,
        tool_subset: Vec<String>,
    },
    /// subagent.event（探查生命周期；phase: spawn|delta|done|fail）
    SubagentProbeEvt {
        session_id: String,
        sub_id: String,
        phase: String,
        summary: Option<String>,
    },
    /// subagent.trace（D33 §3.2：probe 每步过程明细——每模型轮整段文本/工具
    /// 发起与落定；宿主按 sub_id 路由侧栏 run 流，不进主时间线）
    SubagentTrace {
        session_id: String,
        sub_id: String,
        item: bbrt_protocol::SubagentTraceItem,
    },
    /// subagent.join（join 汇总；失败子任务带 fail 标注）
    SubagentJoined {
        session_id: String,
        results: Vec<bbrt_protocol::SubagentResult>,
    },
    /// session.ended
    SessionEnded { session_id: String, summary: String },
    /// D15：记忆写入/更新（D19 增作用域两字段）
    MemorySaved {
        session_id: String,
        name: String,
        title: String,
        #[serde(rename = "memoryType")]
        memory_type: String,
        updated: bool,
        /// D19："user" | "project"（缺省 user）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        /// D19 项目分区名（scope=project 时）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_name: Option<String>,
    },
    /// D15：容量淘汰
    MemoryEvicted {
        session_id: String,
        name: String,
        reason: String,
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
