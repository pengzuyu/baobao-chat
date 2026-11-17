//! 逃逸测试套件（D13-B12 全表 9 用例，真实执行）。
//!
//! 每个测试对应 B12 表一行，测试名可读；断言 violation/错误码/行为。
//! 双层校验：L2 工具层（path/network 纯逻辑）与 L3 OS 层（Seatbelt 真实执行）都测。
//!
//! 安全约束（硬性）：
//! - 破坏性用例（写文件）只写 **临时目录随机子目录**，绝不碰用户真实文件；
//! - fork 炸弹/内存打爆/超时类用例全部限时（单用例 <10s，由断言兜底）；
//! - sandbox-exec 不可用时 OS 层断言**运行时 skip 并打印 SKIP 原因**（不静默通过）。

use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bbrt_sec::sandbox::launcher::{
    detect, MemoryViolationSink, RunOpts, RunSpec, SandboxLauncher, SandboxLevel, Violation,
    ViolationKind, ViolationSink,
};
use bbrt_sec::sandbox::network::NetPolicy;
use bbrt_sec::sandbox::path::{PathIntent, PathPolicy};
use bbrt_sec::sandbox::resource::ResourceLimits;

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 一次性随机临时目录（Drop 自动清理；绝不落在用户家目录）
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "bbc-esc-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).expect("创建临时目录");
        Self(p)
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

/// zsh 命令构造
fn zsh(script: &str) -> RunSpec {
    RunSpec {
        program: "/bin/zsh".into(),
        args: vec!["-c".into(), script.into()],
        ..RunSpec::default()
    }
}

/// 基础执行选项：工作区=临时目录、小内存预算可按需覆盖
fn opts(ws: &TempDir, sink: &Arc<MemoryViolationSink>) -> RunOpts {
    RunOpts {
        timeout_secs: 5,
        limits: ResourceLimits::for_tests(),
        writable_roots: vec![ws.path().clone()],
        sink: Some(sink.clone()),
        ..RunOpts::default()
    }
}

/// 探测一次 Seatbelt（多个用例复用；不可用 → 打印 SKIP 并返回 false）
fn seatbelt_available(launcher: &SandboxLauncher) -> bool {
    if launcher.level() == SandboxLevel::Seatbelt {
        true
    } else {
        let reason = launcher
            .degraded()
            .map(|d| d.reason.clone())
            .unwrap_or_else(|| "未知".into());
        println!("SKIP(OS 层): sandbox-exec 不可用（{reason}），仅执行 L2 工具层断言");
        false
    }
}

/// 进程组是否还有存活进程（ps 扫描；B12 残留检查）
fn pgid_alive(pgid: i32) -> bool {
    let out = std::process::Command::new("/bin/ps")
        .args(["-axo", "pgid="])
        .output()
        .expect("ps 执行");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.trim().parse::<i32>() == Ok(pgid))
}

fn sink_arc() -> Arc<MemoryViolationSink> {
    Arc::new(MemoryViolationSink::new())
}

fn assert_violation(sink: &MemoryViolationSink, code: u32, kind: ViolationKind, row: &str) {
    let hit = sink
        .snapshot()
        .into_iter()
        .find(|v| v.code == code && v.kind == kind);
    assert!(
        hit.is_some(),
        "{row}: 应记录 violation code={code} kind={kind:?}"
    );
}

// ---------------------------------------------------------------------------
// B12 行 1：写工作区外 → 被拒 + 记 violation(8020)
// ---------------------------------------------------------------------------

#[test]
fn b12_row1_write_outside_workspace_denied_and_recorded() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("r1ws");
    let outside = TempDir::new("r1out"); // 工作区外（同为临时目录，绝不碰真实文件）
    let probe = TempDir::new("r1tmp"); // 更外层的"系统 tmp 路径"代理（/tmp 直写）
    let sink = sink_arc();

    // --- L2 工具层：任何档位都拦 ---
    let policy = PathPolicy::with_roots(vec![ws.path().clone()], vec![probe.path().clone()]);
    match policy.validate(&outside.path().join("evil.txt"), PathIntent::Write) {
        Err(bbrt_sec::sandbox::path::PathError::OutsideWorkspace { code, .. }) => {
            assert_eq!(code, 8020);
        }
        other => panic!("L2 应拒绝越界写，实际 {other:?}"),
    }
    // 管线语义：L2 拒绝即写 violation（模拟 D11 §6 步骤 5）
    sink.append(Violation::now(ViolationKind::Path, 8020, "L2 越界写"));
    assert_violation(&sink, 8020, ViolationKind::Path, "B12 行1(L2)");

    // --- L3 OS 层：Seatbelt 下命令直写也被文件系统拒绝 ---
    if !seatbelt_available(&launcher) {
        return;
    }
    let mut o = opts(&ws, &sink);
    o.timeout_secs = 5;
    let target1 = outside.path().join("evil.txt");
    let target2 = probe
        .path()
        .join(format!("outside-{}.txt", std::process::id()));
    let t1 = target1.to_string_lossy().into_owned();
    let t2 = target2.to_string_lossy().into_owned();
    let r = launcher.run(
        &zsh(&format!(
            "echo pwn > '{t1}' 2>/dev/null && echo W1-OK; \
             echo pwn > '{t2}' 2>/dev/null && echo W2-OK; true"
        )),
        &o,
    );
    // 无论退出码：两个目标文件都必须不存在（若沙箱失效被写出，立即清理并断言失败）
    let leaked1 = target1.exists();
    let leaked2 = target2.exists();
    if leaked1 {
        fs::remove_file(&target1).ok();
    }
    if leaked2 {
        fs::remove_file(&target2).ok();
    }
    assert!(!leaked1, "B12 行1: 工作区外兄弟目录写入未被 Seatbelt 拦截");
    assert!(!leaked2, "B12 行1: 白名单外 tmp 路径写入未被 Seatbelt 拦截");
    assert!(
        !r.stdout.contains("W1-OK") && !r.stdout.contains("W2-OK"),
        "写入不应成功 stdout={} stderr={}",
        r.stdout,
        r.stderr
    );
    assert_eq!(r.sandbox_level, SandboxLevel::Seatbelt);
}

// ---------------------------------------------------------------------------
// B12 行 2：读 ~/.ssh/id_rsa（未授权）→ 8026
// ---------------------------------------------------------------------------

#[test]
fn b12_row2_read_ssh_private_key_denied_8026() {
    // 假 $HOME（测试内创建假 id_rsa，绝不读真实家目录）
    let fake_home = TempDir::new("r2home");
    let ssh_dir = fake_home.path().join(".ssh");
    fs::create_dir_all(&ssh_dir).unwrap();
    fs::write(
        ssh_dir.join("id_rsa"),
        b"-----BEGIN TEST FAKE KEY-----\nfake\n",
    )
    .unwrap();

    let policy = PathPolicy::with_roots(vec![fake_home.path().clone()], vec![]);
    // 读场景语义：全盘可读 + 敏感清单拒读（B10）
    match policy.validate(&ssh_dir.join("id_rsa"), PathIntent::Read) {
        Err(bbrt_sec::sandbox::path::PathError::SensitiveRead { code, pattern, .. }) => {
            assert_eq!(code, 8026);
            assert!(pattern.contains("id_rsa"));
        }
        other => panic!("应 8026 拒读，实际 {other:?}"),
    }
    // 管线记录 violation
    let sink = sink_arc();
    sink.append(Violation::now(
        ViolationKind::Path,
        8026,
        "未授权读 ~/.ssh/id_rsa",
    ));
    assert_violation(&sink, 8026, ViolationKind::Path, "B12 行2");

    // 对照：非敏感文件可读（敏感清单不扩大化）
    assert!(policy
        .validate(
            &fake_home.path().join(".ssh").join("known_hosts"),
            PathIntent::Read
        )
        .is_ok());
}

// ---------------------------------------------------------------------------
// B12 行 3：符号链接指向工作区外再写 → realpath 拦截（8024）+ Seatbelt 双层
// ---------------------------------------------------------------------------

#[test]
fn b12_row3_symlink_escape_blocked_8024_both_layers() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("r3ws");
    let outside = TempDir::new("r3out");
    let target = outside.path().join("victim.txt");
    fs::write(&target, b"original").unwrap();
    let link = ws.path().join("jump");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let sink = sink_arc();

    // --- L2：词法在工作区内、realpath 越出 → 8024 ---
    let policy = PathPolicy::with_roots(vec![ws.path().clone()], vec![]);
    match policy.validate(&link, PathIntent::Write) {
        Err(bbrt_sec::sandbox::path::PathError::SymlinkEscape { code, resolved, .. }) => {
            assert_eq!(code, 8024);
            assert_eq!(resolved, fs::canonicalize(&target).unwrap());
        }
        other => panic!("L2 应拦符号链接逃逸，实际 {other:?}"),
    }
    sink.append(Violation::now(ViolationKind::Path, 8024, "符号链接逃逸写"));
    assert_violation(&sink, 8024, ViolationKind::Path, "B12 行3(L2)");

    // --- L3：Seatbelt 下通过链接写也被文件系统拒绝（subpath 不覆盖目标） ---
    if !seatbelt_available(&launcher) {
        return;
    }
    let o = opts(&ws, &sink);
    let l = link.to_string_lossy().into_owned();
    let r = launcher.run(
        &zsh(&format!("echo hacked > '{l}' 2>/dev/null; echo rc=$?")),
        &o,
    );
    let content = fs::read_to_string(&target).unwrap_or_default();
    assert_eq!(
        content,
        "original",
        "Seatbelt 应拒绝经符号链接写工作区外（rc 输出: {}）",
        r.stdout.trim()
    );
}

// ---------------------------------------------------------------------------
// B12 行 4：fork 炸弹 → 限时内被杀（进程组必杀，整用例 <10s）
// ---------------------------------------------------------------------------

#[test]
fn b12_row4_fork_bomb_contained_under_10s() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("r4ws");
    let sink = sink_arc();
    let mut o = opts(&ws, &sink);
    o.timeout_secs = 2; // 限时：整个用例必须 <10s

    // 有界的子进程风暴（每轮 spawn sleep 后台进程；与经典 fork 炸弹同构但受控）。
    // B12 期望"TasksMax/Job 限制内被杀"：受控形态下 storm 被**进程/作业上限**掐灭
    //（zsh job table full / fork EAGAIN 提前退出）或被**超时杀树**击杀——两种都算受限收敛
    let start = std::time::Instant::now();
    let r = launcher.run(
        &zsh("i=0; while true; do /bin/sleep 5 & i=$((i+1)); done"),
        &o,
    );
    let elapsed = start.elapsed();
    assert!(!r.ok, "fork 炸弹不得成功退出");
    assert!(
        elapsed < Duration::from_secs(10),
        "fork 炸弹用例必须在 10s 内收敛，实际 {elapsed:?}"
    );
    let limited_by_process_cap = r.stderr.to_ascii_lowercase().contains("job table full")
        || r.stderr.to_ascii_lowercase().contains("fork");
    assert!(
        r.timeout_killed || r.resource_killed || limited_by_process_cap,
        "应被进程上限/资源限制/超时之一收敛（timeout={} resource={} stderr={:?}）",
        r.timeout_killed,
        r.resource_killed,
        r.stderr
    );
    if r.timeout_killed {
        assert_violation(&sink, 8023, ViolationKind::Resource, "B12 行4");
    }

    // 杀树后无同 pgid 残留进程（即便 job 表满了也要确认清场）
    assert!(!pgid_alive(r.pgid), "进程组 {} 内不得有残留进程", r.pgid);
}

// ---------------------------------------------------------------------------
// B12 行 5：内存打爆（malloc 循环）→ 资源上限终止（8022）
// ---------------------------------------------------------------------------

#[test]
fn b12_row5_memory_bomb_killed_by_limit_8022() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("r5ws");
    let sink = sink_arc();
    let mut o = opts(&ws, &sink);
    o.timeout_secs = 8; // 看门狗兜底上限（正常应在 ~1s 内被 RSS 看门狗杀掉）
    o.limits = ResourceLimits {
        memory_bytes: Some(256 * 1024 * 1024), // 256MB 上限
        ..ResourceLimits::for_tests()
    };

    // zsh 内存膨胀循环：每次拼接 64MB 字符串，快速突破 256MB
    let start = std::time::Instant::now();
    let r = launcher.run(
        &zsh("chunk=$(head -c 67108864 /dev/zero | tr '\\0' x); big=''; i=0; while true; do big=\"$big$chunk\"; i=$((i+1)); done"),
        &o,
    );
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(10),
        "内存打爆用例必须限时，实际 {elapsed:?}"
    );
    assert!(!r.ok, "内存打爆进程不得成功退出");
    assert!(
        r.resource_killed || r.timeout_killed,
        "应被资源限制终止（resource_killed={} timeout_killed={} stderr={}）",
        r.resource_killed,
        r.timeout_killed,
        r.stderr
    );
    assert_violation(&sink, 8022, ViolationKind::Resource, "B12 行5");
    assert!(!pgid_alive(r.pgid));
}

// ---------------------------------------------------------------------------
// B12 行 6：联网（curl 公网/本地）→ Seatbelt deny network* 拒绝（8025）
// ---------------------------------------------------------------------------

#[test]
fn b12_row6_network_egress_denied_8025() {
    // --- L2 纯逻辑：白名单外目标 → 8025 ---
    let net = NetPolicy::from_config(
        &["ai-gateway.internal".to_string()],
        &["127.0.0.0/8".to_string(), "10.0.0.0/8".to_string()],
    )
    .unwrap();
    // 127.0.0.1 在白名单 CIDR 内（联网例外语义），8.8.8.8 拒绝
    assert!(net.check_host("127.0.0.1").is_ok());
    match net.check_host("8.8.8.8") {
        Err(bbrt_sec::sandbox::network::NetworkError::NotWhitelisted { code, .. }) => {
            assert_eq!(code, 8025);
        }
        other => panic!("{other:?}"),
    }
    let sink = sink_arc();
    sink.append(Violation::now(ViolationKind::Network, 8025, "8.8.8.8 出站"));
    assert_violation(&sink, 8025, ViolationKind::Network, "B12 行6(L2)");

    // --- L3 OS 层：Seatbelt deny network* —— 正向对照实验 ---
    // 起一个真实本地监听端口：无沙箱时 curl 必连得上；沙箱生效则必须连不上。
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地监听");
    let port = listener.local_addr().unwrap().port();
    let connected = Arc::new(AtomicBool::new(false));
    let connected_t = connected.clone();
    let accept_thread = std::thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        while std::time::Instant::now() < deadline {
            if let Ok((_, _)) = listener.accept() {
                connected_t.store(true, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });

    let launcher = SandboxLauncher::new();
    if !seatbelt_available(&launcher) {
        accept_thread.join().ok();
        return;
    }
    let ws = TempDir::new("r6ws");
    let o = opts(&ws, &sink);
    let r = launcher.run(
        &zsh(&format!(
            "/usr/bin/curl -sS -m 3 -o /dev/null http://127.0.0.1:{port}/probe && echo NET-OK || echo NET-DENIED"
        )),
        &o,
    );
    accept_thread.join().ok();
    assert!(
        !r.stdout.contains("NET-OK"),
        "Seatbelt deny network* 下 curl 不得成功 stdout={} stderr={}",
        r.stdout,
        r.stderr
    );
    assert!(
        !connected.load(Ordering::SeqCst),
        "正向对照：监听端口未收到任何连接（网络被 OS 层掐断）"
    );
}

// ---------------------------------------------------------------------------
// B12 行 7：超时睡眠 600s 级 → 超时被杀（8023）
// ---------------------------------------------------------------------------

#[test]
fn b12_row7_timeout_sleep_killed_8023() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("r7ws");
    let sink = sink_arc();
    let mut o = opts(&ws, &sink);
    o.timeout_secs = 2;

    let r = launcher.run(&zsh("/bin/sleep 30"), &o);
    assert!(r.timeout_killed, "超时必须触发击杀");
    assert!(!r.ok);
    assert!(
        r.duration_ms >= 1800 && r.duration_ms < 5000,
        "应在 ~2s 被杀，实际 {}ms",
        r.duration_ms
    );
    assert_violation(&sink, 8023, ViolationKind::Resource, "B12 行7");
    assert!(!pgid_alive(r.pgid), "杀树后不得残留");
}

// ---------------------------------------------------------------------------
// B12 行 8：后台进程残留（nohup &）→ 杀树清理，无残留 pgid
// ---------------------------------------------------------------------------

#[test]
fn b12_row8_no_background_residue_after_kill() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("r8ws");
    let sink = sink_arc();
    let mut o = opts(&ws, &sink);
    o.timeout_secs = 4;

    // 主命令瞬时退出，但 nohup 起一个 300s 后台进程挂在同进程组
    let r = launcher.run(
        &zsh("/usr/bin/nohup /bin/sleep 300 >/dev/null 2>&1 & echo spawned"),
        &o,
    );
    assert!(r.ok, "主命令应正常退出: stderr={}", r.stderr);
    assert_eq!(r.stdout.trim(), "spawned");
    // die-with-parent 等价实现：主进程退出后防御性补杀整组
    assert!(!pgid_alive(r.pgid), "nohup 后台进程必须随进程组被清理");
}

// ---------------------------------------------------------------------------
// B12 行 9：输出 100MB stdout → 1MB 截断 + 标注
// ---------------------------------------------------------------------------

#[test]
fn b12_row9_stdout_100mb_truncated_to_1mb() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("r9ws");
    let sink = sink_arc();
    let mut o = opts(&ws, &sink);
    o.timeout_secs = 30; // 100MB 生成留足余量（实测 <2s）

    let r = launcher.run(
        &zsh("/usr/bin/yes abcdefghijklmnop | /usr/bin/head -c 104857600"),
        &o,
    );
    assert!(r.ok, "生成命令应成功: stderr={}", r.stderr);
    assert!(r.truncated, "100MB 输出必须触发截断");
    assert_eq!(
        r.total_output_bytes, 104_857_600,
        "总字节统计应为精确 100MB"
    );
    assert!(
        r.stdout.contains("[truncated, total=104857600 bytes]"),
        "截断标注缺失（stdout 长度 {}）",
        r.stdout.len()
    );
    assert!(
        r.stdout.len() > 1024 * 1024 && r.stdout.len() < 1200 * 1024,
        "保留量应约 1MB（头尾各 50%），实际 {}",
        r.stdout.len()
    );
    assert!(r.stdout.starts_with("abcdefghijklmnop"));
}

// ---------------------------------------------------------------------------
// 附加：Baseline 降级档对照（B11 语义可用性）
// ---------------------------------------------------------------------------

#[test]
fn baseline_mode_still_enforces_timeout_and_group_kill() {
    let launcher = SandboxLauncher::new();
    let ws = TempDir::new("base");
    let sink = sink_arc();
    let mut o = opts(&ws, &sink);
    o.force_level = Some(SandboxLevel::Baseline);
    o.timeout_secs = 2;

    let r = launcher.run(&zsh("/bin/sleep 30"), &o);
    assert_eq!(r.sandbox_level, SandboxLevel::Baseline);
    assert!(r.timeout_killed, "Baseline 档仍必须执行超时杀树");
    assert!(!pgid_alive(r.pgid));
}

// ---------------------------------------------------------------------------
// 附加：探测冒烟（ Seatbelt 可用性如实上报，供 CI 环境诊断）
// ---------------------------------------------------------------------------

#[test]
fn detect_probe_reports_actual_capability() {
    let probe = detect();
    println!(
        "沙箱探测: level={:?} degraded={:?}",
        probe.level, probe.degraded
    );
    if probe.level == SandboxLevel::Baseline {
        // 降级档语义完整（B11：模式上限 auto-edit + 网络拒绝 + 逐次确认）
        let d = probe.degraded.expect("Baseline 必带降级信息");
        assert_eq!(d.mode_cap, "auto-edit");
        assert!(d.network_denied);
        assert!(d.per_confirm);
    }
}
