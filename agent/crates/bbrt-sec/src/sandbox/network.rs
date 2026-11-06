//! L2/L3 网络出站白名单——纯逻辑，不实际抓包（D13-B10 "联网例外"与 09 §3.2.4）。
//!
//! 规则：目标 = IP 字面量 → 逐 CIDR 匹配；域名 → 后缀匹配（api.example.com 命中
//! 白名单 example.com，notexample.com 不命中）。均未命中 → [`NetworkError::NotWhitelisted`]
//! 携带 8025，上层写 violation（kind=network）并按 B10 决定拒绝/杀进程。
//!
//! 默认白名单语义（09 §3.2.4）：内网 CIDR + ai-gateway 与文档/KB 域（租户配置下发，
//! 本类型只承载结构与判定）。

use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::errors::CODE_NETWORK_NOT_ALLOWED;

/// CIDR（IPv4/IPv6）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cidr {
    /// 网络地址
    pub addr: IpAddr,
    /// 前缀长度（0–32 / 0–128）
    pub prefix: u8,
}

impl Cidr {
    /// 解析 `a.b.c.d/n` 或 IPv6 形式；校验前缀范围
    pub fn parse(s: &str) -> Result<Self, NetworkError> {
        let (addr, prefix) = s.split_once('/').ok_or_else(|| NetworkError::BadCidr {
            input: s.to_string(),
            detail: "缺少 / 前缀长度".into(),
        })?;
        let addr: IpAddr = addr.parse().map_err(|_| NetworkError::BadCidr {
            input: s.to_string(),
            detail: "地址段不是合法 IP".into(),
        })?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix: u8 = prefix.parse().map_err(|_| NetworkError::BadCidr {
            input: s.to_string(),
            detail: "前缀不是数字".into(),
        })?;
        if prefix > max {
            return Err(NetworkError::BadCidr {
                input: s.to_string(),
                detail: format!("前缀超过 /{max}"),
            });
        }
        Ok(Self { addr, prefix })
    }

    /// IP 是否落在网段内（掩码比较）
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(host)) => {
                let p = u32::from(self.prefix);
                let mask = if p == 0 { 0 } else { u32::MAX << (32 - p) };
                u32::from(net) & mask == u32::from(host) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(host)) => {
                let p = u128::from(self.prefix);
                let mask = if p == 0 { 0 } else { u128::MAX << (128 - p) };
                u128::from(net) & mask == u128::from(host) & mask
            }
            // v4/v6 混比：不做 v4-mapped 转换，直接不匹配（白名单按字面族别配置）
            _ => false,
        }
    }
}

/// 网络出站白名单
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetPolicy {
    /// 允许的域名后缀（小写存储语义；example.com 允许 example.com 与 *.example.com）
    pub allowed_domains: Vec<String>,
    /// 允许的 CIDR 网段（含内网段与 ai-gateway VIP）
    pub allowed_cidrs: Vec<Cidr>,
}

/// 网络白名单错误（8025 结构化输出 + 配置解析错误）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NetworkError {
    /// 目标不在白名单（8025）
    #[error("网络出站目标不在白名单（8025）: {host}")]
    NotWhitelisted {
        /// 错误码（8025）
        code: u32,
        /// 目标主机（IP 或域名）
        host: String,
    },
    /// CIDR 配置非法
    #[error("CIDR 非法: {input}（{detail}）")]
    BadCidr {
        /// 原始输入
        input: String,
        /// 原因
        detail: String,
    },
}

impl NetPolicy {
    /// 空策略（全拒绝）——策略缺失时按最严档（09 §7.4）
    pub fn new() -> Self {
        Self::default()
    }

    /// 从配置构造（域名小写化 + CIDR 解析；任一 CIDR 非法即整体失败，避免静默漏配）
    pub fn from_config(domains: &[String], cidrs: &[String]) -> Result<Self, NetworkError> {
        Ok(Self {
            allowed_domains: domains.iter().map(|d| d.to_ascii_lowercase()).collect(),
            allowed_cidrs: cidrs
                .iter()
                .map(|c| Cidr::parse(c))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    /// 校验目标主机：IP 字面量走 CIDR；域名走后缀匹配。命中 → Ok(())。
    pub fn check_host(&self, host: &str) -> Result<(), NetworkError> {
        let host = normalize_host(host);
        if host.is_empty() {
            return Err(NetworkError::NotWhitelisted {
                code: CODE_NETWORK_NOT_ALLOWED,
                host: host.to_string(),
            });
        }
        // IP 字面量（含 [v6] 去壳）
        if let Ok(ip) = host.parse::<IpAddr>() {
            if self.allowed_cidrs.iter().any(|c| c.contains(ip)) {
                return Ok(());
            }
            return Err(NetworkError::NotWhitelisted {
                code: CODE_NETWORK_NOT_ALLOWED,
                host: host.to_string(),
            });
        }
        // 域名后缀：api.example.com ∈ example.com；notexample.com ∉ example.com
        let host = host.to_ascii_lowercase();
        if self
            .allowed_domains
            .iter()
            .any(|d| &host == d || host.ends_with(&format!(".{d}")))
        {
            return Ok(());
        }
        Err(NetworkError::NotWhitelisted {
            code: CODE_NETWORK_NOT_ALLOWED,
            host,
        })
    }

    /// 便捷入口：从 URL 提取 host 再校验（scheme://host[:port]/path…）
    pub fn check_url(&self, url: &str) -> Result<(), NetworkError> {
        self.check_host(&extract_host(url).unwrap_or_default())
    }
}

/// 主机名规范化：去 scheme、路径、端口、[] 壳、用户信息
fn normalize_host(host: &str) -> String {
    let mut h = host.trim();
    if let Some(rest) = h.strip_prefix("https://") {
        h = rest;
    } else if let Some(rest) = h.strip_prefix("http://") {
        h = rest;
    }
    // 用户信息
    if let Some((_, after)) = h.split_once('@') {
        h = after;
    }
    // 路径
    if let Some((before, _)) = h.split_once('/') {
        h = before;
    }
    // [v6] 壳：直接取方括号内
    if h.starts_with('[') {
        if let Some(end) = h.find(']') {
            return h[1..end].to_string();
        }
    }
    // 裸 IPv6 字面量（fd00::1）不能再剥"端口"——整体就是地址
    if h.parse::<std::net::Ipv6Addr>().is_ok() {
        return h.to_string();
    }
    // 端口：仅当末段是纯数字（host:8080）才剥离
    if let Some((before, port)) = h.rsplit_once(':') {
        if !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()) {
            h = before;
        }
    }
    h.to_string()
}

/// 从 URL 提取 host（scheme 之后到端口/路径之前；无 scheme 时尽力取首段）
fn extract_host(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let authority = authority
        .rsplit_once('@')
        .map(|(_, a)| a)
        .unwrap_or(authority);
    Some(normalize_host(authority))
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> NetPolicy {
        NetPolicy::from_config(
            &[
                "ai-gateway.internal".to_string(),
                "docs.example.com".to_string(),
                "example.com".to_string(),
            ],
            &[
                "127.0.0.0/8".to_string(),
                "10.0.0.0/8".to_string(),
                "192.168.0.0/16".to_string(),
                "fd00::/8".to_string(),
            ],
        )
        .unwrap()
    }

    #[test]
    fn cidr_parse_and_contains_v4() {
        let c = Cidr::parse("10.1.2.0/24").unwrap();
        assert!(c.contains("10.1.2.99".parse().unwrap()));
        assert!(!c.contains("10.1.3.1".parse().unwrap()));
        let all = Cidr::parse("0.0.0.0/0").unwrap();
        assert!(all.contains("8.8.8.8".parse().unwrap()));
        assert!(Cidr::parse("10.0.0.0/8")
            .unwrap()
            .contains("10.255.0.1".parse().unwrap()));
        // 非法输入
        assert!(Cidr::parse("10.0.0.0").is_err());
        assert!(Cidr::parse("10.0.0.0/33").is_err());
        assert!(Cidr::parse("abc/8").is_err());
    }

    #[test]
    fn cidr_v6() {
        let c = Cidr::parse("fd00::/8").unwrap();
        assert!(c.contains("fd12:3456::1".parse().unwrap()));
        assert!(!c.contains("fe80::1".parse().unwrap()));
        // v4 与 v6 不混比
        assert!(!c.contains("127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn loopback_and_private_cidrs_allowed() {
        let p = policy();
        assert!(p.check_host("127.0.0.1").is_ok());
        assert!(p.check_host("10.20.30.40").is_ok());
        assert!(p.check_host("192.168.1.2").is_ok());
    }

    #[test]
    fn public_ip_denied_8025() {
        let p = policy();
        match p.check_host("8.8.8.8") {
            Err(NetworkError::NotWhitelisted { code, host }) => {
                assert_eq!(code, 8025);
                assert_eq!(host, "8.8.8.8");
            }
            other => panic!("{other:?}"),
        }
        assert!(p.check_host("172.16.0.1").is_err()); // 未配置的私网段同样拒绝
    }

    #[test]
    fn domain_suffix_matching() {
        let p = policy();
        assert!(p.check_host("example.com").is_ok());
        assert!(p.check_host("api.example.com").is_ok());
        assert!(p.check_host("deep.api.example.com").is_ok());
        // 后缀必须落在标签边界
        assert!(p.check_host("notexample.com").is_err());
        assert!(p.check_host("evil.com").is_err());
        // 大小写不敏感
        assert!(p.check_host("API.Example.COM").is_ok());
    }

    #[test]
    fn url_extraction_and_check() {
        let p = policy();
        assert!(p.check_url("https://ai-gateway.internal/v1/chat").is_ok());
        assert!(p.check_url("http://127.0.0.1:8080/health").is_ok());
        assert!(p.check_url("http://[fd00::1]:9/x").is_ok());
        assert!(p.check_url("https://evil.io/x").is_err());
        assert!(p.check_url("https://user:pass@10.0.0.5:443/api").is_ok());
        // 空主机拒绝
        assert!(p.check_url("https:///path").is_err());
    }

    #[test]
    fn empty_policy_denies_everything() {
        let p = NetPolicy::new();
        assert!(p.check_host("127.0.0.1").is_err());
        assert!(p.check_host("example.com").is_err());
    }

    #[test]
    fn bad_cidr_config_fails_whole_policy() {
        let err = NetPolicy::from_config(&[], &["10.0.0.0/8".into(), "oops/99".into()]);
        assert!(matches!(err, Err(NetworkError::BadCidr { .. })));
    }
}
