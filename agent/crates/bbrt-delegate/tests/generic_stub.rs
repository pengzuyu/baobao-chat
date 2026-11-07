//! 通用 CLI 适配器 × sh 桩脚本集成测试（任务书要求的 fake 后端 `##BBW:EVT:` 行协议场景）。
//!
//! 场景表（全部真实跑子进程）：
//! | 场景 | 桩脚本 | 断言要点 |
//! |---|---|---|
//! | 版本探测成功 | version.sh | detect installed + 1.4.2 + probe_health ok |
//! | 版本探测失败 | version-fail.sh | detect 未安装 + 降级 NotInstalled（8030 语义） |
//! | 流式事件行逐条归一化 | stream.sh | Meta/Delta/ToolUse(风险)/ToolResult/Exit + finalize |
//! | send_input 追加指令 | stream.sh | 回显 output 事件 "got: ..." |
//! | 非零退出码 | exit7.sh | Exit{7} + finalize exit.abnormal（8033 语义） |
//! | graceful cancel | hang.sh（trap INT→exit） | SIGINT 后退出，未升级强杀 |
//! | 强杀升级 | hard.sh（trap '' INT） | 3s 宽限 → SIGKILL（信号 9） |
//! | ask 模式拒绝 | 任意 | 17 §5.2：通用后端仅 auto-edit+ |
//! | 工作区锁互斥 | — | 二次获取 8035 |
//! | trait 对象形态 | stream.sh | Arc<dyn CodingBackend> 全链路可用 |

mod common;

use bbrt_delegate::{
    render, CodingBackend, DelegateError, GenericCliBackend, HealthIssue, LaunchOpts,
    NormalizedEvent,
};
use bbrt_protocol::{PermissionMode, RiskLevel, StreamChannel};
use common::{assert_brief_lines, sample_brief, write_script, TestDir};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 排空 stdin 前 9 行（read 逐行消费不越界；head 对管道可能超读，故用 read 循环）
const DRAIN: &str =
    "i=0\nwhile [ \"$i\" -lt 9 ]; do\n  IFS= read -r _b || break\n  i=$((i+1))\ndone\n";

/// 组装桩脚本体：shebang + 排空简报 + 后续逻辑
fn with_drain(rest: &str) -> String {
    format!("#!/bin/sh\n{DRAIN}{rest}")
}

#[test]
fn version_probe_success_via_stub() {
    let dir = TestDir::new("verok");
    let stub = write_script(
        dir.path(),
        "backend.sh",
        "#!/bin/sh\ncase \"$1\" in --version) echo 'stub-generic 1.4.2';; esac\nexit 0\n",
    );
    let backend = GenericCliBackend::new(stub);
    let probe = backend.detect();
    assert_eq!(probe.backend_id, "generic");
    assert!(probe.installed);
    assert_eq!(probe.version.as_deref(), Some("1.4.2"));
    assert!(probe.capabilities.contains(&"line-protocol".to_string()));
    let health = backend.probe_health();
    assert!(health.ok && health.degraded.is_none());
}

#[test]
fn version_probe_failure_marks_not_installed() {
    let dir = TestDir::new("verbad");
    // --version 非零退出 → 未安装（8030 语义）
    let stub = write_script(
        dir.path(),
        "bad.sh",
        "#!/bin/sh\ncase \"$1\" in --version) echo boom >&2; exit 3;; esac\nexit 0\n",
    );
    let backend = GenericCliBackend::new(stub);
    assert!(!backend.detect().installed);
    assert_eq!(
        backend.probe_health().degraded,
        Some(HealthIssue::NotInstalled)
    );
}

/// 流式桩：排空 9 行简报 → meta/纯文本/tool_use/tool_result → 等 stdin 一行 → 回显 → exit 0
fn stream_stub(dir: &TestDir) -> String {
    write_script(
        dir.path(),
        "stream.sh",
        &with_drain(concat!(
            "printf '%s\\n' '##BBW:EVT:{\"kind\":\"meta\",\"text\":\"session start\",\"session_ref\":\"g-77\"}'\n",
            "printf '%s\\n' 'plain working text'\n",
            "printf '%s\\n' '##BBW:EVT:{\"kind\":\"tool_use\",\"call_id\":\"t1\",\"tool\":\"Edit\",\"args\":{\"file_path\":\"src/a.rs\"}}'\n",
            "printf '%s\\n' '##BBW:EVT:{\"kind\":\"tool_result\",\"call_id\":\"t1\",\"ok\":true,\"summary\":\"+3 -1\"}'\n",
            "IFS= read -r extra\n",
            "printf '##BBW:EVT:{\"kind\":\"output\",\"text\":\"got: %s\"}\\n' \"$extra\"\n",
            "exit 0\n",
        )),
    )
}

#[test]
fn stream_lines_normalize_one_by_one_and_finalize() {
    let dir = TestDir::new("stream");
    let stub = stream_stub(&dir);
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    assert_brief_lines(&brief);
    let opts = LaunchOpts::new("d-101", "sess-1", PermissionMode::AutoEdit, &ws);
    let backend = GenericCliBackend::new(stub);
    let session = backend.launch(&brief, &opts).unwrap();
    assert_eq!(session.backend_id(), "generic");
    assert_eq!(session.delegate_task_id(), "d-101");
    assert!(session.pgid() > 1);

    let next = || backend.stream_events(&session).unwrap().unwrap();
    // meta（含续接句柄）
    assert_eq!(
        next(),
        NormalizedEvent::Meta {
            text: "session start".into(),
            session_ref: Some("g-77".into())
        }
    );
    // 纯文本行 → delta（17 §3.2 通用行文本包装）
    assert_eq!(
        next(),
        NormalizedEvent::Delta {
            channel: StreamChannel::Text,
            text: "plain working text".into()
        }
    );
    // tool_use：Edit → Medium 风险（normalize 映射）
    assert_eq!(
        next(),
        NormalizedEvent::ToolUse {
            call_id: "t1".into(),
            tool: "Edit".into(),
            args: serde_json::json!({"file_path": "src/a.rs"}),
            risk: RiskLevel::Medium,
        }
    );
    // tool_result
    assert_eq!(
        next(),
        NormalizedEvent::ToolResult {
            call_id: "t1".into(),
            ok: true,
            summary: "+3 -1".into()
        }
    );
    // send_input 响应（模式 C 续接基础）
    backend.send_input(&session, "extra-input").unwrap();
    assert_eq!(
        next(),
        NormalizedEvent::Delta {
            channel: StreamChannel::Text,
            text: "got: extra-input".into()
        }
    );
    // 正常退出 → Exit 事件，随后流终止
    assert_eq!(
        next(),
        NormalizedEvent::Exit {
            exit_code: Some(0),
            signal: None
        }
    );
    assert!(backend.stream_events(&session).unwrap().is_none());

    let report = backend.finalize(&session).unwrap();
    assert!(report.exit.ok());
    assert_eq!(report.changed_files, vec!["src/a.rs".to_string()]);
    assert_eq!(report.session_ref.as_deref(), Some("g-77"));
    assert!(report.summary.contains("plain working text"));
    assert!(report.summary.contains("got: extra-input"));
}

#[test]
fn send_input_can_come_before_events_drained() {
    // send_input 在事件未消费时先行写入（管道缓冲），桩阻塞读 stdin 前已可读到
    let dir = TestDir::new("earlyinput");
    let stub = stream_stub(&dir);
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let opts = LaunchOpts::new("d-106", "sess-6", PermissionMode::AutoEdit, &ws);
    let backend = GenericCliBackend::new(stub);
    let session = backend.launch(&brief, &opts).unwrap();
    backend.send_input(&session, "early-line").unwrap();
    let mut kinds = Vec::new();
    while let Some(ev) = backend.stream_events(&session).unwrap() {
        kinds.push(ev);
    }
    // 全序列：meta/delta/tool_use/tool_result/output(got: early-line)/exit
    assert_eq!(kinds.len(), 6);
    assert!(
        matches!(kinds[4], NormalizedEvent::Delta { ref text, .. } if text == "got: early-line")
    );
    assert!(matches!(
        kinds[5],
        NormalizedEvent::Exit {
            exit_code: Some(0),
            ..
        }
    ));
    assert!(backend.finalize(&session).unwrap().exit.ok());
}

#[test]
fn nonzero_exit_code_surfaces_in_exit_event_and_finalize() {
    let dir = TestDir::new("exit7");
    let stub = write_script(
        dir.path(),
        "exit7.sh",
        "#!/bin/sh\nIFS= read -r _b\nprintf '%s\\n' 'plain then fail'\nexit 7\n",
    );
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let opts = LaunchOpts::new("d-102", "sess-2", PermissionMode::AutoEdit, &ws);
    let backend = GenericCliBackend::new(stub);
    let session = backend.launch(&brief, &opts).unwrap();

    let delta = backend.stream_events(&session).unwrap().unwrap();
    assert!(matches!(delta, NormalizedEvent::Delta { .. }));
    let exit = backend.stream_events(&session).unwrap().unwrap();
    assert_eq!(
        exit,
        NormalizedEvent::Exit {
            exit_code: Some(7),
            signal: None
        }
    );
    let report = backend.finalize(&session).unwrap();
    assert_eq!(report.exit.exit_code, Some(7));
    assert!(
        report.exit.abnormal(),
        "非零退出应判定异常退出（上层映射 8033）"
    );
}

#[test]
fn graceful_cancel_sigint_exits_cleanly_without_escalation() {
    let dir = TestDir::new("gcancel");
    let stub = write_script(
        dir.path(),
        "hang.sh",
        &with_drain(concat!(
            "trap 'exit 0' INT\n",
            "printf '%s\\n' '##BBW:EVT:{\"kind\":\"meta\",\"text\":\"long running\"}'\n",
            "while true; do sleep 1; done\n",
        )),
    );
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let opts = LaunchOpts::new("d-103", "sess-3", PermissionMode::FullAuto, &ws);
    let backend = GenericCliBackend::new(stub);
    let session = Arc::new(backend.launch(&brief, &opts).unwrap());

    // 读取线程：持续拉取事件直至流终止（cancel 期间阻塞在 read_line）；
    // 就绪同步：首条 meta 事件证明桩已装好 trap（并行测试负载下 spawn/drain 可能滞后）
    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let rb = backend.clone();
    let rs = session.clone();
    let rseen = seen.clone();
    let reader = std::thread::spawn(move || {
        let mut events = Vec::new();
        while let Some(ev) = rb.stream_events(&rs).unwrap() {
            rseen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            events.push(ev);
        }
        events
    });
    let ready = poll_until(5, || seen.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    assert!(ready, "5s 内应收到首条事件（桩就绪）");

    let outcome = backend.cancel(&session, true).unwrap();
    let events = reader.join().unwrap();

    assert!(outcome.graceful);
    assert!(!outcome.escalated_to_kill, "graceful 取消不应升级强杀");
    assert_eq!(outcome.record.exit_code, Some(0));
    assert!(outcome.waited_ms < 3000, "应在 3s 宽限内退出");
    assert_eq!(events.len(), 2);
    assert!(matches!(events[0], NormalizedEvent::Meta { .. }));
    assert_eq!(
        events[1],
        NormalizedEvent::Exit {
            exit_code: Some(0),
            signal: None
        }
    );
    assert!(backend.finalize(&session).unwrap().exit.ok());
}

#[test]
fn force_kill_escalates_after_grace_when_int_ignored() {
    let dir = TestDir::new("hardkill");
    let stub = write_script(
        dir.path(),
        "hard.sh",
        &with_drain(concat!(
            "trap '' INT\n",
            "printf '%s\\n' '##BBW:EVT:{\"kind\":\"meta\",\"text\":\"unkillable\"}'\n",
            "while true; do sleep 5; done\n",
        )),
    );
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let opts = LaunchOpts::new("d-104", "sess-4", PermissionMode::FullAuto, &ws);
    let backend = GenericCliBackend::new(stub);
    let session = Arc::new(backend.launch(&brief, &opts).unwrap());

    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let rb = backend.clone();
    let rs = session.clone();
    let rseen = seen.clone();
    let reader = std::thread::spawn(move || {
        let mut events = Vec::new();
        while let Some(ev) = rb.stream_events(&rs).unwrap() {
            rseen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            events.push(ev);
        }
        events
    });
    // 就绪同步：首条 meta 事件证明 trap '' INT 已安装（否则 SIGINT 会直接杀死 sh）
    let ready = poll_until(5, || seen.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    assert!(ready, "5s 内应收到首条事件（桩就绪）");

    let outcome = backend.cancel(&session, true).unwrap();
    let events = reader.join().unwrap();

    assert!(outcome.escalated_to_kill, "忽略 SIGINT 必须升级 SIGKILL");
    assert!(
        outcome.waited_ms >= 2900,
        "应给足 3s 宽限（实际 {}ms）",
        outcome.waited_ms
    );
    assert_eq!(outcome.record.signal, Some(9));
    assert_eq!(
        events.last(),
        Some(&NormalizedEvent::Exit {
            exit_code: None,
            signal: Some(9)
        })
    );
    assert!(backend.finalize(&session).unwrap().exit.abnormal());
}

#[test]
fn ask_mode_rejected_at_launch_per_17_5_2() {
    let dir = TestDir::new("askmode");
    let stub = write_script(dir.path(), "noop.sh", "#!/bin/sh\nexit 0\n");
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let opts = LaunchOpts::new("d-105", "sess-5", PermissionMode::Ask, &ws);
    let backend = GenericCliBackend::new(stub);
    match backend.launch(&brief, &opts) {
        Err(err @ DelegateError::ModeUnsupported { .. }) => {
            assert!(err.to_string().contains("映射表拒绝"));
        }
        Err(other) => panic!("期望 ModeUnsupported，实际 {other}"),
        Ok(_) => panic!("ask 模式不应允许启动"),
    }
}

#[test]
fn workspace_lock_blocks_second_delegate_on_same_workspace() {
    let dir = TestDir::new("lock");
    let ws = dir.workspace();
    let guard = bbrt_delegate::acquire_workspace_lock(&ws).unwrap();
    // 同工作区第二把锁 → 8035（上层映射拒绝/排队，17 §5.1）
    let err = bbrt_delegate::acquire_workspace_lock(&ws).unwrap_err();
    assert_eq!(err.error_code(), Some(8035));
    drop(guard);
    assert!(bbrt_delegate::acquire_workspace_lock(&ws).is_ok());
}

#[test]
fn generic_backend_usable_as_trait_object() {
    // 编排层实际持有形态：Arc<dyn CodingBackend>
    let dir = TestDir::new("traitobj");
    let stub = stream_stub(&dir);
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let opts = LaunchOpts::new("d-107", "sess-7", PermissionMode::AutoEdit, &ws);
    let be: Arc<dyn bbrt_delegate::CodingBackend> = Arc::new(GenericCliBackend::new(stub));
    let session = be.launch(&brief, &opts).unwrap();
    assert!(be.stream_events(&session).unwrap().is_some());
    session.cancel(false).unwrap();
    let report = be.finalize(&session).unwrap();
    assert!(!report.exit.ok());
}

#[test]
fn resume_rejected_for_generic_backend() {
    let dir = TestDir::new("resume");
    let stub = write_script(dir.path(), "noop.sh", "#!/bin/sh\nexit 0\n");
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let opts = LaunchOpts {
        resume: Some("g-77".into()),
        ..LaunchOpts::new("d-108", "sess-8", PermissionMode::AutoEdit, &ws)
    };
    let backend = GenericCliBackend::new(stub);
    match backend.launch(&brief, &opts) {
        Err(DelegateError::NotImplemented(msg)) => assert!(msg.contains("续接")),
        Err(other) => panic!("期望 NotImplemented，实际 {other}"),
        Ok(_) => panic!("generic 后端不应支持续接"),
    }
}

/// 简报渲染 smoke（集成侧）：forbidden 约束进入渲染文本与子进程 env 注入值
#[test]
fn brief_render_and_forbidden_env_integration() {
    let dir = TestDir::new("briefenv");
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    let text = render(&brief);
    assert!(text.contains("forbidden:"));
    assert!(text.contains("修改 go.mod"));
    let envs = bbrt_delegate::child_env(&brief);
    assert_eq!(envs[0].0, "BBW_BRIEF_FORBIDDEN");
    let parsed: Vec<String> = serde_json::from_str(&envs[0].1).unwrap();
    assert_eq!(parsed.len(), 2);
}

/// 轮询直至条件为真（秒级超时；并行测试负载下 spawn/启动可能滞后）
fn poll_until(timeout_secs: u64, mut pred: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if pred() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
