//! 审批链路端到端冒烟（2026-11-11 真机「审批弹框没弹」排查）：
//! 宿主桥 → 真 bbrt（ask 档）→ 真网关 → 真模型，驱动一次 run_command 审批全程：
//! 发「执行 echo」→ 观察 permission.request 是否经 emit 回调到达（壳侧全链）
//! → 立即 permission.response allow → 观察 tool.result ok + turn 收口。
//! 跑法：cargo run --example permission_smoke
//! 前置：网关在跑（BBC_RT_GATEWAY，默认 http://127.0.0.1:8090）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use baobaochat_client_lib::agent_bridge::AgentHost;

fn main() {
    let saw_request = Arc::new(AtomicBool::new(false));
    let request_id = Arc::new(Mutex::new(String::new()));
    let turn_done = Arc::new(AtomicBool::new(false));
    let host_done = Arc::new(AtomicBool::new(false));

    let emit = {
        let (saw_request, request_id, turn_done, host_done) = (
            saw_request.clone(),
            request_id.clone(),
            turn_done.clone(),
            host_done.clone(),
        );
        Arc::new(move |payload: serde_json::Value| {
            let t = payload["type"].as_str().unwrap_or("").to_string();
            let brief: String = serde_json::to_string(&payload)
                .unwrap_or_default()
                .chars()
                .take(260)
                .collect();
            println!("EVT {t} {brief}");
            match t.as_str() {
                "permission.request" => {
                    let rid = payload["request_id"].as_str().unwrap_or("").to_string();
                    *request_id.lock().unwrap() = rid;
                    saw_request.store(true, Ordering::SeqCst);
                }
                "session.state" => {
                    if payload["state"] == "idle" && saw_request.load(Ordering::SeqCst) {
                        turn_done.store(true, Ordering::SeqCst);
                    }
                }
                "runtime.state" => {
                    host_done.store(true, Ordering::SeqCst);
                }
                _ => {}
            }
        })
    };

    let data_dir = std::env::temp_dir().join(format!("bbc-perm-smoke-{}", std::process::id()));
    let ws = std::env::temp_dir().join(format!("bbc-perm-smoke-ws-{}", std::process::id()));
    std::fs::create_dir_all(&ws).expect("create workspace");
    let host = Arc::new(AgentHost::new(data_dir, emit));

    let sid = host
        .start_session(ws.to_str().unwrap(), "ask", "strong", None, None)
        .expect("start_session");
    println!("== session: {sid}");

    host.request(
        "user.message",
        serde_json::json!({ "sessionId": sid, "text": "请用 shell 执行命令: echo perm-smoke-ok", "attachments": [] }),
    ).expect("user.message");

    // 等 permission.request（模型+planner 可达 60s+）
    for _ in 0..900 {
        if saw_request.load(Ordering::SeqCst) || host_done.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !saw_request.load(Ordering::SeqCst) {
        println!("SMOKE FAIL: 90s 内壳侧 emit 未收到 permission.request");
        std::process::exit(1);
    }

    // 模拟用户点「允许」（scope=once）——与 agent_approve 命令同构（camelCase 键）
    let rid = request_id.lock().unwrap().clone();
    let resp = host.request(
        "permission.response",
        serde_json::json!({ "requestId": rid, "decision": "allow", "scope": "once" }),
    );
    println!("== permission.response allow → {resp:?}");

    // 等回合收口（工具执行+总结，宽限 120s）
    for _ in 0..1200 {
        if turn_done.load(Ordering::SeqCst) || host_done.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if turn_done.load(Ordering::SeqCst) {
        println!("SMOKE PASS: permission.request 壳侧可达 + allow 应答生效（回合收口 idle）");
    } else {
        println!("SMOKE FAIL: 回合未收口（allow 未生效或模型超时）");
        std::process::exit(1);
    }
}
