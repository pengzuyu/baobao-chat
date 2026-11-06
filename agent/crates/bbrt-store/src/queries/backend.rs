//! 委派后端登记（coding_backend，D11 §11 / 17 篇 §7）。
//!
//! id 即后端类型（zcode/claude/generic:bin/builtin）；探测重跑走 upsert 覆盖，
//! enabled=0 对应租户策略禁用（8032）。

use rusqlite::{params, Row};

use crate::{Store, StoreError};

/// coding_backend 行。capabilities 为 JSON（{edit,command,resume,smoke_ms}）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct BackendRow {
    /// 类型即 id（zcode/claude/generic:bin/builtin）
    pub id: String,
    pub type_: String,
    pub path: Option<String>,
    pub version: Option<String>,
    /// JSON: {edit,command,resume,smoke_ms}
    pub capabilities: String,
    /// 租户策略禁用→0（8032）
    pub enabled: bool,
    pub is_default: bool,
    pub detected_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<BackendRow> {
    Ok(BackendRow {
        id: row.get(0)?,
        type_: row.get(1)?,
        path: row.get(2)?,
        version: row.get(3)?,
        capabilities: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        is_default: row.get::<_, i64>(6)? != 0,
        detected_at: row.get(7)?,
    })
}

impl Store {
    /// 按类型 upsert：探测重跑覆盖 path/version/capabilities 等，id 不变。
    pub fn upsert_backend(&self, b: &BackendRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO coding_backend
                 (id, type, path, version, capabilities, enabled, is_default, detected_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 type         = excluded.type,
                 path         = excluded.path,
                 version      = excluded.version,
                 capabilities = excluded.capabilities,
                 enabled      = excluded.enabled,
                 is_default   = excluded.is_default,
                 detected_at  = excluded.detected_at",
            params![
                b.id,
                b.type_,
                b.path,
                b.version,
                b.capabilities,
                b.enabled,
                b.is_default,
                b.detected_at
            ],
        )?;
        Ok(())
    }

    /// 全量后端列表：默认后端在前，其余按 id 稳定排序。
    pub fn list_backends(&self) -> Result<Vec<BackendRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, type, path, version, capabilities, enabled, is_default, detected_at
             FROM coding_backend ORDER BY is_default DESC, id ASC",
        )?;
        let rows = stmt.query_map([], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::BackendRow;
    use crate::testutil;

    fn backend(id: &str, ty: &str, version: Option<&str>, default: bool) -> BackendRow {
        BackendRow {
            id: id.to_string(),
            type_: ty.to_string(),
            path: Some("/usr/local/bin/x".to_string()),
            version: version.map(str::to_string),
            capabilities: r#"{"edit":true,"command":true,"resume":true,"smoke_ms":120}"#
                .to_string(),
            enabled: true,
            is_default: default,
            detected_at: 1000,
        }
    }

    /// upsert 后列出；同 id 二次 upsert 覆盖不新增。
    #[test]
    fn upsert_list_and_reupsert_update() {
        let (_dir, store) = testutil::open_store();
        store
            .upsert_backend(&backend("zcode", "zcode", Some("1.0"), true))
            .unwrap();
        store
            .upsert_backend(&backend("claude", "claude", None, false))
            .unwrap();

        let list = store.list_backends().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "zcode", "默认后端在前");
        assert_eq!(list[1].id, "claude");
        assert_eq!(list[1].version, None);
        assert_eq!(
            list[0].capabilities,
            r#"{"edit":true,"command":true,"resume":true,"smoke_ms":120}"#
        );

        // 二次 upsert：版本探测更新，仍只有 2 行
        let mut updated = backend("claude", "claude", Some("2.1.0"), false);
        updated.enabled = false; // 租户策略禁用（8032）
        store.upsert_backend(&updated).unwrap();
        let list = store.list_backends().unwrap();
        assert_eq!(list.len(), 2, "upsert 不应产生新行");
        let claude = &list[1];
        assert_eq!(claude.version.as_deref(), Some("2.1.0"));
        assert!(!claude.enabled, "enabled 应被覆盖为 false");
    }
}
