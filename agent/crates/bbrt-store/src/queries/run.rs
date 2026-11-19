//! 子 Agent run 记录（agent_run，D16 §3.1）。
//!
//! 后台任务（probe/expert/team/terminal）统一审计行：一次调用 = 一条 run
//! 加一段带 run_id 的 agent_event 事件流，可完整重放（审计口径）。
//! 外部 CLI 委派（kind=delegate）已随委派域退役（2026-11-18 迁移 005）。

use rusqlite::{params, Row};

use crate::{now_ms, Store, StoreError};

/// agent_run 行。ended_at 为 None 即未终态（running）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    /// r-{seq} 持久发号
    pub id: String,
    pub session_id: String,
    /// 调用链根会话（顶层 run=父会话 id）
    pub root_session_id: String,
    /// 父 run（team 成员 expert run=team run id；其余空）
    #[serde(default)]
    pub parent_run_id: String,
    /// 触发本次 run 的工具调用 id（terminal=run_command call_id）
    #[serde(default)]
    pub parent_call_id: String,
    /// probe | expert | team | terminal
    pub kind: String,
    /// builtin.probe / {expertId}@{version} / team:{topology} / shell
    #[serde(default)]
    pub def_ref: String,
    /// running | done | failed | cancelled | interrupted（interrupted 仅恢复写入）
    pub status: String,
    #[serde(default)]
    pub eta_hint_ms: i64,
    #[serde(default)]
    pub eta_actual_ms: i64,
    #[serde(default)]
    pub summary: String,
    /// OBO subject 快照（鉴权审计；宿主身份接线前空串）
    #[serde(default)]
    pub actor: String,
    pub created_at: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

const RUN_COLS: &str = "id, session_id, root_session_id, parent_run_id, parent_call_id, \
                        kind, def_ref, status, eta_hint_ms, eta_actual_ms, summary, \
                        actor, created_at, started_at, ended_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        root_session_id: row.get(2)?,
        parent_run_id: row.get(3)?,
        parent_call_id: row.get(4)?,
        kind: row.get(5)?,
        def_ref: row.get(6)?,
        status: row.get(7)?,
        eta_hint_ms: row.get(8)?,
        eta_actual_ms: row.get(9)?,
        summary: row.get(10)?,
        actor: row.get(11)?,
        created_at: row.get(12)?,
        started_at: row.get(13)?,
        ended_at: row.get(14)?,
    })
}

impl Store {
    /// 持久发号（统一后台任务体系 2026-11-18）：按 kind 分前缀 + uuid 全长
    /// 32 位 hex——子 agent（probe/expert/team）=`agent-`、terminal 后台
    /// 命令=`terminal-`（用户拍板口径；id 即类型可读，
    /// task.wait/task id 跨类型通用）。碰撞查重重试 ≤5 兜底；存量 id
    /// （r-*/dt-*/sub-* 等）不迁移——所有消费方按精确字符串匹配天然兼容。
    pub fn next_task_id(&self, kind: &str) -> Result<String, StoreError> {
        let prefix = match kind {
            "terminal" => "terminal-",
            _ => "agent-",
        };
        for _ in 0..5 {
            let id = format!("{prefix}{}", uuid::Uuid::new_v4().simple());
            let hit: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_run WHERE id = ?1)",
                [&id],
                |row| row.get(0),
            )?;
            if !hit {
                return Ok(id);
            }
        }
        Err(StoreError::Sqlite("任务 id 随机发号连续碰撞（5 次重试）".into()))
    }

    /// 按 id 单查（subagent.wait 终态轮询/结果取回）
    pub fn run_by_id(&self, run_id: &str) -> Result<Option<RunRow>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {RUN_COLS} FROM agent_run WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![run_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(from_row(row)?)),
            None => Ok(None),
        }
    }

    /// run 起始落库（status=running；created_at/started_at 存储侧取 now）。
    pub fn insert_run(&self, row: &RunRow) -> Result<(), StoreError> {
        let now = now_ms();
        self.conn.execute(
            &format!(
                "INSERT INTO agent_run ({RUN_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, 0, '', ?9, ?10, ?10, NULL)"
            ),
            params![
                row.id,
                row.session_id,
                row.root_session_id,
                row.parent_run_id,
                row.parent_call_id,
                row.kind,
                row.def_ref,
                row.eta_hint_ms,
                row.actor,
                now,
            ],
        )?;
        Ok(())
    }

    /// run 终态回写（ended_at 存储侧取 now；summary 全量覆盖）。
    pub fn finish_run(
        &self,
        run_id: &str,
        status: &str,
        eta_actual_ms: i64,
        summary: &str,
    ) -> Result<(), StoreError> {
        let n = self.conn.execute(
            "UPDATE agent_run
             SET status = ?2, eta_actual_ms = ?3, summary = ?4,
                 ended_at = ?5
             WHERE id = ?1",
            params![
                run_id,
                status,
                eta_actual_ms,
                summary,
                now_ms()
            ],
        )?;
        if n == 0 {
            return Err(StoreError::Sqlite(format!("run 不存在: {run_id}")));
        }
        Ok(())
    }

    /// ETA 滚动统计（D16 §5/P1-6：按 def_ref 取最近 8 次已完成 run 的平均
    /// 实际耗时——静态初值表的高阶修正；无样本=None，调用方回落静态表）
    pub fn eta_hint_ms(&self, def_ref: &str) -> Result<Option<i64>, StoreError> {
        let avg: Option<f64> = self.conn.query_row(
            "SELECT AVG(eta_actual_ms) FROM (
                 SELECT eta_actual_ms FROM agent_run
                 WHERE def_ref = ?1 AND status IN ('done','failed') AND eta_actual_ms > 0
                 ORDER BY ended_at DESC LIMIT 8
             )",
            params![def_ref],
            |row| row.get(0),
        )?;
        Ok(avg.map(|v| v.max(0.0) as i64))
    }

    /// 会话的 run 清单（created_at 升序；UI run 面板/审计检索用）。
    pub fn runs_of(&self, session_id: &str) -> Result<Vec<RunRow>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {RUN_COLS} FROM agent_run
             WHERE session_id = ?1 ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = stmt.query_map(params![session_id], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 全部 run 清单（created_at 升序；runs.list 全量口径）
    pub fn runs_all(&self) -> Result<Vec<RunRow>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {RUN_COLS} FROM agent_run ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 崩溃恢复收口：该会话所有 running 态 run 置 interrupted（进程已死，
    /// 不可能仍在执行；返回标记条数）。幂等：二次调用无 running 行即 0。
    pub fn interrupt_running_runs(&self, session_id: &str) -> Result<usize, StoreError> {
        let n = self.conn.execute(
            "UPDATE agent_run
             SET status = 'interrupted', ended_at = ?2
             WHERE session_id = ?1 AND status = 'running'",
            params![session_id, now_ms()],
        )?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use crate::{testutil, RunRow};

    fn start_row(id: &str, session: &str, kind: &str) -> RunRow {
        RunRow {
            id: id.to_string(),
            session_id: session.to_string(),
            root_session_id: session.to_string(),
            parent_run_id: String::new(),
            parent_call_id: String::new(),
            kind: kind.to_string(),
            def_ref: format!("def:{kind}"),
            status: "running".to_string(), // insert_run 强制 running，此值不落库
            eta_hint_ms: 0,
            eta_actual_ms: 0,
            summary: String::new(),
            actor: String::new(),
            created_at: 0,
            started_at: 0,
            ended_at: None,
        }
    }

    /// 发号（统一后台任务体系）：按 kind 分前缀（agent-/terminal-）+
    /// 32 位 hex、连发不重、跨 Store 重开不撞存量
    #[test]
    fn next_task_id_prefix_by_kind_unique_across_reopen() {
        let (dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let cases = [
            ("probe", "agent-"),
            ("expert", "agent-"),
            ("team", "agent-"),
            ("terminal", "terminal-"),
        ];
        let mut seen = std::collections::HashSet::new();
        for (kind, prefix) in cases {
            for _ in 0..4 {
                let id = store.next_task_id(kind).unwrap();
                assert!(
                    id.starts_with(prefix) && id.len() == prefix.len() + 32
                        && id[prefix.len()..].chars().all(|c| c.is_ascii_hexdigit()),
                    "格式应为 {prefix}+32hex: {id}"
                );
                assert!(seen.insert(id.clone()), "连发不应重复: {id}");
            }
        }
        // 落库后重开：新号不撞存量
        for id in seen.iter().take(4) {
            store.insert_run(&start_row(id, "sess-1", "probe")).unwrap();
        }
        drop(store);
        let store2 = crate::Store::open(&dir.path().join("agent").join("runtime.sqlite3")).unwrap();
        for _ in 0..8 {
            let id = store2.next_task_id("terminal").unwrap();
            assert!(!seen.contains(&id), "重开后不应撞存量: {id}");
        }
    }

    /// 005 迁移：模拟 v4 老库（版本拨回 4 + 补回被 005 退役的列）重 open——
    /// 存量数据无损 + child_session_ref/backend 列退役 + terminal 可插可查
    #[test]
    fn migration_005_preserves_data_and_retires_legacy_columns() {
        let (dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store.insert_run(&start_row("r-1", "sess-1", "probe")).unwrap();
        store
            .finish_run("r-1", "done", 123, "旧数据")
            .unwrap();
        drop(store);
        // 版本拨回 4 并补回 005 删除的两列，模拟 005 前老库（v4 形态）
        let db = dir.path().join("agent").join("runtime.sqlite3");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.pragma_update(None, "user_version", 4).unwrap();
            conn.execute_batch(
                "ALTER TABLE agent_run ADD COLUMN child_session_ref TEXT NOT NULL DEFAULT '';
                 ALTER TABLE agent_session ADD COLUMN backend TEXT;",
            )
            .unwrap();
        }
        let store2 = crate::Store::open(&db).unwrap();
        let old = store2.run_by_id("r-1").unwrap().expect("存量 run 应保留");
        assert_eq!(
            (old.kind.as_str(), old.status.as_str(), old.summary.as_str()),
            ("probe", "done", "旧数据")
        );
        // 新 kind：terminal 可插可查（v5 CHECK 生效）
        let tid = store2.next_task_id("terminal").unwrap();
        assert!(tid.starts_with("terminal-"));
        store2.insert_run(&start_row(&tid, "sess-1", "terminal")).unwrap();
        assert_eq!(store2.run_by_id(&tid).unwrap().unwrap().kind, "terminal");
        // 旧列确已退役
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            let has_col = |table: &str, col: &str| -> bool {
                let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
                let names: Vec<String> = stmt
                    .query_map([], |r| r.get::<_, String>(1))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                names.iter().any(|c| c == col)
            };
            assert!(!has_col("agent_run", "child_session_ref"));
            assert!(!has_col("agent_session", "backend"));
        }
    }

    /// 按 id 单查：run_by_id 命中/未命中
    #[test]
    fn run_by_id_hit_and_miss() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let id = store.next_task_id("probe").unwrap();
        store.insert_run(&start_row(&id, "sess-1", "probe")).unwrap();
        let row = store.run_by_id(&id).unwrap().expect("应命中");
        assert_eq!(row.kind, "probe");
        assert_eq!(row.status, "running");
        assert!(store.run_by_id("r-nope").unwrap().is_none());
    }

    /// 生命周期：insert 强制 running → finish 覆盖终态字段 → runs_of 可查
    #[test]
    fn lifecycle_start_finish_list() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store
            .insert_run(&start_row("r-1", "sess-1", "expert"))
            .unwrap();
        store
            .insert_run(&start_row("r-2", "sess-1", "probe"))
            .unwrap();
        // insert 后均 running、无终态
        let runs = store.runs_of("sess-1").unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs
            .iter()
            .all(|r| r.status == "running" && r.ended_at.is_none()));

        store
            .finish_run("r-1", "done", 123_456, "专家完成摘要")
            .unwrap();
        let runs = store.runs_of("sess-1").unwrap();
        assert_eq!(runs[0].status, "done");
        assert_eq!(runs[0].eta_actual_ms, 123_456);
        assert_eq!(runs[0].summary, "专家完成摘要");
        assert!(runs[0].ended_at.is_some(), "终态应带 ended_at");
        assert_eq!(runs[1].status, "running", "其余 run 不受影响");

        // 不存在的 run：报错不静默
        assert!(store.finish_run("r-404", "done", 0, "").is_err());
    }

    /// 恢复收口：running → interrupted（幂等），终态 run 不动
    #[test]
    fn interrupt_running_marks_only_running() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        testutil::seed_session(&store, "sess-2");
        store
            .insert_run(&start_row("r-1", "sess-1", "probe"))
            .unwrap();
        store
            .insert_run(&start_row("r-2", "sess-1", "expert"))
            .unwrap();
        store.finish_run("r-2", "failed", 50, "超步").unwrap();
        store
            .insert_run(&start_row("r-3", "sess-2", "probe"))
            .unwrap();

        assert_eq!(store.interrupt_running_runs("sess-1").unwrap(), 1);
        let runs = store.runs_of("sess-1").unwrap();
        assert_eq!(runs[0].status, "interrupted");
        assert_eq!(runs[1].status, "failed", "终态不被恢复改写");
        assert_eq!(
            store.runs_of("sess-2").unwrap()[0].status,
            "running",
            "其它会话不受影响"
        );
        assert_eq!(store.interrupt_running_runs("sess-1").unwrap(), 0, "幂等");
    }
}
