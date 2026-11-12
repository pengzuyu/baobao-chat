//! 跨栈冒烟（默认忽略）：bbrt-mcp HttpTransport ↔ 真实 Go 服务端 mcpgw。
//!
//! 运行方式（服务端先起，内存模式即可）：
//! ```sh
//! BBW_HTTP_ADDR=127.0.0.1:18099 BBW_JWT_SECRET=<32B> go run ./cmd/bbw-server &
//! BBW_MCP_SMOKE_URL=http://127.0.0.1:18099/mcp/corp \
//! BBW_MCP_SMOKE_TOKEN=<alice access_token> \
//! cargo test -p bbrt-mcp --test mcp_live_cross -- --ignored
//! ```
//! 与 scripts/ 的 Runtime↔网关互通冒烟同一性质：协议契约两侧共同冻结的可重复验证。

use std::sync::Arc;

use bbrt_mcp::{McpClient, McpServerConfig, PolicyFilter, TransportConfig};

#[test]
#[ignore = "需运行中的 bbw-server 与令牌（见文件头注释）"]
fn live_go_gateway_handshake_discover_call() {
    let base = std::env::var("BBW_MCP_SMOKE_URL").expect("BBW_MCP_SMOKE_URL 未设置");
    let token = std::env::var("BBW_MCP_SMOKE_TOKEN").expect("BBW_MCP_SMOKE_TOKEN 未设置");
    let cfg = McpServerConfig {
        name: "corp".into(),
        transport: TransportConfig::Http {
            base_url: base,
            headers: vec![],
        },
    };
    let tokens: bbrt_mcp::TokenProvider = Arc::new(move || Some(token.clone()));
    let (client, results) = McpClient::connect(&[cfg], tokens);
    let r = results[0].1.as_ref().err().map(|e| e.to_string());
    assert!(r.is_none(), "真实网关握手应成功: {r:?}");

    // 发现：试点两工具 + low 风险注记（与 Go 端 server_test 断言镜像）
    let tools = client.list_tools(&PolicyFilter::default());
    let names: Vec<&str> = tools.iter().map(|t| t.full_name.as_str()).collect();
    assert!(names.contains(&"mcp.corp.kb_query"), "发现: {names:?}");
    assert!(names.contains(&"mcp.corp.doc_read"), "发现: {names:?}");

    // 调用：空库 kb_query 也应正常回包（isError=false，items 可为空）
    let out = client
        .call(
            "mcp.corp.kb_query",
            serde_json::json!({"keyword": "架构", "top_k": 3}),
        )
        .expect("kb_query 调用应成功");
    assert!(!out.is_error, "空库是正常结果: {}", out.text);
    assert!(out.text.contains("items"), "应回 KB JSON: {}", out.text);
}
