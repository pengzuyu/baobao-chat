//! 会话全文检索与锚定窗口查询（session_search 数据源；索引见 migrations/008_event_fts.sql）。
//!
//! 并行会话注意：Runtime 对 store 是单连接互斥访问，持锁期间其他会话的事件落库会被
//! 挡住——这里每个方法只做一条短查询；组合形态（命中→窗口→首尾→元信息）由工具层
//! 逐条调用、逐条取锁，本层不提供跨多次查询的聚合方法。

use rusqlite::{params, OptionalExtension};

use crate::fts::{FtsQuery, LikeQuery, SearchPlan, SearchSort};
use crate::queries::event::from_row;
use crate::{EventRow, SessionListRow, Store, StoreError};

/// 参数化 SQL 的参数栈（`?` 按出现顺序绑定，IN 列表长度运行期才知道）
type Params = Vec<Box<dyn rusqlite::ToSql>>;

/// agent_event 列（表别名 e）；前 7 列顺序与 queries::event 的行映射一致
const E_COLS: &str = "e.id, e.session_id, e.seq, e.type, e.payload, e.created_at, e.run_id";

/// 检索命中：事件行 + 摘录 + 相关度
#[derive(Debug, Clone, PartialEq)]
pub struct EventHit {
    pub row: EventRow,
    /// 命中摘录（FTS 路径由 SQLite snippet() 产出，命中片段以 >>> <<< 包裹；
    /// LIKE 路径为空串，由调用方按词在正文上切）
    pub snippet: String,
    /// bm25 相关度（越小越相关；LIKE 路径恒 0）
    pub rank: f64,
}

/// 锚定窗口（翻页/搜索命中点上下文）：锚点 + 前后各若干条同类事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventWindow {
    pub anchor: EventRow,
    /// 锚点之前的事件（id 升序，紧邻锚点的在末尾）
    pub before: Vec<EventRow>,
    /// 锚点之后的事件（id 升序）
    pub after: Vec<EventRow>,
    /// 锚点之前/之后的同类事件总数（小于窗口长度即到头）
    pub count_before: i64,
    pub count_after: i64,
}

/// 会话元信息（检索结果归属展示）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeta {
    pub title: String,
    /// workbench | embedded
    pub form: String,
    /// 所属项目目录与名称（日常会话为空串）
    pub project_path: String,
    pub project_name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 最近会话（浏览形态）：列表行 + 首条提问预览 + 事件数
#[derive(Debug, Clone, PartialEq)]
pub struct SessionBrief {
    pub row: SessionListRow,
    pub preview: Option<String>,
    pub events: i64,
}

/// 入索引文本的 SQL 表达式（与 008 迁移触发器同一口径；`e`=事件表别名）
fn indexed_text_expr(e: &str) -> String {
    format!(
        "CASE {e}.type WHEN 'tool.call' THEN COALESCE(json_extract({e}.payload, '$.tool'), '') \
         || ' ' || COALESCE(json_extract({e}.payload, '$.args'), '') \
         ELSE COALESCE(json_extract({e}.payload, '$.text'), '') END"
    )
}

/// LIKE 串转义（ESCAPE '\'）：`\` `%` `_`
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn in_list(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn push_types(p: &mut Params, types: &[&str]) {
    p.extend(
        types
            .iter()
            .map(|t| Box::new(t.to_string()) as Box<dyn rusqlite::ToSql>),
    );
}

/// 检索公共过滤段（? 顺序：排除会话、types…）：只搜主循环事件（run_id 空）与指定类型
fn search_filter(p: &mut Params, types: &[&str], exclude_session: Option<&str>) -> String {
    p.push(Box::new(exclude_session.unwrap_or_default().to_string()));
    push_types(p, types);
    format!(
        "e.run_id = '' AND e.session_id <> ? AND e.type IN ({})",
        in_list(types.len())
    )
}

/// 「同会话主循环事件 + 指定类型」过滤段与参数栈（? 顺序：session_id、types…）
fn session_scope(session_id: &str, types: &[&str]) -> (String, Params) {
    let mut p: Params = vec![Box::new(session_id.to_string())];
    push_types(&mut p, types);
    (
        format!(
            "e.session_id = ? AND e.run_id = '' AND e.type IN ({})",
            in_list(types.len())
        ),
        p,
    )
}

/// FTS 两路径的共用 SQL（? 顺序：正部 MATCH 串、排除会话、types…、[排除部 MATCH 串]、limit）。
/// FTS 表不带别名：MATCH / rank / snippet() 都按表名引用（hermes 同款写法）。
/// 排除不进 MATCH，用同表的子查询取排除集（见 fts::FtsQuery 注释）。
fn fts_sql(
    table: &str,
    q: &FtsQuery,
    p: &mut Params,
    types: &[&str],
    exclude_session: Option<&str>,
    sort: SearchSort,
) -> String {
    p.push(Box::new(q.positive.clone()));
    let filter = search_filter(p, types, exclude_session);
    let exclusion = if q.exclude.is_empty() {
        String::new()
    } else {
        p.push(Box::new(q.exclude.clone()));
        format!(" AND e.id NOT IN (SELECT rowid FROM {table} WHERE {table} MATCH ?)")
    };
    let order = match sort {
        SearchSort::Rank => format!("{table}.rank"),
        SearchSort::Newest => format!("e.created_at DESC, {table}.rank"),
        SearchSort::Oldest => format!("e.created_at ASC, {table}.rank"),
    };
    format!(
        "SELECT {E_COLS}, snippet({table}, 0, '>>>', '<<<', '…', 12), {table}.rank
         FROM {table}
         JOIN agent_event e ON e.id = {table}.rowid
         WHERE {table} MATCH ? AND {filter}{exclusion}
         ORDER BY {order}
         LIMIT ?"
    )
}

/// 纯排除查询（FTS 路径正部为空）：没有正部可走索引，扫事件表并剔除索引上命中
/// 排除串的行。没有相关度：newest/rank 按事件倒序、oldest 正序
/// （? 顺序：排除会话、types…、排除部 MATCH 串、limit）
fn exclude_only_sql(
    table: &str,
    exclude: &str,
    p: &mut Params,
    types: &[&str],
    exclude_session: Option<&str>,
    sort: SearchSort,
) -> String {
    let filter = search_filter(p, types, exclude_session);
    p.push(Box::new(exclude.to_string()));
    let order = match sort {
        SearchSort::Oldest => "e.id ASC",
        _ => "e.id DESC",
    };
    format!(
        "SELECT {E_COLS}, '', 0.0
         FROM agent_event e
         WHERE {filter}
           AND e.id NOT IN (SELECT rowid FROM {table} WHERE {table} MATCH ?)
         ORDER BY {order}
         LIMIT ?"
    )
}

/// LIKE 路径 SQL（? 顺序：排除会话、types…、各 LIKE 串、limit）。
/// 没有相关度：newest/rank 都按事件倒序，oldest 正序。
fn like_sql(
    lq: &LikeQuery,
    p: &mut Params,
    types: &[&str],
    exclude_session: Option<&str>,
    sort: SearchSort,
) -> String {
    let filter = search_filter(p, types, exclude_session);
    // json_valid 先行短路：坏 payload 不让 json_extract 报错
    let text = format!(
        "CASE WHEN json_valid(e.payload) THEN {} ELSE '' END",
        indexed_text_expr("e")
    );
    let like = |p: &mut Params, t: &str| {
        p.push(Box::new(format!("%{}%", like_escape(t))));
        format!("{text} LIKE ? ESCAPE '\\'")
    };
    let groups: Vec<String> = lq
        .groups
        .iter()
        .map(|g| {
            g.iter()
                .map(|t| like(p, t))
                .collect::<Vec<_>>()
                .join(" AND ")
        })
        .collect();
    let mut cond = if groups.is_empty() {
        "1 = 1".to_string()
    } else {
        groups.join(" OR ")
    };
    for t in &lq.exclude {
        cond.push_str(&format!(" AND {text} NOT LIKE ? ESCAPE '\\'"));
        p.push(Box::new(format!("%{}%", like_escape(t))));
    }
    let order = match sort {
        SearchSort::Oldest => "e.id ASC",
        _ => "e.id DESC",
    };
    format!(
        "SELECT {E_COLS}, '', 0.0
         FROM agent_event e
         WHERE {filter} AND ({cond})
         ORDER BY {order}
         LIMIT ?"
    )
}

impl Store {
    fn rows(&self, sql: &str, p: &[Box<dyn rusqlite::ToSql>]) -> Result<Vec<EventRow>, StoreError> {
        let mut stmt = self.conn.prepare(sql)?;
        let mapped = stmt.query_map(
            rusqlite::params_from_iter(p.iter().map(|v| v.as_ref())),
            from_row,
        )?;
        Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn count(&self, sql: &str, p: &[Box<dyn rusqlite::ToSql>]) -> Result<i64, StoreError> {
        Ok(self.conn.query_row(
            sql,
            rusqlite::params_from_iter(p.iter().map(|v| v.as_ref())),
            |r| r.get(0),
        )?)
    }

    /// 全文检索，按 [`SearchPlan`] 路由到对应索引。`exclude_session` 传当前会话
    /// （内容已在上下文里）；`types` 为可命中的事件类型（对话/含工具调用）。
    pub fn search_events(
        &self,
        plan: &SearchPlan,
        types: &[&str],
        exclude_session: Option<&str>,
        sort: SearchSort,
        limit: u32,
    ) -> Result<Vec<EventHit>, StoreError> {
        if types.is_empty() {
            return Ok(Vec::new());
        }
        let mut p: Params = Vec::new();
        let sql = match plan {
            SearchPlan::Fts(q) if q.positive.is_empty() => exclude_only_sql(
                "agent_event_fts",
                &q.exclude,
                &mut p,
                types,
                exclude_session,
                sort,
            ),
            SearchPlan::Fts(q) => {
                fts_sql("agent_event_fts", q, &mut p, types, exclude_session, sort)
            }
            SearchPlan::Trigram(q) if q.positive.is_empty() => exclude_only_sql(
                "agent_event_fts_tri",
                &q.exclude,
                &mut p,
                types,
                exclude_session,
                sort,
            ),
            SearchPlan::Trigram(q) => fts_sql(
                "agent_event_fts_tri",
                q,
                &mut p,
                types,
                exclude_session,
                sort,
            ),
            SearchPlan::Like(lq) => like_sql(lq, &mut p, types, exclude_session, sort),
        };
        p.push(Box::new(limit as i64));
        let mut stmt = self.conn.prepare(&sql)?;
        let mapped = stmt.query_map(
            rusqlite::params_from_iter(p.iter().map(|v| v.as_ref())),
            |row| {
                Ok(EventHit {
                    row: from_row(row)?,
                    snippet: row.get(7)?,
                    rank: row.get(8)?,
                })
            },
        )?;
        Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 锚定窗口：`window` 条之前的同类事件 + 锚点 + `window` 条之后的同类事件。
    /// 锚点不在该会话 → None。计数是总数（不受窗口长度限制），用于判断是否到头。
    pub fn events_around(
        &self,
        session_id: &str,
        anchor_id: i64,
        window: u32,
        types: &[&str],
    ) -> Result<Option<EventWindow>, StoreError> {
        let anchor = self.rows(
            &format!("SELECT {E_COLS} FROM agent_event e WHERE e.session_id = ?1 AND e.id = ?2"),
            &[Box::new(session_id.to_string()), Box::new(anchor_id)],
        )?;
        let Some(anchor) = anchor.into_iter().next() else {
            return Ok(None);
        };
        let scope = || session_scope(session_id, types);
        let (filter, mut before_p) = scope();
        before_p.push(Box::new(anchor_id));
        before_p.push(Box::new(window as i64));
        let (_, mut after_p) = scope();
        after_p.push(Box::new(anchor_id));
        after_p.push(Box::new(window as i64));
        let mut before = self.rows(
            &format!(
                "SELECT {E_COLS} FROM agent_event e WHERE {filter}
                 AND e.id < ? ORDER BY e.id DESC LIMIT ?"
            ),
            &before_p,
        )?;
        before.reverse();
        let after = self.rows(
            &format!(
                "SELECT {E_COLS} FROM agent_event e WHERE {filter}
                 AND e.id > ? ORDER BY e.id ASC LIMIT ?"
            ),
            &after_p,
        )?;
        before_p.truncate(before_p.len() - 1);
        after_p.truncate(after_p.len() - 1);
        let count_before = self.count(
            &format!("SELECT COUNT(*) FROM agent_event e WHERE {filter} AND e.id < ?"),
            &before_p,
        )?;
        let count_after = self.count(
            &format!("SELECT COUNT(*) FROM agent_event e WHERE {filter} AND e.id > ?"),
            &after_p,
        )?;
        Ok(Some(EventWindow {
            anchor,
            before,
            after,
            count_before,
            count_after,
        }))
    }

    /// 通读用的首尾切片：（前 head 条, 后 tail 条, 同类事件总数）。
    /// 总数不超过 head+tail 时一次性全取（放在第一段，第二段为空）。
    pub fn session_head_tail(
        &self,
        session_id: &str,
        head: u32,
        tail: u32,
        types: &[&str],
    ) -> Result<(Vec<EventRow>, Vec<EventRow>, i64), StoreError> {
        let (filter, p) = session_scope(session_id, types);
        let total = self.count(
            &format!("SELECT COUNT(*) FROM agent_event e WHERE {filter}"),
            &p,
        )?;
        let slice = |order: &str, limit: i64| -> Result<Vec<EventRow>, StoreError> {
            let (filter, mut p) = session_scope(session_id, types);
            p.push(Box::new(limit));
            let sql = format!(
                "SELECT {E_COLS} FROM agent_event e WHERE {filter} ORDER BY e.id {order} LIMIT ?"
            );
            self.rows(&sql, &p)
        };
        if total <= i64::from(head) + i64::from(tail) {
            return Ok((slice("ASC", total)?, Vec::new(), total));
        }
        let first = slice("ASC", i64::from(head))?;
        let mut last = slice("DESC", i64::from(tail))?;
        last.reverse();
        Ok((first, last, total))
    }

    /// 会话首尾（书挡）：`before_id` 之前最早的 n 条 + `after_id` 之后最晚的 n 条，
    /// 都只取给定边界之外的（不与中间窗口重叠）；边界为 None 表示该侧不取。
    pub fn session_bookends(
        &self,
        session_id: &str,
        before_id: Option<i64>,
        after_id: Option<i64>,
        n: u32,
        types: &[&str],
    ) -> Result<(Vec<EventRow>, Vec<EventRow>), StoreError> {
        let side = |cmp: &str, id: i64| -> Result<Vec<EventRow>, StoreError> {
            let (filter, mut p) = session_scope(session_id, types);
            p.push(Box::new(id));
            p.push(Box::new(n as i64));
            // 最早的一条在前：起点侧正序取、终点侧倒序取（调用方再翻回正序）
            let order = if cmp == "<" { "ASC" } else { "DESC" };
            let sql = format!(
                "SELECT {E_COLS} FROM agent_event e WHERE {filter}
                 AND e.id {cmp} ? ORDER BY e.id {order} LIMIT ?"
            );
            self.rows(&sql, &p)
        };
        let start = match before_id {
            Some(id) if n > 0 => side("<", id)?,
            _ => Vec::new(),
        };
        let mut end = match after_id {
            Some(id) if n > 0 => side(">", id)?,
            _ => Vec::new(),
        };
        end.reverse();
        Ok((start, end))
    }

    /// 会话元信息（标题/形式/所属项目/时间）；会话不存在 → None
    pub fn session_meta(&self, session_id: &str) -> Result<Option<SessionMeta>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT s.title, s.form, COALESCE(w.path, ''), COALESCE(w.name, ''),
                        s.created_at, s.updated_at
                 FROM agent_session s
                 LEFT JOIN agent_workspace w ON w.id = s.workspace_id
                 WHERE s.id = ?1",
                params![session_id],
                |r| {
                    Ok(SessionMeta {
                        title: r.get(0)?,
                        form: r.get(1)?,
                        project_path: r.get(2)?,
                        project_name: r.get(3)?,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// 最近会话（updated_at 倒序）+ 首条提问预览 + 事件数
    pub fn recent_sessions(&self, limit: u32) -> Result<Vec<SessionBrief>, StoreError> {
        let mut out = Vec::new();
        for row in self.list_sessions_with_workspace(limit)? {
            // CAST：text 字段非字符串时也落成文本；坏 payload 经 json_valid 短路为 NULL
            let preview: Option<String> = self
                .conn
                .query_row(
                    "SELECT CAST(CASE WHEN json_valid(payload)
                                      THEN json_extract(payload, '$.text') END AS TEXT)
                     FROM agent_event
                     WHERE session_id = ?1 AND type = 'user.text' ORDER BY seq ASC LIMIT 1",
                    params![row.id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let events = self.count(
                "SELECT COUNT(*) FROM agent_event e WHERE e.session_id = ?1",
                &[Box::new(row.id.clone())],
            )?;
            out.push(SessionBrief {
                row,
                preview,
                events,
            });
        }
        Ok(out)
    }

    /// 各项目的会话数（list_projects 数据源）；没有会话的项目不出现
    pub fn count_sessions_by_workspace(&self) -> Result<Vec<(String, i64)>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id, COUNT(*) FROM agent_session
             WHERE workspace_id IS NOT NULL GROUP BY workspace_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{fts, testutil};

    const DIALOG: &[&str] = &["user.text", "assistant.done"];
    const ALL: &[&str] = &["user.text", "assistant.done", "tool.call"];

    fn say(store: &Store, sid: &str, seq: i64, kind: &str, payload: &str) {
        store.append_event(sid, seq, kind, payload).unwrap();
    }

    fn last_id(store: &Store) -> i64 {
        store
            .conn
            .query_row("SELECT MAX(id) FROM agent_event", [], |r| r.get(0))
            .unwrap()
    }

    fn search(store: &Store, query: &str, types: &[&str], exclude: Option<&str>) -> Vec<EventHit> {
        store
            .search_events(
                &fts::plan_query(query).expect("查询应可解析"),
                types,
                exclude,
                SearchSort::Rank,
                50,
            )
            .unwrap()
    }

    fn fts_count(store: &Store, table: &str) -> i64 {
        store
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// bundled SQLite 的 trigram 可用：中文无空盘子串能命中，snippet 带标记
    #[test]
    fn trigram_中文子串命中() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        say(
            &store,
            "sess-1",
            1,
            "user.text",
            r#"{"text":"帮我把登录页的超时改成三十秒"}"#,
        );
        say(
            &store,
            "sess-1",
            2,
            "assistant.done",
            r#"{"text":"好的，已改为 30s"}"#,
        );
        say(
            &store,
            "sess-1",
            3,
            "user.text",
            r#"{"text":"今天天气不错"}"#,
        );

        let hits = search(&store, "登录页的超时", DIALOG, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row.seq, 1);
        assert_eq!(hits[0].row.type_, "user.text");
        assert!(
            hits[0].snippet.contains(">>>登录页的超时<<<"),
            "{}",
            hits[0].snippet
        );
        assert!(hits[0].rank.is_finite());
    }

    /// 英文词级：整词匹配（auth 不中 author）、前缀 `*`、排除对全部词组生效
    #[test]
    fn fts_英文词级与前缀与排除() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        say(
            &store,
            "sess-1",
            1,
            "user.text",
            r#"{"text":"We need to refactor the auth module"}"#,
        );
        say(
            &store,
            "sess-1",
            2,
            "user.text",
            r#"{"text":"Deploy to production today"}"#,
        );
        say(
            &store,
            "sess-1",
            3,
            "user.text",
            r#"{"text":"The author is away"}"#,
        );

        assert_eq!(search(&store, "auth", DIALOG, None).len(), 1);
        assert_eq!(search(&store, "deploy*", DIALOG, None).len(), 1);
        assert_eq!(search(&store, "refactor NOT auth", DIALOG, None).len(), 0);
        // 排除对两组都生效：两组各有一行，两个排除词把两行都盖住才是 0
        // （若只作用于最后一组，refactor 那行会被误留，结果为 1）
        assert_eq!(
            search(
                &store,
                "refactor OR deploy NOT module NOT production",
                DIALOG,
                None
            )
            .len(),
            0
        );
        assert_eq!(
            search(&store, "auth OR deploy NOT production", DIALOG, None).len(),
            1
        );
    }

    /// 纯排除查询（只有 NOT 词）：没有正部，走扫描形态按时间倒序、无摘录
    #[test]
    fn 纯排除查询() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let ids = seed_dialog(&store, "sess-1", 3);
        store
            .append_event(
                "sess-1",
                4,
                "user.text",
                r#"{"text":"deploy to production"}"#,
            )
            .unwrap();

        let hits = search(&store, "NOT deploy", DIALOG, None);
        assert_eq!(
            hits.iter().map(|h| h.row.id).collect::<Vec<_>>(),
            [ids[2], ids[1], ids[0]]
        );
        assert!(hits.iter().all(|h| h.snippet.is_empty() && h.rank == 0.0));
    }

    /// 1–2 字中文词落 LIKE 兜底：子串命中、布尔结构生效、无 snippet（调用方自切）
    #[test]
    fn like_短中文词兜底() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        say(
            &store,
            "sess-1",
            1,
            "user.text",
            r#"{"text":"修复登录超时"}"#,
        );
        say(
            &store,
            "sess-1",
            2,
            "user.text",
            r#"{"text":"注册流程改了"}"#,
        );
        say(
            &store,
            "sess-1",
            3,
            "user.text",
            r#"{"text":"进度 100% 完成"}"#,
        );

        let hits = search(&store, "登录", DIALOG, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row.seq, 1);
        assert!(hits[0].snippet.is_empty());
        assert_eq!(search(&store, "登录 NOT 超时", DIALOG, None).len(), 0);
        // LIKE 通配符按字面匹配
        assert_eq!(search(&store, "进度 100%", DIALOG, None).len(), 1);
        assert_eq!(search(&store, "完成 50%", DIALOG, None).len(), 0);
    }

    /// 默认排除指定会话与子代理 run 事件
    #[test]
    fn 排除当前会话与子代理事件() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        testutil::seed_session(&store, "sess-2");
        say(
            &store,
            "sess-1",
            1,
            "user.text",
            r#"{"text":"登录超时怎么改"}"#,
        );
        say(
            &store,
            "sess-2",
            1,
            "user.text",
            r#"{"text":"登录超时是 bug 吗"}"#,
        );
        store
            .append_event_with_run(
                "sess-1",
                2,
                "user.text",
                r#"{"text":"子代理也提登录超时"}"#,
                "run-1",
            )
            .unwrap();

        let hits = search(&store, "登录超时", DIALOG, Some("sess-2"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row.session_id, "sess-1");
        assert_eq!(search(&store, "登录超时", DIALOG, None).len(), 2);
    }

    /// 类型过滤决定工具调用是否可搜；工具名与脱敏参数都入索引
    #[test]
    fn 类型过滤_工具调用() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        store
            .append_event(
                "sess-1",
                1,
                "tool.call",
                r#"{"call_id":"c1","tool":"run_command","args":"{\"command\":\"cargo test\"}"}"#,
            )
            .unwrap();

        assert_eq!(search(&store, "cargo test", DIALOG, None).len(), 0);
        let hits = search(&store, "cargo test", ALL, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row.type_, "tool.call");
        assert_eq!(search(&store, "run_command", ALL, None).len(), 1);
    }

    /// 思考/工具输出不入索引；坏 payload 不入索引也不连累事件写入
    #[test]
    fn 不入索引的事件与坏payload() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        say(
            &store,
            "sess-1",
            1,
            "assistant.thinking",
            r#"{"text":"想想登录超时的事"}"#,
        );
        say(
            &store,
            "sess-1",
            2,
            "tool.result",
            r#"{"call_id":"c1","ok":true,"summary":"登录超时 30s"}"#,
        );
        say(&store, "sess-1", 3, "user.text", "not json { 登录超时");

        let any = &[
            "user.text",
            "assistant.done",
            "assistant.thinking",
            "tool.call",
            "tool.result",
        ];
        assert!(search(&store, "登录超时", any, None).is_empty());
        // 事件行本身在
        assert_eq!(store.events_after("sess-1", 0, 100).unwrap().len(), 3);
        assert_eq!(fts_count(&store, "agent_event_fts"), 0);
    }

    /// 会话删除级联删事件：索引同步清除，不留孤儿行
    #[test]
    fn 删除会话_索引同步清除() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        testutil::seed_session(&store, "sess-2");
        say(&store, "sess-1", 1, "user.text", r#"{"text":"登录超时"}"#);
        say(&store, "sess-2", 1, "user.text", r#"{"text":"登录超时"}"#);

        store.delete_session("sess-1").unwrap();
        let hits = search(&store, "登录超时", DIALOG, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row.session_id, "sess-2");
        for t in ["agent_event_fts", "agent_event_fts_tri"] {
            assert_eq!(fts_count(&store, t), 1, "{t} 不应残留已删事件的索引行");
        }
    }

    /// 迁移前就存在的事件：索引被清空后拨回 user_version 重跑迁移，回填后可搜
    #[test]
    fn 存量回填_迁移重跑后可搜() {
        let (_dir, mut store) = testutil::open_store();
        testutil::seed_session(&store, "sess-old");
        say(
            &store,
            "sess-old",
            1,
            "user.text",
            r#"{"text":"上个版本的登录超时讨论"}"#,
        );
        store
            .append_event(
                "sess-old",
                2,
                "tool.call",
                r#"{"call_id":"c1","tool":"git_status","args":"{}"}"#,
            )
            .unwrap();
        say(
            &store,
            "sess-old",
            3,
            "assistant.thinking",
            r#"{"text":"不入索引"}"#,
        );
        store
            .conn
            .execute_batch("DELETE FROM agent_event_fts; DELETE FROM agent_event_fts_tri;")
            .unwrap();
        store.conn.pragma_update(None, "user_version", 7).unwrap();

        crate::migrate::run(&mut store.conn).unwrap();

        let hits = search(&store, "登录超时", DIALOG, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(search(&store, "git_status", ALL, None).len(), 1);
        for t in ["agent_event_fts", "agent_event_fts_tri"] {
            assert_eq!(fts_count(&store, t), 2, "{t} 只应含两类入索引事件");
        }
    }

    /// 排序：newest/oldest 按事件时间，rank 缺省（词频高的排前）
    #[test]
    fn 排序_时间与相关度() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        say(
            &store,
            "sess-1",
            1,
            "user.text",
            r#"{"text":"first deploy here"}"#,
        );
        say(
            &store,
            "sess-1",
            2,
            "user.text",
            r#"{"text":"deploy deploy second"}"#,
        );
        let ids: Vec<i64> = store
            .events_after("sess-1", 0, 10)
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        for (i, id) in ids.iter().enumerate() {
            let ts = (i as i64 + 1) * 1000;
            store
                .conn
                .execute(
                    "UPDATE agent_event SET created_at = ?1 WHERE id = ?2",
                    params![ts, id],
                )
                .unwrap();
        }
        let plan = fts::plan_query("deploy").unwrap();
        let order = |sort| {
            store
                .search_events(&plan, DIALOG, None, sort, 50)
                .unwrap()
                .into_iter()
                .map(|h| h.row.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(order(SearchSort::Oldest), ids);
        assert_eq!(order(SearchSort::Newest), [ids[1], ids[0]]);
        assert_eq!(order(SearchSort::Rank), [ids[1], ids[0]]);
    }

    fn seed_dialog(store: &Store, sid: &str, n: i64) -> Vec<i64> {
        let mut ids = Vec::new();
        for seq in 1..=n {
            let payload = format!(r#"{{"text":"第 {seq} 条"}}"#);
            say(store, sid, seq, "user.text", &payload);
            ids.push(last_id(store));
        }
        ids
    }

    /// 锚定窗口：前后各 window 条、两端剩余计数；锚点不在会话内 → None
    #[test]
    fn events_around_窗口与边界计数() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let ids = seed_dialog(&store, "sess-1", 5);

        let w = store
            .events_around("sess-1", ids[2], 1, DIALOG)
            .unwrap()
            .unwrap();
        assert_eq!(w.anchor.id, ids[2]);
        assert_eq!(w.before.iter().map(|e| e.id).collect::<Vec<_>>(), [ids[1]]);
        assert_eq!(w.after.iter().map(|e| e.id).collect::<Vec<_>>(), [ids[3]]);
        assert_eq!((w.count_before, w.count_after), (2, 2));

        let w = store
            .events_around("sess-1", ids[2], 5, DIALOG)
            .unwrap()
            .unwrap();
        assert_eq!(w.before.len(), 2);
        assert_eq!(w.after.len(), 2);
        assert_eq!((w.count_before, w.count_after), (2, 2));

        let head = store
            .events_around("sess-1", ids[0], 2, DIALOG)
            .unwrap()
            .unwrap();
        assert!(head.before.is_empty());
        assert_eq!((head.count_before, head.count_after), (0, 4));
        assert!(store
            .events_around("sess-1", 999_999, 2, DIALOG)
            .unwrap()
            .is_none());
    }

    /// 通读首尾切片：总数超预算时分两段，否则全取
    #[test]
    fn session_head_tail_通读() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let ids = seed_dialog(&store, "sess-1", 5);

        let (first, last, total) = store.session_head_tail("sess-1", 2, 1, DIALOG).unwrap();
        assert_eq!(total, 5);
        assert_eq!(first.iter().map(|e| e.id).collect::<Vec<_>>(), ids[..2]);
        assert_eq!(last.iter().map(|e| e.id).collect::<Vec<_>>(), [ids[4]]);

        let (first, last, _) = store.session_head_tail("sess-1", 10, 0, DIALOG).unwrap();
        assert_eq!(first.iter().map(|e| e.id).collect::<Vec<_>>(), ids);
        assert!(last.is_empty());
    }

    /// 书挡只取窗口之外的首尾，各自升序
    #[test]
    fn session_bookends_窗口之外的首尾() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        let ids = seed_dialog(&store, "sess-1", 9);

        let (start, end) = store
            .session_bookends("sess-1", Some(ids[3]), Some(ids[5]), 2, DIALOG)
            .unwrap();
        assert_eq!(start.iter().map(|e| e.id).collect::<Vec<_>>(), ids[..2]);
        assert_eq!(
            end.iter().map(|e| e.id).collect::<Vec<_>>(),
            [ids[7], ids[8]]
        );
        let (start, end) = store
            .session_bookends("sess-1", None, None, 2, DIALOG)
            .unwrap();
        assert!(start.is_empty() && end.is_empty());
    }

    /// 会话元信息带所属项目；日常会话项目为空；不存在 → None
    #[test]
    fn session_meta_带项目名() {
        let (_dir, store) = testutil::open_store();
        let s = testutil::seed_session(&store, "sess-p");
        let ws = crate::Workspace {
            id: "ws-1".into(),
            path: "/repo/a".into(),
            name: "项目A".into(),
            is_repo: true,
            trusted: true,
            extra_dirs: None,
            last_opened_at: 1,
            created_at: 1,
        };
        store.upsert_workspace(&ws).unwrap();
        store.set_session_workspace(&s.id, Some("ws-1")).unwrap();
        testutil::seed_session(&store, "sess-d");

        let meta = store.session_meta("sess-p").unwrap().unwrap();
        assert_eq!(
            (meta.project_path.as_str(), meta.project_name.as_str()),
            ("/repo/a", "项目A")
        );
        let meta = store.session_meta("sess-d").unwrap().unwrap();
        assert!(meta.project_path.is_empty());
        assert!(store.session_meta("sess-无").unwrap().is_none());
    }

    /// 最近会话带首条提问预览与事件数；无事件的会话预览为空
    #[test]
    fn recent_sessions_带预览与事件数() {
        let (_dir, store) = testutil::open_store();
        testutil::seed_session(&store, "sess-1");
        testutil::seed_session(&store, "sess-2");
        say(
            &store,
            "sess-1",
            1,
            "assistant.done",
            r#"{"text":"先说话的是助手"}"#,
        );
        say(
            &store,
            "sess-1",
            2,
            "user.text",
            r#"{"text":"帮我查登录超时"}"#,
        );

        let briefs = store.recent_sessions(10).unwrap();
        assert_eq!(briefs.len(), 2);
        let first = briefs.iter().find(|b| b.row.id == "sess-1").unwrap();
        assert_eq!(first.preview.as_deref(), Some("帮我查登录超时"));
        assert_eq!(first.events, 2);
        let second = briefs.iter().find(|b| b.row.id == "sess-2").unwrap();
        assert_eq!(second.preview, None);
        assert_eq!(second.events, 0);
    }

    /// 各项目会话数：未关联项目的会话不计，没有会话的项目不出现
    #[test]
    fn count_sessions_by_workspace_只计已关联() {
        let (_dir, store) = testutil::open_store();
        let ws = |id: &str| crate::Workspace {
            id: id.into(),
            path: format!("/repo/{id}"),
            name: id.into(),
            is_repo: false,
            trusted: true,
            extra_dirs: None,
            last_opened_at: 1,
            created_at: 1,
        };
        store.upsert_workspace(&ws("ws-a")).unwrap();
        store.upsert_workspace(&ws("ws-b")).unwrap();
        for (sid, wid) in [
            ("sess-1", Some("ws-a")),
            ("sess-2", Some("ws-a")),
            ("sess-3", None),
        ] {
            let s = testutil::seed_session(&store, sid);
            store.set_session_workspace(&s.id, wid).unwrap();
        }
        assert_eq!(
            store.count_sessions_by_workspace().unwrap(),
            [("ws-a".to_string(), 2)]
        );
    }
}
