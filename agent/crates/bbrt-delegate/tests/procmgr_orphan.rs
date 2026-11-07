//! 遗留进程扫描清理集成测试（D11 §8.4 / 09 §4.6）。
//!
//! 场景：spawn 一个"孤儿制造器"（父立即退出，留下带 BBW_SANDBOX=1 标记 + 唯一
//! 命令标记的死循环 shell → reparent 到 ppid=1）→ scan_orphans 按（标记+父死+过滤）
//! 找到 → cleanup_orphans SIGKILL 清理 → 复扫为空。
//! 附：存活且父在的自身委派进程不被误杀（pgid/父活过滤回归）。

mod common;

use bbrt_delegate::procmgr;
use common::{write_script, TestDir};
use std::time::{Duration, Instant};

/// 轮询直至条件满足（真）或超时（返回 false）
fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if pred() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn orphan_scan_finds_and_cleanup_kills_marked_orphans() {
    let dir = TestDir::new("orphan");
    // 唯一标记进 argv（$0 位）：macOS ps 无 env 视图，标记验证退化为命令过滤
    //（BBW_SANDBOX=1 env 由 procmgr::spawn 注入并被子进程继承，Linux 上经 /proc 精确验证）
    let tag = format!(
        "BBWORPHAN-{}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    );
    let body = format!("#!/bin/sh\nsh -c 'while true; do sleep 1; done' \"{tag}\" &\nexit 0\n");
    let stub = write_script(dir.path(), "maker.sh", &body);

    // 经 procmgr 启动（注入 BBW_SANDBOX=1 + 新进程组）；制造器父进程立即退出。
    // 注意用 wait（不杀组）收割：孤儿与制造器同组，cancel 的组杀会把孤儿一并杀掉
    let (maker, _stdout) = procmgr::spawn(&stub, &[], None, &[]).unwrap();
    let st = maker.wait().unwrap();
    assert!(st.success(), "孤儿制造器应正常退出");

    // 扫描出现（reparent 与 ps 表更新有延迟，轮询等待）
    let found = wait_until(Duration::from_secs(10), || {
        !procmgr::scan_orphans(Some(&tag)).is_empty()
    });
    assert!(found, "10s 内应扫描到带标记孤儿（ppid=1）");
    let orphans = procmgr::scan_orphans(Some(&tag));
    assert!(
        orphans.iter().all(|o| o.ppid == 1 || o.ppid == 0),
        "孤儿父进程应已死: {orphans:?}"
    );
    // 命令行含唯一标记
    assert!(orphans.iter().all(|o| o.command.contains(&tag)));

    // 清理（SIGKILL 组+进程）→ 复扫为空（僵尸由 launchd 回收，轮询等待消失）
    let cleaned = procmgr::cleanup_orphans(Some(&tag));
    assert!(!cleaned.is_empty(), "清理应命中扫描到的孤儿");
    let gone = wait_until(Duration::from_secs(10), || {
        procmgr::scan_orphans(Some(&tag)).is_empty()
    });
    assert!(gone, "清理后复扫应为空");
    // 幂等：再清理为空
    assert!(procmgr::cleanup_orphans(Some(&tag)).is_empty());
}

#[test]
fn live_child_of_ours_is_not_matched_as_orphan() {
    // 存活且父进程（本测试进程）健在的委派子进程：不满足"父已死"→ 不入扫描
    let dir = TestDir::new("live");
    let tag = format!("BBWLIVE-{}", std::process::id());
    let body = format!("#!/bin/sh\nwhile true; do sleep 1; done # {tag}\n");
    let stub = write_script(dir.path(), "live.sh", &body);
    let (proc, _stdout) = procmgr::spawn(&stub, &[], None, &[]).unwrap();
    let pid = proc.pid();
    assert!(proc.pgid == pid);

    let matched = procmgr::scan_orphans(Some(&tag));
    assert!(
        matched.iter().all(|o| o.pid != pid),
        "父进程存活的子进程不得被判为孤儿: {matched:?}"
    );
    // 收尾
    let _ = proc.cancel(false).unwrap();
}

#[test]
fn cleanup_without_filter_on_macos_wont_target_unmarked_launchd_agents() {
    // macOS 上 env 标记不可验证：无 cmd_filter 时 scan 必须返回空（防误杀 launchd 代理，
    // 见 procmgr.rs 登记说明）；Linux 上走 /proc 精确验证，语义不受影响
    let targets = procmgr::scan_orphans(None);
    if std::path::Path::new("/proc").exists() {
        // Linux：仅含 BBW_SANDBOX=1 的真孤儿；不预置断言数量
        assert!(targets.iter().all(|o| o.marker_verified));
    } else {
        assert!(
            targets.is_empty(),
            "macOS 无过滤时不应命中任何进程（标记不可验证）: {targets:?}"
        );
    }
}
