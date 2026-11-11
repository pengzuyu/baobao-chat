//! bbrt-store（D11 §2.8）：Runtime 本地 SQLite 的唯一封装。
//!
//! 职责边界：
//! - 全 Runtime 唯一的 SQLite 访问点，session/sec/tools/delegate 等一律经由本 crate 读写；
//! - 打开即配置：WAL 模式、busy_timeout=5000ms、foreign_keys=ON（D11 §11 头注）；
//! - 迁移版本化：PRAGMA user_version 前向滚移、只增不改（见 migrate.rs）；
//! - 行结构体映射手写、SQL 全参数化（防注入），不引 ORM。
//!
//! 注意（D15 §1）：bbrt-memory 的 journal 是独立文件存储，不进本 crate——
//! 本库没有 journal/memory 相关表，也不要往这里加。

#![forbid(unsafe_code)]

mod migrate;
mod queries;

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

pub use queries::{
    BackendRow, CheckpointRow, ContextRow, DelegateTaskRow, EventRow, GrantRow, RunRow,
    SessionListRow, SessionRow, ViolationRow, Workspace,
};

/// 存储层错误。
///
/// DuplicateSeq 单独成员：事件镜像 WAL 的 (session_id, seq) 唯一冲突是预期内的
/// 竞态信号（D11 §9.1），上游据此做丢弃/重试决策，不能淹没在通用 SQLite 错误里。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// 打开数据库 / 创建父目录等 IO 层失败
    #[error("存储 IO 错误: {0}")]
    Io(String),
    /// 通用 SQLite 错误（含约束冲突原文，便于排查）
    #[error("SQLite 错误: {0}")]
    Sqlite(String),
    /// (session_id, seq) 唯一冲突：会话内事件序号重复
    #[error("事件 seq 重复: (session_id, seq) 唯一冲突")]
    DuplicateSeq,
    /// 迁移脚本执行失败
    #[error("迁移失败: {0}")]
    Migration(String),
    /// 参数非法（如空标题重命名）
    #[error("参数非法: {0}")]
    InvalidInput(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        // 唯一冲突消息形如 "UNIQUE constraint failed: agent_event.session_id, agent_event.seq"；
        // 外键冲突消息为 "FOREIGN KEY constraint failed"，不会被误判。
        if let rusqlite::Error::SqliteFailure(code, Some(msg)) = &e {
            if code.code == rusqlite::ErrorCode::ConstraintViolation
                && msg.contains("agent_event")
                && msg.contains("seq")
            {
                return StoreError::DuplicateSeq;
            }
        }
        StoreError::Sqlite(e.to_string())
    }
}

/// SQLite 门面：持有唯一连接（同步 API，Runtime 内单线程访问由上层保证）。
pub struct Store {
    conn: Connection,
}

impl Store {
    /// 打开（或创建）数据库文件并完成初始化：
    /// 1. 建父目录（客户端 agent/ 子目录可能尚不存在）；
    /// 2. busy_timeout=5000 → journal_mode=WAL → foreign_keys=ON；
    /// 3. 跑版本化迁移（幂等：已应用版本跳过，可安全重复调用）。
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    StoreError::Io(format!("创建数据目录失败 {}: {e}", parent.display()))
                })?;
            }
        }
        let mut conn = Connection::open(path)
            .map_err(|e| StoreError::Io(format!("打开数据库失败 {}: {e}", path.display())))?;
        conn.busy_timeout(Duration::from_millis(5000))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate::run(&mut conn)?;
        Ok(Store { conn })
    }
}

/// 当前时间（Unix 毫秒）。行结构体的时间戳列统一为 i64 毫秒（D11 §11）。
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 测试共享夹具：独立临时库 + 最小会话（事件/检查点/上下文/委派等表都有指向
/// agent_session 的外键，测试必须先落一行会话）。
#[cfg(test)]
pub(crate) mod testutil {
    use crate::{SessionRow, Store};

    /// 每个测试独立的临时目录 + Store（TempDir 必须存活到测试结束，返回值别用 `_` 丢弃）。
    pub(crate) fn open_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let store = Store::open(&dir.path().join("agent").join("runtime.sqlite3"))
            .expect("打开 Store 失败");
        (dir, store)
    }

    /// 最小合法会话行（字段取值满足 §11 的 CHECK 约束）。
    pub(crate) fn sample_session(id: &str) -> SessionRow {
        SessionRow {
            id: id.to_string(),
            workspace_id: None,
            title: "测试会话".to_string(),
            form: "workbench".to_string(),
            mode: "ask".to_string(),
            backend: None,
            model_policy: "auto".to_string(),
            model_override: None,
            status: "idle".to_string(),
            share_enabled: false,
            created_at: crate::now_ms(),
            updated_at: crate::now_ms(),
            ended_at: None,
            summary: None,
        }
    }

    /// 落一行种子会话，返回该行（updated_at 等取值由调用方按需覆盖）。
    pub(crate) fn seed_session(store: &Store, id: &str) -> SessionRow {
        let s = sample_session(id);
        store.insert_session(&s).expect("种子会话插入失败");
        s
    }
}

#[cfg(test)]
mod tests {
    use super::Store;

    /// open() 应建父目录并配好三个 PRAGMA（D11 §2.8）。
    #[test]
    fn open_sets_pragmas_and_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir
            .path()
            .join("agent")
            .join("nested")
            .join("runtime.sqlite3");
        let store = Store::open(&db).expect("打开失败");
        assert!(db.exists(), "数据库文件应已创建（含父目录）");

        let mode: String = store
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal", "journal_mode 应为 WAL");

        let fk: i64 = store
            .conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "foreign_keys 应开启");

        let busy: i64 = store
            .conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(busy, 5000, "busy_timeout 应为 5000ms");
    }

    /// foreign_keys=ON 应真实生效：向 agent_event 插入不存在的 session_id 报约束错误。
    #[test]
    fn foreign_keys_are_enforced() {
        let (_dir, store) = crate::testutil::open_store();
        let err = store
            .append_event("sess-不存在", 1, "round.start", "{}")
            .expect_err("外键约束应拦截");
        assert!(matches!(err, crate::StoreError::Sqlite(_)), "得到 {err:?}");
    }
}
