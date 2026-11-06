//! 委派任务（delegate_task，D11 §11 / 17 篇 §7）。
//!
//! 状态机：preparing → running → completed/failed/cancelled → reviewing →
//! accepted/rejected_restored；本层只持久化状态迁移结果，不做状态校验。

use rusqlite::{params, Row};

use crate::{Store, StoreError};

/// delegate_task 行。task_brief/result_summary 为 JSON 字符串。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct DelegateTaskRow {
    /// dt-<ulid>
    pub id: String,
    pub parent_session_id: String,
    pub backend_type: String,
    /// JSON TaskBrief
    pub task_brief: String,
    /// preparing | running | completed | failed | cancelled | reviewing | accepted | rejected_restored
    pub status: String,
    /// --resume 等续接句柄
    pub child_session_ref: Option<String>,
    pub exit_code: Option<i32>,
    pub result_summary: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<DelegateTaskRow> {
    Ok(DelegateTaskRow {
        id: row.get(0)?,
        parent_session_id: row.get(1)?,
        backend_type: row.get(2)?,
        task_brief: row.get(3)?,
        status: row.get(4)?,
        child_session_ref: row.get(5)?,
        exit_code: row.get(6)?,
        result_summary: row.get(7)?,
        created_at: row.get(8)?,
        started_at: row.get(9)?,
        ended_at: row.get(10)?,
    })
}

impl Store {
    /// 登记委派任务（id 冲突由主键约束兜底）。
    pub fn insert_delegate_task(&self, t: &DelegateTaskRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO delegate_task
                 (id, parent_session_id, backend_type, task_brief, status,
                  child_session_ref, exit_code, result_summary, created_at, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                t.id,
                t.parent_session_id,
                t.backend_type,
                t.task_brief,
                t.status,
                t.child_session_ref,
                t.exit_code,
                t.result_summary,
                t.created_at,
                t.started_at,
                t.ended_at
            ],
        )?;
        Ok(())
    }

    /// 更新任务进度：status / exit_code / result_summary（时间戳列由调用方
    /// 视需要经同表 update 补写，本方法保持最小集）。
    pub fn update_delegate_task(
        &self,
        id: &str,
        status: &str,
        exit_code: Option<i32>,
        summary: Option<&str>,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE delegate_task
             SET status = ?2, exit_code = ?3, result_summary = ?4
             WHERE id = ?1",
            params![id, status, exit_code, summary],
        )?;
        Ok(())
    }

    /// 父会话的委派任务列表：created_at 倒序（最新委派在前）、limit 截断，
    /// 走 idx_delegate_parent。
    pub fn list_delegate_tasks(
        &self,
        parent_session: &str,
        limit: u32,
    ) -> Result<Vec<DelegateTaskRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, parent_session_id, backend_type, task_brief, status,
                    child_session_ref, exit_code, result_summary, created_at, started_at, ended_at
             FROM delegate_task
             WHERE parent_session_id = ?1
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![parent_session, limit as i64], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use crate::{testutil, DelegateTaskRow};

    fn task(id: &str, parent: &str, created: i64) -> DelegateTaskRow {
        DelegateTaskRow {
            id: id.to_string(),
            parent_session_id: parent.to_string(),
            backend_type: "zcode".to_string(),
            task_brief: r#"{"goal":"修个 bug"}"#.to_string(),
            status: "preparing".to_string(),
            child_session_ref: None,
            exit_code: None,
            result_summary: None,
            created_at: created,
            started_at: None,
            ended_at: None,
        }
    }

    /// 全生命周期：插入 → 更新（running/completed）→ 列表倒序；其它父会话隔离。
    #[test]
    fn insert_update_and_list_lifecycle() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-parent");
        testutil::seed_session(&store, "sess-other");
        store
            .insert_delegate_task(&task("dt-1", "sess-parent", 1000))
            .unwrap();
        store
            .insert_delegate_task(&task("dt-2", "sess-parent", 2000))
            .unwrap();
        store
            .insert_delegate_task(&task("dt-9", "sess-other", 3000))
            .unwrap();

        // 跑起来：补续接句柄走整行 update（update_delegate_task 只动 4 个字段，
        // child_session_ref 变更由上层重插/专用方法处理，这里只验证最小集）
        store
            .update_delegate_task("dt-2", "running", None, None)
            .unwrap();
        // 完成：带退出码与结果摘要
        store
            .update_delegate_task("dt-2", "completed", Some(0), Some(r#"{"done":true}"#))
            .unwrap();

        let list = store.list_delegate_tasks("sess-parent", 10).unwrap();
        assert_eq!(list.len(), 2, "只列父会话任务");
        let ids: Vec<&str> = list.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["dt-2", "dt-1"], "created_at 倒序");

        let done = &list[0];
        assert_eq!(done.status, "completed");
        assert_eq!(done.exit_code, Some(0));
        assert_eq!(done.result_summary.as_deref(), Some(r#"{"done":true}"#));
        assert_eq!(done.task_brief, r#"{"goal":"修个 bug"}"#);

        let pending = &list[1];
        assert_eq!(pending.status, "preparing", "未更新的任务保持原状态");

        // limit 截断
        assert_eq!(
            store.list_delegate_tasks("sess-parent", 1).unwrap().len(),
            1
        );
        // 其它父会话只看到自己的
        let other = store.list_delegate_tasks("sess-other", 10).unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].id, "dt-9");
    }
}
