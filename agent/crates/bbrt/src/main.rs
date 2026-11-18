//! bbrt：Runtime 进程入口（D11 §1.2 装配）。
//!
//! 组装：hostapi stdio 传输 × SessionManager × bbrt-tools 管线 ×
//! bbrt-aigw 客户端 × bbrt-store(SQLite WAL) × bbrt-memory 双轨。
//!
//! 线程模型：主线程阻塞读 stdin 信封（REQ 分发）；user.message 的 turn
//! 在独立线程跑（流式事件经共享写锁即时外发）；审批回执经 BrtSink 的
//! request→session 路由表投递。
//!
//! 环境变量（宿主拉起时注入）：
//! - BBC_RT_DATA_DIR   数据目录（默认 {TMPDIR}/bbrt）
//! - BBC_RT_GATEWAY    AI 网关 base（默认 http://127.0.0.1:8091）
//! - BBC_RT_TOKEN      网关令牌（v0.1 静态；OBO 通道阶段二接 hostapi::OboCache）

mod bridge;
mod delegate_bridge;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bbrt_aigw::AigwClient;
use bbrt_hostapi::handshake;
use bbrt_hostapi::{IdGen, RuntimeHandler, StdioTransport};
use bbrt_memory::MemoryEngine;
use bbrt_protocol::{Envelope, HostToRuntime, RuntimeToHost};
use bbrt_session::events::ModelTier;
use bbrt_session::{LoopDeps, SessionManager, StartParams, ToolExecutor};
use bbrt_store::Store;

use bridge::BrtSink;

fn main() {
    if let Err(e) = run() {
        // fatal：退出前尽力吐 error 信封（D11 §4 error.fatal 语义）
        let _ = writeln!(std::io::stderr(), "bbrt fatal: {e}");
        if let Ok(env) = Envelope::wrap(
            1,
            "r-fatal",
            &RuntimeToHost::Error {
                code: 9000,
                message: e.to_string(),
                fatal: true,
                session_id: None,
            },
        ) {
            let mut out = std::io::stdout().lock();
            let _ = bbrt_protocol::codec::write_message(&mut out, &env);
            let _ = out.flush();
        }
        std::process::exit(1);
    }
}

/// stdin/stdout 双工：读独占 stdin 锁；写走全局 stdout()（内部自锁，turn 线程与主线程共用）
struct StdioDuplex {
    input: std::io::StdinLock<'static>,
}
impl Read for StdioDuplex {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.input.read(buf)
    }
}
impl Write for StdioDuplex {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        std::io::stdout().write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stdout().flush()
    }
}

fn run() -> Result<(), String> {
    let data_dir = PathBuf::from(std::env::var("BBC_RT_DATA_DIR").unwrap_or_else(|_| {
        std::env::temp_dir()
            .join("bbrt")
            .to_string_lossy()
            .into_owned()
    }));
    let gateway =
        std::env::var("BBC_RT_GATEWAY").unwrap_or_else(|_| "http://127.0.0.1:8091".into());
    let token = std::env::var("BBC_RT_TOKEN").unwrap_or_default();

    std::fs::create_dir_all(&data_dir).map_err(|e| format!("数据目录不可建: {e}"))?;

    // ── 装配 ──
    let store = Arc::new(Mutex::new(
        Store::open(&data_dir.join("runtime.db")).map_err(|e| format!("SQLite 打开失败: {e}"))?,
    ));
    // 启动清扫：上个进程遗留的进行中会话全部收口为 error（否则占名额且无法操作）
    {
        let swept = store
            .lock()
            .unwrap()
            .sweep_interrupted_on_boot()
            .unwrap_or(0);
        if swept > 0 {
            eprintln!("[boot] 清扫上个进程遗留会话 {swept} 个（进行中态→error）");
        }
    }
    let memory = Arc::new(
        // D23/M3：BBC_MEMORY_ROOT 覆盖记忆根（联调隔离——测试期 agent 脏记忆
        // 不污染日常 USER.md；与 BBC_RT_DEFAULT_WORKSPACE 同族 env 模式）
        MemoryEngine::open_root(
            &data_dir,
            std::env::var_os("BBC_MEMORY_ROOT").map(PathBuf::from),
            Arc::new(bbrt_memory::SystemClock),
        )
        .map_err(|e| format!("记忆引擎打开失败: {e}"))?,
    );

    // OBO 动态令牌：宿主 obo.token 写缓存，过期回退静态 BBC_RT_TOKEN（D11 §10.1）
    let obo = Arc::new(std::sync::Mutex::new(bbrt_hostapi::OboCache::default()));
    // MCP client（D11 §2.10 / D14 §6）：BBC_RT_MCP_SERVERS="name=cmd;name2=cmd --flag"
    // （stdio 本地 server v0.1；远程 HTTP 网关接入后扩展）。主体令牌逐请求现取
    // OboCache（D14 §6.2 三层身份）；单 server 连接失败降级不阻塞
    let mcp_configs = parse_mcp_servers(&std::env::var("BBC_RT_MCP_SERVERS").unwrap_or_default());
    let obo_for_mcp = Arc::clone(&obo);
    let mcp_tokens: bbrt_mcp::TokenProvider = Arc::new(move || {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        obo_for_mcp
            .lock()
            .ok()
            .and_then(|c| c.get(now).map(str::to_string))
    });
    let (mcp_client, mcp_results) = bbrt_mcp::McpClient::connect(&mcp_configs, mcp_tokens);
    let mcp_client = Arc::new(mcp_client); // dispatch（mcp.config 重配）与工具管线共享
    for (name, r) in &mcp_results {
        if let Err(e) = r {
            eprintln!("[bbrt] MCP server '{name}' 连接降级: {e}");
        }
    }
    // 专家库同步（D14 §5 分发阶段一）：BBC_RT_EXPERTS_URL 指向服务端
    // /api/v1/eco/experts（公开只读）→ 清单 → 逐个下载落 {dataDir}/eco/experts/
    // （ExpertIndex 扫描格式；本地手放文件共存——远端不覆盖本地同名，登记）。
    // 失败降级不阻塞启动（内网断连=沿用上次同步产物）
    if let Ok(base) = std::env::var("BBC_RT_EXPERTS_URL") {
        sync_experts(&data_dir, &base);
    }

    // 技能索引（10 篇 §4.5 + D22/L3）：多根扫描=生态根 {dataDir}/eco/skills
    // + 各启用插件版本目录 skills；tools.reload 热重载同口径
    let skills_index = Arc::new(Mutex::new(bbrt_session::SkillIndex::scan_roots(
        &skill_roots(&data_dir),
    )));
    // D19 会话工作区表（manager 与 tools 管线共享：start/end 维护，
    // 工具执行按会话解析沙箱根）
    let session_workspaces = bbrt_session::SessionWorkspaces::new();
    let tools = Arc::new(bbrt_tools::PipelineExecutor::new(bbrt_tools::ToolsConfig {
        // D19：兜底根置空=未登记会话一切读写被拒（安全失败方向）；真实会话
        // 恒经 session_workspaces 表路由到各自项目目录（修旧全局 "." 占位缺口）
        workspace: PathBuf::new(),
        launcher: None, // D32 起 launcher 无探测/等级概念（None=default 进程执行器）
        memory: Some(memory.clone()),
        // 恒 Some（D22/L3）：空配置零成本（连接表空），插件 mcp.config 动态
        // 下发后无需重启即注入工具面
        mcp: Some(mcp_client.clone()),
        session_workspaces: Some(session_workspaces.clone()),
        // D33 §3.1：skill 工具与组装/tools.reload 热重扫共用同一索引实例
        skills: Some(skills_index.clone()),
        ..Default::default()
    }));
    let obo_for_model = Arc::clone(&obo);
    let static_token = token.clone();
    let model = Arc::new(AigwClient::new(&gateway, move || {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        obo_for_model
            .lock()
            .ok()
            .and_then(|c| c.get(now).map(str::to_string))
            .unwrap_or_else(|| static_token.clone())
    }));
    // D23/M2：公共层压实器接线（USER.md 超 3000 字时仅软条目进 bbc-fast 凝缩，
    // 禁止/授权硬条目引擎侧结构性隔离不进 LLM；失败保留旧视图）
    memory.set_compactor(Some(Arc::new(bbrt_session::FastCompactor::new(
        model.clone(),
    ))));

    // 专家会诊启用（D14 §3.3 / D16 P1-5）：本地专家库扫描（含 .override.yaml
    // 覆写合并——D16 §6 三层配置）→ FastCaster 快模型选角（判定优先于探查）。
    // 空库零成本（manifests_empty 直接不组队）；选角是优化不是依赖，降级语义同探查
    let expert_index = bbrt_session::team::ExpertIndex::scan(&data_dir.join("eco/experts"));
    let skills_for_cast = skills_index.clone();
    let tools_for_cast: Arc<dyn ToolExecutor> = tools.clone();
    let caster = Arc::new(bbrt_session::team::FastCaster {
        index: expert_index,
        // 装配闭包：manifest ∩ 工具注册表（含 MCP）∩ 技能库；租户策略
        // （AssemblePolicy.deny_tools）随策略面接线注入，v0.1 空策略
        assemble_for: move |m| {
            bbrt_session::expert::assemble(
                m,
                &tools_for_cast.tool_specs(),
                &skills_for_cast.lock().unwrap(),
                &bbrt_session::expert::AssemblePolicy::default(),
            )
        },
    });

    let sink = Arc::new(BrtSink {
        pending: Mutex::new(std::collections::HashMap::new()),
        seq: Mutex::new(0),
    });
    let deps = LoopDeps {
        model,
        tools,
        delegator: Some(delegate_bridge::bin_delegate_launcher()
            as Arc<dyn bbrt_session::delegation::DelegateLauncher>),
        memory: Some(memory.clone()),
        wal: store.clone(),
        sink: sink.clone(),
        skills: skills_index.clone(),
        fanout: Some(Arc::new(bbrt_session::FastPlanner)),
        experts: Some(caster),
        budget: Default::default(),
    };
    let mut mgr_build = SessionManager::new(deps, Some(store.clone()));
    mgr_build.workspaces = session_workspaces;
    let mgr = Arc::new(mgr_build);

    // ── stdio：StdioTransport 双工（写共用全局 stdout）──
    let mut transport = StdioTransport::new(StdioDuplex {
        input: std::io::stdin().lock(),
    });
    let mut ids = IdGen::new();

    // 握手（10s 首条 initialize；版本协商按 D11 §10.2）——handler 提供 capabilities
    let handler = RtHandler {
        mgr: mgr.clone(),
        memory: memory.clone(),
    };
    let _outcome = handshake::handshake(&mut transport, &handler, &mut ids)
        .map_err(|e| format!("握手失败: {e}"))?;

    // runtime.ready（D11 §4：可接收 session.start 信号）
    send(
        &mut ids,
        &RuntimeToHost::RuntimeReady {
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            active_sessions: mgr.active_count() as u32,
            wal_healthy: true,
        },
    );

    // OBO 续签看护（D11 §10.1：到期前 2min 触发 obo.renew；宿主回 obo.token NTF
    // → dispatch 更新缓存 → 模型令牌闭包自动取新值）。REQ 走全局 stdout 直写，
    // 与主循环写路径互不持锁（stdout 内部自锁）
    {
        let obo_watch = Arc::clone(&obo);
        let renew_seq = Arc::new(std::sync::Mutex::new(0u64));
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            // 仅"已有令牌且进入到期窗口"才续签：无缓存不请求——宿主在首个需要 OBO 的
            // 调用前主动发放（D11 §10.1 会话启动行），空缓存轮询会刷屏
            let needs = obo_watch
                .lock()
                .map(|c| c.get(0).is_some() && c.needs_renew(now))
                .unwrap_or(false);
            if !needs {
                continue;
            }
            let mut n = renew_seq.lock().unwrap();
            *n += 1;
            if let Ok(env) = Envelope::wrap(
                1,
                format!("r-obo-{n}"),
                &RuntimeToHost::OboRenew {
                    scopes: vec![],
                    reason: bbrt_protocol::RenewReason::Expiring,
                },
            ) {
                write_env(&env);
            }
        });
    }

    // 主循环：阻塞读信封 → 分发（REQ 成对回执带 reply_to）
    loop {
        let env = match transport.recv() {
            Ok(Some(e)) => e,
            Ok(None) => return Ok(()), // EOF 优雅退出
            Err(_) => continue,        // 坏行：codec 已丢弃（忽略+计数对齐 D11 §4）
        };
        let reply = dispatch(
            &mgr,
            &memory,
            &sink,
            &store,
            &obo,
            &skills_index,
            &mcp_client,
            &data_dir,
            &mut ids,
            &env,
        );
        if let Some(msg) = reply {
            if let Ok(mut ack) = Envelope::wrap(1, format!("r-{}", ids.next_id()), &msg) {
                ack.reply_to = Some(env.id.clone());
                write_env(&ack);
            }
        }
    }
}

/// host→runtime 分发；REQ 返回成对回执
/// （宿主协议分发天然多依赖——装配态参数群，阶段二若继续膨胀引入 Ctx 结构体收敛）
#[allow(clippy::too_many_arguments)]
fn dispatch(
    mgr: &Arc<SessionManager>,
    memory: &Arc<MemoryEngine>,
    sink: &Arc<BrtSink>,
    store: &Arc<Mutex<Store>>,
    obo: &Arc<std::sync::Mutex<bbrt_hostapi::OboCache>>,
    skills: &Arc<Mutex<bbrt_session::SkillIndex>>,
    mcp: &Arc<bbrt_mcp::McpClient>,
    data_dir: &std::path::Path,
    ids: &mut IdGen,
    env: &Envelope,
) -> Option<RuntimeToHost> {
    let msg: HostToRuntime = match serde_json::from_value(envelope_payload(env)) {
        Ok(m) => m,
        Err(_) => {
            return Some(RuntimeToHost::Error {
                code: 9001,
                message: "payload 解析失败".into(),
                fatal: false,
                session_id: None,
            });
        }
    };
    match msg {
        HostToRuntime::Ping => Some(RuntimeToHost::Pong),
        // 宿主发放/续签 OBO 令牌（NTF；缓存后模型通道自动切换，D11 §10.1）
        HostToRuntime::OboToken { token, exp, scopes } => {
            if let Ok(mut c) = obo.lock() {
                c.set(token, exp, scopes);
            }
            None
        }
        HostToRuntime::Initialize { .. } => Some(RuntimeToHost::InitializeResult {
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            tools: vec![],
            capabilities: vec![
                "session".into(),
                "tools".into(),
                "memory".into(),
            ],
        }),
        HostToRuntime::SessionStart {
            session_id,
            workspace,
            mode,
            model_policy,
            model,
            history_ref,
            title,
            ..
        } => {
            let tier = match model_policy {
                bbrt_protocol::ModelPolicy::Fast => ModelTier::Fast,
                _ => ModelTier::Strong,
            };
            let sec_mode = match mode {
                bbrt_protocol::PermissionMode::Ask => bbrt_sec::gate::PermissionMode::Ask,
                bbrt_protocol::PermissionMode::AutoEdit => bbrt_sec::gate::PermissionMode::AutoEdit,
                bbrt_protocol::PermissionMode::FullAuto => bbrt_sec::gate::PermissionMode::FullAuto,
            };
            // 崩溃恢复（D11 §9.2）：historyRef 指向本地事件镜像 → 先重放再启动
            let restored = history_ref.as_ref().and_then(|_| {
                let guard = store.lock().ok()?;
                let rep = bbrt_session::recover(&guard, &session_id);
                if rep.broken > 0 {
                    send(
                        ids,
                        &RuntimeToHost::Error {
                            code: 8012,
                            message: format!(
                                "重放检测到 {} 处事件断裂，历史为尽力恢复",
                                rep.broken
                            ),
                            fatal: false,
                            session_id: Some(session_id.clone()),
                        },
                    );
                }
                Some(rep)
            });
            match mgr.start(
                session_id.clone(),
                StartParams {
                    workspace,
                    mode: sec_mode,
                    model_policy: tier,
                    model_override: model,
                    // 2026-11-11：宿主可带初始标题（embedded 会话来源名）；缺省=库默认口径
                    title: title.unwrap_or_else(|| "新会话".into()),
                    restored,
                },
            ) {
                Ok(rep) => Some(RuntimeToHost::SessionReady {
                    session_id,
                    restored: rep.restored,
                    replayed_events: Some(rep.replayed_events),
                    warnings: vec![],
                }),
                Err(e) => Some(RuntimeToHost::Error {
                    code: 8001,
                    message: e.to_string(),
                    fatal: false,
                    session_id: Some(session_id),
                }),
            }
        }
        HostToRuntime::UserMessage {
            session_id,
            text,
            thinking,
            ..
        } => {
            let mgr2 = mgr.clone();
            let store2 = store.clone();
            let sid = session_id.clone();
            // turn 独立线程：流式事件经共享 stdout 即时外发
            std::thread::spawn(move || {
                let report = match mgr2.run_turn(&sid, &text, thinking) {
                    Ok(r) => r,
                    // 会话复活（2026-11-11 用户裁决：会话=上下文，无不可逆终态）：
                    // ended/error/重启清扫后的会话 input 即复活——从库行还原参数、
                    // 重放事件镜像续上下文后再投本轮
                    Err(bbrt_session::ManagerError::NotFound(_)) => {
                        match revive_session(&store2, &mgr2, &sid) {
                            Ok(true) => match mgr2.run_turn(&sid, &text, thinking) {
                                Ok(r) => r,
                                Err(e) => {
                                    emit_turn_error(&sid, &e.to_string());
                                    return;
                                }
                            },
                            Ok(false) => {
                                emit_turn_error(&sid, "会话不存在（库中无行）");
                                return;
                            }
                            Err(e) => {
                                emit_turn_error(&sid, &e);
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        emit_turn_error(&sid, &e.to_string());
                        return;
                    }
                };
                let _ = report;
            });
            // 回执=状态镜像（协议无独立 ack 变体，D11 §4 user.message"接受入队"）
            Some(RuntimeToHost::SessionStateReport {
                session_id,
                state: bbrt_protocol::SessionState::Running,
                reason: "queued".into(),
            })
        }
        HostToRuntime::PermissionResponse {
            request_id,
            decision,
            scope,
            edited_args,
            ..
        } => {
            let resp = bbrt_session::loop_runner::PermissionResponse {
                request_id,
                decision: match decision {
                    bbrt_protocol::Decision::Allow => {
                        bbrt_session::loop_runner::PermissionDecision::Allow
                    }
                    bbrt_protocol::Decision::Deny => {
                        bbrt_session::loop_runner::PermissionDecision::Deny
                    }
                },
                scope: match scope {
                    bbrt_protocol::GrantScope::Once => bbrt_sec::memory::GrantScope::Once,
                    bbrt_protocol::GrantScope::Session => bbrt_sec::memory::GrantScope::Session,
                    bbrt_protocol::GrantScope::Permanent => bbrt_sec::memory::GrantScope::Permanent,
                },
                edited: edited_args.map(|v| v.to_string()),
            };
            // permission.response 无会话字段：按 BrtSink 登记的 request→session 路由表投递
            if let Some(sid) = sink.route_of(&resp.request_id) {
                let _ = mgr.respond_permission(&sid, resp);
            }
            None // 循环层的 PermissionResolved 镜像事件即回显
        }
        // D20 澄清回答：按 question→session 路由表投递，循环层镜像事件即回显
        HostToRuntime::ClarifyResponse {
            question_id,
            answers,
            free_text,
        } => {
            let ans = bbrt_session::loop_runner::ClarifyAnswer {
                question_id: question_id.clone(),
                answers,
                free_text,
            };
            if let Some(sid) = sink.route_of(&question_id) {
                let _ = mgr.respond_clarify(&sid, ans);
            }
            None
        }
        // 2026-11-11：中断当前轮（取代旧 session.pause 用户通道）——置旗即回执，
        // 实际中断在流内/工具间检查点生效，收口以 session.state(idle) 上行为准
        HostToRuntime::SessionInterrupt { session_id } => {
            let _ = mgr.interrupt(&session_id);
            Some(RuntimeToHost::SessionInterrupted { session_id })
        }
        // 2026-11-11：会话重命名——直接落库（会话不须在运行态；历史会话也可改名）
        HostToRuntime::SessionRename { session_id, title } => match store.lock() {
            Ok(guard) => match guard.rename_session(&session_id, &title) {
                Ok(0) => Some(RuntimeToHost::Error {
                    code: 8001,
                    message: format!("会话不存在: {session_id}"),
                    fatal: false,
                    session_id: Some(session_id.clone()),
                }),
                Ok(_) => Some(RuntimeToHost::SessionRenamed {
                    session_id,
                    title: title.trim().chars().take(60).collect::<String>()
                        + if title.trim().chars().count() > 60 {
                            "…"
                        } else {
                            ""
                        },
                }),
                Err(e) => Some(RuntimeToHost::Error {
                    code: 9001,
                    message: e.to_string(),
                    fatal: false,
                    session_id: Some(session_id),
                }),
            },
            Err(_) => Some(RuntimeToHost::Error {
                code: 9001,
                message: "store 锁中毒".into(),
                fatal: false,
                session_id: Some(session_id),
            }),
        },
        HostToRuntime::SessionEnd { session_id, .. } => {
            let _ = mgr.end(&session_id, "");
            Some(RuntimeToHost::SessionEnded {
                session_id,
                summary: String::new(),
            })
        }
        // 会话历史（工作台打开会话加载聊天记录）：直读 WAL——会话不须在运行态，
        // 历史/结束会话同样可查（与 rename 直落库同口径）
        HostToRuntime::SessionHistory { session_id } => {
            let events = match store.lock() {
                Ok(g) => g.events_after(&session_id, 0, 10_000).unwrap_or_default(),
                Err(_) => vec![],
            };
            Some(RuntimeToHost::SessionHistoryResult {
                items: bbrt_session::recovery::wal_history(&events),
                session_id,
            })
        }
        // run 历史（D33 §3.3 子 agent 侧栏回放）：agent_event 按 run_id 过滤
        // 投影——spawn→User / trace→Assistant·Tool；与 session.history 同口径
        // 直读 WAL（run 不须在运行态）
        HostToRuntime::RunHistory { run_id } => {
            let events = match store.lock() {
                Ok(g) => g.events_by_run(&run_id, 10_000).unwrap_or_default(),
                Err(_) => vec![],
            };
            Some(RuntimeToHost::RunHistoryResult {
                items: bbrt_session::recovery::wal_run_history(&events),
                run_id,
            })
        }
        HostToRuntime::MemoryList {
            scope,
            workspace_path,
            ..
        } => {
            // D19 作用域列表：缺省/User=用户级（旧口径兼容）；Project+路径=该项目
            // 分区；Project 无路径=全部分区合并（workspace_name=分区名）
            let mem_items = |entries: Vec<bbrt_memory::MemorySummary>,
                             scope_tag: Option<bbrt_protocol::MemoryScope>,
                             ws_name: Option<String>| {
                entries
                    .into_iter()
                    .map(|e| bbrt_protocol::MemoryListItem {
                        name: e.name,
                        title: e.title,
                        memory_type: match e.mtype {
                            bbrt_memory::MemoryType::User => "user".into(),
                            bbrt_memory::MemoryType::Project => "project".into(),
                            bbrt_memory::MemoryType::Feedback => "feedback".into(),
                            bbrt_memory::MemoryType::Reference => "reference".into(),
                        },
                        // MemorySummary.updated_at 为 RFC3339 字符串；协议要毫秒——解析失败回 0（展示层兜底）
                        updated_at: chrono_free_ms(&e.updated_at),
                        hook: e.hook,
                        scope: scope_tag,
                        workspace_name: ws_name.clone(),
                        global_type: None,
                    })
                    .collect::<Vec<_>>()
            };
            let items = match scope {
                Some(bbrt_protocol::MemoryScope::Project) => match workspace_path.as_deref() {
                    Some(p) if !p.is_empty() => {
                        let path = std::path::PathBuf::from(p);
                        let key =
                            bbrt_memory::scope_key(&std::fs::canonicalize(&path).unwrap_or(path));
                        mem_items(
                            memory.list_scoped(Some(std::path::Path::new(p))),
                            Some(bbrt_protocol::MemoryScope::Project),
                            Some(key),
                        )
                    }
                    _ => memory
                        .list_project_partitions()
                        .into_iter()
                        .flat_map(|(key, entries)| {
                            mem_items(
                                entries,
                                Some(bbrt_protocol::MemoryScope::Project),
                                Some(key),
                            )
                        })
                        .collect(),
                },
                _ => {
                    // D23：缺省/User 作用域=公共层 USER.md 压实视图条目——
                    // 直读 replay（带十类标签），删除走 memory.forget
                    memory
                        .global()
                        .replay()
                        .into_iter()
                        .map(|e| bbrt_protocol::MemoryListItem {
                            // name=title=条目全文（forget 的 contains 精确键）
                            name: e.text.clone(),
                            title: e.text.clone(),
                            memory_type: "user".into(),
                            updated_at: 0, // 视图无元数据（D23 拍板 #6）
                            hook: String::new(),
                            scope: None,
                            workspace_name: None,
                            global_type: Some(e.gtype.label().to_string()),
                        })
                        .collect()
                }
            };
            Some(RuntimeToHost::MemoryListResult { items })
        }
        HostToRuntime::MemoryDelete {
            name,
            scope,
            workspace_path,
        } => Some(RuntimeToHost::MemoryDeleteResult {
            ok: memory
                .delete_scoped(
                    match scope {
                        Some(bbrt_protocol::MemoryScope::Project) => {
                            workspace_path.as_deref().map(std::path::Path::new)
                        }
                        _ => None,
                    },
                    &name,
                )
                .unwrap_or(false),
        }),
        // D23 §3.5/M3：公共层条目移除（记忆页撤销按钮；条目粒度 tombstone）
        HostToRuntime::MemoryForget {
            memory_type,
            contains,
        } => {
            let removed = match bbrt_memory::GlobalType::parse(&memory_type) {
                Some(gtype) => memory
                    .forget_global(gtype, &contains, "host-ui")
                    .unwrap_or_default(),
                None => vec![],
            };
            Some(RuntimeToHost::MemoryForgetResult { removed })
        }
        // ── D19 项目/日常双区 ──
        HostToRuntime::WorkspaceRegister { path, name } => {
            // realpath 归一 upsert（同目录重复打开不换身份）；登记后取全行回执
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let real = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
            let registered = store.lock().ok().and_then(|s| {
                bbrt_session::register_workspace(&s, &real.to_string_lossy(), name.as_deref(), now);
                s.get_workspace_by_path(&real.to_string_lossy())
                    .ok()
                    .flatten()
            });
            match registered {
                Some(w) => Some(RuntimeToHost::WorkspaceRegistered { item: ws_item(&w) }),
                None => Some(RuntimeToHost::Error {
                    code: 8002,
                    message: format!("项目登记失败（存储不可用）: {path}"),
                    fatal: false,
                    session_id: None,
                }),
            }
        }
        HostToRuntime::WorkspaceList => {
            let items = store
                .lock()
                .ok()
                .and_then(|s| s.list_workspaces().ok())
                .unwrap_or_default()
                .iter()
                .map(ws_item)
                .collect();
            Some(RuntimeToHost::WorkspaceListed { items })
        }
        HostToRuntime::WorkspaceForget { id } => {
            let ok = store
                .lock()
                .ok()
                .and_then(|s| s.remove_workspace(&id).ok())
                .unwrap_or(false);
            Some(RuntimeToHost::WorkspaceForgot { ok })
        }
        HostToRuntime::SessionList { limit } => {
            // D19 持久会话列表（宿主重启恢复数据源；活跃状态由宿主缓存叠加）
            let items = store
                .lock()
                .ok()
                .and_then(|s| s.list_sessions_with_workspace(limit.unwrap_or(50)).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|r| bbrt_protocol::SessionListItem {
                    id: r.id,
                    title: r.title,
                    workspace: r.workspace,
                    mode: r.mode,
                    model_policy: r.model_policy,
                    model_override: r.model_override,
                    status: r.status,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                    ended_at: r.ended_at,
                    summary: r.summary,
                })
                .collect();
            Some(RuntimeToHost::SessionListed { items })
        }
        HostToRuntime::ModelSwitch {
            session_id,
            to,
            model,
            reason,
        } => {
            // model.switched 产生方（D11 §4）：空闲会话切换；turn 中跳过。
            // model=直达引用（0023）透传；缺省=清 override 回 to 档位
            let tier = match to {
                bbrt_protocol::ModelPolicy::Fast => bbrt_session::ModelTier::Fast,
                bbrt_protocol::ModelPolicy::Strong => bbrt_session::ModelTier::Strong,
                bbrt_protocol::ModelPolicy::Auto => bbrt_session::ModelTier::Strong,
            };
            let _ = mgr.switch_model(
                session_id.as_deref(),
                tier,
                model.as_deref(),
                reason.as_deref().unwrap_or("user"),
            );
            None
        }
        HostToRuntime::DelegateLaunch {
            session_id,
            delegate_task_id,
            backend,
            task_brief,
            ..
        } => {
            // 简报阶段确认：run 尚未后台化（hub 未注册），按 session 定向
            mgr.respond_delegate(
                &delegate_task_id,
                &session_id,
                bbrt_session::loop_runner::DelegateHostMsg::Launch {
                    backend,
                    brief: task_brief, // None=沿用模型原稿（D16：确认不改稿是主路径）
                },
            )
            .ok();
            None // 委派事件流（delegate.event/end）即回显
        }
        HostToRuntime::DelegateInput {
            delegate_task_id,
            text,
        } => {
            mgr.respond_delegate(
                &delegate_task_id,
                "",
                bbrt_session::loop_runner::DelegateHostMsg::Input { text },
            )
            .ok();
            None
        }
        HostToRuntime::DelegateCancel {
            delegate_task_id,
            graceful,
        } => {
            mgr.respond_delegate(
                &delegate_task_id,
                "",
                bbrt_session::loop_runner::DelegateHostMsg::Cancel { graceful },
            )
            .ok();
            None
        }
        HostToRuntime::DelegateReview {
            delegate_task_id,
            decision,
            ..
        } => {
            let accept = matches!(decision, bbrt_protocol::ReviewDecision::Accept);
            mgr.respond_delegate(
                &delegate_task_id,
                "",
                bbrt_session::loop_runner::DelegateHostMsg::Review { accept },
            )
            .ok();
            None
        }
        // run 清单（D16 §3.1：agent_run 投影；run 面板/审计检索）
        HostToRuntime::RunsList { session_id } => Some(RuntimeToHost::RunsListResult {
            items: mgr.list_runs(session_id.as_deref()),
        }),
        // 工具/技能热重载（10 篇 §4.5：宿主安装/更新/卸载技能包后 tools.reload
        // {reason:skill}；App/Policy/Plugin 亦触发技能重扫——生态内容变更的
        // 统一失效信号。D22/L3：扫描多根=生态根+各启用插件版本目录）
        HostToRuntime::ToolsReload { .. } => {
            if let Ok(mut idx) = skills.lock() {
                *idx = bbrt_session::SkillIndex::scan_roots(&skill_roots(data_dir));
            }
            None // 效果经后续轮次注入体现（协议无独立回执变体）
        }
        // MCP 装配动态下发（NTF；D22 §5.3/L3：宿主推全量——系统级+插件级合并、
        // PLUGIN_ROOT 已替换；按名重配=未变保留/变了断开/新增懒连/移除断开）
        HostToRuntime::McpConfig { servers } => {
            let configs = servers.iter().map(wire_to_mcp_config).collect();
            mcp.reconfigure(configs);
            None
        }
        // 个人 MCP server 连接测试（REQ；D26 §6）：一次性 McpConnection 即弃
        // ——TLS/TOKEN 动态注入全走生产代码路径，测的就是真实链路。stdio 冷启动
        // （node ~1s）由宿主 request 侧超时兜底；不套租户策略（测连通与工具发现）
        HostToRuntime::McpTest { server } => {
            let tokens: bbrt_mcp::TokenProvider = {
                let obo = Arc::clone(obo);
                Arc::new(move || {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    obo.lock().ok().and_then(|c| c.get(now).map(str::to_string))
                })
            };
            let cfg = wire_to_mcp_config(&server);
            let name = server.name.clone();
            let mk = |ok: bool, tools: Vec<String>, error: Option<String>| {
                Some(RuntimeToHost::McpTestResult {
                    name: name.clone(),
                    ok,
                    tools,
                    error,
                })
            };
            match bbrt_mcp::McpConnection::connect(&cfg, tokens) {
                Ok(mut conn) => match conn.list_tools() {
                    Ok(tools) => mk(
                        true,
                        // server 侧原工具名（短名；全名= mcp.{name}.{tool} 可推导）
                        tools.into_iter().map(|t| t.name).collect(),
                        None,
                    ),
                    Err(e) => mk(false, vec![], Some(format!("工具发现失败: {e}"))),
                },
                Err(e) => mk(false, vec![], Some(format!("连接失败: {e}"))),
            }
        }
        _ => None, // 其余 REQ 阶段二；NTF 误投忽略
    }
}

/// 专家库同步：清单（scope=all published）→ 下载 → 落 eco/experts/*.yaml。
/// 文件名 = expert_id 的 '.' 换 '_'（corp.x → corp_x.yaml）；本地同名不
/// 覆盖（用户手改保护）；单条失败跳过继续。
fn sync_experts(data_dir: &std::path::Path, base: &str) {
    let dir = data_dir.join("eco/experts");
    if std::fs::create_dir_all(&dir).is_err() {
        eprintln!("[bbrt] 专家目录不可建，跳过同步");
        return;
    }
    let base = base.trim_end_matches('/');
    let list_url = format!("{base}?scope=all");
    let Ok(list_json) = bbrt_mcp::http::get_text(&list_url) else {
        eprintln!("[bbrt] 专家库清单拉取失败（沿用本地）: {list_url}");
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&list_json) else {
        eprintln!("[bbrt] 专家库清单解析失败");
        return;
    };
    let empty = vec![];
    let items = v.get("data").and_then(|d| d.as_array()).unwrap_or(&empty);
    let mut synced = 0usize;
    for item in items {
        let (Some(id), Some(expert_id)) = (
            item.get("id").and_then(|x| x.as_str()),
            item.get("expert_id").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        let dl_url = format!("{base}/{id}/download");
        let Ok(yaml) = bbrt_mcp::http::get_text(&dl_url) else {
            eprintln!("[bbrt] 专家 {expert_id} 下载失败，跳过");
            continue;
        };
        let fname = format!("{}.yaml", expert_id.replace('.', "_"));
        let path = dir.join(&fname);
        if path.exists() {
            continue; // 本地同名不覆盖（手改保护）
        }
        if std::fs::write(&path, &yaml).is_ok() {
            synced += 1;
        }
    }
    if synced > 0 {
        eprintln!("[bbrt] 专家库同步 +{synced}（{dir:?}）");
    }
}

/// 技能扫描根集合（D22 §5.3/L3）：生态根在前（同名技能优先）+ 各启用插件
/// activeVersion 目录的 skills 根。插件根=读 {dataDir}/eco/plugins/{id}/
/// plugin-state.json（enabled=true 且 activeVersion 非空）；state 缺失/坏
/// JSON 跳过该插件。
fn skill_roots(data_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut roots = vec![data_dir.join("eco/skills")];
    let plugins_dir = data_dir.join("eco/plugins");
    let Ok(rd) = std::fs::read_dir(&plugins_dir) else {
        return roots;
    };
    let mut plugin_ids: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    plugin_ids.sort();
    for id in plugin_ids {
        let base = plugins_dir.join(&id);
        let Ok(state) = std::fs::read_to_string(base.join("plugin-state.json")) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&state) else {
            continue;
        };
        let enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
        let Some(ver) = v.get("activeVersion").and_then(|x| x.as_str()) else {
            continue;
        };
        if !enabled || ver.is_empty() {
            continue;
        }
        let skills = base.join(ver).join("skills");
        if skills.is_dir() {
            roots.push(skills);
        }
    }
    roots
}

/// mcp.config wire → McpServerConfig（env map → Vec 对，保序无要求）
fn wire_to_mcp_config(w: &bbrt_protocol::McpServerWire) -> bbrt_mcp::McpServerConfig {
    use bbrt_protocol::McpTransportWire;
    let transport = match &w.transport {
        McpTransportWire::Stdio { command, args, env } => bbrt_mcp::TransportConfig::Stdio {
            command: command.clone(),
            args: args.clone(),
            env: env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        },
        McpTransportWire::Http { base_url, headers } => bbrt_mcp::TransportConfig::Http {
            base_url: base_url.clone(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        },
    };
    bbrt_mcp::McpServerConfig {
        name: w.name.clone(),
        transport,
    }
}

/// BBC_RT_MCP_SERVERS="corp=http://127.0.0.1:8090/mcp/corp;fake=fake-server --flag"
/// （值 http(s):// 前缀=远程 MCP 端点（公司域 mcpgw 或外部 https server——
/// D26 §5 TLS）；否则=stdio 本地子进程命令行）
fn parse_mcp_servers(raw: &str) -> Vec<bbrt_mcp::McpServerConfig> {
    raw.split(';')
        .filter_map(|seg| {
            let seg = seg.trim();
            if seg.is_empty() {
                return None;
            }
            let (name, target) = seg.split_once('=')?;
            let name = name.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let t = target.trim_start();
            let transport = if t.starts_with("http://") || t.starts_with("https://") {
                bbrt_mcp::TransportConfig::Http {
                    base_url: target.trim().to_string(),
                    headers: vec![], // env 通道无自定义头（插件级经 mcp.config wire 携带）
                }
            } else {
                let mut parts = target.split_whitespace();
                let command = parts.next()?.to_string();
                bbrt_mcp::TransportConfig::Stdio {
                    command,
                    args: parts.map(str::to_string).collect(),
                    env: vec![],
                }
            };
            Some(bbrt_mcp::McpServerConfig { name, transport })
        })
        .collect()
}

/// D19 agent_workspace 行 → 协议 WorkspaceItem 投影（extra_dirs 不透出）
fn ws_item(w: &bbrt_store::Workspace) -> bbrt_protocol::WorkspaceItem {
    bbrt_protocol::WorkspaceItem {
        id: w.id.clone(),
        path: w.path.clone(),
        name: w.name.clone(),
        is_repo: w.is_repo,
        trusted: w.trusted,
        last_opened_at: w.last_opened_at,
        created_at: w.created_at,
    }
}

/// RFC3339 → 毫秒（无 chrono：手解 YYYY-MM-DDTHH:MM:SS[.fff](Z|+08:00) 简化形）
fn chrono_free_ms(rfc3339: &str) -> u64 {
    let num = |a: usize, b: usize| -> Option<u64> {
        rfc3339.get(a..b).and_then(|s| s.parse::<u64>().ok())
    };
    let parts = (|| -> Option<u64> {
        if rfc3339.len() < 19 {
            return None;
        }
        let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
        let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
        let days = days_from_civil(y as i64, mo as i64, d as i64);
        Some(((days * 86400 + h as i64 * 3600 + mi as i64 * 60 + sec as i64) * 1000) as u64)
    })();
    parts.unwrap_or(0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn envelope_payload(env: &Envelope) -> serde_json::Value {
    // codec 层已把 type 提升走；消息枚举反序列化需要 type 回填
    let mut v = env.payload.clone();
    if let serde_json::Value::Object(map) = &mut v {
        map.insert(
            "type".into(),
            serde_json::Value::String(env.msg_type.clone()),
        );
    }
    v
}

// ---- stdout 写（全局 stdout()，内部自锁跨线程安全）----

fn write_env(env: &Envelope) {
    let mut out = std::io::stdout();
    let _ = bbrt_protocol::codec::write_message(&mut out, env);
    let _ = out.flush();
}

fn send(ids: &mut IdGen, msg: &RuntimeToHost) {
    if let Ok(env) = Envelope::wrap(1, format!("r-{}", ids.next_id()), msg) {
        write_env(&env);
    }
}

/// turn 线程内错误上报（无 IdGen 借用权——id 用纳秒时钟保证唯一；stdout 全局锁线程安全）
fn emit_turn_error(session_id: &str, message: &str) {
    let env = Envelope::wrap(
        1,
        format!(
            "r-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ),
        &RuntimeToHost::Error {
            code: 8001,
            message: message.to_string(),
            fatal: false,
            session_id: Some(session_id.to_string()),
        },
    );
    if let Ok(env) = env {
        write_env(&env);
    }
}

/// 会话复活（2026-11-11「会话不死」裁决）：库里有行=有历史上下文——行还原
/// workspace/mode/模型/标题，重放事件镜像后经 manager.start 重建运行对象。
/// Ok(false)=库中无行（真·未知会话）；Err=锁/IO 失败细节。
fn revive_session(
    store: &Arc<Mutex<Store>>,
    mgr: &SessionManager,
    session_id: &str,
) -> Result<bool, String> {
    let guard = store.lock().map_err(|e| format!("store 锁中毒: {e}"))?;
    let row = match guard.get_session(session_id).map_err(|e| e.to_string())? {
        Some(r) => r,
        None => return Ok(false), // 库中无行=真未知会话，不复活
    };
    let ws_path = match &row.workspace_id {
        Some(wid) => guard
            .get_workspace(wid)
            .ok()
            .flatten()
            .map(|w| w.path)
            .unwrap_or_default(),
        None => String::new(),
    };
    let replay = bbrt_session::recover(&guard, session_id);
    drop(guard);
    let mode = match row.mode.as_str() {
        "auto-edit" => bbrt_sec::gate::PermissionMode::AutoEdit,
        "full-auto" => bbrt_sec::gate::PermissionMode::FullAuto,
        _ => bbrt_sec::gate::PermissionMode::Ask,
    };
    let tier = if row.model_policy == "fast" {
        ModelTier::Fast
    } else {
        ModelTier::Strong
    };
    mgr.start(
        session_id.to_string(),
        StartParams {
            workspace: ws_path,
            mode,
            model_policy: tier,
            model_override: row.model_override,
            title: row.title,
            restored: Some(replay),
        },
    )
    .map(|_| true)
    .map_err(|e| e.to_string())
}

/// 握手期 capabilities 提供者（后续消息走 dispatch 主循环，不经 serve）
struct RtHandler {
    #[allow(dead_code)]
    mgr: Arc<SessionManager>,
    #[allow(dead_code)]
    memory: Arc<MemoryEngine>,
}
impl RuntimeHandler for RtHandler {
    fn handle(&mut self, _msg: HostToRuntime, _env: &Envelope) -> Option<RuntimeToHost> {
        None // 握手只消费 initialize；回执由 handshake 内部生成
    }
    fn capabilities(&self) -> Vec<String> {
        vec!["session".into(), "tools".into(), "memory".into()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MCP server 配置双形态：http:// 前缀=远程网关（mcpgw）；否则 stdio 命令行
    #[test]
    fn parse_mcp_servers_http_and_stdio() {
        let cfgs = parse_mcp_servers(
            "corp=http://127.0.0.1:8090/mcp/corp; fake=fake-server --flag --v; bad; =x",
        );
        assert_eq!(cfgs.len(), 2, "坏段（无名/无=）应跳过: {cfgs:?}");
        assert!(matches!(
            &cfgs[0].transport,
            bbrt_mcp::TransportConfig::Http { base_url, .. }
                if base_url == "http://127.0.0.1:8090/mcp/corp",
        ));
        assert_eq!(cfgs[0].name, "corp");
        assert!(matches!(
            &cfgs[1].transport,
            bbrt_mcp::TransportConfig::Stdio { command, args, .. }
                if command == "fake-server" && args == &vec!["--flag".to_string(), "--v".to_string()],
        ));
        assert!(parse_mcp_servers("").is_empty());
        // https 前缀（D26 §5）同样归 Http 形态
        let cfgs = parse_mcp_servers("ext=https://mcp.example.com/mcp");
        assert!(matches!(
            &cfgs[0].transport,
            bbrt_mcp::TransportConfig::Http { base_url, .. }
                if base_url == "https://mcp.example.com/mcp",
        ));
    }
}
