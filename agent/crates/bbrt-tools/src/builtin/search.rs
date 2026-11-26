//! search_files 工具（D11 §2.4 builtin/search.rs；命中 ≤200 条截断标注）。
//!
//! 自写实现（不引 glob/walkdir 依赖）：
//! - pattern 含 `*` 或 `?` → 文件名 glob 匹配（递归）；
//! - 否则 → 文件名子串 + **内容子串** 双匹配（内容命中给出首个命中行，截 200 字）；
//! - 递归遍历不跟随符号链接（防越出工作区的遍历逃逸），跳过 .git/target/node_modules
//!   （性能；v0.1 约定），命中超过 200 条停止并尾部标注 `[truncated, hits=N, showing 200]`；
//! - 扫描文件数设 20000 上限（防御超大目录把会话卡死，D11 §12 边界）。

use std::fs;
use std::path::Path;

use bbrt_sec::gate::ActionCategory;
use serde_json::json;

use super::{deny, str_arg, timed, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 命中条数上限（D11 §2.4：命中 ≤200）
pub const MAX_HITS: usize = 200;

/// 扫描文件数上限（防御性边界）
const MAX_FILES_SCANNED: usize = 20_000;

/// 单文件内容读取上限（超大文件只在前 1MB 内匹配）
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// 跳过的目录名（性能约定）
const SKIP_DIRS: [&str; 3] = [".git", "target", "node_modules"];

/// search_files 实现
pub(crate) fn search_files(
    env: &ExecEnv,
    args: &serde_json::Value,
) -> Result<ExecOutput, ToolBlock> {
    let pattern =
        str_arg(args, "pattern").ok_or_else(|| deny(8002, "search_files 缺少 pattern 参数"))?;
    let root_arg = str_arg(args, "path");

    let (result, ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        // 根目录解析：默认工作区；相对路径以工作区根为基准；读授权统一入口
        // （2026-11-26 审批化：工作区内自动/附件/票据/full-auto；敏感红卡）
        let raw_root = root_arg
            .map(|p| super::resolve_against(&env.workspace, &p))
            .unwrap_or_else(|| env.workspace.clone());
        let root = super::read_access::authorize_read(env, "search_files", &raw_root)?;

        let is_glob = pattern.contains('*') || pattern.contains('?');
        let mut state = WalkState {
            hits: Vec::new(),
            hits_capped: false,
            files_scanned: 0,
            scan_capped: false,
        };
        walk(&root, &pattern, is_glob, &mut state);

        let mut summary = state.hits.join("\n");
        if state.hits_capped {
            summary.push_str(&format!("\n[truncated, showing {MAX_HITS}]"));
        }
        if state.scan_capped {
            summary.push_str(&format!(
                "\n[scan capped at {MAX_FILES_SCANNED} files, results may be incomplete]"
            ));
        }
        if state.hits.is_empty() && !state.hits_capped {
            summary = format!("未命中：{pattern}（根 {}）", root.display());
        }
        Ok(ExecOutput {
            summary,
            truncated: state.hits_capped || state.scan_capped,
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

/// 遍历状态（命中收集 + 截断旗标）
struct WalkState {
    hits: Vec<String>,
    /// 命中达 200 上限且仍有未遍历条目（截断标注依据）
    hits_capped: bool,
    files_scanned: usize,
    scan_capped: bool,
}

/// 递归遍历（不跟随符号链接；命中满 200 或扫描满上限即收敛）
fn walk(dir: &Path, pattern: &str, is_glob: bool, state: &mut WalkState) {
    if state.hits.len() >= MAX_HITS || state.files_scanned >= MAX_FILES_SCANNED {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return; // 无权限/已删除等：跳过该目录（尽力遍历）
    };
    for entry in entries.flatten() {
        if state.hits.len() >= MAX_HITS {
            // 上限截断：目录里还有未处理条目
            state.hits_capped = true;
            return;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if ft.is_dir() {
            // 不跟随符号链接目录（防遍历逃逸）；跳过约定目录
            let name = entry.file_name().to_string_lossy().into_owned();
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&path, pattern, is_glob, state);
        } else if ft.is_file() {
            if state.files_scanned >= MAX_FILES_SCANNED {
                state.scan_capped = true;
                return;
            }
            state.files_scanned += 1;
            if let Some(hit) = match_file(&path, pattern, is_glob) {
                state.hits.push(hit);
            }
        }
    }
}

/// 单文件匹配：文件名（glob/子串）+ 内容子串；返回展示行（文件名命中优先短格式）
fn match_file(path: &Path, pattern: &str, is_glob: bool) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let name_hit = if is_glob {
        glob_match(pattern, &name)
    } else {
        name.contains(pattern)
    };
    if name_hit {
        return Some(path.display().to_string());
    }
    if is_glob {
        return None; // glob 模式只匹配文件名
    }
    // 内容子串匹配：读前 1MB；跳过敏感文件（8026 口径——搜索不泄露密钥内容）
    if is_sensitive_name(&name) {
        return None; // 敏感文件静默跳过（不产生 violation：搜索是只读枚举）
    }
    let Ok(meta) = fs::metadata(path) else {
        return None;
    };
    if meta.len() > MAX_FILE_BYTES {
        // 超大文件只取头部 1MB（尽力匹配）
        return read_head(path).and_then(|text| content_line(path, &text, pattern));
    }
    let text = fs::read_to_string(path).unwrap_or_default();
    content_line(path, &text, pattern)
}

/// 敏感文件名判定（复用 bbrt-context 名单；搜索结果不泄露敏感文件内容）
fn is_sensitive_name(name: &str) -> bool {
    bbrt_context::excerpt::is_sensitive_path(name)
}

/// 读文件头 1MB（有损转 String）
fn read_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut f = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; MAX_FILE_BYTES as usize];
    let n = f.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 内容命中 → 展示行 "path:首个命中行"（行截 200 字）
fn content_line(path: &Path, text: &str, pattern: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains(pattern))?;
    // 2026-11-23 修「search_files 卡死」：line.len() 是字节数，中文等多字节
    // 字符下 200 落在字符中间时 &line[..200] 直接 panic（现场：'为' 198..201）——
    // 工具线程一死 tool.result/turn.end 全断，会话永久执行中且无法停止。
    // 回退到 ≤200 的最近字符边界再切。
    let line = if line.len() > 200 {
        let mut end = 200;
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        &line[..end]
    } else {
        line
    };
    Some(format!("{}:{}", path.display(), line.trim()))
}

/// 极简 glob（`*` 任意序列、`?` 单字符；大小写敏感）——递归回溯实现
fn glob_match(pattern: &str, text: &str) -> bool {
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

// 读边界 ensure_inside_roots 已退役（2026-11-26 读审批化）——根目录走
// read_access::authorize_read 统一入口（见 builtin/read_access.rs）。

/// search_files 工具定义（D13-A2 行 1：只读，全档自动）
pub fn search_files_def() -> ToolDef {
    ToolDef {
        name: "search_files".into(),
        description: "Recursive search: if pattern contains * or ?, match file names by glob; \
                      otherwise match both file names and file contents by substring (content \
                      hits show the first matching line); returns at most 200 entries, \
                      truncated with a marker beyond that"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Search pattern (glob or substring)"},
                "path": {"type": "string", "description": "Search root directory (absolute, ~/ or relative; defaults to the workspace; outside-root search asks for approval)"}
            },
            "required": ["pattern"]
        }),
        risk: RiskLevel::Low,
        category: ActionCategory::ReadOnly,
    }
}
