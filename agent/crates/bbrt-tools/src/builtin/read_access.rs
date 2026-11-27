//! 读权限模型（2026-11-26）：文件读取从「工作区硬拦 8020」改为「工作区外读需审批」。
//!
//! 口径（当日拍板）：
//! - 工作区内读取自动放行（三档）；
//! - 用户随消息附带的文件视为已授权（用户亲自给的，路径在工作区外也不弹卡）；
//! - 工作区外未授权读取：ask/auto-edit 弹审批卡（本次/本会话该目录树），
//!   **full-auto 放行**（用户拍板：全自动档不弹）；
//! - 敏感文件（密钥/凭据清单命中）：三档都弹红卡、仅「本次」——用户批准后凭
//!   一次性票据读取；
//! - 审批记忆只到本会话（不做永久授权）；
//! - `run_command` 只读命令（cat 等）暂不纳入（拍板：命令通道维持现状）。
//!
//! 两个入口：
//! - [`ReadAccess::decide`]：门控判定用（不消费票据）——pipeline::check 在
//!   permission_gate 放行后对三个读工具追加调用；
//! - [`ReadAccess::authorize`]：执行层校验用（消费一次性票据）——fs.rs /
//!   search.rs 统一入口。执行层校验保证子代理/专家直调 execute 时同样被拦
//!   （他们没有审批链，未授权读会收到 Blocked 提示回主会话授权）。
//!
//! 适用工具：read_file / list_dir / glob_files / grep_files。

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bbrt_context::AttachmentRef;
use bbrt_sec::errors::CODE_SANDBOX_DENIED;
use bbrt_sec::sandbox::launcher::ViolationKind;
use bbrt_sec::sandbox::path::{is_sensitive_file, read_realpath};

use super::{deny, ExecEnv, ToolBlock};

/// 读工具参数名（path 可缺省=工作区，四个读工具同口径）
pub(crate) const READ_TOOLS: &[&str] = &["read_file", "list_dir", "glob_files", "grep_files"];

/// 工具名是否读审批适用
pub(crate) fn is_read_tool(tool: &str) -> bool {
    READ_TOOLS.contains(&tool)
}

/// 从工具参数提取读取目标（缺省=工作区根，glob_files/grep_files 同口径）
pub(crate) fn read_target(workspace: &Path, args: &serde_json::Value) -> PathBuf {
    args.get("path")
        .and_then(|v| v.as_str())
        .map(|p| super::resolve_against(workspace, p))
        .unwrap_or_else(|| workspace.to_path_buf())
}

/// 门控/执行判定结论
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadDecision {
    /// 放行（工作区内非敏感/已授权/附带/full-auto 工作区外）
    Allowed,
    /// 需用户审批（sensitive=true=红卡仅本次；false=工作区外普通读）
    NeedsApproval { sensitive: bool, path: PathBuf },
}

/// 单会话授权集
#[derive(Debug, Default)]
struct Grants {
    /// 用户随消息附带的文件（realpath 精确集合；敏感与否都放行）
    attached: HashSet<PathBuf>,
    /// 「本会话」批准的目录树（父目录前缀；敏感文件不进这里——仅 once）
    dirs: Vec<PathBuf>,
    /// 「本次」票据（realpath 精确；执行时消费）
    once: HashSet<PathBuf>,
}

impl Grants {
    /// 是否放行（consume=true 时消费一次性票据）。
    /// attached/once 精确路径对敏感文件同样生效（用户亲自给的/单独批准的）；
    /// **目录树授权只对非敏感生效**——批准某目录不等于批准读它下面的密钥
    fn covers(&mut self, resolved: &Path, sensitive: bool, consume: bool) -> bool {
        if self.attached.contains(resolved) {
            return true;
        }
        if self.once.contains(resolved) {
            if consume {
                self.once.remove(resolved);
            }
            return true;
        }
        !sensitive && self.dirs.iter().any(|d| resolved.starts_with(d))
    }
}

/// 会话读授权登记表（进程级单例；PipelineExecutor 持 Arc，session_env 克隆共享）
#[derive(Debug, Default)]
pub struct ReadAccess {
    inner: Mutex<HashMap<String, Grants>>,
}

impl ReadAccess {
    /// 用户附带登记（run_turn_with 经 ToolExecutor::register_attachments 调用）：
    /// realpath 落集合（文件不存在也登记——执行时 NotFound 由读取报错，不在此拦）
    pub fn register_attachments(&self, session_id: &str, attachments: &[AttachmentRef]) {
        let mut g = self.lock();
        let grants = g.entry(session_id.to_string()).or_default();
        for a in attachments {
            grants.attached.insert(read_realpath(Path::new(&a.path)));
        }
    }

    /// 审批通过落授权（loop_runner NeedConfirm→Allow 链的 record_grant 路由）：
    /// scope=once 或敏感 → 精确路径票据；scope=session 且非敏感 → 父目录树。
    /// permanent 在读审批不存在（confirm options 不给；防御性报错）
    pub fn record_grant(
        &self,
        session_id: &str,
        resolved: &Path,
        scope: bbrt_sec::memory::GrantScope,
        sensitive: bool,
    ) -> Result<(), String> {
        use bbrt_sec::memory::GrantScope as GS;
        // 入口统一 realpath（调用方可能传原始路径——macOS /var↔/private/var
        // 前缀差异会让后续 starts_with 全部失配；canonicalize 幂等无害）
        let resolved = read_realpath(resolved);
        let mut g = self.lock();
        let grants = g.entry(session_id.to_string()).or_default();
        match (scope, sensitive) {
            (GS::Permanent, _) => {
                return Err("读取授权不支持永久记忆".into());
            }
            // 敏感文件任何档都只给精确路径票据（目录树授权对密钥无效）
            (_, true) | (GS::Once, _) => {
                grants.once.insert(resolved.to_path_buf());
            }
            (GS::Session, false) => {
                // 父目录树：list_dir("某目录") 授权其下递归读取
                if let Some(parent) = resolved.parent() {
                    grants.dirs.push(parent.to_path_buf());
                }
                grants.once.insert(resolved.to_path_buf());
            }
        }
        Ok(())
    }

    /// 门控判定（不消费票据）。workspace_roots/exceptions 来自 env.path_policy。
    pub fn decide(&self, env: &ExecEnv, session_id: &str, target: &Path) -> ReadDecision {
        let resolved = read_realpath(target);
        let sensitive = is_sensitive_file(&resolved);
        let inside = inside_roots(env, &resolved);
        let mut g = self.lock();
        let granted = g
            .get_mut(session_id)
            .map(|gr| gr.covers(&resolved, sensitive, false))
            .unwrap_or(false);
        drop(g);
        match (granted, sensitive, inside) {
            (true, ..) => ReadDecision::Allowed,
            // 工作区内非敏感=自动；工作区内敏感=弹红卡（原 8026 审批化）
            (_, false, true) => ReadDecision::Allowed,
            (_, true, _) => ReadDecision::NeedsApproval {
                sensitive: true,
                path: resolved,
            },
            // 工作区外非敏感：full-auto 放行（拍板），其余弹卡
            (_, false, false) if env.full_auto => ReadDecision::Allowed,
            (_, false, false) => ReadDecision::NeedsApproval {
                sensitive: false,
                path: resolved,
            },
        }
    }

    /// 执行层统一校验（fs.rs/search.rs 入口；消费一次性票据）。
    /// 返回 Ok(resolved)。子代理/专家直调 execute 无审批链——未授权在此拦下。
    pub fn authorize(
        &self,
        env: &ExecEnv,
        session_id: &str,
        tool: &str,
        target: &Path,
    ) -> Result<PathBuf, ToolBlock> {
        let resolved = read_realpath(target);
        let sensitive = is_sensitive_file(&resolved);
        let inside = inside_roots(env, &resolved);
        let mut g = self.lock();
        let granted = g
            .get_mut(session_id)
            .map(|gr| gr.covers(&resolved, sensitive, true))
            .unwrap_or(false);
        drop(g);
        let ok = granted || (inside && !sensitive) || (!inside && !sensitive && env.full_auto);
        if ok {
            return Ok(resolved);
        }
        // violation 记录（审计口径同旧 8020/8026 拦截）
        let (code, why) = if sensitive {
            (8026, "敏感文件需批准读取")
        } else {
            (CODE_SANDBOX_DENIED, "读取未授权（工作区外）")
        };
        env.record_violation(
            ViolationKind::Path,
            code,
            format!("{tool} 读授权拦截: {}", resolved.display()),
        );
        Err(deny(
            code,
            format!(
                "{why}（{code}）: {} 不在当前工作区内且未经批准。请让用户在审批卡中批准，或请用户把文件作为附件随消息发送",
                resolved.display()
            ),
        ))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Grants>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// 读授权统一入口（fs.rs / search.rs 调用；消费一次性票据）。
/// env.read_access=会话绑定句柄时走完整判定；None（全局兜底 env——单测/嵌入式）
/// 退化为旧口径：工作区内非敏感放行，其余拦截。
pub(crate) fn authorize_read(
    env: &ExecEnv,
    tool: &str,
    target: &Path,
) -> Result<PathBuf, ToolBlock> {
    match &env.read_access {
        Some(ra) => ra.authorize(env, &ra.session_id, tool, target),
        None => {
            let resolved = read_realpath(target);
            let sensitive = is_sensitive_file(&resolved);
            if inside_roots(env, &resolved) && !sensitive {
                return Ok(resolved);
            }
            let (code, why) = if sensitive {
                (8026, "敏感文件需批准读取")
            } else {
                (CODE_SANDBOX_DENIED, "读取未授权（工作区外）")
            };
            env.record_violation(
                ViolationKind::Path,
                code,
                format!("{tool} 读授权拦截: {}", resolved.display()),
            );
            Err(deny(
                code,
                format!("{why}（{code}）: {}", resolved.display()),
            ))
        }
    }
}

/// 工作区内判定（工作区根 ∪ 例外可写目录；canonicalize 对齐 PathPolicy 口径）
fn inside_roots(env: &ExecEnv, resolved: &Path) -> bool {
    env.path_policy
        .workspace_roots
        .iter()
        .chain(env.path_policy.writable_exceptions.iter())
        .any(|r| resolved.starts_with(std::fs::canonicalize(r).unwrap_or_else(|_| r.clone())))
}

/// 会话绑定句柄（ExecEnv 持有；authorize/decide 调用免传 session_id）
#[derive(Clone)]
pub struct SessionReadAccess {
    pub(crate) session_id: String,
    pub(crate) access: Arc<ReadAccess>,
}

impl std::ops::Deref for SessionReadAccess {
    type Target = ReadAccess;
    fn deref(&self) -> &ReadAccess {
        &self.access
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bbrt_context::AttachmentKind;
    use bbrt_sec::sandbox::launcher::MemoryViolationSink;
    use bbrt_sec::sandbox::path::PathPolicy;

    /// 夹具：工作区 tempdir + 全局 env（read_access 句柄由测试各自构造）
    fn fixture() -> (ExecEnv, std::sync::Arc<ReadAccess>, tempfile::TempDir) {
        let ws = tempfile::tempdir().unwrap();
        let env = ExecEnv {
            workspace: ws.path().to_path_buf(),
            path_policy: PathPolicy::with_roots(vec![ws.path().to_path_buf()], vec![]),
            net_policy: bbrt_sec::sandbox::network::NetPolicy::new(),
            launcher: bbrt_sec::sandbox::launcher::SandboxLauncher::new(),
            memory: None,
            journal_hook: None,
            sink: Arc::new(MemoryViolationSink::new()),
            read_access: None,
            full_auto: false,
        };
        (env, Arc::new(ReadAccess::default()), ws)
    }

    fn att(path: &str) -> AttachmentRef {
        AttachmentRef {
            path: path.into(),
            kind: AttachmentKind::File,
            name: "f".into(),
            size: 1,
            mime: None,
        }
    }

    fn inside_ws(ws: &tempfile::TempDir, name: &str) -> PathBuf {
        let p = ws.path().join(name);
        std::fs::write(&p, "hello").unwrap();
        p
    }

    #[test]
    fn 工作区内自动_工作区外ask弹卡_fullauto放行() {
        let (mut env, ra, ws) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let f = outside.path().join("note.txt");
        std::fs::write(&f, "x").unwrap();
        // 工作区内：Allowed
        assert_eq!(
            ra.decide(&env, "s1", &inside_ws(&ws, "a.txt")),
            ReadDecision::Allowed
        );
        // 工作区外 ask：NeedsApproval
        assert_eq!(
            ra.decide(&env, "s1", &f),
            ReadDecision::NeedsApproval {
                sensitive: false,
                path: read_realpath(&f)
            }
        );
        // full-auto：放行（拍板）
        env.full_auto = true;
        assert_eq!(ra.decide(&env, "s1", &f), ReadDecision::Allowed);
    }

    #[test]
    fn 敏感文件全档弹卡_附件登记即授权_目录树不覆盖敏感() {
        let (mut env, ra, _ws) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("id_rsa");
        std::fs::write(&secret, "KEY").unwrap();
        let note = outside.path().join("note.txt");
        std::fs::write(&note, "x").unwrap();
        // 敏感：ask/full-auto 都弹红卡
        assert_eq!(
            ra.decide(&env, "s1", &secret),
            ReadDecision::NeedsApproval {
                sensitive: true,
                path: read_realpath(&secret)
            }
        );
        env.full_auto = true;
        assert_eq!(
            ra.decide(&env, "s1", &secret),
            ReadDecision::NeedsApproval {
                sensitive: true,
                path: read_realpath(&secret)
            }
        );
        env.full_auto = false;
        // session 目录树授权后：普通文件放行、同目录敏感仍弹卡（covers 非敏感限定）
        ra.record_grant("s1", &note, bbrt_sec::memory::GrantScope::Session, false)
            .unwrap();
        assert_eq!(ra.decide(&env, "s1", &note), ReadDecision::Allowed);
        assert_eq!(
            ra.decide(&env, "s1", &secret),
            ReadDecision::NeedsApproval {
                sensitive: true,
                path: read_realpath(&secret)
            }
        );
        // 附件登记（用户亲自给的敏感文件也放行）
        ra.register_attachments("s2", &[att(secret.to_str().unwrap())]);
        assert_eq!(ra.decide(&env, "s2", &secret), ReadDecision::Allowed);
    }

    #[test]
    fn 一次票据消费即失效_violation记录() {
        let (env, ra, _ws) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let f = outside.path().join("a.txt");
        std::fs::write(&f, "x").unwrap();
        ra.record_grant("s1", &f, bbrt_sec::memory::GrantScope::Once, false)
            .unwrap();
        // 第一次消费成功
        assert!(ra.authorize(&env, "s1", "read_file", &f).is_ok());
        // once 票据已消费 → 拒 + violation 记录
        assert!(ra.authorize(&env, "s1", "read_file", &f).is_err());
        // （violation 记录经 env.sink——MemoryViolationSink 可查码，此处仅断言拒绝）
    }

    #[test]
    fn 永久授权拒绝_会话间隔离() {
        let (env, ra, ws) = fixture();
        let f = inside_ws(&ws, "x.txt");
        assert!(ra
            .record_grant("s1", &f, bbrt_sec::memory::GrantScope::Permanent, false)
            .is_err());
        // s2 无授权：工作区内文件也只对 s1 有效——登记表按会话隔离
        ra.record_grant("s1", &f, bbrt_sec::memory::GrantScope::Session, false)
            .unwrap();
        assert_eq!(ra.decide(&env, "s1", &f), ReadDecision::Allowed);
        // s2 对同一工作区内文件同样 Allowed（工作区内自动，与登记无关）——
        // 隔离断言用工作区外路径
        let outside = tempfile::tempdir().unwrap();
        let o = outside.path().join("o.txt");
        std::fs::write(&o, "x").unwrap();
        assert_eq!(
            ra.decide(&env, "s2", &o),
            ReadDecision::NeedsApproval {
                sensitive: false,
                path: read_realpath(&o)
            }
        );
    }
}
