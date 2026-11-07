//! claude / zcode 适配器 × sh 桩脚本集成测试。
//!
//! - claude：桩输出 stream-json 样例行序列（17 §3.2 事件通道），断言归一化链路
//!   （system/init → Meta+session_ref；assistant → Delta+ToolUse；user → ToolResult；
//!   result → Delta+Meta）与 finalize（changed_files/session_ref/summary）；
//! - zcode：桩输出假定行文本协议（`##ZCODE:` 前缀 + 纯文本行），含 warning 场景
//!   （headless 权限询问，17 §3.3）。
//!
//! 两者均经 detect（--version）探测；不依赖真实 CLI 安装。

mod common;

use bbrt_delegate::{ClaudeBackend, CodingBackend, LaunchOpts, NormalizedEvent, ZcodeBackend};
use bbrt_protocol::{PermissionMode, RiskLevel, StreamChannel};
use common::{assert_brief_lines, sample_brief, write_script, TestDir};

/// claude 桩：--version → 版本行；否则输出 stream-json 样例序列（简报经 -p 传入，不读 stdin）
fn claude_stub(dir: &TestDir) -> String {
    write_script(
        dir.path(),
        "claude.sh",
        concat!(
            "#!/bin/sh\n",
            "case \"$1\" in --version) echo 'claude version 1.5.0'; exit 0;; esac\n",
            "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-1\",\"model\":\"stub-claude\"}'\n",
            "printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"让我看看文件\"},{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Edit\",\"input\":{\"file_path\":\"src/a.rs\"}}]}}'\n",
            "printf '%s\\n' '{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\",\"content\":\"应用补丁成功\",\"is_error\":false}]}}'\n",
            "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"已完成\",\"session_id\":\"sess-1\"}'\n",
            "exit 0\n",
        ),
    )
}

#[test]
fn claude_adapter_end_to_end_stream_json() {
    let dir = TestDir::new("claude");
    let stub = claude_stub(&dir);
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    assert_brief_lines(&brief);
    let opts = LaunchOpts::new("d-201", "sess-a", PermissionMode::AutoEdit, &ws);
    let backend = ClaudeBackend::with_bin(stub);
    assert_eq!(backend.id(), "claude");

    // detect/probe_health 走 --version
    let probe = backend.detect();
    assert!(probe.installed);
    assert_eq!(probe.version.as_deref(), Some("1.5.0"));
    assert!(probe.capabilities.contains(&"stream-json".to_string()));
    assert!(backend.probe_health().ok);

    let session = backend.launch(&brief, &opts).unwrap();
    let mut events = Vec::new();
    while let Some(ev) = backend.stream_events(&session).unwrap() {
        events.push(ev);
    }
    // system/init → Meta（session_id 续接句柄）
    assert_eq!(
        events[0],
        NormalizedEvent::Meta {
            text: "session init（model=stub-claude）".into(),
            session_ref: Some("sess-1".into())
        }
    );
    // assistant 一行多块 → Delta + ToolUse（顺序保留）
    assert_eq!(
        events[1],
        NormalizedEvent::Delta {
            channel: StreamChannel::Text,
            text: "让我看看文件".into()
        }
    );
    assert_eq!(
        events[2],
        NormalizedEvent::ToolUse {
            call_id: "toolu_1".into(),
            tool: "Edit".into(),
            args: serde_json::json!({"file_path": "src/a.rs"}),
            risk: RiskLevel::Medium,
        }
    );
    // user tool_result
    assert_eq!(
        events[3],
        NormalizedEvent::ToolResult {
            call_id: "toolu_1".into(),
            ok: true,
            summary: "应用补丁成功".into()
        }
    );
    // result → Delta(结果文本) + Meta(session_ref)
    assert_eq!(
        events[4],
        NormalizedEvent::Delta {
            channel: StreamChannel::Text,
            text: "已完成".into()
        }
    );
    assert_eq!(
        events[5],
        NormalizedEvent::Meta {
            text: "result/success".into(),
            session_ref: Some("sess-1".into())
        }
    );
    // 进程退出
    assert_eq!(
        events[6],
        NormalizedEvent::Exit {
            exit_code: Some(0),
            signal: None
        }
    );

    let report = backend.finalize(&session).unwrap();
    assert!(report.exit.ok());
    assert_eq!(report.changed_files, vec!["src/a.rs".to_string()]);
    assert_eq!(report.session_ref.as_deref(), Some("sess-1"));
    assert!(report.summary.contains("让我看看文件"));
    assert!(report.summary.contains("已完成"));
}

#[test]
fn claude_detect_missing_binary_not_installed() {
    let backend = ClaudeBackend::with_bin("/nonexistent/claude-bbw-test");
    assert!(!backend.detect().installed);
    let health = backend.probe_health();
    assert!(!health.ok);
    assert_eq!(
        health.degraded,
        Some(bbrt_delegate::HealthIssue::NotInstalled)
    );
}

/// zcode 桩：--version → 版本行；否则排空 9 行简报后输出假定行文本协议序列
fn zcode_stub(dir: &TestDir) -> String {
    write_script(
        dir.path(),
        "zcode.sh",
        concat!(
            "#!/bin/sh\n",
            "case \"$1\" in --version) echo 'zcode 0.9.7'; exit 0;; esac\n",
            "i=0\nwhile [ \"$i\" -lt 9 ]; do\n  IFS= read -r _b || break\n  i=$((i+1))\ndone\n",
            "printf '%s\\n' '##ZCODE:{\"kind\":\"meta\",\"text\":\"init zcode\",\"session_ref\":\"zc-9\"}'\n",
            "printf '%s\\n' 'zcode plain delta'\n",
            "printf '%s\\n' '##ZCODE:{\"kind\":\"tool_use\",\"call_id\":\"z1\",\"tool\":\"Bash\",\"args\":{\"command\":\"make build\"}}'\n",
            "printf '%s\\n' '##ZCODE:{\"kind\":\"tool_result\",\"call_id\":\"z1\",\"ok\":false,\"summary\":\"build failed\"}'\n",
            "printf '%s\\n' '##ZCODE:{\"kind\":\"warning\",\"text\":\"permission prompt in headless\"}'\n",
            "exit 0\n",
        ),
    )
}

#[test]
fn zcode_adapter_end_to_end_line_protocol() {
    let dir = TestDir::new("zcode");
    let stub = zcode_stub(&dir);
    let ws = dir.workspace();
    let brief = sample_brief(&ws);
    assert_brief_lines(&brief);
    let opts = LaunchOpts::new("d-202", "sess-b", PermissionMode::FullAuto, &ws);
    let backend = ZcodeBackend::with_bin(stub);
    assert_eq!(backend.id(), "zcode");

    let probe = backend.detect();
    assert!(probe.installed);
    assert_eq!(probe.version.as_deref(), Some("0.9.7"));
    assert!(backend.probe_health().ok);

    let session = backend.launch(&brief, &opts).unwrap();
    let mut events = Vec::new();
    while let Some(ev) = backend.stream_events(&session).unwrap() {
        events.push(ev);
    }
    // meta（session_ref）→ delta（纯文本）→ tool_use（Bash → High）→ tool_result（失败）→ warning → exit
    assert_eq!(
        events[0],
        NormalizedEvent::Meta {
            text: "init zcode".into(),
            session_ref: Some("zc-9".into())
        }
    );
    assert_eq!(
        events[1],
        NormalizedEvent::Delta {
            channel: StreamChannel::Text,
            text: "zcode plain delta".into()
        }
    );
    assert_eq!(
        events[2],
        NormalizedEvent::ToolUse {
            call_id: "z1".into(),
            tool: "Bash".into(),
            args: serde_json::json!({"command": "make build"}),
            risk: RiskLevel::High,
        }
    );
    assert_eq!(
        events[3],
        NormalizedEvent::ToolResult {
            call_id: "z1".into(),
            ok: false,
            summary: "build failed".into()
        }
    );
    // headless 权限询问 → Warning（17 §3.3：出现即异常，上层终止+建议改参数组合）
    assert_eq!(
        events[4],
        NormalizedEvent::Warning {
            text: "permission prompt in headless".into()
        }
    );
    assert_eq!(
        events[5],
        NormalizedEvent::Exit {
            exit_code: Some(0),
            signal: None
        }
    );

    let report = backend.finalize(&session).unwrap();
    assert!(report.exit.ok());
    assert_eq!(report.session_ref.as_deref(), Some("zc-9"));
    // Bash 工具不入 changed_files（仅 Edit/Write 类提取）
    assert!(report.changed_files.is_empty());
    assert!(report.summary.contains("zcode plain delta"));
}

#[test]
fn registry_detect_all_with_stub_claude_zcode_builtin() {
    // BackendRegistry：并行探测（claude/zcode 桩 + builtin 恒可用）
    use bbrt_delegate::BackendRegistry;
    use std::sync::Arc;
    let dir = TestDir::new("regall");
    let mut reg = BackendRegistry::new();
    reg.register(Arc::new(ClaudeBackend::with_bin(claude_stub(&dir))))
        .unwrap();
    reg.register(Arc::new(ZcodeBackend::with_bin(zcode_stub(&dir))))
        .unwrap();
    reg.register(Arc::new(bbrt_delegate::BuiltinBackend))
        .unwrap();

    let probes = reg.detect_all();
    assert_eq!(
        probes
            .iter()
            .map(|p| p.backend_id.as_str())
            .collect::<Vec<_>>(),
        vec!["claude", "zcode", "builtin"]
    );
    assert_eq!(probes[0].version.as_deref(), Some("1.5.0"));
    assert_eq!(probes[1].version.as_deref(), Some("0.9.7"));
    assert!(probes[2].installed); // 内置恒可用（17 §1.3 兜底）
}
