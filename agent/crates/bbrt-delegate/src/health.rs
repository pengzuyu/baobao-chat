//! 后端健康检查（D11 §8.5；17 §9 "后端版本升级破坏 CLI 协议"）。
//!
//! - detect：`<bin> --version`（5s 超时）+ PATH 解析；
//! - 版本能力矩阵：占位实现（claude/zcode 各一条最低版本记录），版本不符 →
//!   8031 语义（提示锁定版本或降级）；
//! - 冒烟：最小 headless 调用（30s 超时）——v0.1 由编排层按需调用
//!   （probe_health 不自动拉起真实 CLI，避免每次健康检查产生模型调用费用；
//!   登记偏差：D11 §8.5 的"测 3 次"与登录态探测未实现）。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use bbrt_protocol::PermissionMode;

use crate::backend::HealthIssue;

/// `<bin> --version` 探测超时（D11 §8.5）
pub const VERSION_PROBE_TIMEOUT_SECS: u64 = 5;

/// 最小 headless 冒烟超时（D11 §8.5）
pub const SMOKE_TIMEOUT_SECS: u64 = 30;

/// --version 探测结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionInfo {
    /// 请求的二进制名（或路径）
    pub bin: String,
    /// 解析到的绝对路径（PATH 查找结果）
    pub path: String,
    /// 提取的版本号（如 "1.4.2"）
    pub version: String,
    /// --version 输出首行原文
    pub raw: String,
}

/// PATH 解析：含路径分隔符直接检查存在性，否则逐个 PATH 目录查找可执行文件。
/// （标准库无 which(1) 等价，此为最小实现；不检查 x 位以外的权限语义）
pub fn resolve_bin(bin: &str) -> Option<PathBuf> {
    let p = PathBuf::from(bin);
    if bin.contains('/') {
        return p.is_file().then_some(p);
    }
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(bin))
        .find(|cand| cand.is_file())
}

/// 运行命令并限时期待退出（超时强杀）：返回 (退出是否成功, stdout 全文)
fn run_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> std::io::Result<(bool, String)> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = stdout.read_to_string(&mut buf);
                    out = buf;
                }
                return Ok((st.success(), out));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok((false, String::new()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
}

/// 提取版本号：首个含数字且含点的 token，去掉 v 前缀与尾缀（"v1.4.2-beta" → "1.4.2"）
pub fn extract_version(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let t = token.trim_start_matches(['v', 'V']);
        let mut num = String::new();
        for ch in t.chars() {
            if ch.is_ascii_digit() || ch == '.' {
                num.push(ch);
            } else {
                break;
            }
        }
        if num.contains('.') && num.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return Some(num.trim_end_matches('.').to_string());
        }
    }
    None
}

/// 版本探测（D11 §8.5 detect：`<bin> --version`，5s 超时）。
/// 未安装/非零退出/超时/输出无版本 → None。
pub fn probe_version(bin: &str, timeout: Duration) -> Option<VersionInfo> {
    let path = resolve_bin(bin)?;
    let path_str = path.to_string_lossy().into_owned();
    let program = if bin.contains('/') {
        bin.to_string()
    } else {
        path_str.clone()
    };
    let (ok, out) = run_with_timeout(&program, &["--version"], timeout).ok()?;
    if !ok {
        return None;
    }
    let first = out.lines().next().unwrap_or_default().to_string();
    let version = extract_version(&first)?;
    Some(VersionInfo {
        bin: bin.to_string(),
        path: path_str,
        version,
        raw: first,
    })
}

/// 语义化版本段比较（"1.10" > "1.9"；缺段按 0；非数字段按 0）
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|seg| seg.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (mut va, mut vb) = (parse(a), parse(b));
    let n = va.len().max(vb.len());
    va.resize(n, 0);
    vb.resize(n, 0);
    va.cmp(&vb)
}

/// 版本能力矩阵占位（D11 §8.5：决定可用参数集；不兼容 → 8031）。
/// v0.1 登记口径：最低版本为保守占位值，待各 CLI 实际协议断点回填。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityMatrix {
    /// 后端 id（claude/zcode/...）
    pub backend_id: String,
    /// 最低兼容版本（低于此 → 8031）
    pub min_version: String,
    /// 是否支持会话续接（模式 C）
    pub supports_resume: bool,
    /// 支持的权限模式（§8.2 映射声明；generic 为 auto-edit+）
    pub supported_modes: Vec<PermissionMode>,
}

/// 内置占位矩阵（claude/zcode；generic 无矩阵——无版本协议可依赖，恒 None）
pub fn capability_matrix(backend_id: &str) -> Option<CapabilityMatrix> {
    match backend_id {
        "claude" => Some(CapabilityMatrix {
            backend_id: "claude".into(),
            min_version: "1.0.0".into(),
            supports_resume: true,
            supported_modes: vec![
                PermissionMode::Ask,
                PermissionMode::AutoEdit,
                PermissionMode::FullAuto,
            ],
        }),
        "zcode" => Some(CapabilityMatrix {
            backend_id: "zcode".into(),
            min_version: "0.1.0".into(),
            supports_resume: true,
            supported_modes: vec![
                PermissionMode::Ask,
                PermissionMode::AutoEdit,
                PermissionMode::FullAuto,
            ],
        }),
        _ => None,
    }
}

/// 版本检查：低于矩阵最低版本 → [`HealthIssue::VersionTooLow`]（8031 语义）
pub fn check_version(matrix: &CapabilityMatrix, found: Option<&str>) -> Result<(), HealthIssue> {
    let Some(found) = found else {
        // 无版本信息：v0.1 放行（版本提取失败的旧 CLI），登记：可收紧为拒绝
        return Ok(());
    };
    if compare_versions(found, &matrix.min_version) == std::cmp::Ordering::Less {
        return Err(HealthIssue::VersionTooLow {
            found: Some(found.to_string()),
            required: matrix.min_version.clone(),
        });
    }
    Ok(())
}

/// 最小 headless 冒烟（D11 §8.5：如 `claude -p "ping"`；超时 30s）。
/// 返回 Err(原因) 表示冒烟失败（降级依据）。v0.1 不自动重试 3 次（登记）。
pub fn smoke(program: &str, args: &[String], timeout: Duration) -> Result<String, String> {
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    match run_with_timeout(program, &arg_refs, timeout) {
        Ok((true, out)) => Ok(out),
        Ok((false, _)) => Err("冒烟调用非零退出".into()),
        Err(e) => Err(format!("冒烟调用执行失败: {e}")),
    }
}

// ---------------------------------------------------------------------------
// 单元测试（版本探测经真实桩脚本）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;

    #[test]
    fn extract_version_from_common_formats() {
        assert_eq!(
            extract_version("claude 1.2.3 (Claude Code)"),
            Some("1.2.3".into())
        );
        assert_eq!(extract_version("v2.0.1"), Some("2.0.1".into()));
        assert_eq!(
            extract_version("zcode version 0.9.7-beta+abc"),
            Some("0.9.7".into())
        );
        assert_eq!(extract_version("no version here"), None);
        assert_eq!(extract_version("42"), None); // 无点分
    }

    #[test]
    fn compare_versions_segments() {
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Greater);
        assert_eq!(compare_versions("1.0.0", "1.0"), Equal);
        assert_eq!(compare_versions("0.9", "1.0.0"), Less);
        assert_eq!(compare_versions("2.1", "2.1.1"), Less);
    }

    #[test]
    fn capability_matrix_and_version_check_8031_semantics() {
        let m = capability_matrix("claude").unwrap();
        assert!(m.supports_resume);
        assert!(check_version(&m, Some("1.4.2")).is_ok());
        assert!(check_version(&m, Some("0.9.0")).is_err());
        assert!(matches!(
            check_version(&m, Some("0.9.0")),
            Err(HealthIssue::VersionTooLow { found: Some(f), required }) if f == "0.9.0" && required == "1.0.0"
        ));
        assert!(capability_matrix("generic").is_none());
        assert!(capability_matrix("builtin").is_none());
    }

    #[test]
    fn probe_version_success_failure_and_timeout() {
        let dir = testing::temp_dir("ver");

        // 成功：输出 "stub-generic 1.4.2"
        let ok = testing::write_script(
            &dir,
            "ok.sh",
            "#!/bin/sh\ncase \"$1\" in --version) echo 'stub-generic 1.4.2'; exit 0;; esac\nexit 0\n",
        );
        let info = probe_version(&ok.to_string_lossy(), Duration::from_secs(5)).unwrap();
        assert_eq!(info.version, "1.4.2");
        assert_eq!(info.bin, ok.to_string_lossy());
        assert!(info.raw.contains("stub-generic"));

        // 失败：--version 非零退出
        let bad = testing::write_script(
            &dir,
            "bad.sh",
            "#!/bin/sh\ncase \"$1\" in --version) echo boom >&2; exit 3;; esac\nexit 0\n",
        );
        assert!(probe_version(&bad.to_string_lossy(), Duration::from_secs(5)).is_none());

        // 超时：--version 挂起 30s（探测限时 300ms）
        let hang = testing::write_script(
            &dir,
            "hang.sh",
            "#!/bin/sh\ncase \"$1\" in --version) sleep 30;; esac\nexit 0\n",
        );
        let started = Instant::now();
        assert!(probe_version(&hang.to_string_lossy(), Duration::from_millis(300)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5), "超时应及时返回");

        // 不存在
        assert!(probe_version("/nonexistent/bbc-backend", Duration::from_secs(5)).is_none());
    }

    #[test]
    fn resolve_bin_finds_sh() {
        assert!(resolve_bin("sh").is_some());
        assert!(resolve_bin("/bin/sh").is_some());
        assert!(resolve_bin("bbc-nonexistent-backend-xyz").is_none());
    }

    #[test]
    fn smoke_reports_failure_reason() {
        let dir = testing::temp_dir("smoke");
        let ok = testing::write_script(&dir, "ok.sh", "#!/bin/sh\necho pong\n");
        assert_eq!(
            smoke(&ok.to_string_lossy(), &[], Duration::from_secs(5)).unwrap(),
            "pong\n"
        );
        let bad = testing::write_script(&dir, "bad.sh", "#!/bin/sh\nexit 9\n");
        assert!(smoke(&bad.to_string_lossy(), &[], Duration::from_secs(5)).is_err());
        assert!(smoke("/nonexistent/bin", &[], Duration::from_secs(5)).is_err());
    }
}
