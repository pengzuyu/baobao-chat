//! 端到端冒烟（脱离 Tauri 窗口）：宿主桥 → 真 bbrt → 真网关（BBC_RT_GATEWAY）→ 真模型。
//! 跑法：cargo run --example agent_smoke
//! 前置：cargo build -p bbrt（workspace 内）；网关在跑（默认 http://127.0.0.1:8090，
//! BBC_RT_TOKEN=dev-token 类）；会连真实模型（planner 走 bbc-fast 档）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use baobaochat_client_lib::agent_bridge::AgentHost;

fn main() {
    let done = Arc::new(AtomicBool::new(false));
    let d2 = done.clone();
    let emit = Arc::new(move |payload: serde_json::Value| {
        let t = payload["type"].as_str().unwrap_or("").to_string();
        let brief: String = serde_json::to_string(&payload)
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        println!("EVT {t} {brief}");
        if t == "stream.done" {
            d2.store(true, Ordering::SeqCst);
        }
    });
    let data_dir = std::env::temp_dir().join(format!("bbc-smoke-{}", std::process::id()));
    let host = AgentHost::new(data_dir, emit);

    let model = std::env::var("SMOKE_MODEL").ok();
    let sid = host
        .start_session("/tmp", "ask", "strong", model.as_deref(), None, false, None)
        .expect("start_session");
    println!("== session: {sid}");

    host.request(
        "user.message",
        serde_json::json!({ "sessionId": sid, "text": "只回复两个字:成功", "attachments": [] }),
    )
    .expect("user.message");

    // glm-5.3 全链（planner fast 档 reasoning + 主回复）可达 30s+，宽限 90s
    for _ in 0..900 {
        if done.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    println!(
        "== sessions: {}",
        serde_json::to_string(&host.list_sessions()).unwrap()
    );
    if done.load(Ordering::SeqCst) {
        println!("SMOKE PASS");
    } else {
        println!("SMOKE FAIL（90s 内未见 stream.done）");
        std::process::exit(1);
    }
}
