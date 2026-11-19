//! 专家 Agent 装配器（D14）：Persona Manifest 解析 + 装配过滤 + 受限子会话。
//!
//! 专家 = 带独立工具集/技能/MCP 绑定的**进程内受限子会话**（区别于探查
//! 子 Agent 的固定只读集）。本模块承担 D14 三段：
//! - §2 manifest 解析：声明式 YAML **受限子集**（固定 schema、未知键拒绝、
//!   flow 列表 `[...]`、persona `|` 块标量）——不引 yaml 依赖（skills.rs
//!   同取向），强校验契合供应链安全（§7"一切皆插件"不采纳的落点）
//! - §6.3 防线一（装配过滤）：manifest 声明 ∩ 运行时注册表 ∩ 租户策略 →
//!   超出部分剔除标灰（dropped 清单即详情页标灰数据源）；技能绑定 ∩
//!   SkillIndex 同理。knowledge 空间 ACL 在服务端 RLS（防线三）兜底，
//!   本地仅声明透传
//! - §3.2 受限子会话：独立上下文（persona system + 任务简报，无主历史）、
//!   manifest 步数/上下文预算、模型档位路由；审计流 `act=expert:{personaId}
//!   :{activationId}`（WAL expert.* 类型，协议事件复用 subagent.*——协议
//!   已冻结 18 篇，不新增变体）
//!
//! v0.1 边界：OBO scope 最小化（防线二）不在本模块——装配器是执行基元。
//! 单专家调用（D14 §3.3 精简形态）见本模块 `FastPicker`；协作图/会诊
//! （Team Graph）已随 team 域退役（2026-11-19）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use bbrt_aigw::{ChatClient, ChatRequest, ToolSpec};
use bbrt_context::{estimate_tokens, Round};

use crate::events::SessionEvent;
use crate::executor::{ToolExecutor, ToolInvocation, ToolOutcome};
use crate::skills::SkillIndex;
use crate::subagent::{clamp_summary, drain, messages_with, truncate_chars};
use bbrt_sec::gate::PermissionMode;

/// 单专家步数硬顶（§8-5：专家总步数 ≤120/图；单个默认 40、上限 120）
pub const EXPERT_MAX_STEPS_LIMIT: usize = 120;
/// 步数缺省（D14 §2 示例值）
pub const EXPERT_DEFAULT_MAX_STEPS: usize = 40;
/// 上下文预算缺省（32k）
pub const EXPERT_DEFAULT_CONTEXT_K: usize = 32;
/// 上下文预算下/上限（k）
pub const EXPERT_CONTEXT_K_MIN: usize = 8;
pub const EXPERT_CONTEXT_K_MAX: usize = 128;
/// 专家回传摘要上限（与探查一致：≤2k tokens，不回传原文）
pub const EXPERT_SUMMARY_TOKENS: usize = 2000;

// ---------------------------------------------------------------------------
// Manifest（D14 §2 声明式）
// ---------------------------------------------------------------------------

/// 工具白名单三类来源（§6.1 注册表口径：builtin 编译期 / apps+mcp 连接期）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManifestTools {
    /// 本地内置（文件/命令/git 类）
    pub builtin: Vec<String>,
    /// 生态应用工具（经 MCP 网关，`app_short.*`）
    pub apps: Vec<String>,
    /// MCP 网关/外部 server 工具（`mcp.{server}.{tool}`）
    pub mcp: Vec<String>,
}

/// 执行约束（§2 constraints）
#[derive(Debug, Clone, PartialEq)]
pub struct ExpertConstraints {
    /// 单次 Activation 步数上限（1..=120，缺省 40）
    pub max_steps: usize,
    /// 上下文预算（k tokens，8..=128，缺省 32）
    pub max_context_k: usize,
    /// readonly / checkpointed / none
    pub write_policy: String,
    /// 命令策略（AGENTS.md 白名单等；v0.1 引导性声明）
    pub command_policy: String,
}

impl Default for ExpertConstraints {
    fn default() -> Self {
        Self {
            max_steps: EXPERT_DEFAULT_MAX_STEPS,
            max_context_k: EXPERT_DEFAULT_CONTEXT_K,
            write_policy: "readonly".into(),
            command_policy: String::new(),
        }
    }
}

/// 专家定义包（声明式，不携带可执行代码）
#[derive(Debug, Clone, PartialEq)]
pub struct ExpertManifest {
    /// corp./dept. 公司级；usr.{userId}. 个人级；plugin.{plugin_id}.{name} 插件翻译（D22/L5）
    pub id: String,
    /// 一期仅 local（remote=外呼 A2A 二期预留，解析即拒）
    pub kind: String,
    pub version: String,
    pub display: String,
    pub icon: String,
    /// 人设与输出契约（system prompt 增量）
    pub persona: String,
    pub tools: ManifestTools,
    pub skills: Vec<String>,
    /// 知识空间绑定（ACL 服务端兜底，本地声明透传）
    pub knowledge_spaces: Vec<String>,
    pub constraints: ExpertConstraints,
    /// strong | fast（缺省 strong；映射 bbc-strong/bbc-fast，19 篇档位）
    pub model_tier: String,
    /// company | personal
    pub source: String,
    /// 公司级 ed25519 签名（个人级为空）
    pub signature: String,
}

/// 专家装配/解析错误
#[derive(Debug, thiserror::Error)]
pub enum ExpertError {
    /// YAML 受限子集语法/结构不符
    #[error("manifest 解析失败：{0}")]
    Parse(String),
    /// 语义校验不过（枚举/范围/前缀）
    #[error("manifest 非法：{0}")]
    Invalid(String),
}

// ---------------------------------------------------------------------------
// 解析（受限 YAML 子集：固定 schema + flow 列表 + persona 块标量）
// ---------------------------------------------------------------------------

/// 顶层键白名单（未知键拒绝——声明式强校验）
const TOP_KEYS: &[&str] = &[
    "id",
    "type",
    "version",
    "display",
    "icon",
    "persona",
    "tools",
    "skills",
    "knowledge",
    "constraints",
    "model",
    "source",
    "signature",
];

/// 解析 manifest 文本（D14 §2 格式）
pub fn parse_manifest(text: &str) -> Result<ExpertManifest, ExpertError> {
    let mut m = ExpertManifest {
        id: String::new(),
        kind: String::new(),
        version: String::new(),
        display: String::new(),
        icon: String::new(),
        persona: String::new(),
        tools: ManifestTools::default(),
        skills: vec![],
        knowledge_spaces: vec![],
        constraints: ExpertConstraints::default(),
        model_tier: String::new(),
        source: String::new(),
        signature: String::new(),
    };
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let (key, val) = split_kv(t).ok_or_else(|| ExpertError::Parse(format!("非法行：{t}")))?;
        if !TOP_KEYS.contains(&key.as_str()) {
            return Err(ExpertError::Parse(format!(
                "未知键：{key}（manifest 为封闭 schema）"
            )));
        }
        match key.as_str() {
            "persona" => {
                // persona: | → 缩进块标量（dedent 按块内首行缩进）
                if val.trim() != "|" {
                    return Err(ExpertError::Parse("persona 仅支持 | 块标量".into()));
                }
                m.persona = take_block(&mut lines);
            }
            "tools" => {
                expect_empty(val, "tools")?;
                m.tools = parse_tools_block(&mut lines)?;
            }
            "knowledge" => {
                expect_empty(val, "knowledge")?;
                m.knowledge_spaces = parse_flow_list(
                    &parse_sub_block(&mut lines, "knowledge")?
                        .into_iter()
                        .find(|(k, _)| k == "spaces")
                        .map(|(_, v)| v)
                        .ok_or_else(|| ExpertError::Parse("knowledge 缺 spaces".into()))?,
                );
            }
            "constraints" => {
                expect_empty(val, "constraints")?;
                for (k, v) in parse_sub_block(&mut lines, "constraints")? {
                    match k.as_str() {
                        "max_steps" => {
                            m.constraints.max_steps = v
                                .parse()
                                .map_err(|_| ExpertError::Parse(format!("max_steps 非数值：{v}")))?
                        }
                        "max_context" => m.constraints.max_context_k = parse_k(&v)?,
                        "write_policy" => m.constraints.write_policy = v,
                        "command_policy" => m.constraints.command_policy = v,
                        _ => return Err(ExpertError::Parse(format!("constraints 未知子键：{k}"))),
                    }
                }
            }
            "model" => {
                // model: { tier: strong }（flow map，仅 tier 键）
                let inner = flow_map_inner(&val);
                for (k, v) in inner {
                    if k != "tier" {
                        return Err(ExpertError::Parse(format!("model 未知子键：{k}")));
                    }
                    m.model_tier = v;
                }
            }
            "skills" => m.skills = parse_flow_list(&val),
            "id" => m.id = val,
            "type" => m.kind = val,
            "version" => m.version = val,
            "display" => m.display = val,
            "icon" => m.icon = val,
            "source" => m.source = val,
            "signature" => m.signature = val,
            _ => unreachable!("白名单已过滤"),
        }
    }
    validate(&m)?;
    Ok(m)
}

/// 语义校验（§2 关键约束 + §8 资源界限）
fn validate(m: &ExpertManifest) -> Result<(), ExpertError> {
    let inv = |msg: &str| Err(ExpertError::Invalid(msg.into()));
    if !(m.id.starts_with("corp.")
        || m.id.starts_with("dept.")
        || m.id.starts_with("usr.")
        // 插件翻译专家（D22 §2/L5：壳 agents/*.md 翻译落
        // eco/experts/plugin_{id}_*.yaml，id=plugin.{plugin_id}.{name}）
        || m.id.starts_with("plugin."))
    {
        return inv("id 前缀必须为 corp./dept./usr.{userId}./plugin.");
    }
    if m.kind != "local" {
        return inv(&format!(
            "type={} 不支持（一期仅 local，remote 二期预留）",
            m.kind
        ));
    }
    if m.version.is_empty() || m.display.is_empty() || m.persona.trim().is_empty() {
        return inv("version/display/persona 必填");
    }
    match m.constraints.write_policy.as_str() {
        "readonly" | "checkpointed" | "none" => {}
        _ => return inv("write_policy 必须 readonly/checkpointed/none"),
    }
    if !(1..=EXPERT_MAX_STEPS_LIMIT).contains(&m.constraints.max_steps) {
        return inv(&format!("max_steps 须 1..={EXPERT_MAX_STEPS_LIMIT}"));
    }
    if !(EXPERT_CONTEXT_K_MIN..=EXPERT_CONTEXT_K_MAX).contains(&m.constraints.max_context_k) {
        return inv(&format!(
            "max_context 须 {EXPERT_CONTEXT_K_MIN}..={EXPERT_CONTEXT_K_MAX}k"
        ));
    }
    match m.model_tier.as_str() {
        "" | "strong" | "fast" => {}
        _ => return inv("model.tier 仅 strong/fast"),
    }
    if !matches!(m.source.as_str(), "company" | "personal") {
        return inv("source 必须 company/personal");
    }
    for list in [&m.tools.builtin, &m.tools.apps, &m.tools.mcp, &m.skills] {
        if has_dup(list) {
            return inv("工具/技能声明存在重复项");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 本地覆写层（D16 §6：上游建议配置 → 用户覆写 → 硬上限）
// ---------------------------------------------------------------------------

/// 覆写键白名单（封闭 schema：只能增强/调参——加工具/加 MCP/调步数预算/
/// 调档位；id/type/version/persona/signature/source 身份字段锁死）
const OVERRIDE_KEYS: &[&str] = &["tools", "skills", "constraints", "model"];

/// 应用本地覆写（`{id}.override.yaml`，与 manifest 同一受限 YAML 子集）：
/// - tools/skills：**合并**（union，上游在前）——"不满意就加工具/MCP 增强"主路径
/// - constraints：字段级覆盖；model：tier 覆盖
/// - 硬上限不可突破：合并后整 manifest 重走 validate（步数/预算/枚举/重复）
pub fn apply_override(m: &mut ExpertManifest, text: &str) -> Result<(), ExpertError> {
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let (key, val) =
            split_kv(t).ok_or_else(|| ExpertError::Parse(format!("覆写非法行：{t}")))?;
        if !OVERRIDE_KEYS.contains(&key.as_str()) {
            return Err(ExpertError::Parse(format!(
                "覆写未知/禁改键：{key}（可覆写 tools/skills/constraints/model）"
            )));
        }
        match key.as_str() {
            "tools" => {
                expect_empty(val, "tools")?;
                let extra = parse_tools_block(&mut lines)?;
                let union = |a: &mut Vec<String>, b: Vec<String>| {
                    for x in b {
                        if !a.contains(&x) {
                            a.push(x);
                        }
                    }
                };
                union(&mut m.tools.builtin, extra.builtin);
                union(&mut m.tools.apps, extra.apps);
                union(&mut m.tools.mcp, extra.mcp);
            }
            "skills" => {
                for x in parse_flow_list(&val) {
                    if !m.skills.contains(&x) {
                        m.skills.push(x);
                    }
                }
            }
            "constraints" => {
                expect_empty(val, "constraints")?;
                for (k, v) in parse_sub_block(&mut lines, "constraints")? {
                    match k.as_str() {
                        "max_steps" => {
                            m.constraints.max_steps = v
                                .parse()
                                .map_err(|_| ExpertError::Parse(format!("max_steps 非数值：{v}")))?
                        }
                        "max_context" => m.constraints.max_context_k = parse_k(&v)?,
                        "write_policy" => m.constraints.write_policy = v,
                        "command_policy" => m.constraints.command_policy = v,
                        _ => return Err(ExpertError::Parse(format!("constraints 未知子键：{k}"))),
                    }
                }
            }
            "model" => {
                for (k, v) in flow_map_inner(&val) {
                    if k != "tier" {
                        return Err(ExpertError::Parse(format!("model 未知子键：{k}")));
                    }
                    m.model_tier = v;
                }
            }
            _ => unreachable!("白名单已过滤"),
        }
    }
    validate(m)
}

// ---------------------------------------------------------------------------
// 装配过滤（§6.3 防线一）
// ---------------------------------------------------------------------------

/// 租户策略注入点（agent_tool_policy；v0.1 精确名/`mcp.{server}.*` 前缀通配）
#[derive(Debug, Clone, Default)]
pub struct AssemblePolicy {
    /// 禁用工具（精确名或 `mcp.kb.*` 式前缀通配）
    pub deny_tools: Vec<String>,
}

impl AssemblePolicy {
    fn denies(&self, name: &str) -> bool {
        self.deny_tools.iter().any(|p| {
            // `mcp.kb.*` 匹配 kb server 下任一工具（前缀含 `.`，不误伤 `mcp.kb` 本名）
            p.strip_suffix(".*")
                .is_some_and(|pre| name.starts_with(&format!("{pre}.")))
                || p == name
        })
    }
}

/// 剔除项（详情页标灰数据源，§4 PAG-14）
#[derive(Debug, Clone, PartialEq)]
pub struct Dropped {
    pub name: String,
    pub reason: String,
}

/// 装配产物：可执行受限子会话的全部输入
#[derive(Debug, Clone)]
pub struct AssembledExpert {
    pub manifest: ExpertManifest,
    /// persona + 技能正文 + 约束引导（独立窗口 system）
    pub system_prompt: String,
    /// bbc-strong / bbc-fast（tier 缺省 strong）
    pub model: String,
    pub max_steps: usize,
    /// 上下文预算（tokens；超限自杀返部分结果）
    pub max_context_tokens: usize,
    /// 过滤后工具名集（模型可见子集）
    pub tool_names: Vec<String>,
    /// 工具剔除清单（未注册/策略禁用）
    pub dropped_tools: Vec<Dropped>,
    /// 技能剔除清单（未安装）
    pub dropped_skills: Vec<Dropped>,
}

/// 装配：manifest ∩ 运行时注册表 ∩ 租户策略 → 受限子会话输入。
/// readonly **不**在此剔除 run_command 类（§8-1：写类靠门控+沙箱，装配层
/// 不管工具形态；checkpointed 审批等待随编排层）。
pub fn assemble(
    m: &ExpertManifest,
    registry: &[ToolSpec],
    skills: &SkillIndex,
    policy: &AssemblePolicy,
) -> AssembledExpert {
    let registered: Vec<&str> = registry.iter().map(|s| s.name.as_str()).collect();
    let mut tool_names = vec![];
    let mut dropped_tools = vec![];
    for name in m
        .tools
        .builtin
        .iter()
        .chain(&m.tools.apps)
        .chain(&m.tools.mcp)
    {
        if !registered.contains(&name.as_str()) {
            dropped_tools.push(Dropped {
                name: name.clone(),
                reason: "未注册（未安装/已下线）".into(),
            });
        } else if policy.denies(name) {
            dropped_tools.push(Dropped {
                name: name.clone(),
                reason: "租户策略禁用".into(),
            });
        } else {
            tool_names.push(name.clone());
        }
    }
    let mut skill_bodies: Vec<(String, String)> = vec![];
    let mut dropped_skills = vec![];
    for want in &m.skills {
        match skills.entries.iter().find(|e| &e.name == want) {
            Some(e) => skill_bodies.push((e.name.clone(), e.body.clone())),
            None => dropped_skills.push(Dropped {
                name: want.clone(),
                reason: "技能未安装".into(),
            }),
        }
    }
    AssembledExpert {
        system_prompt: build_system(m, &skill_bodies),
        model: match m.model_tier.as_str() {
            "fast" => "bbc-fast".into(),
            _ => "bbc-strong".into(),
        },
        max_steps: m.constraints.max_steps,
        max_context_tokens: m.constraints.max_context_k * 1024,
        tool_names,
        dropped_tools,
        dropped_skills,
        manifest: m.clone(),
    }
}

/// system 组装：persona（人设+输出契约）+ 技能正文注入 + 约束引导。
/// persona 内的权限表述仅为引导，硬边界=装配过滤+服务端 RLS（§8-6）。
fn build_system(m: &ExpertManifest, skill_bodies: &[(String, String)]) -> String {
    let mut sys = String::new();
    sys.push_str(m.persona.trim());
    if !skill_bodies.is_empty() {
        sys.push_str("\n\n## 绑定技能\n");
        for (name, body) in skill_bodies {
            sys.push_str(&format!("\n### {name}\n{}\n", body.trim()));
        }
    }
    sys.push_str("\n\n## 执行约束\n");
    let write_hint = match m.constraints.write_policy.as_str() {
        "readonly" => "readonly：产出结构化结论，不做落盘修改（写操作将被门控拦截）",
        "checkpointed" => "checkpointed：改动经主会话检查点与审批卡",
        _ => "none：无写操作约束声明",
    };
    sys.push_str(&format!("- 写策略：{write_hint}\n"));
    if !m.constraints.command_policy.is_empty() {
        sys.push_str(&format!("- 命令策略：{}\n", m.constraints.command_policy));
    }
    if !m.knowledge_spaces.is_empty() {
        sys.push_str(&format!(
            "- 知识空间视野：{}（按用户本人权限，服务端过滤）\n",
            m.knowledge_spaces.join(", ")
        ));
    }
    sys
}

// ---------------------------------------------------------------------------
// 受限子会话（§3.2：独立上下文一次性执行，D11 对齐）
// ---------------------------------------------------------------------------

/// 专家执行上下文（owned Arc——线程派发/后台化安全；完整走 bbrt-tools
/// 管线 gate/审计/脱敏，"专家权限 ≤ 主会话档位"由此保证）
#[derive(Clone)]
pub struct ExpertCtx {
    pub model: Arc<dyn ChatClient>,
    pub tools: Arc<dyn ToolExecutor>,
    pub mode: PermissionMode,
    /// 运行中枢（D16 决策⑧：Activation 注册补充指令/取消通道；None=仅本地跑）
    pub hub: Option<Arc<crate::bg_hub::BgHub>>,
    /// D35 定时任务：无人值守（专家工具白名单再剔除 ask_user）
    pub unattended: bool,
}

/// 单次 Activation 产物（摘要回填主上下文/审计用）
#[derive(Debug, Clone, PartialEq)]
pub struct ExpertResult {
    /// 持久 run id（D16 §3.1：接 Store 时 r-{seq}；否则退回进程内临时 id）
    pub run_id: String,
    pub persona_id: String,
    pub ok: bool,
    pub summary: String,
}

/// Activation 序号（进程内唯一化；仅未接 Store 时的 run id 退路）
static ACT_SEQ: AtomicUsize = AtomicUsize::new(0);

/// 跑一次专家 Activation：run 起始 → 独立上下文 mini-loop（manifest 步数/
/// 预算上限，工具经完整管线）→ done/fail + run 终态。复用 subagent 协议事件
/// （协议冻结不新增变体），专家身份经 WAL `expert.*` 类型与
/// `act=expert:{id}:{run_id}`。run 行落 agent_run（kind=expert，D16 §3.1）。
pub fn run_expert(
    ctx: &ExpertCtx,
    session_id: &str,
    assembled: &AssembledExpert,
    task: &str,
    sink: &dyn crate::events::SessionSink,
    wal: &dyn crate::loop_runner::EventLog,
    parent_run_id: &str,
) -> ExpertResult {
    use crate::loop_runner::{RunEnd, RunStart};
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let started = std::time::Instant::now();
    let run_id = wal
        .next_task_id("expert")
        .unwrap_or_else(|| format!("act-{now_ms}-{}", ACT_SEQ.fetch_add(1, Ordering::Relaxed)));
    // 补充指令通道（D16 决策⑧）：注册先于执行循环（同探查口径）
    let (input_tx, input_rx) = std::sync::mpsc::channel::<crate::loop_runner::BgHostMsg>();
    if let Some(hub) = ctx.hub.as_ref() {
        hub.register(&run_id, session_id, input_tx.clone());
    }
    drop(input_tx);
    let persona_id = assembled.manifest.id.clone();
    let act = format!("expert:{persona_id}:{run_id}");

    let def_ref = format!("{}@{}", assembled.manifest.id, assembled.manifest.version);
    let eta_hint = wal
        .eta_hint(&def_ref)
        .unwrap_or_else(|| crate::loop_runner::static_eta_ms("expert"));
    wal.run_start(&RunStart {
        run_id: run_id.clone(),
        session_id: session_id.to_string(),
        root_session_id: session_id.to_string(),
        parent_run_id: parent_run_id.to_string(),
        parent_call_id: String::new(),
        kind: "expert",
        def_ref: def_ref.clone(),
        eta_hint_ms: eta_hint,
        actor: String::new(),
    });
    sink.emit(SessionEvent::SubagentSpawned {
        session_id: session_id.to_string(),
        sub_id: run_id.clone(),
        task_digest: truncate_chars(&format!("{}：{}", assembled.manifest.display, task), 60),
        tool_subset: assembled.tool_names.clone(),
    });
    wal.append_run(
        session_id,
        &run_id,
        "expert.activate",
        &format!(
            "{{\"persona\":\"{persona_id}\",\"run_id\":\"{run_id}\",\"act\":\"{act}\",\"tools\":{}}}",
            serde_json::to_string(&assembled.tool_names).unwrap_or_else(|_| "[]".into())
        ),
    );

    let mut history: Vec<Round> = vec![];
    let mut steps = 0usize;
    let mut cancelled = false;
    let result = loop {
        // 补充指令 drain（每步轮询；注入为 user 轮——下一模型轮即见）
        while let Ok(msg) = input_rx.try_recv() {
            match msg {
                crate::loop_runner::BgHostMsg::Input { text } => {
                    wal.append_run(
                        session_id,
                        &run_id,
                        "expert.input",
                        &serde_json::json!({ "run_id": run_id, "text": text }).to_string(),
                    );
                    history.push(Round::User {
                        content: format!("[主 Agent 补充指令] {text}"),
                    });
                    sink.emit(SessionEvent::SubagentProbeEvt {
                        session_id: session_id.to_string(),
                        sub_id: run_id.clone(),
                        phase: "delta".into(),
                        summary: Some(format!("收到补充指令：{}", truncate_chars(&text, 40))),
                    });
                }
                crate::loop_runner::BgHostMsg::Cancel { .. } => {
                    wal.append_run(
                        session_id,
                        &run_id,
                        "expert.cancel",
                        &serde_json::json!({ "run_id": run_id }).to_string(),
                    );
                    cancelled = true;
                }
            }
        }
        if cancelled {
            break ExpertResult {
                run_id: run_id.clone(),
                persona_id: persona_id.clone(),
                ok: false,
                summary: format!("已按指令取消，部分结果：{}", last_text(&history)),
            };
        }
        if steps >= assembled.max_steps {
            break ExpertResult {
                run_id: run_id.clone(),
                persona_id: persona_id.clone(),
                ok: false,
                summary: format!(
                    "超步自杀（>{}），部分结果：{}",
                    assembled.max_steps,
                    last_text(&history)
                ),
            };
        }
        steps += 1;
        let msgs = messages_with(&assembled.system_prompt, &history, task);
        if msgs
            .iter()
            .map(|m| estimate_tokens(&m.content))
            .sum::<usize>()
            > assembled.max_context_tokens
        {
            break ExpertResult {
                run_id: run_id.clone(),
                persona_id: persona_id.clone(),
                ok: false,
                summary: format!(
                    "超上下文预算（>{}k tokens），部分结果：{}",
                    assembled.max_context_tokens / 1024,
                    last_text(&history)
                ),
            };
        }
        let req = ChatRequest {
            model: assembled.model.clone(),
            messages: msgs,
            tools: expert_specs(ctx.tools.as_ref(), &assembled.tool_names, ctx.unattended),
            thinking: None,
        };
        let Ok(stream) = ctx.model.chat(&req) else {
            break ExpertResult {
                run_id: run_id.clone(),
                persona_id: persona_id.clone(),
                ok: false,
                summary: "模型通道失败".into(),
            };
        };
        let (text, tool_calls, finish) = drain(stream);
        history.push(Round::Assistant {
            content: text.clone(),
            tool_calls: tool_calls
                .iter()
                .map(|t| bbrt_context::ToolCallRecord {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    args_digest: bbrt_sec::masking::args_digest(&t.arguments),
                })
                .collect(),
        });
        if finish != bbrt_aigw::FinishReason::ToolCalls || tool_calls.is_empty() {
            break ExpertResult {
                run_id: run_id.clone(),
                persona_id: persona_id.clone(),
                ok: true,
                summary: clamp_summary(&text),
            };
        }
        for tc in tool_calls {
            let call = ToolInvocation {
                call_id: tc.id.clone(),
                name: tc.name.clone(),
                args_json: tc.arguments.clone(),
                session_id: session_id.to_string(),
            };
            let summary = match ctx.tools.execute(ctx.mode, &call) {
                ToolOutcome::Ok { summary, .. } => summary,
                ToolOutcome::Blocked { summary, .. } => format!("[被拦] {summary}"),
            };
            history.push(Round::Tool {
                call_id: tc.id.clone(),
                name: tc.name.clone(),
                summary: clamp_summary(&summary),
            });
        }
    };

    let phase = if result.ok { "done" } else { "fail" };
    sink.emit(SessionEvent::SubagentProbeEvt {
        session_id: session_id.to_string(),
        sub_id: run_id.clone(),
        phase: phase.into(),
        summary: Some(truncate_chars(&result.summary, 200)),
    });
    wal.append_run(
        session_id,
        &run_id,
        if result.ok {
            "expert.done"
        } else {
            "expert.fail"
        },
        &format!("{{\"run_id\":\"{run_id}\",\"act\":\"{act}\",\"phase\":\"{phase}\"}}"),
    );
    wal.run_end(
        &run_id,
        &RunEnd {
            status: if cancelled {
                "cancelled"
            } else if result.ok {
                "done"
            } else {
                "failed"
            },
            eta_actual_ms: started.elapsed().as_millis() as i64,
            summary: &truncate_chars(&result.summary, 400),
        },
    );
    if let Some(hub) = ctx.hub.as_ref() {
        hub.unregister(&run_id);
    }
    result
}

/// 白名单工具 specs（模型只见装配过滤后子集；D35 无人值守再剔除 ask_user）
fn expert_specs(tools: &dyn ToolExecutor, names: &[String], unattended: bool) -> Vec<ToolSpec> {
    tools
        .tool_specs()
        .into_iter()
        .filter(|s| names.contains(&s.name))
        .filter(|s| !(unattended && s.name == "ask_user"))
        .collect()
}

fn last_text(history: &[Round]) -> String {
    history
        .iter()
        .rev()
        .find_map(|r| match r {
            Round::Assistant { content, .. } if !content.is_empty() => Some(clamp_summary(content)),
            _ => None,
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 专家库索引与单专家选角（D14 §3.3 自动选角的精简形态）
// ---------------------------------------------------------------------------

/// 专家库索引：扫描 `eco/experts/*.yaml`（一文件一 manifest；解析失败
/// 静默跳过不阻塞其余——降级语义同技能装载；tools.reload 联动由 bin 侧重扫）
#[derive(Debug, Clone, Default)]
pub struct ExpertIndex {
    pub manifests: Vec<ExpertManifest>,
}

impl ExpertIndex {
    /// 扫描专家库目录（缺失/空目录=空索引；yaml/yml 双扩展）。
    /// `{id}.override.yaml` = 本地覆写（D16 §6 三层配置：建议配置→覆写→
    /// 硬上限）：tools/skills 合并增强、constraints/model 覆盖后重校验；
    /// 坏覆写降级=沿用建议配置（不阻塞该专家可用）。
    pub fn scan(dir: &std::path::Path) -> Self {
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return Self::default(),
        };
        let mut manifests: Vec<ExpertManifest> = vec![];
        let mut overrides: Vec<(String, String)> = vec![]; // (id, 覆写文本)
        for p in rd.filter_map(|e| e.ok()).map(|e| e.path()) {
            if !matches!(p.extension().and_then(|x| x.to_str()), Some("yaml" | "yml")) {
                continue;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            if let Some(stem) = name
                .strip_suffix(".override.yaml")
                .or_else(|| name.strip_suffix(".override.yml"))
            {
                overrides.push((stem.to_string(), text));
            } else if let Ok(m) = parse_manifest(&text) {
                manifests.push(m);
            }
        }
        for (id, text) in overrides {
            let Some(m) = manifests.iter_mut().find(|m| m.id == id) else {
                continue; // 孤儿覆写（上游已删）：忽略
            };
            if let Err(e) = apply_override(m, &text) {
                eprintln!("[bbrt] 专家 {id} 本地覆写非法，沿用建议配置：{e}");
            }
        }
        manifests.sort_by(|a, b| a.id.cmp(&b.id)); // 确定性：选角清单顺序稳定
        Self { manifests }
    }

    /// 按 id 取 manifest
    pub fn get(&self, id: &str) -> Option<&ExpertManifest> {
        self.manifests.iter().find(|m| m.id == id)
    }

    /// 选角清单文本（id + display + persona 摘要——快模型视角）
    fn roster(&self) -> String {
        self.manifests
            .iter()
            .map(|m| {
                format!(
                    "- {}：{}｜{}",
                    m.id,
                    m.display,
                    truncate_chars(m.persona.trim(), 60)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// 单专家派发（选角产物：装配后的专家 + 角色位标签 + 任务简报）
pub struct ExpertPick {
    /// 角色位标签（缺省=manifest display；回填标题用）
    pub label: String,
    pub expert: Arc<AssembledExpert>,
    /// 任务简报（当前=用户原话）
    pub task: String,
}

/// 专家调用源（依赖倒置：loop_runner 只依赖本 trait；bin 装配 FastPicker，
/// 测试注入假件。None=零行为回主循环——专家调用是优化不是依赖，降级语义同探查）
pub trait ExpertSource: Send + Sync {
    /// 判定是否需要某位专家并装配（命中返回单专家派发；装配过滤已生效）
    fn pick(&self, model: &dyn ChatClient, user_text: &str) -> Option<ExpertPick>;
}

/// 快模型单专家选角器（D14 §3.3：任务关键词 × manifest 能力声明匹配；输出
/// JSON {expert}——解析失败/围栏噪声/幻觉 id 一律降级不调用）。装配闭包由
/// bin 注入（registry/skills/policy 绑定侧）。
pub struct FastPicker<F>
where
    F: Fn(&ExpertManifest) -> AssembledExpert + Send + Sync,
{
    pub index: ExpertIndex,
    /// manifest → 装配产物（assemble() 的绑定封装，含 dropped 标灰信息）
    pub assemble_for: F,
}

const PICKER_SYSTEM: &str = "判定任务是否需要交给某位专家执行。可用专家清单：\nROSTER\n\
    输出纯 JSON（无围栏无解释）：\n\
    {\"expert\": \"专家id\"} 或 {\"expert\": null}\n\
    判定：任务明确需要清单中某位专家的专业视角，且清单中有匹配专家（最多 1 个）；\
    单一问题/清单不匹配/普通问答输出 null。";

impl<F> ExpertSource for FastPicker<F>
where
    F: Fn(&ExpertManifest) -> AssembledExpert + Send + Sync,
{
    fn pick(&self, model: &dyn ChatClient, user_text: &str) -> Option<ExpertPick> {
        if self.index.manifests.is_empty() {
            return None;
        }
        let system = PICKER_SYSTEM.replacen("ROSTER", &self.index.roster(), 1);
        let out = crate::loop_runner::chat_text(model, &system, user_text).ok()?;
        let v: serde_json::Value =
            serde_json::from_str(crate::subagent::strip_fence(&out).trim()).ok()?;
        let id = v.get("expert")?.as_str()?;
        // 幻觉 id 防线：只认清单内专家（声明式——不在库=不存在）
        let m = self.index.get(id)?;
        Some(ExpertPick {
            label: m.display.clone(),
            expert: Arc::new((self.assemble_for)(m)),
            task: user_text.to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// 受限 YAML 子集解析内部件
// ---------------------------------------------------------------------------

/// 拆 `key: value`（value 可空=子块/块标量）
fn split_kv(t: &str) -> Option<(String, String)> {
    let (k, v) = t.split_once(':')?;
    let k = k.trim();
    if k.is_empty() || k.contains(' ') {
        return None;
    }
    Some((k.to_string(), v.trim().to_string()))
}

fn expect_empty(val: String, key: &str) -> Result<(), ExpertError> {
    if val.is_empty() {
        Ok(())
    } else {
        Err(ExpertError::Parse(format!("{key} 不接受行内值")))
    }
}

/// 块标量捕获（dedent 按块内首个非空行缩进；空行保留）
fn take_block(lines: &mut std::iter::Peekable<std::str::Lines<'_>>) -> String {
    let mut raw: Vec<String> = vec![];
    let mut indent: Option<usize> = None;
    while let Some(line) = lines.peek() {
        if !line.trim().is_empty() {
            let lead = line.len() - line.trim_start().len();
            if lead == 0 {
                break; // 回到顶层键
            }
            if indent.is_none() {
                indent = Some(lead);
            }
        }
        raw.push(line.to_string());
        lines.next();
    }
    let n = indent.unwrap_or(0);
    raw.iter()
        .map(|l| {
            if l.len() >= n {
                &l[n..]
            } else {
                l.trim_start()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// 缩进子块平铺键值（`key: value` 一层；注释/空行跳过；退格=块结束）
fn parse_sub_block(
    lines: &mut std::iter::Peekable<std::str::Lines<'_>>,
    owner: &str,
) -> Result<Vec<(String, String)>, ExpertError> {
    let mut out = vec![];
    while let Some(line) = lines.peek() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            lines.next();
            continue;
        }
        let lead = line.len() - t.len();
        if lead == 0 {
            break;
        }
        let (k, v) =
            split_kv(t).ok_or_else(|| ExpertError::Parse(format!("{owner} 子块非法行：{t}")))?;
        out.push((k, v));
        lines.next();
    }
    Ok(out)
}

/// tools 子块（builtin/apps/mcp 三个 flow 列表键）
fn parse_tools_block(
    lines: &mut std::iter::Peekable<std::str::Lines<'_>>,
) -> Result<ManifestTools, ExpertError> {
    let subs = parse_sub_block(lines, "tools")?;
    let mut tools = ManifestTools::default();
    for (k, v) in subs {
        match k.as_str() {
            "builtin" => tools.builtin = parse_flow_list(&v),
            "apps" => tools.apps = parse_flow_list(&v),
            "mcp" => tools.mcp = parse_flow_list(&v),
            _ => return Err(ExpertError::Parse(format!("tools 未知子键：{k}"))),
        }
    }
    Ok(tools)
}

/// flow 列表 `[a, b, c]`（容忍空串/多余空白）
fn parse_flow_list(s: &str) -> Vec<String> {
    let inner = s.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// flow map `{ tier: strong }` 内层键值
fn flow_map_inner(s: &str) -> Vec<(String, String)> {
    let inner = s.trim().trim_start_matches('{').trim_end_matches('}');
    inner
        .split(',')
        .filter_map(|pair| split_kv(pair.trim()))
        .collect()
}

/// `32k` / `32` → 数值（k 后缀；其他后缀拒绝）
fn parse_k(s: &str) -> Result<usize, ExpertError> {
    let t = s.trim();
    if let Some(num) = t.strip_suffix('k').or_else(|| t.strip_suffix('K')) {
        num.trim()
            .parse()
            .map_err(|_| ExpertError::Parse(format!("max_context 非数值：{t}")))
    } else {
        t.parse()
            .map_err(|_| ExpertError::Parse(format!("max_context 非数值：{t}")))
    }
}

fn has_dup(list: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    list.iter().any(|s| !seen.insert(s.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
id: corp.code-reviewer
type: local
version: 1.2.0
display: 代码评审专家
icon: review.png
persona: |
  你是资深评审员。逐文件审查 diff，输出：阻断问题/建议/风险评级三段结构。
tools:
  builtin: [read_file, search_files, git_diff, run_command]
  apps:   [oa.lookup]
  mcp:    [kb.search]
skills: [corp.review-standards]
knowledge:
  spaces: [kb.contract, kb.product]
constraints:
  max_steps: 40
  max_context: 32k
  write_policy: readonly
  command_policy: whitelist_only
model: { tier: strong }
source: company
signature: abc123
";

    /// D14 §2 原样样例可解析且字段全对齐
    #[test]
    fn parse_full_sample() {
        let m = parse_manifest(SAMPLE).unwrap();
        assert_eq!(m.id, "corp.code-reviewer");
        assert_eq!(m.kind, "local");
        assert_eq!(
            m.tools.builtin,
            vec!["read_file", "search_files", "git_diff", "run_command"]
        );
        assert_eq!(m.tools.apps, vec!["oa.lookup"]);
        assert_eq!(m.tools.mcp, vec!["kb.search"]);
        assert_eq!(m.skills, vec!["corp.review-standards"]);
        assert_eq!(m.knowledge_spaces, vec!["kb.contract", "kb.product"]);
        assert_eq!(m.constraints.max_steps, 40);
        assert_eq!(m.constraints.max_context_k, 32);
        assert_eq!(m.constraints.write_policy, "readonly");
        assert_eq!(m.model_tier, "strong");
        assert_eq!(m.source, "company");
        assert!(m.persona.contains("资深评审员"));
    }

    /// 缺省填充：constraints/model 可整段省略（40/32k/readonly/strong）
    #[test]
    fn parse_defaults() {
        let minimal = "id: usr.42.helper\ntype: local\nversion: 0.1.0\ndisplay: 助手\npersona: |\n  干活\nsource: personal\n";
        let m = parse_manifest(minimal).unwrap();
        assert_eq!(m.constraints.max_steps, EXPERT_DEFAULT_MAX_STEPS);
        assert_eq!(m.constraints.max_context_k, EXPERT_DEFAULT_CONTEXT_K);
        assert_eq!(m.constraints.write_policy, "readonly");
        assert_eq!(m.model_tier, "");
    }

    /// persona 多行块捕获（含空行与缩进归一）
    #[test]
    fn parse_persona_block() {
        let text = "id: corp.x\ntype: local\nversion: 1.0.0\ndisplay: X\npersona: |\n  第一行\n\n    缩进保留\n  第二段\nsource: company\n";
        let m = parse_manifest(text).unwrap();
        assert!(m.persona.contains("第一行\n\n  缩进保留\n第二段"));
    }

    /// 封闭 schema：未知顶层键/子键拒绝；type=remote 拒绝
    #[test]
    fn parse_rejects() {
        let bad_key = SAMPLE.replacen("icon:", "payload:", 1);
        assert!(matches!(
            parse_manifest(&bad_key),
            Err(ExpertError::Parse(_))
        ));
        let remote = SAMPLE.replace("type: local", "type: remote");
        assert!(matches!(
            parse_manifest(&remote),
            Err(ExpertError::Invalid(_))
        ));
        let bad_policy = SAMPLE.replace("write_policy: readonly", "write_policy: always");
        assert!(parse_manifest(&bad_policy).is_err());
        let bad_id = SAMPLE.replace("corp.code-reviewer", "free.agent");
        assert!(matches!(
            parse_manifest(&bad_id),
            Err(ExpertError::Invalid(_))
        ));
        let over_steps = SAMPLE.replace(
            "max_steps: 40",
            &format!("max_steps: {}", EXPERT_MAX_STEPS_LIMIT + 1),
        );
        assert!(matches!(
            parse_manifest(&over_steps),
            Err(ExpertError::Invalid(_))
        ));
    }

    /// 本地覆写（D16 §6）：合并增强 + 调参 + 硬上限不可突破 + 身份锁死
    #[test]
    fn override_merges_and_enforces_limits() {
        let mut m = parse_manifest(SAMPLE).unwrap();
        apply_override(
            &mut m,
            "tools:\n  builtin: [write_file]\n  mcp: [my.local.tool]\nskills: [my.extra-skill]\nconstraints:\n  max_steps: 120\nmodel: { tier: fast }\n",
        )
        .unwrap();
        // 合并：上游工具保留 + 新增；技能合并
        assert!(m.tools.builtin.contains(&"run_command".to_string()));
        assert!(m.tools.builtin.contains(&"write_file".to_string()));
        assert!(m.tools.mcp.contains(&"my.local.tool".to_string()));
        assert!(m.tools.mcp.contains(&"kb.search".to_string()));
        assert!(m.skills.contains(&"corp.review-standards".to_string()));
        assert!(m.skills.contains(&"my.extra-skill".to_string()));
        // 调参/档位覆盖
        assert_eq!(m.constraints.max_steps, 120);
        assert_eq!(m.model_tier, "fast");

        // 硬上限：超步数顶拒绝
        let mut m2 = parse_manifest(SAMPLE).unwrap();
        assert!(apply_override(&mut m2, "constraints:\n  max_steps: 999\n").is_err());
        // 硬上限：非法档位拒绝
        let mut m3 = parse_manifest(SAMPLE).unwrap();
        assert!(apply_override(&mut m3, "model: { tier: mega }\n").is_err());
        // 身份锁死：persona/id 禁改
        let mut m4 = parse_manifest(SAMPLE).unwrap();
        assert!(apply_override(&mut m4, "persona: |\n  换个人设\n").is_err());
        assert!(apply_override(&mut m4, "id: corp.other\n").is_err());
    }

    /// 策略通配：mcp.kb.* 拒 kb.search 不拒 oa.lookup
    #[test]
    fn policy_glob() {
        let p = AssemblePolicy {
            deny_tools: vec!["mcp.kb.*".into()],
        };
        assert!(p.denies("mcp.kb.search"));
        assert!(p.denies("mcp.kb.query"));
        assert!(!p.denies("oa.lookup"));
        assert!(!p.denies("mcp.kb"));
    }
}
