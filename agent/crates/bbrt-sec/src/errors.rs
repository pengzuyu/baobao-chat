//! 沙箱/安全域错误码常量（09 篇 §6.4 权威；本 crate 占用 8020–8026）。
//!
//! 8027（审计哈希链校验失败）/8028（钥匙串拒绝）属 audit/凭据模块（D11 §2.5 后续排期），
//! 不在本期落地范围。8002/8006 是通用工具错误码（14 篇已登记），gate.rs 第①②步引用，
//! 常量在此集中以便引用方不写魔法数字。

/// 8002：缺少权限点（如无 `agent:tool:run_command` 却调用 run_command）
pub const CODE_NO_PERMISSION_POINT: u32 = 8002;

/// 8006：租户策略禁用了该工具（agent_tool_policy）
pub const CODE_TOOL_DISABLED: u32 = 8006;

/// 8020：命令被沙箱拒绝（路径越界 / 资源白名单；符号链接逃逸单独走 8024）
pub const CODE_SANDBOX_DENIED: u32 = 8020;

// 8021 已退役（2026-11-23 用户拍板：危险规则库"拒绝类"降级统一双确认，
// 不再有不经确认的直接拦截路径；码位保留不复用。loop_runner 的
// SessionEvent::Error 复用 8021 数字表「连续工具失败超限」为历史遗留）

/// 8022：进程资源超限被终止（CPU/内存；macOS 为 rlimit 尽力 + 监控杀超限）
pub const CODE_RESOURCE_LIMIT: u32 = 8022;

/// 8023：进程超时被终止（默认 300s，可配 1–600s）
pub const CODE_TIMEOUT: u32 = 8023;

/// 8024：符号链接逃逸拦截（realpath 校验发现解析后越出工作区）
pub const CODE_SYMLINK_ESCAPE: u32 = 8024;

/// 8025：网络出站目标不在白名单（CIDR / 域名后缀均未命中）
pub const CODE_NETWORK_NOT_ALLOWED: u32 = 8025;

/// 8026：敏感文件读取被拒绝（默认拒读清单：.env* / *.pem / id_rsa* 等）
pub const CODE_SENSITIVE_READ: u32 = 8026;

/// 8027：工具实现 panic（catch_unwind 兜底转工具错误——不杀会话循环线程，
/// 否则 tool.result/turn.end 永不发出，UI 永久「执行中」且无法停止）
pub const CODE_TOOL_PANIC: u32 = 8027;
