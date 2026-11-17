//! L2 路径校验（D13-B9 第 2 层；09 §4.3 管线 [3]；D11 §2.5 sandbox/path.rs）。
//!
//! 职责：
//! - 工作区白名单：允许多根 + 例外可写目录（如专用临时目录）；写越界 → 8020；
//! - realpath 符号链接逃逸检查：词法上在工作区内、解析后越出 → 8024
//!   （读场景全盘可读、敏感清单拒读是 B10 的"敏感读"层语义）；
//! - 敏感文件默认拒读（09 §7.2 拒读清单）：`.env*` / `*.pem` / `id_rsa*` /
//!   `*credentials*` / `.npmrc` 等 → 8026；用户显式授权（readable_exceptions）后可读。
//!
//! 返回值统一为解析后的规范路径（canonicalize；macOS 上 /tmp 等会解析为
//! /private/tmp 前缀——Seatbelt profile 的 subpath 匹配也必须用该规范形式）。

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::errors::{CODE_SANDBOX_DENIED, CODE_SENSITIVE_READ, CODE_SYMLINK_ESCAPE};

/// 路径访问意图
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathIntent {
    /// 读（全盘可读语义，敏感清单拒读，B10）
    Read,
    /// 写（必须 ∈ 工作区根 ∪ 例外可写目录）
    Write,
}

/// 敏感文件模式（09 §7.2 拒读清单；返回值为命中的模式名，用于错误详情）
/// 判定对象是**文件名**（大小写不敏感）。
pub fn sensitive_pattern(file_name: &str) -> Option<&'static str> {
    let name = file_name.to_ascii_lowercase();
    let name = name.as_str();
    if name.starts_with(".env") || name.ends_with(".env") {
        Some(".env*")
    } else if name.ends_with(".pem") || name.ends_with(".key") {
        Some("*.pem/*.key")
    } else if name.starts_with("id_rsa")
        || name.starts_with("id_dsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
    {
        Some("id_rsa*")
    } else if name.contains("credentials") {
        Some("*credentials*")
    } else if name == ".npmrc" || name == ".netrc" {
        Some(".npmrc/.netrc")
    } else {
        None
    }
}

/// 路径校验错误（变体携带沙箱错误码，供上层直接写 violation/回填 tool.result）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PathError {
    /// 写越界（8020）：词法与解析后都不在白名单内
    #[error("路径越界（8020）: {path} 不在可写白名单内")]
    OutsideWorkspace {
        /// 错误码（8020）
        code: u32,
        /// 原始路径
        path: PathBuf,
    },
    /// 符号链接逃逸（8024）：词法在工作区内、realpath 后越出
    #[error("符号链接逃逸（8024）: {path} 解析为 {resolved}，越出工作区")]
    SymlinkEscape {
        /// 错误码（8024）
        code: u32,
        /// 原始路径
        path: PathBuf,
        /// realpath 解析结果
        resolved: PathBuf,
    },
    /// 敏感文件拒读（8026）：命中默认拒读清单
    #[error("敏感文件拒读（8026）: {path} 命中拒读清单 {pattern}")]
    SensitiveRead {
        /// 错误码（8026）
        code: u32,
        /// 原始路径
        path: PathBuf,
        /// 命中的模式（展示用）
        pattern: String,
    },
}

/// L2 路径策略：工作区多根 + 例外目录
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPolicy {
    /// 工作区根（允许多个；读写白名单基准）
    pub workspace_roots: Vec<PathBuf>,
    /// 例外可写目录（临时目录/缓存等，写白名单=roots+exceptions）
    pub writable_exceptions: Vec<PathBuf>,
    /// 用户显式授权可读的敏感文件（09 §7.2：按文件授权后可读，值仍打码）
    pub readable_exceptions: Vec<PathBuf>,
}

impl PathPolicy {
    /// 空（无根）策略：任何写都会被拒——用于测试与"最严档"初始化
    pub fn new() -> Self {
        Self::default()
    }

    /// 单根 + 例外可写目录的便捷构造
    pub fn with_roots(roots: Vec<PathBuf>, writable_exceptions: Vec<PathBuf>) -> Self {
        Self {
            workspace_roots: roots,
            writable_exceptions,
            readable_exceptions: Vec::new(),
        }
    }

    /// 判定**解析后**路径是否可写：根先 canonicalize（macOS 上 /var、/tmp 解析为
    /// /private/… 前缀，词法比较会漏配；根不存在时退词法规范化）
    fn writable_contains_canonical(&self, resolved: &Path) -> bool {
        self.workspace_roots
            .iter()
            .chain(self.writable_exceptions.iter())
            .any(|r| {
                resolved.starts_with(fs::canonicalize(r).unwrap_or_else(|_| normalize_lexical(r)))
            })
    }

    /// 判定**词法**路径是否在白名单内（区分 8024/8020：词法在内而解析越出=逃逸）
    fn writable_contains_lexical(&self, base: &Path) -> bool {
        self.workspace_roots
            .iter()
            .chain(self.writable_exceptions.iter())
            .any(|r| base.starts_with(normalize_lexical(r)))
    }

    /// L2 校验入口。返回解析后的规范路径。
    ///
    /// - Write：realpath（不存在则解析最深存在祖先后拼接尾部）∈ 白名单，
    ///   否则按"词法在内/在外"区分 8024/8020；
    /// - Read：敏感清单（原始名与解析名都查，防 `ln -s id_rsa link` 改名绕过）→ 8026；
    ///   其余放行（B10：全盘可读 + L2 拒读清单为主）。
    pub fn validate(&self, path: &Path, intent: PathIntent) -> Result<PathBuf, PathError> {
        let base = absolutize(path);
        let resolved = realpath_best_effort(&base);

        match intent {
            PathIntent::Write => {
                if self.writable_contains_canonical(&resolved) {
                    return Ok(resolved);
                }
                let lexical_inside = self.writable_contains_lexical(&base);
                Err(if lexical_inside {
                    PathError::SymlinkEscape {
                        code: CODE_SYMLINK_ESCAPE,
                        path: base,
                        resolved,
                    }
                } else {
                    PathError::OutsideWorkspace {
                        code: CODE_SANDBOX_DENIED,
                        path: base,
                    }
                })
            }
            PathIntent::Read => {
                // 敏感检查：原始词法名与解析名都过一遍清单（软链改名绕过防护）
                let candidates = [base.clone(), resolved.clone()];
                for candidate in &candidates {
                    if let Some(name) = candidate.file_name().and_then(|n| n.to_str()) {
                        if let Some(pattern) = sensitive_pattern(name) {
                            let authorized = self.readable_exceptions.contains(candidate);
                            if !authorized {
                                return Err(PathError::SensitiveRead {
                                    code: CODE_SENSITIVE_READ,
                                    path: base,
                                    pattern: pattern.to_string(),
                                });
                            }
                        }
                    }
                }
                Ok(resolved)
            }
        }
    }
}

/// 相对路径绝对化（相对当前工作目录；运行时调用方传绝对路径为主流路径）
fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexical(path)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        normalize_lexical(&cwd.join(path))
    }
}

/// 词法规范化：消解 `.` 与 `..`（不触碰文件系统，不解析符号链接）
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// realpath 尽力版：目标不存在时解析"最深存在的祖先"再拼回剩余尾部
/// （写新文件的常见场景）。全部失败（如权限拒绝）返回词法规范化结果。
fn realpath_best_effort(path: &Path) -> PathBuf {
    if let Ok(c) = fs::canonicalize(path) {
        return c;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    while let Some(parent) = cur.parent() {
        if let Ok(c) = fs::canonicalize(parent) {
            // cur 自身也未被解析（否则最外层 canonicalize 已成功），需拼回它的文件名
            let mut resolved = c;
            if let Some(name) = cur.file_name() {
                resolved.push(name);
            }
            for seg in tail.iter().rev() {
                resolved.push(seg);
            }
            return resolved;
        }
        if let Some(name) = cur.file_name() {
            tail.push(name.to_os_string());
        }
        cur = parent.to_path_buf();
    }
    path.to_path_buf()
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 临时目录守卫（panic 也保证清理，绝不留垃圾在系统临时区）
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bbc-sec-path-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &PathBuf {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn write_inside_root_ok_and_outside_8020() {
        let ws = TempDir::new("inout");
        let policy = PathPolicy::with_roots(vec![ws.path().clone()], vec![]);
        let ok = policy
            .validate(&ws.path().join("src/main.rs"), PathIntent::Write)
            .unwrap();
        // 返回规范路径（macOS 上 /var → /private/var）
        assert!(ok.starts_with(fs::canonicalize(ws.path()).unwrap()));
        let err = policy
            .validate(&ws.path().join("../escape.txt"), PathIntent::Write)
            .unwrap_err();
        match err {
            PathError::OutsideWorkspace { code, .. } => assert_eq!(code, 8020),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn multi_root_and_writable_exception() {
        let a = TempDir::new("mra");
        let b = TempDir::new("mrb");
        let tmp = TempDir::new("mrtmp");
        let outside = TempDir::new("mrout");
        let policy = PathPolicy::with_roots(
            vec![a.path().clone(), b.path().clone()],
            vec![tmp.path().clone()],
        );
        assert!(policy
            .validate(&a.path().join("x"), PathIntent::Write)
            .is_ok());
        assert!(policy
            .validate(&tmp.path().join("y"), PathIntent::Write)
            .is_ok());
        assert!(matches!(
            policy.validate(&outside.path().join("z"), PathIntent::Write),
            Err(PathError::OutsideWorkspace { .. })
        ));
    }

    #[test]
    fn symlink_escape_write_blocked_8024() {
        let ws = TempDir::new("sym");
        let out = TempDir::new("symout");
        let target = out.path().join("secret.txt");
        fs::write(&target, b"x").unwrap();
        let link = ws.path().join("jump");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let policy = PathPolicy::with_roots(vec![ws.path().clone()], vec![]);
        match policy.validate(&link, PathIntent::Write) {
            Err(PathError::SymlinkEscape { code, resolved, .. }) => {
                assert_eq!(code, 8024);
                assert_eq!(resolved, fs::canonicalize(&target).unwrap());
            }
            other => panic!("应拦截符号链接逃逸，实际 {other:?}"),
        }
        // 读场景：链接本身不是敏感名 → 放行（敏感由清单管，见下）
        assert!(policy.validate(&link, PathIntent::Read).is_ok());
    }

    #[test]
    fn sensitive_read_denied_8026_with_rename_defense() {
        let ws = TempDir::new("sens");
        let ssh = ws.path().join(".ssh");
        fs::create_dir_all(&ssh).unwrap();
        fs::write(ssh.join("id_rsa"), b"FAKE-KEY-FOR-TEST").unwrap();
        fs::write(ws.path().join(".env.local"), b"K=V").unwrap();
        fs::write(ws.path().join("cert.pem"), b"x").unwrap();
        fs::write(ws.path().join("notes.txt"), b"ok").unwrap();

        let policy = PathPolicy::with_roots(vec![ws.path().clone()], vec![]);
        let id_rsa = ssh.join("id_rsa");
        for f in [
            &id_rsa,
            &ws.path().join(".env.local"),
            &ws.path().join("cert.pem"),
        ] {
            match policy.validate(f, PathIntent::Read) {
                Err(PathError::SensitiveRead { code, pattern, .. }) => {
                    assert_eq!(code, 8026);
                    assert!(!pattern.is_empty());
                }
                Ok(p) => panic!("{f:?} 应拒读（8026），实际放行 {p:?}"),
                other => panic!("{other:?}"),
            }
        }
        // 普通文件放行
        assert!(policy
            .validate(&ws.path().join("notes.txt"), PathIntent::Read)
            .is_ok());

        // 改名软链绕过防护：link 名无害但解析名是 id_rsa → 仍拒
        let alias = ws.path().join("harmless-alias");
        std::os::unix::fs::symlink(ssh.join("id_rsa"), &alias).unwrap();
        assert!(matches!(
            policy.validate(&alias, PathIntent::Read),
            Err(PathError::SensitiveRead { .. })
        ));

        // 用户显式授权后可读（09 §7.2）
        let authorized = PathPolicy {
            readable_exceptions: vec![alias.canonicalize().unwrap()],
            ..PathPolicy::with_roots(vec![ws.path().clone()], vec![])
        };
        assert!(authorized.validate(&alias, PathIntent::Read).is_ok());
    }

    #[test]
    fn sensitive_pattern_table() {
        assert_eq!(sensitive_pattern(".env"), Some(".env*"));
        assert_eq!(sensitive_pattern(".env.production"), Some(".env*"));
        assert_eq!(sensitive_pattern("prod.env"), Some(".env*"));
        assert_eq!(sensitive_pattern("server.pem"), Some("*.pem/*.key"));
        assert_eq!(sensitive_pattern("id_rsa"), Some("id_rsa*"));
        assert_eq!(sensitive_pattern("id_ed25519.pub"), Some("id_rsa*"));
        assert_eq!(
            sensitive_pattern("gcp-credentials.json"),
            Some("*credentials*")
        );
        assert_eq!(sensitive_pattern(".npmrc"), Some(".npmrc/.netrc"));
        assert_eq!(sensitive_pattern("main.rs"), None);
        assert_eq!(sensitive_pattern("environment.md"), None);
    }
}
