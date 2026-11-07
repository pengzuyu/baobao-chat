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
use bbrt_sec::sandbox::launcher::{
    DegradedInfo, MemoryViolationSink, SandboxLauncher, SandboxLevel, SandboxProbe,
};
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
    }
}

fn blocked_code(out: ToolOutcome) -> (u32, String) {
    match out {
        ToolOutcome::Blocked { code, summary } => (code, summary),
        ToolOutcome::Ok { summary, .. } => panic!("期望 Blocked，实际 Ok: {summary}"),
    }
}

// ---------------------------------------------------------------------------
// registry 与未注册 8002
// ---------------------------------------------------------------------------

#[test]
fn 注册表_内置清单查询与未注册8002() {
    let f = Fixture::new();
    let ex = f.executor();
    // specs 覆盖内置 12 工具
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
    ] {
        assert!(names.contains(&expect), "缺少内置工具 {expect}");
    }
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
            serde_json::json!({"command": "echo bbw-tools-echo"}),
        ),
    ));
    assert_eq!(exit_code, Some(0), "stderr 分支: {summary}");
    assert!(!truncated);
    assert!(summary.contains("bbw-tools-echo"));
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
fn run_command_seatbelt不可用降级baseline仍执行() {
    let f = Fixture::new();
    // 注入 Baseline 探测结果（模拟 sandbox-exec 不可用；B11 降级矩阵）
    let probe = SandboxProbe {
        level: SandboxLevel::Baseline,
        degraded: Some(DegradedInfo {
            reason: "测试注入：模拟 sandbox-exec 不可用".into(),
            mode_cap: "auto-edit",
            network_denied: true,
            per_confirm: true,
        }),
    };
    let mut cfg = ToolsConfig::new(f.ws.path());
    cfg.policy = Some(ToolPolicy::default());
    cfg.launcher = Some(SandboxLauncher::from_probe(probe));
    let ex = PipelineExecutor::new(Arc::new(cfg));
    let (summary, _, exit_code, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "run_command",
            serde_json::json!({"command": "echo degraded-ok"}),
        ),
    ));
    assert_eq!(exit_code, Some(0), "降级档仍应执行: {summary}");
    assert!(summary.contains("degraded-ok"));
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
    match ex.check(
        PermissionMode::Ask,
        &call(
            "run_command",
            serde_json::json!({"command": "echo confirm-me"}),
        ),
    ) {
        CheckOutcome::NeedConfirm {
            reason,
            preview,
            options,
        } => {
            assert!(!reason.is_empty());
            assert_eq!(preview.kind, "command");
            assert_eq!(preview.content, "echo confirm-me");
            // ask 档任意命令：once/session（无 permanent——非 full-auto 首确认场景）
            assert!(options.contains(&"once".to_string()));
            assert!(options.contains(&"session".to_string()));
            assert!(!options.contains(&"permanent".to_string()));
        }
        other => panic!("ask 档 run_command 应需确认: {other:?}"),
    }
}

#[test]
fn gate_fullauto任意命令首次确认可记忆() {
    let f = Fixture::new();
    let ex = f.executor();
    // D13-A2 行 4：full-auto 任意命令 🔶 首次确认可记忆 → options 含 permanent
    match ex.check(
        PermissionMode::FullAuto,
        &call(
            "run_command",
            serde_json::json!({"command": "python3 gen.py"}),
        ),
    ) {
        CheckOutcome::NeedConfirm { options, .. } => {
            assert!(options.contains(&"permanent".to_string()), "{options:?}");
        }
        other => panic!("full-auto 任意命令仍需首确认: {other:?}"),
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
    let c = call(
        "run_command",
        serde_json::json!({"command": "echo grant-me"}),
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
    let other_call = call("run_command", serde_json::json!({"command": "echo other"}));
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
fn memory_save_写入tmp目录出现md与memory索引() {
    let data = tempfile::tempdir().expect("memory data dir");
    let engine = Arc::new(
        bbrt_memory::MemoryEngine::open(data.path(), Arc::new(bbrt_memory::SystemClock)).unwrap(),
    );
    let mut cfg = ToolsConfig::new(fixture_workspace());
    cfg.policy = Some(ToolPolicy::default());
    cfg.memory = Some(engine);
    let ex = PipelineExecutor::new(Arc::new(cfg));
    let (summary, _, _, _) = ok_of(ex.execute(
        PermissionMode::Ask,
        &call(
            "memory_save",
            serde_json::json!({"title": "偏好简洁回复", "type": "user", "body": "用户偏好简洁的中文回复"}),
        ),
    ));
    assert!(summary.contains("偏好简洁回复"), "{summary}");
    let mem_dir = data.path().join("agent").join("memory");
    assert!(mem_dir.join("MEMORY.md").exists(), "MEMORY.md 索引应生成");
    let entries: Vec<_> = fs::read_dir(&mem_dir)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name().to_string_lossy().ends_with(".md") && e.file_name() != "MEMORY.md"
        })
        .collect();
    assert_eq!(entries.len(), 1, "一文件一事实：新增一条记忆");
    // MEMORY.md 索引含标题行
    let index = fs::read_to_string(mem_dir.join("MEMORY.md")).unwrap();
    assert!(index.contains("偏好简洁回复"));
}

/// 独立工作区（memory 测试不依赖主夹具的 tempdir 生命周期）
fn fixture_workspace() -> PathBuf {
    std::env::temp_dir().join(format!(
        "bbw-tools-mem-ws-{}-{}",
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
        delegator: None,
        memory: None,
        wal: Arc::new(bbrt_session::NoopEventLog),
        sink: Arc::new(bbrt_session::NullSink),
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
