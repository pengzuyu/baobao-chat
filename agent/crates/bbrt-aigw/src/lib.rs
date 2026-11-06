//! bbrt-aigw —— Agent Runtime 的 AI 网关客户端 crate（D11 §2.7）。
//!
//! # 职责
//! - 调用 ai-gateway 的 OpenAI 兼容接口 `POST /v1/chat/completions`（docs/19 §6.2）；
//! - SSE 流式解析 → [`StreamEvent`]（session 侧转发为 stream.delta / stream.done，D11 §4）；
//! - 失败重试：仅"连接失败 / 5xx / 429 且尚未产出任何流事件"时重试（429/5xx 线性退避
//!   500ms×n，n≤3，docs/08 §4.6）；已产出事件后断流 → [`AigwError::StreamInterrupted`]，
//!   由 session 按 8011 语义处理（本 crate 不做断流重放）；
//! - usage 计量透出（prompt/completion tokens，缺省 0）。
//!
//! # v0.1 明确口径（写入实现约定）
//! - **传输：`std::net::TcpStream` 手写 HTTP/1.1**，不引入任何 HTTP 库依赖；
//!   目标 base_url 形如 `http://127.0.0.1:8091`（本机网关/本地代理）。
//!   **开放问题（已登记）：HTTPS 版待网关侧上 TLS 后切换 rustls，本版 `https://` 直接
//!   报 [`AigwError::Protocol`]。**
//! - 同步阻塞 API：`chat()` 返回逐事件产出的迭代器，套接字级读写超时 60s。
//! - 请求嵌套 struct 序列化为 camelCase（v0.1 锁定形态，见 `types.rs` 注释与测试）。
//! - 降档（strong→fast）归 session 决策，本 crate 仅透出错误 kind 供其映射 8011。
//!
//! # 模块布局（对齐 D11 §2.7）
//! - `types.rs`  公共请求/事件类型与 wire 序列化
//! - `error.rs`  AigwError 与网关错误体（code/message）解析
//! - `http.rs`   手写 HTTP/1.1：请求写、响应头解析、Content-Length/chunked/EOF 三种 body 读法
//! - `sse.rs`    SSE 行解析 → StreamEvent 迭代器
//! - `retry.rs`  退避策略（可注入 backoff 基数）
//! - `client.rs` [`AigwClient`] 与 [`ChatClient`] trait
//! - `merge.rs`  [`merge_stream_events`]：流事件合并为一轮（session 收尾用）

mod client;
mod error;
mod http;
mod merge;
mod retry;
mod sse;
mod types;

pub use client::{AigwClient, ChatClient};
pub use error::{parse_gateway_error_body, AigwError, GatewayError};
pub use merge::{merge_stream_events, MergedTurn};
pub use types::{
    ChatMessage, ChatRequest, FinishReason, StreamEvent, ToolCallMsg, ToolSpec, Usage,
};
