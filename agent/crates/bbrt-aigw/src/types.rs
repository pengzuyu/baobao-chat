//! 公共数据类型与 wire 序列化（D11 §2.7 types.rs：ChatReq/Chunk/ToolCall/Usage）。
//!
//! # JSON 形态（v0.1 锁定口径）
//! 嵌套 struct 序列化采用 **camelCase**（`toolCalls` / `toolCallId` / `inputSchema`），
//! 字段名由本模块单元测试锁定；网关适配层负责与 OpenAI 官方 snake_case wire 形态的
//! 对齐（docs/19 §3.1 适配层职责）。响应方向的 chunk DTO 见 `sse.rs`，按 OpenAI
//! 实际形态（snake_case）解析。

use serde::{Deserialize, Serialize};

/// 一条对话消息。role 取值：system / user / assistant / tool。
///
/// - assistant 消息可携带 `tool_calls`（历史回放时把整轮工具调用列表发回网关）；
/// - tool 消息携带 `tool_call_id`（对应被执行的调用）；
/// - user 消息的 `content` 可为分段数组（2026-11-26 视觉通道：文本段 + 图像段）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: MessageContent,
    /// assistant 消息的工具调用列表；空时序列化时省略。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallMsg>,
    /// tool 消息对应的调用 id；None 时序列化时省略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// 消息内容（2026-11-26）：纯文本 or 分段数组（OpenAI 兼容多模态形态）。
///
/// `untagged` 序列化：`Text` 落 JSON 字符串——与 v0.1 线上字节逐字节一致，纯文本
/// 会话的 prompt cache 前缀不受影响；`Parts` 落数组。反序列化按形态自动判别。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl MessageContent {
    /// 文本部分（Parts 形态=各 text 段拼接；仅做 token 估算/断言用）
    pub fn text(&self) -> &str {
        match self {
            MessageContent::Text(s) => s,
            // Parts 形态的文本段由调用方保证恰好一个；多段取首段
            MessageContent::Parts(parts) => parts
                .iter()
                .find_map(|p| match p {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .unwrap_or(""),
        }
    }

    /// 图像段数量（0=纯文本消息）
    pub fn image_count(&self) -> usize {
        match self {
            MessageContent::Text(_) => 0,
            MessageContent::Parts(parts) => parts
                .iter()
                .filter(|p| matches!(p, ContentPart::ImageUrl { .. }))
                .count(),
        }
    }
}

impl Default for MessageContent {
    fn default() -> Self {
        MessageContent::Text(String::new())
    }
}

impl From<String> for MessageContent {
    fn from(s: String) -> Self {
        MessageContent::Text(s)
    }
}

impl From<&str> for MessageContent {
    fn from(s: &str) -> Self {
        MessageContent::Text(s.to_string())
    }
}

/// 分段内容的一段：文本 or 图像（`type` 用 OpenAI snake_case——多模态 wire 形态，
/// 非本 crate 的 camelCase 嵌套约定：上游模型侧只认这一种拼写）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

/// 图像段载荷：`url` 为 data URL（runtime 侧读盘缩放后内联；本 crate 不碰文件）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
}

/// 一次工具调用（assistant 发起）。`arguments` 为 JSON 字符串——
/// 流式场景下由多个 [`StreamEvent::ToolCallDelta`] 的增量拼接而成。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallMsg {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 工具定义（注入请求 tools 列表）。`input_schema` 为 JSON Schema 值。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// 一次 chat 请求（D11 §2.7 ChatReq）。`stream: true` 由 wire 层统一注入，
/// 调用方无需（也无法）显式设置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// 模型档位别名（docs/19 §3.2：只允许 bbc-fast / bbc-strong 等，网关侧校验）。
    pub model: String,
    pub messages: Vec<ChatMessage>,
    /// 空时序列化时省略（无工具轮次不占请求体）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    /// 思考开关透传（2026-11-11：智谱 GLM 系 `{"thinking":{"type":"enabled"}}`；
    /// None=不开；思考增量经 SSE reasoning_content 回流 ReasoningDelta）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<serde_json::Value>,
}

/// SSE 流式产出的事件（session 侧映射 stream.delta / stream.done）。
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// 文本增量（stream.delta channel=text）。
    TextDelta { text: String },
    /// 思考增量（stream.delta channel=reasoning；SSE reasoning_content，2026-11-11）
    ReasoningDelta { text: String },
    /// 工具调用开始：chunk 首帧携带 id（与 name）。
    ToolCallBegin {
        index: usize,
        id: String,
        name: String,
    },
    /// 工具参数 JSON 增量（按 index 对应到 ToolCallBegin 的槽位，拼接成完整 arguments）。
    ToolCallDelta { index: usize, args_delta: String },
    /// 一轮生成结束：finish_reason + usage 汇总 + 上游实际模型名（D36：客户端据此
    /// 在**桌面端**上下文注册表里解析上限；上游未回 model=None）。
    Done {
        finish: FinishReason,
        usage: Usage,
        model: Option<String>,
    },
}

/// 生成结束原因（OpenAI finish_reason 子集，v0.1 仅映射这三种；未知值报 Protocol）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
}

/// token 用量计量（docs/19 §6.7；缺省 0——网关未回 usage 时按 0 上报）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    /// 缓存命中 tokens（D36：上游 `usage.prompt_tokens_details.cached_tokens`
    /// 或 DeepSeek 风格 `prompt_cache_hit_tokens`；None=上游未上报，不臆造 0）
    pub cached_tokens: Option<usize>,
}

/// 构造发送给网关的请求体：ChatRequest + `stream: true`。
///
/// 网关契约（docs/19 §6.2）：OpenAI Chat Completions 兼容 + 强制流式。
pub(crate) fn wire_body(req: &ChatRequest) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WireReq<'a> {
        model: &'a str,
        stream: bool,
        messages: &'a [ChatMessage],
        #[serde(skip_serializing_if = "Option::is_none")]
        tools: Option<&'a [ToolSpec]>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thinking: Option<&'a serde_json::Value>,
    }
    let wire = WireReq {
        model: &req.model,
        stream: true,
        messages: &req.messages,
        tools: (!req.tools.is_empty()).then_some(req.tools.as_slice()),
        thinking: req.thinking.as_ref(),
    };
    serde_json::to_string(&wire).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> ChatRequest {
        ChatRequest {
            thinking: None,
            model: "bbc-strong".to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: "你是编码助手".into(),
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: MessageContent::default(),
                    tool_calls: vec![ToolCallMsg {
                        id: "call-1".to_string(),
                        name: "read_file".to_string(),
                        arguments: r#"{"path":"a.rs"}"#.to_string(),
                    }],
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "tool".to_string(),
                    content: "文件内容…".into(),
                    tool_calls: vec![],
                    tool_call_id: Some("call-1".to_string()),
                },
            ],
            tools: vec![ToolSpec {
                name: "read_file".to_string(),
                description: "读取工作区文件".to_string(),
                input_schema: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}}}),
            }],
        }
    }

    /// ChatRequest JSON 形态锁定：字段名断言 + roundtrip（嵌套 struct camelCase）。
    #[test]
    fn chat_request_roundtrip_and_field_names() {
        let req = sample_request();
        let json = serde_json::to_value(&req).unwrap();

        // 字段名断言（camelCase 锁定）
        assert_eq!(json["model"], "bbc-strong");
        assert!(json.get("messages").is_some());
        let assistant = &json["messages"][1];
        assert_eq!(assistant["toolCalls"][0]["id"], "call-1");
        assert_eq!(assistant["toolCalls"][0]["name"], "read_file");
        assert_eq!(assistant["toolCalls"][0]["arguments"], r#"{"path":"a.rs"}"#);
        assert_eq!(json["messages"][2]["toolCallId"], "call-1");
        let tool = &json["tools"][0];
        assert_eq!(tool["name"], "read_file");
        assert_eq!(tool["inputSchema"]["type"], "object");

        // roundtrip
        let back: ChatRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);
    }

    /// wire 体：注入 stream:true；空 tools 省略；tools 非空时出现。
    #[test]
    fn wire_body_injects_stream_and_skips_empty_tools() {
        let body = wire_body(&ChatRequest {
            model: "bbc-fast".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".into(),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            tools: vec![],
            thinking: None,
        });
        assert!(body.contains(r#""stream":true"#), "body={body}");
        assert!(!body.contains("\"tools\""), "空 tools 应省略，body={body}");
        assert!(body.contains(r#""model":"bbc-fast""#));
        // 纯文本 content 仍是 JSON 字符串（v0.1 线上字节不变——prompt cache 前缀稳定）
        assert!(body.contains(r#""content":"hi""#), "body={body}");

        let with_tools = wire_body(&sample_request());
        assert!(with_tools.contains(r#""stream":true"#));
        assert!(with_tools.contains("\"tools\":["));
        assert!(with_tools.contains("\"inputSchema\""));
    }

    /// 反序列化容错：历史消息缺失 tool_calls / tool_call_id 字段时按缺省处理。
    #[test]
    fn chat_message_defaults_for_missing_fields() {
        let msg: ChatMessage = serde_json::from_str(r#"{"role":"user","content":"问题"}"#).unwrap();
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content.text(), "问题");
        assert_eq!(msg.content.image_count(), 0);
        assert!(msg.tool_calls.is_empty());
        assert!(msg.tool_call_id.is_none());
    }

    /// 2026-11-26 视觉通道：分段 content（文本段 + 图像段）的线上形态与往返。
    #[test]
    fn message_content_parts_wire_shape_and_roundtrip() {
        let data_url = "data:image/jpeg;base64,/9j/4AAQ";
        let msg = ChatMessage {
            role: "user".to_string(),
            content: MessageContent::Parts(vec![
                ContentPart::Text {
                    text: "帮我看这张图".to_string(),
                },
                ContentPart::ImageUrl {
                    image_url: ImageUrl {
                        url: data_url.to_string(),
                    },
                },
            ]),
            tool_calls: vec![],
            tool_call_id: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        // 多模态 wire 形态：type 用 snake_case（image_url），与 OpenAI/智谱兼容层一致
        assert_eq!(
            json,
            serde_json::json!({
                "role":"user",
                "content":[
                    {"type":"text","text":"帮我看这张图"},
                    {"type":"image_url","image_url":{"url":data_url}}
                ]
            })
        );
        assert_eq!(msg.content.text(), "帮我看这张图");
        assert_eq!(msg.content.image_count(), 1);

        // 往返保形（Parts 不塌回 Text）
        let back: ChatMessage = serde_json::from_value(json).unwrap();
        assert_eq!(back, msg);

        // wire 体同样落数组
        let body = wire_body(&ChatRequest {
            model: "bbc-strong".to_string(),
            messages: vec![msg],
            tools: vec![],
            thinking: None,
        });
        assert!(body.contains(r#""type":"image_url""#), "body={body}");
    }
}
