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
        audience: None,
        meta: None,
    }
}

/// 握手→发现：3 工具命名空间化；风险级默认 Medium、x-bbc-risk 声明 High。
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
        "x-bbc-risk 声明应生效"
    );
}

/// stdio 传输恒匿名（D38 拍板 8：stdio 无跨网络边界，永不需要令牌——
/// audience 恒 None，_meta.bbcObo 不再注入；HTTP 统一身份注入见 mcp_http_test）。
#[test]
fn stdio_call_has_no_identity_injection() {
    let tokens: Arc<dyn Fn(&str) -> Option<String> + Send + Sync> =
        Arc::new(|_: &str| Some("tok-42".into()));
    let (client, _) = McpClient::connect(&[fake_server_cfg()], tokens);

    let out = client
        .call("mcp.fake.echo", serde_json::json!({"text": "你好"}))
        .unwrap();
    // 即便令牌提供者有票：stdio 无受众声明 → 不注入（echo 回显 obo:none）
    assert_eq!(out.text, "echo:你好 obo:none");
    assert!(!out.is_error);
}

/// 归因身份（act）：call_as 携带 expert 归因（bbcAct 注入——fake server 不回显，仅验通路不炸）。
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

/// 动态重配（D22 §5.3 / D26 OQ-3 收口）：connect 空表 → reconfigure 追加
/// fake → list_tools 懒补连发现工具；再 reconfigure 移除 → 断开不可见。
/// 这是"装插件后 agent 看得见工具"的连接层前提（注册表热重建在 bbrt-tools）。
#[test]
fn reconfigure_adds_and_removes_servers() {
    let (client, results) = McpClient::connect(&[], no_token());
    assert!(results.is_empty());

    // 追加：reconfigure 只更新配置表（不连接），list_tools 入口懒补连
    client.reconfigure(vec![fake_server_cfg()]);
    let tools = client.list_tools(&PolicyFilter::default());
    let names: Vec<&str> = tools.iter().map(|t| t.full_name.as_str()).collect();
    assert_eq!(
        names,
        vec!["mcp.fake.echo", "mcp.fake.risky_op", "mcp.fake.fail_probe"],
        "懒补连后应可发现新 server 工具"
    );

    // 追加的 server 可直接调用
    let out = client
        .call("mcp.fake.echo", serde_json::json!({"text": "热"}))
        .unwrap();
    assert_eq!(out.text, "echo:热 obo:none");

    // 移除：配置表清空 → 连接断开 → 不可见不可调
    client.reconfigure(vec![]);
    assert!(client.list_tools(&PolicyFilter::default()).is_empty());
    let err = client
        .call("mcp.fake.echo", serde_json::json!({"text": "x"}))
        .unwrap_err();
    assert!(matches!(err, McpError::Call(_)), "移除后应拒绝: {err}");
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
        audience: None,
        meta: None,
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
            audience: None,
        },
        audience: None,
        meta: None,
    };
    let (_, results) = McpClient::connect(&[http], no_token());
    assert!(matches!(results[0].1, Err(McpError::Connect(_))));
}
