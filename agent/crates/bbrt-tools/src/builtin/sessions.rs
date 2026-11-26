//! session_search 工具（任务感知工作台·会话检索）：跨会话搜索与 agent 的历史对话，
//! 或在单个会话内翻页/通读。数据源=本机 agent_event 事件镜像 WAL + 008 全文索引
//! （查询净化、路径路由与索引查询见 bbrt_store::fts / queries::search）。
//!
//! 参考 hermes-agent tools/session_search_tool.py 的「单工具四形态」，形态由参数
//! 组合推断、没有 mode 参数——
//! - DISCOVERY 传 query：全文命中 → 按会话去重 → 每个会话带命中摘录 + 命中点前后
//!   窗口 + 会话首尾书挡（一次看清「当时要做什么 / 命中处 / 最后怎么收尾」）
//! - SCROLL    传 session_id + around_event_id：锚点前后翻页，带两端剩余计数
//! - READ      只传 session_id：通读（前 20 + 后 10，超出的给翻页指引）
//! - BROWSE    什么都不传：最近会话列表
//!
//! 搜索与最近会话默认排除当前会话（内容已在上下文里）与子代理 run 事件；
//! 显式指定 session_id 的翻页/通读不受限。
//!
//! 并行会话注意：Runtime 对 store 是单连接互斥访问——本工具每条查询单独取锁、
//! 查完即放，不跨整个形态持锁（否则一次搜索会挡住其他会话的事件落库）。

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use bbrt_store::{EventHit, EventRow, SearchSort, Store};

use super::{degraded_output, lock_store, ok_output, str_arg, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// scope=dialog（缺省）：只搜/只展示提问与回复
const DIALOG: &[&str] = &["user.text", "assistant.done"];
/// scope=all：加工具调用（工具名 + 脱敏参数）
const ALL: &[&str] = &["user.text", "assistant.done", "tool.call"];

/// 输出预算：序列化后的 JSON 上限（字节）。超出则每条消息的字符上限折半重裁，
/// 仍超出再从末尾丢会话——单次搜索不把上下文撑爆
const MAX_BYTES: usize = 64 * 1024;
const MIN_CAP: usize = 200;
/// 窗口/书挡消息的缺省字符上限（通读形态更大）
const WINDOW_CAP: usize = 1000;
const READ_CAP: usize = 3000;

const DISCOVERY_WINDOW: u32 = 5;
const BOOKEND: u32 = 3;
const READ_HEAD: u32 = 20;
const READ_TAIL: u32 = 10;

pub fn session_search_def() -> ToolDef {
    ToolDef {
        name: "session_search".into(),
        description: "Search past conversations with the agent stored on this machine, or read \
                      inside one. Full-text index over the local session store — no model calls, \
                      every result is actual dialogue from the database. Four calling shapes, \
                      inferred from the arguments:\n\
                      1) SEARCH — pass query: runs full-text search, returns the top sessions. \
                      Each result carries the session title, a snippet with the match marked as \
                      >>>match<<<, the events around the match (window, anchor flagged), and the \
                      session's opening and ending lines (bookend_start / bookend_end) so you can \
                      see the goal, the match and the resolution in one call.\n\
                      2) SCROLL — pass session_id + around_event_id: events around the anchor. \
                      Pass the last id to scroll forward, the first id to scroll back; \
                      events_before / events_after tell you how much remains.\n\
                      3) READ — pass session_id only: the whole session (first 20 + last 10 \
                      events when long; scroll for the middle).\n\
                      4) BROWSE — pass nothing: recently active sessions with previews.\n\
                      Query syntax: AND is the default between words; OR, NOT, quoted \"exact \
                      phrase\" and prefix wildcards (deploy*) work. Pass keywords or a short \
                      phrase, not a whole sentence. Use it whenever the user asks what was \
                      discussed or decided before (\"what did we do about X\", \"where did we \
                      leave Y\") before searching the filesystem or the web — chat tools like \
                      im_history cover other people's messages, this covers the user's own \
                      sessions with you"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search shape: keywords or a short phrase to find in past \
                                    conversations. Omit to browse recent sessions. Ignored when \
                                    session_id is set"
                },
                "limit": {
                    "type": "integer",
                    "description": "Search: max sessions to return (default 3, max 10). Browse: \
                                    max sessions to list (default 10, max 30)"
                },
                "sort": {
                    "type": "string",
                    "enum": ["newest", "oldest"],
                    "description": "Search only. Omit for relevance order; 'newest' for recency \
                                    questions (where did we leave X); 'oldest' for origin \
                                    questions (how did X start)"
                },
                "scope": {
                    "type": "string",
                    "enum": ["dialog", "all"],
                    "description": "'dialog' (default) searches and shows user prompts and \
                                    assistant replies only; 'all' also includes tool calls"
                },
                "session_id": {
                    "type": "string",
                    "description": "Scroll/Read: a session_id from a previous result. With \
                                    around_event_id it scrolls; alone it reads the whole session"
                },
                "around_event_id": {
                    "type": "integer",
                    "description": "Scroll: event id to center the window on (match_event_id from \
                                    a search, or any id from a previous window)"
                },
                "window": {
                    "type": "integer",
                    "description": "Scroll: events on each side of the anchor (default 5, 1-20)"
                }
            }
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// session_search 实现：按参数组合推断形态，返回 JSON 文本
pub(crate) fn search(
    store: Option<&Arc<Mutex<Store>>>,
    current_session: &str,
    args: &Value,
) -> Result<ExecOutput, ToolBlock> {
    let Some(store) = store else {
        return Ok(degraded_output(
            "Session search is unavailable: the local session store is not assembled.",
        ));
    };
    let types = scope_types(args);
    let anchor = args.get("around_event_id").and_then(Value::as_i64);
    // 形态推断：滚动 > 通读 > 搜索 > 最近会话
    let built = match (str_arg(args, "session_id"), anchor) {
        (Some(sid), Some(id)) => {
            let window = clamp(int_arg(args, "window").unwrap_or(5), 1, 20) as u32;
            scroll(store, &sid, id, window, types)
        }
        (Some(sid), None) => read(store, &sid, types),
        (None, _) => match str_arg(args, "query") {
            Some(query) => {
                let sort = match str_arg(args, "sort").as_deref() {
                    Some("newest") => SearchSort::Newest,
                    Some("oldest") => SearchSort::Oldest,
                    _ => SearchSort::Rank,
                };
                let limit = clamp(int_arg(args, "limit").unwrap_or(3), 1, 10) as u32;
                discover(store, &query, limit, sort, types, current_session)
            }
            None => {
                let limit = clamp(int_arg(args, "limit").unwrap_or(10), 1, 30) as u32;
                browse(store, limit, current_session)
            }
        },
    };
    match built {
        Ok((value, cap)) => Ok(ok_output(fit_budget(&value, cap))),
        Err(e) => Ok(degraded_output(format!("Session search failed: {e}"))),
    }
}

fn scope_types(args: &Value) -> &'static [&'static str] {
    match str_arg(args, "scope").as_deref() {
        Some("all") => ALL,
        _ => DIALOG,
    }
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn clamp(v: i64, lo: i64, hi: i64) -> i64 {
    v.max(lo).min(hi)
}

/// 搜索形态：返回（结果树, 窗口字符上限）
fn discover(
    store: &Arc<Mutex<Store>>,
    query: &str,
    limit: u32,
    sort: SearchSort,
    types: &[&str],
    current_session: &str,
) -> Result<(Value, usize), bbrt_store::StoreError> {
    let Some(plan) = bbrt_store::plan_query(query) else {
        return Ok((
            json!({
                "mode": "discover",
                "query": query,
                "results": [],
                "count": 0,
                "message": "The query has no searchable keywords; pass words or a short phrase.",
            }),
            WINDOW_CAP,
        ));
    };
    let hits = lock_store(store).search_events(&plan, types, Some(current_session), sort, 50)?;
    // 按会话去重（命中已按 sort 有序），每个会话取最靠前的一条
    let mut firsts: Vec<EventHit> = Vec::new();
    for hit in hits {
        if firsts
            .iter()
            .any(|h| h.row.session_id == hit.row.session_id)
        {
            continue;
        }
        firsts.push(hit);
        if firsts.len() == limit as usize {
            break;
        }
    }
    // LIKE 兜底路径没有 SQLite snippet：按词在正文上切
    let like_terms: Vec<String> = match &plan {
        bbrt_store::SearchPlan::Like(lq) => lq.groups.iter().flatten().cloned().collect(),
        _ => Vec::new(),
    };
    let mut results = Vec::new();
    for hit in firsts {
        let sid = hit.row.session_id.as_str();
        let Some(window) =
            lock_store(store).events_around(sid, hit.row.id, DISCOVERY_WINDOW, types)?
        else {
            continue;
        };
        // 书挡只取窗口之外的：边界=窗口里最早/最晚的事件（无前/后文时即锚点）
        let first_id = window.before.first().unwrap_or(&window.anchor).id;
        let last_id = window.after.last().unwrap_or(&window.anchor).id;
        let (start, end) = lock_store(store).session_bookends(
            sid,
            Some(first_id),
            Some(last_id),
            BOOKEND,
            types,
        )?;
        let meta = match lock_store(store).session_meta(sid)? {
            Some(meta) => meta,
            None => continue,
        };
        let snippet = if hit.snippet.is_empty() {
            excerpt(&plain_text(&hit.row).unwrap_or_default(), &like_terms, 60)
        } else {
            hit.snippet.clone()
        };
        let events: Vec<Value> = window
            .before
            .iter()
            .map(|e| msg(e, false))
            .chain(std::iter::once(msg(&window.anchor, true)))
            .chain(window.after.iter().map(|e| msg(e, false)))
            .flatten()
            .collect();
        results.push(json!({
            "session_id": sid,
            "title": meta.title,
            "form": meta.form,
            "project": project_label(&meta),
            "started_at": iso(meta.created_at),
            "last_active": iso(meta.updated_at),
            "match_event_id": hit.row.id,
            "matched": role_of(&hit.row.type_),
            "snippet": snippet,
            "events_before": window.count_before,
            "events_after": window.count_after,
            "bookend_start": start.iter().filter_map(|e| msg(e, false)).collect::<Vec<_>>(),
            "window": events,
            "bookend_end": end.iter().filter_map(|e| msg(e, false)).collect::<Vec<_>>(),
        }));
    }
    let count = results.len();
    let message = if count == 0 {
        "No matching sessions. Try shorter keywords (Chinese words of 1-2 characters also \
         work), broaden with OR, or omit query to browse recent sessions."
    } else {
        "Each result shows the session opening (bookend_start), the match in context (window, \
         anchor flagged) and its ending (bookend_end). Pass session_id + around_event_id to \
         scroll, or session_id alone to read the whole session."
    };
    Ok((
        json!({ "mode": "discover", "query": query, "count": count, "results": results, "message": message }),
        WINDOW_CAP,
    ))
}

/// 翻页形态：锚点 + 前后各 `window` 条，带两端剩余计数
fn scroll(
    store: &Arc<Mutex<Store>>,
    sid: &str,
    anchor_id: i64,
    window: u32,
    types: &[&str],
) -> Result<(Value, usize), bbrt_store::StoreError> {
    let Some(w) = lock_store(store).events_around(sid, anchor_id, window, types)? else {
        return Ok((
            json!({ "mode": "scroll", "error": format!("around_event_id {anchor_id} is not in session {sid}") }),
            WINDOW_CAP,
        ));
    };
    let meta = lock_store(store).session_meta(sid)?;
    let events: Vec<Value> = w
        .before
        .iter()
        .map(|e| msg(e, false))
        .chain(std::iter::once(msg(&w.anchor, true)))
        .chain(w.after.iter().map(|e| msg(e, false)))
        .flatten()
        .collect();
    Ok((
        json!({
            "mode": "scroll",
            "session_id": sid,
            "title": meta.as_ref().map(|m| m.title.clone()).unwrap_or_default(),
            "project": meta.as_ref().map(project_label).unwrap_or_default(),
            "around_event_id": anchor_id,
            "events_before": w.count_before,
            "events_after": w.count_after,
            "window": events,
            "message": format!(
                "{} event(s) before and {} after the anchor remain in this session. Pass the last \
                 id to scroll forward or the first id to scroll back.",
                w.count_before, w.count_after
            ),
        }),
        WINDOW_CAP,
    ))
}

/// 通读形态：前 READ_HEAD + 后 READ_TAIL 条，超出的给翻页指引
fn read(
    store: &Arc<Mutex<Store>>,
    sid: &str,
    types: &[&str],
) -> Result<(Value, usize), bbrt_store::StoreError> {
    let Some(meta) = lock_store(store).session_meta(sid)? else {
        return Ok((
            json!({ "mode": "read", "error": format!("session_id not found: {sid}") }),
            READ_CAP,
        ));
    };
    let (head, tail, total) =
        lock_store(store).session_head_tail(sid, READ_HEAD, READ_TAIL, types)?;
    let shown = head.len() + tail.len();
    let truncated = i64::try_from(shown).unwrap_or(i64::MAX) < total;
    let mut message = String::new();
    if truncated {
        message = format!(
            "Showing the first {} and last {} of {total} events; pass session_id + \
             around_event_id (any id above) to read the middle.",
            head.len(),
            tail.len()
        );
    }
    Ok((
        json!({
            "mode": "read",
            "session_id": sid,
            "title": meta.title,
            "project": project_label(&meta),
            "event_count": total,
            "truncated": truncated,
            "head": head.iter().filter_map(|e| msg(e, false)).collect::<Vec<_>>(),
            "tail": tail.iter().filter_map(|e| msg(e, false)).collect::<Vec<_>>(),
            "message": message,
        }),
        READ_CAP,
    ))
}

/// 最近会话形态：标题/所属项目/首条提问预览/事件数/时间，跳过当前会话
fn browse(
    store: &Arc<Mutex<Store>>,
    limit: u32,
    current_session: &str,
) -> Result<(Value, usize), bbrt_store::StoreError> {
    let briefs = lock_store(store).recent_sessions(limit.saturating_add(5))?;
    let results: Vec<Value> = briefs
        .into_iter()
        .filter(|b| b.row.id != current_session)
        .take(limit as usize)
        .map(|b| {
            // 预览截到 120 字符；更短的原样返回
            let preview = clip(b.preview.as_deref().unwrap_or_default(), 120)
                .or_else(|| b.preview.clone())
                .unwrap_or_default();
            json!({
                "session_id": b.row.id,
                "title": b.row.title,
                "project": b.row.workspace,
                "preview": preview,
                "events": b.events,
                "last_active": iso(b.row.updated_at),
            })
        })
        .collect();
    let count = results.len();
    Ok((
        json!({
            "mode": "browse",
            "count": count,
            "results": results,
            "message": "Most recently active sessions. Pass a query to search, or session_id to \
                        read one.",
        }),
        WINDOW_CAP,
    ))
}

/// 事件 → 可展示消息（全文不裁，渲染期按预算裁）；无法展示的返回 None
fn msg(ev: &EventRow, anchor: bool) -> Option<Value> {
    let payload: Value = serde_json::from_str(&ev.payload).ok()?;
    let mut m = match ev.type_.as_str() {
        "user.text" => json!({ "role": "user", "text": text_of(&payload)? }),
        "assistant.done" => json!({ "role": "assistant", "text": text_of(&payload)? }),
        "tool.call" => json!({
            "role": "tool",
            "tool": payload.get("tool").and_then(Value::as_str).unwrap_or_default(),
            "args": payload.get("args").and_then(Value::as_str).unwrap_or_default(),
        }),
        _ => return None,
    };
    m["id"] = json!(ev.id);
    if anchor {
        m["anchor"] = json!(true);
    }
    Some(m)
}

fn text_of(payload: &Value) -> Option<String> {
    payload
        .get("text")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn role_of(type_: &str) -> &'static str {
    match type_ {
        "user.text" => "user",
        "assistant.done" => "assistant",
        _ => "tool",
    }
}

/// 事件的纯文本（LIKE 路径切摘录用）
fn plain_text(ev: &EventRow) -> Option<String> {
    let payload: Value = serde_json::from_str(&ev.payload).ok()?;
    Some(match ev.type_.as_str() {
        "tool.call" => format!(
            "{} {}",
            payload
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            payload
                .get("args")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
        _ => text_of(&payload)?,
    })
}

fn project_label(meta: &bbrt_store::SessionMeta) -> String {
    if meta.project_name.is_empty() {
        String::new()
    } else {
        format!("{} ({})", meta.project_name, meta.project_path)
    }
}

/// LIKE 兜底路径的摘录：按最早命中的词在正文上切一段，命中片段用与 SQLite
/// snippet() 相同的标记包起来
fn excerpt(text: &str, terms: &[String], radius: usize) -> String {
    let hit = terms
        .iter()
        .filter_map(|t| find_ci(text, t).map(|at| (at, t.chars().count())))
        .min_by_key(|(at, _)| *at);
    let Some((at, len)) = hit else {
        return clip(text, radius * 2).unwrap_or_else(|| text.to_string());
    };
    let chars: Vec<char> = text.chars().collect();
    let start = at.saturating_sub(radius);
    let end = (at + len + radius).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..at]);
    out.push_str(">>>");
    out.extend(&chars[at..at + len]);
    out.push_str("<<<");
    out.extend(&chars[at + len..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// 子串查找（ASCII 大小写不敏感，其余按字符相等）；返回字符下标
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h: Vec<char> = hay.chars().collect();
    let n: Vec<char> = needle.chars().collect();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| {
        h[i..i + n.len()]
            .iter()
            .zip(&n)
            .all(|(a, b)| a.eq_ignore_ascii_case(b) || a == b)
    })
}

/// 超过 `cap` 个字符则截断并标注；未超返回 None
fn clip(text: &str, cap: usize) -> Option<String> {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(cap).collect();
    chars.next().is_some().then(|| format!("{head}…"))
}

/// 序列化并压进输出预算：先按 `cap` 裁每条消息；仍超预算则字符上限折半重裁
/// （消息全文留在结果树里，裁剪只发生在渲染期）；到下限仍超则从末尾丢会话并提示
fn fit_budget(full: &Value, mut cap: usize) -> String {
    const MSG_KEYS: &[&str] = &["window", "bookend_start", "bookend_end", "head", "tail"];
    let clip_container = |v: &mut Value, cap: usize| {
        for key in MSG_KEYS {
            if let Some(msgs) = v.get_mut(*key).and_then(Value::as_array_mut) {
                for m in msgs {
                    for field in ["text", "args"] {
                        if let Some(text) = m.get(field).and_then(Value::as_str) {
                            if let Some(head) = clip(text, cap) {
                                m[field] = json!(head);
                                m["truncated"] = json!(true);
                            }
                        }
                    }
                }
            }
        }
    };
    let mut dropped = 0usize;
    loop {
        let mut v = full.clone();
        if dropped > 0 {
            if let Some(results) = v.get_mut("results").and_then(Value::as_array_mut) {
                let keep = results.len().saturating_sub(dropped).max(1);
                results.truncate(keep);
                v["count"] = json!(keep);
            }
        }
        clip_container(&mut v, cap);
        if let Some(results) = v.get_mut("results").and_then(Value::as_array_mut) {
            for r in results {
                clip_container(r, cap);
            }
        }
        let text = v.to_string();
        if text.len() <= MAX_BYTES {
            if dropped > 0 {
                v["message"] = json!(format!(
                    "Output budget exceeded: {dropped} further session(s) omitted — narrow the \
                     query or lower limit."
                ));
                return v.to_string();
            }
            return text;
        }
        if cap > MIN_CAP {
            cap /= 2;
        } else if v["results"].as_array().is_some_and(|r| r.len() > 1) {
            dropped += 1;
        } else {
            return text;
        }
    }
}

/// Unix 毫秒 → UTC「YYYY-MM-DDTHH:MMZ」（展示用；无时区库，按 UTC 标注）
fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let tod = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}Z",
        tod / 3600,
        tod % 3600 / 60
    )
}

/// 天数 → 公历日期（Howard Hinnant days_from_civil 的逆运算）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_store() -> (tempfile::TempDir, Arc<Mutex<Store>>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("agent").join("runtime.sqlite3")).unwrap();
        (dir, Arc::new(Mutex::new(store)))
    }

    fn seed(store: &Arc<Mutex<Store>>, id: &str, title: &str) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        lock_store(store)
            .insert_session(&bbrt_store::SessionRow {
                id: id.into(),
                workspace_id: None,
                title: title.into(),
                form: "workbench".into(),
                mode: "ask".into(),
                model_override: None,
                status: "idle".into(),
                share_enabled: false,
                created_at: now,
                updated_at: now,
                ended_at: None,
                summary: None,
                conv_id: None,
            })
            .unwrap();
    }

    fn push(store: &Arc<Mutex<Store>>, sid: &str, kind: &str, payload: Value) -> i64 {
        let s = lock_store(store);
        let seq = s.next_event_seq(sid).unwrap();
        s.append_event(sid, seq, kind, &payload.to_string())
            .unwrap();
        s.events_after(sid, seq - 1, 1).unwrap().remove(0).id
    }

    /// 一轮问答，返回（提问 id, 回复 id）
    fn turn(store: &Arc<Mutex<Store>>, sid: &str, ask: &str, reply: &str) -> (i64, i64) {
        let a = push(store, sid, "user.text", json!({ "text": ask }));
        let b = push(store, sid, "assistant.done", json!({ "text": reply }));
        (a, b)
    }

    fn run(store: &Arc<Mutex<Store>>, current: &str, args: Value) -> Value {
        let out = search(Some(store), current, &args).unwrap();
        assert_eq!(out.exit_code, None, "{}", out.summary);
        serde_json::from_str(&out.summary)
            .unwrap_or_else(|e| panic!("非 JSON（{e}）: {}", out.summary))
    }

    /// 未装配（单测/嵌入式）：降级不阻断
    #[test]
    fn 未装配降级() {
        let out = search(None, "sess-1", &json!({"query": "登录超时"})).unwrap();
        assert_eq!(out.exit_code, Some(1));
        assert!(out.summary.contains("not assembled"));
    }

    /// 工具定义：只读低危；四形态参数面齐备
    #[test]
    fn 定义_只读低危() {
        let def = session_search_def();
        assert_eq!(def.name, "session_search");
        assert_eq!(def.risk, RiskLevel::Low);
        assert_eq!(def.category, bbrt_sec::gate::ActionCategory::ReadOnly);
        for key in [
            "query",
            "limit",
            "sort",
            "scope",
            "session_id",
            "around_event_id",
            "window",
        ] {
            assert!(
                def.input_schema["properties"][key].is_object(),
                "缺少参数 {key}"
            );
        }
        assert!(def.description.contains("SCROLL") && def.description.contains("BROWSE"));
    }

    /// 搜索：命中会话带摘录、锚定窗口与首尾书挡；当前会话与其他会话被排除/去重
    #[test]
    fn 搜索_命中带书挡与窗口() {
        let (_dir, store) = open_store();
        seed(&store, "sess-cur", "当前会话");
        turn(&store, "sess-cur", "登录页的超时怎么改", "当前会话也聊过");
        seed(&store, "sess-other", "无关会话");
        turn(&store, "sess-other", "今天天气", "不错");
        let hit = {
            // 十七轮：命中在第 9 轮，窗口 ±5 盖不到首尾
            seed(&store, "sess-old", "旧会话");
            let mut hit = 0;
            for i in 1..=17 {
                let (a, b) = turn(
                    &store,
                    "sess-old",
                    &format!("问题 {i}"),
                    &format!("回答 {i}"),
                );
                if i == 9 {
                    hit = push(
                        &store,
                        "sess-old",
                        "user.text",
                        json!({"text": "登录页的超时太短"}),
                    );
                }
                let _ = (a, b);
            }
            hit
        };

        let v = run(&store, "sess-cur", json!({"query": "登录页的超时"}));
        assert_eq!(v["mode"], "discover");
        assert_eq!(v["count"], 1);
        let r = &v["results"][0];
        assert_eq!(r["session_id"], "sess-old");
        assert_eq!(r["title"], "旧会话");
        assert_eq!(r["match_event_id"], hit);
        assert!(
            r["snippet"]
                .as_str()
                .unwrap()
                .contains(">>>登录页的超时<<<"),
            "{}",
            r["snippet"]
        );
        assert_eq!(r["matched"], "user");
        let window = r["window"].as_array().unwrap();
        assert_eq!(window.len(), 11, "锚点 + 前后各 5");
        assert!(window[5]["anchor"] == json!(true), "锚点应在窗口正中");
        assert_eq!(window[5]["id"], json!(hit));
        assert!(window.iter().filter(|m| m["anchor"] == json!(true)).count() == 1);
        // 书挡取窗口之外的首尾各 3 条，与窗口不重叠
        let ids = |key: &str| {
            r[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["id"].as_i64().unwrap())
                .collect::<Vec<_>>()
        };
        let (start, w, end) = (ids("bookend_start"), ids("window"), ids("bookend_end"));
        assert_eq!(start.len(), 3);
        assert_eq!(end.len(), 3);
        assert!(start[2] < w[0], "书挡起点应在窗口之前");
        assert!(w[10] < end[0], "书挡终点应在窗口之后");
        assert_eq!(
            (r["events_before"].as_i64(), r["events_after"].as_i64()),
            (Some(18), Some(16))
        );
        assert!(r["last_active"].as_str().unwrap().ends_with('Z'));
    }

    /// 短中文词走 LIKE 兜底：没有 SQLite snippet，摘录按词在正文上切
    #[test]
    fn 搜索_短中文词like路径有摘录() {
        let (_dir, store) = open_store();
        seed(&store, "sess-1", "会话一");
        turn(
            &store,
            "sess-1",
            "帮我看看登录超时的问题",
            "已经把超时改成 30 秒了",
        );
        seed(&store, "sess-cur", "当前");

        let v = run(&store, "sess-cur", json!({"query": "登录"}));
        let r = &v["results"][0];
        assert!(
            r["snippet"].as_str().unwrap().contains(">>>登录<<<"),
            "{}",
            r["snippet"]
        );
    }

    /// 按会话去重 + limit；sort=newest 按时间倒序
    #[test]
    fn 搜索_按会话去重与limit() {
        let (_dir, store) = open_store();
        seed(&store, "sess-cur", "当前");
        for (sid, title) in [("sess-a", "A"), ("sess-b", "B"), ("sess-c", "C")] {
            // 事件落库的 created_at 是毫秒精度：隔开 2ms 保证三个会话的时间可区分
            std::thread::sleep(std::time::Duration::from_millis(2));
            seed(&store, sid, title);
            turn(&store, sid, "deploy 的方案", "两次命中 deploy deploy");
            turn(&store, sid, "再谈 deploy", "好的");
        }
        let order = |sort: Option<&str>, limit: i64| {
            run(
                &store,
                "sess-cur",
                json!({ "query": "deploy", "limit": limit, "sort": sort }),
            )["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["session_id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        let newest = order(Some("newest"), 10);
        assert_eq!(
            newest,
            ["sess-c", "sess-b", "sess-a"],
            "newest=最近活跃的会话在前"
        );
        assert_eq!(order(None, 2).len(), 2, "limit 限制会话数");
    }

    /// 无命中：给出可操作的建议；无关键词：提示换查询
    #[test]
    fn 搜索_无命中与无关键词() {
        let (_dir, store) = open_store();
        seed(&store, "sess-1", "会话一");
        turn(&store, "sess-1", "聊点别的", "好");
        let v = run(&store, "sess-cur", json!({"query": "完全没出现过的话"}));
        assert_eq!(v["count"], 0);
        assert!(v["message"].as_str().unwrap().contains("shorter keywords"));
        let v = run(&store, "sess-cur", json!({"query": "***"}));
        assert!(v["message"]
            .as_str()
            .unwrap()
            .contains("no searchable keywords"));
    }

    /// scope=all 把工具调用纳入搜索与展示；缺省 dialog 不含
    #[test]
    fn 搜索_scope_all含工具调用() {
        let (_dir, store) = open_store();
        seed(&store, "sess-1", "会话一");
        push(
            &store,
            "sess-1",
            "tool.call",
            json!({"call_id": "c1", "tool": "run_command", "args": "{\"command\":\"cargo test 登录超时\"}"}),
        );
        assert_eq!(
            run(&store, "sess-cur", json!({"query": "cargo test"}))["count"],
            0
        );
        let v = run(
            &store,
            "sess-cur",
            json!({"query": "cargo test", "scope": "all"}),
        );
        let r = &v["results"][0];
        assert_eq!(r["matched"], "tool");
        assert_eq!(r["window"][0]["role"], "tool");
        assert_eq!(r["window"][0]["tool"], "run_command");
        assert!(r["window"][0]["args"]
            .as_str()
            .unwrap()
            .contains("cargo test"));
    }

    /// 翻页：锚点居中、两端剩余计数；锚点不在会话内给出错误
    #[test]
    fn 翻页_窗口与锚点() {
        let (_dir, store) = open_store();
        seed(&store, "sess-1", "会话一");
        let mut ids = Vec::new();
        for i in 1..=7 {
            ids.push(push(
                &store,
                "sess-1",
                "user.text",
                json!({ "text": format!("第 {i} 条") }),
            ));
        }
        let v = run(
            &store,
            "sess-1",
            json!({"session_id": "sess-1", "around_event_id": ids[3], "window": 2}),
        );
        assert_eq!(v["mode"], "scroll");
        let w = v["window"].as_array().unwrap();
        assert_eq!(w.len(), 5);
        assert_eq!(w[2]["anchor"], json!(true));
        // 两端计数是总数（不受窗口长度限制）：7 条里锚点居中，前后各 3 条
        assert_eq!(
            (v["events_before"].clone(), v["events_after"].clone()),
            (json!(3), json!(3))
        );
        let v = run(
            &store,
            "sess-1",
            json!({"session_id": "sess-1", "around_event_id": 999_999}),
        );
        assert!(v["error"].as_str().unwrap().contains("is not in session"));
        // window 越界被夹到 [1, 20]
        let v = run(
            &store,
            "sess-1",
            json!({"session_id": "sess-1", "around_event_id": ids[3], "window": 999}),
        );
        assert_eq!(v["window"].as_array().unwrap().len(), 7);
    }

    /// 通读：短会话全取；长会话给首尾与翻页指引；不存在的会话给出错误
    #[test]
    fn 通读_短会话全取与长会话首尾() {
        let (_dir, store) = open_store();
        seed(&store, "sess-short", "短会话");
        turn(&store, "sess-short", "你好", "你好，有什么可以帮你");
        seed(&store, "sess-long", "长会话");
        for i in 1..=40 {
            turn(&store, "sess-long", &format!("问 {i}"), &format!("答 {i}"));
        }

        let v = run(&store, "sess-x", json!({"session_id": "sess-short"}));
        assert_eq!(v["mode"], "read");
        assert_eq!(v["event_count"], 2);
        assert_eq!(v["truncated"], json!(false));
        assert_eq!(v["head"].as_array().unwrap().len(), 2);
        assert!(v["tail"].as_array().unwrap().is_empty());

        let v = run(&store, "sess-x", json!({"session_id": "sess-long"}));
        assert_eq!(v["event_count"], 80);
        assert_eq!(v["truncated"], json!(true));
        assert_eq!(v["head"].as_array().unwrap().len(), 20);
        assert_eq!(v["tail"].as_array().unwrap().len(), 10);
        assert!(v["message"]
            .as_str()
            .unwrap()
            .contains("to read the middle"));

        let v = run(&store, "sess-x", json!({"session_id": "sess-无"}));
        assert!(v["error"].as_str().unwrap().contains("not found"));
    }

    /// 最近会话：跳过当前会话，带首条提问预览与事件数
    #[test]
    fn 最近会话_跳过当前带预览() {
        let (_dir, store) = open_store();
        seed(&store, "sess-1", "会话一");
        turn(&store, "sess-1", "帮我查登录超时", "好的");
        seed(&store, "sess-2", "会话二");
        seed(&store, "sess-cur", "当前");
        turn(&store, "sess-cur", "当前会话的提问", "当前会话的回复");

        let v = run(&store, "sess-cur", json!({}));
        assert_eq!(v["mode"], "browse");
        let ids: Vec<&str> = v["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["session_id"].as_str().unwrap())
            .collect();
        assert!(!ids.contains(&"sess-cur"), "{ids:?}");
        assert_eq!(v["count"], json!(ids.len()));
        let one = v["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["session_id"] == "sess-1")
            .unwrap();
        assert_eq!(one["preview"], "帮我查登录超时");
        assert_eq!(one["events"], 2);
        assert_eq!(one["title"], "会话一");
        // limit 夹到 [1, 30]
        let v = run(&store, "sess-cur", json!({"limit": 1}));
        assert_eq!(v["count"], 1);
    }

    /// 形态推断优先级：带锚点的滚动 > 通读 > 搜索 > 最近会话
    #[test]
    fn 形态推断() {
        let (_dir, store) = open_store();
        seed(&store, "sess-1", "会话一");
        let (a, _) = turn(&store, "sess-1", "提问", "回复");
        assert_eq!(
            run(&store, "x", json!({"session_id": "sess-1"}))["mode"],
            "read"
        );
        assert_eq!(
            run(
                &store,
                "x",
                json!({"session_id": "sess-1", "around_event_id": a})
            )["mode"],
            "scroll"
        );
        assert_eq!(
            run(&store, "x", json!({"query": "提问"}))["mode"],
            "discover"
        );
        assert_eq!(run(&store, "x", json!({}))["mode"], "browse");
    }

    /// 输出预算：超长内容折半裁剪后仍是合法 JSON 且不超上限，并带截断标注
    #[test]
    fn 输出预算_超限裁剪() {
        let (_dir, store) = open_store();
        seed(&store, "sess-1", "大会话");
        let big = "很长的回答内容。".repeat(400); // 约 3200 字符
        for i in 1..=30 {
            turn(&store, "sess-1", &format!("问题 {i}"), &big);
        }
        let out = search(Some(&store), "sess-x", &json!({"session_id": "sess-1"})).unwrap();
        assert!(out.summary.len() <= MAX_BYTES, "{} 字节", out.summary.len());
        let v: Value = serde_json::from_str(&out.summary).expect("裁剪后仍应是合法 JSON");
        let head = v["head"].as_array().unwrap();
        let clipped = head
            .iter()
            .filter(|m| m["truncated"] == json!(true))
            .count();
        // 前 20 条=10 轮问答：10 条长回复被裁，10 条短提问原样
        assert_eq!(clipped, 10, "{clipped}");
        assert!(head
            .iter()
            .all(|m| m["text"].as_str().unwrap().chars().count() <= WINDOW_CAP));
    }

    #[test]
    fn 时间与摘录辅助() {
        assert_eq!(iso(0), "1970-01-01T00:00Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00Z");
        assert_eq!(
            iso(951_782_400_000 + 3_600_000 * 13 + 60_000 * 5),
            "2000-02-29T13:05Z"
        );
        assert_eq!(clip("abcde", 3).as_deref(), Some("abc…"));
        assert_eq!(clip("abc", 3), None);
        assert_eq!(find_ci("Hello 登录 World", "hello"), Some(0));
        assert_eq!(find_ci("Hello 世界", "世界"), Some(6));
        assert_eq!(find_ci("abc", "abcd"), None);
        assert_eq!(
            excerpt("前面的话 登录超时 后面的话", &["登录".to_string()], 2),
            "…话 >>>登录<<<超时…"
        );
    }
}
