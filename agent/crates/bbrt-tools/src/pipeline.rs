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
use bbrt_sec::errors::{CODE_NO_PERMISSION_POINT, CODE_TOOL_PANIC};
use bbrt_sec::gate::{
    classify_action, permission_gate, AllowSource, Decision, GateCtx, ToolCall as GateCall,
};
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
    /// 工具注册表（§6 步骤 1；D26 OQ-3 收口：RwLock 支撑 mcp.config 热重建——
    /// 宿主装配推送后 bin 后台重建，进行中 turn 用旧表跑完，下轮 tool_specs 即新面）
    registry: std::sync::RwLock<ToolRegistry>,
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
    /// AGENTS.md 白名单缓存（缺口修复 2026-11-24：AGENTS.md→mtime→前缀清单；
    /// 编辑 AGENTS.md 会话内即时生效免重启）
    whitelist_cache: std::sync::Mutex<
        std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, Vec<String>)>,
    >,
    /// 读授权登记表（2026-11-26 读审批化：附件自动授权 + 读审批的会话票据；
    /// Arc 跨 session_env 克隆共享，子代理直调 execute 同表校验）
    read_access: std::sync::Arc<builtin::read_access::ReadAccess>,
}

/// D19 workspace 类工具（依赖会话工作目录做沙箱根；项目会话=项目目录，
/// 日常会话=默认用户工作区——2026-11-12 修订）
const WORKSPACE_BOUND_TOOLS: &[&str] = &[
    "read_file",
    "list_dir",
    "write_file",
    "edit_file",
    "glob_files",
    "grep_files",
    "run_command",
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
            read_access: None,
            full_auto: false,
        };
        // MCP 来源注入（连接期发现 → register_mcp_tools；D26 OQ-3 收口：构造
        // 与 reload_mcp 热重建共用同一注册函数）
        let registry = std::sync::RwLock::new(build_registry(&config));
        let mcp = config.mcp.clone();
        Self {
            registry,
            config,
            grants: Arc::new(GrantStore::new()),
            rules: DangerRuleSet::builtin(),
            env,
            mcp,
            policies: std::sync::Mutex::new(std::collections::HashMap::new()),
            whitelist_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            read_access: Arc::new(builtin::read_access::ReadAccess::default()),
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
        // 读授权句柄（2026-11-26 读审批化）：绑定该会话——附件/审批票据按会话隔离
        env.read_access = Some(Arc::new(builtin::read_access::SessionReadAccess {
            session_id: session_id.to_string(),
            access: Arc::clone(&self.read_access),
        }));
        env
    }

    /// 会话执行环境 + 当前档位覆写（读审批化：full-auto 工作区外非敏感读放行的
    /// 判定依据；check 与 execute 同口径——同一调用同一结论）
    fn session_env_with_mode(
        &self,
        session_id: &str,
        mode: bbrt_sec::gate::PermissionMode,
    ) -> ExecEnv {
        let mut env = self.session_env(session_id);
        env.full_auto = mode == bbrt_sec::gate::PermissionMode::FullAuto;
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

    /// 白名单前缀（缺口修复 2026-11-24：AGENTS.md 白名单拍板后从未接上，
    /// config 通道 v0.1 恒空=免确认通道空转）。按会话工作区解析：
    /// - 项目会话 → 项目根 AGENTS.md 的 ` ```bbc-whitelist ` 围栏块；
    /// - 日常会话 → 默认用户工作区 AGENTS.md（用户级通道）；
    /// - 未登记/未装配表 → 仅 config 全局通道（单测/嵌入式）。
    /// 与 config.whitelist_prefixes 合并去重；命中后仍受 gate 守卫
    /// （is_plain_direct_invocation + 危险规则扫描）——白名单只免确认不免规则。
    fn whitelist_for_session(&self, session_id: &str) -> Vec<String> {
        let mut out = self.config.whitelist_prefixes.clone();
        let Some(reg) = &self.config.session_workspaces else {
            return out;
        };
        let dir = match reg.get(session_id) {
            None => return out,
            Some(None) => self
                .config
                .default_workspace
                .clone()
                .unwrap_or_else(bbrt_sec::sandbox::default_user_workspace),
            Some(Some(ws)) => ws.clone(),
        };
        if let Some(entries) = self.agents_whitelist_cached(&dir) {
            for e in entries {
                if !out.contains(&e) {
                    out.push(e);
                }
            }
        }
        out
    }

    /// 读目录下 AGENTS.md 白名单（mtime 缓存：未变命中缓存，变了重解析）
    fn agents_whitelist_cached(&self, dir: &std::path::Path) -> Option<Vec<String>> {
        let md_path = dir.join("AGENTS.md");
        let mtime = std::fs::metadata(&md_path).ok()?.modified().ok()?;
        let mut cache = self.whitelist_cache.lock().ok()?;
        if let Some((cached_at, entries)) = cache.get(&md_path) {
            if *cached_at == mtime {
                return Some(entries.clone());
            }
        }
        let text = std::fs::read_to_string(&md_path).ok()?;
        let entries = crate::whitelist::parse_agents_whitelist(&text);
        cache.insert(md_path, (mtime, entries.clone()));
        Some(entries)
    }

    /// 替换注册表（bin 注入 app.*/技能合并后的注册表；10 篇 §4.6）
    pub fn with_registry(self, registry: ToolRegistry) -> Self {
        *self.registry.write().unwrap_or_else(|p| p.into_inner()) = registry;
        self
    }

    /// 注册表快照（只读访问；热重建下返回克隆避免调用方持锁跨步）
    pub fn registry(&self) -> ToolRegistry {
        self.registry
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// MCP 注册表热重建（D26 OQ-3 / D22 §5.3 收口）：宿主 mcp.config 下发后由
    /// bin 在后台线程调用——懒连新 server + 全量工具发现是慢操作，不阻塞宿主
    /// 消息循环；进行中 turn 用旧注册表跑完，下轮 tool_specs() 即新面。重建
    /// 语义=全量（内建 + 当前 MCP 发现），卸载/禁用 server 的工具随之移除。
    pub fn reload_mcp(&self) {
        let reg = build_registry(&self.config);
        *self.registry.write().unwrap_or_else(|p| p.into_inner()) = reg;
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

    /// hybrid 执行（run_command 专用）：DetachedCommand 统一底座——同步等待
    /// 至多 wait_secs，完成返回 Done（组装口径与同步 launcher 一致）；未完
    /// **不杀**返回 StillRunning（句柄移交 session 侧转后台，保住执行进度，
    /// 对齐 Claude Code「超时转后台」）。非 run_command 工具回落同步 execute。
    fn execute_or_handoff(
        &self,
        mode: bbrt_sec::gate::PermissionMode,
        call: &ToolInvocation,
        wait_secs: u64,
    ) -> bbrt_session::CommandHandoff {
        if call.name != "run_command" {
            return bbrt_session::CommandHandoff::Done(self.execute(mode, call));
        }
        let det = match self.spawn_background(call) {
            Ok(d) => d,
            // spawn 失败（校验拒绝/spawn 错误）→ 走同步 execute 复现同款 Blocked 语义
            Err(_e) => {
                return bbrt_session::CommandHandoff::Done(self.execute(mode, call));
            }
        };
        let mut det = det;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait_secs.max(1));
        loop {
            match det.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {}
            }
            if std::time::Instant::now() >= deadline {
                return bbrt_session::CommandHandoff::StillRunning(det);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let r = det.finish();
        let summary = builtin::cmd::exit_summary(&r);
        let outcome = if r.resource_killed {
            ToolOutcome::Blocked {
                code: 8022,
                summary: mask(&format!("进程资源超限被终止（8022）：{}ms", r.duration_ms)),
            }
        } else {
            ToolOutcome::Ok {
                summary: mask(&summary),
                truncated: r.truncated,
                exit_code: r.exit_code,
                duration_ms: r.duration_ms as u64,
            }
        };
        bbrt_session::CommandHandoff::Done(outcome)
    }

    /// 门控判定（§6 步骤 1-4 浓缩；不执行、不发审批）
    fn check(&self, mode: bbrt_sec::gate::PermissionMode, call: &ToolInvocation) -> CheckOutcome {
        // ① ToolDef 查询（§6 步骤 1：未注册 → 8002；读锁快照——热重建下不持锁跨步）
        let registered = self
            .registry
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(&call.name)
            .is_some();
        if !registered {
            return CheckOutcome::Deny {
                code: CODE_NO_PERMISSION_POINT,
                message: format!("工具 {} 未注册（8002）", call.name),
            };
        }
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
        let whitelist: Vec<String> = self.whitelist_for_session(&call.session_id);
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
            Decision::Allow { source } => {
                // 读审批追加判定（2026-11-26：读工具三档矩阵放行后，工作区外
                // 未授权读在 ask/auto-edit 弹卡、敏感读全档弹红卡）
                if builtin::read_access::is_read_tool(&call.name) {
                    let env = self.session_env_with_mode(&call.session_id, mode);
                    let target = builtin::read_access::read_target(&env.workspace, &args);
                    match self.read_access.decide(&env, &call.session_id, &target) {
                        builtin::read_access::ReadDecision::Allowed => {}
                        builtin::read_access::ReadDecision::NeedsApproval { sensitive, path } => {
                            return CheckOutcome::NeedConfirm {
                                reason: if sensitive {
                                    format!(
                                        "Agent 想读取敏感文件（密钥/凭据类，路径 {}）。批准后仅本次可读",
                                        path.display()
                                    )
                                } else {
                                    format!(
                                        "Agent 想读取工作区外的文件（{}）——不在当前工作区内",
                                        path.display()
                                    )
                                },
                                preview: ToolPreview {
                                    kind: if sensitive {
                                        "read-sensitive".into()
                                    } else {
                                        "read".into()
                                    },
                                    content: path.display().to_string(),
                                },
                                options: if sensitive {
                                    vec!["once".into()]
                                } else {
                                    vec!["once".into(), "session".into()]
                                },
                            };
                        }
                    }
                }
                CheckOutcome::Allow {
                    source: allow_source_str(&source),
                }
            }
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

    /// 逐调用风险级（P0 显示层对齐；ToolExecutor trait 覆写）：按 gate 分类
    /// 映射（ActionCategory::risk_level），run_command 以命令内容为准——只读/
    /// 白名单直调 low、任意命令 medium、规则命中 high；旧「按工具名静态表」
    /// （run_command 一律 high）退役。参数非法/未注册等异常 → medium（中性，
    /// 不放大也不掩盖；8002 语义由 check 负责）。
    /// 2026-11-26 读审批化：敏感文件读取标 high（审批卡红卡依据）。
    fn risk_of_call(&self, call: &ToolInvocation) -> &'static str {
        // 敏感读优先（只读类但碰密钥/凭据 → 红卡高危）
        if builtin::read_access::is_read_tool(&call.name) {
            if let Ok(args) = Self::parse_args(call) {
                let env = self.session_env(&call.session_id);
                let target = builtin::read_access::read_target(&env.workspace, &args);
                if bbrt_sec::sandbox::path::is_sensitive_file(
                    &bbrt_sec::sandbox::path::read_realpath(&target),
                ) {
                    return "high";
                }
            }
        }
        let args = match Self::parse_args(call) {
            Ok(v) => Self::gate_args(&call.name, &v),
            Err(_) => return "medium",
        };
        let permission_points: Vec<&str> = Vec::new();
        let whitelist = self.whitelist_for_session(&call.session_id);
        let ctx = GateCtx {
            policy: None,
            permission_points: &permission_points,
            memory: None,
            rules: &self.rules,
            whitelist_prefixes: &whitelist,
            untrusted: false,
        };
        let gate_call = GateCall {
            tool: &call.name,
            args: &args,
        };
        classify_action(&gate_call, &ctx).risk_level()
    }

    /// 执行（§6 步骤 5-7：沙箱校验 + 执行 + 脱敏；权限路径由调用方保证）。
    /// D19：workspace 类工具按会话解析执行环境——项目会话沙箱根=该项目目录
    /// （A 项目会话写 B 项目 → 预检 8020 + Seatbelt 内核双拦），日常会话=
    /// 默认用户工作区同款覆写（2026-11-12 修订：原整体拒绝废除）。
    fn execute(&self, mode: bbrt_sec::gate::PermissionMode, call: &ToolInvocation) -> ToolOutcome {
        let args = match Self::parse_args(call) {
            Ok(v) => v,
            Err(b) => return blocked(&b),
        };
        let ws_bound = WORKSPACE_BOUND_TOOLS.contains(&call.name.as_str());
        let env = if ws_bound {
            // full-auto 覆写（读审批化：工作区外非敏感读在 full-auto 放行的依据）
            self.session_env_with_mode(&call.session_id, mode)
        } else {
            self.env.clone()
        };
        // ⑥ 分发执行（未注册兜底 8002）。catch_unwind 兜底（8027，2026-11-23）：
        // builtin 实现 panic（现场：search_files 行截断落在多字节字符中间）裸穿会
        // 杀掉会话循环线程——tool.result/turn.end 永不发出，UI 永久「执行中」且
        // 「停止」旗标无人读取＝无法停止。panic 就地转工具错误，本轮继续收口。
        let result: Result<ExecOutput, ToolBlock> = match std::panic::catch_unwind(
            std::panic::AssertUnwindSafe(|| match call.name.as_str() {
            "read_file" => builtin::fs::read_file(&env, &args),
            "list_dir" => builtin::fs::list_dir(&env, &args),
            "write_file" => builtin::fs::write_file(&env, &args),
            "edit_file" => builtin::fs::edit_file(&env, &args),
            "glob_files" => builtin::search::glob_files(&env, &args),
            "grep_files" => builtin::search::grep_files(&env, &args),
            "run_command" => builtin::cmd::run(&env, &args),
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
            // D22/D26 自省面：已装插件与 MCP server 清单（inventory 内存快照）
            "list_plugins" => builtin::plugins::list_plugins(self.mcp.as_ref(), &args),
            // 任务感知工作台：工作台登记项目清单（本机登记表实时查询）
            "list_projects" => builtin::projects::list(self.config.store.as_ref(), &args),
            // 采纳已登记项目为会话工作根：校验通过后改会话工作区登记表，
            // 下个工具调用起 session_env 自动路由到项目目录
            "use_project" => builtin::projects::use_project(
                self.config.store.as_ref(),
                self.config.session_workspaces.as_ref(),
                &call.session_id,
                &args,
            ),
            // 任务感知工作台：历史对话检索/翻页/通读/最近会话（搜索默认排除当前会话）
            "session_search" => builtin::sessions::search(
                self.config.store.as_ref(),
                &call.session_id,
                &args,
            ),
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
            }),
        ) {
            Ok(r) => r,
            Err(payload) => {
                let msg = payload
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "未知 panic".into());
                // 宿主把 stderr 汇入 bbrt.log——留现场第一手 panic 原文便于归因
                eprintln!("[tools] 工具 {} panic（8027）: {msg}", call.name);
                Err(ToolBlock {
                    code: CODE_TOOL_PANIC,
                    message: format!("工具 {} 内部崩溃（8027）: {msg}", call.name),
                })
            }
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

    /// 审批通过后落记忆（§4.2；高危 permanent 由 GrantStore 硬名单拒绝）。
    /// 2026-11-26 读审批化：读工具路由到读授权登记表（once=精确票据 /
    /// session=父目录树；敏感恒精确票据），不走命令级 GrantStore
    fn record_grant(
        &self,
        _mode: bbrt_sec::gate::PermissionMode,
        call: &ToolInvocation,
        scope: GrantScope,
    ) -> Result<(), String> {
        if builtin::read_access::is_read_tool(&call.name) {
            let args = Self::parse_args(call).map_err(|b| b.message)?;
            let env = self.session_env(&call.session_id);
            let target = builtin::read_access::read_target(&env.workspace, &args);
            let resolved = bbrt_sec::sandbox::path::read_realpath(&target);
            let sensitive = bbrt_sec::sandbox::path::is_sensitive_file(&resolved);
            return self
                .read_access
                .record_grant(&call.session_id, &resolved, scope, sensitive);
        }
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
        self.registry
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .specs()
    }

    /// 用户随消息附带登记（2026-11-26：附件=用户亲自授权，工作区外读不弹卡）
    fn register_attachments(&self, session_id: &str, attachments: &[bbrt_context::AttachmentRef]) {
        self.read_access
            .register_attachments(session_id, attachments);
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 内建 + MCP 发现合并出注册表（构造期与 reload_mcp 热重建共用；D26 OQ-3）
fn build_registry(config: &ToolsConfig) -> ToolRegistry {
    let mut registry = ToolRegistry::builtin();
    register_mcp_tools(&mut registry, config);
    registry
}

/// MCP 发现条目 → ToolDef（纯映射；D14 §6.1）：风险级沿用 server 清单声明
/// （缺失默认 Medium）；动作类别按风险粗映射——Low→ReadOnly（矩阵放行）、
/// Medium→NetworkEgress（远程调用语义，ask/确认档）、High→CorpWrite
/// （公司域写全模式确认；09 §3.1 治理属性权威源不变）
fn mcp_tool_def(t: bbrt_mcp::ToolEntry) -> crate::registry::ToolDef {
    crate::registry::ToolDef {
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
            bbrt_protocol::RiskLevel::Medium => bbrt_sec::gate::ActionCategory::NetworkEgress,
            bbrt_protocol::RiskLevel::High => bbrt_sec::gate::ActionCategory::CorpWrite,
        },
    }
}

/// MCP 来源注入（连接期发现 → mcp_tool_def；同名覆盖——MCP 工具全名自带
/// server 命名空间，与内建不冲突）
fn register_mcp_tools(registry: &mut ToolRegistry, config: &ToolsConfig) {
    let Some(client) = &config.mcp else {
        return;
    };
    for t in client.list_tools(&config.mcp_policy) {
        registry.register(mcp_tool_def(t));
    }
}

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

#[cfg(test)]
mod registry_reload_tests {
    //! D26 OQ-3 收口单测：MCP 发现→ToolDef 映射 + 注册表热重建语义。
    //! （含真连接的懒连路径由 bbrt-mcp tests/mcp_stdio_test.rs reconfigure 用例覆盖）

    use super::{build_registry, mcp_tool_def, register_mcp_tools};
    use crate::config::ToolsConfig;
    use crate::registry::RiskLevel;
    use bbrt_mcp::{McpClient, ToolEntry};
    use bbrt_sec::gate::ActionCategory;
    use bbrt_session::ToolExecutor;

    fn entry(name: &str, risk: bbrt_protocol::RiskLevel) -> ToolEntry {
        ToolEntry {
            full_name: format!("mcp.fake.{name}"),
            server: "fake".into(),
            name: name.into(),
            description: format!("{name} desc"),
            input_schema: serde_json::json!({"type": "object"}),
            risk,
        }
    }

    /// mcp_tool_def 纯映射（打真函数）：Low→ReadOnly / Medium→NetworkEgress /
    /// High→CorpWrite；全名/描述/schema 保真
    #[test]
    fn mcp_tool_def_maps_risk_to_category() {
        let low = mcp_tool_def(entry("low_op", bbrt_protocol::RiskLevel::Low));
        assert_eq!(low.risk, RiskLevel::Low);
        assert_eq!(low.category, ActionCategory::ReadOnly);

        let mid = mcp_tool_def(entry("mid_op", bbrt_protocol::RiskLevel::Medium));
        assert_eq!(mid.risk, RiskLevel::Medium);
        assert_eq!(mid.category, ActionCategory::NetworkEgress);

        let high = mcp_tool_def(entry("high_op", bbrt_protocol::RiskLevel::High));
        assert_eq!(high.name, "mcp.fake.high_op");
        assert_eq!(high.risk, RiskLevel::High);
        assert_eq!(high.category, ActionCategory::CorpWrite);
        assert_eq!(high.input_schema, serde_json::json!({"type": "object"}));
    }

    /// mcp 未装配：reload_mcp 幂等无 panic，注册表=纯内建
    #[test]
    fn reload_without_mcp_keeps_builtin() {
        let ex = crate::PipelineExecutor::new(ToolsConfig::new("."));
        let before = ex.registry();
        ex.reload_mcp();
        assert_eq!(
            ToolExecutor::tool_specs(&ex).len(),
            before.specs().len(),
            "无 MCP 时重建=内建不变"
        );
        assert!(before.get("read_file").is_some(), "内建工具应在册");
    }

    /// 空 client（无 server 配置）：reload_mcp 后仍=内建（list_tools 空）
    #[test]
    fn reload_with_empty_client_keeps_builtin() {
        let (client, _) = McpClient::connect(&[], bbrt_mcp::no_token());
        let mut cfg = ToolsConfig::new(".");
        cfg.mcp = Some(std::sync::Arc::new(client));
        let ex = crate::PipelineExecutor::new(cfg);
        ex.reload_mcp();
        assert!(
            ex.registry()
                .names()
                .iter()
                .all(|n| !n.starts_with("mcp.")),
            "空连接表不应有 mcp.* 工具"
        );
    }

    /// register_mcp_tools 空 config（mcp=None）早退不 panic
    #[test]
    fn register_mcp_tools_without_client_is_noop() {
        let cfg = ToolsConfig::new(".");
        let mut reg = crate::registry::ToolRegistry::builtin();
        register_mcp_tools(&mut reg, &cfg);
        assert!(reg.names().iter().all(|n| !n.starts_with("mcp.")));
    }

    /// build_registry 与构造期一致（同一来源函数——回归护栏）
    #[test]
    fn build_registry_matches_builtin_when_no_mcp() {
        let cfg = ToolsConfig::new(".");
        let reg = build_registry(&cfg);
        let via_new = crate::PipelineExecutor::new(ToolsConfig::new("."));
        let mut a = reg.names().into_iter().map(str::to_string).collect::<Vec<_>>();
        let mut b = via_new.registry().names().into_iter().map(str::to_string).collect::<Vec<_>>();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b);
    }
}
