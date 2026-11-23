//! run_command 工具（D11 §2.4 builtin/cmd.rs；D13-B9 分层防御管线的编排层）。
//!
//! 执行路径（09 §4.3）：
//! 1. 命令文本解析（`command` 字符串 / `cmd` 字符串或数组；词法切分支持单双引号）；
//! 2. cwd 校验 ∈ 工作区（Write 意图，8020）；
//! 3. **L2 词法写意图预检**：重定向目标（`>`/`>>`/`2>`）与写类命令的操作数路径
//!    逐一经 PathPolicy.validate(Write) 校验，越界 → violation + blocked（8020/8024）；
//! 4. program 解析为绝对路径；
//! 5. SandboxLauncher 真实执行：violation sink、超时/资源超限映射 8023/8022、
//!    输出截断标注（launcher 内建 1MB 头尾各 50%）。
//!
//! 预检（步骤 3）是词法启发式（v0.1）；D32 起 Seatbelt OS 层退场，词法预检
//! （本步骤 + PathPolicy）即命令写路径的唯一确定性防线。

use std::path::{Path, PathBuf};

use bbrt_sec::errors::{CODE_RESOURCE_LIMIT, CODE_TIMEOUT};
use bbrt_sec::gate::ActionCategory;
use bbrt_sec::sandbox::launcher::{ExitResult, RunOpts, RunSpec, DEFAULT_TIMEOUT_SECS};
use bbrt_sec::sandbox::path::{PathError, PathIntent};
use serde_json::{json, Value};

use super::{deny, str_arg, timed, ExecEnv, ExecOutput, ToolBlock};
use crate::registry::{RiskLevel, ToolDef};

/// 参数族错误码（14 篇：8002 工具未授权/不可执行）
const CODE_TOOL_ARGS: u32 = 8002;

/// 写类命令清单：后续非 flag 操作数按写意图校验（cp/mv/install/rsync 单独取末操作数）
const WRITE_CMDS: [&str; 9] = [
    "touch", "mkdir", "rm", "rmdir", "tee", "truncate", "dd", "chmod", "chown",
];

/// 带源/目的语义的命令：仅末位非 flag 操作数是写目标
const SRC_DST_CMDS: [&str; 4] = ["cp", "mv", "install", "rsync"];

/// 永久放行的写目标（命令通用出口）
const ALWAYS_OK_TARGETS: [&str; 1] = ["/dev/null"];

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// run_command 实现
pub(crate) fn run(env: &ExecEnv, args: &Value) -> Result<ExecOutput, ToolBlock> {
    let cmd_text = command_text(args)
        .ok_or_else(|| deny(CODE_TOOL_ARGS, "run_command 缺少 command/cmd 参数"))?;
    let (result, _ms) = timed(|| -> Result<ExecOutput, ToolBlock> {
        let spec = prepare_run_spec(env, args, &cmd_text)?;
        let opts = base_run_opts(env);
        run_with_launcher(env, spec, opts)
    });
    result
}

/// 校验 + RunSpec 组装（cwd 白名单/词法预检/执行形态——同步 run 与
/// 后台 spawn_background 共用，统一后台任务体系 2026-11-18）
pub(crate) fn prepare_run_spec(
    env: &ExecEnv,
    args: &Value,
    cmd_text: &str,
) -> Result<RunSpec, ToolBlock> {
    // cwd：默认工作区；显式给出则须在工作区白名单内（相对路径以工作区根为基准；8020）
    let cwd = match str_arg(args, "cwd") {
        Some(c) => {
            let cwd_buf = super::resolve_against(&env.workspace, &c);
            match env.path_policy.validate(&cwd_buf, PathIntent::Write) {
                Ok(p) => p,
                Err(e) => {
                    let code = path_error_code(&e);
                    env.record_violation(
                        bbrt_sec::sandbox::launcher::ViolationKind::Path,
                        code,
                        format!("run_command cwd 越界: {e}"),
                    );
                    return Err(deny(code, format!("cwd {c} 不在工作区白名单内（{code}）")));
                }
            }
        }
        None => env.workspace.clone(),
    };

    // L2 词法写意图预检（越界 → violation + blocked 8020/8024）
    precheck_write_targets(env, cmd_text, &cwd)?;

    // 执行形态：cmd 数组 → 直接 exec（program+args）；
    // 命令字符串 → /bin/sh -c（重定向/管道等 shell 语义由 sh 解释，预检已扫过写目标）
    Ok(match cmd_array(args) {
        Some(parts) if !parts.is_empty() => {
            let (program, rest) = parts.split_first().expect("非空已确认");
            RunSpec {
                program: resolve_program(program),
                args: rest.to_vec(),
                cwd: Some(cwd),
                env: Vec::new(),
            }
        }
        _ => shell_spec(cmd_text, cwd),
    })
}

/// 命令字符串 → shell 解释形态（重定向/管道等 shell 语义由对应 shell 解释，
/// 预检已扫过写目标）：unix=/bin/sh -c；windows=cmd /C
fn shell_spec(cmd_text: &str, cwd: PathBuf) -> RunSpec {
    #[cfg(unix)]
    {
        RunSpec {
            program: resolve_program("sh"),
            args: vec!["-c".to_string(), cmd_text.to_string()],
            cwd: Some(cwd),
            env: Vec::new(),
        }
    }
    #[cfg(windows)]
    {
        RunSpec {
            program: resolve_program("cmd"),
            args: vec!["/C".to_string(), cmd_text.to_string()],
            cwd: Some(cwd),
            env: Vec::new(),
        }
    }
}

/// cmd 数组形态提取（[program, args...]；非数组返回 None）
fn cmd_array(args: &Value) -> Option<Vec<String>> {
    let arr = args.get("cmd")?.as_array()?;
    let parts: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .filter(|s| !s.is_empty())
        .collect();
    Some(parts)
}

// ---------------------------------------------------------------------------
// 共享执行辅助（git/http 复用）
// ---------------------------------------------------------------------------

/// 组装标准 RunOpts：violation sink + 默认超时 300s
/// （D32 起 launcher 无 OS 沙箱层，可写根不再随执行器下发——
/// 词法围栏由本 builtin 的 precheck_write_targets/PathPolicy 承担）
pub(crate) fn base_run_opts(env: &ExecEnv) -> RunOpts {
    RunOpts {
        timeout_secs: DEFAULT_TIMEOUT_SECS,
        sink: Some(std::sync::Arc::clone(&env.sink)),
        ..RunOpts::default()
    }
}

/// 经 SandboxLauncher 执行并映射结果：超时 8023 / 资源超限 8022 / 其余 Ok（含非零退出）
pub(crate) fn run_with_launcher(
    env: &ExecEnv,
    spec: RunSpec,
    opts: RunOpts,
) -> Result<ExecOutput, ToolBlock> {
    let r: ExitResult = env.launcher.run(&spec, &opts);
    if r.timeout_killed {
        // launcher 已记 violation（8023）；此处映射阻断语义
        return Err(deny(
            CODE_TIMEOUT,
            format!("命令超时被终止（8023）：{}ms", r.duration_ms),
        ));
    }
    if r.resource_killed {
        return Err(deny(
            CODE_RESOURCE_LIMIT,
            format!("进程资源超限被终止（8022）：{}ms", r.duration_ms),
        ));
    }
    Ok(ExecOutput {
        summary: exit_summary(&r),
        truncated: r.truncated,
        exit_code: r.exit_code,
        duration_ms: r.duration_ms as u64,
    })
}

/// ExitResult → 结果摘要文本（同步/后台/超时转后台三路共用组装口径；
/// loop_runner 后台线程有一份对齐的字符串版——改这里时同步那边）
pub(crate) fn exit_summary(r: &ExitResult) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !r.stdout.trim().is_empty() {
        parts.push(r.stdout.trim_end().to_string());
    }
    if !r.stderr.trim().is_empty() {
        parts.push(format!("[stderr]\n{}", r.stderr.trim_end()));
    }
    if r.exit_code != Some(0) {
        parts.push(format!(
            "[exit_code={}]",
            r.exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into())
        ));
    }
    if r.truncated {
        parts.push(format!(
            "[输出超 1MB 截断，total={} bytes]",
            r.total_output_bytes
        ));
    }
    parts.join("\n")
}

/// 命令文本提取：`command`（gate 分类同名字段）优先，`cmd` 别名（字符串或数组）兜底
pub(crate) fn command_text(args: &Value) -> Option<String> {
    if let Some(c) = args.get("command").and_then(Value::as_str) {
        if !c.trim().is_empty() {
            return Some(c.trim().to_string());
        }
    }
    match args.get("cmd") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Array(a)) if !a.is_empty() => {
            let parts: Vec<String> = a
                .iter()
                .map(|v| v.as_str().unwrap_or_default().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" "))
            }
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 词法解析
// ---------------------------------------------------------------------------

/// 词法切分（空白分隔；单/双引号成组保留内容、引号剥离；v0.1 不解变量与转义）
pub(crate) fn tokenize(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for ch in cmd.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                c if c.is_whitespace() => {
                    if !cur.is_empty() {
                        tokens.push(std::mem::take(&mut cur));
                    }
                }
                c => cur.push(c),
            },
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

/// program 解析为绝对路径：含 / 原样；否则按 PATH（+常见兜底目录）查存在文件
#[cfg(unix)]
pub(crate) fn resolve_program(program: &str) -> String {
    if program.contains('/') {
        return program.to_string();
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for d in ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"] {
        dirs.push(PathBuf::from(d));
    }
    for dir in dirs {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    program.to_string() // 找不到：交给 spawn 报错（不在此伪造失败码）
}

/// Windows：PATH 搜索按 PATHEXT 后缀族探测（.exe/.cmd/…；cmd 内建如 dir 无可执行
/// 文件——返回原名交 spawn 报错，同 unix 口径）；带分隔符的（/ 或 \）视为已解析路径
#[cfg(windows)]
pub(crate) fn resolve_program(program: &str) -> String {
    if program.contains('/') || program.contains('\\') {
        return program.to_string();
    }
    let exts: Vec<String> = std::env::var("PATHEXT")
        .map(|v| {
            v.split(';')
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_else(|_| vec![".exe".into(), ".cmd".into(), ".bat".into()]);
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for dir in dirs {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
        for ext in &exts {
            let with_ext = dir.join(format!("{program}{ext}"));
            if with_ext.is_file() {
                return with_ext.to_string_lossy().into_owned();
            }
        }
    }
    program.to_string() // 找不到：交给 spawn 报错（不在此伪造失败码）
}

// ---------------------------------------------------------------------------
// L2 写意图预检
// ---------------------------------------------------------------------------

/// 重定向形态：无 / 目标在下一 Token / 目标连写在当前 Token
enum RedirectForm<'a> {
    /// 不是重定向
    None,
    /// `>` / `>>` / `2>` 等后跟空目标 → 目标取下一 Token
    Separate,
    /// `>file` / `2>>file` 连写，携带内联目标
    Inline(&'a str),
}

/// 判定 Token 的重定向形态（fd 前缀限 0-2 位数字；`2>&1` 的 & 目标由调用方过滤）
fn redirect_form(t: &str) -> RedirectForm<'_> {
    let Some(idx) = t.find('>') else {
        return RedirectForm::None;
    };
    let prefix = &t[..idx];
    let is_redirect = idx == 0 || (prefix.len() <= 2 && prefix.chars().all(|c| c.is_ascii_digit()));
    if !is_redirect {
        return RedirectForm::None;
    }
    let rest = t[idx..].trim_start_matches('>');
    if rest.is_empty() {
        RedirectForm::Separate
    } else {
        RedirectForm::Inline(rest)
    }
}

/// 提取命令中的写意图目标路径：
/// - 重定向：`>`、`>>`、`2>`（独立或连写形态）；
/// - 写类命令（touch/rm/...）的非 flag 操作数；cp/mv/install/rsync 仅取末操作数。
fn write_targets(tokens: &[String]) -> Vec<String> {
    let program = tokens.first().map(|s| basename(s)).unwrap_or_default();
    let operands = tokens
        .iter()
        .skip(1)
        .filter(|t| !t.starts_with('-'))
        .collect::<Vec<_>>();
    let mut targets: Vec<String> = Vec::new();
    // 1) 重定向（任意命令）
    let mut iter = tokens.iter().peekable();
    while let Some(t) = iter.next() {
        match redirect_form(t) {
            RedirectForm::None => {}
            RedirectForm::Inline(target) => {
                if !target.starts_with('&') {
                    targets.push(target.to_string());
                }
            }
            RedirectForm::Separate => {
                if let Some(next) = iter.peek() {
                    if !next.starts_with('&') {
                        targets.push((*next).clone());
                    }
                }
            }
        }
    }
    // 2) 写类命令操作数
    if WRITE_CMDS.contains(&program.as_str()) {
        targets.extend(operands.iter().map(|s| (*s).clone()));
    } else if SRC_DST_CMDS.contains(&program.as_str()) {
        if let Some(last) = operands.last() {
            targets.push((*last).clone());
        }
    }
    targets
}

/// basename（最后一段）
fn basename(p: &str) -> String {
    p.rsplit('/').next().unwrap_or(p).to_string()
}

/// 写意图预检：目标 ∈ 工作区白名单（相对路径按 cwd 解析）；越界 → violation + 8020/8024
fn precheck_write_targets(env: &ExecEnv, cmd: &str, cwd: &Path) -> Result<(), ToolBlock> {
    let tokens = tokenize(cmd);
    for target in write_targets(&tokens) {
        if ALWAYS_OK_TARGETS.contains(&target.as_str()) || target.starts_with('&') {
            continue;
        }
        let abs = if target.starts_with('/') {
            PathBuf::from(&target)
        } else {
            cwd.join(&target)
        };
        if let Err(e) = env.path_policy.validate(&abs, PathIntent::Write) {
            let code = path_error_code(&e);
            env.record_violation(
                bbrt_sec::sandbox::launcher::ViolationKind::Path,
                code,
                format!("命令写目标越界: {target}（{e}）"),
            );
            return Err(deny(
                code,
                format!("命令写目标 {target} 不在工作区白名单内（{code}）"),
            ));
        }
    }
    Ok(())
}

/// PathError → 错误码
fn path_error_code(e: &PathError) -> u32 {
    match e {
        PathError::OutsideWorkspace { code, .. }
        | PathError::SymlinkEscape { code, .. }
        | PathError::SensitiveRead { code, .. } => *code,
    }
}

// ---------------------------------------------------------------------------
// ToolDef 导出
// ---------------------------------------------------------------------------

/// run_command 工具定义（D13-A2 行 3/4/5：白名单/任意/高危，类别随 args 动态）
pub fn run_command_def() -> ToolDef {
    ToolDef {
        name: "run_command".into(),
        description: "在沙箱中执行 shell 命令（工作区可写、默认断网、输出 1MB 截断）。\
                      command 传命令文本（兼容 cmd 字符串/数组形态）；cwd 默认工作区。\
                      默认同步执行：超过 300s 未完成会自动转后台（不中断），返回任务 id\
                      由 task.wait 取结果——无需预判时长，正常直接调用即可"
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "命令文本（首选字段）"},
                "cmd": {"type": ["string", "array"],
                        "description": "命令别名：字符串或 [program, args...] 数组"},
                "cwd": {"type": "string", "description": "工作目录（须在工作区内，默认工作区根）"},
                "background": {"type": "boolean", "description": "低优先级选项：仅当明确预知任务远超 300s 且不想占用当前轮等待时才设 true（立即返回任务 id）；一般不用设——超时会自动转后台"}
            },
            "required": ["command"]
        }),
        risk: RiskLevel::High,
        category: ActionCategory::ArbitraryCommand,
    }
}

// ---------------------------------------------------------------------------
// 单元测试：词法解析与写意图提取（纯逻辑）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bbrt_sec::sandbox::launcher::SandboxLauncher;
    use std::fs;

    #[test]
    fn 词法切分_引号成组() {
        assert_eq!(tokenize("echo a b"), vec!["echo", "a", "b"]);
        assert_eq!(
            tokenize("git commit -m \"a b c\""),
            vec!["git", "commit", "-m", "a b c"]
        );
        assert_eq!(tokenize("echo 'x  y'"), vec!["echo", "x  y"]);
        assert_eq!(tokenize("  "), Vec::<String>::new());
    }

    #[test]
    fn 写目标提取_重定向与命令形态() {
        // 重定向独立 token
        let t = tokenize("echo hi > /tmp/out.txt");
        assert_eq!(write_targets(&t), vec!["/tmp/out.txt"]);
        // 连写 2>/var/log/x 与分离形态 2> /var/log/x
        assert_eq!(
            write_targets(&tokenize("sh gen.sh 2>/var/log/x")),
            vec!["/var/log/x"]
        );
        assert_eq!(
            write_targets(&tokenize("sh gen.sh 2> /var/log/x")),
            vec!["/var/log/x"]
        );
        // /dev/null 与 & 不进目标
        let t = tokenize("cmd > /dev/null 2>&1");
        assert_eq!(write_targets(&t), vec!["/dev/null"]);
        // touch：全部非 flag 操作数。-t 的时间戳参数（202001010000）也进清单——
        // 词法层无法区分 flag 值与路径；它按 cwd 解析落在工作区内，不造成误拦
        let t = tokenize("touch -t 202001010000 a.txt /etc/hosts");
        assert_eq!(
            write_targets(&t),
            vec!["202001010000", "a.txt", "/etc/hosts"]
        );
        // cp：仅末操作数
        let t = tokenize("cp /etc/hosts out.txt");
        assert_eq!(write_targets(&t), vec!["out.txt"]);
        // 只读命令：无写目标
        let t = tokenize("cargo test --lib");
        assert!(write_targets(&t).is_empty());
    }

    #[test]
    fn 命令文本_command优先cmd兜底() {
        assert_eq!(
            command_text(&json!({"command": "echo a"})),
            Some("echo a".to_string())
        );
        assert_eq!(
            command_text(&json!({"cmd": "echo b"})),
            Some("echo b".to_string())
        );
        assert_eq!(
            command_text(&json!({"cmd": ["echo", "c"]})),
            Some("echo c".to_string())
        );
        assert_eq!(command_text(&json!({})), None);
        assert_eq!(command_text(&json!({"command": "  "})), None);
    }

    #[test]
    fn program解析_绝对路径查表() {
        // 绝对/相对含 / 原样
        assert_eq!(resolve_program("/bin/echo"), "/bin/echo");
        assert_eq!(resolve_program("./local/tool"), "./local/tool");
        // 裸名解析到系统目录（macOS/linux 皆有 /bin/echo）
        assert_eq!(resolve_program("echo"), "/bin/echo");
        // 不存在的名字原样返回（交给 spawn 报错）
        assert_eq!(
            resolve_program("definitely-not-exist-xyz"),
            "definitely-not-exist-xyz"
        );
    }

    #[test]
    fn 进程执行器默认构造可用() {
        // D32 起 launcher 无探测/等级概念；这里只验证类型可构造（编译期契约）
        let _l: SandboxLauncher = SandboxLauncher::new();
        let _ = fs::canonicalize("/tmp");
    }
}
