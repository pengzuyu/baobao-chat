//! OBO 令牌缓存（D11 §10.1、§2.9 obo.rs）。
//!
//! 本模块只管缓存与续签判定：token/exp/scopes 存进程内存，到期前 2min 判
//! needs_renew()。续签请求（obo.renew）的实际发送由会话装配负责；token 边界
//! （不过 WebView、不下发子进程、不落盘/日志明文）由持有方保证。

use std::time::Duration;

/// 到期前续签窗口：2min（D11 §10.1"到期前 2min 定时器触发 obo.renew"）
pub const RENEW_WINDOW: Duration = Duration::from_secs(2 * 60);

#[derive(Debug)]
struct Entry {
    token: String,
    /// 过期时刻（unix 秒）
    exp_unix: u64,
    scopes: Vec<String>,
}

/// OBO 令牌内存缓存（单条：宿主每次 obo.token 发放/续签覆盖旧值）
#[derive(Debug, Default)]
pub struct OboCache {
    entry: Option<Entry>,
}

impl OboCache {
    pub fn new() -> Self {
        Self { entry: None }
    }

    /// 写入/覆盖缓存（宿主 obo.token NTF 或续签回执落地处调用）
    pub fn set(&mut self, token: impl Into<String>, exp_unix: u64, scopes: Vec<String>) {
        self.entry = Some(Entry {
            token: token.into(),
            exp_unix,
            scopes,
        });
    }

    /// 取当前仍有效的 token；now >= exp 视为过期返回 None
    pub fn get(&self, now_unix: u64) -> Option<&str> {
        let e = self.entry.as_ref()?;
        (now_unix < e.exp_unix).then_some(e.token.as_str())
    }

    /// 是否需要续签：无缓存 / 已过期 / 进入到期前 2min 窗口（含边界）。
    /// scope 不足触发的续签判定不在本模块（D11 §10.1 由会话层重算）。
    pub fn needs_renew(&self, now_unix: u64) -> bool {
        match &self.entry {
            None => true,
            Some(e) => e.exp_unix <= now_unix + RENEW_WINDOW.as_secs(),
        }
    }

    /// 当前缓存 scopes（无缓存为空切片）
    pub fn scopes(&self) -> &[String] {
        self.entry
            .as_ref()
            .map(|e| e.scopes.as_slice())
            .unwrap_or(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_cache_needs_renew_and_yields_nothing() {
        let c = OboCache::new();
        assert!(c.needs_renew(1_000));
        assert_eq!(c.get(1_000), None);
        assert!(c.scopes().is_empty());
    }

    #[test]
    fn valid_token_hit_outside_renew_window() {
        let mut c = OboCache::new();
        c.set("tok-1", 10_000, vec!["kb:read".to_string()]);
        assert_eq!(c.get(9_999), Some("tok-1"));
        // 距到期还有 121s：窗口之外，不需续签
        assert!(!c.needs_renew(10_000 - 121));
        assert_eq!(c.scopes(), ["kb:read".to_string()]);
    }

    #[test]
    fn renew_window_boundary_is_inclusive() {
        let mut c = OboCache::new();
        c.set("tok-1", 10_000, vec![]);
        // 恰好剩 120s：进入续签窗口
        assert!(c.needs_renew(10_000 - 120));
        // 窗口内 token 本身仍有效，可继续使用直至续签完成
        assert_eq!(c.get(10_000 - 60), Some("tok-1"));
    }

    #[test]
    fn expired_token_unusable_and_needs_renew() {
        let mut c = OboCache::new();
        c.set("tok-1", 1_000, vec![]);
        assert_eq!(c.get(1_000), None);
        assert!(c.needs_renew(1_000));
        // 覆盖写入后恢复可用
        c.set("tok-2", 20_000, vec!["kb:read".to_string()]);
        assert_eq!(c.get(1_000), Some("tok-2"));
    }
}
