//! 工具子系统配置（bin 装配入口；D11 §2.4）。
//!
//! [`ToolsConfig`] 承载执行所需的外部件：工作区/例外可写目录、网络白名单、
//! 沙箱执行器（None=探测降级，D13-B11）、记忆引擎（memory_save 的 W1 写入路径）、
//! journal 字符串事件回调（file.changed 喂被动轨；ActivityEvent 组装由 bin 侧完成）
//! 与 violation 出口（默认内存，可注入 JSONL/SQLite 实现）。
//!
//! 门控上下文（GateCtx 组装所需的策略/权限点/白名单前缀/untrusted）一并在此承载：
//! v0.1 由 bin 装配传入；租户策略拉取（GET /agent/policies）接入后替换 policy 字段。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bbrt_memory::MemoryEngine;
use bbrt_sec::gate::{PermissionMode, ToolPolicy, PERM_FULL_AUTO, PERM_RUN_COMMAND};
use bbrt_sec::sandbox::launcher::{SandboxLauncher, Violation, ViolationSink};
use bbrt_sec::sandbox::network::NetPolicy;
use bbrt_sec::sandbox::path::PathPolicy;

/// journal 字符串事件回调类型（file.changed 等；bin 侧转 ActivityEvent 喂被动轨）
pub type JournalHook = Arc<dyn Fn(&str) + Send + Sync>;

/// 工具执行配置（PipelineExecutor 的全部外部依赖）
pub struct ToolsConfig {
    /// 工作区根（读写白名单基准）
    pub workspace: PathBuf,
    /// 例外可写目录（专用临时目录/缓存等）
    pub extra_writable: Vec<PathBuf>,
    /// 网络白名单：域名后缀（小写；example.com 覆盖 *.example.com）
    pub net_allow_domains: Vec<String>,
    /// 网络白名单：CIDR 网段（含内网段与 ai-gateway VIP）
    pub net_allow_cidrs: Vec<String>,
    /// 沙箱执行器；None = 构造期 detect() 探测（不可用自动降级 Baseline，B11）
    pub launcher: Option<SandboxLauncher>,
    /// 记忆引擎；None = memory_save 返回不可用
    pub memory: Option<Arc<MemoryEngine>>,
    /// journal 字符串事件回调（修改类工具先记 file.changed；bin 侧转 ActivityEvent）
    pub journal_hook: Option<JournalHook>,
    /// 租户策略；None = 策略缺失按最严档（gate ①；09 §7.4）
    pub policy: Option<ToolPolicy>,
    /// 用户权限点（gate ②；默认含 run_command + full-auto，bin 按实际用户裁剪）
    pub permission_points: Vec<String>,
    /// 白名单命令前缀（项目 AGENTS.md 声明，如 "cargo test"；v0.1 暂空）
    pub whitelist_prefixes: Vec<String>,
    /// 参数是否含 untrusted 来源子串（gate ⑤；session 层指纹匹配后置位）
    pub untrusted: bool,
    /// violation 出口；None = PipelineExecutor 内建 MemoryViolationSink
    pub violation_sink: Option<Arc<dyn ViolationSink>>,
}

impl ToolsConfig {
    /// 最小配置：单工作区 + 默认权限点（run_command/full-auto）+ 空网络白名单。
    /// 注意 policy=None 意味着门控按"策略缺失=最严档 Ask"执行；需要真实矩阵行为
    /// （如 full-auto 放行文件编辑）时装配方应显式设置 `policy = Some(ToolPolicy::default())`。
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self {
            workspace: workspace.into(),
            extra_writable: Vec::new(),
            net_allow_domains: Vec::new(),
            net_allow_cidrs: Vec::new(),
            launcher: None,
            memory: None,
            journal_hook: None,
            policy: None,
            permission_points: vec![PERM_RUN_COMMAND.to_string(), PERM_FULL_AUTO.to_string()],
            whitelist_prefixes: Vec::new(),
            untrusted: false,
            violation_sink: None,
        }
    }

    /// 网络白名单（内网 CIDR + 域名后缀）；任一 CIDR 非法 → 整体退化为空策略
    /// （全拒绝，"宁可多拦"，09 §7.4 策略缺失语义）
    pub fn net_policy(&self) -> NetPolicy {
        NetPolicy::from_config(&self.net_allow_domains, &self.net_allow_cidrs).unwrap_or_default()
    }

    /// 路径策略（工作区根 + 例外可写目录）
    pub fn path_policy(&self) -> PathPolicy {
        PathPolicy::with_roots(vec![self.workspace.clone()], self.extra_writable.clone())
    }

    /// 生效档位预检：租户 max_mode 收敛后的档位（A3；仅提示用，权威判定在 gate 内）
    pub fn effective_mode(&self, session_mode: PermissionMode) -> PermissionMode {
        match self.policy.as_ref().and_then(|p| p.max_mode) {
            Some(cap) => session_mode.min(cap),
            None if self.policy.is_none() => PermissionMode::Ask,
            None => session_mode,
        }
    }
}

impl Default for ToolsConfig {
    /// 结构体更新语法便利（`ToolsConfig { workspace, ..Default::default() }`）。
    /// workspace 为空占位——生产装配必须显式给出，否则一切读写都被白名单拒绝
    /// （安全失败方向：宁可全拦）。
    fn default() -> Self {
        Self {
            workspace: PathBuf::new(),
            extra_writable: Vec::new(),
            net_allow_domains: Vec::new(),
            net_allow_cidrs: Vec::new(),
            launcher: None,
            memory: None,
            journal_hook: None,
            policy: None,
            permission_points: vec![PERM_RUN_COMMAND.to_string(), PERM_FULL_AUTO.to_string()],
            whitelist_prefixes: Vec::new(),
            untrusted: false,
            violation_sink: None,
        }
    }
}

/// violation → SQLite（agent_sandbox_violation 表，D09 §5.1/D11 §11）适配器。
/// detail 落库前打码（store 契约：detail 为打码后文本）。
pub struct StoreViolationSink {
    store: Arc<Mutex<bbrt_store::Store>>,
    session_id: String,
}

impl StoreViolationSink {
    /// 绑定 SQLite 门面与会话 id
    pub fn new(store: Arc<Mutex<bbrt_store::Store>>, session_id: impl Into<String>) -> Self {
        Self {
            store,
            session_id: session_id.into(),
        }
    }
}

impl ViolationSink for StoreViolationSink {
    fn append(&self, violation: Violation) {
        let kind = match violation.kind {
            bbrt_sec::sandbox::launcher::ViolationKind::Path => "path",
            bbrt_sec::sandbox::launcher::ViolationKind::Network => "network",
            bbrt_sec::sandbox::launcher::ViolationKind::Resource => "resource",
            bbrt_sec::sandbox::launcher::ViolationKind::Rule => "rule",
            bbrt_sec::sandbox::launcher::ViolationKind::DangerCmd => "danger-cmd",
        };
        let row = bbrt_store::ViolationRow {
            id: 0, // 自增主键，插入时由 SQLite 分配
            session_id: self.session_id.clone(),
            kind: kind.to_string(),
            detail: bbrt_sec::masking::mask(&violation.detail),
            code: i64::from(violation.code),
            ts: violation.ts_ms as i64,
        };
        // 写库失败不影响主流程（violation 是尽力记录）
        if let Ok(store) = self.store.lock() {
            let _ = store.insert_violation(&row);
        }
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认配置_权限点与空白名单() {
        let cfg = ToolsConfig::new("/tmp/ws-does-not-matter");
        assert!(cfg
            .permission_points
            .contains(&"agent:tool:run_command".to_string()));
        assert!(cfg
            .permission_points
            .contains(&"agent:mode:full_auto".to_string()));
        // 空网络白名单 = 全拒绝
        let net = cfg.net_policy();
        assert!(net.check_url("https://example.com/x").is_err());
        // 路径策略带工作区根
        let path = cfg.path_policy();
        assert_eq!(
            path.workspace_roots,
            vec![PathBuf::from("/tmp/ws-does-not-matter")]
        );
        // 策略缺失 → 生效档位压到 Ask（09 §7.4）
        assert_eq!(
            cfg.effective_mode(PermissionMode::FullAuto),
            PermissionMode::Ask
        );
    }

    #[test]
    fn 非法_cidr_整体退化为全拒绝() {
        let mut cfg = ToolsConfig::new("/tmp/ws");
        cfg.net_allow_domains = vec!["example.com".into()];
        cfg.net_allow_cidrs = vec!["10.0.0.0/8".into(), "oops/99".into()];
        let net = cfg.net_policy();
        // 域名也一并失效（整体退化，避免静默漏配）
        assert!(net.check_url("https://example.com/x").is_err());
    }

    #[test]
    fn 合法白名单_域名与网段放行() {
        let mut cfg = ToolsConfig::new("/tmp/ws");
        cfg.net_allow_domains = vec!["internal.corp".into()];
        cfg.net_allow_cidrs = vec!["127.0.0.0/8".into()];
        let net = cfg.net_policy();
        assert!(net.check_url("https://api.internal.corp/v1").is_ok());
        assert!(net.check_url("http://127.0.0.1:8080/health").is_ok());
        assert!(net.check_url("https://evil.io/x").is_err());
    }
}
