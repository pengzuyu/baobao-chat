//! 打码模式库 + args_digest（09 篇 §7.2；D11 §2.5 masking.rs）。
//!
//! 职责：命令/参数/工具输出在**进入上下文、UI、审计之前**替换密钥类子串为 `***`；
//! `args_digest` 对"已打码文本"计算 FNV-1a 64 位摘要（审计 §4.5 的 args_digest 字段）。
//! 不引 regex 依赖：模式全部手写扫描器（见历史教训——依赖链大件禁止）。
//!
//! 覆盖模式（任务口径）：
//! - AK/SK 前缀：AWS AccessKey `AKIA/ASIA/ABIA/ACCA` + 16 位大写字母数字；
//! - JWT：`eyJ…`（base64url 三段，点分隔）；
//! - 赋值型密钥：`password=` / `token:` / `secret=` 等 key=value 形态（值打码）；
//! - 私钥块：`-----BEGIN … PRIVATE KEY-----` 至 END 整块打码。

/// FNV-1a 64 位偏移基数（非加密摘要，仅用于审计参数指纹去重/比对）
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a 64 位素数
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// 赋值型密钥的键名清单（小写匹配，值打码；命中 `key=` / `key:` / `"key":` 形态）
const ASSIGNMENT_KEYS: [&str; 13] = [
    "password",
    "passwd",
    "pwd",
    "token",
    "secret",
    "api_key",
    "apikey",
    "access_key",
    "accesskey",
    "secret_key",
    "secretkey",
    "client_secret",
    "authorization",
];

/// AWS 风格 AccessKey ID 前缀（后接 16 位 [A-Z0-9]）
const AK_PREFIXES: [&str; 4] = ["AKIA", "ASIA", "ABIA", "ACCA"];

/// 打码占位符（与 09 篇 §7.2 约定一致：替换为 `***`）
const MASK: &str = "***";

/// 对输入做全量打码：私钥块 → JWT → AK/SK → 赋值型密钥（先长后短避免碎片化）。
/// 输出与输入等价文本，命中片段替换为 `***`；无命中原样返回（同一分配）。
pub fn mask(input: &str) -> String {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    collect_private_key_blocks(input, &mut ranges);
    collect_jwt(input, &mut ranges);
    collect_access_keys(input, &mut ranges);
    collect_assignments(input, &mut ranges);
    if ranges.is_empty() {
        return input.to_string();
    }
    // 区间合并（同一定位可能被多个扫描器命中）
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        match merged.last_mut() {
            Some((_, last_end)) if s <= *last_end => {
                if e > *last_end {
                    *last_end = e;
                }
            }
            _ => merged.push((s, e)),
        }
    }
    let mut out = String::with_capacity(input.len());
    let mut pos = 0usize;
    for (s, e) in merged {
        // 命中点均为 ASCII 边界（各扫描器只在 ASCII 字节处定界），切片安全
        out.push_str(&input[pos..s]);
        out.push_str(MASK);
        pos = e;
    }
    out.push_str(&input[pos..]);
    out
}

/// 对"已打码"文本计算 64 位 FNV-1a 摘要，返回 16 位小写十六进制。
/// 非加密哈希：用途仅限审计 args_digest 指纹（同参数同摘要、不还原原文）。
pub fn args_digest(masked: &str) -> String {
    let mut h: u64 = FNV_OFFSET;
    for b in masked.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    format!("{h:016x}")
}

/// 便捷组合：先打码再取摘要（审计管线 §4.5 的标准顺序——先打码再落盘）
pub fn mask_and_digest(input: &str) -> (String, String) {
    let masked = mask(input);
    let digest = args_digest(&masked);
    (masked, digest)
}

// ---------------------------------------------------------------------------
// 扫描器：只返回 ASCII 安全的字节区间（start/end 落在 ASCII 边界）
// ---------------------------------------------------------------------------

/// 私钥块：`-----BEGIN … PRIVATE KEY-----` 到对应 `-----END … KEY-----`（含端点）。
/// 找不到 END（截断的粘贴文本）时打码到输入末尾，宁可多打不可漏打。
fn collect_private_key_blocks(input: &str, out: &mut Vec<(usize, usize)>) {
    let bytes = input.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = input[from..].find("-----BEGIN") {
        let start = from + rel;
        // BEGIN 行内必须声明 PRIVATE KEY，普通 CERTIFICATE/PUBLIC KEY 不在打码范围
        let head_end = (start + 80).min(bytes.len());
        let head = &input[start..head_end];
        let is_private = head.contains("PRIVATE KEY");
        if !is_private {
            from = start + "-----BEGIN".len();
            continue;
        }
        let end_marker = "-----END";
        let search_from = start + "-----BEGIN".len();
        match input[search_from..].find(end_marker) {
            Some(rel_end) => {
                let end_start = search_from + rel_end;
                // END 之后到下一个 "-----"（含）为止；无第二个 ----- 则到行尾/末尾
                let after_end = &input[end_start + end_marker.len()..];
                let end = match after_end.find("-----") {
                    Some(rel_tail) => {
                        (end_start + end_marker.len() + rel_tail + 5).min(bytes.len())
                    }
                    None => after_end
                        .find(['\n', '\r'])
                        .map_or(bytes.len(), |nl| end_start + end_marker.len() + nl),
                };
                out.push((start, end));
                from = end;
            }
            None => {
                out.push((start, bytes.len()));
                return;
            }
        }
    }
}

/// JWT：`eyJ` 开头的 base64url 三段（header.payload.signature），段长 ≥8/≥8/≥1。
fn collect_jwt(input: &str, out: &mut Vec<(usize, usize)>) {
    let bytes = input.as_bytes();
    let b64 = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'_';
    let mut from = 0usize;
    while let Some(rel) = input[from..].find("eyJ") {
        let start = from + rel;
        // 词边界：前一字符不能是 base64url 字符（避免 URL 路径中的 eyJxxx 误配一半）
        if start > 0 && b64(bytes[start - 1]) {
            from = start + 3;
            continue;
        }
        let mut i = start + 3;
        let seg = |i: &mut usize, min: usize| -> bool {
            let s = *i;
            while *i < bytes.len() && b64(bytes[*i]) && *i - s < 4096 {
                *i += 1;
            }
            *i - s >= min
        };
        if seg(&mut i, 8)
            && i < bytes.len()
            && bytes[i] == b'.'
            && {
                i += 1;
                seg(&mut i, 8)
            }
            && i < bytes.len()
            && bytes[i] == b'.'
            && {
                i += 1;
                seg(&mut i, 1)
            }
        {
            out.push((start, i));
            from = i;
        } else {
            from = start + 3;
        }
    }
}

/// AK/SK：前缀（AKIA/ASIA/ABIA/ACCA）+ 恰好 16 位 [A-Z0-9]，前后需非同族字符。
fn collect_access_keys(input: &str, out: &mut Vec<(usize, usize)>) {
    let bytes = input.as_bytes();
    let body = |c: u8| c.is_ascii_uppercase() || c.is_ascii_digit();
    for prefix in AK_PREFIXES {
        let mut from = 0usize;
        while let Some(rel) = input[from..].find(prefix) {
            let start = from + rel;
            let mut end = start + prefix.len();
            let body_start = end;
            while end < bytes.len() && body(bytes[end]) && end - body_start < 20 {
                end += 1;
            }
            let len_ok = end - body_start == 16;
            let boundary_before = start == 0 || !body(bytes[start - 1]);
            let boundary_after = end >= bytes.len() || !body(bytes[end]);
            if len_ok && boundary_before && boundary_after {
                out.push((start, end));
                from = end;
            } else {
                from = start + prefix.len();
            }
        }
    }
}

/// 赋值型密钥：`password=xxx` / `"token": "xxx"` / `secret:xxx`——仅打码**值**，
/// 保留键名便于人读审计。值至少 3 字符（避免 `a=b` 类噪声）。
fn collect_assignments(input: &str, out: &mut Vec<(usize, usize)>) {
    let lower = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let lower_bytes = lower.as_bytes();
    let is_key_char = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    for key in ASSIGNMENT_KEYS {
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(key) {
            let ks = from + rel;
            let ke = ks + key.len();
            from = ke;
            // 键名左边界：行首/空白/引号/分隔符，避免 mypassword= 误配 password=
            let left_ok = ks == 0 || !is_key_char(lower_bytes[ks - 1]);
            if !left_ok {
                continue;
            }
            // 键名闭引号（JSON 形态 "token": v），可选一组单/双引号
            let mut i = ke;
            if matches!(bytes.get(i), Some(&q) if q == b'"' || q == b'\'') {
                i += 1;
            }
            // 等号或冒号（允许中间空白，如 JSON 的 "token": "v"）
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            if i >= bytes.len() || (bytes[i] != b'=' && bytes[i] != b':') {
                continue;
            }
            i += 1;
            while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                i += 1;
            }
            // 开引号（单/双）一起吞掉，打码包含引号内的值
            let quote = match bytes.get(i) {
                Some(&q) if q == b'"' || q == b'\'' => {
                    i += 1;
                    Some(q)
                }
                _ => None,
            };
            let vs = i;
            while i < bytes.len() {
                let c = bytes[i];
                if c == b'\n' || c == b'\r' || c == b'\t' || c == b' ' {
                    break;
                }
                if quote == Some(c) {
                    break; // 闭引号保留可见，仅打码引号内的值
                }
                if quote.is_none()
                    && (c == b'"' || c == b'\'' || c == b',' || c == b'}' || c == b'&' || c == b';')
                {
                    break;
                }
                i += 1;
            }
            if i - vs >= 3 {
                out.push((vs, i));
                from = i;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 单元测试：四类模式 + 摘要稳定性
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_aws_access_key() {
        let s = "aws key AKIAIOSFODNN7EXAMPLE used";
        assert_eq!(mask(s), "aws key *** used");
        // 17 位主体（超长）不匹配，17 位会截断到 16 后受右边界约束——此处验证恰好 16 位
        assert_eq!(mask("AKIAIOSFODNN7EXAMPLEX"), "AKIAIOSFODNN7EXAMPLEX");
    }

    #[test]
    fn masks_jwt_token() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65IIFE";
        let masked = mask(&format!("Bearer {jwt} please"));
        assert_eq!(masked, "Bearer *** please");
    }

    #[test]
    fn masks_assignment_values_not_keys() {
        assert_eq!(mask("password=hunter2 go"), "password=*** go");
        assert_eq!(mask(r#""token": "abc123", x=1"#), r#""token": "***", x=1"#);
        assert_eq!(mask("db?secret=topsecret&v=2"), "db?secret=***&v=2");
        // 值过短不打码；键名左边界防误配
        assert_eq!(mask("a=b"), "a=b");
        assert_eq!(mask("mypassword=longsecret"), "mypassword=longsecret");
    }

    #[test]
    fn masks_private_key_block() {
        let input = "prefix\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\nsuffix";
        let masked = mask(input);
        assert!(masked.starts_with("prefix\n***\nsuffix"));
        // 公钥证书不在清单
        assert_eq!(
            mask("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"),
            "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"
        );
    }

    #[test]
    fn mask_plain_text_unchanged() {
        let s = "cargo test --lib 与中文注释";
        assert_eq!(mask(s), s);
    }

    #[test]
    fn digest_is_stable_and_collision_shallow() {
        let (_, d1) = mask_and_digest("run_command cargo test");
        let (_, d2) = mask_and_digest("run_command cargo test");
        assert_eq!(d1, d2);
        assert_eq!(d1.len(), 16);
        let (_, d3) = mask_and_digest("run_command cargo build");
        assert_ne!(d1, d3);
        // 打码先于摘要：明文密码不进入 digest 的明文域（摘要是单向指纹，此处校验输入已打码）
        let (masked, d4) = mask_and_digest("curl -H 'password=hunter2' https://x");
        assert!(masked.contains("***"));
        assert!(!masked.contains("hunter2"));
        assert_eq!(d4.len(), 16);
    }
}
