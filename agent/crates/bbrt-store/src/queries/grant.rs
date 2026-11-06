//! 三级权限记忆（agent_tool_grant，D09/D11 §11）。
//!
//! scope：once（当次）/ session（会话内）/ permanent（永久，镜像 agent/allow.json）。
//! 会话结束时调用 expire_session_grants 把该会话未过期的授权打上过期时间。

use rusqlite::{params, Row};

use crate::{now_ms, Store, StoreError};

/// agent_tool_grant 行。session_id 仅 scope=session 时归属（否则 NULL）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct GrantRow {
    pub id: String,
    /// scope=session 时归属会话
    pub session_id: Option<String>,
    pub tool: String,
    /// 命令前缀/路径通配/域名
    pub pattern: String,
    /// once | session | permanent
    pub scope: String,
    pub granted_at: i64,
    /// once=立即；session=会话结束（expire_session_grants 打点）
    pub expires_at: Option<i64>,
    /// 审批卡摘要（PAG-11 展示）
    pub source_card: Option<String>,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<GrantRow> {
    Ok(GrantRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        tool: row.get(2)?,
        pattern: row.get(3)?,
        scope: row.get(4)?,
        granted_at: row.get(5)?,
        expires_at: row.get(6)?,
        source_card: row.get(7)?,
    })
}

impl Store {
    /// 登记授权（id 冲突由主键约束兜底）。
    pub fn insert_grant(&self, g: &GrantRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO agent_tool_grant
                 (id, session_id, tool, pattern, scope, granted_at, expires_at, source_card)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                g.id,
                g.session_id,
                g.tool,
                g.pattern,
                g.scope,
                g.granted_at,
                g.expires_at,
                g.source_card
            ],
        )?;
        Ok(())
    }

    /// 授权列表：可按 scope / session_id 任意组合过滤（均 None 时全量），
    /// granted_at 倒序（最近授权在前）。注意按 session_id 过滤只命中会话级授权
    /// （permanent 授权 session_id 为 NULL）。
    pub fn list_grants(
        &self,
        scope: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<GrantRow>, StoreError> {
        const COLS: &str =
            "id, session_id, tool, pattern, scope, granted_at, expires_at, source_card";
        let query = match (scope, session_id) {
            (Some(sc), Some(sid)) => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLS} FROM agent_tool_grant
                     WHERE scope = ?1 AND session_id = ?2 ORDER BY granted_at DESC"
                ))?;
                let rows = stmt.query_map(params![sc, sid], from_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            (Some(sc), None) => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLS} FROM agent_tool_grant
                     WHERE scope = ?1 ORDER BY granted_at DESC"
                ))?;
                let rows = stmt.query_map(params![sc], from_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            (None, Some(sid)) => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLS} FROM agent_tool_grant
                     WHERE session_id = ?1 ORDER BY granted_at DESC"
                ))?;
                let rows = stmt.query_map(params![sid], from_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            (None, None) => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLS} FROM agent_tool_grant ORDER BY granted_at DESC"
                ))?;
                let rows = stmt.query_map([], from_row)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(query)
    }

    /// 删除单条授权；返回是否真的删了（id 不存在 → false）。
    pub fn delete_grant(&self, id: &str) -> Result<bool, StoreError> {
        let n = self
            .conn
            .execute("DELETE FROM agent_tool_grant WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    /// 会话结束的授权过期清理：把该会话所有未打过期时间的授权 expires_at 置为 now。
    /// 返回本次打点条数；已过期的不动（保留首次过期时间）。
    pub fn expire_session_grants(&self, session_id: &str) -> Result<u32, StoreError> {
        let n = self.conn.execute(
            "UPDATE agent_tool_grant SET expires_at = ?2
             WHERE session_id = ?1 AND expires_at IS NULL",
            params![session_id, now_ms()],
        )?;
        Ok(n as u32)
    }
}

#[cfg(test)]
mod tests {
    use crate::{testutil, GrantRow};

    fn grant(id: &str, session: Option<&str>, scope: &str, granted: i64) -> GrantRow {
        GrantRow {
            id: id.to_string(),
            session_id: session.map(str::to_string),
            tool: "bash".to_string(),
            pattern: "git *".to_string(),
            scope: scope.to_string(),
            granted_at: granted,
            expires_at: None,
            source_card: Some("PAG-11".to_string()),
        }
    }

    /// 插入 + 过滤组合：scope 过滤、session 过滤、全量倒序。
    #[test]
    fn insert_and_list_with_filters() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store
            .insert_grant(&grant("g-1", Some("sess-1"), "session", 1000))
            .unwrap();
        store
            .insert_grant(&grant("g-2", None, "permanent", 2000))
            .unwrap();
        store
            .insert_grant(&grant("g-3", Some("sess-1"), "once", 3000))
            .unwrap();

        // 全量：granted_at 倒序
        let all = store.list_grants(None, None).unwrap();
        let ids: Vec<&str> = all.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["g-3", "g-2", "g-1"]);

        // scope=permanent
        let perm = store.list_grants(Some("permanent"), None).unwrap();
        assert_eq!(perm.len(), 1);
        assert_eq!(perm[0].id, "g-2");

        // session 维度：只命中 sess-1 的会话级授权，granted_at 倒序
        let mine = store.list_grants(None, Some("sess-1")).unwrap();
        let ids: Vec<&str> = mine.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["g-3", "g-1"]);

        // 组合过滤
        let combo = store.list_grants(Some("session"), Some("sess-1")).unwrap();
        assert_eq!(combo.len(), 1);
        assert_eq!(combo[0].id, "g-1");

        // 字段往返
        assert_eq!(combo[0].session_id.as_deref(), Some("sess-1"));
        assert_eq!(combo[0].pattern, "git *");
        assert_eq!(combo[0].source_card.as_deref(), Some("PAG-11"));
    }

    /// 删除：命中 true，再删 false。
    #[test]
    fn delete_grant_reports_whether_deleted() {
        let (_dir, store) = testutil::open_store();
        store
            .insert_grant(&grant("g-1", None, "permanent", 1000))
            .unwrap();
        assert!(store.delete_grant("g-1").unwrap());
        assert!(!store.delete_grant("g-1").unwrap(), "已删再删应 false");
        assert!(store.list_grants(None, None).unwrap().is_empty());
    }

    /// 会话过期清理：只打点该会话未过期的授权，其它会话/已过期不动。
    #[test]
    fn expire_session_grants_marks_only_pending() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        testutil::seed_session(&store, "sess-2");
        // sess-1：两条未过期 + 一条已过期
        store
            .insert_grant(&grant("g-1", Some("sess-1"), "session", 1000))
            .unwrap();
        store
            .insert_grant(&grant("g-2", Some("sess-1"), "once", 1100))
            .unwrap();
        let mut expired = grant("g-3", Some("sess-1"), "once", 900);
        expired.expires_at = Some(950);
        store.insert_grant(&expired).unwrap();
        // sess-2：一条（不应被动）
        store
            .insert_grant(&grant("g-4", Some("sess-2"), "session", 1200))
            .unwrap();
        // permanent 无会话归属（不应被动）
        store
            .insert_grant(&grant("g-5", None, "permanent", 1300))
            .unwrap();

        let before = crate::now_ms();
        let n = store.expire_session_grants("sess-1").unwrap();
        assert_eq!(n, 2, "只打点 sess-1 未过期的 2 条");
        let after = crate::now_ms();

        let sess1 = store.list_grants(None, Some("sess-1")).unwrap();
        for g in &sess1 {
            match g.id.as_str() {
                "g-3" => assert_eq!(g.expires_at, Some(950), "已过期保留原值"),
                _ => {
                    let at = g.expires_at.expect("未过期的应被打点");
                    assert!((before..=after).contains(&at), "{} 打点时间应为 now", g.id);
                }
            }
        }

        // 其它会话 / permanent（无会话归属）不受影响
        assert_eq!(
            store.list_grants(None, Some("sess-2")).unwrap()[0].expires_at,
            None,
            "sess-2 的授权不应被动"
        );
        assert_eq!(
            store.list_grants(Some("permanent"), None).unwrap()[0].expires_at,
            None,
            "permanent 授权不应被动"
        );

        // 幂等：已全部打点，再次清理返回 0
        assert_eq!(store.expire_session_grants("sess-1").unwrap(), 0);
    }
}
