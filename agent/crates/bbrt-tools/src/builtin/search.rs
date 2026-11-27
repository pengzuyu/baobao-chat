//! 文件检索工具（D11 §2.4 builtin/search.rs；2026-11-27 工具面改造）。
//!
//! 原 search_files 单工具双语义（pattern 含 `*`/`?` 只匹配文件名、否则文件名+内容
//! 子串）拆成两个单一职责工具——双语义靠参数形状切换是模型误用重灾区（内容检索
//! 顺手写 `*.rs` 静默变成文件名 glob、按标准 glob 写 `**/*.x` 却只对 basename 匹配
//! 恒 0 命中），拆分后形态与业界约定（Glob/Grep）对齐，先验强、描述短也不会错位：
//!
//! - [`glob_files`]：文件名/路径 glob（`**` 跨段、`*` 段内、`?` 单字符；pattern 含
//!   `/` 对根的相对路径匹配，否则对任意深度文件名匹配），≤200 条；
//! - [`grep_files`]：内容正则检索（regex crate；行号、逐文件 ≤20 行 +N、总 ≤200 行；
//!   glob 过滤/include、ignore_case、content/files/count 三输出模式）。
//!
//! 两工具共享遍历器：不跟随符号链接（防越出工作区的遍历逃逸）；跳过构建产物与
//! 依赖目录（SKIP_DIRS，根目录本身指向其中时不跳——显式 path 是明确意图）；扫描
//! 文件数 20000 上限（防御超大目录把会话卡死，D11 §12 边界）；命中/展示 200 上限。
//! grep 内容匹配跳过敏感文件（8026 口径——搜索不泄露密钥内容）与二进制文件
//! （头部 8KB 含 NUL 判定）；超大文件只在前 1MB 内匹配。

use std::fs;
use std::io::Read;
use std::path::Path;

use bbrt_sec::gate::ActionCategory;
use regex::RegexBuilder;
use serde_json::json;

use super::{deny, str_arg, timed, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 命中/展示条数上限（沿 D11 §2.4：命中 ≤200）
pub const MAX_HITS: usize = 200;

/// 单文件展示行数上限（content 模式：一文件刷屏会挤掉其它文件的命中）
const MAX_LINES_PER_FILE: usize = 20;

/// 扫描文件数上限（防御性边界）
const MAX_FILES_SCANNED: usize = 20_000;

/// 单文件内容读取上限（超大文件只在前 1MB 内匹配）
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// 二进制嗅探窗口（头部 8KB 含 NUL 即按二进制跳过）
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// 跳过的目录名（构建产物与依赖；性能约定。根目录本身命中此表不跳——
/// 显式 path 指进去=明确意图，跳过只对根之下的子目录生效）
const SKIP_DIRS: [&str; 12] = [
    ".git",
    "target",
    "node_modules",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "vendor",
    "__pycache__",
    ".next",
    ".cache",
];

// ---------------------------------------------------------------------------
// 共享遍历器
// ---------------------------------------------------------------------------

/// 遍历状态（扫描计数 + 截断旗标；命中收集由回调持有）
struct WalkState {
    files_scanned: usize,
    scan_capped: bool,
}

/// 递归遍历（不跟随符号链接；`visit` 返回 false = 已达展示上限，提前收敛）
fn walk(
    dir: &Path,
    root: &Path,
    state: &mut WalkState,
    visit: &mut dyn FnMut(&Path, &str) -> bool,
) {
    if state.files_scanned >= MAX_FILES_SCANNED || state.scan_capped {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return; // 无权限/已删除等：跳过该目录（尽力遍历）
    };
    for entry in entries.flatten() {
        if state.files_scanned >= MAX_FILES_SCANNED {
            state.scan_capped = true;
            return;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if ft.is_dir() {
            // 不跟随符号链接目录（防遍历逃逸）；跳过约定目录（根目录豁免）
            let name = entry.file_name().to_string_lossy().into_owned();
            if path != root && SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&path, root, state, visit);
            if state.scan_capped {
                return;
            }
        } else if ft.is_file() {
            state.files_scanned += 1;
            let rel = rel_path(&path, root);
            if !visit(&path, &rel) {
                return;
            }
        }
    }
}

/// 相对路径（正斜杠分隔；根外兜底用完整 display）
fn rel_path(path: &Path, root: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        _ => path.to_string_lossy().into_owned(),
    }
}

/// 按字符截断（UTF-8 安全；旧实现按字节找字符边界，语义同、写法更直）
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

// ---------------------------------------------------------------------------
// glob 匹配：段级 `**` + 段内 `*`/`?`
// ---------------------------------------------------------------------------

/// path glob 匹配：pattern 含 `/` 对相对路径整段匹配；否则对文件名匹配
/// （任意深度——`*.rs` 等价 `**/*.rs`，与常见编辑器/agent 工具口径一致）
fn glob_matches(pattern: &str, rel: &str, file_name: &str) -> bool {
    if pattern.contains('/') {
        segs_match(
            pattern.split('/').collect::<Vec<_>>().as_slice(),
            rel.split('/').collect::<Vec<_>>().as_slice(),
        )
    } else {
        seg_glob(pattern, file_name)
    }
}

/// 段序列匹配（`**` 匹配零或多个段；其余段逐一 seg_glob）
fn segs_match(p: &[&str], t: &[&str]) -> bool {
    match p.first() {
        None => t.is_empty(),
        Some(&"**") => segs_match(&p[1..], t) || (!t.is_empty() && segs_match(p, &t[1..])),
        Some(seg) => !t.is_empty() && seg_glob(seg, t[0]) && segs_match(&p[1..], &t[1..]),
    }
}

/// 单段匹配（`*` 任意序列、`?` 单字符；大小写敏感）。不跨段：入参含 `/` 一律
/// 不匹配——跨段是 `segs_match` 的职责，这里守住单元契约
fn seg_glob(pattern: &str, text: &str) -> bool {
    if pattern.contains('/') || text.contains('/') {
        return false;
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => {
                // 连续 * 合并；匹配空或吞一个字符
                let rest = &p[1..];
                go(rest, t) || (!t.is_empty() && go(p, &t[1..]))
            }
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a == b => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    go(&p, &t)
}

// ---------------------------------------------------------------------------
// glob_files
// ---------------------------------------------------------------------------

/// glob_files 实现：读授权统一入口 → 遍历收集路径（≤200 条）
pub(crate) fn glob_files(env: &ExecEnv, args: &serde_json::Value) -> Result<ExecOutput, ToolBlock> {
    let pattern =
        str_arg(args, "pattern").ok_or_else(|| deny(8002, "glob_files 缺少 pattern 参数"))?;
    let root_arg = str_arg(args, "path");

    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let raw_root = root_arg
            .map(|p| super::resolve_against(&env.workspace, &p))
            .unwrap_or_else(|| env.workspace.clone());
        let root = super::read_access::authorize_read(env, "glob_files", &raw_root)?;

        let mut state = WalkState {
            files_scanned: 0,
            scan_capped: false,
        };
        let mut hits: Vec<String> = Vec::new();
        let mut hits_capped = false;
        walk(&root, &root, &mut state, &mut |path, rel| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if glob_matches(&pattern, rel, &name) {
                if hits.len() >= MAX_HITS {
                    hits_capped = true;
                    return false;
                }
                hits.push(path.display().to_string());
            }
            true
        });
        hits.sort();
        if hits_capped {
            hits.push(format!("[truncated, showing {MAX_HITS}]"));
        }
        if state.scan_capped {
            hits.push(format!(
                "\n[scan capped at {MAX_FILES_SCANNED} files, results may be incomplete; narrow the path and retry]"
            ));
        }
        if hits.is_empty() {
            hits.push(format!("未命中：{pattern}（根 {}）", root.display()));
        }
        Ok(ExecOutput {
            summary: hits.join("\n"),
            truncated: hits_capped || state.scan_capped,
            exit_code: None,
            duration_ms: 0,
        })
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

// ---------------------------------------------------------------------------
// grep_files
// ---------------------------------------------------------------------------

/// grep_files 输出模式
#[derive(Clone, Copy, PartialEq)]
enum OutMode {
    Content,
    Files,
    Count,
}

/// grep_files 实现：读授权统一入口 → 正则编译 → 遍历内容匹配
pub(crate) fn grep_files(env: &ExecEnv, args: &serde_json::Value) -> Result<ExecOutput, ToolBlock> {
    let pattern =
        str_arg(args, "pattern").ok_or_else(|| deny(8002, "grep_files 缺少 pattern 参数"))?;
    let glob_filter = str_arg(args, "glob");
    let ignore_case = args
        .get("ignore_case")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mode = match str_arg(args, "output_mode").as_deref() {
        None | Some("content") => OutMode::Content,
        Some("files") => OutMode::Files,
        Some("count") => OutMode::Count,
        Some(other) => {
            return Err(deny(
                8002,
                format!("grep_files output_mode 仅支持 content/files/count，收到 {other}"),
            ))
        }
    };

    let re = RegexBuilder::new(&pattern)
        .case_insensitive(ignore_case)
        .build()
        .map_err(|e| deny(8002, format!("grep_files pattern 不是合法正则: {e}")))?;

    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let raw_root = str_arg(args, "path")
            .map(|p| super::resolve_against(&env.workspace, &p))
            .unwrap_or_else(|| env.workspace.clone());
        let root = super::read_access::authorize_read(env, "grep_files", &raw_root)?;

        let mut state = WalkState {
            files_scanned: 0,
            scan_capped: false,
        };
        let mut lines: Vec<String> = Vec::new(); // 展示行（三模式同形态：path 前缀行）
        let mut hits_capped = false;
        let mut file_hits_total: usize = 0; // 命中文件数（files/count 模式截断依据）

        walk(&root, &root, &mut state, &mut |path, rel| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // include 过滤（与 glob_files 同口径：含 / 对相对路径，否则对文件名）
            if let Some(g) = &glob_filter {
                if !glob_matches(g, rel, &name) {
                    return true;
                }
            }
            // 敏感文件静默跳过（8026 口径：搜索不泄露密钥内容）；二进制跳过
            if is_sensitive_name(&name) || is_binary(path) {
                return true;
            }
            let Some(text) = read_text(path) else {
                return true; // 非 UTF-8/不可读：跳过
            };
            let mut file_match_count: usize = 0;
            let mut shown: Vec<(usize, &str)> = Vec::new(); // 本文件前 20 条 (行号, 行)
            for (idx, line) in text.lines().enumerate() {
                if re.is_match(line) {
                    file_match_count += 1;
                    if mode == OutMode::Content && shown.len() < MAX_LINES_PER_FILE {
                        shown.push((idx + 1, line));
                    }
                }
            }
            if file_match_count > 0 {
                if mode == OutMode::Content {
                    // 单文件截 20 条 + 超额标注（真实计数）；总量 200 满仅停展示
                    for (lineno, line) in shown {
                        if lines.len() >= MAX_HITS {
                            hits_capped = true;
                            break;
                        }
                        lines.push(format!(
                            "{}:{}:{}",
                            path.display(),
                            lineno,
                            truncate_chars(line.trim(), 200)
                        ));
                    }
                    if file_match_count > MAX_LINES_PER_FILE && lines.len() < MAX_HITS {
                        lines.push(format!(
                            "{}:（{} more matches in this file）",
                            path.display(),
                            file_match_count - MAX_LINES_PER_FILE
                        ));
                    }
                    if lines.len() >= MAX_HITS {
                        hits_capped = true;
                    }
                }
                match mode {
                    OutMode::Files => {
                        if file_hits_total < MAX_HITS {
                            lines.push(path.display().to_string());
                            file_hits_total += 1;
                        } else {
                            hits_capped = true;
                        }
                    }
                    OutMode::Count => {
                        if file_hits_total < MAX_HITS {
                            lines.push(format!("{}:{}", path.display(), file_match_count));
                            file_hits_total += 1;
                        } else {
                            hits_capped = true;
                        }
                    }
                    OutMode::Content => {
                        file_hits_total += 1; // 命中文件数仅供 truncated 判定参考
                    }
                }
            }
            // 三模式展示位均满 → 提前收敛
            lines.len() < MAX_HITS
        });

        if hits_capped {
            lines.push(format!("[truncated, showing {MAX_HITS}]"));
        }
        if state.scan_capped {
            lines.push(format!(
                "[scan capped at {MAX_FILES_SCANNED} files, results may be incomplete; narrow the path and retry]"
            ));
        }
        if lines.is_empty() {
            lines.push(format!("未命中：{pattern}（根 {}）", root.display()));
        }
        Ok(ExecOutput {
            summary: lines.join("\n"),
            truncated: hits_capped || state.scan_capped,
            exit_code: None,
            duration_ms: 0,
        })
    });
    let out = result?;
    Ok(ExecOutput {
        duration_ms: ms,
        ..out
    })
}

/// 敏感文件名判定（复用 bbrt-context 名单；搜索结果不泄露敏感文件内容）
fn is_sensitive_name(name: &str) -> bool {
    bbrt_context::excerpt::is_sensitive_path(name)
}

/// 二进制嗅探：头部 8KB 含 NUL 即按二进制跳过（读全文只为正则匹配太浪费）
fn is_binary(path: &Path) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return true; // 打不开按不可搜处理
    };
    let mut buf = vec![0u8; BINARY_SNIFF_BYTES];
    let n = f.read(&mut buf).unwrap_or(0);
    buf[..n].contains(&0)
}

/// 读文本（>1MB 只读头部 1MB；非 UTF-8 返回 None）
fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        let mut f = fs::File::open(path).ok()?;
        let mut buf = vec![0u8; MAX_FILE_BYTES as usize];
        let n = f.read(&mut buf).unwrap_or(0);
        buf.truncate(n);
        Some(String::from_utf8_lossy(&buf).into_owned())
    } else {
        fs::read_to_string(path).ok()
    }
}

// 读边界 ensure_inside_roots 已退役（2026-11-26 读审批化）——根目录走
// read_access::authorize_read 统一入口（见 builtin/read_access.rs）。

// ---------------------------------------------------------------------------
// ToolDef 导出
// ---------------------------------------------------------------------------

/// glob_files 工具定义（只读，全档自动）
pub fn glob_files_def() -> ToolDef {
    ToolDef {
        name: "glob_files".into(),
        description: "Find files by name or path glob: ** matches any number of path segments, \
                      * matches within one segment, ? matches one character. A pattern containing \
                      / is matched against paths relative to the search root (e.g. **/*.rs, \
                      src/lib/*.ts); otherwise it matches file names at any depth (e.g. *.md). \
                      Returns at most 200 matching file paths. Build/dependency directories \
                      (target, node_modules, dist, vendor, ...) are skipped unless the search \
                      root itself points into one"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern (e.g. **/*.rs, *.md, report-*.json)"},
                "path": {"type": "string", "description": "Search root directory (absolute, ~/ or relative; defaults to the workspace)"}
            },
            "required": ["pattern"]
        }),
        risk: RiskLevel::Low,
        category: ActionCategory::ReadOnly,
    }
}

/// grep_files 工具定义（只读，全档自动）
pub fn grep_files_def() -> ToolDef {
    ToolDef {
        name: "grep_files".into(),
        description: "Search file contents with a regular expression (Rust regex syntax — no \
                      lookahead/backreferences; use alternation and character classes instead). \
                      Returns matching lines as path:line:text with line numbers (at most 200 \
                      lines, at most 20 per file with a +N-more marker). Parameters: glob \
                      restricts which files are searched (path glob relative to the root, e.g. \
                      **/*.go); ignore_case for case-insensitive matching; output_mode \"files\" \
                      lists matching file paths only, \"count\" reports per-file match counts. \
                      Binary and secret-looking files are skipped silently. Prefer this over \
                      run_command grep — results are line-numbered and structured. When results \
                      are empty or truncated on a large tree, narrow path to a subdirectory and \
                      retry instead of concluding the content does not exist"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression to search for"},
                "path": {"type": "string", "description": "Search root directory (absolute, ~/ or relative; defaults to the workspace)"},
                "glob": {"type": "string", "description": "Only search files whose path relative to the root matches this glob (e.g. **/*.ts)"},
                "ignore_case": {"type": "boolean", "description": "Case-insensitive matching (default false)"},
                "output_mode": {"type": "string", "enum": ["content", "files", "count"],
                                "description": "content = matching lines with line numbers (default); files = matching file paths; count = per-file match counts"}
            },
            "required": ["pattern"]
        }),
        risk: RiskLevel::Low,
        category: ActionCategory::ReadOnly,
    }
}

// ---------------------------------------------------------------------------
// 单元测试（纯逻辑：glob 匹配器/截断；执行链路在 tests/tools_suite.rs）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_段级星号不跨段() {
        assert!(seg_glob("*.rs", "main.rs"));
        assert!(!seg_glob("*.rs", "src/main.rs")); // * 不跨 /
        assert!(seg_glob("a?c", "abc"));
        assert!(!seg_glob("a?c", "ac"));
        assert!(seg_glob("report-*.json", "report-2026.json"));
    }

    #[test]
    fn glob_双星跨段() {
        // ** 匹配零或多段
        assert!(segs_match(&["**", "*.rs"], &["main.rs"]));
        assert!(segs_match(&["**", "*.rs"], &["src", "deep", "main.rs"]));
        assert!(segs_match(&["src", "**", "*.rs"], &["src", "main.rs"]));
        assert!(segs_match(
            &["src", "**", "*.rs"],
            &["src", "a", "b", "m.rs"]
        ));
        assert!(!segs_match(&["src", "**", "*.rs"], &["lib", "m.rs"]));
        assert!(segs_match(&["**", "test", "**"], &["a", "test", "b"]));
    }

    #[test]
    fn glob_含斜杠对相对路径_不含对文件名() {
        assert!(glob_matches("**/*.rs", "src/main.rs", "main.rs"));
        assert!(glob_matches("*.rs", "src/main.rs", "main.rs"));
        assert!(!glob_matches("src/*.rs", "lib/main.rs", "main.rs"));
        assert!(glob_matches("src/*.rs", "src/main.rs", "main.rs"));
    }

    #[test]
    fn 截断按字符安全() {
        let s = "为".repeat(300);
        assert_eq!(truncate_chars(&s, 200).chars().count(), 200);
        assert_eq!(truncate_chars("短文本", 200), "短文本");
    }

    #[test]
    fn 相对路径正斜杠() {
        let root = Path::new("/tmp/r");
        assert_eq!(rel_path(Path::new("/tmp/r/src/a.rs"), root), "src/a.rs");
        assert_eq!(rel_path(Path::new("/tmp/r"), root), "/tmp/r"); // 根自身兜底
        assert_eq!(rel_path(Path::new("/other/x"), root), "/other/x");
    }
}
