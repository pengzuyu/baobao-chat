//! 沙箱违规记录（agent_sandbox_violation，D09 §5.1 / D11 §11）。
//!
//! 只追加不改：被阻止的操作落库供工作台违规面板回看；id 由 SQLite 自增分配
//! （插入时忽略行结构体里的 id 字段，读取时回填）。

use rusqlite::{params, Row};

use crate::{Store, StoreError};

/// agent_sandbox_violation 行。detail 为打码后文本；code 取 8020-8026。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct ViolationRow {
    /// 自增主键（插入时由 SQLite 分配）
    pub id: i64,
    pub session_id: String,
    /// path | network | resource | rule | danger-cmd
    pub kind: String,
    /// 打码后的细节
    pub detail: String,
    /// 8020-8026
    pub code: i64,
    pub ts: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<ViolationRow> {
    Ok(ViolationRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        kind: row.get(2)?,
        detail: row.get(3)?,
        code: row.get(4)?,
        ts: row.get(5)?,
    })
}

impl Store {
    /// 追加违规记录（id 自增分配，v.id 被忽略）。
    pub fn insert_violation(&self, v: &ViolationRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO agent_sandbox_violation (session_id, kind, detail, code, ts)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![v.session_id, v.kind, v.detail, v.code, v.ts],
        )?;
        Ok(())
    }

    /// 会话违规列表：ts 倒序（最近在前）、limit 截断，走 idx_violation_session。
    pub fn list_violations(
        &self,
        session_id: &str,
        limit: u32,
    ) -> Result<Vec<ViolationRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, kind, detail, code, ts FROM agent_sandbox_violation
             WHERE session_id = ?1 ORDER BY ts DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session_id, limit as i64], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use crate::{testutil, ViolationRow};

    fn v(session: &str, kind: &str, code: i64, ts: i64) -> ViolationRow {
        ViolationRow {
            id: 0, // 自增列，插入时忽略
            session_id: session.to_string(),
            kind: kind.to_string(),
            detail: "已打码细节".to_string(),
            code,
            ts,
        }
    }

    /// 追加后按 ts 倒序、limit 截断；自增 id 由库分配；同 ts 以 id 决胜。
    #[test]
    fn insert_and_list_desc_with_limit() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        for (kind, code, ts) in [
            ("path", 8020, 1000),
            ("network", 8023, 3000),
            ("rule", 8025, 2000),
        ] {
            store
                .insert_violation(&v("sess-1", kind, code, ts))
                .unwrap();
        }

        let all = store.list_violations("sess-1", 10).unwrap();
        let kinds: Vec<&str> = all.iter().map(|x| x.kind.as_str()).collect();
        assert_eq!(kinds, ["network", "rule", "path"], "ts 倒序");
        assert!(all.iter().all(|x| x.id > 0), "自增 id 应非零");
        assert_eq!(all[0].code, 8023);

        // limit 截断
        let top = store.list_violations("sess-1", 1).unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].kind, "network");

        // 其它会话不可见
        testutil::seed_session(&store, "sess-2");
        assert!(store.list_violations("sess-2", 10).unwrap().is_empty());
    }
}
