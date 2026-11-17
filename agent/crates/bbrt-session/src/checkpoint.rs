//! 变更检查点（08 §4.4 stash 式快照 + D11 §11 agent_checkpoint）。
//!
//! 快照 = `git stash create` 等价物落隐藏 ref `refs/bbc-agent/{session}/cp-{n}`
//! （不触碰工作区/索引；干净树退化用 HEAD）；未跟踪文件记清单不搬移。
//! 恢复 = `git read-tree -u --reset` 回放该树（先建 pre-restore 保护快照，
//! 未跟踪文件不动）。非 git 工作区：快照仍登记（git_ref 空、无差异——
//! 时间线锚点），恢复拒绝。
//!
//! 与沙箱的关系：检查点由 Runtime 发起而非模型工具调用，git 直跑
//! （同 delegate 进程管理先例；D13 约束的是模型发起的命令）。

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use bbrt_protocol::FileChange;
use bbrt_store::{CheckpointRow, Store};

/// pre-edit 快照复用窗口（08 §4.4"同批共用，间隔 >5min 或跨任务再建"）
const EDIT_SNAPSHOT_WINDOW_MS: i64 = 5 * 60 * 1000;

/// 快照产物（loop/bridge 事件外发用）
#[derive(Debug, Clone)]
pub struct SnapshotOutcome {
    pub checkpoint_id: String,
    pub git_ref: Option<String>,
    pub files_changed: Vec<FileChange>,
    pub untracked: Vec<String>,
    pub reason: String,
}

/// 检查点服务（依赖倒置：bin 以真实 git+Store 实现；测试注入假件）
pub trait SnapshotService: Send + Sync {
    /// 建检查点（reason: pre-edit | pre-command | manual | delegate | pre-restore）
    fn create(
        &self,
        session_id: &str,
        workspace: &str,
        reason: &str,
    ) -> Result<SnapshotOutcome, String>;

    /// pre-edit 快照（服务内 5min 窗口去重；None=窗口内已建，复用上一枚）
    fn pre_edit(
        &self,
        session_id: &str,
        workspace: &str,
    ) -> Result<Option<SnapshotOutcome>, String>;

    /// 恢复到检查点（先建 pre-restore 保护快照）；Ok=保护快照 id
    fn restore(
        &self,
        session_id: &str,
        workspace: &str,
        checkpoint_id: &str,
    ) -> Result<String, String>;
}

/// 真实实现：SQLite 登记 + git 快照/恢复（store 经 Mutex 共享，与 bin 装配一致）
pub struct GitSnapshots {
    store: Arc<Mutex<Store>>,
}

impl GitSnapshots {
    pub fn new(store: Arc<Mutex<Store>>) -> Self {
        Self { store }
    }
}

impl SnapshotService for GitSnapshots {
    fn create(
        &self,
        session_id: &str,
        workspace: &str,
        reason: &str,
    ) -> Result<SnapshotOutcome, String> {
        let store = self.store.lock().map_err(|_| "存储锁中毒".to_string())?;
        create_snapshot(&store, session_id, workspace, reason)
    }

    fn pre_edit(
        &self,
        session_id: &str,
        workspace: &str,
    ) -> Result<Option<SnapshotOutcome>, String> {
        let store = self.store.lock().map_err(|_| "存储锁中毒".to_string())?;
        if let Some(last) = store
            .last_checkpoint(session_id)
            .map_err(|e| e.to_string())?
        {
            if now_ms() - last.created_at < EDIT_SNAPSHOT_WINDOW_MS {
                return Ok(None);
            }
        }
        create_snapshot(&store, session_id, workspace, "pre-edit").map(Some)
    }

    fn restore(
        &self,
        session_id: &str,
        workspace: &str,
        checkpoint_id: &str,
    ) -> Result<String, String> {
        let store = self.store.lock().map_err(|_| "存储锁中毒".to_string())?;
        restore_snapshot(&store, session_id, workspace, checkpoint_id)
    }
}

// ---------------------------------------------------------------------------
// 核心实现（&Store 纯函数化，便于直接单测）
// ---------------------------------------------------------------------------

fn create_snapshot(
    store: &Store,
    session_id: &str,
    workspace: &str,
    reason: &str,
) -> Result<SnapshotOutcome, String> {
    let dir = Path::new(workspace);
    let is_repo = git(dir, &["rev-parse", "--is-inside-work-tree"])
        .map(|v| v == "true")
        .unwrap_or(false);

    let (git_ref, files_changed, untracked) = if is_repo {
        // stash create：索引+工作区已跟踪修改落提交对象；干净树输出空 → 退化 HEAD
        let sha = {
            let s = git(dir, &["stash", "create"]).unwrap_or_default();
            if s.is_empty() {
                git(dir, &["rev-parse", "HEAD"])?
            } else {
                s
            }
        };
        let n = store
            .count_checkpoints(session_id)
            .map_err(|e| e.to_string())?;
        let r = format!("refs/bbc-agent/{session_id}/cp-{n}");
        git(dir, &["update-ref", &r, &sha])?;
        let files = parse_numstat(&git(dir, &["diff", "HEAD", "--numstat"])?);
        let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect();
        (Some(r), files, untracked)
    } else {
        // 非 git 工作区：仍登记时间线锚点（git_ref 空），restore 拒绝
        (None, vec![], vec![])
    };

    let row = CheckpointRow {
        id: new_cp_id(),
        session_id: session_id.to_string(),
        git_ref: git_ref.clone(),
        untracked: if untracked.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&untracked).unwrap_or_else(|_| "[]".into()))
        },
        files_changed: serde_json::to_string(&files_changed).unwrap_or_else(|_| "[]".into()),
        reason: reason.to_string(),
        last_event_seq: store.next_event_seq(session_id).map(|n| n - 1).unwrap_or(0),
        created_at: now_ms(),
    };
    store.insert_checkpoint(&row).map_err(|e| e.to_string())?;
    Ok(SnapshotOutcome {
        checkpoint_id: row.id,
        git_ref,
        files_changed,
        untracked,
        reason: reason.to_string(),
    })
}

fn restore_snapshot(
    store: &Store,
    session_id: &str,
    workspace: &str,
    checkpoint_id: &str,
) -> Result<String, String> {
    let row = store
        .get_checkpoint(checkpoint_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "检查点不存在".to_string())?;
    if row.session_id != session_id {
        return Err("检查点不属于该会话".into());
    }
    let Some(git_ref) = row.git_ref.as_ref() else {
        return Err("非 git 工作区的检查点无法恢复".into());
    };
    // 先落保护快照（pre-restore），恢复动作本身可再恢复
    let guard = create_snapshot(store, session_id, workspace, "pre-restore")?;
    let dir = Path::new(workspace);
    let sha = git(dir, &["rev-parse", git_ref])?;
    git(dir, &["read-tree", "-u", "--reset", &sha])?;
    Ok(guard.checkpoint_id)
}

// ---------------------------------------------------------------------------
// git 子进程与工具
// ---------------------------------------------------------------------------

/// 跑 git（cwd=workspace；检查点为 Runtime 发起，不经模型命令沙箱——见模块注释）
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git 启动失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} 失败: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git diff --numstat` 输出（`add\tdel\tpath`；二进制为 `-` 记 0）
fn parse_numstat(out: &str) -> Vec<FileChange> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split('\t');
            let add = it.next()?;
            let del = it.next()?;
            let path = it.next()?.to_string();
            Some(FileChange {
                path,
                add: add.parse().unwrap_or(0),
                del: del.parse().unwrap_or(0),
            })
        })
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// cp-<ms>-<seq>（DDL 语义 cp-<ulid> 的简化唯一形；同毫秒以序号决胜）
static CP_SEQ: AtomicU64 = AtomicU64::new(0);
fn new_cp_id() -> String {
    format!("cp-{}-{}", now_ms(), CP_SEQ.fetch_add(1, Ordering::Relaxed))
}
