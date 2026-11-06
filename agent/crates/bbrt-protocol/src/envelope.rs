//! stdio JSONL 协议消息与信封（D11 §2.1 / §4 全消息表，v1 共 38 个消息类型）。
//!
//! 落码约定：
//! - 消息枚举用 `#[serde(tag = "type")]` 判别：序列化形如 `{"type":"session.start", ...字段}`；
//!   `Envelope::wrap/unwrap` 负责把 `type` 提升到信封层、其余字段收进 `payload`，
//!   对齐 D11 §4 线路格式 `{"v":1,"id":"h-..","type":"..","ts":..,"payload":{..}}`。
//! - 前向兼容：不开 `deny_unknown_fields`（未知字段必须容忍）；未知消息 type 的
//!   "忽略+计数上报"决策属调用方（bbrt-hostapi），本 crate 只报反序列化错误。
//! - 可选字段一律 `Option`（缺席不序列化），集合字段带 `default` 容忍缺省。

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 协议当前版本（D11 §2.1 version.rs：PROTOCOL_VERSION=1；协商语义见 §10.2）
pub const PROTOCOL_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// 共享枚举（D11 §2.1 common.rs 对应；序列化名以 §4 payload 说明与 §11 DDL CHECK 为准）
// ---------------------------------------------------------------------------

/// 权限模式三档（09 篇；"ask"/"auto-edit"/"full-auto"）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Ask,
    AutoEdit,
    FullAuto,
}

/// 模型档位策略（"fast"/"strong"/"auto"）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelPolicy {
    Fast,
    Strong,
    Auto,
}

/// 工具风险级（TODO: 分级口径与 09 篇风险矩阵对齐）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

/// 三级权限记忆授权范围（09 §4.2）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantScope {
    Once,
    Session,
    Permanent,
}

/// 权限确认决定（permission.response）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
}

/// 委派审查结论（delegate.review）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewDecision {
    Accept,
    Reject,
}

/// 会话结束原因（session.end）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    Normal,
    Logout,
    Revoked,
}

/// 检查点触发原因（与 §11 agent_checkpoint.reason CHECK 一致）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointReason {
    PreEdit,
    PreCommand,
    Manual,
    Delegate,
}

/// 工具热重载原因（tools.reload：app/skill/policy）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolsReloadReason {
    App,
    Skill,
    Policy,
}

/// OBO 续签原因（obo.renew）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenewReason {
    Expiring,
    Insufficient,
}

/// 上下文压缩阶段（compaction.event）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompactionPhase {
    Start,
    Done,
}

/// 子 Agent 生命周期（subagent.event）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentPhase {
    Spawn,
    Delta,
    Done,
    Fail,
}

/// 委派归一化事件类别（delegate.event，D11 §8.3 映射表）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegateEventKind {
    Output,
    ToolUse,
    ToolResult,
    Warning,
    Meta,
}

/// 模型切档原因（model.switched：auto/user/降档）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSwitchReason {
    Auto,
    User,
    Downgrade,
}

/// 流式增量通道：D11 §4 原表为 text|reasoning，本实现按任务书增补 tool（委派终端流）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamChannel {
    Text,
    Reasoning,
    Tool,
}

/// tool.call 事件来源：self=本产品工具管线；backend=委派后端归一化（D11 §8.3）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolSource {
    #[serde(rename = "self")]
    Local,
    Backend,
}

// ---------------------------------------------------------------------------
// payload 复合结构
// ---------------------------------------------------------------------------

/// 一轮生成用量（stream.done.usage{in,out}；字段名 `in` 是保留字，用 rename 映射）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(rename = "in")]
    pub in_tokens: u64,
    #[serde(rename = "out")]
    pub out_tokens: u64,
}

/// 检查点改动文件（与 §11 agent_checkpoint.files_changed JSON [{path,add,del}] 一致）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub add: u64,
    pub del: u64,
}

/// 子 Agent 汇总结果（summary ≤2k tokens，不回传原文，D11 §7）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentResult {
    pub sub_id: String,
    pub ok: bool,
    pub summary: String,
}

/// 简报上下文条目（delegate.brief.brief.context[]）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefContextItem {
    pub source: String,
    pub excerpt: String,
}

/// 结构化任务简报（17 篇；forbidden 会转成子进程约束，D11 §2.6 brief.rs）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskBrief {
    pub task: String,
    pub workspace: String,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub context: Vec<BriefContextItem>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub forbidden: Vec<String>,
}

/// 工具被阻断信息（tool.result.blocked{rule,kind}；kind 见 §11 agent_sandbox_violation）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Blocked {
    pub rule: String,
    pub kind: String,
}

/// 权限确认预览（permission.request.preview{kind:command/diff/obo,...}）
/// TODO: diff/obo 的字段细节以 09 §6.1 审批卡设计为准
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Preview {
    Command { command: String },
    Diff { path: String },
    Obo { scopes: Vec<String> },
}

// ---------------------------------------------------------------------------
// 会话状态枚举（D11 §3 状态机，starting + 9 态）
// session.state 消息 payload 与 §11 agent_session.status 共用此枚举。
// 有意不加 #[non_exhaustive]：状态集合一旦变化，bbrt-session 状态机必须同步修改（编译期强制）。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Starting,
    Idle,
    Running,
    WaitingPermission,
    WaitingReview,
    SubagentFanout,
    Delegating,
    Paused,
    Error,
    Ended,
}

impl SessionState {
    /// 线路/DDL 名（与 serde 序列化结果一致）
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionState::Starting => "starting",
            SessionState::Idle => "idle",
            SessionState::Running => "running",
            SessionState::WaitingPermission => "waiting_permission",
            SessionState::WaitingReview => "waiting_review",
            SessionState::SubagentFanout => "subagent_fanout",
            SessionState::Delegating => "delegating",
            SessionState::Paused => "paused",
            SessionState::Error => "error",
            SessionState::Ended => "ended",
        }
    }

    /// 由线路/DDL 名解析（未知返回 None，调用方按需报 9001）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "starting" => Some(SessionState::Starting),
            "idle" => Some(SessionState::Idle),
            "running" => Some(SessionState::Running),
            "waiting_permission" => Some(SessionState::WaitingPermission),
            "waiting_review" => Some(SessionState::WaitingReview),
            "subagent_fanout" => Some(SessionState::SubagentFanout),
            "delegating" => Some(SessionState::Delegating),
            "paused" => Some(SessionState::Paused),
            "error" => Some(SessionState::Error),
            "ended" => Some(SessionState::Ended),
            _ => None,
        }
    }
}

impl fmt::Display for SessionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Host → Runtime 消息（D11 §4 表"宿主→RT"全部 + 双向 ping/pong）
// ---------------------------------------------------------------------------

/// 宿主下发消息（15 个宿主→RT 类型 + 双向 ping/pong）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive] // 前向兼容：新增变体不破坏下游匹配（D11 §2.1）
#[serde(tag = "type")]
pub enum HostToRuntime {
    /// 握手（REQ→initialize.result）
    #[serde(rename = "initialize", rename_all = "camelCase")]
    Initialize {
        protocol_version: u32,
        #[serde(default)]
        capabilities: Vec<String>,
        data_dir: String,
        /// 代理配置内容宿主侧自定义，可空（无代理场景）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proxy_config: Option<Value>,
    },

    /// 新建/恢复会话（REQ→session.ready）
    #[serde(rename = "session.start", rename_all = "camelCase")]
    SessionStart {
        session_id: String,
        workspace: String,
        mode: PermissionMode,
        model_policy: ModelPolicy,
        #[serde(default)]
        skills: Vec<String>,
        /// 恢复指针：崩溃恢复时指向本地事件镜像
        #[serde(default, skip_serializing_if = "Option::is_none")]
        history_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        backend_hint: Option<String>,
    },

    /// 用户输入（REQ，回执=接受入队）
    #[serde(rename = "user.message", rename_all = "camelCase")]
    UserMessage {
        session_id: String,
        text: String,
        /// TODO: 附件目前为引用字符串，结构随 09/10 篇细化
        #[serde(default)]
        attachments: Vec<String>,
        /// 斜杠指令（/strong 等）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slash: Option<String>,
    },

    /// 权限确认回执（permission.request 的下行应答）
    #[serde(rename = "permission.response", rename_all = "camelCase")]
    PermissionResponse {
        request_id: String,
        decision: Decision,
        scope: GrantScope,
        /// 用户改命令再执行
        #[serde(default, skip_serializing_if = "Option::is_none")]
        edited_args: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        accepted_hunks: Option<Vec<String>>,
    },

    /// 手动建检查点（REQ→checkpoint.created）
    #[serde(rename = "checkpoint.create", rename_all = "camelCase")]
    CheckpointCreate {
        session_id: String,
        /// 手动创建，当前固定 "manual"
        reason: String,
    },

    /// 恢复检查点（REQ→回执{ok,newSnapshotId}；回执消息类型 D11 未命名，见 README TODO）
    #[serde(rename = "checkpoint.restore", rename_all = "camelCase")]
    CheckpointRestore { checkpoint_id: String },

    /// 确认委派启动（REQ→回执{pid}；同上）
    #[serde(rename = "delegate.launch", rename_all = "camelCase")]
    DelegateLaunch {
        session_id: String,
        delegate_task_id: String,
        backend: String,
        /// 可被用户编辑后的简报
        task_brief: TaskBrief,
        mode: PermissionMode,
        workspace: String,
    },

    /// 委派追加指令（17 send_input）
    #[serde(rename = "delegate.input", rename_all = "camelCase")]
    DelegateInput {
        delegate_task_id: String,
        text: String,
    },

    /// 取消委派（graceful=true: SIGINT→3s→SIGKILL 进程组）
    #[serde(rename = "delegate.cancel", rename_all = "camelCase")]
    DelegateCancel {
        delegate_task_id: String,
        graceful: bool,
    },

    /// 委派审查结论（17 §8 确认侧）
    #[serde(rename = "delegate.review", rename_all = "camelCase")]
    DelegateReview {
        delegate_task_id: String,
        decision: ReviewDecision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rejected_hunks: Option<Vec<String>>,
    },

    /// 暂停会话
    #[serde(rename = "session.pause", rename_all = "camelCase")]
    SessionPause { session_id: String },

    /// 恢复会话
    #[serde(rename = "session.resume", rename_all = "camelCase")]
    SessionResume { session_id: String },

    /// 结束会话（任意态→ended）
    #[serde(rename = "session.end", rename_all = "camelCase")]
    SessionEnd {
        session_id: String,
        reason: EndReason,
    },

    /// OBO 令牌发放/续签（NTF；token 仅此通道，不过 WebView/不下发子进程）
    #[serde(rename = "obo.token", rename_all = "camelCase")]
    OboToken {
        token: String,
        exp: u64,
        #[serde(default)]
        scopes: Vec<String>,
    },

    /// 工具热重载（10 篇通道/策略变更）
    #[serde(rename = "tools.reload", rename_all = "camelCase")]
    ToolsReload { reason: ToolsReloadReason },

    /// 健康（REQ；宿主每 20s 发，5s 未回 pong 判不健康）
    #[serde(rename = "ping")]
    Ping,

    /// 健康（ping 应答；标注"双向"故两枚举都保留）
    #[serde(rename = "pong")]
    Pong,
}

// ---------------------------------------------------------------------------
// Runtime → Host 消息（D11 §4 表"RT→宿主"全部 + 双向 ping/pong）
// ---------------------------------------------------------------------------

/// Runtime 上行消息（21 个 RT→宿主类型 + 双向 ping/pong）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive] // 前向兼容：新增变体不破坏下游匹配（D11 §2.1）
#[serde(tag = "type")]
pub enum RuntimeToHost {
    /// 握手回执
    #[serde(rename = "initialize.result", rename_all = "camelCase")]
    InitializeResult {
        runtime_version: String,
        #[serde(default)]
        tools: Vec<String>,
        #[serde(default)]
        capabilities: Vec<String>,
    },

    /// 就绪信号（NTF；握手后、进入服务态前，宿主以此为可接收 session.start 的信号）
    #[serde(rename = "runtime.ready", rename_all = "camelCase")]
    RuntimeReady {
        runtime_version: String,
        active_sessions: u32,
        wal_healthy: bool,
    },

    /// 会话可用（=08 篇 session.started 的 D11 细化命名）
    #[serde(rename = "session.ready", rename_all = "camelCase")]
    SessionReady {
        session_id: String,
        restored: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replayed_events: Option<u32>,
        #[serde(default)]
        warnings: Vec<String>,
    },

    /// 流式增量（UNT；seq 会话内单调递增）
    #[serde(rename = "stream.delta", rename_all = "camelCase")]
    StreamDelta {
        session_id: String,
        delta: String,
        seq: u64,
        channel: StreamChannel,
    },

    /// 一轮生成结束（UNT）
    #[serde(rename = "stream.done", rename_all = "camelCase")]
    StreamDone {
        session_id: String,
        finish_reason: String,
        usage: Usage,
    },

    /// 工具调用展示（UNT；args 已脱敏，全文在 Runtime 内部）
    #[serde(rename = "tool.call", rename_all = "camelCase")]
    ToolCall {
        call_id: String,
        session_id: String,
        tool: String,
        args: Value,
        risk: RiskLevel,
        parallel: bool,
        source: ToolSource,
    },

    /// 工具结果摘要（UNT）
    #[serde(rename = "tool.result", rename_all = "camelCase")]
    ToolResult {
        call_id: String,
        ok: bool,
        summary: String,
        truncated: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blocked: Option<Blocked>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },

    /// 权限确认请求（UNT；等待下行 permission.response，120s 超时=拒绝）
    #[serde(rename = "permission.request", rename_all = "camelCase")]
    PermissionRequest {
        request_id: String,
        tool: String,
        risk: RiskLevel,
        args: Value,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preview: Option<Preview>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        options: Vec<GrantScope>,
    },

    /// 检查点已建（=08 篇 checkpoint.event 的 D11 细化命名）
    #[serde(rename = "checkpoint.created", rename_all = "camelCase")]
    CheckpointCreated {
        checkpoint_id: String,
        session_id: String,
        #[serde(default)]
        files_changed: Vec<FileChange>,
        reason: CheckpointReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
    },

    /// 上下文压缩通知（UNT；phase=start 时 freed/kept 为空）
    #[serde(rename = "compaction.event", rename_all = "camelCase")]
    CompactionEvent {
        session_id: String,
        phase: CompactionPhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        freed_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kept_rounds: Option<u32>,
    },

    /// 模型档位切换（UNT）
    #[serde(rename = "model.switched", rename_all = "camelCase")]
    ModelSwitched {
        session_id: String,
        from: ModelPolicy,
        to: ModelPolicy,
        reason: ModelSwitchReason,
    },

    /// 子 Agent 派生（UNT；并发 ≤3）
    #[serde(rename = "subagent.spawn", rename_all = "camelCase")]
    SubagentSpawn {
        session_id: String,
        sub_id: String,
        task_digest: String,
        #[serde(default)]
        tool_subset: Vec<String>,
    },

    /// 子 Agent 事件（UNT）
    #[serde(rename = "subagent.event", rename_all = "camelCase")]
    SubagentEvent {
        sub_id: String,
        phase: SubagentPhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },

    /// 子 Agent 汇总完成（UNT；失败子任务带 fail 标注）
    #[serde(rename = "subagent.join", rename_all = "camelCase")]
    SubagentJoin {
        session_id: String,
        #[serde(default)]
        results: Vec<SubagentResult>,
    },

    /// 简报待确认（UNT；等待 delegate.launch）
    #[serde(rename = "delegate.brief", rename_all = "camelCase")]
    DelegateBrief {
        session_id: String,
        brief: TaskBrief,
        backend_suggestion: String,
    },

    /// 委派归一化事件（UNT；§8.3 映射表产物）
    #[serde(rename = "delegate.event", rename_all = "camelCase")]
    DelegateEvent {
        delegate_task_id: String,
        kind: DelegateEventKind,
        payload: Value,
    },

    /// 委派子进程退出（UNT；触发 diff 审查卡）
    #[serde(rename = "delegate.end", rename_all = "camelCase")]
    DelegateEnd {
        delegate_task_id: String,
        exit_code: i32,
        summary: String,
        #[serde(default)]
        changed_files: Vec<String>,
        /// 与 §11 DDL nullable 对齐：非 git 工作区/异常退出时无检查点
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child_session_ref: Option<String>,
    },

    /// 状态迁移（UNT；state 为 D11 §3 枚举）
    #[serde(rename = "session.state", rename_all = "camelCase")]
    SessionStateReport {
        session_id: String,
        state: SessionState,
        reason: String,
    },

    /// 会话结束回执
    #[serde(rename = "session.ended", rename_all = "camelCase")]
    SessionEnded {
        session_id: String,
        summary: String,
    },

    /// 请求 OBO 续签（REQ；到期前 2min / scope 不足）
    #[serde(rename = "obo.renew", rename_all = "camelCase")]
    OboRenew {
        #[serde(default)]
        scopes: Vec<String>,
        reason: RenewReason,
    },

    /// 健康（标注"双向"故两枚举都保留）
    #[serde(rename = "ping")]
    Ping,

    /// 健康（ping 应答，RT 收 ping 立即回）
    #[serde(rename = "pong")]
    Pong,

    /// 协议级错误（NTF；fatal=true 时 Runtime 退出前 flush WAL）
    #[serde(rename = "error", rename_all = "camelCase")]
    Error {
        code: u32,
        message: String,
        fatal: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// 信封（D11 §4：{"v":1,"id":"h-..|r-..","reply_to":"..?","type":"..","ts":..,"payload":{..}}）
// ---------------------------------------------------------------------------

/// stdio JSONL 信封。id 前缀：h-=宿主、r-=Runtime；REQ 的成对结果用 reply_to 指回。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
    #[serde(rename = "type")]
    pub msg_type: String,
    /// ping/pong 等无字段消息可缺省 payload 键（反序列化为 Null）
    #[serde(default)]
    pub payload: Value,
}

impl Envelope {
    /// 把消息（tag="type" 判别枚举）打包进信封：type 提升到信封层，其余字段落入 payload。
    pub fn wrap<M: Serialize>(
        v: u32,
        id: impl Into<String>,
        message: &M,
    ) -> Result<Self, ProtocolError> {
        let value = serde_json::to_value(message).map_err(|e| ProtocolError::Serialize(e.to_string()))?;
        let mut map = match value {
            Value::Object(map) => map,
            _ => return Err(ProtocolError::PayloadNotObject),
        };
        let msg_type = match map.remove("type") {
            Some(Value::String(s)) => s,
            _ => return Err(ProtocolError::MissingTag),
        };
        Ok(Self {
            v,
            id: id.into(),
            reply_to: None,
            ts: None,
            msg_type,
            payload: Value::Object(map),
        })
    }

    /// 从信封还原消息：payload + 信封 type 重组为 tag 判别枚举。
    /// payload 中若已含 "type" 键会被信封 type 覆盖（信封才是权威）。
    pub fn unwrap<M: serde::de::DeserializeOwned>(&self) -> Result<M, ProtocolError> {
        let mut obj = match &self.payload {
            Value::Object(map) => map.clone(),
            Value::Null => Map::new(),
            _ => return Err(ProtocolError::PayloadNotObject),
        };
        obj.insert("type".to_string(), Value::String(self.msg_type.clone()));
        serde_json::from_value(Value::Object(obj)).map_err(|e| ProtocolError::Deserialize(e.to_string()))
    }

    /// 设置 reply_to（REQ 成对结果指向原请求 id）
    pub fn with_reply_to(mut self, reply_to: impl Into<String>) -> Self {
        self.reply_to = Some(reply_to.into());
        self
    }

    /// 设置 ts（unix 毫秒由调用方决定，本 crate 不取时钟）
    pub fn with_ts(mut self, ts: u64) -> Self {
        self.ts = Some(ts);
        self
    }
}

// ---------------------------------------------------------------------------
// 错误类型（实现 std::error::Error，经 thiserror 派生）
// ---------------------------------------------------------------------------

/// 信封与消息互转错误（未知消息 type 表现为 Deserialize，"忽略+计数"由调用方决策）
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("消息序列化失败: {0}")]
    Serialize(String),
    #[error("消息反序列化失败: {0}")]
    Deserialize(String),
    #[error("payload 不是 JSON 对象")]
    PayloadNotObject,
    #[error("消息缺少 type 判别字段")]
    MissingTag,
}
