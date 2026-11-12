//! stdio JSONL 协议消息与信封（D11 §2.1 / §4 全消息表，v1 共 44 个消息类型 = 38 + D15 追加 6）。
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

/// 澄清选项（clarify.request.options 项；D20）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClarifyOption {
    /// 选项短文案（回答回传此值）
    pub label: String,
    /// 补充说明（可选，UI 副行展示）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
    /// 恢复前保护快照（DDL CHECK 五值之一；随 checkpoint.restore 接线补齐协议枚举）
    PreRestore,
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
/// 线路契约 camel：嵌套 struct 的 rename_all 不随枚举变体传导，必须自带
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
// D15 记忆/日报协议增量（D15 §2.4/§3.3，追加进 D11 §4 全消息表）
// 嵌套 struct 一律自带 rename_all（rename_all 不随枚举变体传导，7698c52 教训）
// ---------------------------------------------------------------------------

/// 日报轻量统计（report.daily.stats 与 report.list 回执条目共用；D15 §3.3）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStatsLite {
    pub sessions: u32,
    pub tools: u32,
    pub blocked: u32,
    pub files_changed: u32,
    pub memory_saved: u32,
}

/// memory.list 回执条目（D15 §2.4：{name,title,type,updated_at,hook}）
/// wire 字段名逐字照 D15：type 与 updated_at 显式 rename 覆盖 camelCase
/// （嵌套 struct 无 tag 冲突，可以持有名为 type 的线路字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListItem {
    pub name: String,
    pub title: String,
    #[serde(rename = "type")]
    pub memory_type: String,
    #[serde(rename = "updated_at")]
    pub updated_at: u64,
    /// 召回触发特征（W2 启发式正则；无则为空串）
    pub hook: String,
    /// D19 作用域（缺省 user=旧口径兼容）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MemoryScope>,
    /// D19 项目分区名（scope=project 时携带；目录名-路径短哈希）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
}

/// report.list 回执条目（D15 §3.3：{date, stats}）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportListItem {
    /// YYYY-MM-DD
    pub date: String,
    pub stats: DailyStatsLite,
}

// ---------------------------------------------------------------------------
// D19 项目/日常双区协议增量（会话 workspace 空串=日常；项目登记/查询、
// 会话持久列表、记忆作用域。嵌套 struct 一律自带 rename_all——既有教训）
// ---------------------------------------------------------------------------

/// 知识记忆作用域（D19：user=用户级（缺省兼容旧口径）；project=项目级分区）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    User,
    Project,
}

/// 项目目录行（D19；agent_workspace 投影。path 为 realpath，业务身份锚点）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    /// ws-<ms>-<n>
    pub id: String,
    /// realpath（唯一）
    pub path: String,
    pub name: String,
    /// .git 探测结果
    pub is_repo: bool,
    /// 信任确认（D08 §4.4；D19 简化=目录选择动作即显式信任，注册恒 true）
    pub trusted: bool,
    pub last_opened_at: i64,
    pub created_at: i64,
}

/// 会话列表行（D19；agent_session JOIN agent_workspace。宿主重启后持久恢复数据源）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListItem {
    pub id: String,
    pub title: String,
    /// 工作目录（""=日常对话；未关联 workspace 的历史行同样为 ""）
    pub workspace: String,
    pub mode: String,
    /// fast | strong | auto
    pub model_policy: String,
    /// 会话级模型直达引用（p:<provider>:<model>；缺省=档位别名）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// 会话历史条目（session.history 回执；工作台打开会话加载聊天记录）。
/// WAL 摘要级投影：user 原文 / assistant 原文 / 工具名+结果摘要；
/// 审批·澄清卡是即时交互不入历史（WAL 不回放）。旧 WAL 行缺新字段时
/// assistant 旧轮无原文（跳过）、tool 无结果摘要（name-only 行）——渐进降级
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryItem {
    #[serde(rename = "user")]
    User { text: String },
    #[serde(rename = "assistant")]
    Assistant { text: String },
    #[serde(rename = "tool", rename_all = "camelCase")]
    // 变体级：enum 级 rename_all 只管变体名不管字段
    Tool {
        call_id: String,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ok: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
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
    WaitingClarify,
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
            SessionState::WaitingClarify => "waiting_clarify",
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
            "waiting_clarify" => Some(SessionState::WaitingClarify),
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

/// 思考强度三档（2026-11-11：zcode 同款 low/medium/high；轮级随 user.message）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingLevel {
    /// 不思考（直答）
    Low,
    /// 默认思考
    Medium,
    /// 深度思考（更大思考预算）
    High,
}

/// 宿主下发消息（15 个宿主→RT 类型 + D15 追加 3 类型 + 双向 ping/pong）
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
        /// 工作目录。D19：空串=日常对话（无目录——文件/命令/git/search/委派类工具
        /// 不可用、记忆恒用户作用域）；非空=项目会话（realpath 归一，自动 upsert
        /// agent_workspace 并回填 session.workspace_id，工具沙箱根=该目录）
        workspace: String,
        mode: PermissionMode,
        model_policy: ModelPolicy,
        /// 会话级模型直达引用（0023 多供应商）：p:<provider_id>:<model>；
        /// 缺省=走 model_policy 档位别名。仅主循环对话模型，内部辅助调用恒档位
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default)]
        skills: Vec<String>,
        /// 恢复指针：崩溃恢复时指向本地事件镜像
        #[serde(default, skip_serializing_if = "Option::is_none")]
        history_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        backend_hint: Option<String>,
        /// 初始标题（2026-11-11：IM embedded 会话创建即带来源名「与xxx的对话」；
        /// 缺省=库内默认「新会话」，由宿主在首条用户消息后经 session.rename 派生）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
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
        /// 思考强度（2026-11-11 三档，轮级生效）：low=不思考 / medium=默认 /
        /// high=思考+大预算；缺省=medium（旧口径兼容）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking: Option<ThinkingLevel>,
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

    /// 澄清回答回执（clarify.request 的下行应答；D20——ask_user 工具阻塞等待此消息）
    #[serde(rename = "clarify.response", rename_all = "camelCase")]
    ClarifyResponse {
        question_id: String,
        /// 所选选项 label（multi_select 多个）；「其他」自由输入只进 free_text
        #[serde(default)]
        answers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        free_text: Option<String>,
    },

    /// 手动建检查点（REQ→checkpoint.created）
    #[serde(rename = "checkpoint.create", rename_all = "camelCase")]
    CheckpointCreate {
        session_id: String,
        /// 手动创建，当前固定 "manual"
        reason: String,
    },

    /// 恢复检查点（REQ→checkpoint.restored {ok,newCheckpointId}；恢复前自动建 pre-restore 保护快照）
    #[serde(rename = "checkpoint.restore", rename_all = "camelCase")]
    CheckpointRestore { checkpoint_id: String },

    /// 确认委派启动（REQ→回执{pid}；同上）
    #[serde(rename = "delegate.launch", rename_all = "camelCase")]
    DelegateLaunch {
        session_id: String,
        delegate_task_id: String,
        backend: String,
        /// 用户编辑后的简报；None=沿用模型产出原稿（D16 客户端接线：
        /// 确认不改稿是主路径，编辑稿随 P1 简报编辑器）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_brief: Option<TaskBrief>,
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

    /// 模型档位切换（D11 §4 model.switched 产生方；回执经 model.switched 事件，
    /// 非 REQ→RES——切换结果事件化与 14 篇推送语义一致）
    #[serde(rename = "model.switch", rename_all = "camelCase")]
    ModelSwitch {
        /// 目标会话（None=全部活跃会话）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        to: ModelPolicy,
        /// 直达引用（0023）：非空=切到 p:<id>:<model>（to 为名义档位）；
        /// 显式 null/缺省=清除 override 回 to 档位
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },

    /// 委派审查结论（17 §8 确认侧）
    #[serde(rename = "delegate.review", rename_all = "camelCase")]
    DelegateReview {
        delegate_task_id: String,
        decision: ReviewDecision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rejected_hunks: Option<Vec<String>>,
    },

    /// run 清单查询（D16 §3.1：REQ→runs.list.result；session_id 缺省=全部会话）
    #[serde(rename = "runs.list", rename_all = "camelCase")]
    RunsList {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },

    /// 中断当前轮（2026-11-11 取代旧 session.pause/resume 用户操作通道——暂停/恢复
    /// 按钮已随「停止=中断当前轮、会话保留」口径移除；RT 内部自动暂停触发不受影响）。
    /// 语义：置中断旗标，LLM 流内/工具间检查点立即断，收口报 idle（可继续追问）
    #[serde(rename = "session.interrupt", rename_all = "camelCase")]
    SessionInterrupt { session_id: String },

    /// 会话重命名（REQ→session.renamed；标题派生/手动改名统一通道）
    #[serde(rename = "session.rename", rename_all = "camelCase")]
    SessionRename { session_id: String, title: String },

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

    // -- D15 §2.4/§3.3 追加（REQ；成对回执见 RuntimeToHost 的 *.result 变体） --
    /// 记忆列表查询（D15 §2.4；REQ→memory.list.result）
    #[serde(rename = "memory.list", rename_all = "camelCase")]
    MemoryList {
        /// 条数上限（D15 标注 limit?，可缺省）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
        /// D19 作用域过滤（缺省=全部两域）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<MemoryScope>,
        /// D19 项目路径过滤（realpath 精确匹配；scope=project 时可选）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_path: Option<String>,
    },

    /// 记忆删除（D15 §2.4；REQ→memory.delete.result{ok}）
    #[serde(rename = "memory.delete", rename_all = "camelCase")]
    MemoryDelete {
        name: String,
        /// D19 作用域（缺省 user=旧口径兼容）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<MemoryScope>,
        /// D19 项目路径（scope=project 时定位分区）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_path: Option<String>,
    },

    /// 日报列表查询（D15 §3.3；REQ→report.list.result）
    #[serde(rename = "report.list", rename_all = "camelCase")]
    ReportList {
        /// 条数上限（同 memory.list，可缺省）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
    },

    // -- D19 项目/日常双区追加（REQ；成对回执见 RuntimeToHost） --
    /// 项目目录登记（D19；REQ→workspace.registered。realpath 归一 upsert：
    /// 同目录重复打开不换身份；name 缺省=目录名；is_repo 由 .git 探测）
    #[serde(rename = "workspace.register", rename_all = "camelCase")]
    WorkspaceRegister {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },

    /// 项目列表（D19；REQ→workspace.listed；last_opened_at 倒序）
    #[serde(rename = "workspace.list", rename_all = "camelCase")]
    WorkspaceList,

    /// 项目移除登记（D19；REQ→workspace.forgot{ok}；只删登记行，不动会话/记忆分区）
    #[serde(rename = "workspace.forget", rename_all = "camelCase")]
    WorkspaceForget { id: String },

    /// 会话历史查询（REQ→session.history.result；工作台打开会话加载聊天记录。
    /// 直读 agent_event WAL——会话不须在运行态，历史/结束会话同样可查）
    #[serde(rename = "session.history", rename_all = "camelCase")]
    SessionHistory { session_id: String },

    /// 会话持久列表（D19；REQ→session.listed。agent_session JOIN agent_workspace，
    /// 宿主重启后恢复会话列表的数据源；活跃状态以宿主缓存叠加为准）
    #[serde(rename = "session.list", rename_all = "camelCase")]
    SessionList {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
    },
}

// ---------------------------------------------------------------------------
// Runtime → Host 消息（D11 §4 表"RT→宿主"全部 + 双向 ping/pong）
// ---------------------------------------------------------------------------

/// Runtime 上行消息（21 个 RT→宿主类型 + D15 追加 6 类型 + 双向 ping/pong）
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
        /// 发起会话（2026-11-12 补：与 permission.request 同因——wire 无会话字段
        /// 则宿主壳无法路由，前端工具行永停 running（圈圈不停）；缺省空串兼容旧宿主）
        #[serde(default, skip_serializing_if = "String::is_empty")]
        session_id: String,
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
        /// 发起会话（2026-11-12 补：wire 原不带会话字段，宿主壳无从路由 → 审批
        /// 弹框在真机链路永不弹、120s 全超时；缺省空串兼容旧宿主/旧 golden）
        #[serde(default, skip_serializing_if = "String::is_empty")]
        session_id: String,
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

    /// 澄清提问（UNT；等待下行 clarify.response，**不超时**——用户可随时答，
    /// 会话「停止」可中断收口 cancelled。D20 ask_user 工具触发）
    #[serde(rename = "clarify.request", rename_all = "camelCase")]
    ClarifyRequest {
        /// 发起会话（2026-11-12 补：与 permission.request 同因——wire 无会话字段
        /// 则宿主壳无法路由到会话流，提问卡永不弹；缺省空串兼容旧宿主）
        #[serde(default, skip_serializing_if = "String::is_empty")]
        session_id: String,
        question_id: String,
        /// 完整问题文本
        question: String,
        /// 短标签（≤12 字，UI chip 展示）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        options: Vec<ClarifyOption>,
        /// true=可多选；false/缺省=单选
        #[serde(default)]
        multi_select: bool,
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

    /// 检查点恢复回执（checkpoint.restore REQ；newCheckpointId=自动创建的 pre-restore 保护快照）
    #[serde(rename = "checkpoint.restored", rename_all = "camelCase")]
    CheckpointRestored {
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_checkpoint_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
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
        /// 切换后的直达引用（0023；None=档位别名模式）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
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

    /// 子 Agent 事件（UNT；session_id 由 bin bridge 补挂——变体本身可选，
    /// 兼容 bbrt-delegate 侧无会话上下文的构造）
    #[serde(rename = "subagent.event", rename_all = "camelCase")]
    SubagentEvent {
        #[serde(default)]
        session_id: String,
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

    /// 委派归一化事件（UNT；§8.3 映射表产物；session_id 由 bin bridge 补挂）
    #[serde(rename = "delegate.event", rename_all = "camelCase")]
    DelegateEvent {
        #[serde(default)]
        session_id: String,
        delegate_task_id: String,
        kind: DelegateEventKind,
        payload: Value,
    },

    /// 委派子进程退出（UNT；触发 diff 审查卡）
    #[serde(rename = "delegate.end", rename_all = "camelCase")]
    DelegateEnd {
        #[serde(default)]
        session_id: String,
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
    SessionEnded { session_id: String, summary: String },

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

    // -- D15 §2.4/§3.3 追加（UNT 事件 + REQ 成对回执） --
    /// 记忆写入/更新（D15 §2.4；UNT）
    /// 字段名 memory_type：内部 tag 模式下变体字段不得与 tag 名 type 同名（D15 实现既有约定），
    /// 线路名即 memoryType，不与信封层 type 冲突。
    #[serde(rename = "memory.saved", rename_all = "camelCase")]
    MemorySaved {
        session_id: String,
        name: String,
        title: String,
        memory_type: String,
        /// true=同题更新既有条目；false=新建（D15 §2.2）
        updated: bool,
        /// D19 作用域（缺省 user=旧口径兼容）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<MemoryScope>,
        /// D19 项目分区名（scope=project 时携带）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_name: Option<String>,
    },

    /// 记忆淘汰（D15 §2.4；UNT；reason 目前取值 "capacity"）
    #[serde(rename = "memory.evicted", rename_all = "camelCase")]
    MemoryEvicted {
        /// LRU 淘汰可能发生在会话之外（启动索引重建），可缺省
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        name: String,
        reason: String,
    },

    /// 日报产出/更新（D15 §3.3；UNT；path 指向 UI 消费的 json 产物）
    #[serde(rename = "report.daily", rename_all = "camelCase")]
    ReportDaily {
        /// YYYY-MM-DD
        date: String,
        path: String,
        stats: DailyStatsLite,
    },

    /// memory.list 回执（D15 §2.4；回执 type 命名沿用 initialize→initialize.result 的 *.result 约定）
    #[serde(rename = "memory.list.result", rename_all = "camelCase")]
    MemoryListResult {
        #[serde(default)]
        items: Vec<MemoryListItem>,
    },

    /// memory.delete 回执（D15 §2.4）
    #[serde(rename = "memory.delete.result", rename_all = "camelCase")]
    MemoryDeleteResult { ok: bool },

    /// report.list 回执（D15 §3.3）
    #[serde(rename = "report.list.result", rename_all = "camelCase")]
    ReportListResult {
        #[serde(default)]
        items: Vec<ReportListItem>,
    },

    /// runs.list 回执（D16 §3.1：agent_run 行 camelCase 投影，字段全集）
    #[serde(rename = "runs.list.result", rename_all = "camelCase")]
    RunsListResult {
        #[serde(default)]
        items: Vec<Value>,
    },

    // -- D19 项目/日常双区回执 --
    /// workspace.register 回执（D19；登记/更新后的项目行）
    #[serde(rename = "workspace.registered", rename_all = "camelCase")]
    WorkspaceRegistered { item: WorkspaceItem },

    /// workspace.list 回执（D19；last_opened_at 倒序）
    #[serde(rename = "workspace.listed", rename_all = "camelCase")]
    WorkspaceListed { items: Vec<WorkspaceItem> },

    /// workspace.forget 回执（D19）
    #[serde(rename = "workspace.forgot", rename_all = "camelCase")]
    WorkspaceForgot { ok: bool },

    /// session.list 回执（D19；updated_at 倒序）
    #[serde(rename = "session.listed", rename_all = "camelCase")]
    SessionListed { items: Vec<SessionListItem> },

    /// session.interrupt 回执（2026-11-11；置旗即回，实际中断以 session.state 上行为准）
    #[serde(rename = "session.interrupted", rename_all = "camelCase")]
    SessionInterrupted { session_id: String },

    /// session.rename 回执（2026-11-11；落库后的最终标题）
    #[serde(rename = "session.renamed", rename_all = "camelCase")]
    SessionRenamed { session_id: String, title: String },

    /// session.history 回执（seq 升序；空=无历史或会话不存在）
    #[serde(rename = "session.history.result", rename_all = "camelCase")]
    SessionHistoryResult {
        session_id: String,
        #[serde(default)]
        items: Vec<HistoryItem>,
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
        let value =
            serde_json::to_value(message).map_err(|e| ProtocolError::Serialize(e.to_string()))?;
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
        serde_json::from_value(Value::Object(obj))
            .map_err(|e| ProtocolError::Deserialize(e.to_string()))
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
