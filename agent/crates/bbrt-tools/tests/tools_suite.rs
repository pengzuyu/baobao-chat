//! bbrt-tools 集成测试：tempdir 真实执行（沙箱/文件系统/记忆引擎均真跑）。
//!
//! 覆盖面对照任务口径：
//! - registry 注册/查询/未注册 8002；read_file 正常/截断/敏感 8026/越界 8020；
//! - write/edit 白名单内外与 journal 回调；search_files 命中/递归/200 上限；
//! - run_command 真实沙箱 echo/越界写 violation+blocked/Baseline 降级；
//! - gate 集成（ask 确认卡预览、full-auto 任意命令首次确认、只读全档放行）；
//! - record_grant session 记忆命中 / 高危永久拒绝；memory_save 落盘 MEMORY.md；
//! - masking 打码；ToolExecutor trait 对象装配 LoopDeps（编译期断言）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bbrt_sec::gate::{
    Decision, GateCtx, PermissionMode, ToolCall, ToolPolicy, PERM_FULL_AUTO, PERM_RUN_COMMAND,
};
use bbrt_sec::memory::{GrantScope, GrantStore};
use bbrt_sec::sandbox::launcher::{MemoryViolationSink, SandboxLauncher};
use bbrt_session::{CheckOutcome, LoopDeps, ToolExecutor, ToolInvocation, ToolOutcome};
use bbrt_tools::{PipelineExecutor, ToolsConfig};

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 空闲模型桩（LoopDeps 装配用）
struct NopModel;

impl bbrt_aigw::ChatClient for NopModel {
    fn chat(
        &self,
        _req: &bbrt_aigw::ChatRequest,
    ) -> Result<
        Box<dyn Iterator<Item = Result<bbrt_aigw::StreamEvent, bbrt_aigw::AigwError>> + Send>,
        bbrt_aigw::AigwError,
    > {
        Ok(Box::new(std::iter::empty()))
    }
}

/// 测试夹具：工作区 tempdir + 带默认策略的配置 + 内存 violation sink
struct Fixture {
    #[allow(dead_code)] // 保留目录存活
    ws: tempfile::TempDir,
    cfg: Arc<ToolsConfig>,
    sink: Arc<MemoryViolationSink>,
    journal: Arc<Mutex<Vec<String>>>,
}

impl Fixture {
    fn new() -> Self {
        Self::build(None, None)
    }

    /// 通用装配：`store`/`session_workspaces` 为 None 即基础夹具；带会话工作区表时
    /// 日常会话默认工作区指向 tempdir（执行路径不碰真实 HOME）
    fn build(
        store: Option<Arc<Mutex<bbrt_store::Store>>>,
        session_workspaces: Option<bbrt_session::SessionWorkspaces>,
    ) -> Self {
        let ws = tempfile::tempdir().expect("tempdir");
        let sink = Arc::new(MemoryViolationSink::new());
        let journal = Arc::new(Mutex::new(Vec::new()));
        let mut cfg = ToolsConfig::new(ws.path());
        // 显式给出默认策略：走真实矩阵行为（None=策略缺失最严档）
        cfg.policy = Some(ToolPolicy::default());
        cfg.violation_sink = Some(sink.clone());
        let hook_sink = Arc::clone(&journal);
        cfg.journal_hook = Some(Arc::new(move |event: &str| {
            hook_sink.lock().unwrap().push(event.to_string());
        }));
        cfg.store = store;
        if session_workspaces.is_some() {
            cfg.default_workspace = Some(ws.path().join("user-ws"));
        }
        cfg.session_workspaces = session_workspaces;
        Self {
            ws,
            cfg: Arc::new(cfg),
            sink,
            journal,
        }
    }

    fn executor(&self) -> PipelineExecutor {
        PipelineExecutor::new(Arc::clone(&self.cfg))
    }

    fn journal_events(&self) -> Vec<String> {
        self.journal.lock().unwrap().clone()
    }
}

fn call(name: &str, args: serde_json::Value) -> ToolInvocation {
    ToolInvocation {
        call_id: "c1".into(),
        name: name.into(),
        args_json: serde_json::to_string(&args).unwrap(),
        session_id: "sess-test".into(),
    }
}

fn ok_of(out: ToolOutcome) -> (String, bool, Option<i32>, u64) {
    match out {
        ToolOutcome::Ok {
            summary,
            truncated,
            exit_code,
            duration_ms,
        } => (summary, truncated, exit_code, duration_ms),
        ToolOutcome::Blocked { code, summary } => {
            panic!("期望 Ok，实际 Blocked({code}): {summary}")
        }
        // 2a69bd4 新增变体（用户拒绝=流程控制非执行失败）；套件断言面不消费
        ToolOutcome::Rejected { code, summary } => {
            panic!("期望 Ok，实际 Rejected({code}): {summary}")
        }
    }
}

fn blocked_code(out: ToolOutcome) -> (u32, String) {
    match out {
        ToolOutcome::Blocked { code, summary } => (code, summary),
        ToolOutcome::Ok { summary, .. } => panic!("期望 Blocked，实际 Ok: {summary}"),
        ToolOutcome::Rejected { code, summary } => {
            panic!("期望 Blocked，实际 Rejected({code}): {summary}")
        }
    }
}

// ---------------------------------------------------------------------------
// registry 与未注册 8002
// ---------------------------------------------------------------------------

#[test]
fn 注册表_内置清单查询与未注册8002() {
    let f = Fixture::new();
    let ex = f.executor();
    // specs 覆盖内置 12 工具 + D20 ask_user（loop_runner 拦截、仅注册可发现性）
    let specs = ex.tool_specs();
    let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
    for expect in [
        "read_file",
        "list_dir",
        "write_file",
        "edit_file",
        "search_files",
        "run_command",
        "git_status",
        "git_diff",
        "git_commit",
        "git_push",
        "http_fetch",
        "memory_save",
        "ask_user",
    ] {
        assert!(names.contains(&expect), "缺少内置工具 {expect}");
    }
    // ask_user 契约：question/options 必填（执行由 loop_runner 拦截，不经 pipeline）
    let ask = specs.iter().find(|s| s.name == "ask_user").unwrap();
    let required = ask.input_schema["required"].as_array().unwrap();
    assert!(required.iter().any(|v| v == "question"));
    assert!(required.iter().any(|v| v == "options"));
    // 未注册 → check Deny 8002（D11 §6 步骤 1）
    match ex.check(
        PermissionMode::Ask,
        &call("mystery_tool", serde_json::json!({})),
    ) {
        CheckOutcome::Deny { code, message } => {
            assert_eq!(code, 8002);
            assert!(message.contains("未注册"));
        }
        other => panic!("{other:?}"),
    }
    // execute 分发兜底同样 8002
    let (code, _) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call("mystery_tool", serde_json::json!({})),
    ));
    assert_eq!(code, 8002);
}

#[test]
fn check_参数非法json拒绝8002() {
    let f = Fixture::new();
    let ex = f.executor();
    let mut bad = call("run_command", serde_json::json!({}));
    bad.args_json = "{not-json".into();
    match ex.check(PermissionMode::Ask, &bad) {
        CheckOutcome::Deny { code, .. } => assert_eq!(code, 8002),
        other => panic!("{other:?}"),
    }
}

// ---------------------------------------------------------------------------
// read_file / list_dir
// ---------------------------------------------------------------------------

#[test]
fn read_file_正常摘录带行号() {
    let f = Fixture::new();
    fs::write(f.ws.path().join("a.txt"), "alpha\nbeta\ngamma").unwrap();
    let ex = f.executor();
    let (summary, truncated, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("read_file", serde_json::json!({"path": "a.txt"})),
    ));
    assert_eq!(summary, "1 alpha\n2 beta\n3 gamma");
    assert!(!truncated);
    assert_eq!(exit_code, None);
}

#[test]
fn read_file_默认400行截断并可分页() {
    let f = Fixture::new();
    let content = (1..=500)
        .map(|i| format!("line{i}"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(f.ws.path().join("big.txt"), content).unwrap();
    let ex = f.executor();
    // 默认窗口：400 行 + 截断标注（context::excerpt 语义）
    let (summary, truncated, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("read_file", serde_json::json!({"path": "big.txt"})),
    ));
    assert!(truncated);
    assert!(summary.contains("400 line400"));
    assert!(summary.contains("[truncated, offset=1]"));
    // offset=401 续读恰好到 EOF：无标注
    let (summary2, truncated2, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "read_file",
            serde_json::json!({"path": "big.txt", "offset": 401, "limit": 100}),
        ),
    ));
    assert!(!truncated2);
    assert!(summary2.starts_with("401 line401"));
    assert!(summary2.ends_with("500 line500"));
}

#[test]
fn read_file_敏感文件拒读8026() {
    let f = Fixture::new();
    fs::write(f.ws.path().join(".env.local"), "PASSWORD=x\nTOKEN=y").unwrap();
    let ex = f.executor();
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call("read_file", serde_json::json!({"path": ".env.local"})),
    ));
    assert_eq!(code, 8026);
    assert!(msg.contains("敏感"));
    assert!(f.sink.has_code(8026), "violation 应记录 8026");
}

#[test]
fn read_file_工作区外路径8020() {
    let f = Fixture::new();
    let ex = f.executor();
    let (code, _) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call("read_file", serde_json::json!({"path": "/etc/hosts"})),
    ));
    assert_eq!(code, 8020);
    assert!(f.sink.has_code(8020));
}

#[test]
fn list_dir_类型前缀与排序() {
    let f = Fixture::new();
    fs::write(f.ws.path().join("z.txt"), "x").unwrap();
    fs::write(f.ws.path().join("a.txt"), "x").unwrap();
    fs::create_dir(f.ws.path().join("sub")).unwrap();
    let ex = f.executor();
    let (summary, truncated, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("list_dir", serde_json::json!({"path": "."})),
    ));
    assert!(!truncated);
    assert!(summary.contains("f a.txt"));
    assert!(summary.contains("f z.txt"));
    assert!(summary.contains("d sub"));
}

// ---------------------------------------------------------------------------
// write_file / edit_file
// ---------------------------------------------------------------------------

#[test]
fn write_file_白名单内真实写入并记journal事件() {
    let f = Fixture::new();
    let ex = f.executor();
    let target = f.ws.path().join("src").join("new.rs");
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "write_file",
            serde_json::json!({"path": target.to_string_lossy(), "content": "fn main() {}\n"}),
        ),
    ));
    assert!(summary.contains("已写入"));
    assert!(summary.contains("new.rs"));
    // 文件真实落盘（父目录自动创建）
    assert_eq!(fs::read_to_string(&target).unwrap(), "fn main() {}\n");
    // 修改前 journal 回调：file.changed 字符串事件
    let events = f.journal_events();
    assert!(events
        .iter()
        .any(|e| e.contains("file.changed") && e.contains("new.rs")));
}

#[test]
fn write_file_白名单外拒绝8020() {
    let f = Fixture::new();
    let outside = tempfile::tempdir().expect("tempdir outside");
    let ex = f.executor();
    let target = outside.path().join("escape.txt");
    let (code, _) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call(
            "write_file",
            serde_json::json!({"path": target.to_string_lossy(), "content": "x"}),
        ),
    ));
    assert_eq!(code, 8020);
    assert!(!target.exists(), "越界文件不应被写入");
    assert!(f.sink.has_code(8020));
    // journal 不应有事件（未发生修改）
    assert!(f.journal_events().is_empty());
}

#[test]
fn edit_file_首处替换与journal事件() {
    let f = Fixture::new();
    fs::write(f.ws.path().join("cfg.txt"), "aaa bbb aaa").unwrap();
    let ex = f.executor();
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "edit_file",
            serde_json::json!({"path": "cfg.txt", "old": "aaa", "new": "zzz"}),
        ),
    ));
    assert!(summary.contains("已替换 1 处"));
    assert_eq!(
        fs::read_to_string(f.ws.path().join("cfg.txt")).unwrap(),
        "zzz bbb aaa"
    );
    assert!(f.journal_events().iter().any(|e| e.contains("edit_file")));
    // all=true 全量替换（bbb 仅 1 处，与首处替换等价）
    let _ = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "edit_file",
            serde_json::json!({"path": "cfg.txt", "old": "bbb", "new": "ccc", "all": true}),
        ),
    ));
    assert_eq!(
        fs::read_to_string(f.ws.path().join("cfg.txt")).unwrap(),
        "zzz ccc aaa"
    );
}

#[test]
fn edit_file_old未命中不动文件() {
    let f = Fixture::new();
    fs::write(f.ws.path().join("x.txt"), "content").unwrap();
    let ex = f.executor();
    let (code, _) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call(
            "edit_file",
            serde_json::json!({"path": "x.txt", "old": "nope", "new": "y"}),
        ),
    ));
    assert_eq!(code, 8002);
    assert_eq!(
        fs::read_to_string(f.ws.path().join("x.txt")).unwrap(),
        "content"
    );
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

#[test]
fn search_files_内容子串递归命中() {
    let f = Fixture::new();
    fs::create_dir_all(f.ws.path().join("deep").join("deeper")).unwrap();
    fs::write(f.ws.path().join("top.md"), "nothing here").unwrap();
    fs::write(f.ws.path().join("deep").join("m1.rs"), "fn needle() {}\n").unwrap();
    fs::write(
        f.ws.path().join("deep").join("deeper").join("m2.rs"),
        "x\nneedle_found\n",
    )
    .unwrap();
    let ex = f.executor();
    let (summary, truncated, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("search_files", serde_json::json!({"pattern": "needle"})),
    ));
    assert!(!truncated);
    assert!(
        summary.contains("m1.rs:fn needle() {}"),
        "命中行格式: {summary}"
    );
    assert!(summary.contains("m2.rs:needle_found"));
    assert!(!summary.contains("top.md"), "未命中文件不应出现");
}

#[test]
fn search_files_glob文件名匹配() {
    let f = Fixture::new();
    fs::write(f.ws.path().join("main.rs"), "").unwrap();
    fs::write(f.ws.path().join("lib.rs"), "").unwrap();
    fs::write(f.ws.path().join("notes.txt"), "").unwrap();
    let ex = f.executor();
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("search_files", serde_json::json!({"pattern": "*.rs"})),
    ));
    assert!(summary.contains("main.rs"));
    assert!(summary.contains("lib.rs"));
    assert!(!summary.contains("notes.txt"));
}

#[test]
fn search_files_200条上限截断标注() {
    let f = Fixture::new();
    let dir = f.ws.path().join("many");
    fs::create_dir_all(&dir).unwrap();
    for i in 0..250 {
        fs::write(dir.join(format!("hit{i:03}.txt")), "needle").unwrap();
    }
    let ex = f.executor();
    let (summary, truncated, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "search_files",
            serde_json::json!({"pattern": "needle", "path": "many"}),
        ),
    ));
    assert!(truncated, "250 命中 > 200 上限");
    assert!(summary.contains("[truncated, showing 200]"));
    assert_eq!(summary.lines().count(), 201); // 200 行 + 标注行
}

/// 2026-11-23 修「search_files 卡死」回归：命中行超 200 字节且第 200 字节
/// 落在多字节字符中间（现场 panic 原文：'为' bytes 198..201）——旧实现
/// &line[..200] 直接 panic 杀会话循环线程（UI 永久执行中且无法停止），
/// 现回退最近字符边界截断。67 个'为'（201 字节）+needle：截断点=198。
#[test]
fn search_files_多字节截断不panic() {
    let f = Fixture::new();
    fs::write(
        f.ws.path().join("a2a-doc.md"),
        format!("{}needle\n", "为".repeat(67)),
    )
    .unwrap();
    let ex = f.executor();
    // 修复前本调用 panic（测试进程直接失败）
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("search_files", serde_json::json!({"pattern": "needle"})),
    ));
    assert!(summary.contains("a2a-doc.md"), "命中文件应在结果中: {summary}");
    // 展示行按字符边界截到 66 个'为'（198 字节）——不 panic 且不切半字符
    assert!(
        summary.contains(&"为".repeat(66)),
        "截断应落在字符边界: {summary}"
    );
}

// ---------------------------------------------------------------------------
// run_command（真实沙箱）
// ---------------------------------------------------------------------------

#[test]
fn run_command_echo真实沙箱exit0() {
    let f = Fixture::new();
    let ex = f.executor();
    let (summary, truncated, exit_code, duration) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "run_command",
            serde_json::json!({"command": "echo bbc-tools-echo"}),
        ),
    ));
    assert_eq!(exit_code, Some(0), "stderr 分支: {summary}");
    assert!(!truncated);
    assert!(summary.contains("bbc-tools-echo"));
    assert!(duration < 30_000, "沙箱 echo 不应超过 30s");
}

#[test]
fn run_command_工作区内写文件成功() {
    let f = Fixture::new();
    let ex = f.executor();
    let target = f.ws.path().join("out.txt");
    let cmd = format!("echo sandboxed > {}", target.to_string_lossy());
    let (_, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("run_command", serde_json::json!({"command": cmd})),
    ));
    assert_eq!(exit_code, Some(0));
    assert_eq!(fs::read_to_string(&target).unwrap().trim(), "sandboxed");
}

#[test]
fn run_command_越界写命令violation加blocked8020() {
    let f = Fixture::new();
    let outside = tempfile::tempdir().expect("tempdir outside");
    let ex = f.executor();
    let target = outside.path().join("pwn.txt");
    let cmd = format!("touch {}", target.to_string_lossy());
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call("run_command", serde_json::json!({"command": cmd})),
    ));
    assert_eq!(code, 8020);
    assert!(msg.contains("pwn.txt"), "拒绝信息应含命令目标: {msg}");
    assert!(f.sink.has_code(8020), "violation 应记录 8020");
    assert!(!target.exists(), "越界目标不应被创建（预检先行阻断）");
}

#[test]
fn run_command_注入执行器仍执行() {
    let f = Fixture::new();
    // D32 起 launcher 无探测/降级概念（原 from_probe 注入位保留为默认构造对照）
    let mut cfg = ToolsConfig::new(f.ws.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.launcher = Some(SandboxLauncher::new());
    let ex = PipelineExecutor::new(Arc::new(cfg));
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "run_command",
            serde_json::json!({"command": "echo injected-ok"}),
        ),
    ));
    assert_eq!(exit_code, Some(0), "注入执行器仍应执行: {summary}");
    assert!(summary.contains("injected-ok"));
}

#[test]
fn run_command_非零退出码回传() {
    let f = Fixture::new();
    let ex = f.executor();
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("run_command", serde_json::json!({"command": "false"})),
    ));
    assert_eq!(exit_code, Some(1));
    assert!(summary.contains("[exit_code=1]"));
}

// ---------------------------------------------------------------------------
// gate 集成（check 路径）
// ---------------------------------------------------------------------------

#[test]
fn gate_ask档run_command需确认_预览含命令原文() {
    let f = Fixture::new();
    let ex = f.executor();
    // 2026-11-24 只读分类器接入：echo 归只读档全档放行，改用写语义样本
    match ex.check(
        PermissionMode::Ask,
        &call(
            "run_command",
            serde_json::json!({"command": "touch confirm-me.tmp"}),
        ),
    ) {
        CheckOutcome::NeedConfirm {
            reason,
            preview,
            options,
        } => {
            assert!(!reason.is_empty());
            assert_eq!(preview.kind, "command");
            assert_eq!(preview.content, "touch confirm-me.tmp");
            // ask 档任意命令：once/session（无 permanent——非 full-auto 首确认场景）
            assert!(options.contains(&"once".to_string()));
            assert!(options.contains(&"session".to_string()));
            assert!(!options.contains(&"permanent".to_string()));
        }
        other => panic!("ask 档 run_command 应需确认: {other:?}"),
    }
}

#[test]
fn gate_fullauto任意命令直接放行() {
    let f = Fixture::new();
    let ex = f.executor();
    // D32 矩阵修订：full-auto 任意命令 ✅（原「首确认可记忆」随矩阵放行消亡；
    // 词法围栏=precheck_write_targets/PathPolicy）
    match ex.check(
        PermissionMode::FullAuto,
        &call(
            "run_command",
            serde_json::json!({"command": "python3 gen.py"}),
        ),
    ) {
        CheckOutcome::Allow { .. } => {}
        other => panic!("full-auto 任意命令应直接放行: {other:?}"),
    }
}

#[test]
fn gate_只读工具三档全放行matrix() {
    let f = Fixture::new();
    let ex = f.executor();
    for mode in [
        PermissionMode::Ask,
        PermissionMode::AutoEdit,
        PermissionMode::FullAuto,
    ] {
        match ex.check(mode, &call("read_file", serde_json::json!({"path": "a"}))) {
            CheckOutcome::Allow { source } => assert_eq!(source, "matrix"),
            other => panic!("{mode:?} 只读应放行: {other:?}"),
        }
    }
}

#[test]
fn gate_write_file_ask确认且预览为diff() {
    let f = Fixture::new();
    let ex = f.executor();
    match ex.check(
        PermissionMode::Ask,
        &call(
            "write_file",
            serde_json::json!({"path": "a.txt", "content": "hello"}),
        ),
    ) {
        CheckOutcome::NeedConfirm { preview, .. } => {
            assert_eq!(preview.kind, "diff");
            assert!(preview.content.contains("a.txt"));
            assert!(preview.content.contains("hello"));
        }
        other => panic!("ask 档写文件应确认: {other:?}"),
    }
}

#[test]
fn gate_权限点缺失拒绝8002() {
    let f = Fixture::new();
    let mut cfg = ToolsConfig::new(f.ws.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.permission_points.clear(); // 无 run_command 权限点 → 工具隐藏语义
    let ex = PipelineExecutor::new(Arc::new(cfg));
    match ex.check(
        PermissionMode::Ask,
        &call("run_command", serde_json::json!({"command": "echo x"})),
    ) {
        CheckOutcome::Deny { code, .. } => assert_eq!(code, 8002),
        other => panic!("{other:?}"),
    }
}

// ---------------------------------------------------------------------------
// record_grant（三级记忆）
// ---------------------------------------------------------------------------

#[test]
fn record_grant_session级记忆后同调用放行() {
    let f = Fixture::new();
    let ex = f.executor();
    // 2026-11-24 只读分类器接入：echo 归只读档全档放行，改用写语义样本
    let c = call(
        "run_command",
        serde_json::json!({"command": "touch grant-me.tmp"}),
    );
    // ask 档：先确认
    assert!(matches!(
        ex.check(PermissionMode::Ask, &c),
        CheckOutcome::NeedConfirm { .. }
    ));
    // 审批通过（session）→ 落记忆
    ex.record_grant(PermissionMode::Ask, &c, GrantScope::Session)
        .expect("session 授权应可落库");
    // 同调用再 check → Allow{source=memory}
    match ex.check(PermissionMode::Ask, &c) {
        CheckOutcome::Allow { source } => {
            assert!(source.contains("memory"), "source={source}");
            assert!(source.contains("session"));
        }
        other => panic!("记忆命中应放行: {other:?}"),
    }
    // 不同命令不命中
    let other_call = call(
        "run_command",
        serde_json::json!({"command": "touch other.tmp"}),
    );
    assert!(matches!(
        ex.check(PermissionMode::Ask, &other_call),
        CheckOutcome::NeedConfirm { .. }
    ));
}

#[test]
fn record_grant_高危命令永久记忆拒绝() {
    let f = Fixture::new();
    let ex = f.executor();
    // rm -rf 系统路径命中危险规则库 → permanent 拒绝（D13-A5）
    let danger = call(
        "run_command",
        serde_json::json!({"command": "rm -rf /etc/old"}),
    );
    let err = ex
        .record_grant(PermissionMode::FullAuto, &danger, GrantScope::Permanent)
        .unwrap_err();
    assert!(err.contains("永久"), "{err}");
    // 永不全自动工具（git_push）permanent 由 GrantStore 硬名单拒绝
    let push = call("git_push", serde_json::json!({"remote": "origin"}));
    assert!(ex
        .record_grant(PermissionMode::Ask, &push, GrantScope::Permanent)
        .is_err());
    // session 级不受影响
    assert!(ex
        .record_grant(PermissionMode::Ask, &push, GrantScope::Session)
        .is_ok());
}

// ---------------------------------------------------------------------------
// memory_save（W1 写入路径）
// ---------------------------------------------------------------------------

#[test]
fn memory_save_十类直通公共层与四类回落() {
    let data = tempfile::tempdir().expect("memory data dir");
    let engine = Arc::new(
        bbrt_memory::MemoryEngine::open(data.path(), Arc::new(bbrt_memory::SystemClock)).unwrap(),
    );
    let mut cfg = ToolsConfig::new(fixture_workspace());
    cfg.policy = Some(ToolPolicy::default());
    cfg.memory = Some(engine);
    let ex = PipelineExecutor::new(Arc::new(cfg));
    // ① 十类直通：偏好 → USER.md 一行 + journal 落盘
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "memory_save",
            serde_json::json!({"title": "先结论后细节", "type": "偏好", "body": "汇报先给结论"}),
        ),
    ));
    assert!(summary.contains("[偏好]"), "{summary}");
    let global_dir = data.path().join("agent").join("memory").join("global");
    let view = fs::read_to_string(global_dir.join("USER.md")).unwrap();
    assert!(view.contains("[偏好] 先结论后细节"), "{view}");
    assert!(global_dir.join("journal.jsonl").exists(), "journal 应生成");
    // ② 四类兼容：user → 引擎路由公共层（画像回落，不再落用户级文件族）
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "memory_save",
            serde_json::json!({"title": "后端为主", "type": "user", "body": "主语言 Go"}),
        ),
    ));
    assert!(
        summary.contains("画像"),
        "user 类应回落公共层画像：{summary}"
    );
    let view = fs::read_to_string(global_dir.join("USER.md")).unwrap();
    assert!(view.contains("[画像] 后端为主"), "{view}");
    // ③ 非法 type 拒绝（8002）
    let (code, _) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call(
            "memory_save",
            serde_json::json!({"title": "t", "type": "hacker", "body": "b"}),
        ),
    ));
    assert_eq!(code, 8002);
    // ④ D37：status 手工写入拒绝（项目进度台账唯一写入方=会话结束自动合并）
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call(
            "memory_save",
            serde_json::json!({"title": "项目进度台账", "type": "status", "body": "## 已做\n- x"}),
        ),
    ));
    assert_eq!(code, 8002);
    assert!(msg.contains("项目进度台账"), "拒绝文案应说明台账：{msg}");
}

/// 独立工作区（memory 测试不依赖主夹具的 tempdir 生命周期）
fn fixture_workspace() -> PathBuf {
    std::env::temp_dir().join(format!(
        "bbc-tools-mem-ws-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn memory_save_未装配引擎拒绝() {
    let f = Fixture::new(); // cfg.memory = None
    let ex = f.executor();
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call(
            "memory_save",
            serde_json::json!({"title": "t", "body": "b"}),
        ),
    ));
    assert_eq!(code, 8002);
    assert!(msg.contains("未装配"));
}

/// D23/M2：memory_forget（更正第一步）与 memory_read（项目正文拉取+touch）
#[test]
fn memory_forget移除清单与memory_read项目正文() {
    let data = tempfile::tempdir().expect("memory data dir");
    let proj = tempfile::tempdir().expect("proj ws");
    let engine = Arc::new(
        bbrt_memory::MemoryEngine::open(data.path(), Arc::new(bbrt_memory::SystemClock)).unwrap(),
    );
    let mut cfg = ToolsConfig::new(proj.path().to_path_buf());
    cfg.policy = Some(ToolPolicy::default());
    cfg.memory = Some(engine.clone());
    cfg.session_workspaces = Some(ws_registry(proj.path()));
    let ex = PipelineExecutor::new(Arc::new(cfg));

    // 项目会话写一条项目知识（sess-a 已注册工作区）
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_save",
            serde_json::json!({"title": "端口约定", "type": "project", "body": "开发服务固定走 8090"}),
            "sess-a",
        ),
    ));
    // ① memory_read：正文按需拉取（slug=标题 slug 化）
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_read",
            serde_json::json!({"name": "端口约定"}),
            "sess-a",
        ),
    ));
    assert!(summary.contains("8090"), "{summary}");
    // ② 日常会话 memory_read → 8002 引导（公共层已全文注入）
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_read",
            serde_json::json!({"name": "x"}),
            "sess-daily",
        ),
    ));
    assert_eq!(code, 8002);
    assert!(msg.contains("USER.md"), "{msg}");
    // ③ memory_forget：画像改名两步链
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_save",
            serde_json::json!({"title": "用户叫小红", "type": "画像", "body": ""}),
            "sess-a",
        ),
    ));
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_forget",
            serde_json::json!({"type": "画像", "contains": "小红"}),
            "sess-a",
        ),
    ));
    assert!(summary.contains("已移除 1 条"), "{summary}");
    assert!(summary.contains("用户叫小红"), "{summary}");
    let view = fs::read_to_string(data.path().join("agent/memory/global/USER.md")).unwrap();
    assert!(!view.contains("小红"), "更正后视图即净：{view}");
    // ④ 未命中回显
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_forget",
            serde_json::json!({"type": "画像", "contains": "不存在"}),
            "sess-a",
        ),
    ));
    assert!(summary.contains("无匹配"), "{summary}");
    // ⑤ last_used 已被 touch（read 后条目 frontmatter 带 last_used 时间戳）
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_read",
            serde_json::json!({"name": "端口约定"}),
            "sess-a",
        ),
    ));
    let partition = fs::read_dir(data.path().join("agent/memory/projects"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_dir())
        .expect("项目分区应存在");
    let md = fs::read_to_string(partition.join("端口约定.md")).unwrap();
    assert!(
        md.contains("last_used: 2"),
        "touch 应写 last_used 时间戳：{md}"
    );
}

// ---------------------------------------------------------------------------
// masking / git / http
// ---------------------------------------------------------------------------

#[test]
fn masking_输出password被打码() {
    let f = Fixture::new();
    let ex = f.executor();
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "run_command",
            serde_json::json!({"command": "echo password=hunter2secret"}),
        ),
    ));
    assert_eq!(exit_code, Some(0));
    assert!(summary.contains("password=***"), "summary={summary}");
    assert!(!summary.contains("hunter2secret"), "明文密码不得出现在结果");
}

#[test]
fn git_status_经沙箱真实执行() {
    let f = Fixture::new();
    // 测试准备：真实 git init + 未跟踪文件（不经过被测代码）
    let ok = std::process::Command::new("git")
        .arg("init")
        .arg("--quiet")
        .current_dir(f.ws.path())
        .status()
        .expect("git 可用");
    assert!(ok.success(), "git init 失败");
    fs::write(f.ws.path().join("README.md"), "# t\n").unwrap();
    let ex = f.executor();
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("git_status", serde_json::json!({})),
    ));
    assert_eq!(exit_code, Some(0), "git 输出: {summary}");
    assert!(
        summary.contains("?? README.md"),
        "porcelain 输出: {summary}"
    );
    assert!(summary.contains("## "), "分支头行: {summary}");
}

#[test]
fn git_commit与push_v01拒绝8028() {
    let f = Fixture::new();
    let ex = f.executor();
    for (name, args) in [
        ("git_commit", serde_json::json!({"message": "x"})),
        ("git_push", serde_json::json!({})),
    ] {
        let (code, msg) = blocked_code(ex.execute(PermissionMode::Ask, &call(name, args)));
        assert_eq!(code, 8028, "{name}");
        assert!(msg.contains("钥匙串"));
    }
}

#[test]
fn http_fetch_白名单外8025() {
    let f = Fixture::new();
    let mut cfg = ToolsConfig::new(f.ws.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.net_allow_domains = vec!["internal.corp".into()];
    let sink = Arc::new(MemoryViolationSink::new());
    cfg.violation_sink = Some(sink.clone());
    let ex = PipelineExecutor::new(Arc::new(cfg));
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call(
            "http_fetch",
            serde_json::json!({"url": "https://public-evil.io/api"}),
        ),
    ));
    assert_eq!(code, 8025);
    assert!(msg.contains("public-evil.io"));
    assert!(sink.has_code(8025));
}

#[test]
fn http_fetch_白名单内经沙箱curl执行() {
    let f = Fixture::new();
    let mut cfg = ToolsConfig::new(f.ws.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.net_allow_cidrs = vec!["127.0.0.0/8".into()]; // 回环白名单
    let ex = PipelineExecutor::new(Arc::new(cfg));
    // 回环 1 端口无监听：curl exit 7（连接拒绝）——验证真实执行路径且不触外网
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "http_fetch",
            serde_json::json!({"url": "http://127.0.0.1:1/x"}),
        ),
    ));
    assert_eq!(exit_code, Some(7), "期望 curl 连接拒绝: {summary}");
    assert!(summary.contains("[exit_code=7]"));
}

// ---------------------------------------------------------------------------
// trait 对象兼容（LoopDeps 装配编译期断言）
// ---------------------------------------------------------------------------

#[test]
fn tool_executor_trait对象可装配loopdeps() {
    let f = Fixture::new();
    // Arc<dyn ToolExecutor>：session LoopDeps.tools 字段的精确类型
    let executor: Arc<dyn ToolExecutor> = Arc::new(f.executor());
    // 经 trait 对象调用四个契约方法
    let specs = executor.tool_specs();
    assert!(!specs.is_empty());
    match executor.check(
        PermissionMode::Ask,
        &call("read_file", serde_json::json!({"path": "a"})),
    ) {
        CheckOutcome::Allow { source } => assert_eq!(source, "matrix"),
        other => panic!("{other:?}"),
    }
    let _ = executor.execute(
        PermissionMode::Ask,
        &call("read_file", serde_json::json!({"path": "a"})),
    );
    let c = call("run_command", serde_json::json!({"command": "echo trait"}));
    assert!(executor
        .record_grant(PermissionMode::Ask, &c, GrantScope::Session)
        .is_ok());
    // 完整 LoopDeps 装配（编译期类型断言：tools 字段即 Arc<dyn ToolExecutor>）
    let deps = LoopDeps {
        model: Arc::new(NopModel),
        tools: executor,
        memory: None,
        wal: Arc::new(bbrt_session::NoopEventLog),
        sink: Arc::new(bbrt_session::NullSink),
        skills: Arc::new(Mutex::new(bbrt_session::SkillIndex::default())),
        fanout: None,
        experts: None,
        budget: Default::default(),
    };
    let _ = &deps;
}

// ---------------------------------------------------------------------------
// 与 bbrt-sec 门控原语的交叉验证（gate 行为锚定，防止依赖语义漂移）
// ---------------------------------------------------------------------------

#[test]
fn gate_原语行为锚定_决策矩阵与记忆() {
    // 直接调用 sec 的 permission_gate 验证我们依赖的语义假设：
    // 1) 只读全档 Allow；2) 白名单前缀 + full-auto Allow；3) 记忆命中 Allow{Memory}
    let rules = bbrt_sec::DangerRuleSet::builtin();
    let memory = GrantStore::new();
    let policy = ToolPolicy::default();
    let whitelist = vec!["cargo test".to_string()];
    let ctx = GateCtx {
        policy: Some(&policy),
        permission_points: &[PERM_RUN_COMMAND, PERM_FULL_AUTO],
        memory: Some(&memory),
        rules: &rules,
        whitelist_prefixes: &whitelist,
        untrusted: false,
    };
    let args = serde_json::json!({"command": "cargo test --lib"});
    let c = ToolCall {
        tool: "run_command",
        args: &args,
    };
    // full-auto + 白名单命令 → Allow（A2 行 3）
    assert!(matches!(
        bbrt_sec::gate::permission_gate(PermissionMode::FullAuto, &c, &ctx),
        Decision::Allow { .. }
    ));
    // ask 档同命令 → Confirm
    assert!(matches!(
        bbrt_sec::gate::permission_gate(PermissionMode::Ask, &c, &ctx),
        Decision::Confirm { .. }
    ));
}

// ---------------------------------------------------------------------------
// 杂项：extra_writable 例外目录（ToolsConfig 契约）
// ---------------------------------------------------------------------------

#[test]
fn write_file_例外可写目录放行() {
    let f = Fixture::new();
    let extra = tempfile::tempdir().expect("extra writable");
    let mut cfg = ToolsConfig::new(f.ws.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.extra_writable = vec![extra.path().to_path_buf()];
    let ex = PipelineExecutor::new(Arc::new(cfg));
    let target: &Path = &extra.path().join("cache.txt");
    let (_, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "write_file",
            serde_json::json!({"path": target.to_string_lossy(), "content": "ok"}),
        ),
    ));
    assert_eq!(fs::read_to_string(target).unwrap(), "ok");
}

/// MCP 工具分派（D11 §2.10 dispatch_by_source）：装配空 client → 发现 0 工具、
/// mcp.* 执行走 McpClient 转发分支（未连接 server → 8002 标灰语义）。
#[test]
fn mcp_dispatch_degrades_to_8002() {
    let (client, _) = bbrt_mcp::McpClient::connect(&[], bbrt_mcp::no_token());
    let ex = PipelineExecutor::new(ToolsConfig {
        mcp: Some(std::sync::Arc::new(client)),
        ..ToolsConfig::new(std::path::Path::new("."))
    });
    assert!(
        !ex.registry().names().iter().any(|n| n.starts_with("mcp.")),
        "空连接表不应注册 mcp 工具"
    );
    let c = ToolInvocation {
        call_id: "c1".into(),
        name: "mcp.fake.echo".into(),
        args_json: "{}".into(),
        session_id: "s".into(),
    };
    match ex.execute(bbrt_sec::gate::PermissionMode::Ask, &c) {
        ToolOutcome::Blocked { code, .. } => assert_eq!(code, 8002),
        other => panic!("未连接 server 的 mcp 调用应 8002 拒绝: {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// D19 按会话路由沙箱（项目隔离 + 日常拒绝 + memory 分级）
// ---------------------------------------------------------------------------

fn call_in(name: &str, args: serde_json::Value, session: &str) -> ToolInvocation {
    ToolInvocation {
        call_id: "c-d19".into(),
        name: name.into(),
        args_json: serde_json::to_string(&args).unwrap(),
        session_id: session.into(),
    }
}

/// 会话表装配（sess-a→项目A、sess-daily→日常）
fn ws_registry(a: &Path) -> bbrt_session::SessionWorkspaces {
    let reg = bbrt_session::SessionWorkspaces::new();
    reg.set("sess-a", Some(a.to_path_buf()));
    reg.set("sess-daily", None);
    reg
}

/// A 项目会话写 A 目录成功；写 B 项目目录被 8020 拦（预检）且不落盘。
#[test]
fn d19_项目会话沙箱根只认本项目() {
    let proj_a = tempfile::tempdir().expect("proj a");
    let proj_b = tempfile::tempdir().expect("proj b");
    let sink = Arc::new(MemoryViolationSink::new());
    let mut cfg = ToolsConfig::new(proj_a.path()); // 兜底根=A（真实装配=sidecar cwd）
    cfg.policy = Some(ToolPolicy::default());
    cfg.violation_sink = Some(sink.clone());
    cfg.session_workspaces = Some(ws_registry(proj_a.path()));
    let ex = PipelineExecutor::new(Arc::new(cfg));

    // A 内写：成功
    let inside = proj_a.path().join("src/main.rs");
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "write_file",
            serde_json::json!({
                "path": inside.to_string_lossy(), "content": "fn main() {}"
            }),
            "sess-a",
        ),
    ));
    assert!(inside.exists(), "A 内写应成功");

    // B 内写：8020 + 不落盘 + violation
    let outside = proj_b.path().join("pwn.txt");
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "write_file",
            serde_json::json!({
                "path": outside.to_string_lossy(), "content": "x"
            }),
            "sess-a",
        ),
    ));
    assert_eq!(code, 8020);
    assert!(!outside.exists(), "B 项目目录不应被写入");
    assert!(
        msg.contains("8020") || msg.contains("越界") || msg.contains("白名单"),
        "{msg}"
    );
}

/// 日常会话（无目录）：2026-11-12 ZCode 式口径修订——workspace 类工具挂
/// 默认用户工作区（cfg.default_workspace 注入 tmp 免写真实 HOME）：区内可用、
/// 越界仍 8020 双拦（原「整体拒绝」废除）。
#[test]
fn d19_日常会话默认用户工作区可用且越界仍拒() {
    let ws = tempfile::tempdir().expect("ws");
    let daily = tempfile::tempdir().expect("daily");
    let sink = Arc::new(MemoryViolationSink::new());
    let mut cfg = ToolsConfig::new(ws.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.violation_sink = Some(sink.clone());
    cfg.session_workspaces = Some(ws_registry(ws.path()));
    cfg.default_workspace = Some(daily.path().to_path_buf());
    let ex = PipelineExecutor::new(Arc::new(cfg));

    // 区内写 + 读：应成功（沙箱根=默认用户工作区）
    let inside = daily.path().join("note.md");
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "write_file",
            serde_json::json!({
                "path": inside.to_string_lossy(), "content": "hi daily"
            }),
            "sess-daily",
        ),
    ));
    assert!(inside.exists(), "默认工作区内写应成功");

    // 区内命令：cwd=默认工作区（产物落区内验证）
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "run_command",
            serde_json::json!({"command": "touch cwd-probe.txt"}),
            "sess-daily",
        ),
    ));
    assert!(
        daily.path().join("cwd-probe.txt").exists(),
        "命令 cwd 应=默认用户工作区"
    );

    // 越界（兜底根外）：8020 + 不落盘 + violation
    let outside = ws.path().join("escape.txt");
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "write_file",
            serde_json::json!({
                "path": outside.to_string_lossy(), "content": "x"
            }),
            "sess-daily",
        ),
    ));
    assert_eq!(code, 8020, "越界应 8020");
    assert!(!outside.exists(), "越界路径不应被写入");
    assert!(
        msg.contains("8020") || msg.contains("越界") || msg.contains("白名单"),
        "{msg}"
    );
    assert!(sink.has_code(8020), "violation 应记录越界拦截");
}

/// memory_save 分级：项目会话 project 类落项目分区、user 类落用户级；
/// 日常会话一律用户级。
#[test]
fn d19_memory_save按会话作用域分级() {
    let data = tempfile::tempdir().expect("memory data");
    let proj = tempfile::tempdir().expect("proj");
    let engine = Arc::new(
        bbrt_memory::MemoryEngine::open(data.path(), Arc::new(bbrt_memory::SystemClock)).unwrap(),
    );
    let mut cfg = ToolsConfig::new(proj.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.memory = Some(engine.clone());
    cfg.session_workspaces = Some(ws_registry(proj.path()));
    let ex = PipelineExecutor::new(Arc::new(cfg));

    // 项目会话：project 类 → 项目分区
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_save",
            serde_json::json!({
                "title": "构建端口 8090", "type": "project", "body": "服务端口固定 8090"
            }),
            "sess-a",
        ),
    ));
    // 项目会话：user 类 → 用户级
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_save",
            serde_json::json!({
                "title": "偏好中文", "type": "user", "body": "回答用中文"
            }),
            "sess-a",
        ),
    ));
    // 日常会话：project 类回落用户级
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "memory_save",
            serde_json::json!({
                "title": "临时事实", "type": "project", "body": "日常会话记录的事实"
            }),
            "sess-daily",
        ),
    ));

    let proj_titles: Vec<String> = engine
        .list_scoped(Some(proj.path()))
        .iter()
        .map(|m| m.title.clone())
        .collect();
    assert_eq!(
        proj_titles,
        ["构建端口 8090"],
        "项目分区应只有 project 类条目"
    );
    let mut user_titles: Vec<String> = engine
        .list_scoped(None)
        .iter()
        .map(|m| m.title.clone())
        .collect();
    user_titles.sort();
    assert_eq!(
        user_titles,
        ["临时事实：日常会话记录的事实", "偏好中文：回答用中文"],
        "公共层=user 类与日常回落的 project 类（D23：文本=标题：首行，均画像档）"
    );
}

/// run_command 的 cwd 同样受会话沙箱根约束（A 会话 cd B → 8020）。
#[test]
fn d19_项目会话cwd越界8020() {
    let proj_a = tempfile::tempdir().expect("a");
    let proj_b = tempfile::tempdir().expect("b");
    let mut cfg = ToolsConfig::new(proj_a.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.session_workspaces = Some(ws_registry(proj_a.path()));
    let ex = PipelineExecutor::new(Arc::new(cfg));
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "run_command",
            serde_json::json!({
                "command": "echo x > escape.txt",
                "cwd": proj_b.path().join("sub").to_string_lossy()
            }),
            "sess-a",
        ),
    ));
    assert_eq!(code, 8020);
    assert!(msg.contains("cwd"), "应指明 cwd 越界: {msg}");
}

// ---------------------------------------------------------------------------
// AGENTS.md 白名单装配（缺口修复 2026-11-24：v0.1 通道恒空从未接上）
// ---------------------------------------------------------------------------

/// 项目会话 AGENTS.md `bbc-whitelist` 块生效：cargo test 命中白名单档
/// （risk=low、ask 确认卡 reason=白名单通道）；复合形态仍被守卫拦回任意命令档；
/// 未登记会话不误命中
#[test]
fn agents_md_whitelist_resolves_per_session_workspace() {
    let proj = tempfile::tempdir().expect("proj");
    let daily = tempfile::tempdir().expect("daily");
    fs::write(
        proj.path().join("AGENTS.md"),
        "# 项目约定\n\n```bbc-whitelist\ncargo test\ngo build ./...\n```\n",
    )
    .expect("写 AGENTS.md");
    let mut cfg = ToolsConfig::new(proj.path());
    cfg.policy = Some(ToolPolicy::default());
    let reg = bbrt_session::SessionWorkspaces::new();
    reg.set("sess-a", Some(proj.path().to_path_buf()));
    reg.set("sess-daily", None);
    cfg.session_workspaces = Some(reg);
    cfg.default_workspace = Some(daily.path().to_path_buf()); // 隔离真实 HOME
    let ex = PipelineExecutor::new(Arc::new(cfg));

    // ① 项目会话：白名单命中 → WhitelistCommand（risk=low）
    let c = call_in("run_command", serde_json::json!({"command": "cargo test --lib"}), "sess-a");
    assert_eq!(ex.risk_of_call(&c), "low", "白名单命中应为 low");
    // ask 档确认卡走白名单通道（区别于任意命令文案）
    match ex.check(PermissionMode::Ask, &c) {
        CheckOutcome::NeedConfirm { reason, .. } => {
            assert!(reason.contains("白名单"), "应走白名单通道: {reason}")
        }
        other => panic!("ask 档白名单命令应确认: {other:?}"),
    }
    // ② 复合形态守卫：前缀命中但 && 落任意命令档（risk=medium）
    let compound = call_in(
        "run_command",
        serde_json::json!({"command": "cargo test && ls /"}),
        "sess-a",
    );
    assert_eq!(ex.risk_of_call(&compound), "medium", "复合形态应守卫回任意命令");
    // ③ 只读命令不依赖白名单（P1 分类器优先）：ls 仍 low
    let ls = call_in("run_command", serde_json::json!({"command": "ls -la"}), "sess-a");
    assert_eq!(ex.risk_of_call(&ls), "low", "只读分类器应先行");
    // ④ 日常会话无 AGENTS.md：cargo test 不误命中（任意命令档）
    let daily_call = call_in(
        "run_command",
        serde_json::json!({"command": "cargo test --lib"}),
        "sess-daily",
    );
    assert_eq!(ex.risk_of_call(&daily_call), "medium", "日常会话不应命中项目白名单");
}

/// AGENTS.md 编辑后（mtime 变化）会话内即时生效：新增条目马上命中
#[test]
fn agents_md_whitelist_reloads_on_change() {
    let proj = tempfile::tempdir().expect("proj");
    fs::write(
        proj.path().join("AGENTS.md"),
        "```bbc-whitelist\ncargo test\n```\n",
    )
    .expect("初版");
    let mut cfg = ToolsConfig::new(proj.path());
    cfg.policy = Some(ToolPolicy::default());
    let reg = bbrt_session::SessionWorkspaces::new();
    reg.set("sess-a", Some(proj.path().to_path_buf()));
    cfg.session_workspaces = Some(reg);
    let ex = PipelineExecutor::new(Arc::new(cfg));
    let go = call_in("run_command", serde_json::json!({"command": "go vet ./..."}), "sess-a");
    assert_eq!(ex.risk_of_call(&go), "medium", "未声明前不应命中");
    // mtime 粒度秒级——确保 mtime 变化再重写（有的文件系统 mtime 精度 1s）
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(
        proj.path().join("AGENTS.md"),
        "```bbc-whitelist\ncargo test\ngo vet\n```\n",
    )
    .expect("追加 go vet");
    assert_eq!(ex.risk_of_call(&go), "low", "编辑 AGENTS.md 后应即时生效");
}

// ---------------------------------------------------------------------------
// 任务感知工作台：list_projects / use_project / session_search
// ---------------------------------------------------------------------------

/// 工作台夹具：执行器 + Runtime 本地库 + 会话工作区表（库的临时目录保活到测试结束；
/// 日常会话 sess-test 已登记）
struct StoreFixture {
    f: Fixture,
    #[allow(dead_code)] // 保留库目录存活
    dir: tempfile::TempDir,
    store: Arc<Mutex<bbrt_store::Store>>,
}

impl StoreFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("store dir");
        let store = Arc::new(Mutex::new(
            bbrt_store::Store::open(&dir.path().join("runtime.sqlite3")).expect("store"),
        ));
        let reg = bbrt_session::SessionWorkspaces::new();
        reg.set("sess-test", None);
        let f = Fixture::build(Some(Arc::clone(&store)), Some(reg));
        Self { f, dir, store }
    }

    fn executor(&self) -> PipelineExecutor {
        self.f.executor()
    }

    /// 日常会话的默认用户工作区（Fixture::build 指到 tempdir）
    fn user_ws(&self) -> PathBuf {
        self.f.ws.path().join("user-ws")
    }
}

/// 落一行未绑定项目的会话
fn seed_session(store: &Arc<Mutex<bbrt_store::Store>>, id: &str, form: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    store
        .lock()
        .unwrap()
        .insert_session(&bbrt_store::SessionRow {
            id: id.into(),
            workspace_id: None,
            title: format!("会话{id}"),
            form: form.into(),
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

/// 在 `root` 下建目录并登记为工作台项目，返回真实路径
fn register_project(store: &Arc<Mutex<bbrt_store::Store>>, root: &Path, name: &str) -> PathBuf {
    fs::create_dir_all(root.join(name)).unwrap();
    let real = fs::canonicalize(root.join(name)).unwrap();
    store
        .lock()
        .unwrap()
        .upsert_workspace(&bbrt_store::Workspace {
            id: format!("ws-{name}"),
            path: real.to_string_lossy().into_owned(),
            name: name.into(),
            is_repo: false,
            trusted: true,
            extra_dirs: None,
            last_opened_at: 1_000,
            created_at: 1_000,
        })
        .unwrap();
    real
}

/// 往会话追加一条文本事件，返回事件 id
fn append_event(store: &Arc<Mutex<bbrt_store::Store>>, sid: &str, kind: &str, text: &str) -> i64 {
    let payload = serde_json::json!({ "text": text }).to_string();
    let s = store.lock().unwrap();
    let seq = s.next_event_seq(sid).unwrap();
    s.append_event(sid, seq, kind, &payload).unwrap();
    s.events_after(sid, seq - 1, 1).unwrap().remove(0).id
}

/// 未装配本地库（单测/嵌入式）：三工具降级不阻断
#[test]
fn 工作台工具_未装配降级() {
    let f = Fixture::new();
    let ex = f.executor();
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("list_projects", serde_json::json!({})),
    ));
    assert_eq!(exit_code, Some(1));
    assert!(summary.contains("not assembled"), "{summary}");
    let (_, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("use_project", serde_json::json!({"path": "/x"})),
    ));
    assert_eq!(exit_code, Some(1));
    let (_, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("session_search", serde_json::json!({"query": "登录超时"})),
    ));
    assert_eq!(exit_code, Some(1));
}

/// list_projects 经管线执行：登记项目逐项可见；只读工具三档全放行
#[test]
fn list_projects_管线执行与只读放行() {
    let sf = StoreFixture::new();
    let proj = register_project(&sf.store, sf.f.ws.path(), "proj-a");
    let ex = sf.executor();
    for mode in [
        PermissionMode::Ask,
        PermissionMode::AutoEdit,
        PermissionMode::FullAuto,
    ] {
        match ex.check(mode, &call("list_projects", serde_json::json!({}))) {
            CheckOutcome::Allow { .. } => {}
            other => panic!("{other:?}"),
        }
    }
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("list_projects", serde_json::json!({})),
    ));
    assert_eq!(exit_code, None);
    assert!(
        summary.contains(&format!("proj-a — {} (not a git repo;", proj.display())),
        "{summary}"
    );
}

/// use_project 采纳后：相对路径写入落在项目目录（而非用户工作区），用户工作区暂不可写；
/// 切回后相对路径回到用户工作区
#[test]
fn use_project_采纳后文件工具落项目目录() {
    let sf = StoreFixture::new();
    seed_session(&sf.store, "sess-test", "workbench");
    let proj = register_project(&sf.store, sf.f.ws.path(), "proj-a");
    let ex = sf.executor();
    let path = proj.to_string_lossy().into_owned();

    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call("use_project", serde_json::json!({"path": path})),
    ));
    assert!(summary.contains("switched to project"), "{summary}");
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "write_file",
            serde_json::json!({"path": "notes.txt", "content": "hello\n"}),
        ),
    ));
    assert_eq!(
        fs::read_to_string(proj.join("notes.txt")).unwrap(),
        "hello\n"
    );
    assert!(!sf.user_ws().join("notes.txt").exists(), "不应落用户工作区");

    // 采纳期间根=项目目录：用户工作区越界 8020（与项目会话一致）
    let outside = sf.user_ws().join("x.txt");
    let (code, _) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call(
            "write_file",
            serde_json::json!({"path": outside.to_string_lossy().as_ref(), "content": "x"}),
        ),
    ));
    assert_eq!(code, 8020);

    ok_of(ex.execute(
        PermissionMode::Ask,
        &call("use_project", serde_json::json!({})),
    ));
    ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "write_file",
            serde_json::json!({"path": "back.txt", "content": "b\n"}),
        ),
    ));
    assert_eq!(
        fs::read_to_string(sf.user_ws().join("back.txt")).unwrap(),
        "b\n"
    );
}

/// 范围校验经管线：聊天唤起会话（embedded）与项目会话均拒绝 8006，登记表不变
#[test]
fn use_project_聊天会话与项目会话拒绝() {
    let sf = StoreFixture::new();
    seed_session(&sf.store, "sess-test", "embedded");
    seed_session(&sf.store, "sess-proj", "workbench");
    let proj = register_project(&sf.store, sf.f.ws.path(), "proj-a");
    let path = proj.to_string_lossy().into_owned();
    {
        let s = sf.store.lock().unwrap();
        let wid = s.get_workspace_by_path(&path).unwrap().unwrap().id;
        s.set_session_workspace("sess-proj", Some(&wid)).unwrap();
    }
    let ex = sf.executor();

    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call("use_project", serde_json::json!({"path": path})),
    ));
    assert_eq!(code, 8006);
    assert!(msg.contains("chat-invoked"), "{msg}");

    // 未登记路径：8002 且列出可用项目
    seed_session(&sf.store, "sess-task", "workbench");
    let (code, msg) = blocked_code(ex.execute(
        PermissionMode::Ask,
        &call_in(
            "use_project",
            serde_json::json!({"path": "/not/registered"}),
            "sess-task",
        ),
    ));
    assert_eq!(code, 8002);
    assert!(msg.contains(&path), "{msg}");
}

/// session_search 经管线：搜索命中其他会话并带命中点上下文，默认排除当前会话；
/// 通读与翻页按参数组合推断，显式指定会话不受排除限制；只读工具三档全放行
#[test]
fn session_search_管线搜索翻页通读() {
    let sf = StoreFixture::new();
    seed_session(&sf.store, "sess-old", "workbench");
    seed_session(&sf.store, "sess-test", "workbench");
    let hit = append_event(&sf.store, "sess-old", "user.text", "登录页的超时时间太短了");
    append_event(
        &sf.store,
        "sess-old",
        "assistant.done",
        "已把登录页的超时改成 30 秒",
    );
    append_event(
        &sf.store,
        "sess-test",
        "user.text",
        "当前会话也提到登录页的超时",
    );
    let ex = sf.executor();

    for mode in [
        PermissionMode::Ask,
        PermissionMode::AutoEdit,
        PermissionMode::FullAuto,
    ] {
        let c = call(
            "session_search",
            serde_json::json!({"query": "登录页的超时"}),
        );
        match ex.check(mode, &c) {
            CheckOutcome::Allow { .. } => {}
            other => panic!("{other:?}"),
        }
    }
    let run = |args: serde_json::Value| -> serde_json::Value {
        let (summary, _, exit_code, _) =
            ok_of(ex.execute(PermissionMode::Ask, &call("session_search", args)));
        assert_eq!(exit_code, None, "{summary}");
        serde_json::from_str(&summary).expect("结果应为 JSON")
    };

    // 搜索：当前会话虽命中但被排除
    let v = run(serde_json::json!({"query": "登录页的超时", "limit": 5}));
    assert_eq!(v["mode"], "discover");
    let results = v["results"].as_array().unwrap();
    assert_eq!(results.len(), 1, "{v}");
    assert_eq!(results[0]["session_id"], "sess-old");
    let snippet = results[0]["snippet"].as_str().unwrap();
    assert!(snippet.contains(">>>登录页的超时<<<"), "{snippet}");
    let window = results[0]["window"].as_array().unwrap();
    assert_eq!(window[0]["anchor"], serde_json::json!(true));
    assert_eq!(window[1]["text"], "已把登录页的超时改成 30 秒");

    // 通读：显式指定的会话不受排除限制
    let v = run(serde_json::json!({"session_id": "sess-test"}));
    assert_eq!(v["mode"], "read");
    assert_eq!(v["event_count"], 1);

    // 翻页：锚点前无内容、后有一条
    let v = run(serde_json::json!({"session_id": "sess-old", "around_event_id": hit}));
    assert_eq!(v["mode"], "scroll");
    assert_eq!(v["events_before"], 0);
    assert_eq!(v["events_after"], 1);
}

// ---------------------------------------------------------------------------
// 读审批化（2026-11-26）：工作区外读需审批 / 敏感红卡 / full-auto 放行 / 附件自动授权
// ---------------------------------------------------------------------------

/// 带会话表夹具（sess-daily=日常会话 → 默认用户工作区=ws/user-ws；执行层
/// session_env 注入读授权句柄）
fn read_approval_fixture() -> (Fixture, PipelineExecutor, tempfile::TempDir) {
    let ws = tempfile::tempdir().expect("ws");
    let reg = {
        let r = bbrt_session::SessionWorkspaces::new();
        r.set("sess-a", Some(ws.path().to_path_buf()));
        r.set("sess-daily", None);
        r
    };
    let f = Fixture::build(None, Some(reg));
    let ex = f.executor();
    (f, ex, ws)
}

#[test]
fn 读审批_ask档工作区外弹卡_批准once后放行且票据一次性() {
    let (_f, ex, ws) = read_approval_fixture();
    let outside = tempfile::tempdir().expect("outside");
    let f = outside.path().join("note.txt");
    fs::write(&f, "secret-ish").unwrap();

    // check：门控矩阵放行（ReadOnly）后追加读判定 → 弹卡
    let c = call_in(
        "read_file",
        serde_json::json!({"path": f.to_string_lossy()}),
        "sess-daily",
    );
    match ex.check(PermissionMode::Ask, &c) {
        CheckOutcome::NeedConfirm {
            reason,
            preview,
            options,
        } => {
            assert!(reason.contains("工作区外"), "{reason}");
            assert_eq!(preview.kind, "read");
            assert_eq!(preview.content, {
                bbrt_sec::sandbox::path::read_realpath(&f)
                    .to_string_lossy()
                    .into_owned()
            });
            assert_eq!(options, vec!["once".to_string(), "session".to_string()]);
        }
        other => panic!("期望 NeedConfirm，实际 {other:?}"),
    }
    // 执行层无票据：拒绝
    let (code, msg) = blocked_code(ex.execute(PermissionMode::Ask, &c));
    assert_eq!(code, bbrt_sec::errors::CODE_SANDBOX_DENIED, "{msg}");
    // 审批通过（once）→ 放行
    ex.record_grant(PermissionMode::Ask, &c, GrantScope::Once)
        .unwrap();
    let (summary, ..) = ok_of(ex.execute(PermissionMode::Ask, &c));
    assert!(summary.contains("secret-ish"), "{summary}");
    // once 票据已消费 → 再读拒绝
    blocked_code(ex.execute(PermissionMode::Ask, &c));
    let _ = ws;
}

#[test]
fn 读审批_敏感文件红卡仅once_风险标high_session票据无效() {
    let (_f, ex, _ws) = read_approval_fixture();
    let outside = tempfile::tempdir().expect("outside");
    let secret = outside.path().join("id_rsa_test");
    fs::write(&secret, "PRIVATE KEY").unwrap();
    let c = call_in(
        "read_file",
        serde_json::json!({"path": secret.to_string_lossy()}),
        "sess-daily",
    );
    assert_eq!(ex.risk_of_call(&c), "high", "敏感读应标 high（红卡）");
    match ex.check(PermissionMode::Ask, &c) {
        CheckOutcome::NeedConfirm {
            preview, options, ..
        } => {
            assert_eq!(preview.kind, "read-sensitive");
            assert_eq!(options, vec!["once".to_string()], "敏感仅本次");
        }
        other => panic!("期望 NeedConfirm，实际 {other:?}"),
    }
    // 敏感文件的「会话」授权被降级为精确票据（record_grant 内 sensitive→once）：
    // 同目录另一敏感文件不得连带放行
    let secret2 = outside.path().join(".env.local");
    fs::write(&secret2, "PASSWORD=x").unwrap();
    let c2 = call_in(
        "read_file",
        serde_json::json!({"path": secret2.to_string_lossy()}),
        "sess-daily",
    );
    ex.record_grant(PermissionMode::Ask, &c, GrantScope::Session)
        .unwrap();
    let (s, ..) = ok_of(ex.execute(PermissionMode::Ask, &c));
    assert!(!s.is_empty());
    blocked_code(ex.execute(PermissionMode::Ask, &c2));
    // 目录树授权对敏感文件无效：先给 note 的 session 授权，敏感文件仍拦
    let note = outside.path().join("note.txt");
    fs::write(&note, "x").unwrap();
    let cn = call_in(
        "read_file",
        serde_json::json!({"path": note.to_string_lossy()}),
        "sess-daily",
    );
    ex.record_grant(PermissionMode::Ask, &cn, GrantScope::Session)
        .unwrap();
    blocked_code(ex.execute(PermissionMode::Ask, &c2));
}

#[test]
fn 读审批_fullauto工作区外自动放行_session档目录树放行() {
    let (_f, ex, _ws) = read_approval_fixture();
    let outside = tempfile::tempdir().expect("outside");
    let f1 = outside.path().join("a.txt");
    let f2 = outside.path().join("b.txt");
    fs::write(&f1, "AAA").unwrap();
    fs::write(&f2, "BBB").unwrap();
    let c1 = call_in(
        "read_file",
        serde_json::json!({"path": f1.to_string_lossy()}),
        "sess-daily",
    );
    // full-auto：check 直接放行、execute 不需要票据
    assert!(matches!(
        ex.check(PermissionMode::FullAuto, &c1),
        CheckOutcome::Allow { .. }
    ));
    ok_of(ex.execute(PermissionMode::FullAuto, &c1));
    // ask 档弹卡批准「本会话」（目录树）→ 同目录其它文件免再批
    let c2 = call_in(
        "read_file",
        serde_json::json!({"path": f2.to_string_lossy()}),
        "sess-daily",
    );
    assert!(matches!(
        ex.check(PermissionMode::Ask, &c2),
        CheckOutcome::NeedConfirm { .. }
    ));
    ex.record_grant(PermissionMode::Ask, &c2, GrantScope::Session)
        .unwrap();
    let (s2, ..) = ok_of(ex.execute(PermissionMode::Ask, &c2));
    assert!(s2.contains("BBB"), "{s2}");
    let (s1, ..) = ok_of(ex.execute(PermissionMode::Ask, &c1));
    assert!(s1.contains("AAA"), "{s1}");
}

#[test]
fn 读审批_附件自动授权_用户亲自给的敏感文件也放行() {
    let (_f, ex, _ws) = read_approval_fixture();
    let outside = tempfile::tempdir().expect("outside");
    let plain = outside.path().join("report.pdf");
    let secret = outside.path().join(".env.local");
    fs::write(&plain, "PDF").unwrap();
    fs::write(&secret, "PASSWORD=x").unwrap();
    let atts = vec![
        bbrt_context::AttachmentRef {
            path: plain.to_string_lossy().into_owned(),
            kind: bbrt_context::AttachmentKind::File,
            name: "report.pdf".into(),
            size: 3,
            mime: None,
        },
        bbrt_context::AttachmentRef {
            path: secret.to_string_lossy().into_owned(),
            kind: bbrt_context::AttachmentKind::File,
            name: ".env.local".into(),
            size: 10,
            mime: None,
        },
    ];
    ex.register_attachments("sess-daily", &atts);
    let cp = call_in(
        "read_file",
        serde_json::json!({"path": plain.to_string_lossy()}),
        "sess-daily",
    );
    let cs = call_in(
        "read_file",
        serde_json::json!({"path": secret.to_string_lossy()}),
        "sess-daily",
    );
    // 附带文件（含敏感）ask 档直接放行——用户亲自给的
    assert!(matches!(
        ex.check(PermissionMode::Ask, &cp),
        CheckOutcome::Allow { .. }
    ));
    assert!(matches!(
        ex.check(PermissionMode::Ask, &cs),
        CheckOutcome::Allow { .. }
    ));
    ok_of(ex.execute(PermissionMode::Ask, &cs));
    ok_of(ex.execute(PermissionMode::Ask, &cp));
    // 未附带的工作区外文件照旧弹卡
    let other = outside.path().join("other.txt");
    fs::write(&other, "x").unwrap();
    let co = call_in(
        "read_file",
        serde_json::json!({"path": other.to_string_lossy()}),
        "sess-daily",
    );
    assert!(matches!(
        ex.check(PermissionMode::Ask, &co),
        CheckOutcome::NeedConfirm { .. }
    ));
}

#[test]
fn 读审批_波浪号路径展开后正确判定() {
    let (_f, ex, _ws) = read_approval_fixture();
    // ~/ 不存在的工作区外路径：ask 弹卡（read_realpath 尽力解析不 panic）
    let c = call_in(
        "read_file",
        serde_json::json!({"path": "~/bbc-nonexistent-probe.txt"}),
        "sess-daily",
    );
    assert!(matches!(
        ex.check(PermissionMode::Ask, &c),
        CheckOutcome::NeedConfirm { .. }
    ));
}
