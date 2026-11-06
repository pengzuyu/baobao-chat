//! 变更检查点（agent_checkpoint，D11 §11 / 重放起点 §9.2）。
//!
//! last_event_seq 是恢复重放起点；last_checkpoint 按 created_at 倒序取最新，
//! 同毫秒并列时以 rowid 决胜（保证确定性）。

use rusqlite::{params, OptionalExtension, Row};

use crate::{Store, StoreError};

/// agent_checkpoint 行。files_changed 为 JSON（[{path,add,del}]），untracked/git_ref 可空。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct CheckpointRow {
    /// cp-<ulid>
    pub id: String,
    pub session_id: String,
    /// refs/bbw-agent/{session}/cp-{n}
    pub git_ref: Option<String>,
    /// JSON: 未跟踪文件清单
    pub untracked: Option<String>,
    /// JSON: [{path,add,del}]
    pub files_changed: String,
    /// pre-edit | pre-command | manual | delegate | pre-restore
    pub reason: String,
    /// 重放起点（§9.2）
    pub last_event_seq: i64,
    pub created_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<CheckpointRow> {
    Ok(CheckpointRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        git_ref: row.get(2)?,
        untracked: row.get(3)?,
        files_changed: row.get(4)?,
        reason: row.get(5)?,
        last_event_seq: row.get(6)?,
        created_at: row.get(7)?,
    })
}

impl Store {
    /// 登记检查点（id 冲突由主键约束兜底）。
    pub fn insert_checkpoint(&self, c: &CheckpointRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO agent_checkpoint
                 (id, session_id, git_ref, untracked, files_changed, reason,
                  last_event_seq, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                c.id,
                c.session_id,
                c.git_ref,
                c.untracked,
                c.files_changed,
                c.reason,
                c.last_event_seq,
                c.created_at
            ],
        )?;
        Ok(())
    }

    /// 会话最新检查点（created_at 倒序，同毫秒按 rowid 决胜）；无则 None。
    pub fn last_checkpoint(&self, session_id: &str) -> Result<Option<CheckpointRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, git_ref, untracked, files_changed, reason,
                    last_event_seq, created_at
             FROM agent_checkpoint
             WHERE session_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1",
        )?;
        let row = stmt
            .query_row(params![session_id], from_row)
            .optional()
            .map_err(StoreError::from)?;
        Ok(row)
    }
}

#[cfg(test)]
mod tests {
    use crate::{testutil, CheckpointRow};

    fn cp(id: &str, session: &str, seq: i64, created: i64) -> CheckpointRow {
        CheckpointRow {
            id: id.to_string(),
            session_id: session.to_string(),
            git_ref: Some(format!("refs/bbw-agent/{session}/{id}")),
            untracked: Some(r#"["a.txt"]"#.to_string()),
            files_changed: r#"[{"path":"a.txt","add":3,"del":1}]"#.to_string(),
            reason: "pre-edit".to_string(),
            last_event_seq: seq,
            created_at: created,
        }
    }

    /// 插入两个检查点：last 取 created_at 最新那个，字段全量往返。
    #[test]
    fn last_checkpoint_returns_newest() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store
            .insert_checkpoint(&cp("cp-1", "sess-1", 10, 1000))
            .unwrap();
        store
            .insert_checkpoint(&cp("cp-2", "sess-1", 20, 2000))
            .unwrap();

        let last = store
            .last_checkpoint("sess-1")
            .unwrap()
            .expect("应有检查点");
        assert_eq!(last, cp("cp-2", "sess-1", 20, 2000));
    }

    /// 无检查点 / 其它会话互不可见 → None。
    #[test]
    fn last_checkpoint_none_when_absent() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        testutil::seed_session(&store, "sess-2");
        store
            .insert_checkpoint(&cp("cp-1", "sess-1", 10, 1000))
            .unwrap();

        assert!(store.last_checkpoint("sess-2").unwrap().is_none());
        assert!(store.last_checkpoint("sess-不存在").unwrap().is_none());
    }
}
