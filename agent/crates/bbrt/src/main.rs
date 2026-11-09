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
//! - BBW_RT_DATA_DIR   数据目录（默认 {TMPDIR}/bbrt）
//! - BBW_RT_GATEWAY    AI 网关 base（默认 http://127.0.0.1:8091）
//! - BBW_RT_TOKEN      网关令牌（v0.1 静态；OBO 通道阶段二接 hostapi::OboCache）

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
use bbrt_session::SnapshotService;
use bbrt_session::{LoopDeps, SessionManager, StartParams};
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
    let data_dir = PathBuf::from(std::env::var("BBW_RT_DATA_DIR").unwrap_or_else(|_| {
        std::env::temp_dir()
            .join("bbrt")
            .to_string_lossy()
            .into_owned()
    }));
    let gateway =
        std::env::var("BBW_RT_GATEWAY").unwrap_or_else(|_| "http://127.0.0.1:8091".into());
    let token = std::env::var("BBW_RT_TOKEN").unwrap_or_default();

    std::fs::create_dir_all(&data_dir).map_err(|e| format!("数据目录不可建: {e}"))?;

    // ── 装配 ──
    let store = Arc::new(Mutex::new(
        Store::open(&data_dir.join("runtime.db")).map_err(|e| format!("SQLite 打开失败: {e}"))?,
    ));
    let memory = Arc::new(
        MemoryEngine::open(&data_dir, Arc::new(bbrt_memory::SystemClock))
            .map_err(|e| format!("记忆引擎打开失败: {e}"))?,
    );
    // 启动回补漏日日报（D15 §3.2 触发 2；产物经 report.daily 事件补报宿主）
    let backfilled = memory.startup_backfill().unwrap_or_default();

    // OBO 动态令牌：宿主 obo.token 写缓存，过期回退静态 BBW_RT_TOKEN（D11 §10.1）
    let obo = Arc::new(std::sync::Mutex::new(bbrt_hostapi::OboCache::default()));
    // MCP client（D11 §2.10 / D14 §6）：BBW_RT_MCP_SERVERS="name=cmd;name2=cmd --flag"
    // （stdio 本地 server v0.1；远程 HTTP 网关接入后扩展）。主体令牌逐请求现取
    // OboCache（D14 §6.2 三层身份）；单 server 连接失败降级不阻塞
    let mcp_configs = parse_mcp_servers(&std::env::var("BBW_RT_MCP_SERVERS").unwrap_or_default());
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
    for (name, r) in &mcp_results {
        if let Err(e) = r {
            eprintln!("[bbrt] MCP server '{name}' 连接降级: {e}");
        }
    }
    // 专家库同步（D14 §5 分发阶段一）：BBW_RT_EXPERTS_URL 指向服务端
    // /api/v1/eco/experts（公开只读）→ 清单 → 逐个下载落 {dataDir}/eco/experts/
    // （ExpertIndex 扫描格式；本地手放文件共存——远端不覆盖本地同名，登记）。
    // 失败降级不阻塞启动（内网断连=沿用上次同步产物）
    if let Ok(base) = std::env::var("BBW_RT_EXPERTS_URL") {
        sync_experts(&data_dir, &base);
    }

    // 技能索引（10 篇 §4.5）：扫描 {dataDir}/eco/skills/*/SKILL.md；
    // tools.reload{reason:skill} 热重载（宿主安装/更新/卸载技能包后触发）
    let skills_index = Arc::new(Mutex::new(bbrt_session::SkillIndex::scan(
        &data_dir.join("eco/skills"),
    )));
    let tools = Arc::new(bbrt_tools::PipelineExecutor::new(bbrt_tools::ToolsConfig {
        workspace: PathBuf::from("."),
        launcher: None, // detect() 探测（Seatbelt/Baseline + 降级徽标）
        memory: Some(memory.clone()),
        mcp: (!mcp_configs.is_empty()).then(|| Arc::new(mcp_client)),
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
        snapshots: Some(Arc::new(bbrt_session::GitSnapshots::new(store.clone()))),
        skills: skills_index.clone(),
        fanout: Some(Arc::new(bbrt_session::FastPlanner)),
        experts: None,
        budget: Default::default(),
    };
    let mgr = Arc::new(SessionManager::new(deps, Some(store.clone())));

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

    // 启动回补的日报补报
    for rep in backfilled {
        send(
            &mut ids,
            &RuntimeToHost::ReportDaily {
                date: rep.date,
                path: rep.json_path.display().to_string(),
                stats: to_lite(&rep.stats),
            },
        );
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
            &data_dir.join("eco/skills"),
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
    eco_skills_dir: &std::path::Path,
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
                "reports".into(),
            ],
        }),
        HostToRuntime::SessionStart {
            session_id,
            workspace,
            mode,
            model_policy,
            model,
            history_ref,
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
            // 被动轨：session.started 入 journal（D15 §3.1）
            let _ = memory.record(&bbrt_memory::ActivityEvent::SessionStarted {
                session: session_id.clone(),
                workspace: workspace.clone(),
                mode: format!("{mode:?}").to_lowercase(),
            });
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
                    title: session_id.clone(),
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
            session_id, text, ..
        } => {
            let mgr2 = mgr.clone();
            let sid = session_id.clone();
            // turn 独立线程：流式事件经共享 stdout 即时外发
            std::thread::spawn(move || {
                let _ = mgr2.run_turn(&sid, &text);
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
        HostToRuntime::SessionPause { session_id } => {
            let _ = mgr.interrupt(&session_id);
            Some(RuntimeToHost::SessionStateReport {
                session_id,
                state: bbrt_protocol::SessionState::Paused,
                reason: "user-pause".into(),
            })
        }
        HostToRuntime::SessionEnd { session_id, .. } => {
            let _ = mgr.end(&session_id, "");
            Some(RuntimeToHost::SessionEnded {
                session_id,
                summary: String::new(),
            })
        }
        HostToRuntime::MemoryList { .. } => Some(RuntimeToHost::MemoryListResult {
            items: memory
                .knowledge()
                .list()
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
                })
                .collect(),
        }),
        HostToRuntime::MemoryDelete { name } => Some(RuntimeToHost::MemoryDeleteResult {
            ok: memory.knowledge().delete(&name).unwrap_or(false),
        }),
        HostToRuntime::ReportList { limit } => Some(RuntimeToHost::ReportListResult {
            // reports 目录统计扫描（D15 §3.3；日期倒序，损坏文件跳过）
            items: memory
                .list_reports(limit.unwrap_or(0) as usize)
                .into_iter()
                .map(|st| bbrt_protocol::ReportListItem {
                    date: st.date.clone(),
                    stats: bbrt_protocol::DailyStatsLite {
                        sessions: st.sessions as u32,
                        tools: st.tool_calls as u32,
                        blocked: st.blocked as u32,
                        files_changed: st.files_changed as u32,
                        memory_saved: st.memory_saved.len() as u32,
                    },
                })
                .collect(),
        }),
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
            backend,
            task_brief,
            ..
        } => {
            mgr.respond_delegate(bbrt_session::loop_runner::DelegateHostMsg::Launch {
                backend,
                brief: Some(task_brief),
            })
            .ok();
            None // 委派事件流（delegate.event/end）即回显
        }
        HostToRuntime::DelegateInput { text, .. } => {
            mgr.respond_delegate(bbrt_session::loop_runner::DelegateHostMsg::Input { text })
                .ok();
            None
        }
        HostToRuntime::DelegateCancel { graceful, .. } => {
            mgr.respond_delegate(bbrt_session::loop_runner::DelegateHostMsg::Cancel { graceful })
                .ok();
            None
        }
        HostToRuntime::DelegateReview { decision, .. } => {
            let accept = matches!(decision, bbrt_protocol::ReviewDecision::Accept);
            mgr.respond_delegate(bbrt_session::loop_runner::DelegateHostMsg::Review { accept })
                .ok();
            None
        }
        // 手动检查点（PAG-06；回执即 checkpoint.created）
        HostToRuntime::CheckpointCreate { session_id, reason } => {
            let reason = if reason.is_empty() {
                "manual".into()
            } else {
                reason
            };
            let Some(ws) = mgr.workspace_of(&session_id) else {
                return Some(RuntimeToHost::Error {
                    code: 8001,
                    message: format!("会话不存在: {session_id}"),
                    fatal: false,
                    session_id: Some(session_id),
                });
            };
            let svc = bbrt_session::GitSnapshots::new(store.clone());
            match svc.create(&session_id, &ws, &reason) {
                Ok(out) => {
                    // 回执即 checkpoint.created（REQ 成对 reply_to）；不再经 sink 双发
                    Some(RuntimeToHost::CheckpointCreated {
                        checkpoint_id: out.checkpoint_id,
                        session_id,
                        files_changed: out.files_changed,
                        reason: match out.reason.as_str() {
                            "pre-edit" => bbrt_protocol::CheckpointReason::PreEdit,
                            "pre-command" => bbrt_protocol::CheckpointReason::PreCommand,
                            "delegate" => bbrt_protocol::CheckpointReason::Delegate,
                            "pre-restore" => bbrt_protocol::CheckpointReason::PreRestore,
                            _ => bbrt_protocol::CheckpointReason::Manual,
                        },
                        git_ref: out.git_ref,
                    })
                }
                Err(e) => Some(RuntimeToHost::Error {
                    code: 8001,
                    message: format!("检查点创建失败: {e}"),
                    fatal: false,
                    session_id: Some(session_id),
                }),
            }
        }
        // 恢复检查点（先解析归属会话→工作区；自动建 pre-restore 保护快照）
        HostToRuntime::CheckpointRestore { checkpoint_id } => {
            let sid = store
                .lock()
                .ok()
                .and_then(|g| g.get_checkpoint(&checkpoint_id).ok().flatten())
                .map(|r| r.session_id);
            let Some(sid) = sid else {
                return Some(RuntimeToHost::CheckpointRestored {
                    ok: false,
                    new_checkpoint_id: None,
                    error: Some("检查点不存在".into()),
                });
            };
            let ws = mgr.workspace_of(&sid).unwrap_or_default();
            let svc = bbrt_session::GitSnapshots::new(store.clone());
            match svc.restore(&sid, &ws, &checkpoint_id) {
                Ok(new_cp) => Some(RuntimeToHost::CheckpointRestored {
                    ok: true,
                    new_checkpoint_id: Some(new_cp),
                    error: None,
                }),
                Err(e) => Some(RuntimeToHost::CheckpointRestored {
                    ok: false,
                    new_checkpoint_id: None,
                    error: Some(e),
                }),
            }
        }
        // 工具/技能热重载（10 篇 §4.5：宿主安装/更新/卸载技能包后 tools.reload
        // {reason:skill}；App/Policy 亦触发技能重扫——生态内容变更的统一失效信号）
        HostToRuntime::ToolsReload { .. } => {
            if let Ok(mut idx) = skills.lock() {
                *idx = bbrt_session::SkillIndex::scan(eco_skills_dir);
            }
            None // 效果经后续轮次注入体现（协议无独立回执变体）
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

/// BBW_RT_MCP_SERVERS="corp=http://127.0.0.1:8090/mcp/corp;fake=fake-server --flag"
/// （值 http:// 前缀=远程 MCP 网关（公司域 mcpgw，D14 §6.1 连接期发现
/// mcp.{name}.*）；否则=stdio 本地子进程命令行）
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
            let transport = if target.trim_start().starts_with("http://") {
                bbrt_mcp::TransportConfig::Http {
                    base_url: target.trim().to_string(),
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

fn to_lite(s: &bbrt_memory::DailyStats) -> bbrt_protocol::DailyStatsLite {
    bbrt_protocol::DailyStatsLite {
        sessions: s.sessions as u32,
        tools: s.tool_calls as u32,
        blocked: s.blocked as u32,
        files_changed: s.files_changed as u32,
        memory_saved: s.memory_saved.len() as u32,
    }
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
        vec![
            "session".into(),
            "tools".into(),
            "memory".into(),
            "reports".into(),
        ]
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
            bbrt_mcp::TransportConfig::Http { base_url }
                if base_url == "http://127.0.0.1:8090/mcp/corp",
        ));
        assert_eq!(cfgs[0].name, "corp");
        assert!(matches!(
            &cfgs[1].transport,
            bbrt_mcp::TransportConfig::Stdio { command, args, .. }
                if command == "fake-server" && args == &vec!["--flag".to_string(), "--v".to_string()],
        ));
        assert!(parse_mcp_servers("").is_empty());
    }
}
