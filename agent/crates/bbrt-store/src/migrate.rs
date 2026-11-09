//! 版本化迁移（D11 §2.8：向前滚移、只增不改、幂等）。
//!
//! 版本号存 PRAGMA user_version：0 表示全新库；下标 i 的脚本对应版本 i+1。
//! 已应用（user_version ≥ 目标版本）的脚本直接跳过，因此对同一文件重复 open 安全；
//! 每个脚本一个事务：建表 DDL 与 user_version 提升同生共死，中途失败自动回滚。
//!
//! 维护纪律：只允许向 MIGRATIONS 追加新脚本（002_*、003_* …），
//! 已发布脚本一个字符都不许改。

use rusqlite::Connection;

use crate::StoreError;

/// 迁移脚本清单（下标即版本号-1）。001_init 为 D11 §11 全表 DDL 逐表照建；
/// 002 增列 model_override（会话级模型直达引用，0023 多供应商）；
/// 003 子 Agent run 记录模型（agent_run 表 + agent_event.run_id，D16 §3.1）。
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/001_init.sql"),
    include_str!("migrations/002_model_override.sql"),
    include_str!("migrations/003_subagent_run.sql"),
];

/// 执行所有未应用的迁移。
pub(crate) fn run(conn: &mut Connection) -> Result<(), StoreError> {
    let mut current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| StoreError::Migration(format!("读取 user_version 失败: {e}")))?;
    for (idx, script) in MIGRATIONS.iter().enumerate() {
        let target = idx as i64 + 1;
        if current >= target {
            continue; // 幂等：已应用跳过
        }
        let tx = conn
            .transaction()
            .map_err(|e| StoreError::Migration(format!("开启迁移事务失败: {e}")))?;
        tx.execute_batch(script)
            .map_err(|e| StoreError::Migration(format!("版本 {target} 迁移脚本执行失败: {e}")))?;
        tx.pragma_update(None, "user_version", target)
            .map_err(|e| {
                StoreError::Migration(format!("user_version 提升到 {target} 失败: {e}"))
            })?;
        tx.commit()
            .map_err(|e| StoreError::Migration(format!("提交版本 {target} 失败: {e}")))?;
        current = target;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{run, MIGRATIONS};
    use crate::Store;

    /// 同一文件 open 两次：第二次迁移应整体跳过（重复 CREATE TABLE 会直接报错）。
    #[test]
    fn open_twice_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.sqlite3");
        Store::open(&path).expect("首次打开失败");
        let store = Store::open(&path).expect("二次打开失败（迁移应幂等跳过）");
        let v: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64, "迁移后 user_version 应到位");
    }

    /// 迁移落库后重开：版本保持、数据仍在（WAL 落盘）。
    #[test]
    fn migration_version_and_data_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.sqlite3");
        {
            let store = Store::open(&path).unwrap();
            crate::testutil::seed_session(&store, "sess-keep");
        }
        let store2 = Store::open(&path).unwrap();
        let v: i64 = store2
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        assert!(
            store2.get_session("sess-keep").unwrap().is_some(),
            "重开后数据应仍在"
        );
    }

    /// run() 对全新连接应把 user_version 从 0 提到 1。
    #[test]
    fn run_sets_user_version_on_fresh_db() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run(&mut conn).expect("内存库迁移失败");
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        // 再跑一遍验证幂等分支（conn 已应用）
        run(&mut conn).expect("重复迁移失败");
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_event'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
    }
}
