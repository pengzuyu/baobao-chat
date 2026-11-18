//! 后台委派中枢（D16 §5：委派直接后台——launch 后 turn 立即返回，
//! 会话可继续对话；事件流与审查在专用线程）。
//!
//! 职责：
//! - **后台 run 注册表**（run_id → 指令通道）：宿主 cancel/review
//!   经 manager 定向路由到具体 run（P0-2②——取代对全部活跃会话的广播，
//!   修多会话并存时的误投）；
//! - **产物 parking**：审查通过的摘要按会话入队，manager 在下一次 run_turn 前
//!   drain 并注入主上下文（delegate.join 轮次，loop_runner::inject_delegate_join）；
//! - **会话收口**：session.end 时对本会话全部后台 run 优雅取消。
//!
//! 事件循环/收尾/审查本体复用 loop_runner 的四个共用函数（同步退化路径与
//! 后台路径同一份核心）；线程结束自行注销（detach——run 状态由 agent_run
//! 行承载，不依赖线程存活）。无最大执行时长（D16 决策④），仅用户 cancel。

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::events::SessionSink;
use crate::loop_runner::{DelegateHostMsg, EventLog};

/// 后台 run 登记项（线程 detach；注销即移除）
struct BgRun {
    session_id: String,
    tx: Sender<DelegateHostMsg>,
}

/// 待回填主上下文的产物（多形态共用：delegate.join/subagent.join/team.join）
#[derive(Debug, Clone, PartialEq)]
pub struct DelegateJoin {
    /// 注入 history 的轮次名（Round::Tool.name）
    pub name: String,
    pub run_id: String,
    pub summary: String,
}

/// 中枢（manager 持一份；runner 经 SessionRunner.delegate_hub 共享同一实例）
#[derive(Default)]
pub struct DelegateHub {
    /// run_id → 后台 run（注册先于线程启动——宿主指令无窗口期丢失）
    runs: Mutex<HashMap<String, BgRun>>,
    /// session_id → 待注入摘要队列（drain 在 manager.run_turn 前）
    joins: Mutex<HashMap<String, Vec<DelegateJoin>>>,
}

impl DelegateHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 后台执行一个已 launch 的委派流（D16 §5）：
    /// 事件流泵 → delegate.end（全字段上行）→ 异常退出即终（不出审查卡，
    /// 口径同同步路径 8033）→ 审查（超时=拒绝）→ accept 则 park 摘要 → 注销。
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        self: &Arc<Self>,
        run_id: String,
        session_id: String,
        backend: String,
        stream: Box<dyn crate::delegation::DelegateStream>,
        sink: Arc<dyn SessionSink>,
        wal: Arc<dyn EventLog>,
        review_timeout: Duration,
        started: Instant,
    ) {
        let (tx, rx) = std::sync::mpsc::channel();
        // 先注册后启动：宿主指令（含启动即 cancel 的极端时序）零丢失
        self.runs.lock().unwrap().insert(
            run_id.clone(),
            BgRun {
                session_id: session_id.clone(),
                tx,
            },
        );
        let hub = Arc::clone(self);
        let rid = run_id.clone();
        let sid = session_id.clone();
        std::thread::Builder::new()
            .name(format!("bbc-delegate-{rid}"))
            .spawn(move || {
                let mut stream = stream;
                let cancelled = crate::loop_runner::pump_delegate_stream(
                    &sid,
                    &rid,
                    &backend,
                    stream.as_mut(),
                    &rx,
                    None, // 会话暂停不终止后台委派（D16 §5）；仅用户 cancel
                    sink.as_ref(),
                    wal.as_ref(),
                );
                let final_rep = crate::loop_runner::finish_delegate_stream(
                    &sid,
                    &rid,
                    cancelled,
                    started,
                    stream.as_mut(),
                    sink.as_ref(),
                    wal.as_ref(),
                );
                let exit_code = final_rep.exit_code.unwrap_or(-1);
                if cancelled || exit_code != 0 {
                    // 异常退出/取消：不出审查卡（同步路径 8033 同口径），但回执同样
                    // park 回填主上下文——主 Agent 此前只有「后台运行中」占位工具
                    // 结果，不 park 则失败/取消信息只在侧栏 run 流可见
                    // （DelegateEnd/WAL failed），主 Agent 永远不知 run 已终止，
                    // 无法告知用户或改道（2026-11-18 真机：claude 未登录秒退
                    // 报错，错误已返回但结果未进主 agent）。cancelled 短路在前：
                    // claude 捕获 SIGINT 干净退出 exit=0，若落入审查窗口会空等
                    // review_timeout 后 reject
                    let summary = if cancelled {
                        format!("[委派已取消] {rid}（后端 {backend}）用户取消，exit={exit_code}")
                    } else {
                        format!(
                            "[委派失败] {rid}（后端 {backend}）异常退出 exit={exit_code}：{}",
                            crate::subagent::truncate_chars(&final_rep.summary, 400)
                        )
                    };
                    hub.park_join(
                        &sid,
                        DelegateJoin {
                            name: "delegate.join".into(),
                            run_id: rid.clone(),
                            summary,
                        },
                    );
                    hub.unregister(&rid);
                    return;
                }
                let accepted = crate::loop_runner::await_delegate_review(&rx, review_timeout, None);
                crate::loop_runner::resolve_delegate_review(
                    &sid,
                    &rid,
                    accepted,
                    sink.as_ref(),
                    wal.as_ref(),
                );
                if accepted {
                    hub.park_join(
                        &sid,
                        DelegateJoin {
                            name: "delegate.join".into(),
                            run_id: rid.clone(),
                            summary: format!("[委派完成·审查通过] {}", final_rep.summary),
                        },
                    );
                }
                hub.unregister(&rid);
            })
            .expect("委派后台线程 spawn 失败");
    }

    /// 定向路由（P0-2②）：命中后台 run 投递其指令通道；未命中=false
    /// （简报阶段/已结束——调用方回落 session 通道或丢弃）
    pub fn route(&self, run_id: &str, msg: &DelegateHostMsg) -> bool {
        self.runs
            .lock()
            .unwrap()
            .get(run_id)
            .map(|r| r.tx.send(msg.clone()).is_ok())
            .unwrap_or(false)
    }

    /// 审查通过产物入队（下一轮 run_turn 前 drain 注入）
    pub fn park_join(&self, session_id: &str, join: DelegateJoin) {
        self.joins
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .push(join);
    }

    /// 取走该会话全部待注入产物（manager.run_turn 前调用）
    pub fn drain_joins(&self, session_id: &str) -> Vec<DelegateJoin> {
        self.joins
            .lock()
            .unwrap()
            .remove(session_id)
            .unwrap_or_default()
    }

    /// 会话收口：对本会话全部后台 run 优雅取消（session.end；
    /// 线程自注销，此处不 join 不阻塞）
    pub fn cancel_session(&self, session_id: &str) {
        for run in self.runs.lock().unwrap().values() {
            if run.session_id == session_id {
                let _ = run.tx.send(DelegateHostMsg::Cancel { graceful: true });
            }
        }
    }

    /// 后台 run 计数（测试等待用）
    pub fn active_count(&self) -> usize {
        self.runs.lock().unwrap().len()
    }

    /// 注销（探查/专家 run 也经此复用——补充指令/取消通道随 run 生命周期）
    pub fn unregister(&self, run_id: &str) {
        self.runs.lock().unwrap().remove(run_id);
    }

    /// 注册（探查/专家：run 内部 run_id 分配后、执行循环前调用；
    /// 注册先于执行=宿主/主 Agent 指令零窗口丢失）
    pub fn register(&self, run_id: &str, session_id: &str, tx: Sender<DelegateHostMsg>) {
        self.runs.lock().unwrap().insert(
            run_id.to_string(),
            BgRun {
                session_id: session_id.to_string(),
                tx,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 注册→路由→注销的通道语义（不拉线程，纯中枢行为）
    #[test]
    fn route_targets_registered_run_only() {
        let hub = Arc::new(DelegateHub::new());
        let (tx, rx) = std::sync::mpsc::channel();
        hub.runs.lock().unwrap().insert(
            "r-1".into(),
            BgRun {
                session_id: "s-1".into(),
                tx,
            },
        );
        assert!(hub.route("r-1", &DelegateHostMsg::Review { accept: true }));
        assert!(!hub.route("r-404", &DelegateHostMsg::Review { accept: true }));
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(100)),
            Ok(DelegateHostMsg::Review { accept: true })
        ));

        hub.park_join(
            "s-1",
            DelegateJoin {
                name: "delegate.join".into(),
                run_id: "r-1".into(),
                summary: "x".into(),
            },
        );
        hub.park_join(
            "s-1",
            DelegateJoin {
                name: "subagent.join".into(),
                run_id: "r-2".into(),
                summary: "y".into(),
            },
        );
        hub.park_join(
            "s-2",
            DelegateJoin {
                name: "team.join".into(),
                run_id: "r-3".into(),
                summary: "z".into(),
            },
        );
        let drained = hub.drain_joins("s-1");
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].run_id, "r-1");
        assert!(hub.drain_joins("s-1").is_empty(), "drain 一次性取走");
        assert_eq!(hub.drain_joins("s-2").len(), 1, "会话间隔离");
    }

    /// 后台 run 全链集成（真线程）用的轻量桩
    mod bg {
        use crate::delegation::{DelegateFinal, DelegateStream, WaitEvt};
        use crate::events::{SessionEvent, SessionSink};
        use crate::loop_runner::EventLog;

        pub struct NoopSink;
        impl SessionSink for NoopSink {
            fn emit(&self, _evt: SessionEvent) {}
        }
        pub struct NoopLog;
        impl EventLog for NoopLog {
            fn append(&self, _s: &str, _t: &str, _p: &str) {}
            fn append_run(&self, _s: &str, _r: &str, _t: &str, _p: &str) {}
        }

        /// 秒退失败流：零事件直接终止，finalize 报 exit=1 + 错误摘要
        /// （模拟 claude 未登录 -p 秒退：stream-json result 行的 result 文本
        /// 已积累进 summary，进程 exit 1）
        pub struct FailingStream;
        impl DelegateStream for FailingStream {
            fn next(&mut self) -> Option<crate::delegation::DelegateEvt> {
                None
            }
            fn cancel(&mut self, _graceful: bool) {}
            fn finalize(&mut self) -> DelegateFinal {
                DelegateFinal {
                    summary: "Not logged in: Please run /login".into(),
                    changed_files: vec![],
                    session_ref: None,
                    exit_code: Some(1),
                }
            }
        }

        /// 取消流：先 Idle 数轮（给 route Cancel 的投递窗口）再终止；
        /// finalize exit=0（claude 捕获 SIGINT 干净退出的实测形态）
        pub struct IdleThenEndStream {
            pub rounds: u32,
        }
        impl DelegateStream for IdleThenEndStream {
            fn next(&mut self) -> Option<crate::delegation::DelegateEvt> {
                None
            }
            fn next_wait(&mut self, timeout: std::time::Duration) -> WaitEvt {
                if self.rounds > 0 {
                    self.rounds -= 1;
                    std::thread::sleep(timeout.min(std::time::Duration::from_millis(100)));
                    return WaitEvt::Idle;
                }
                WaitEvt::Ended
            }
            fn cancel(&mut self, _graceful: bool) {}
            fn finalize(&mut self) -> DelegateFinal {
                DelegateFinal {
                    summary: String::new(),
                    changed_files: vec![],
                    session_ref: None,
                    exit_code: Some(0),
                }
            }
        }
    }

    /// 轮询等待某会话 park 出回执（drain 取走式；5s 上限）
    fn wait_for_join(hub: &DelegateHub, sid: &str) -> DelegateJoin {
        for _ in 0..100 {
            if let Some(j) = hub.drain_joins(sid).into_iter().next() {
                return j;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("5s 内未等到后台 run 回执 park");
    }

    /// 失败回执回归（2026-11-18 真机缺口：claude 报错秒退后错误信息只在
    /// 侧栏 run 流可见，主 Agent 永远停在「后台运行中」占位结果）：
    /// exit≠0 必须以 delegate.join park 失败摘要（含 exit 码与错误文本）
    #[test]
    fn bg_failing_run_parks_error_join() {
        use bg::*;
        let hub = Arc::new(DelegateHub::new());
        hub.spawn(
            "r-9".into(),
            "s-9".into(),
            "claude".into(),
            Box::new(FailingStream),
            Arc::new(NoopSink),
            Arc::new(NoopLog),
            Duration::from_secs(8),
            Instant::now(),
        );
        let join = wait_for_join(&hub, "s-9");
        assert_eq!(join.name, "delegate.join");
        assert_eq!(join.run_id, "r-9");
        assert!(join.summary.contains("委派失败"), "summary={}", join.summary);
        assert!(join.summary.contains("exit=1"), "summary={}", join.summary);
        assert!(
            join.summary.contains("Not logged in"),
            "summary={}",
            join.summary
        );
        assert_eq!(hub.active_count(), 0, "结束后注销");
    }

    /// 取消短路回归：用户 cancel 且子进程干净退出（exit=0，claude 捕获
    /// SIGINT 的实测形态）——须短路审查直接 park 取消回执，而非落入
    /// review 窗口空等超时 reject
    #[test]
    fn bg_cancelled_run_skips_review_and_parks_cancel_join() {
        use bg::*;
        let hub = Arc::new(DelegateHub::new());
        hub.spawn(
            "r-10".into(),
            "s-10".into(),
            "claude".into(),
            Box::new(IdleThenEndStream { rounds: 3 }),
            Arc::new(NoopSink),
            Arc::new(NoopLog),
            Duration::from_secs(8),
            Instant::now(),
        );
        hub.route("r-10", &DelegateHostMsg::Cancel { graceful: true });
        let join = wait_for_join(&hub, "s-10");
        assert!(join.summary.contains("委派已取消"), "summary={}", join.summary);
        assert_eq!(hub.active_count(), 0, "结束后注销");
    }
}
