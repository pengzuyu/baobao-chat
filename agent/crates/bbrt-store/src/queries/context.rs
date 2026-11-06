//! 上下文持久化（agent_context，D11 §11）。
//!
//! 存压缩态 JSON 字符串（history/archive/key_file_map/token_usage），由
//! bbrt-context 负责结构化与压缩算法，本层只管字节往返；save 为 upsert。

use rusqlite::{params, OptionalExtension, Row};

use crate::{now_ms, Store, StoreError};

/// agent_context 行。history/token_usage 为 JSON 字符串；archive/key_file_map 可空。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct ContextRow {
    /// 主键 = 会话 id
    pub session_id: String,
    /// JSON: 近 N 轮
    pub history: String,
    /// JSON: 归档摘要段
    pub archive_summary: Option<String>,
    /// JSON: path→{usage,lines}
    pub key_file_map: Option<String>,
    /// JSON: {in,out,by_model}
    pub token_usage: String,
    pub updated_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<ContextRow> {
    Ok(ContextRow {
        session_id: row.get(0)?,
        history: row.get(1)?,
        archive_summary: row.get(2)?,
        key_file_map: row.get(3)?,
        token_usage: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

impl Store {
    /// 保存（upsert）压缩态上下文：compaction 后覆盖写，updated_at 刷新为 now。
    pub fn save_context(
        &self,
        session_id: &str,
        history_json: &str,
        archive_json: Option<&str>,
        key_file_map_json: Option<&str>,
        token_usage_json: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO agent_context
                 (session_id, history, archive_summary, key_file_map, token_usage, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id) DO UPDATE SET
                 history         = excluded.history,
                 archive_summary = excluded.archive_summary,
                 key_file_map    = excluded.key_file_map,
                 token_usage     = excluded.token_usage,
                 updated_at      = excluded.updated_at",
            params![
                session_id,
                history_json,
                archive_json,
                key_file_map_json,
                token_usage_json,
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// 取压缩态上下文；未保存过返回 None。
    pub fn load_context(&self, session_id: &str) -> Result<Option<ContextRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, history, archive_summary, key_file_map, token_usage, updated_at
             FROM agent_context WHERE session_id = ?1",
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
    use crate::testutil;

    /// 保存后取回：含可空字段 None 的全量往返。
    #[test]
    fn save_and_load_roundtrip() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");

        store
            .save_context(
                "sess-1",
                r#"[{"role":"user"}]"#,
                None,
                None,
                r#"{"in":10,"out":5}"#,
            )
            .unwrap();
        let got = store.load_context("sess-1").unwrap().expect("应有上下文");
        assert_eq!(got.session_id, "sess-1");
        assert_eq!(got.history, r#"[{"role":"user"}]"#);
        assert_eq!(got.archive_summary, None);
        assert_eq!(got.key_file_map, None);
        assert_eq!(got.token_usage, r#"{"in":10,"out":5}"#);
        assert!(got.updated_at > 0);

        // 可空字段带值再往返
        store
            .save_context(
                "sess-1",
                "[]",
                Some(r#"[{"summary":"归档段"}]"#),
                Some(r#"{"a.rs":{"usage":2,"lines":100}}"#),
                r#"{"in":1,"out":1}"#,
            )
            .unwrap();
        let got = store.load_context("sess-1").unwrap().unwrap();
        assert_eq!(
            got.archive_summary.as_deref(),
            Some(r#"[{"summary":"归档段"}]"#)
        );
        assert_eq!(
            got.key_file_map.as_deref(),
            Some(r#"{"a.rs":{"usage":2,"lines":100}}"#)
        );
    }

    /// 覆盖写：同会话二次 save 是更新而非新行（主键约束下不会插重复）。
    #[test]
    fn save_overwrites_previous() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store
            .save_context("sess-1", "v1", None, None, "t1")
            .unwrap();
        store
            .save_context("sess-1", "v2", Some("a2"), Some("k2"), "t2")
            .unwrap();

        let got = store.load_context("sess-1").unwrap().expect("应有上下文");
        assert_eq!(got.history, "v2", "后写覆盖前写");
        assert_eq!(got.token_usage, "t2");
        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM agent_context", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "upsert 不应产生第二行");
    }

    /// 未保存过 → None。
    #[test]
    fn load_missing_returns_none() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        assert!(store.load_context("sess-1").unwrap().is_none());
    }
}
