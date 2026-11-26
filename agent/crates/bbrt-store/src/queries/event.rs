//! 事件镜像 WAL（agent_event，D11 §9.1）。
//!
//! 崩溃恢复数据源：seq 会话内单调、(session_id, seq) 唯一，
//! 重复 append 报 StoreError::DuplicateSeq（预期内竞态信号，上游丢弃即可）。

use rusqlite::{params, Row};

use crate::{now_ms, Store, StoreError};

/// agent_event 行。id/payload：id 为自增主键；payload 为 JSON 字符串。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct EventRow {
    /// 自增主键（由 SQLite 分配）
    pub id: i64,
    pub session_id: String,
    /// 会话内单调序号
    pub seq: i64,
    /// 事件类型（SQL 列名 type，序列化同为 "type"）
    #[serde(rename = "type")]
    pub type_: String,
    /// JSON payload
    pub payload: String,
    pub created_at: i64,
    /// 归属 run（D16 §3.1；主循环事件为空串）
    #[serde(default)]
    pub run_id: String,
}

/// 行映射（按位置读前 7 列：id, session_id, seq, type, payload, created_at, run_id——
/// queries/search.rs 在其后追加列时复用）
pub(super) fn from_row(row: &Row<'_>) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        seq: row.get(2)?,
        type_: row.get(3)?,
        payload: row.get(4)?,
        created_at: row.get(5)?,
        run_id: row.get(6)?,
    })
}

impl Store {
    /// 追加事件（created_at 由存储侧取 now 毫秒）。
    /// (session_id, seq) 冲突 → Err(DuplicateSeq)；session_id 不存在 → 外键约束错。
    pub fn append_event(
        &self,
        session_id: &str,
        seq: i64,
        type_: &str,
        payload: &str,
    ) -> Result<(), StoreError> {
        self.append_event_with_run(session_id, seq, type_, payload, "")
    }

    /// 带 run 归属的事件追加（D16 §3.1：子 agent 里程碑事件挂 run_id；
    /// 主循环事件沿用 append_event，run_id 空）。同 (session_id, seq) 唯一约束。
    pub fn append_event_with_run(
        &self,
        session_id: &str,
        seq: i64,
        type_: &str,
        payload: &str,
        run_id: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO agent_event (session_id, seq, type, payload, created_at, run_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, seq, type_, payload, now_ms(), run_id],
        )?;
        Ok(())
    }

    /// 下一可用 seq：max(seq)+1，空会话为 1。
    pub fn next_event_seq(&self, session_id: &str) -> Result<i64, StoreError> {
        let n: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_event WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        Ok(n)
    }

    /// 增量拉取：seq 严格大于 after_seq、升序、limit 截断（恢复重放与断线补发用）。
    pub fn events_after(
        &self,
        session_id: &str,
        after_seq: i64,
        limit: u32,
    ) -> Result<Vec<EventRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, seq, type, payload, created_at, run_id FROM agent_event
             WHERE session_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after_seq, limit as i64], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 按 run 归属拉取（D33 §3.3 run.history 回放：idx_event_run 索引，
    /// id 升序=写入序；主循环事件 run_id 空串不命中）
    pub fn events_by_run(&self, run_id: &str, limit: u32) -> Result<Vec<EventRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, seq, type, payload, created_at, run_id FROM agent_event
             WHERE run_id = ?1 ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![run_id, limit as i64], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use crate::{testutil, StoreError};

    #[test]
    fn next_seq_is_monotonic_across_appends() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        // 空会话从 1 起
        assert_eq!(store.next_event_seq("sess-1").unwrap(), 1);
        for seq in 1..=3 {
            store
                .append_event("sess-1", seq, "round.start", "{}")
                .unwrap();
        }
        assert_eq!(store.next_event_seq("sess-1").unwrap(), 4);
        // 其它会话互不影响
        testutil::seed_session(&store, "sess-2");
        assert_eq!(store.next_event_seq("sess-2").unwrap(), 1);
    }

    #[test]
    fn duplicate_seq_maps_to_duplicate_seq_error() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store
            .append_event("sess-1", 1, "round.start", "{}")
            .unwrap();
        store.append_event("sess-1", 2, "round.end", "{}").unwrap();

        let err = store
            .append_event("sess-1", 1, "round.start", "{}")
            .expect_err("重复 seq 应报错");
        assert!(matches!(err, StoreError::DuplicateSeq), "得到 {err:?}");
        // 不同会话同 seq 合法（唯一约束是会话内）
        testutil::seed_session(&store, "sess-2");
        store
            .append_event("sess-2", 1, "round.start", "{}")
            .unwrap();
    }

    #[test]
    fn events_after_boundaries_order_and_limit() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        for seq in 1..=5 {
            store
                .append_event("sess-1", seq, &format!("evt-{seq}"), "{}")
                .unwrap();
        }

        // after_seq=0：全量、升序、payload/type 往返
        let all = store.events_after("sess-1", 0, 100).unwrap();
        let seqs: Vec<i64> = all.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [1, 2, 3, 4, 5]);
        assert_eq!(all[0].type_, "evt-1");
        assert_eq!(all[0].session_id, "sess-1");
        assert!(
            all.iter().all(|e| e.created_at > 0),
            "created_at 应由存储侧写入"
        );
        assert!(all[0].id > 0, "自增 id 应非零");

        // 严格大于边界：after_seq=3 → [4,5]
        let tail = store.events_after("sess-1", 3, 100).unwrap();
        let seqs: Vec<i64> = tail.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [4, 5]);

        // limit 截断 + 越过末尾返回空
        let one = store.events_after("sess-1", 0, 1).unwrap();
        assert_eq!(one.len(), 1);
        assert!(store.events_after("sess-1", 5, 10).unwrap().is_empty());

        // 不相关会话互不可见
        testutil::seed_session(&store, "sess-2");
        assert!(store.events_after("sess-2", 0, 10).unwrap().is_empty());
    }
}
