//! 错误类型（D11 §2.7）。
//!
//! kind 划分与 session 侧映射约定：
//! - [`AigwError::Unavailable`]：网关不可达（TCP 连接失败 / 请求-响应头阶段 IO 失败）。
//!   session 映射 8011（连续失败后暂停会话，docs/08 §4.6）。
//! - [`AigwError::HttpStatus`]：网关返回非 2xx。`code` 优先取网关错误 JSON 体的
//!   `code` 字段（8xxx，docs/19 §6.6：8050 限流 / 8051 供应商不可用 / 8052 档位未配置），
//!   解析不到时回退 HTTP 状态码。
//! - [`AigwError::StreamInterrupted`]：已开始消费 SSE 后断流（连接重置 / 读超时 /
//!   响应体结束但既无 [DONE] 也无 finish_reason）。session 按 8011 处理幂等重放，
//!   **本 crate 不重放**（docs/19 §4.5：生成式无续传语义）。
//! - [`AigwError::Protocol`]：HTTP/SSE 协议违规（非法 base_url、坏 chunked 帧、未知
//!   finish_reason 等）。
//! - [`AigwError::Serialization`]：JSON 编解码失败。

use thiserror::Error;

/// AI 网关客户端统一错误。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AigwError {
    /// 网关不可达（连接失败/超时）。无附带文本：诊断信息由调用方结合 base_url 记录。
    #[error("AI 网关不可达（连接失败或响应超时）")]
    Unavailable,
    /// 非 2xx 响应；code = 网关错误体 code（8xxx）优先，否则 HTTP 状态码。
    #[error("AI 网关返回错误响应，code={code}")]
    HttpStatus { code: u16 },
    /// HTTP / SSE / chunked 协议层违规。
    #[error("AI 网关协议错误：{0}")]
    Protocol(String),
    /// 已产出流事件后断流（session 侧按 8011 处理）。
    #[error("SSE 流中断（断流；由 session 按 8011 处理，不在本 crate 重放）")]
    StreamInterrupted,
    /// JSON 序列化/反序列化失败。
    #[error("序列化失败：{0}")]
    Serialization(String),
}

/// 网关错误 JSON 体解析结果（docs/19 §6.2：OpenAI 风格错误体，code 填 8xxx）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayError {
    /// 网关错误码（8xxx 段）。
    pub code: u16,
    /// 人类可读错误信息。
    pub message: String,
}

/// 解析网关错误响应体。支持两种形态（均按容错解析）：
///
/// - OpenAI 风格嵌套：`{"error":{"code":8051,"message":"供应商不可用"}}`
/// - 扁平：`{"code":8050,"message":"网关限流"}`
///
/// `code` 接受数字或数字字符串；解析失败（非 JSON / 无 code / code 非数字）返回 None。
pub fn parse_gateway_error_body(body: &str) -> Option<GatewayError> {
    let value: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let obj = value.get("error").unwrap_or(&value);
    let raw_code = obj.get("code")?;
    let code_u64 = match raw_code {
        serde_json::Value::Number(n) => n.as_u64().filter(|v| *v <= u64::from(u16::MAX)),
        serde_json::Value::String(s) => s.trim().parse::<u16>().ok().map(u64::from),
        _ => None,
    }?;
    let code = u16::try_from(code_u64).ok()?;
    let message = obj
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    Some(GatewayError { code, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_openai_style_nested_error_body() {
        let gw = parse_gateway_error_body(
            r#"{"error":{"code":8051,"message":"供应商不可用","provider_status":"red"}}"#,
        )
        .unwrap();
        assert_eq!(gw.code, 8051);
        assert_eq!(gw.message, "供应商不可用");
    }

    #[test]
    fn parse_flat_error_body_and_numeric_string_code() {
        let gw = parse_gateway_error_body(r#"{"code":8050,"message":"网关限流"}"#).unwrap();
        assert_eq!(gw.code, 8050);
        let s = parse_gateway_error_body(r#"{"error":{"code":"8052","message":"档位未配置"}}"#)
            .unwrap();
        assert_eq!(s.code, 8052);
        assert_eq!(s.message, "档位未配置");
    }

    #[test]
    fn parse_invalid_error_body_returns_none() {
        assert!(parse_gateway_error_body("not json").is_none());
        assert!(parse_gateway_error_body(r#"{"message":"无 code"}"#).is_none());
        assert!(parse_gateway_error_body(r#"{"code":"abc"}"#).is_none());
        assert!(parse_gateway_error_body("").is_none());
    }
}
