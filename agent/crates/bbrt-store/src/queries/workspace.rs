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
}
