//! bbrt-mcp 集成测试：拉起测试专用 stdio server（CARGO_BIN_EXE），
//! 全链路验证 initialize→list_tools→call 的命名空间/风险级/身份注入/策略过滤。

use std::sync::Arc;

use bbrt_mcp::{no_token, McpClient, McpError, McpServerConfig, PolicyFilter, TransportConfig};

fn fake_server_cfg() -> McpServerConfig {
    McpServerConfig {
        name: "fake".into(),
        transport: TransportConfig::Stdio {
            command: env!("CARGO_BIN_EXE_mcp-fake-server").into(),
            args: vec![],
            env: vec![],
        },
    }
}

/// 握手→发现：3 工具命名空间化；风险级默认 Medium、x-bbw-risk 声明 High。
#[test]
fn initialize_and_discover_namespaced_tools() {
    let (client, results) = McpClient::connect(&[fake_server_cfg()], no_token());
    assert!(
        results.iter().all(|(_, r)| r.is_ok()),
        "fake server 应连接成功: {results:?}"
    );

    let tools = client.list_tools(&PolicyFilter::default());
    let names: Vec<&str> = tools.iter().map(|t| t.full_name.as_str()).collect();
    assert_eq!(
        names,
        vec!["mcp.fake.echo", "mcp.fake.risky_op", "mcp.fake.fail_probe"]
    );
    let echo = &tools[0];
    assert_eq!(echo.risk, bbrt_protocol::RiskLevel::Medium, "缺省风险级=中");
    let risky = &tools[1];
    assert_eq!(
        risky.risk,
        bbrt_protocol::RiskLevel::High,
        "x-bbw-risk 声明应生效"
    );
}

/// 主体身份逐请求注入：echo 回显 _meta.bbwObo（D14 §6.2 验证点）。
#[test]
fn obo_token_propagates_per_call() {
    let tokens: Arc<dyn Fn() -> Option<String> + Send + Sync> = Arc::new(|| Some("tok-42".into()));
    let (client, _) = McpClient::connect(&[fake_server_cfg()], tokens);

    let out = client
        .call("mcp.fake.echo", serde_json::json!({"text": "你好"}))
        .unwrap();
    assert_eq!(out.text, "echo:你好 obo:tok-42");
    assert!(!out.is_error);
}

/// 归因身份（act）：call_as 携带 expert 归因（bbwAct 注入——fake server 不回显，仅验通路不炸）。
#[test]
fn call_with_expert_attribution() {
    let (client, _) = McpClient::connect(&[fake_server_cfg()], no_token());
    let out = client
        .call_as(
            "mcp.fake.echo",
            serde_json::json!({"text": "x"}),
            "expert:corp.ppt-maker:run-1",
        )
        .unwrap();
    assert!(out.text.starts_with("echo:x"));
}

/// MCP 语义：业务失败 = isError 结果（非 JSON-RPC error）；未知工具 = JSON-RPC error。
#[test]
fn is_error_semantics_vs_rpc_error() {
    let (client, _) = McpClient::connect(&[fake_server_cfg()], no_token());

    let out = client
        .call("mcp.fake.fail_probe", serde_json::json!({}))
        .unwrap();
    assert!(out.is_error, "业务失败应是 isError=true 的正常回包");
    assert!(!out.text.is_empty());

    // 工具名存在但 server 侧 method 未知 → 走 JSON-RPC error（Err）
    // （fake server 对已知 method 内的未知工具名返回 isError，此处验证的是
    //  client 对不存在 server 的拒绝路径）
    let err = client
        .call("mcp.不存在.echo", serde_json::json!({}))
        .unwrap_err();
    assert!(
        matches!(err, McpError::Call(_)),
        "未连接 server 应拒绝: {err}"
    );
}

/// 策略过滤：禁用 server → 工具不可见（策略作用于发现层，调用层不复查——
/// 注册表注入时已被过滤，未注册名走 8002）。
#[test]
fn policy_disables_server() {
    let (client, _) = McpClient::connect(&[fake_server_cfg()], no_token());
    let policy = PolicyFilter::new(vec!["fake".into()]);
    assert!(client.list_tools(&policy).is_empty(), "禁用后不应发现工具");
    // 不过滤的名单照常发现
    assert_eq!(client.list_tools(&PolicyFilter::default()).len(), 3);
}

/// 连接失败与不支持传输：单 server 失败不阻塞（降级语义）。
#[test]
fn connect_failures_degrade() {
    // 不存在的命令 → Connect 错误
    let bad = McpServerConfig {
        name: "bad".into(),
        transport: TransportConfig::Stdio {
            command: "/nonexistent/bbrt-mcp-server".into(),
            args: vec![],
            env: vec![],
        },
    };
    let (client, results) = McpClient::connect(&[bad], no_token());
    assert!(matches!(results[0].1, Err(McpError::Connect(_))));
    assert!(client.list_tools(&PolicyFilter::default()).is_empty());

    // HTTP 传输：闭端口 → Connect 错误（HTTP 传输已实现，见 mcp_http_test）
    let http = McpServerConfig {
        name: "gw".into(),
        transport: TransportConfig::Http {
            base_url: "http://127.0.0.1:1/mcp".into(), // 端口 1 无监听
            headers: vec![],
        },
    };
    let (_, results) = McpClient::connect(&[http], no_token());
    assert!(matches!(results[0].1, Err(McpError::Connect(_))));
}
