//! 会话生命周期持久化（agent_session，D11 §11 / 状态机 §3）。
//!
//! status 取值为 D11 §3 状态机枚举；ended/error 为终态，
//! 进入终态时补写 ended_at（已有值保留首次结束时间，重试结束不覆盖）。

use rusqlite::{params, OptionalExtension, Row};

use crate::{now_ms, Store, StoreError};

/// agent_session 行。workspace_id/ended_at/summary 可空。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // 嵌套 struct 自带 rename_all（历史 bug 教训）
pub struct SessionRow {
    /// sess-<ulid>
    pub id: String,
    pub workspace_id: Option<String>,
    pub title: String,
    /// embedded | workbench
    pub form: String,
    /// ask | auto-edit | full-auto
    pub mode: String,
    /// 委派后端 zcode|claude|generic|builtin（17 篇增列）
    /// fast | strong | auto
    pub model_policy: String,
    /// 会话级模型直达引用（0023 多供应商；p:<provider_id>:<model>）。
    /// NULL=走 model_policy 档位别名；仅作用于主循环对话模型（002 迁移增列）。
    pub model_override: Option<String>,
    /// D11 §3 状态机枚举
    pub status: String,
    pub share_enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
    pub summary: Option<String>,
}

/// SELECT 列清单（顺序与 from_row 一致）
const COLS: &str = "id, workspace_id, title, form, mode, model_policy, model_override, status, \
                    share_enabled, created_at, updated_at, ended_at, summary";

fn from_row(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        form: row.get(3)?,
        mode: row.get(4)?,
        model_policy: row.get(5)?,
        model_override: row.get(6)?,
        status: row.get(7)?,
        share_enabled: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        ended_at: row.get(11)?,
        summary: row.get(12)?,
    })
}

impl Store {
    /// 新会话登记（id 主键冲突由约束兜底报 Sqlite 错）。
    pub fn insert_session(&self, s: &SessionRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO agent_session
                 (id, workspace_id, title, form, mode, model_policy, model_override, status,
                  share_enabled, created_at, updated_at, ended_at, summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                s.id,
                s.workspace_id,
                s.title,
                s.form,
                s.mode,
                s.model_policy,
                s.model_override,
                s.status,
                s.share_enabled,
                s.created_at,
                s.updated_at,
                s.ended_at,
                s.summary
            ],
        )?;
        Ok(())
    }

    /// 更新会话状态与摘要（updated_at 刷新为 now）；
    /// status 进入终态（ended/error）时补 ended_at，非终态不动它。
    pub fn update_session(
        &self,
        id: &str,
        status: &str,
        summary: Option<&str>,
    ) -> Result<(), StoreError> {
        let now = now_ms();
        self.conn.execute(
            "UPDATE agent_session
             SET status     = ?2,
                 summary    = ?3,
                 updated_at = ?4,
                 ended_at   = CASE WHEN ?2 IN ('ended','error')
                                   THEN COALESCE(ended_at, ?4)
                                   ELSE ended_at END
             WHERE id = ?1",
            params![id, status, summary, now],
        )?;
        Ok(())
    }

    /// 模型选择回写（model.switch 持久化；override None=清直达引用回档位）。
    pub fn update_session_model(
        &self,
        id: &str,
        policy: &str,
        model_override: Option<&str>,
    ) -> Result<(), StoreError> {
        let now = now_ms();
        self.conn.execute(
            "UPDATE agent_session
             SET model_policy   = ?2,
                 model_override = ?3,
                 updated_at     = ?4
             WHERE id = ?1",
            params![id, policy, model_override, now],
        )?;
        Ok(())
    }

    /// 会话重命名（2026-11-11：标题派生/手动改名；updated_at 随之刷新）。
    /// 空白标题返回 Err 不落库；返回受影响行数（0=会话不存在）。
    pub fn rename_session(&self, id: &str, title: &str) -> Result<u32, StoreError> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(StoreError::InvalidInput(format!("空标题: {id}")));
        }
        let title = if trimmed.chars().count() > 60 {
            let mut cut: String = trimmed.chars().take(60).collect();
            cut.push('…');
            cut
        } else {
            trimmed.to_string()
        };
        let n = self.conn.execute(
            "UPDATE agent_session SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now_ms()],
        )?;
        Ok(n as u32)
    }

    /// 按 id 精确查会话。
    pub fn get_session(&self, id: &str) -> Result<Option<SessionRow>, StoreError> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLS} FROM agent_session WHERE id = ?1"))?;
        let row = stmt
            .query_row(params![id], from_row)
            .optional()
            .map_err(StoreError::from)?;
        Ok(row)
    }

    /// 会话列表：可按状态过滤，updated_at 倒序（最近活动在前），limit 截断。
    pub fn list_sessions(
        &self,
        status: Option<&str>,
        limit: u32,
    ) -> Result<Vec<SessionRow>, StoreError> {
        match status {
            Some(st) => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLS} FROM agent_session WHERE status = ?1 \
                     ORDER BY updated_at DESC LIMIT ?2"
                ))?;
                let rows = stmt.query_map(params![st, limit as i64], from_row)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
            None => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLS} FROM agent_session ORDER BY updated_at DESC LIMIT ?1"
                ))?;
                let rows = stmt.query_map(params![limit as i64], from_row)?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            }
        }
    }

    /// 启动清扫（2026-11-10 内嵌卡真机事故）：进程刚起=一切进行中状态都是
    /// 上个进程的遗物（running/waiting_*/paused/starting → error；
    /// 另含已退役的 waiting_review/delegating——存量库残留行仍须收口）。
    /// 否则死会话永远占 UI 与「活跃≤3」名额，且 input/stop 均 NotFound 无法收口。
    /// 返回清扫行数（idle/ended/error 不动）。
    pub fn sweep_interrupted_on_boot(&self) -> Result<u32, StoreError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let n = self.conn.execute(
            "UPDATE agent_session SET status='error', ended_at=?1, updated_at=?1 \
             WHERE status IN ('starting','running','waiting_permission',\
             'waiting_review','subagent_fanout','delegating','paused')",
            params![now],
        )?;
        Ok(n as u32)
    }

    /// 活跃会话数：status 不在终态（ended/error）即活跃（首页红点/恢复提示用）。
    pub fn count_active_sessions(&self) -> Result<u32, StoreError> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM agent_session WHERE status NOT IN ('ended','error')",
            [],
            |row| row.get(0),
        )?;
        Ok(n as u32)
    }

    /// 会话持久列表 × 工作区路径（D19 session.list 数据源）：
    /// LEFT JOIN agent_workspace，未关联（日常/历史行）workspace=""。
    /// updated_at 倒序，limit 截断。
    pub fn list_sessions_with_workspace(
        &self,
        limit: u32,
    ) -> Result<Vec<SessionListRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.title, COALESCE(w.path, ''), s.mode, s.model_policy, s.model_override, \
                    s.status, s.created_at, s.updated_at, s.ended_at, s.summary
             FROM agent_session s
             LEFT JOIN agent_workspace w ON w.id = s.workspace_id
             ORDER BY s.updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(SessionListRow {
                id: row.get(0)?,
                title: row.get(1)?,
                workspace: row.get(2)?,
                mode: row.get(3)?,
                model_policy: row.get(4)?,
                model_override: row.get(5)?,
                status: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                ended_at: row.get(9)?,
                summary: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 回填会话工作区归属（D19：session.start 带目录时挂 workspace_id）
    pub fn set_session_workspace(
        &self,
        id: &str,
        workspace_id: Option<&str>,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE agent_session SET workspace_id = ?2 WHERE id = ?1",
            params![id, workspace_id],
        )?;
        Ok(())
    }
}

/// session.list 协议行（D19；agent_session JOIN agent_workspace 投影，
/// 字段口径对齐 bbrt_protocol::SessionListItem——本结构即其数据源）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListRow {
    pub id: String,
    pub title: String,
    /// 工作目录（""=日常/未关联）
    pub workspace: String,
    pub mode: String,
    pub model_policy: String,
    pub model_override: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
    pub summary: Option<String>,
}

#[cfg(test)]
mod tests {
    use crate::testutil;

    /// 重命名：正常改名 / 截断超长 / 空白拒绝 / 不存在返回 0（2026-11-11）
    #[test]
    fn rename_session_rules() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-r1");
        assert_eq!(store.rename_session("sess-r1", "与张三的对话").unwrap(), 1);
        assert_eq!(
            store.get_session("sess-r1").unwrap().unwrap().title,
            "与张三的对话"
        );
        // 超长截断到 60 字符 + 省略号
        let long = "长".repeat(80);
        assert_eq!(store.rename_session("sess-r1", &long).unwrap(), 1);
        let got = store.get_session("sess-r1").unwrap().unwrap().title;
        assert_eq!(got.chars().count(), 61, "60 字 + 省略号");
        assert!(got.ends_with('…'));
        // 空白拒绝
        assert!(store.rename_session("sess-r1", "   ").is_err());
        // 不存在：0 行受影响不报错
        assert_eq!(store.rename_session("sess-无", "新名").unwrap(), 0);
    }

    /// 插入后按 id 取回，13 个字段全量一致（含可空字段与外键归属）。
    #[test]
    fn insert_and_get_roundtrip() {
        let (_dir, store) = testutil::open_store();
        // workspace_id 有外键：先登记工作区再挂会话
        store
            .upsert_workspace(&crate::Workspace {
                id: "ws-1".to_string(),
                path: "/repo/a".to_string(),
                name: "项目".to_string(),
                is_repo: true,
                trusted: true,
                extra_dirs: None,
                last_opened_at: 1000,
                created_at: 1000,
            })
            .unwrap();
        let mut s = testutil::sample_session("sess-1");
        s.workspace_id = Some("ws-1".to_string());
        s.share_enabled = true;
        s.summary = Some("干了点活".to_string());
        store.insert_session(&s).unwrap();

        let got = store.get_session("sess-1").unwrap().expect("应查到");
        assert_eq!(got, s);
        assert!(store.get_session("sess-不存在").unwrap().is_none());
    }

    /// 启动清扫：进行中七态全收口 error，idle/ended 不动；幂等（2026-11-10 内嵌卡事故）
    #[test]
    fn sweep_interrupted_on_boot_collects_only_active_states() {
        let (_dir, store) = testutil::open_store();
        for (id, status) in [
            ("s-run", "running"),
            ("s-wait", "waiting_permission"),
            ("s-pause", "paused"),
            ("s-idle", "idle"),
            ("s-end", "ended"),
        ] {
            testutil::seed_session(&store, id);
            store.update_session(id, status, None).unwrap();
        }
        assert_eq!(store.sweep_interrupted_on_boot().unwrap(), 3);
        for id in ["s-run", "s-wait", "s-pause"] {
            assert_eq!(
                store.get_session(id).unwrap().unwrap().status,
                "error",
                "{id} 应收口"
            );
        }
        assert_eq!(store.get_session("s-idle").unwrap().unwrap().status, "idle");
        assert_eq!(store.get_session("s-end").unwrap().unwrap().status, "ended");
        assert_eq!(
            store.sweep_interrupted_on_boot().unwrap(),
            0,
            "二次清扫幂等"
        );
    }

    /// 状态机走 idle → running → ended：ended_at 只在终态补写且不覆盖。
    #[test]
    fn update_session_lifecycle_sets_ended_at() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");

        // 非终态更新：ended_at 保持 NULL，status/summary 生效
        store.update_session("sess-1", "running", None).unwrap();
        let got = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(got.status, "running");
        assert!(got.ended_at.is_none(), "非终态不应写 ended_at");

        // 终态：补 ended_at + summary
        store
            .update_session("sess-1", "ended", Some("任务完成"))
            .unwrap();
        let ended = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(ended.status, "ended");
        assert_eq!(ended.summary.as_deref(), Some("任务完成"));
        assert!(ended.ended_at.is_some(), "终态应写 ended_at");

        // 再次终态更新（error）：ended_at 保留首次结束时间
        let first_end = ended.ended_at;
        store.update_session("sess-1", "error", None).unwrap();
        let failed = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.ended_at, first_end, "ended_at 不被二次结束覆盖");
    }

    /// 列表：状态过滤 + updated_at 倒序 + limit。
    #[test]
    fn list_sessions_filters_orders_and_limits() {
        let (_dir, store) = testutil::open_store();
        for (id, status, updated) in [
            ("sess-a", "idle", 1000),
            ("sess-b", "idle", 3000),
            ("sess-c", "idle", 2000),
            ("sess-d", "ended", 4000),
        ] {
            let mut s = testutil::sample_session(id);
            s.status = status.to_string();
            s.updated_at = updated;
            store.insert_session(&s).unwrap();
        }

        // 全量：updated_at 倒序
        let all = store.list_sessions(None, 10).unwrap();
        let ids: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["sess-d", "sess-b", "sess-c", "sess-a"]);

        // 过滤 idle：ended 不出现
        let idle = store.list_sessions(Some("idle"), 10).unwrap();
        let ids: Vec<&str> = idle.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["sess-b", "sess-c", "sess-a"]);

        // limit 截断
        let top = store.list_sessions(Some("idle"), 2).unwrap();
        let ids: Vec<&str> = top.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["sess-b", "sess-c"]);
    }

    /// 活跃计数：终态（ended/error）不计入。
    #[test]
    fn count_active_sessions_excludes_terminal() {
        let (_dir, store) = testutil::open_store();
        for (id, status) in [
            ("sess-a", "idle"),
            ("sess-b", "running"),
            ("sess-c", "ended"),
            ("sess-d", "error"),
        ] {
            let mut s = testutil::sample_session(id);
            s.status = status.to_string();
            store.insert_session(&s).unwrap();
        }
        assert_eq!(store.count_active_sessions().unwrap(), 2);

        // error → 恢复活跃
        store.update_session("sess-d", "paused", None).unwrap();
        assert_eq!(store.count_active_sessions().unwrap(), 3);
    }

    /// D19 持久列表 × 工作区 JOIN：关联行带路径、未关联（日常）workspace=""。
    #[test]
    fn list_sessions_with_workspace_joins_and_falls_back_empty() {
        let (_dir, store) = testutil::open_store();
        store
            .upsert_workspace(&crate::Workspace {
                id: "ws-1".to_string(),
                path: "/repo/proj".to_string(),
                name: "proj".to_string(),
                is_repo: true,
                trusted: true,
                extra_dirs: None,
                last_opened_at: 1000,
                created_at: 1000,
            })
            .unwrap();
        let mut proj = testutil::sample_session("sess-proj");
        proj.workspace_id = Some("ws-1".to_string());
        proj.updated_at = 2000;
        store.insert_session(&proj).unwrap();
        let mut daily = testutil::sample_session("sess-daily");
        daily.updated_at = 1000;
        store.insert_session(&daily).unwrap();

        let rows = store.list_sessions_with_workspace(10).unwrap();
        assert_eq!(rows.len(), 2);
        // updated_at 倒序：proj 在前
        assert_eq!(rows[0].id, "sess-proj");
        assert_eq!(rows[0].workspace, "/repo/proj");
        assert_eq!(rows[1].id, "sess-daily");
        assert_eq!(rows[1].workspace, "", "未关联工作区（日常）应为空串");

        // set_session_workspace 回填/解除
        store
            .set_session_workspace("sess-daily", Some("ws-1"))
            .unwrap();
        let again = store.list_sessions_with_workspace(10).unwrap();
        assert!(again.iter().all(|r| r.workspace == "/repo/proj"));
        store.set_session_workspace("sess-daily", None).unwrap();
        let back = store.list_sessions_with_workspace(10).unwrap();
        assert_eq!(
            back.iter()
                .find(|r| r.id == "sess-daily")
                .unwrap()
                .workspace,
            ""
        );
    }
}
