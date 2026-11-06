//! http_fetch 工具（D11 §2.4 builtin/http.rs）。
//!
//! 两段防线（09 §3.2.4 / §4.1.1）：
//! 1. **NetPolicy 白名单**（纯逻辑，8025）：URL 主机 ∉ 域名后缀 ∪ CIDR →
//!    violation（network）+ blocked；内网 GET 白名单命中可走记忆豁免（gate 层）；
//! 2. **沙箱执行**：v0.1 经 SandboxLauncher 跑系统 curl（`--max-time` 限 30s、
//!    `allow_network=true` 仅放行该次出站；无 curl 可执行文件则拒绝执行）。
//!
//! 未做：响应体大小限制沿用 launcher 的 1MB 输出截断；HTTPS 证书校验跟随系统 curl。

use serde_json::{json, Value};

use super::cmd::run_with_launcher;
use super::{deny, str_arg, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};
use bbrt_sec::errors::CODE_NETWORK_NOT_ALLOWED;
use bbrt_sec::gate::ActionCategory;
use bbrt_sec::sandbox::launcher::{RunSpec, ViolationKind};
use bbrt_sec::sandbox::network::NetworkError;

/// curl 缺失时的拒绝码（沙箱执行器不可用族，8020）
const CODE_NO_CURL: u32 = 8020;

/// curl 命中白名单后的出站超时（秒）
const FETCH_TIMEOUT_SECS: u64 = 30;

/// 常见 curl 绝对路径（按序探测；Seatbelt 内建议绝对路径）
const CURL_CANDIDATES: [&str; 3] = [
    "/usr/bin/curl",
    "/usr/local/bin/curl",
    "/opt/homebrew/bin/curl",
];

/// http_fetch 实现
pub(crate) fn fetch(env: &ExecEnv, args: &Value) -> Result<ExecOutput, ToolBlock> {
    let url = str_arg(args, "url").ok_or_else(|| deny(8002, "http_fetch 缺少 url 参数"))?;

    // ① NetPolicy 白名单（8025）
    if let Err(e) = env.net_policy.check_url(&url) {
        let (code, host) = match &e {
            NetworkError::NotWhitelisted { code, host } => (*code, host.clone()),
            NetworkError::BadCidr { input, .. } => (CODE_NETWORK_NOT_ALLOWED, input.clone()),
        };
        env.record_violation(
            ViolationKind::Network,
            code,
            format!("http_fetch 出站目标不在白名单: {host}"),
        );
        return Err(deny(
            code,
            format!("网络出站目标不在白名单（{code}）: {host}"),
        ));
    }

    // ② 沙箱 curl 执行（无 curl → 拒绝；v0.1 不自带 HTTP 客户端）
    let Some(curl) = CURL_CANDIDATES
        .iter()
        .find(|p| std::path::Path::new(p).is_file())
        .map(|p| p.to_string())
    else {
        return Err(deny(
            CODE_NO_CURL,
            "沙箱内 curl 不可用（8020）：v0.1 http_fetch 依赖系统 curl 执行",
        ));
    };
    let spec = RunSpec {
        program: curl,
        args: vec![
            "-sS".to_string(),
            "--max-time".to_string(),
            FETCH_TIMEOUT_SECS.to_string(),
            url.clone(),
        ],
        cwd: Some(env.workspace.clone()),
        env: Vec::new(),
    };
    let mut opts = super::cmd::base_run_opts(env);
    opts.allow_network = true; // 白名单已过，profile 省略 deny network*
    run_with_launcher(env, spec, opts)
}

/// http_fetch 工具定义（D13-A2 行 6：网络出站，永不全自动；内网 GET 可记忆）
pub fn http_fetch_def() -> ToolDef {
    ToolDef {
        name: "http_fetch".into(),
        description: "HTTP GET 抓取（仅内网白名单域/网段；沙箱内经系统 curl 执行，30s 超时，\
                      响应 1MB 截断）"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "目标 URL（主机须在出站白名单内）"}
            },
            "required": ["url"]
        }),
        risk: RiskLevel::Medium,
        category: ActionCategory::NetworkEgress,
    }
}
