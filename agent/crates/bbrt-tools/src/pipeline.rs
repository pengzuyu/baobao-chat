//! 工具执行管线（D11 §6 九步伪码的落地；实现 bbrt_session::ToolExecutor 契约）。
//!
//! 管线对照（D11 §6 步骤 → 本 crate 归属）：
//!
//! | §6 步骤 | 归属 | 说明 |
//! |---|---|---|
//! | 0 展示（tool.call，args 打码） | session loop_runner | 已在 bbrt-session 实现 |
//! | 1 风险级判定（未注册 8002） | [`PipelineExecutor::check`] ① | registry.get |
//! | 2 矩阵检查（gate ①→③） | [`PipelineExecutor::check`] ② | sec::gate::permission_gate |
//! | 3 三级记忆（gate ④） | [`PipelineExecutor::check`] ② | gate 内部第④步（GrantStore） |
//! | 4 需确认 → permission.request | session loop_runner | check 返回 NeedConfirm{preview,options} |
//! | 5 沙箱校验（路径/网络） | [`PipelineExecutor::execute`] | 各 builtin 内 PathPolicy/NetPolicy（8020/8024/8025/8026）+ cmd 词法预检 |
//! | 6 执行 | [`PipelineExecutor::execute`] | builtin 分发（沙箱真实执行） |
//! | 7 结果脱敏 | [`PipelineExecutor::execute`] | masking::mask 统一打码 |
//! | 8 审计 JSONL | session/store 层 | args_digest 已由 session 回填（§6 步骤 0） |
//! | 9 回填上下文 | session loop_runner | ToolOutcome 摘要入上下文 |
//!
//! 审批通过后的记忆落库（§4.2）由 [`PipelineExecutor::record_grant`] 承担：
//! run_command 按命令原文精确匹配（同调用语义），其余工具按 `*` 整工具授权
//! （gate 的记忆匹配只对 command 字段取值，见 bbrt-sec gate.rs command_arg）。

use std::sync::Arc;

use bbrt_sec::danger_rules::DangerRuleSet;
use bbrt_sec::errors::CODE_NO_PERMISSION_POINT;
use bbrt_sec::gate::{permission_gate, AllowSource, Decision, GateCtx, ToolCall as GateCall};
use bbrt_sec::masking::mask;
use bbrt_sec::memory::{Grant, GrantScope, GrantStore};
use bbrt_sec::sandbox::launcher::MemoryViolationSink;
use bbrt_session::{CheckOutcome, ToolExecutor, ToolInvocation, ToolOutcome, ToolPreview};
use serde_json::Value;

use crate::builtin::{self, ExecEnv, ExecOutput, ToolBlock};
use crate::config::ToolsConfig;
use crate::registry::ToolRegistry;

/// 管线执行器（实现 session 的 ToolExecutor trait；bin 经 Arc<dyn ToolExecutor> 装配 LoopDeps）
pub struct PipelineExecutor {
    /// 工具注册表（§6 步骤 1）
    registry: ToolRegistry,
    /// 配置（工作区/白名单/记忆引擎/journal 回调/门控上下文）
    config: Arc<ToolsConfig>,
    /// 三级授权记忆（gate ④ 与 record_grant 共享；bin 可经 grants() 持有同源实例）
    grants: Arc<GrantStore>,
    /// 危险命令规则库（分类③用；v0.1 内置库）
    rules: DangerRuleSet,
    /// 执行环境（builtin 共享）
    env: ExecEnv,
    /// MCP client（D11 §2.10：mcp.* 工具执行转发；None=未装配）
    mcp: Option<Arc<bbrt_mcp::McpClient>>,
    /// D19 按项目根缓存的 PathPolicy（多会话同项目共享；锁保护 rusqlite 式
    /// 线程安全——这里只是 HashMap 缓存）
    policies: std::sync::Mutex<
        std::collections::HashMap<std::path::PathBuf, bbrt_sec::sandbox::path::PathPolicy>,
    >,
}

/// D19 workspace 类工具（依赖会话工作目录做沙箱根；项目会话=项目目录，
/// 日常会话=默认用户工作区——2026-11-12 修订）
const WORKSPACE_BOUND_TOOLS: &[&str] = &[
    "read_file",
    "list_dir",
    "write_file",
    "edit_file",
    "search_files",
    "run_command",
    "git_status",
    "git_diff",
    "git_commit",
    "git_push",
];

impl PipelineExecutor {
    /// 标准构造：内置工具注册表 + 配置派生执行环境 + 空授权记忆。
    /// 接受 `ToolsConfig` 或 `Arc<ToolsConfig>`（bin 装配与测试两种形态）。
    pub fn new(config: impl Into<Arc<ToolsConfig>>) -> Self {
        let config = config.into();
        let sink: Arc<dyn bbrt_sec::sandbox::launcher::ViolationSink> = config
            .violation_sink
            .clone()
            .unwrap_or_else(|| Arc::new(MemoryViolationSink::new()));
        let launcher = config.launcher.clone().unwrap_or_default();
        let env = ExecEnv {
            workspace: std::fs::canonicalize(&config.workspace)
                .unwrap_or_else(|_| config.workspace.clone()),
            path_policy: config.path_policy(),
            net_policy: config.net_policy(),
            launcher,
            memory: config.memory.clone(),
            journal_hook: config.journal_hook.clone(),
            sink,
        };
        // MCP 来源注入（D14 §6.1 连接期发现）：风险级沿用 server 清单声明
        // （缺失默认 Medium）；动作类别按风险粗映射——Low→ReadOnly（矩阵放行）、
        // Medium→NetworkEgress（远程调用语义，ask/确认档）、High→CorpWrite
        // （公司域写全模式确认；09 §3.1 治理属性权威源不变）
        let mut registry = ToolRegistry::builtin();
        if let Some(client) = &config.mcp {
            for t in client.list_tools(&config.mcp_policy) {
                registry.register(crate::registry::ToolDef {
                    name: t.full_name.clone(),
                    description: t.description.clone(),
                    input_schema: t.input_schema.clone(),
                    risk: match t.risk {
                        bbrt_protocol::RiskLevel::Low => crate::registry::RiskLevel::Low,
                        bbrt_protocol::RiskLevel::Medium => crate::registry::RiskLevel::Medium,
                        bbrt_protocol::RiskLevel::High => crate::registry::RiskLevel::High,
                    },
                    category: match t.risk {
                        bbrt_protocol::RiskLevel::Low => bbrt_sec::gate::ActionCategory::ReadOnly,
                        bbrt_protocol::RiskLevel::Medium => {
                            bbrt_sec::gate::ActionCategory::NetworkEgress
                        }
                        bbrt_protocol::RiskLevel::High => bbrt_sec::gate::ActionCategory::CorpWrite,
                    },
                });
            }
        }
        let mcp = config.mcp.clone();
        Self {
            registry,
            config,
            grants: Arc::new(GrantStore::new()),
            rules: DangerRuleSet::builtin(),
            env,
            mcp,
            policies: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// D19 按项目根取（或建）PathPolicy：根=该项目目录 + 全局例外可写目录。
    /// 同项目并发会话共享同一策略实例（缓存命中）。
    fn policy_for(&self, root: &std::path::Path) -> bbrt_sec::sandbox::path::PathPolicy {
        let mut cache = self.policies.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(p) = cache.get(root) {
            return p.clone();
        }
        let policy = bbrt_sec::sandbox::path::PathPolicy::with_roots(
            vec![root.to_path_buf()],
            self.config.extra_writable.clone(),
        );
        cache.insert(root.to_path_buf(), policy.clone());
        policy
    }

    /// D19 按会话解析执行环境（workspace 类工具用；2026-11-12 修订）：
    /// - 项目会话 → 克隆 env 覆写 workspace/path_policy（沙箱根=该项目目录）；
    /// - 日常会话 → 默认用户工作区（ZCode 式口径：不绑项目会话共用的用户级
    ///   工作空间——原 8020 整体拒绝废除；沙箱根=该目录，越界仍 8020 词法+内核双拦）；
    /// - 未装配表/未登记会话 → 兜底全局 env（单测/嵌入式旧行为；子代理按主会话
    ///   路由沙箱登记阶段二）。
    fn session_env(&self, session_id: &str) -> ExecEnv {
        let Some(reg) = &self.config.session_workspaces else {
            return self.env.clone();
        };
        let ws = match reg.get(session_id) {
            None => return self.env.clone(),
            Some(None) => self
                .config
                .default_workspace
                .clone()
                .unwrap_or_else(bbrt_sec::sandbox::default_user_workspace),
            Some(Some(ws)) => ws.clone(),
        };
        // 首用确保目录存在（用户工作区可能尚未创建；项目目录天然存在）
        let _ = std::fs::create_dir_all(&ws);
        let real = std::fs::canonicalize(&ws).unwrap_or(ws);
        let mut env = self.env.clone();
        env.workspace = real.clone();
        env.path_policy = self.policy_for(&real);
        env
    }

    /// D19 会话项目目录（memory_save 作用域路由用）：日常/未登记 → None（用户级）
    fn session_ws_path(&self, session_id: &str) -> Option<std::path::PathBuf> {
        self.config
            .session_workspaces
            .as_ref()
            .and_then(|reg| reg.get(session_id))
            .flatten()
    }

    /// 替换注册表（bin 注入 app.*/技能合并后的注册表；10 篇 §4.6）
    pub fn with_registry(mut self, registry: ToolRegistry) -> Self {
        self.registry = registry;
        self
    }

    /// 注册表只读访问
    pub fn registry(&self) -> &ToolRegistry {
        &self.registry
    }

    /// 授权记忆同源句柄（bin 侧会话结束 clear_session / 持久化导出）
    pub fn grants(&self) -> Arc<GrantStore> {
        Arc::clone(&self.grants)
    }

    /// 解析调用参数（非法 JSON → 8002 拒绝）
    fn parse_args(call: &ToolInvocation) -> Result<Value, ToolBlock> {
        serde_json::from_str(&call.args_json).map_err(|e| ToolBlock {
            code: CODE_NO_PERMISSION_POINT,
            message: format!("参数不是合法 JSON: {e}"),
        })
    }

    /// 组装 gate 参数：run_command 保证 command 字段存在（cmd 别名归一），
    /// 使分类③/记忆④/危险规则扫描基于同一命令文本
    fn gate_args(name: &str, args: &Value) -> Value {
        if name == "run_command" && args.get("command").is_none() {
            if let Some(cmd) = builtin::cmd::command_text(args) {
                let mut patched = args.clone();
                patched["command"] = Value::String(cmd);
                return patched;
            }
        }
        args.clone()
    }
}

// ---------------------------------------------------------------------------
// ToolExecutor 实现（bbrt-session executor.rs 契约）
// ---------------------------------------------------------------------------

impl ToolExecutor for PipelineExecutor {
    /// 后台 spawn run_command（统一后台任务体系）：校验/spec 组装复用同步路径
    /// （cwd 白名单/词法预检），DetachedCommand 无内建超时——长任务不设上限
    /// 仅取消（对齐委派口径）；输出捕获/截断与同步口径一致
    fn spawn_background(
        &self,
        call: &ToolInvocation,
    ) -> Result<bbrt_sec::sandbox::DetachedCommand, String> {
        if call.name != "run_command" {
            return Err(format!("{} 不支持后台执行（仅 run_command）", call.name));
        }
        let args = Self::parse_args(call).map_err(|b| format!("{}（{}）", b.message, b.code))?;
        let cmd_text = builtin::cmd::command_text(&args)
            .ok_or_else(|| "run_command 缺少 command/cmd 参数（8101）".to_string())?;
        let env = self.session_env(&call.session_id);
        let spec = builtin::cmd::prepare_run_spec(&env, &args, &cmd_text)
            .map_err(|b| format!("{}（{}）", b.message, b.code))?;
        bbrt_sec::sandbox::DetachedCommand::spawn(&spec, &bbrt_sec::sandbox::RunOpts::default())
            .map_err(|e| format!("后台 spawn 失败: {e}"))
    }

    /// 门控判定（§6 步骤 1-4 浓缩；不执行、不发审批）
    fn check(&self, mode: bbrt_sec::gate::PermissionMode, call: &ToolInvocation) -> CheckOutcome {
        // ① ToolDef 查询（§6 步骤 1：未注册 → 8002）
        let Some(_def) = self.registry.get(&call.name) else {
            return CheckOutcome::Deny {
                code: CODE_NO_PERMISSION_POINT,
                message: format!("工具 {} 未注册（8002）", call.name),
            };
        };
        // 参数解析（非法 JSON → 8002）
        let args = match Self::parse_args(call) {
            Ok(v) => v,
            Err(b) => {
                return CheckOutcome::Deny {
                    code: b.code,
                    message: b.message,
                }
            }
        };
        // ② permission_gate（09 §4.1 ①→⑥；矩阵/记忆/不可信全在 gate 内）
        let gate_args = Self::gate_args(&call.name, &args);
        let permission_points: Vec<&str> = self
            .config
            .permission_points
            .iter()
            .map(|s| s.as_str())
            .collect();
        let whitelist: Vec<String> = self.config.whitelist_prefixes.clone();
        let ctx = GateCtx {
            policy: self.config.policy.as_ref(),
            permission_points: &permission_points,
            memory: Some(&self.grants),
            rules: &self.rules,
            whitelist_prefixes: &whitelist,
            untrusted: self.config.untrusted,
        };
        let gate_call = GateCall {
            tool: &call.name,
            args: &gate_args,
        };
        match permission_gate(mode, &gate_call, &ctx) {
            Decision::Allow { source } => CheckOutcome::Allow {
                source: allow_source_str(&source),
            },
            Decision::Confirm {
                double_prompt,
                reason,
                scopes,
            } => CheckOutcome::NeedConfirm {
                // 高危双重提示前缀（A4 长按交互由宿主实现；此处标记语义）
                reason: if double_prompt {
                    format!("【双重提示】{reason}")
                } else {
                    reason
                },
                preview: build_preview(&call.name, &args),
                options: scopes.iter().map(scope_str).collect(),
            },
            Decision::Deny { code, reason } => CheckOutcome::Deny {
                code,
                message: reason,
            },
        }
    }

    /// 执行（§6 步骤 5-7：沙箱校验 + 执行 + 脱敏；权限路径由调用方保证）。
    /// D19：workspace 类工具按会话解析执行环境——项目会话沙箱根=该项目目录
    /// （A 项目会话写 B 项目 → 预检 8020 + Seatbelt 内核双拦），日常会话=
    /// 默认用户工作区同款覆写（2026-11-12 修订：原整体拒绝废除）。
    fn execute(&self, _mode: bbrt_sec::gate::PermissionMode, call: &ToolInvocation) -> ToolOutcome {
        let args = match Self::parse_args(call) {
            Ok(v) => v,
            Err(b) => return blocked(&b),
        };
        let ws_bound = WORKSPACE_BOUND_TOOLS.contains(&call.name.as_str());
        let env = if ws_bound {
            self.session_env(&call.session_id)
        } else {
            self.env.clone()
        };
        // ⑥ 分发执行（未注册兜底 8002）
        let result: Result<ExecOutput, ToolBlock> = match call.name.as_str() {
            "read_file" => builtin::fs::read_file(&env, &args),
            "list_dir" => builtin::fs::list_dir(&env, &args),
            "write_file" => builtin::fs::write_file(&env, &args),
            "edit_file" => builtin::fs::edit_file(&env, &args),
            "search_files" => builtin::search::search_files(&env, &args),
            "run_command" => builtin::cmd::run(&env, &args),
            "git_status" => builtin::git::git_status(&env, &args),
            "git_diff" => builtin::git::git_diff(&env, &args),
            "git_commit" => builtin::git::git_commit(&env, &args),
            "git_push" => builtin::git::git_push(&env, &args),
            "http_fetch" => builtin::http::fetch(&env, &args),
            "memory_save" => {
                let ws = self.session_ws_path(&call.session_id);
                builtin::memory::save(&env, &args, &call.session_id, ws.as_deref())
            }
            // D23/M2：公共层更正（全局，无会话工作区参与）
            "memory_forget" => builtin::memory::forget(&env, &args, &call.session_id),
            // D23/M2：项目记忆正文按需拉取（touch last_used）
            "memory_read" => {
                let ws = self.session_ws_path(&call.session_id);
                builtin::memory::read(&env, &args, &call.session_id, ws.as_deref())
            }
            // D33 §3.1：技能显式加载（结果=SKILL.md 正文，天然注入下轮上下文；
            // 未装配索引/未命中走 Ok 降级引导，见 builtin/skill.rs）
            "skill" => builtin::skill::load(self.config.skills.as_ref(), &args),
            // mcp.{server}.{tool}（D11 §2.10 dispatch_by_source：网关/外部 MCP 工具；
            // OBO 由 McpClient 令牌闭包逐请求注入；断连/未注册 → 8002 标灰语义）
            _ if call.name.starts_with("mcp.") => match &self.mcp {
                Some(client) => match client.call(&call.name, args) {
                    Ok(out) => Ok(ExecOutput {
                        summary: out.text,
                        truncated: false,
                        exit_code: Some(i32::from(out.is_error)),
                        duration_ms: 0,
                    }),
                    Err(e) => Err(ToolBlock {
                        code: CODE_NO_PERMISSION_POINT,
                        message: format!("MCP 调用失败（{e}）"),
                    }),
                },
                None => Err(ToolBlock {
                    code: CODE_NO_PERMISSION_POINT,
                    message: "MCP 未装配（8002）".into(),
                }),
            },
            _ => Err(ToolBlock {
                code: CODE_NO_PERMISSION_POINT,
                message: format!("工具 {} 未注册（8002）", call.name),
            }),
        };
        match result {
            // ⑦ 结果脱敏（先打码再回填上下文/UI；09 §7.2）
            Ok(out) => ToolOutcome::Ok {
                summary: mask(&out.summary),
                truncated: out.truncated,
                exit_code: out.exit_code,
                duration_ms: out.duration_ms,
            },
            Err(b) => blocked(&ToolBlock {
                code: b.code,
                message: mask(&b.message),
            }),
        }
    }

    /// 审批通过后落记忆（§4.2；高危 permanent 由 GrantStore 硬名单拒绝）
    fn record_grant(
        &self,
        _mode: bbrt_sec::gate::PermissionMode,
        call: &ToolInvocation,
        scope: GrantScope,
    ) -> Result<(), String> {
        let args = Self::parse_args(call).map_err(|b| b.message)?;
        let pattern = grant_pattern(&call.name, &args);
        // A5 补充：命令命中危险规则 → 拒绝永久（GrantStore 硬名单只覆盖永不全自动工具）
        if scope == GrantScope::Permanent {
            if let Some(cmd) = builtin::cmd::command_text(&args) {
                if let Some(hit) = self.rules.scan(&cmd) {
                    return Err(format!(
                        "高危命令禁止永久记忆（D13-A5）：{}（规则：{}）",
                        cmd, hit.rule.reason
                    ));
                }
            }
        }
        let grant = Grant {
            tool: call.name.clone(),
            pattern,
            scope,
            granted_at_ms: builtin::now_ms(),
        };
        self.grants.insert(grant).map_err(|e| e.to_string())
    }

    /// 工具清单（assemble 注入模型 tools 参数）
    fn tool_specs(&self) -> Vec<bbrt_aigw::ToolSpec> {
        self.registry.specs()
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// blocked 映射
fn blocked(b: &ToolBlock) -> ToolOutcome {
    ToolOutcome::Blocked {
        code: b.code,
        summary: b.message.clone(),
    }
}

/// 放行来源 → 审计字符串（decision_source）
fn allow_source_str(source: &AllowSource) -> String {
    match source {
        AllowSource::Matrix => "matrix".to_string(),
        AllowSource::Memory { scope, pattern } => {
            format!("memory:{}({pattern})", scope_str(scope))
        }
    }
}

/// scope 字符串（审批卡 options 与审计）
fn scope_str(scope: &GrantScope) -> String {
    match scope {
        GrantScope::Once => "once".to_string(),
        GrantScope::Session => "session".to_string(),
        GrantScope::Permanent => "permanent".to_string(),
    }
}

/// 审批卡预览（§3.4：command 可编辑回传 / diff 摘要 / none）
fn build_preview(name: &str, args: &Value) -> ToolPreview {
    match name {
        "run_command" => ToolPreview {
            kind: "command".into(),
            content: builtin::cmd::command_text(args).unwrap_or_default(),
        },
        "write_file" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            let content = args.get("content").and_then(Value::as_str).unwrap_or("");
            ToolPreview {
                kind: "diff".into(),
                content: format!(
                    "写入 {path}（{} 字节）\n{}",
                    content.len(),
                    head(content, 400)
                ),
            }
        }
        "edit_file" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            let old = args.get("old").and_then(Value::as_str).unwrap_or("");
            let new = args.get("new").and_then(Value::as_str).unwrap_or("");
            ToolPreview {
                kind: "diff".into(),
                content: format!("编辑 {path}\n- {}\n+ {}", head(old, 200), head(new, 200)),
            }
        }
        "git_commit" => ToolPreview {
            kind: "diff".into(),
            content: format!(
                "提交信息：{}",
                args.get("message").and_then(Value::as_str).unwrap_or("")
            ),
        },
        _ => ToolPreview {
            kind: "none".into(),
            content: String::new(),
        },
    }
}

/// 头部截断（按字符数，UTF-8 安全）
fn head(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// 授权 pattern 推导：run_command = 命令原文（同调用精确匹配）；
/// 其余工具 = "*"（gate 记忆匹配只对 command 字段取值，路径 pattern 无法生效）
fn grant_pattern(name: &str, args: &Value) -> String {
    if name == "run_command" {
        builtin::cmd::command_text(args).unwrap_or_else(|| "*".to_string())
    } else {
        "*".to_string()
    }
}
