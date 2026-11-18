//! 委派编排契约（D11 §3 #11-13 / §8；17 篇委派体系）。
//! 依赖倒置：session 定义本契约，bbrt-delegate 的真实后端由 bin 装配适配——
//! session 不依赖 delegate crate（与 executor/sink 同思路，保持可独立单测）。

use bbrt_protocol::TaskBrief;

/// 委派启动请求（HostToRuntime::DelegateLaunch 的 session 侧形态）
#[derive(Debug, Clone)]
pub struct DelegateLaunchReq {
    pub delegate_task_id: String,
    /// 父会话 id（P0-2①：接线 LaunchOpts.parent_session_id——委派子进程
    /// 审计关联此前断链，delegate_bridge 传空串）
    pub session_id: String,
    pub backend: String,
    pub brief: TaskBrief,
    /// 权限模式（→ 各后端启动参数映射，§8.2）
    pub mode: bbrt_sec::gate::PermissionMode,
}

/// 归一化委派事件（bbrt-delegate::NormalizedEvent 的 session 侧镜像；
/// bin 装配时做枚举映射，避免依赖传导）
#[derive(Debug, Clone)]
pub enum DelegateEvt {
    Meta {
        text: String,
        session_ref: Option<String>,
    },
    Delta {
        channel: DelegateChannel,
        text: String,
    },
    ToolUse {
        call_id: String,
        tool: String,
        args: serde_json::Value,
        risk: &'static str,
    },
    ToolResult {
        call_id: String,
        ok: bool,
        summary: String,
    },
    Warning {
        text: String,
    },
    Exit {
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
}

/// 流式通道（bbrt_protocol::StreamChannel 的本地镜像）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegateChannel {
    Text,
    Reasoning,
}

/// 委派收尾报告（FinalReport 镜像）
#[derive(Debug, Clone)]
pub struct DelegateFinal {
    pub summary: String,
    pub changed_files: Vec<String>,
    pub session_ref: Option<String>,
    pub exit_code: Option<i32>,
}

/// next_wait 结果（超时轮询三态）
#[derive(Debug, Clone)]
pub enum WaitEvt {
    Ready(DelegateEvt),
    /// 超时无事件（调用方回旋：drain 宿主指令/空闲心跳）
    Idle,
    /// 流终止（Exit 已产出）
    Ended,
}

/// 委派事件流（next=None 即流终止；Exit 事件之后终止）
pub trait DelegateStream: Send {
    fn next(&mut self) -> Option<DelegateEvt>;

    /// 带超时拉取（pump 轮询用）：Ready=下一条事件 / Idle=超时无事件
    /// （调用方回旋处理宿主指令/空闲心跳）/ Ended=流终止。
    /// 默认实现=阻塞 next() 忽略超时（mock/脚本流语义不变）；真实后端
    /// 覆盖为读线程 recv_timeout——子进程静默期不再卡死取消息路径。
    fn next_wait(&mut self, _timeout: std::time::Duration) -> WaitEvt {
        match self.next() {
            Some(evt) => WaitEvt::Ready(evt),
            None => WaitEvt::Ended,
        }
    }
    /// 取消（graceful=SIGINT→3s→SIGKILL，D11 §8.4）
    fn cancel(&mut self, graceful: bool);
    /// 收尾：summary/changed_files/session_ref
    fn finalize(&mut self) -> DelegateFinal;
}

/// 委派启动器（bin 侧由 BackendRegistry 适配实现）
pub trait DelegateLauncher: Send + Sync {
    /// 可用后端清单（健康面板/简报建议）
    fn backends(&self) -> Vec<String>;
    /// 启动（锁获取失败→Err 文案含 8035 语义；后端未装→8030；模式不支持→Err）
    fn launch(&self, req: &DelegateLaunchReq) -> Result<Box<dyn DelegateStream>, String>;
}
