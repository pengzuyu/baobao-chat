//! 子 Agent run 记录（agent_run，D16 §3.1）。
//!
//! 三形态（probe/expert/team/delegate）统一审计行：一次调用 = 一条 run
//! 加一段带 run_id 的 agent_event 事件流，可完整重放（审计口径）。
//! 发号 r-{seq} 跨重启唯一（单连接互斥下 max+1，无并发竞态）；
//! 取代 001 的 delegate_task（从未接线，DDL 留待清理迁移）。

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
    /// 触发本次 run 的工具调用 id（委派=coding.delegate call_id）
    #[serde(default)]
    pub parent_call_id: String,
    /// probe | expert | team | delegate
    pub kind: String,
    /// builtin.probe / {expertId}@{version} / team:{topology} / backend:{type}
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
    #[serde(default)]
    pub child_session_ref: String,
    /// OBO subject 快照（鉴权审计；宿主身份接线前空串）
    #[serde(default)]
    pub actor: String,
    pub created_at: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

const RUN_COLS: &str = "id, session_id, root_session_id, parent_run_id, parent_call_id, \
                        kind, def_ref, status, eta_hint_ms, eta_actual_ms, summary, \
                        child_session_ref, actor, created_at, started_at, ended_at";

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
        child_session_ref: row.get(11)?,
        actor: row.get(12)?,
        created_at: row.get(13)?,
        started_at: row.get(14)?,
        ended_at: row.get(15)?,
    })
}

impl Store {
    /// 持久发号：r-{uuid 前 8 hex}（如 r-a1b2c3d4）——随机不暴露计数
    /// （用户拍板 UUID 形式；弃序号制）。碰撞概率 16^8 分之一，命中查重重试
    /// 兜底。存量 id（r-1/r-000003）不迁移；排序按 created_at 不受影响；
    /// subagent.cancel 等消费方只认 r- 前缀不变。
    pub fn next_run_id(&self) -> Result<String, StoreError> {
        for _ in 0..5 {
            let id = format!("r-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
            let hit: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_run WHERE id = ?1)",
                [&id],
                |row| row.get(0),
            )?;
            if !hit {
                return Ok(id);
            }
        }
        Err(StoreError::Sqlite("run id 随机发号连续碰撞（5 次重试）".into()))
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
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, 0, '', '', ?9, ?10, ?10, NULL)"
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

    /// run 终态回写（ended_at 存储侧取 now；summary/child_session_ref 全量覆盖）。
    pub fn finish_run(
        &self,
        run_id: &str,
        status: &str,
        eta_actual_ms: i64,
        summary: &str,
        child_session_ref: &str,
    ) -> Result<(), StoreError> {
        let n = self.conn.execute(
            "UPDATE agent_run
             SET status = ?2, eta_actual_ms = ?3, summary = ?4,
                 child_session_ref = ?5, ended_at = ?6
             WHERE id = ?1",
            params![
                run_id,
                status,
                eta_actual_ms,
                summary,
                child_session_ref,
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
            child_session_ref: String::new(),
            actor: String::new(),
            created_at: 0,
            started_at: 0,
            ended_at: None,
        }
    }

    /// 发号（2026-11-18 起随机制）：r-{8 hex} 格式、连发不重、不暴露计数、
    /// 跨 Store 重开不撞存量
    #[test]
    fn next_run_id_random_unique_across_reopen() {
        let (dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let mut seen = std::collections::HashSet::new();
        for _ in 0..32 {
            let id = store.next_run_id().unwrap();
            assert!(
                id.starts_with("r-") && id.len() == 10 && id[2..].chars().all(|c| c.is_ascii_hexdigit()),
                "格式应为 r-XXXXXXXX: {id}"
            );
            assert!(seen.insert(id.clone()), "连发不应重复: {id}");
        }
        // 落库后重开：新号不撞存量
        for id in seen.iter().take(4) {
            store.insert_run(&start_row(id, "sess-1", "probe")).unwrap();
        }
        drop(store);
        let store2 = crate::Store::open(&dir.path().join("agent").join("runtime.sqlite3")).unwrap();
        for _ in 0..8 {
            let id = store2.next_run_id().unwrap();
            assert!(!seen.contains(&id), "重开后不应撞存量: {id}");
        }
    }

    /// 按 id 单查：run_by_id 命中/未命中
    #[test]
    fn run_by_id_hit_and_miss() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let id = store.next_run_id().unwrap();
        store.insert_run(&start_row(&id, "sess-1", "delegate")).unwrap();
        let row = store.run_by_id(&id).unwrap().expect("应命中");
        assert_eq!(row.kind, "delegate");
        assert_eq!(row.status, "running");
        assert!(store.run_by_id("r-nope").unwrap().is_none());
    }

    /// 生命周期：insert 强制 running → finish 覆盖终态字段 → runs_of 可查
    #[test]
    fn lifecycle_start_finish_list() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store
            .insert_run(&start_row("r-1", "sess-1", "delegate"))
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
            .finish_run("r-1", "done", 123_456, "委派完成摘要", "claude-session-9")
            .unwrap();
        let runs = store.runs_of("sess-1").unwrap();
        assert_eq!(runs[0].status, "done");
        assert_eq!(runs[0].eta_actual_ms, 123_456);
        assert_eq!(runs[0].summary, "委派完成摘要");
        assert_eq!(runs[0].child_session_ref, "claude-session-9");
        assert!(runs[0].ended_at.is_some(), "终态应带 ended_at");
        assert_eq!(runs[1].status, "running", "其余 run 不受影响");

        // 不存在的 run：报错不静默
        assert!(store.finish_run("r-404", "done", 0, "", "").is_err());
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
        store.finish_run("r-2", "failed", 50, "超步", "").unwrap();
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
