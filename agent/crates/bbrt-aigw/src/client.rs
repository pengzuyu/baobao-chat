//! AI 网关客户端（D11 §2.7 client.rs：POST /v1/chat/completions + SSE → stream.delta）。
//!
//! 请求：`POST {base}/v1/chat/completions`，头 `Authorization: Bearer <token>` /
//! `Content-Type: application/json` / `Accept: text/event-stream`，body 为 ChatRequest
//! JSON（wire 层注入 `stream:true`，docs/19 §6.2）。
//!
//! 重试口径（v0.1）：仅"连接失败 / 5xx / 429 且尚未产出任何流事件"时重试
//! （`chat()` 返回迭代器之前不可能产出事件，故重试全部发生在本层）；429/5xx 按线性
//! 退避 500ms×n、n≤3；重试耗尽后：连接失败 → [`AigwError::Unavailable`]，
//! 5xx/429 → [`AigwError::HttpStatus`]（code 优先取网关错误体 8xxx）。迭代器产出
//! 事件后的断流由 `sse.rs` 报 [`AigwError::StreamInterrupted`]，session 按 8011
//! 处理（本 crate 不重放）。强→快降档决策亦归 session（docs/08 §4.6）。
//!
//! 传输：std::net::TcpStream 手写 HTTP/1.1（v0.1 仅 http://，HTTPS 为已登记开放问题）。

use std::io::Write;
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use crate::error::{parse_gateway_error_body, AigwError, GatewayError};
use crate::http::{
    build_request_bytes, parse_base_url, read_response_head, BodyReader, IO_TIMEOUT,
};
use crate::retry::{is_retryable_status, RetryPolicy};
use crate::sse::SseEventIterator;
use crate::types::{wire_body, ChatRequest, StreamEvent};

/// chat 客户端抽象（session/bin 依赖此 trait 解耦传输实现）。
pub trait ChatClient: Send + Sync {
    /// 发起一轮流式对话。成功即返回逐事件产出的迭代器（同步阻塞，套接字超时 60s）。
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError>;
}

/// AI 网关客户端（默认指向本机网关/本地代理，如 `http://127.0.0.1:8091`）。
pub struct AigwClient {
    base: String,
    /// OBO token 提供者：每次请求（含重试）现取，token 过期由 hostapi 侧续签后自然生效。
    token: Arc<dyn Fn() -> String + Send + Sync>,
    retry: RetryPolicy,
}

impl AigwClient {
    /// `token_provider` 每次请求时被调用，返回当前有效的 Bearer token。
    pub fn new(
        base_url: &str,
        token_provider: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            base: base_url.to_string(),
            token: Arc::new(token_provider),
            retry: RetryPolicy::default(),
        }
    }

    /// 切换网关地址（如宿主注入新的本地代理地址）。
    pub fn set_base_url(&mut self, base: &str) {
        self.base = base.to_string();
    }

    /// 注入退避基数（默认 500ms；测试用 1ms 加速重试用例）。
    pub fn with_backoff_base(mut self, base: Duration) -> Self {
        self.retry.backoff_base = base;
        self
    }

    /// 单次尝试：连接 → 写请求 → 读响应头 → 2xx 交给 SSE 迭代器 / 非 2xx 读错误体。
    fn attempt(&self, body: &str) -> Result<SseEventIterator<TcpStream>, AttemptFailure> {
        let base = parse_base_url(&self.base).map_err(AttemptFailure::Fatal)?;
        let mut stream = TcpStream::connect((base.host.as_str(), base.port))
            .map_err(|_| AttemptFailure::Connect)?;
        // 套接字级 60s 读写超时（硬约束；超时表现为 IO 错误）
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

        let token = (self.token)();
        let request = build_request_bytes(&base, &token, body);
        stream
            .write_all(&request)
            .map_err(|_| AttemptFailure::Fatal(AigwError::Unavailable))?;

        let mut reader = BodyReader::new(stream);
        let head = read_response_head(&mut reader).map_err(|e| {
            AttemptFailure::Fatal(match e {
                // 请求/响应头阶段的 IO 失败与提前断开，归并为"网关不可达"
                AigwError::StreamInterrupted => AigwError::Unavailable,
                other => other,
            })
        })?;
        reader.set_mode(head.body_mode());

        if (200..=299).contains(&head.status) {
            // 2xx 一律按 SSE 消费（v0.1 强制流式请求；不校验 Content-Type，宽容网关缺头）
            return Ok(SseEventIterator::new(reader));
        }

        // 非 2xx：尽力读错误体并解析 code/message（docs/19 §6.2/§6.6）
        let bytes = reader.read_body_bytes();
        let gw = parse_gateway_error_body(&String::from_utf8_lossy(&bytes));
        Err(AttemptFailure::Status {
            http: head.status,
            gw,
        })
    }
}

impl ChatClient for AigwClient {
    fn chat(
        &self,
        req: &ChatRequest,
    ) -> Result<Box<dyn Iterator<Item = Result<StreamEvent, AigwError>> + Send>, AigwError> {
        let body = wire_body(req);
        let mut retries_used: u32 = 0;
        loop {
            match self.attempt(&body) {
                Ok(iter) => return Ok(Box::new(iter)),
                Err(failure) => {
                    let retryable = match &failure {
                        AttemptFailure::Connect => true,
                        AttemptFailure::Status { http, .. } => is_retryable_status(*http),
                        AttemptFailure::Fatal(_) => false,
                    };
                    if retryable && self.retry.can_retry(retries_used + 1) {
                        retries_used += 1;
                        std::thread::sleep(self.retry.delay_for_retry(retries_used));
                        continue;
                    }
                    return Err(match failure {
                        AttemptFailure::Connect => AigwError::Unavailable,
                        AttemptFailure::Status { http, gw } => AigwError::HttpStatus {
                            // 网关错误体 code（8xxx）优先，否则 HTTP 状态码
                            code: gw.map(|g| g.code).unwrap_or(http),
                        },
                        AttemptFailure::Fatal(e) => e,
                    });
                }
            }
        }
    }
}

/// 单次尝试的失败分类（决定是否重试）。
enum AttemptFailure {
    /// TCP 连接失败（可重试；详情不外抛——Unavailable 为 unit 语义）。
    Connect,
    /// 非 2xx 响应（429/5xx 可重试）。
    Status { http: u16, gw: Option<GatewayError> },
    /// 不可重试的致命错误（base_url 非法 / 协议违规 / 请求阶段 IO 失败）。
    Fatal(AigwError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ChatMessage;

    fn sample_req() -> ChatRequest {
        ChatRequest {
            model: "bbc-fast".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            tools: vec![],
            thinking: None,
        }
    }

    /// https:// base_url：立即报 Protocol（开放问题：待网关上 TLS），不发起网络请求。
    #[test]
    fn https_base_url_rejected_immediately() {
        let client = AigwClient::new("https://gw.example.com", || "t".to_string())
            .with_backoff_base(Duration::from_millis(1));
        let err = match ChatClient::chat(&client, &sample_req()) {
            Err(e) => e,
            Ok(_) => panic!("https base_url 应被拒绝"),
        };
        assert!(matches!(err, AigwError::Protocol(_)));
    }

    /// set_base_url 生效：非法 scheme 切换后立即 Protocol。
    #[test]
    fn set_base_url_takes_effect() {
        let mut client = AigwClient::new("http://127.0.0.1:1", || "t".to_string());
        client.set_base_url("ftp://bad");
        let err = match ChatClient::chat(&client, &sample_req()) {
            Err(e) => e,
            Ok(_) => panic!("非法 scheme 应被拒绝"),
        };
        assert!(matches!(err, AigwError::Protocol(_)));
    }
}
