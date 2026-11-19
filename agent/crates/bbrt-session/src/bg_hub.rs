//! 后台任务中枢（D16 §5 后台化推广：探查/专家超窗与终端后台命令）。
//!
//! 职责：
//! - **后台 run 注册表**（run_id → 指令通道）：宿主 run.cancel / 模型侧
//!   subagent.adjust 定向路由到具体 run（P0-2②——取代对全部活跃会话的
//!   广播，修多会话并存时的误投）；
//! - **产物 parking**：后台完成的摘要按会话入队，manager 在下一次 run_turn
//!   前 drain 并注入主上下文（subagent.join/expert.join 轮次，
//!   loop_runner::inject_bg_join）；
//! - **会话收口**：session.end 时对本会话全部后台 run 优雅取消。
//!
//! 各 run 的执行线程自行注销（detach——run 状态由 agent_run 行承载，
//! 不依赖线程存活）。无最大执行时长（D16 决策④），仅用户 cancel。
//! 外部 CLI 委派后端的 spawn 已随委派域退役（2026-11-18）。

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use crate::loop_runner::BgHostMsg;

/// 后台 run 登记项（线程 detach；注销即移除）
struct BgRun {
    session_id: String,
    tx: Sender<BgHostMsg>,
}

/// 待回填主上下文的产物（多形态共用：subagent.join/expert.join）
#[derive(Debug, Clone, PartialEq)]
pub struct BgJoin {
    /// 注入 history 的轮次名（Round::Tool.name）
    pub name: String,
    pub run_id: String,
    pub summary: String,
}

/// 中枢（manager 持一份；runner 经 SessionRunner.bg_hub 共享同一实例）
#[derive(Default)]
pub struct BgHub {
    /// run_id → 后台 run（注册先于线程启动——宿主指令无窗口期丢失）
    runs: Mutex<HashMap<String, BgRun>>,
    /// session_id → 待注入摘要队列（drain 在 manager.run_turn 前）
    joins: Mutex<HashMap<String, Vec<BgJoin>>>,
}

impl BgHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 定向路由（P0-2②）：命中后台 run 投递其指令通道；未命中=false
    /// （已结束/未知 run——调用方按需报错，不静默）
    pub fn route(&self, run_id: &str, msg: &BgHostMsg) -> bool {
        self.runs
            .lock()
            .unwrap()
            .get(run_id)
            .map(|r| r.tx.send(msg.clone()).is_ok())
            .unwrap_or(false)
    }

    /// 后台产物入队（下一轮 run_turn 前 drain 注入）
    pub fn park_join(&self, session_id: &str, join: BgJoin) {
        self.joins
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .push(join);
    }

    /// 取走该会话全部待注入产物（manager.run_turn 前调用）
    pub fn drain_joins(&self, session_id: &str) -> Vec<BgJoin> {
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
                let _ = run.tx.send(BgHostMsg::Cancel { graceful: true });
            }
        }
    }

    /// 后台 run 计数（测试等待用）
    pub fn active_count(&self) -> usize {
        self.runs.lock().unwrap().len()
    }

    /// 注销（探查/专家/终端 run 经此复用——指令通道随 run 生命周期）
    pub fn unregister(&self, run_id: &str) {
        self.runs.lock().unwrap().remove(run_id);
    }

    /// 注册（探查/专家/终端：run 内部 run_id 分配后、执行循环前调用；
    /// 注册先于执行=宿主/主 Agent 指令零窗口丢失）
    pub fn register(&self, run_id: &str, session_id: &str, tx: Sender<BgHostMsg>) {
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
    use std::sync::Arc;

    /// 注册→路由→注销的通道语义（不拉线程，纯中枢行为）
    #[test]
    fn route_targets_registered_run_only() {
        let hub = Arc::new(BgHub::new());
        let (tx, rx) = std::sync::mpsc::channel();
        hub.runs.lock().unwrap().insert(
            "r-1".into(),
            BgRun {
                session_id: "s-1".into(),
                tx,
            },
        );
        assert!(hub.route("r-1", &BgHostMsg::Cancel { graceful: true }));
        assert!(!hub.route("r-404", &BgHostMsg::Cancel { graceful: true }));
        assert!(matches!(
            rx.recv_timeout(std::time::Duration::from_millis(100)),
            Ok(BgHostMsg::Cancel { graceful: true })
        ));

        hub.park_join(
            "s-1",
            BgJoin {
                name: "subagent.join".into(),
                run_id: "r-1".into(),
                summary: "x".into(),
            },
        );
        hub.park_join(
            "s-1",
            BgJoin {
                name: "expert.join".into(),
                run_id: "r-2".into(),
                summary: "y".into(),
            },
        );
        hub.park_join(
            "s-2",
            BgJoin {
                name: "expert.join".into(),
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
}
