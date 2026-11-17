//! 三级授权记忆（09 篇 §4.2；D11 §2.5 memory.rs）。
//!
//! **这是权限记忆（放行记忆），不是知识记忆**：记录的是"用户允许过某工具+参数形态"，
//! 命中即代表门控第④步放行（decision_source=memory）。
//!
//! - once：仅当前这一次调用，命中即消费；
//! - session：本会话内同工具+同参数形态（Runtime 内存，会话结束失效）；
//! - permanent：用户级持久（本 crate 提供内存视图 + 序列化接口，落 allow.json 由 store 层负责）。
//!
//! 硬规则（A2/A5/§4.2）：**高危工具（永不全自动清单）的 pattern 永不匹配 permanent**——
//! insert 时拒绝，match 时防御性跳过（双保险，防绕过/防脏数据）。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 授权 scope（09 §4.2 表）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantScope {
    /// 本次允许：仅当前这一次调用，立即失效
    Once,
    /// 会话内允许：本会话同工具+同参数形态
    Session,
    /// 永久允许：写入用户级 allow.json（此处为内存视图）
    Permanent,
}

/// 永久记忆硬名单（§4.2 限制条款；**D32 修订**：触人/出域动作最多 Session 级记忆，
/// file_upload/app_write 补齐 CorpWrite 全集；网络出站 http_fetch 可记忆故不在此列）
const NEVER_PERMANENT_TOOLS: [&str; 6] = [
    "git_push",
    "doc_write",
    "im_send",
    "file_upload",
    "app_write",
    "coding.delegate",
];

/// 一条授权记忆（§5.1 agent_tool_grant 表的内存形态）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// 工具名（如 run_command / edit_file）
    pub tool: String,
    /// 参数模式：`*` 通配（前缀 `cargo test*`、后缀 `*.rs`、中缀皆可；无 `*` 为全等）
    pub pattern: String,
    /// scope
    pub scope: GrantScope,
    /// 授权时间（epoch 毫秒，审计字段）
    pub granted_at_ms: u64,
}

/// 授权记忆错误
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MemoryError {
    /// 高危工具禁止永久记忆（A5/A2：双重提示类不可永久）
    #[error("工具 {tool} 属高危清单，禁止永久记忆（09 §4.2 限制）")]
    PermanentForbidden {
        /// 被拒绝的工具名
        tool: String,
    },
    /// 模式为空（无意义的授权）
    #[error("授权 pattern 不能为空")]
    EmptyPattern,
}

/// 命中结果：scope + 命中的模式（审计 decision_source=memory 时回填）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantMatch {
    /// 命中的 scope
    pub scope: GrantScope,
    /// 命中的模式串
    pub pattern: String,
}

/// 三级授权记忆存储（内存版；permanent 的持久化由 store 层加载/回放）
#[derive(Debug, Default)]
pub struct GrantStore {
    grants: Mutex<Vec<Grant>>,
}

impl GrantStore {
    /// 空存储
    pub fn new() -> Self {
        Self::default()
    }

    /// 工具是否允许永久记忆（硬名单外允许；租户总开关策略在上层收敛后仍走此硬名单）
    pub fn permanent_allowed(tool: &str) -> bool {
        !NEVER_PERMANENT_TOOLS.contains(&tool)
    }

    /// 写入一条授权。校验：pattern 非空；permanent + 高危工具 → 拒绝（硬规则）。
    pub fn insert(&self, grant: Grant) -> Result<(), MemoryError> {
        if grant.pattern.is_empty() {
            return Err(MemoryError::EmptyPattern);
        }
        if grant.scope == GrantScope::Permanent && !Self::permanent_allowed(&grant.tool) {
            return Err(MemoryError::PermanentForbidden {
                tool: grant.tool.clone(),
            });
        }
        let mut grants = self.lock();
        // 同工具+同模式重复授权：取更宽 scope 覆盖，避免堆积
        grants.retain(|g| !(g.tool == grant.tool && g.pattern == grant.pattern));
        grants.push(grant);
        Ok(())
    }

    /// 匹配当前调用：按"最具体模式优先"（模式长者优先），once 命中即消费。
    /// 防御性规则：高危工具的 permanent 条目即便存在也不匹配（双保险）。
    pub fn match_call(&self, tool: &str, args: &str) -> Option<GrantMatch> {
        let mut grants = self.lock();
        // 收集命中（once 命中需移除，先记录索引）
        let mut best: Option<(usize, Grant)> = None;
        for (idx, g) in grants.iter().enumerate() {
            if g.tool != tool || !pattern_matches(&g.pattern, args) {
                continue;
            }
            if g.scope == GrantScope::Permanent && !Self::permanent_allowed(tool) {
                continue; // 防御：脏数据里的高危永久条目不生效
            }
            let better = match &best {
                None => true,
                Some((_, bg)) => g.pattern.len() > bg.pattern.len(),
            };
            if better {
                best = Some((idx, g.clone()));
            }
        }
        let (idx, g) = best?;
        if g.scope == GrantScope::Once {
            grants.remove(idx); // 消费型：单次调用有效
        }
        Some(GrantMatch {
            scope: g.scope,
            pattern: g.pattern,
        })
    }

    /// 会话结束：清除 session 与未消费的 once 条目（permanent 保留）
    pub fn clear_session(&self) {
        self.lock().retain(|g| g.scope == GrantScope::Permanent);
    }

    /// 当前条目数（测试/健康检查）
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// 全量条目快照（permanent 持久化到 allow.json 的导出口）
    pub fn snapshot(&self) -> Vec<Grant> {
        self.lock().clone()
    }

    /// 批量导入（allow.json 加载恢复）
    pub fn load(&self, grants: Vec<Grant>) -> Result<(), MemoryError> {
        for g in grants {
            self.insert(g)?;
        }
        Ok(())
    }

    /// 锁辅助（ poisoned 时重建——授权记忆非关键数据，宁可清空不可 panic/死锁）
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Grant>> {
        self.grants.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// 参数模式匹配：`*` 通配（可多个，匹配任意字符序列含空）。
/// 例：`cargo test*` 前缀、`*.rs` 后缀、`src/*.rs` 中缀、`exact` 全等。
fn pattern_matches(pattern: &str, text: &str) -> bool {
    let (p, t) = (pattern.as_bytes(), text.as_bytes());
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    #[test]
    fn pattern_matching_prefix_suffix_middle_exact() {
        assert!(pattern_matches("cargo test*", "cargo test --lib"));
        assert!(!pattern_matches("cargo test*", "cargo build"));
        assert!(pattern_matches("*.rs", "src/main.rs"));
        assert!(!pattern_matches("*.rs", "src/main.rs.bak"));
        assert!(pattern_matches("src/*.rs", "src/gate.rs"));
        assert!(pattern_matches("exact cmd", "exact cmd"));
        assert!(pattern_matches("*", "anything at all"));
    }

    #[test]
    fn session_grant_matches_within_session_and_clears() {
        let store = GrantStore::new();
        store
            .insert(Grant {
                tool: "run_command".into(),
                pattern: "cargo test*".into(),
                scope: GrantScope::Session,
                granted_at_ms: now(),
            })
            .unwrap();
        let m = store.match_call("run_command", "cargo test --lib").unwrap();
        assert_eq!(m.scope, GrantScope::Session);
        assert_eq!(m.pattern, "cargo test*");
        // 会话内持续命中
        assert!(store.match_call("run_command", "cargo test").is_some());
        // 其它工具/形态不命中
        assert!(store.match_call("run_command", "cargo build").is_none());
        assert!(store.match_call("edit_file", "src/x.rs").is_none());
        // 会话结束清空
        store.clear_session();
        assert!(store.match_call("run_command", "cargo test").is_none());
    }

    #[test]
    fn once_grant_is_consumed_after_single_use() {
        let store = GrantStore::new();
        store
            .insert(Grant {
                tool: "run_command".into(),
                pattern: "rm -rf ./target*".into(),
                scope: GrantScope::Once,
                granted_at_ms: now(),
            })
            .unwrap();
        assert!(store
            .match_call("run_command", "rm -rf ./target/debug")
            .is_some());
        assert!(store
            .match_call("run_command", "rm -rf ./target/debug")
            .is_none());
    }

    #[test]
    fn permanent_grant_persists_across_sessions() {
        let store = GrantStore::new();
        store
            .insert(Grant {
                tool: "run_command".into(),
                pattern: "cargo test*".into(),
                scope: GrantScope::Permanent,
                granted_at_ms: now(),
            })
            .unwrap();
        store.clear_session();
        assert_eq!(
            store.match_call("run_command", "cargo test").unwrap().scope,
            GrantScope::Permanent
        );
    }

    #[test]
    fn never_permanent_tools_rejected_on_insert_and_ignored_on_match() {
        let store = GrantStore::new();
        for tool in NEVER_PERMANENT_TOOLS {
            let err = store
                .insert(Grant {
                    tool: tool.into(),
                    pattern: "*".into(),
                    scope: GrantScope::Permanent,
                    granted_at_ms: now(),
                })
                .unwrap_err();
            assert_eq!(
                err,
                MemoryError::PermanentForbidden {
                    tool: tool.to_string()
                }
            );
        }
        // 防御性：脏数据直接塞入（绕过 insert）后 match 也不生效
        store.lock().push(Grant {
            tool: "git_push".into(),
            pattern: "origin*".into(),
            scope: GrantScope::Permanent,
            granted_at_ms: now(),
        });
        assert!(store.match_call("git_push", "origin main").is_none());
        // session scope 不受影响
        store
            .insert(Grant {
                tool: "git_push".into(),
                pattern: "origin*".into(),
                scope: GrantScope::Session,
                granted_at_ms: now(),
            })
            .unwrap();
        assert!(store.match_call("git_push", "origin main").is_some());
    }

    #[test]
    fn empty_pattern_rejected_and_snapshot_load_roundtrip() {
        let store = GrantStore::new();
        assert_eq!(
            store.insert(Grant {
                tool: "edit_file".into(),
                pattern: String::new(),
                scope: GrantScope::Session,
                granted_at_ms: now(),
            }),
            Err(MemoryError::EmptyPattern)
        );
        store
            .insert(Grant {
                tool: "edit_file".into(),
                pattern: "*.rs".into(),
                scope: GrantScope::Permanent,
                granted_at_ms: 42,
            })
            .unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.len(), 1);
        let store2 = GrantStore::new();
        store2.load(snap.clone()).unwrap();
        assert!(store2.match_call("edit_file", "src/a.rs").is_some());
        // JSON 形态（camelCase 契约）
        let j = serde_json::to_string(&snap[0]).unwrap();
        assert!(j.contains("\"grantedAtMs\":42"));
    }

    #[test]
    fn most_specific_pattern_wins() {
        let store = GrantStore::new();
        for (pat, scope) in [
            ("cargo*", GrantScope::Session),
            ("cargo test*", GrantScope::Session),
        ] {
            store
                .insert(Grant {
                    tool: "run_command".into(),
                    pattern: pat.into(),
                    scope,
                    granted_at_ms: now(),
                })
                .unwrap();
        }
        let m = store.match_call("run_command", "cargo test").unwrap();
        assert_eq!(m.pattern, "cargo test*");
    }
}
