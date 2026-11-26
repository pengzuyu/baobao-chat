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

/// 会话结束原因（session.end）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    Normal,
    Logout,
    Revoked,
}

/// 工具热重载原因（tools.reload：app/skill/policy/plugin）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolsReloadReason {
    App,
    Skill,
    Policy,
    /// 插件装卸/启禁（D22/L3：skills 重扫多根 + MCP 重配后）
    Plugin,
}

/// MCP server 装配 wire（mcp.config 载荷；D22 §5.3）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerWire {
    /// 命名空间段：工具全名 mcp.{name}.{tool}
    pub name: String,
    pub transport: McpTransportWire,
    /// 来源元数据（D26 OQ-3 同批自省面：list_plugins 工具据此回答
    /// "装了哪些插件"——corp/local/plugin/personal 四源标注）。
    /// Option 缺省=旧宿主 wire 零兼容负担
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<McpServerMetaWire>,
}

/// server 来源元数据 wire（list_plugins 自省面；宿主装配期填）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerMetaWire {
    /// 来源：corp（公司域网关）/ local（壳本地工具面）/ plugin / personal
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    /// 展示名（plugin.json name，缺省回落 plugin_id）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
    /// 插件 activeVersion（非插件源为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// 传输配置 wire（stdio 子进程 / 远程 HTTP；env 为 map 形态，Runtime 侧转 Vec 对）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum McpTransportWire {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::HashMap<String, String>,
    },
    Http {
        base_url: String,
        /// 自定义请求头（外部系统鉴权如 Private-Token；值中 `${BBC_USER_TOKEN}`
        /// 由 Runtime 调用层动态替换——token 15min 轮换不静态化；`${CONFIG:*}`
        /// 宿主装配时已替换。自定义 Authorization 覆盖自动 Bearer。D22 §6.1/L4）
        #[serde(default)]
        headers: std::collections::HashMap<String, String>,
        /// 统一身份声明（D38：`x-bbc-auth` 归一后的 wire 形态）——声明即由
        /// Runtime 按受众取 agent 票逐请求注入 Bearer；None=匿名调用不注入
        #[serde(default)]
        auth: Option<McpAuthWire>,
    },
}

/// 统一身份 wire（D38 §3.5）：type 固定 "obo"；audience 由宿主装配期显式填
/// （生态应用=该 server url、corp=bbc-corp），Runtime 不做任何推导；scope=
/// 可选权限收窄（缺省空=票按用户全量签，见宿主换票请求）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthWire {
    pub r#type: String,
    pub audience: String,
    #[serde(default)]
    pub scope: Vec<String>,
}

/// D38 保留逻辑受众（与服务端 platform/agentjwt 常量同值——内部端点收编单票制）
pub const AUD_CORP: &str = "bbc-corp";
pub const AUD_AIGW: &str = "bbc-aigw";

/// 单张 agent 票（obo.token 载荷元素；D38 §3.5——audience 为该票唯一预期消费方）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OboTokenEntry {
    pub audience: String,
    pub token: String,
    /// 过期时刻（unix 秒；宿主按 OBO_EXP_MARGIN 预留缓冲后交付）
    pub exp: u64,
    #[serde(default)]
    pub scopes: Vec<String>,
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

/// 子 Agent 过程条目（D33 §3.2 subagent.trace 的 item 三态：每模型轮整段文本 /
/// 工具发起（脱敏后）/ 工具落定）。WAL `subagent.trace` 行 payload 同构复用
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubagentTraceItem {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_call", rename_all = "camelCase")]
    ToolCall {
        call_id: String,
        tool: String,
        args_masked: String,
        risk: RiskLevel,
    },
    #[serde(rename = "tool_result", rename_all = "camelCase")]
    ToolResult {
        call_id: String,
        ok: bool,
        summary: String,
        duration_ms: u64,
    },
}

/// 模型切档原因（model.switched：auto/user/降档）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSwitchReason {
    Auto,
    User,
    Downgrade,
}

/// 流式增量通道（D11 §4：text|reasoning）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamChannel {
    Text,
    Reasoning,
}

/// tool.call 事件来源：self=本产品工具管线
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolSource {
    #[serde(rename = "self")]
    Local,
}

// ---------------------------------------------------------------------------
// payload 复合结构
// ---------------------------------------------------------------------------

/// 一轮生成用量（stream.done.usage{in,out}；字段名 `in` 是保留字，用 rename 映射）。
/// D36 增可选 cached_tokens/model：cached=上游缓存命中（未上报=None）；model=上游实际
/// 模型名（桌面端据此在本机上下文注册表解析上限，不落服务端）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(rename = "in")]
    pub in_tokens: u64,
    #[serde(rename = "out")]
    pub out_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
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

/// 工具被阻断信息（tool.result.blocked{rule,kind}；kind 见 §11 agent_sandbox_violation）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Blocked {
    pub rule: String,
    pub kind: String,
}

/// 权限确认预览（permission.request.preview{kind:command/diff/read/obo,...}）
/// TODO: diff/obo 的字段细节以 09 §6.1 审批卡设计为准
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Preview {
    Command {
        command: String,
    },
    Diff {
        path: String,
    },
    /// 文件读取审批（2026-11-26 读审批化）：sensitive=true=敏感文件红卡（仅本次）
    Read {
        path: String,
        sensitive: bool,
    },
    Obo {
        scopes: Vec<String>,
    },
}

// ---------------------------------------------------------------------------
// D15 记忆协议增量（D15 §2.4，追加进 D11 §4 全消息表）
// 嵌套 struct 一律自带 rename_all（rename_all 不随枚举变体传导，7698c52 教训）
// ---------------------------------------------------------------------------

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
    /// D23 公共层十类标签（画像/偏好/…；携带=该条在 USER.md 压实视图中，
    /// 删除走 memory.forget 而非 memory.delete）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_type: Option<String>,
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
    /// 会话级模型直达引用（p:<provider>:<model>；缺省=公司默认档 bbc-default——
    /// 2026-11-26 单档化：快/强档位与 model_policy 字段退役）
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
    #[serde(rename = "user", rename_all = "camelCase")]
    User {
        text: String,
        /// 回合起点毫秒（turn.start 行 created_at 投影；旧 WAL 行可缺 →
        /// 前端 ts=0 降级，折叠统计行不带冻结用时）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ts: Option<i64>,
        /// 回合收口时刻毫秒（turn.end 行 created_at 投影）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_done_at: Option<i64>,
        /// 本轮附件（user.text 行 attachments 投影；旧 WAL 行无此字段 → 空）
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<Attachment>,
    },
    #[serde(rename = "assistant")]
    Assistant { text: String },
    /// 思考全文（assistant.thinking WAL 行投影；与 stream.delta(reasoning)
    /// 同一词。D33 思考回放批次：纯聊天轮过程区不再重开即丢）
    #[serde(rename = "reasoning")]
    Reasoning { text: String },
    /// 回合错误（turn.error WAL 行投影：8011 模型不可用/流中断、8010 超限等——
    /// 重开回放保留错误卡，用户能看到 agent 为何没回复；旧 WAL 行无此类型）
    #[serde(rename = "error", rename_all = "camelCase")]
    Error {
        code: u32,
        message: String,
        fatal: bool,
    },
    #[serde(rename = "tool", rename_all = "camelCase")]
    // 变体级：enum 级 rename_all 只管变体名不管字段
    Tool {
        call_id: String,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ok: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        /// 脱敏后参数原文（D33 §3.4：工具卡历史回放保真——命令/路径/diff 重启
        /// 可见；旧 WAL 行无此字段 → None 降级 name-only）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<String>,
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
    SubagentFanout,
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
            SessionState::SubagentFanout => "subagent_fanout",
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
            "subagent_fanout" => Some(SessionState::SubagentFanout),
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

/// 用户消息附件类型（宿主按扩展名判定；runtime 复核后才决定是否走视觉）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    /// 图片（png/jpeg/gif/webp；支持视觉的模型以图像形式接收）
    Image,
    /// 普通文件（runtime 只把路径告诉模型，由模型自行 read_file）
    File,
}

/// 用户消息附件（2026-11-26）：本机文件**路径引用**——不复制、不内联字节
/// （协议单行上限 `MAX_LINE_BYTES` 255KB，内联图片走不通；由 runtime 自行读盘）。
/// 用户亲自附带的文件视为已授权读取（工作区外也不弹读审批）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// 本机绝对路径
    pub path: String,
    pub kind: AttachmentKind,
    /// 展示文件名（路径被改名后仍可读；缺省取 path 文件名）
    pub name: String,
    /// 字节数
    #[serde(default)]
    pub size: u64,
    /// MIME（图片 png/jpeg/gif/webp；普通文件可缺省）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
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
        /// 工作目录。D19：空串=日常/任务对话（2026-11-12 改口径：文件/命令类
        /// 工具可用，沙箱根=用户工作空间 ~/.baobaochat/workspace，记忆恒用户
        /// 作用域）；非空=项目会话（realpath 归一，自动 upsert
        /// agent_workspace 并回填 session.workspace_id，工具沙箱根=该目录）
        workspace: String,
        mode: PermissionMode,
        /// 会话级模型直达引用（0023 多供应商）：p:<provider_id>:<model>；
        /// 缺省=公司默认档 bbc-default（2026-11-26 单档化：model_policy 字段退役，
        /// 会话不再有档位——有引用走引用，没有走默认档）。仅主循环对话模型，
        /// 内部辅助调用恒走默认档
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default)]
        skills: Vec<String>,
        /// 恢复指针：崩溃恢复时指向本地事件镜像
        #[serde(default, skip_serializing_if = "Option::is_none")]
        history_ref: Option<String>,
        /// 初始标题（2026-11-11：IM embedded 会话创建即带来源名「与xxx的对话」；
        /// 缺省=库内默认「新会话」，由宿主在首条用户消息后经 session.rename 派生）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// D35 定时任务：无人值守执行——禁用 ask_user（工具面移除+分支防御）、
        /// SYSTEM_PROMPT 追加“不能提问、按合理默认继续”约束
        /// （审批等待窗口 approval_timeout_secs 已随“审批不超时”拍板退役，
        /// 2026-11-25；旧宿主多发该字段会被 serde 忽略，无兼容负担）
        #[serde(default, skip_serializing_if = "is_false")]
        unattended: bool,
        /// 会话场景来源（2026-11-23 三区块场景提示词）："embedded"=IM 私聊/群聊
        /// 唤起（SYSTEM_PROMPT 末尾注入聊天场景段，conv_id 常驻抗压缩）；
        /// "task"=任务区新建（不绑定单一项目段）。缺省时按 workspace 判定：
        /// 非空=项目会话（项目段），空=任务会话（兼容历史数据）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<String>,
        /// embedded 场景的来源聊天会话 ID（im_history 工具参数；仅 origin=embedded
        /// 有意义，随场景段注入 system prompt）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conv_id: Option<String>,
        /// embedded 场景的聊天类型："single"=私聊 / "group"=群聊（场景事实，
        /// 群聊=多人发言指代更模糊）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conv_type: Option<String>,
    },

    /// 用户输入（REQ，回执=接受入队）
    #[serde(rename = "user.message", rename_all = "camelCase")]
    UserMessage {
        session_id: String,
        text: String,
        /// 附件（本机路径引用，见 [`Attachment`]；空=无附件。2026-11-26 前为占位
        /// 字符串数组且 runtime 不消费）
        #[serde(default)]
        attachments: Vec<Attachment>,
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

    /// 取消后台 run（terminal 后台命令/探查/专家在跑任务统一入口；
    /// graceful=true 优雅取消——SIGINT→宽限→强杀由各执行体解释）
    #[serde(rename = "run.cancel", rename_all = "camelCase")]
    RunCancel {
        session_id: String,
        run_id: String,
        graceful: bool,
    },

    /// 会话模型切换（D11 §4 model.switched 产生方；回执经 model.switched 事件，
    /// 非 REQ→RES——切换结果事件化与 14 篇推送语义一致）
    #[serde(rename = "model.switch", rename_all = "camelCase")]
    ModelSwitch {
        /// 目标会话（None=全部活跃会话）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        /// 直达引用（0023）：非空=切到 p:<id>:<model>；
        /// null/缺省=清除 override 回公司默认档（2026-11-26 单档化：档位字段 to 退役）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
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

    /// 会话中途切权限模式（NTF 无成对回执；补旧协议缺口——此前宿主仅本地记录，
    /// runtime 恒用 session.start 时的模式，切档不生效）。即时生效：下一个工具
    /// 调用按新模式门控（升档 full-auto 的二次确认在宿主侧完成）
    #[serde(rename = "session.set_mode", rename_all = "camelCase")]
    SessionSetMode {
        session_id: String,
        mode: PermissionMode,
    },

    /// 会话重命名（REQ→session.renamed；标题派生/手动改名统一通道）
    #[serde(rename = "session.rename", rename_all = "camelCase")]
    SessionRename { session_id: String, title: String },

    /// 结束会话（任意态→ended）
    #[serde(rename = "session.end", rename_all = "camelCase")]
    SessionEnd {
        session_id: String,
        reason: EndReason,
    },

    /// 会话删除（2026-11-24 工作台需求；REQ→session.deleted）。回合进行中拒绝；
    /// 删除=运行态收口 + 持久层整体清除（agent_session 及事件 WAL/上下文/会话级
    /// 授权/审计索引/沙箱违规/run 子表 + 审计 JSONL 文件），不可恢复
    #[serde(rename = "session.delete", rename_all = "camelCase")]
    SessionDelete { session_id: String },

    /// agent 票发放/续签（NTF；D38 §3.5 票据代——全受众同批下发，齐进齐出；
    /// token 仅此通道，不过 WebView/不下发子进程）
    #[serde(rename = "obo.token", rename_all = "camelCase")]
    OboToken { tokens: Vec<OboTokenEntry> },

    /// 工具热重载（10 篇通道/策略变更）
    #[serde(rename = "tools.reload", rename_all = "camelCase")]
    ToolsReload { reason: ToolsReloadReason },

    /// MCP 装配动态下发（NTF；D22 §5.3/L3：插件安装/更新/启禁/卸载后宿主推
    /// **全量**装配——系统级（corp 等）+插件级两源合并、`${PLUGIN_ROOT}` 已
    /// 替换为版本目录绝对路径；Runtime 按名重配：保留未变连接/断开移除/
    /// 新增懒连。启动持久性=宿主每次 spawn ready 后重推一次）
    #[serde(rename = "mcp.config", rename_all = "camelCase")]
    McpConfig { servers: Vec<McpServerWire> },

    /// 个人 MCP server 连接测试（REQ→mcp.test.result；D26 §6：一次性连接即弃
    /// ——TLS/TOKEN 动态注入/懒连接全走生产代码路径，测的就是真实链路）
    #[serde(rename = "mcp.test", rename_all = "camelCase")]
    McpTest { server: McpServerWire },

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

    /// 公共层记忆移除（D23 §3.5/M3；REQ→memory.forget.result{removed[]}）：
    /// 条目粒度 tombstone——同类型文本包含 contains 的条目全部移除并回显清单
    #[serde(rename = "memory.forget", rename_all = "camelCase")]
    MemoryForget {
        /// 十类标签（画像/偏好/风格/习惯/禁止/授权/人际/术语/目标/教训）；
        /// 信封 type 已被 tag 占用，线路名沿用 memoryType（同 MemorySaved）
        memory_type: String,
        /// 匹配串
        contains: String,
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

    /// run 历史查询（REQ→run.history.result；D33 §3.3 子 agent 侧栏回放——
    /// agent_event 按 run_id 过滤投影：spawn→User / trace→Assistant·Tool）
    #[serde(rename = "run.history", rename_all = "camelCase")]
    RunHistory { run_id: String },

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

    /// 会话模型切换（UNT；2026-11-26 单档化：档位字段 from/to 退役——旧 WAL 行多出的
    /// from/to 按前向兼容口径忽略，回放不断裂）
    #[serde(rename = "model.switched", rename_all = "camelCase")]
    ModelSwitched {
        session_id: String,
        /// 切换后的直达引用（0023；None=公司默认档）
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

    /// 子 Agent 事件（UNT；session_id 由 bin bridge 补挂——变体本身可选）
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

    /// 子 Agent 过程明细（UNT；D33 §3.2：probe 每步文本/工具外发——宿主按
    /// sub_id 路由到侧栏 run 流，不进主时间线）
    #[serde(rename = "subagent.trace", rename_all = "camelCase")]
    SubagentTrace {
        #[serde(default)]
        session_id: String,
        sub_id: String,
        item: SubagentTraceItem,
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

    /// 请求 agent 票续签（REQ；D38 拍板 9 票据代——不带受众，整代全量重签）
    #[serde(rename = "obo.renew", rename_all = "camelCase")]
    OboRenew { reason: RenewReason },

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

    /// memory.list 回执（D15 §2.4；回执 type 命名沿用 initialize→initialize.result 的 *.result 约定）
    #[serde(rename = "memory.list.result", rename_all = "camelCase")]
    MemoryListResult {
        #[serde(default)]
        items: Vec<MemoryListItem>,
    },

    /// memory.delete 回执（D15 §2.4）
    #[serde(rename = "memory.delete.result", rename_all = "camelCase")]
    MemoryDeleteResult { ok: bool },

    /// memory.forget 回执（D23 §3.5/M3：公共层条目移除清单——UI 同步删除）
    #[serde(rename = "memory.forget.result", rename_all = "camelCase")]
    MemoryForgetResult {
        /// 被移除条目文本（0/1/N；同名误伤回显）
        #[serde(default)]
        removed: Vec<String>,
    },

    /// runs.list 回执（D16 §3.1：agent_run 行 camelCase 投影，字段全集）
    #[serde(rename = "runs.list.result", rename_all = "camelCase")]
    RunsListResult {
        #[serde(default)]
        items: Vec<Value>,
    },

    /// mcp.test 回执（D26 §6：ok=false 时 error 带原因；tools 为短名清单）
    #[serde(rename = "mcp.test.result", rename_all = "camelCase")]
    McpTestResult {
        name: String,
        ok: bool,
        #[serde(default)]
        tools: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
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

    /// session.delete 回执（会话不存在回 Error 8001、回合进行中回 8002）
    #[serde(rename = "session.deleted", rename_all = "camelCase")]
    SessionDeleted { session_id: String },

    /// session.history 回执（seq 升序；空=无历史或会话不存在）。
    /// D36：lastUsage=WAL 最后一条 assistant.done 的用量（重启后输入框状态条恢复；
    /// 旧会话/无记录=None）。
    #[serde(rename = "session.history.result", rename_all = "camelCase")]
    SessionHistoryResult {
        session_id: String,
        #[serde(default)]
        items: Vec<HistoryItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_usage: Option<Usage>,
    },

    /// run.history 回执（D33；空=run 不存在或无过程行）
    #[serde(rename = "run.history.result", rename_all = "camelCase")]
    RunHistoryResult {
        run_id: String,
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

/// serde skip_serializing_if 辅助：bool 为 false 时省略（D35 unattended 旧 golden 兼容）
fn is_false(b: &bool) -> bool {
    !*b
}
