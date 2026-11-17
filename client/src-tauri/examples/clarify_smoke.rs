//! D20 澄清提问链路端到端冒烟：宿主桥 → 真 bbrt（ask 档）→ 假网关 → 真 bbrt 循环。
//! 驱动 ask_user 工具全程：发「clarify-smoke」→ 观察 clarify.request 到达壳侧 emit
//! → 回 clarify.response（camelCase 键）→ 观察工具结果含所选答案 → 回合收口 idle。
//! 跑法：BBC_RT_GATEWAY=http://127.0.0.1:18099 cargo run --example clarify_smoke
//! 前置：mock-gateway.mjs（/tmp/bbc-perm-debug/）在跑。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use baobaochat_client_lib::agent_bridge::AgentHost;

fn main() {
    let saw_request = Arc::new(AtomicBool::new(false));
    let question_id = Arc::new(Mutex::new(String::new()));
    let saw_answer_in_result = Arc::new(AtomicBool::new(false));
    let turn_done = Arc::new(AtomicBool::new(false));
    let host_down = Arc::new(AtomicBool::new(false));

    let emit = {
        let (saw_request, question_id, saw_answer, turn_done, host_down) = (
            saw_request.clone(),
            question_id.clone(),
            saw_answer_in_result.clone(),
            turn_done.clone(),
            host_down.clone(),
        );
        Arc::new(move |payload: serde_json::Value| {
            let t = payload["type"].as_str().unwrap_or("").to_string();
            match t.as_str() {
                "clarify.request" => {
                    let qid = payload["question_id"].as_str().unwrap_or("").to_string();
                    println!(
                        "== clarify.request 到达壳侧 emit: question={} options={} multi_select={}",
                        payload["question"], payload["options"], payload["multi_select"]
                    );
                    *question_id.lock().unwrap() = qid;
                    saw_request.store(true, Ordering::SeqCst);
                }
                "tool.result" => {
                    let s = payload["summary"].as_str().unwrap_or("");
                    println!("== tool.result: ok={} summary={}", payload["ok"], s);
                    if s.contains("方案A") {
                        saw_answer.store(true, Ordering::SeqCst);
                    }
                }
                "session.state" => {
                    let st = payload["state"].as_str().unwrap_or("");
                    if st == "waiting_clarify" {
                        println!("== session.state: waiting_clarify（状态机 #6b 生效）");
                    }
                    if st == "idle" && saw_request.load(Ordering::SeqCst) {
                        turn_done.store(true, Ordering::SeqCst);
                    }
                }
                "runtime.state" => {
                    host_down.store(true, Ordering::SeqCst);
                }
                _ => {}
            }
        })
    };

    let data_dir = std::env::temp_dir().join(format!("bbc-clarify-smoke-{}", std::process::id()));
    let ws = std::env::temp_dir().join(format!("bbc-clarify-smoke-ws-{}", std::process::id()));
    std::fs::create_dir_all(&ws).expect("create workspace");
    let host = Arc::new(AgentHost::new(data_dir, emit));

    let sid = host
        .start_session(ws.to_str().unwrap(), "ask", "strong", None, None)
        .expect("start_session");
    println!("== session: {sid}");

    host.request(
        "user.message",
        serde_json::json!({ "sessionId": sid, "text": "clarify-smoke：请提问我", "attachments": [] }),
    ).expect("user.message");

    for _ in 0..900 {
        if saw_request.load(Ordering::SeqCst) || host_down.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !saw_request.load(Ordering::SeqCst) {
        println!("SMOKE FAIL: 90s 内壳侧 emit 未收到 clarify.request");
        std::process::exit(1);
    }

    // 模拟用户选「方案A」+补充（fire 无回执——与 agent_clarify_respond 命令同构）
    let qid = question_id.lock().unwrap().clone();
    host.fire(
        "clarify.response",
        serde_json::json!({ "questionId": qid, "answers": ["方案A"], "freeText": "注意兼容" }),
    )
    .expect("clarify.response fire");

    for _ in 0..1200 {
        if turn_done.load(Ordering::SeqCst) || host_down.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if turn_done.load(Ordering::SeqCst) && saw_answer_in_result.load(Ordering::SeqCst) {
        println!("SMOKE PASS: clarify.request 壳侧可达 + 回答注入工具结果 + 回合收口 idle");
    } else {
        println!(
            "SMOKE FAIL: 收口={} 工具结果含答案={}",
            turn_done.load(Ordering::SeqCst),
            saw_answer_in_result.load(Ordering::SeqCst)
        );
        std::process::exit(1);
    }
}
