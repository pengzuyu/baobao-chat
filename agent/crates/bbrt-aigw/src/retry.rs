//! 重试/退避策略（D11 §2.7 retry.rs；语义依据 docs/08 §4.6、docs/19 §4.5）。
//!
//! v0.1 口径：
//! - **仅**在"连接失败 / HTTP 5xx / 429，且尚未产出任何流事件"时重试；
//! - 429/5xx 线性退避 500ms×n，n≤3（共 1 次首发 + 3 次重试）；
//! - 已产出事件后的断流**不重试**（生成式无续传语义，docs/19 §4.5），
//!   由 session 按 8011 处理；
//! - 退避基数可注入（`AigwClient::with_backoff_base`），测试用 1ms 加速。

use std::time::Duration;

/// 退避策略参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RetryPolicy {
    /// 最大重试次数（不含首发）。语义口径：n≤3。
    pub max_retries: u32,
    /// 退避基数（第 n 次重试等待 base×n）。
    pub backoff_base: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            backoff_base: Duration::from_millis(500),
        }
    }
}

impl RetryPolicy {
    /// 第 n 次重试（n 从 1 起）前的等待时长：base×n（500ms、1s、1.5s）。
    pub fn delay_for_retry(&self, retry_no: u32) -> Duration {
        self.backoff_base.saturating_mul(retry_no)
    }

    /// 是否还允许第 n 次重试。
    pub fn can_retry(&self, retry_no: u32) -> bool {
        retry_no <= self.max_retries
    }
}

/// HTTP 状态码是否可重试（429 / 5xx）。
pub(crate) fn is_retryable_status(code: u16) -> bool {
    code == 429 || code >= 500
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_linear_backoff_within_three_retries() {
        let policy = RetryPolicy::default();
        assert_eq!(policy.max_retries, 3);
        assert_eq!(policy.delay_for_retry(1), Duration::from_millis(500));
        assert_eq!(policy.delay_for_retry(2), Duration::from_millis(1000));
        assert_eq!(policy.delay_for_retry(3), Duration::from_millis(1500));
        assert!(policy.can_retry(3));
        assert!(!policy.can_retry(4));
    }

    #[test]
    fn injectable_backoff_base() {
        let policy = RetryPolicy {
            backoff_base: Duration::from_millis(1),
            ..RetryPolicy::default()
        };
        assert_eq!(policy.delay_for_retry(3), Duration::from_millis(3));
    }

    #[test]
    fn retryable_status_codes() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(is_retryable_status(503));
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(401));
        assert!(!is_retryable_status(404));
        assert!(!is_retryable_status(200));
    }
}
