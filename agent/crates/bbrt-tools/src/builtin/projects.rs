//! 项目工具（任务感知工作台）：agent 感知「工作台登记了哪些项目」，并能把其中
//! 一个采纳为本会话的工作根。
//!
//! 背景（2026-11-25 真机反馈）：任务会话问「我有几个开发的项目」只在用户工作区里
//! 找——项目登记表（agent_workspace，本机 SQLite）此前只有宿主协议 workspace.list
//! 能查，工具面拿不到；任务会话的写权限又只覆盖用户工作区，没法直接改项目代码。
//!
//! - list_projects：只读清单（名称/路径/是否 git/会话数/最近打开）
//! - use_project：把已登记项目采纳为会话工作根——改的是会话工作区登记表
//!   （SessionWorkspaces），下个工具调用起 pipeline 的 session_env 自动路由到项目
//!   目录（文件/命令/git/AGENTS.md 白名单/记忆分区全部跟随，复用 D19 机制）；
//!   不带 path 调用切回用户工作区。采纳是会话内运行时状态，不写库。
//!
//! 可用范围：只对「未绑定项目的任务会话」开放——项目会话保持 D19 的项目隔离
//! （A 项目会话不改 B 项目），IM 唤起的 embedded 会话不开放（聊天上下文含他人消息）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use bbrt_sec::errors::CODE_TOOL_DISABLED;
use bbrt_session::SessionWorkspaces;
use bbrt_store::Store;

use super::{degraded_output, deny, lock_store, ok_output, str_arg, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 工具参数/装配错误码（14 篇：8002）
const CODE_TOOL_ARGS: u32 = 8002;

pub fn list_projects_def() -> ToolDef {
    ToolDef {
        name: "list_projects".into(),
        description: "List the projects registered in your workbench: name, path, whether it is \
                      a git repository, session count and last opened time. Use when the user \
                      asks what projects they have or are working on. To read or modify files \
                      inside one of them from a task session, call use_project with its path"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {}
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

pub fn use_project_def() -> ToolDef {
    ToolDef {
        name: "use_project".into(),
        description: "Switch the working root of this task session to a project registered in \
                      the workbench (call list_projects first to get exact paths). After a \
                      successful call, file tools, commands and git operate inside that project \
                      and writes there are allowed; memory saves go to that project's partition. \
                      Only projects the user has already opened in the workbench can be adopted. \
                      Call it again without path to return to the default user workspace. Not \
                      available in project-bound or chat-invoked sessions"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path of a registered project as returned by \
                                    list_projects; omit to return to the user workspace"
                }
            }
        }),
        risk: RiskLevel::Low,
        category: bbrt_sec::gate::ActionCategory::ReadOnly,
    }
}

/// 毫秒时间差 → 粗略相对时间（清单展示用）
fn ago(ms: i64) -> String {
    let ms = ms.max(0);
    let (mins, hours, days) = (ms / 60_000, ms / 3_600_000, ms / 86_400_000);
    if mins < 1 {
        "just now".into()
    } else if mins < 60 {
        format!("{mins}m ago")
    } else if hours < 24 {
        format!("{hours}h ago")
    } else {
        format!("{days}d ago")
    }
}

/// list_projects 实现：登记表实时查询（非快照）+ 各项目会话数。
pub(crate) fn list(
    store: Option<&Arc<Mutex<Store>>>,
    _args: &serde_json::Value,
) -> Result<ExecOutput, ToolBlock> {
    let Some(store) = store else {
        return Ok(degraded_output(
            "Project listing is unavailable: the local session store is not assembled.",
        ));
    };
    let fetched = {
        let store = lock_store(store);
        store
            .list_workspaces()
            .and_then(|projects| Ok((projects, store.count_sessions_by_workspace()?)))
    };
    let (projects, counts) = match fetched {
        Ok(v) => v,
        Err(e) => return Ok(degraded_output(format!("Project listing failed: {e}"))),
    };
    if projects.is_empty() {
        return Ok(ok_output(
            "No projects registered yet (open a folder in the workbench to add one).",
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let mut lines = vec![format!("Projects: {}", projects.len())];
    for p in &projects {
        let sessions = counts
            .iter()
            .find(|(id, _)| *id == p.id)
            .map(|(_, n)| *n)
            .unwrap_or(0);
        lines.push(format!(
            "- {} — {} ({}; {} session{}; last opened {})",
            p.name,
            p.path,
            if p.is_repo {
                "git repo"
            } else {
                "not a git repo"
            },
            sessions,
            if sessions == 1 { "" } else { "s" },
            ago(now.saturating_sub(p.last_opened_at))
        ));
    }
    lines.push("To work inside one of them, call use_project with its path.".into());
    Ok(ok_output(lines.join("\n")))
}

/// use_project 实现：校验通过后改会话工作区登记表（不写库）。
pub(crate) fn use_project(
    store: Option<&Arc<Mutex<Store>>>,
    registry: Option<&SessionWorkspaces>,
    session_id: &str,
    args: &serde_json::Value,
) -> Result<ExecOutput, ToolBlock> {
    let (Some(store), Some(registry)) = (store, registry) else {
        return Ok(degraded_output(
            "Project switching is unavailable: the local session store is not assembled.",
        ));
    };
    // 范围校验：只对「出生时未绑定项目」的会话开放。以库行为准——采纳不写库，
    // 所以采纳后的会话仍可切回用户工作区或换项目（登记表此时与项目会话同形，
    // 不能作为判据）；会话行不在库（嵌入式 runner）时才退回登记表判定
    let row = {
        let store = lock_store(store);
        store.get_session(session_id)
    };
    let row = match row {
        Ok(row) => row,
        Err(e) => return Ok(degraded_output(format!("Project switching failed: {e}"))),
    };
    match row {
        Some(row) if row.workspace_id.is_some() => {
            return Err(deny(
                CODE_TOOL_DISABLED,
                "use_project is only for task sessions; this session is bound to a project \
                 (project sessions stay isolated from each other)",
            ));
        }
        Some(row) if row.form == "embedded" => {
            return Err(deny(
                CODE_TOOL_DISABLED,
                "use_project is not available in chat-invoked sessions; open a task session in \
                 the workbench to modify project files",
            ));
        }
        Some(_) => {}
        None => match registry.get(session_id) {
            Some(None) => {}
            Some(Some(_)) => {
                return Err(deny(
                    CODE_TOOL_DISABLED,
                    "use_project is only for task sessions; this session is bound to a project",
                ));
            }
            None => {
                return Err(deny(
                    CODE_TOOL_DISABLED,
                    "use_project is unavailable: this session has no workspace routing",
                ));
            }
        },
    }
    let Some(path) = str_arg(args, "path") else {
        registry.set(session_id, None);
        return Ok(ok_output(
            "Working root switched back to the default user workspace.",
        ));
    };
    // 路径校验：只认工作台已登记的目录（agent 不能自授权写任意目录）
    let real = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let found = {
        let store = lock_store(store);
        store.get_workspace_by_path(&real.to_string_lossy())
    };
    let ws = match found {
        Ok(Some(ws)) => ws,
        Ok(None) => {
            let registered = lock_store(store)
                .list_workspaces()
                .map(|all| all.into_iter().map(|w| w.path).collect::<Vec<_>>())
                .unwrap_or_default();
            return Err(deny(
                CODE_TOOL_ARGS,
                format!(
                    "use_project: {path} is not a project registered in the workbench. Registered \
                     projects: [{}]. Only projects the user has opened in the workbench can be \
                     adopted",
                    registered.join(", ")
                ),
            ));
        }
        Err(e) => return Ok(degraded_output(format!("Project switching failed: {e}"))),
    };
    // 目录已被移动/删除时不采纳：session_env 首用会 create_dir_all，凭空重建一个空目录
    if !Path::new(&ws.path).is_dir() {
        return Err(deny(
            CODE_TOOL_ARGS,
            format!(
                "use_project: the directory of project \"{}\" no longer exists: {} (moved or \
                 deleted?)",
                ws.name, ws.path
            ),
        ));
    }
    registry.set(session_id, Some(PathBuf::from(&ws.path)));
    Ok(ok_output(format!(
        "Working root switched to project \"{}\" ({}). From now on file tools, commands and git \
         operate inside this project — paths resolve there and writing elsewhere is rejected; \
         memory saves go to this project's partition. Call use_project again without path to \
         return to the default user workspace.",
        ws.name, ws.path
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_store() -> (tempfile::TempDir, Arc<Mutex<Store>>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("agent").join("runtime.sqlite3")).unwrap();
        (dir, Arc::new(Mutex::new(store)))
    }

    fn seed_session(store: &Arc<Mutex<Store>>, id: &str, form: &str) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        lock_store(store)
            .insert_session(&bbrt_store::SessionRow {
                id: id.into(),
                workspace_id: None,
                title: "测试会话".into(),
                form: form.into(),
                mode: "ask".into(),
                model_policy: "auto".into(),
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

    /// 在 `root` 下登记一个项目，返回其真实路径
    fn register(store: &Arc<Mutex<Store>>, root: &Path, id: &str) -> PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let real = std::fs::canonicalize(&dir).unwrap();
        lock_store(store)
            .upsert_workspace(&bbrt_store::Workspace {
                id: id.into(),
                path: real.to_string_lossy().into_owned(),
                name: format!("项目{id}"),
                is_repo: false,
                trusted: true,
                extra_dirs: None,
                last_opened_at: 1_000,
                created_at: 1_000,
            })
            .unwrap();
        real
    }

    fn blocked_code(out: Result<ExecOutput, ToolBlock>) -> (u32, String) {
        match out {
            Ok(o) => panic!("期望阻断，实际 Ok: {}", o.summary),
            Err(b) => (b.code, b.message),
        }
    }

    /// 未装配（单测/嵌入式）：降级不阻断
    #[test]
    fn list_未装配降级() {
        let out = list(None, &json!({})).unwrap();
        assert_eq!(out.exit_code, Some(1));
        assert!(out.summary.contains("not assembled"));
        let out = use_project(None, None, "sess-1", &json!({"path": "/x"})).unwrap();
        assert_eq!(out.exit_code, Some(1));
    }

    /// 空登记表：明确提示尚无项目
    #[test]
    fn list_空清单() {
        let (_dir, store) = open_store();
        let out = list(Some(&store), &json!({})).unwrap();
        assert_eq!(out.exit_code, None);
        assert!(out.summary.contains("No projects registered"));
    }

    /// 清单逐项带路径、git 标记、会话数与最近打开
    #[test]
    fn list_含会话数与最近打开() {
        let (dir, store) = open_store();
        let a = register(&store, dir.path(), "ws-a");
        let _b = register(&store, dir.path(), "ws-b");
        seed_session(&store, "sess-1", "workbench");
        seed_session(&store, "sess-2", "workbench");
        {
            let s = lock_store(&store);
            let sid = s
                .get_workspace_by_path(a.to_string_lossy().as_ref())
                .unwrap()
                .unwrap()
                .id;
            s.set_session_workspace("sess-1", Some(&sid)).unwrap();
            s.set_session_workspace("sess-2", Some(&sid)).unwrap();
        }

        let out = list(Some(&store), &json!({})).unwrap();
        let text = out.summary;
        assert!(text.starts_with("Projects: 2"), "{text}");
        assert!(
            text.contains(&format!(
                "- 项目ws-a — {} (not a git repo; 2 sessions; last opened",
                a.display()
            )),
            "{text}"
        );
        assert!(
            text.contains("(not a git repo; 0 sessions; last opened"),
            "{text}"
        );
        assert!(text.ends_with("call use_project with its path."), "{text}");
    }

    /// 任务会话采纳已登记项目：登记表变为该项目真实路径
    #[test]
    fn use_采纳后登记表变更() {
        let (dir, store) = open_store();
        let real = register(&store, dir.path(), "ws-a");
        seed_session(&store, "sess-1", "workbench");
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", None);

        // 传带尾斜杠的路径也能对上（先 canonicalize 再查）
        let arg = format!("{}/", real.display());
        let out = use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": arg}),
        )
        .unwrap();
        assert_eq!(out.exit_code, None);
        assert!(
            out.summary.contains("switched to project \"项目ws-a\""),
            "{}",
            out.summary
        );
        assert_eq!(registry.get("sess-1"), Some(Some(real)));
    }

    /// 未登记路径：拒绝并列出可用路径；登记表不变
    #[test]
    fn use_未登记路径拒绝() {
        let (dir, store) = open_store();
        let real = register(&store, dir.path(), "ws-a");
        seed_session(&store, "sess-1", "workbench");
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", None);

        let (code, msg) = blocked_code(use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": "/not/registered"}),
        ));
        assert_eq!(code, CODE_TOOL_ARGS);
        assert!(msg.contains("is not a project registered"), "{msg}");
        assert!(msg.contains(real.to_string_lossy().as_ref()), "{msg}");
        assert_eq!(registry.get("sess-1"), Some(None));
    }

    /// 不带 path：切回用户工作区（采纳后的会话登记表与项目会话同形，仍可切回）
    #[test]
    fn use_不带path切回() {
        let (dir, store) = open_store();
        let real = register(&store, dir.path(), "ws-a");
        seed_session(&store, "sess-1", "workbench");
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", None);
        let path = real.to_string_lossy();
        use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": path.as_ref()}),
        )
        .unwrap();
        assert_eq!(registry.get("sess-1"), Some(Some(real)));

        let out = use_project(Some(&store), Some(&registry), "sess-1", &json!({})).unwrap();
        assert!(out.summary.contains("default user workspace"));
        assert_eq!(registry.get("sess-1"), Some(None));
    }

    /// 采纳后可换到另一个已登记项目
    #[test]
    fn use_采纳后可换项目() {
        let (dir, store) = open_store();
        let a = register(&store, dir.path(), "ws-a");
        let b = register(&store, dir.path(), "ws-b");
        seed_session(&store, "sess-1", "workbench");
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", None);
        use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": a.to_string_lossy().as_ref()}),
        )
        .unwrap();
        use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": b.to_string_lossy().as_ref()}),
        )
        .unwrap();
        assert_eq!(registry.get("sess-1"), Some(Some(b)));
    }

    /// 项目会话（库行 workspace_id 非空）：保持 D19 项目隔离，拒绝切换
    #[test]
    fn use_项目会话拒绝() {
        let (dir, store) = open_store();
        let real = register(&store, dir.path(), "ws-a");
        seed_session(&store, "sess-1", "workbench");
        let wid = lock_store(&store)
            .get_workspace_by_path(real.to_string_lossy().as_ref())
            .unwrap()
            .unwrap()
            .id;
        lock_store(&store)
            .set_session_workspace("sess-1", Some(&wid))
            .unwrap();
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", Some(real.clone()));

        let (code, msg) = blocked_code(use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": real.to_string_lossy().as_ref()}),
        ));
        assert_eq!(code, CODE_TOOL_DISABLED);
        assert!(msg.contains("bound to a project"), "{msg}");
        assert_eq!(registry.get("sess-1"), Some(Some(real)));
    }

    /// 会话行不在库（嵌入式 runner）：退回登记表判定，项目会话同样拒绝
    #[test]
    fn use_会话不在库_按登记表拒绝() {
        let (dir, store) = open_store();
        let real = register(&store, dir.path(), "ws-a");
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", Some(real.clone()));
        let (code, _) = blocked_code(use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": real.to_string_lossy().as_ref()}),
        ));
        assert_eq!(code, CODE_TOOL_DISABLED);
        registry.remove("sess-1");
        let (code, _) = blocked_code(use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": real.to_string_lossy().as_ref()}),
        ));
        assert_eq!(code, CODE_TOOL_DISABLED);
    }

    /// IM 唤起的 embedded 会话：不开放
    #[test]
    fn use_embedded会话拒绝() {
        let (dir, store) = open_store();
        let real = register(&store, dir.path(), "ws-a");
        seed_session(&store, "sess-1", "embedded");
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", None);

        let (code, msg) = blocked_code(use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": real.to_string_lossy().as_ref()}),
        ));
        assert_eq!(code, CODE_TOOL_DISABLED);
        assert!(msg.contains("chat-invoked"), "{msg}");
        assert_eq!(registry.get("sess-1"), Some(None));
    }

    /// 已登记但目录已不存在：拒绝（不凭空重建空目录）
    #[test]
    fn use_目录已不存在拒绝() {
        let (dir, store) = open_store();
        let gone = dir.path().join("gone");
        let real = register(&store, &gone, "ws-a");
        std::fs::remove_dir_all(&gone).unwrap();
        seed_session(&store, "sess-1", "workbench");
        let registry = SessionWorkspaces::new();
        registry.set("sess-1", None);

        let (code, msg) = blocked_code(use_project(
            Some(&store),
            Some(&registry),
            "sess-1",
            &json!({"path": real.to_string_lossy().as_ref()}),
        ));
        assert_eq!(code, CODE_TOOL_ARGS);
        assert!(msg.contains("no longer exists"), "{msg}");
        assert!(!real.exists());
        assert_eq!(registry.get("sess-1"), Some(None));
    }

    /// 工具定义：只读低危，注册名与参数面
    #[test]
    fn 定义_只读低危() {
        for (def, name) in [
            (list_projects_def(), "list_projects"),
            (use_project_def(), "use_project"),
        ] {
            assert_eq!(def.name, name);
            assert_eq!(def.risk, RiskLevel::Low);
            assert_eq!(def.category, bbrt_sec::gate::ActionCategory::ReadOnly);
        }
        assert!(use_project_def().input_schema["properties"]["path"].is_object());
    }

    #[test]
    fn 相对时间() {
        assert_eq!(ago(999), "just now");
        assert_eq!(ago(5 * 60_000), "5m ago");
        assert_eq!(ago(3 * 3_600_000), "3h ago");
        assert_eq!(ago(40 * 86_400_000), "40d ago");
        assert_eq!(ago(-5), "just now");
    }
}
