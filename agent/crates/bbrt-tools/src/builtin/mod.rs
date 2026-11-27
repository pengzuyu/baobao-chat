//! 内置工具实现（D11 §2.4 builtin/）。
//!
//! 模块划分与工具清单：
//! - [`fs`]：read_file / list_dir / write_file / edit_file
//! - [`search`]：search_files（递归 glob 文件名 + 内容子串，命中 ≤200）
//! - [`cmd`]：run_command（经 bbrt-sec SandboxLauncher 真实沙箱执行）
//! - [`git`]：git_status / git_diff（经沙箱跑 git）；git_commit / git_push（v0.1 拒绝 8028）
//! - [`http`]：http_fetch（NetPolicy 白名单 + 沙箱 curl）
//! - [`memory`]：memory_save（bbrt-memory W1 模型写入路径）
//! - [`subagent`]：spawn_subagents（子 agent 通用派发薄门面——执行在 session 循环专用路径）
//!
//! 各实现返回 [`ExecOutput`]（成功）或 [`ToolBlock`]（带 8020-8026/8002 错误码的阻断），
//! 脱敏统一由 pipeline 第 7 步完成（D11 §6），本层不重复打码——例外是 violation
//! detail（落库/展示前即打码，见 [`ExecEnv::record_violation`]）。

pub mod ask_user;
pub mod cmd;
pub mod fs;
pub mod git;
pub mod http;
pub mod memory;
pub mod plugins;
pub mod projects;
pub(crate) mod read_access;
pub mod search;
pub mod sessions;
pub mod skill;
pub mod subagent;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use bbrt_memory::MemoryEngine;
use bbrt_sec::sandbox::launcher::{SandboxLauncher, Violation, ViolationKind, ViolationSink};
use bbrt_sec::sandbox::network::NetPolicy;
use bbrt_sec::sandbox::path::PathPolicy;

use crate::registry::ToolRegistry;

/// journal 字符串事件回调类型（file.changed 等；bin 侧转 ActivityEvent 喂被动轨）
pub(crate) type JournalHook = Arc<dyn Fn(&str) + Send + Sync>;

/// 执行环境（PipelineExecutor 构造期从 ToolsConfig 派成，全部工具共享；
/// D19 按会话克隆覆写 workspace/path_policy——多项目会话各自沙箱根互不串门）
#[derive(Clone)]
pub(crate) struct ExecEnv {
    /// 工作区根（规范路径；命令 cwd 默认值）。D19：会话路由后=该项目目录；
    /// 日常会话的 workspace 类工具在 pipeline 层先拦（8020 专用文案）
    pub workspace: PathBuf,
    /// 路径策略（工作区根 + 例外可写；敏感拒读 8026/越界 8020/软链逃逸 8024）
    pub path_policy: PathPolicy,
    /// 网络出站白名单（8025）
    pub net_policy: NetPolicy,
    /// 沙箱执行器（探测/注入；含降级信息 B11）
    pub launcher: SandboxLauncher,
    /// 记忆引擎（memory_save；None=不可用）
    pub memory: Option<Arc<MemoryEngine>>,
    /// journal 字符串事件回调（修改类先记 file.changed）
    pub journal_hook: Option<JournalHook>,
    /// violation 出口
    pub sink: Arc<dyn ViolationSink>,
    /// 读授权句柄（2026-11-26 读审批化：工作区外读需审批/附件自动授权/敏感红卡）。
    /// None=未装配（全局兜底 env——读工作区外一律按未授权拦截，与单测/嵌入式旧行为）
    pub read_access: Option<Arc<read_access::SessionReadAccess>>,
    /// 会话当前是否 full-auto（execute 时由 pipeline 按 mode 覆写；工作区外
    /// 非敏感读在 full-auto 放行——2026-11-26 拍板）
    pub full_auto: bool,
}

impl ExecEnv {
    /// 记录一条沙箱违规（detail 先打码再落 sink；09 §5.1 agent_sandbox_violation）
    pub(crate) fn record_violation(
        &self,
        kind: ViolationKind,
        code: u32,
        detail: impl Into<String>,
    ) {
        let masked = bbrt_sec::masking::mask(&detail.into());
        self.sink.append(Violation::now(kind, code, masked));
    }

    /// journal 字符串事件回调（无 hook 静默跳过；事件由 bin 侧转 ActivityEvent 喂被动轨）
    pub(crate) fn emit_journal(&self, event: &str) {
        if let Some(hook) = &self.journal_hook {
            hook(event);
        }
    }
}

/// 工具执行成功产物（D11 §6 步骤 6-8 浓缩；summary 由 pipeline 打码后回填上下文）
#[derive(Debug, Clone)]
pub(crate) struct ExecOutput {
    /// 结果摘要（将被 masking::mask 打码）
    pub summary: String,
    /// 是否发生截断（输出 1MB / 摘录 400 行 / 命中 200 条）
    pub truncated: bool,
    /// 进程退出码（非进程类工具为 None）
    pub exit_code: Option<i32>,
    /// 执行时长（毫秒）
    pub duration_ms: u64,
}

/// 工具执行阻断（携带 09 §6.4 错误码：8002 参数/未注册、8020-8026 沙箱域、8028 钥匙串）
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub(crate) struct ToolBlock {
    /// 错误码
    pub code: u32,
    /// 人读原因
    pub message: String,
}

/// 阻断快捷构造
pub(crate) fn deny(code: u32, message: impl Into<String>) -> ToolBlock {
    ToolBlock {
        code,
        message: message.into(),
    }
}

/// 计时辅助：闭包执行 → (结果, 毫秒)
pub(crate) fn timed<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let started = Instant::now();
    let out = f();
    (out, started.elapsed().as_millis() as u64)
}

/// epoch 毫秒（授权记忆 granted_at_ms 等审计字段）
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 相对路径以工作区根为基准解析（模型产出的相对路径语义 = 工作区内相对路径；
/// 不随 Runtime 进程 cwd 漂移）。2026-11-26：`~`/`~/` 展开 HOME——原实现会把
/// `~/Desktop/a.txt` 拼成 `<workspace>/~/Desktop/a.txt`（读审批化后模型常给
/// home 绝对/波浪线路径，不展开则读授权判定全错）
pub(crate) fn resolve_against(workspace: &std::path::Path, p: &str) -> std::path::PathBuf {
    let trimmed = p.trim();
    let home = |rest: &str| -> std::path::PathBuf {
        let h = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()));
        if rest.is_empty() {
            h
        } else {
            h.join(rest.trim_start_matches('/'))
        }
    };
    if trimmed == "~" {
        return home("");
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home(rest);
    }
    let path = std::path::Path::new(trimmed);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    }
}

/// 取字符串参数（trim 非空）
pub(crate) fn str_arg(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 取非负整数参数
pub(crate) fn usize_arg(args: &serde_json::Value, key: &str) -> Option<usize> {
    args.get(key).and_then(|v| v.as_u64()).map(|v| v as usize)
}

/// Runtime 本地库取锁（中毒锁也取：store 侧失败不该连带拖垮后续所有工具调用）
pub(crate) fn lock_store(
    store: &std::sync::Arc<std::sync::Mutex<bbrt_store::Store>>,
) -> std::sync::MutexGuard<'_, bbrt_store::Store> {
    store.lock().unwrap_or_else(|p| p.into_inner())
}

/// 本地库类工具（list_projects / use_project / session_search）的正常返回
pub(crate) fn ok_output(summary: impl Into<String>) -> ExecOutput {
    ExecOutput {
        summary: summary.into(),
        truncated: false,
        exit_code: None,
        duration_ms: 0,
    }
}

/// 本地库类工具的降级返回：未装配（单测/嵌入式）或查询失败——Ok + exit_code=1
/// （非阻断，list_plugins 降级同款），文案让模型知道下一步
pub(crate) fn degraded_output(summary: impl Into<String>) -> ExecOutput {
    ExecOutput {
        summary: summary.into(),
        truncated: false,
        exit_code: Some(1),
        duration_ms: 0,
    }
}

/// 注册全部内置工具（registry.builtin() 调用）
pub(crate) fn register_all(registry: &mut ToolRegistry) {
    registry.register(fs::read_file_def());
    registry.register(fs::list_dir_def());
    registry.register(fs::write_file_def());
    registry.register(fs::edit_file_def());
    registry.register(search::search_files_def());
    registry.register(cmd::run_command_def());
    registry.register(git::git_status_def());
    registry.register(git::git_diff_def());
    registry.register(git::git_commit_def());
    registry.register(git::git_push_def());
    registry.register(http::http_fetch_def());
    registry.register(memory::memory_save_def());
    registry.register(memory::memory_forget_def());
    registry.register(memory::memory_read_def());
    registry.register(memory::subagent_adjust_def());
    registry.register(memory::subagent_cancel_def());
    // 统一后台任务体系：等待任意后台任务结果（loop_runner 拦截，仅注册可发现性）
    registry.register(memory::task_wait_def());
    // D20：提问卡（loop_runner 拦截，仅注册可发现性）
    registry.register(ask_user::ask_user_def());
    // D33：技能显式加载（执行体在 pipeline dispatch——SkillIndex 经 ToolsConfig 注入）
    registry.register(skill::skill_def());
    // D22/D26 自省面收口：已装插件与 MCP server 清单（执行体在 pipeline dispatch）
    registry.register(plugins::list_plugins_def());
    // 任务感知工作台：工作台项目清单 + 采纳已登记项目为会话工作根
    // （执行体在 pipeline dispatch——数据源为 ToolsConfig.store）
    registry.register(projects::list_projects_def());
    registry.register(projects::use_project_def());
    // 任务感知工作台：历史对话检索/翻页/通读/最近会话（四形态由参数组合推断）
    registry.register(sessions::session_search_def());
    // 子 agent 通用派发入口（loop_runner 拦截，仅注册可发现性；2026-11-26 起由
    // 主 Agent 以工具调用显式发起——前置隐藏判定 planner 退役）
    registry.register(subagent::spawn_subagents_def());
}
