//! 工作区登记（agent_workspace，D11 §11）。
//!
//! path 是业务身份锚点（realpath 唯一）：同一目录重复打开走 upsert 更新，
//! 首次登记的 created_at 不被覆盖。

use rusqlite::{params, OptionalExtension, Row};

use crate::{Store, StoreError};

/// agent_workspace 行。时间戳为 i64 毫秒；extra_dirs 为 JSON 数组字符串（例外目录[]）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct Workspace {
    /// ws-<ulid>
    pub id: String,
    /// realpath，唯一
    pub path: String,
    pub name: String,
    /// git 探测结果
    pub is_repo: bool,
    /// 信任确认（D08 §4.4）
    pub trusted: bool,
    /// JSON: 例外目录[]
    pub extra_dirs: Option<String>,
    pub last_opened_at: i64,
    pub created_at: i64,
}

/// 行映射（列序与 COLS 一致）
fn from_row(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        is_repo: row.get::<_, i64>(3)? != 0,
        trusted: row.get::<_, i64>(4)? != 0,
        extra_dirs: row.get(5)?,
        last_opened_at: row.get(6)?,
        created_at: row.get(7)?,
    })
}

impl Store {
    /// 按路径 upsert：path 冲突则更新展示/信任字段与 last_opened_at；
    /// id、created_at 保留首次登记值（同目录重复打开不换身份）。
    pub fn upsert_workspace(&self, w: &Workspace) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO agent_workspace
                 (id, path, name, is_repo, trusted, extra_dirs, last_opened_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(path) DO UPDATE SET
                 name           = excluded.name,
                 is_repo        = excluded.is_repo,
                 trusted        = excluded.trusted,
                 extra_dirs     = excluded.extra_dirs,
                 last_opened_at = excluded.last_opened_at",
            params![
                w.id,
                w.path,
                w.name,
                w.is_repo,
                w.trusted,
                w.extra_dirs,
                w.last_opened_at,
                w.created_at
            ],
        )?;
        Ok(())
    }

    /// 按 realpath 精确查工作区。
    pub fn get_workspace_by_path(&self, path: &str) -> Result<Option<Workspace>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, is_repo, trusted, extra_dirs, last_opened_at, created_at
             FROM agent_workspace WHERE path = ?1",
        )?;
        let ws = stmt
            .query_row(params![path], from_row)
            .optional()
            .map_err(StoreError::from)?;
        Ok(ws)
    }

    /// 按 id 精确查项目（2026-11-11 会话复活：session 行 workspace_id → 路径还原）
    pub fn get_workspace(&self, id: &str) -> Result<Option<Workspace>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, is_repo, trusted, extra_dirs, last_opened_at, created_at
             FROM agent_workspace WHERE id = ?1",
        )?;
        let ws = stmt
            .query_row(params![id], from_row)
            .optional()
            .map_err(StoreError::from)?;
        Ok(ws)
    }

    /// 全量项目列表（D19 workspace.list；last_opened_at 倒序=最近打开在前）。
    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, is_repo, trusted, extra_dirs, last_opened_at, created_at
             FROM agent_workspace ORDER BY last_opened_at DESC",
        )?;
        let rows = stmt.query_map([], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 移除项目登记（D19 workspace.forget；只删登记行——会话行 workspace_id
    /// 置 NULL（历史会话仍在列表、归入日常展示），记忆分区文件不动）。
    pub fn remove_workspace(&self, id: &str) -> Result<bool, StoreError> {
        let n = self.conn.execute(
            "UPDATE agent_session SET workspace_id = NULL WHERE workspace_id = ?1",
            params![id],
        )?;
        let _ = n; // 解除关联行数不回传（尽力清理）
        let removed = self
            .conn
            .execute("DELETE FROM agent_workspace WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::Workspace;
    use crate::testutil;

    fn ws(id: &str, path: &str, trusted: bool, last_opened: i64) -> Workspace {
        Workspace {
            id: id.to_string(),
            path: path.to_string(),
            name: "项目".to_string(),
            is_repo: true,
            trusted,
            extra_dirs: Some(r#"["/tmp/out"]"#.to_string()),
            last_opened_at: last_opened,
            created_at: 1000,
        }
    }

    /// 首次登记后可按路径取回，字段全量一致。
    #[test]
    fn upsert_then_get_by_path_roundtrip() {
        let (_dir, store) = testutil::open_store();
        store
            .upsert_workspace(&ws("ws-1", "/repo/a", false, 1000))
            .unwrap();
        let got = store
            .get_workspace_by_path("/repo/a")
            .unwrap()
            .expect("应查到");
        assert_eq!(got, ws("ws-1", "/repo/a", false, 1000));
    }

    /// path 唯一：同路径二次 upsert 是更新而非新行，created_at/id 不变。
    #[test]
    fn upsert_same_path_updates_in_place() {
        let (_dir, store) = testutil::open_store();
        store
            .upsert_workspace(&ws("ws-1", "/repo/a", false, 1000))
            .unwrap();
        store
            .upsert_workspace(&ws("ws-2", "/repo/a", true, 2000))
            .unwrap();

        let got = store
            .get_workspace_by_path("/repo/a")
            .unwrap()
            .expect("应查到");
        assert_eq!(got.id, "ws-1", "身份 id 保留首次登记值");
        assert_eq!(got.created_at, 1000, "created_at 保留首次登记值");
        assert!(got.trusted, "信任状态应被更新");
        assert_eq!(got.last_opened_at, 2000);

        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM agent_workspace", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "path 唯一，不应产生第二行");
    }

    /// 未登记路径返回 None。
    #[test]
    fn get_missing_path_returns_none() {
        let (_dir, store) = testutil::open_store();
        assert!(store.get_workspace_by_path("/nope").unwrap().is_none());
    }

    /// D19 列表按 last_opened_at 倒序（最近打开在前）。
    #[test]
    fn list_workspaces_orders_by_last_opened_desc() {
        let (_dir, store) = testutil::open_store();
        store
            .upsert_workspace(&ws("ws-1", "/repo/a", false, 1000))
            .unwrap();
        store
            .upsert_workspace(&ws("ws-2", "/repo/b", false, 3000))
            .unwrap();
        store
            .upsert_workspace(&ws("ws-3", "/repo/c", false, 2000))
            .unwrap();
        let ids: Vec<String> = store
            .list_workspaces()
            .unwrap()
            .into_iter()
            .map(|w| w.id)
            .collect();
        assert_eq!(ids, ["ws-2", "ws-3", "ws-1"]);
    }

    /// D19 移除登记：删行 + 解除会话关联（会话行保留、workspace_id 置 NULL）。
    #[test]
    fn remove_workspace_deletes_row_and_unlinks_sessions() {
        let (_dir, store) = testutil::open_store();
        store
            .upsert_workspace(&ws("ws-1", "/repo/a", false, 1000))
            .unwrap();
        let mut s = testutil::sample_session("sess-1");
        s.workspace_id = Some("ws-1".to_string());
        store.insert_session(&s).unwrap();

        assert!(store.remove_workspace("ws-1").unwrap());
        assert!(store.get_workspace_by_path("/repo/a").unwrap().is_none());
        assert!(store.list_workspaces().unwrap().is_empty());
        // 会话行保留但归属解除（session.list 归入日常展示）
        let got = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(got.workspace_id, None);
        // 不存在的 id 返回 false（幂等语义）
        assert!(!store.remove_workspace("ws-不存在").unwrap());
    }
}
