//! agent 票缓存（D11 §10.1 / D38 单票制票据代）。
//!
//! 按受众键控：一种 agent 票（ES256），每受众（生态应用=url / corp=aigw 保留名）
//! 一张，同批签发同 TTL（票据代齐进齐出，D38 拍板 9）。本模块只管缓存与续签判定：
//! ticket/exp/scopes 存进程内存，到期前 2min 判 needs_renew()（任一受众进窗=整代
//! 重签）。续签请求（obo.renew）的实际发送由会话装配负责；token 边界（不过
//! WebView、不下发子进程、不落盘/日志明文）由持有方保证。

use std::collections::HashMap;
use std::time::Duration;

/// 到期前续签窗口：2min（D11 §10.1"到期前 2min 定时器触发 obo.renew"）
pub const RENEW_WINDOW: Duration = Duration::from_secs(2 * 60);

#[derive(Debug)]
struct Entry {
    token: String,
    /// 过期时刻（unix 秒）
    exp_unix: u64,
    /// 票内权限点（随代下发保真；诊断用——v0.1 无消费面，防 dead_code 警告标记）
    #[allow(dead_code)]
    scopes: Vec<String>,
}

/// 单张票数据（宿主 obo.token 下发元素 → set_generation 输入）
#[derive(Debug, Clone)]
pub struct Ticket {
    pub audience: String,
    pub token: String,
    pub exp_unix: u64,
    pub scopes: Vec<String>,
}

/// agent 票按受众键控缓存（整代覆盖；D38 拍板 9/10：齐进齐出 + 运行时纯查取）
#[derive(Debug, Default)]
pub struct OboCache {
    entries: HashMap<String, Entry>,
}

impl OboCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// 整代覆盖（宿主 obo.token{tokens[]} 落地处调用）：全量替换——装配变更/
    /// 续签都发整代，旧代残留受众（卸载插件）随之清除
    pub fn set_generation(&mut self, tickets: Vec<Ticket>) {
        self.entries = tickets
            .into_iter()
            .map(|t| {
                (
                    t.audience,
                    Entry {
                        token: t.token,
                        exp_unix: t.exp_unix,
                        scopes: t.scopes,
                    },
                )
            })
            .collect();
    }

    /// 按受众取当前仍有效的票；now >= exp 视为过期返回 None（调用路径纯内存查取）
    pub fn get(&self, audience: &str, now_unix: u64) -> Option<&str> {
        self.entries
            .get(audience)
            .filter(|e| now_unix < e.exp_unix)
            .map(|e| e.token.as_str())
    }

    /// 是否需要续签：有票且任一受众进入到期前 2min 窗（含边界）——整代重签
    /// （票据代同 TTL，先到期者带动全代）。空表 = 无缓存不请求（宿主在首个需要
    /// 票的调用前主动发放，空缓存轮询不刷屏——D11 §10.1 语义保留）
    pub fn needs_renew(&self, now_unix: u64) -> bool {
        !self.entries.is_empty()
            && self
                .entries
                .values()
                .any(|e| e.exp_unix <= now_unix + RENEW_WINDOW.as_secs())
    }

    /// 当前票受众清单（诊断/retain 用）
    pub fn audiences(&self) -> Vec<&str> {
        self.entries.keys().map(String::as_str).collect()
    }

    /// 装配变更后清孤儿受众（卸载/禁用插件的票不残留；返回是否清除过）
    pub fn retain(&mut self, keep: &[String]) -> bool {
        let before = self.entries.len();
        self.entries.retain(|aud, _| keep.iter().any(|k| k == aud));
        self.entries.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(aud: &str, exp_unix: u64) -> Ticket {
        Ticket {
            audience: aud.into(),
            token: format!("tok-{aud}"),
            exp_unix,
            scopes: vec![],
        }
    }

    #[test]
    fn empty_cache_needs_no_renew_and_yields_nothing() {
        let c = OboCache::new();
        assert!(c.get("bbc-corp", 1_000).is_none());
        assert!(!c.needs_renew(1_000), "空缓存不请求续签（宿主主动发放语义）");
        assert!(c.audiences().is_empty());
    }

    #[test]
    fn valid_ticket_hit_outside_renew_window() {
        let mut c = OboCache::new();
        c.set_generation(vec![ticket("bbc-corp", 10_000)]);
        assert_eq!(c.get("bbc-corp", 9_999), Some("tok-bbc-corp"));
        assert_eq!(c.get("bbc-aigw", 9_999), None, "无该受众即无票");
        // 距到期还有 121s：窗口之外，不需续签
        assert!(!c.needs_renew(10_000 - 121));
    }

    #[test]
    fn keyed_by_audience_no_cross_read() {
        let mut c = OboCache::new();
        c.set_generation(vec![
            ticket("https://oa.internal/mcp", 10_000),
            ticket("bbc-aigw", 10_000),
        ]);
        assert_eq!(c.get("https://oa.internal/mcp", 9_000), Some("tok-https://oa.internal/mcp"));
        assert_eq!(c.get("bbc-aigw", 9_000), Some("tok-bbc-aigw"));
        // 串受众取不到（aud 隔离）
        assert_eq!(c.get("https://hr.internal/mcp", 9_000), None);
        assert_eq!(c.audiences().len(), 2);
    }

    #[test]
    fn renew_window_boundary_is_inclusive_whole_generation() {
        let mut c = OboCache::new();
        // 票据代：两受众同 exp
        c.set_generation(vec![ticket("bbc-corp", 10_000), ticket("bbc-aigw", 10_000)]);
        // 恰好剩 120s：进入续签窗口 → 整代重签
        assert!(c.needs_renew(10_000 - 120));
        // 窗口内票本身仍有效，可继续使用直至续签完成
        assert_eq!(c.get("bbc-corp", 10_000 - 60), Some("tok-bbc-corp"));
    }

    #[test]
    fn any_expiring_ticket_triggers_generation_renew() {
        let mut c = OboCache::new();
        c.set_generation(vec![
            ticket("bbc-corp", 10_000),
            ticket("bbc-aigw", 20_000), // 更晚到期
        ]);
        // corp 进窗（剩 119s）→ 整代需续（齐进齐出）
        assert!(c.needs_renew(10_000 - 119));
        // 全部远离窗口 → 不续
        let mut c2 = OboCache::new();
        c2.set_generation(vec![ticket("bbc-corp", 20_000), ticket("bbc-aigw", 20_000)]);
        assert!(!c2.needs_renew(10_000));
    }

    #[test]
    fn expired_ticket_unusable_but_no_renew_when_stale_only() {
        let mut c = OboCache::new();
        c.set_generation(vec![ticket("bbc-corp", 1_000)]);
        assert_eq!(c.get("bbc-corp", 1_000), None);
        // 全代已过期：仍判需续（有票且进窗=负窗口）——宿主续签失败即 401 降级
        assert!(c.needs_renew(1_000));
        // 覆盖写入后恢复可用
        c.set_generation(vec![ticket("bbc-corp", 20_000)]);
        assert_eq!(c.get("bbc-corp", 1_000), Some("tok-bbc-corp"));
    }

    #[test]
    fn retain_drops_orphan_audiences() {
        let mut c = OboCache::new();
        c.set_generation(vec![
            ticket("bbc-corp", 10_000),
            ticket("https://oa.internal/mcp", 10_000),
        ]);
        assert!(c.retain(&["bbc-corp".into()]), "应清除过孤儿");
        assert_eq!(c.audiences(), vec!["bbc-corp"]);
        assert!(!c.retain(&["bbc-corp".into()]), "无变化再 retain 返回 false");
    }
}
