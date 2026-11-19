# BaobaoChat Agent Runtime（bbrt-* Rust workspace）

Agent Runtime 独立进程的实现仓库（Rust sidecar，08 §3.1）。内部设计权威出处：
`docs/detail/D11-AgentRuntime内部详细设计.md`（crate 划分 §2 / 会话状态机 §3 / stdio 全消息表 §4）；
进程架构与协议概述见 `docs/08-AI-Agent总体设计.md` §3 / §6.1。

## 现状与构建约定

骨架阶段。**当前开发环境无 cargo**：代码按稳定 Rust（edition 2021）落码，由 CI 负责验证：

```bash
cargo fmt --all -- --check   # 若 CI 首跑因格式差异失败，本地执行一次 cargo fmt --all 提交即可
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

后续接入 cargo-deny 强制依赖方向（禁止环），并按 D11 §1.2 完整落 crate。

## crate 图（箭头 = 依赖方向，指向被依赖方）

```text
已落：
  bbrt-session ──► bbrt-protocol ◄── serde / serde_json / thiserror

规划（D11 §1.2，全部就位后的完整依赖图）：
  ┌──────────── bbrt（bin，进程入口/装配） ────────────┐
  │  bbrt-session ──► bbrt-context / bbrt-tools        │
  │       │             │          │                   │
  │       │             ▼          ▼                   │
  │       │        bbrt-sec                            │
  │       ▼                                          │
  │  bbrt-aigw   bbrt-store   bbrt-hostapi   bbrt-protocol
  └────────────────────────────────────────────────────┘
  规则：protocol ← 所有（仅 serde/serde_json）；store 是 SQLite 唯一写入方；
  tools 与 delegate 互不依赖。
```

## 与 D11 的映射

| D11 章节 | 本仓库落点 | 说明 |
|---|---|---|
| §2.1 bbrt-protocol | `crates/bbrt-protocol` | 骨架期单文件承载：`envelope.rs`（信封+全消息枚举+共享枚举+SessionState），`codec.rs`（行式 JSONL）；D11 的 messages/ 按消息簇拆分文件、version.rs 协商逻辑待消息量增长后再拆 |
| §4 全消息表 | `envelope.rs` 两个枚举 | 38/38 类型覆盖（见下表）；`#[serde(tag="type")]` 判别、不开 deny_unknown_fields、可选字段 Option |
| §3 会话状态机 | `crates/bbrt-session/src/state.rs` | 纯函数、20/20 迁移；SessionState 枚举权威在 protocol（session.state 消息契约），session re-export 使用 |
| §2.2 其余文件 | 未落 | manager / loop_runner / pending / wal / recovery / emitter / interrupt / types 见排期 |

## D11 §4 消息覆盖核对（38/38）

HostToRuntime 17 变体（宿主→RT 15 + 双向 ping/pong）：

| D11 type | 变体 |
|---|---|
| initialize | Initialize |
| session.start | SessionStart |
| user.message | UserMessage |
| permission.response | PermissionResponse |
| checkpoint.create | CheckpointCreate |
| checkpoint.restore | CheckpointRestore |
| run.cancel | RunCancel |
| session.pause / session.resume | SessionPause / SessionResume |
| session.end | SessionEnd |
| obo.token | OboToken |
| tools.reload | ToolsReload |
| ping / pong（双向） | Ping / Pong |

RuntimeToHost 23 变体（RT→宿主 21 + 双向 ping/pong）：

| D11 type | 变体 |
|---|---|
| initialize.result | InitializeResult |
| runtime.ready | RuntimeReady |
| session.ready | SessionReady |
| stream.delta | StreamDelta（channel: text/reasoning/tool） |
| stream.done | StreamDone（usage{in,out}） |
| tool.call | ToolCall（source: self/backend） |
| tool.result | ToolResult（exitCode?/blocked?/durationMs?） |
| permission.request | PermissionRequest（preview{kind:command/diff/obo}） |
| checkpoint.created | CheckpointCreated |
| compaction.event | CompactionEvent |
| model.switched | ModelSwitched |
| subagent.spawn / subagent.event / subagent.join | SubagentSpawn / SubagentEvent / SubagentJoin |
| session.state | SessionStateReport（state 为 §3 十态枚举） |
| session.ended | SessionEnded |
| obo.renew | OboRenew |
| error | Error（code/message/fatal/sessionId?） |
| ping / pong（双向） | Ping / Pong |

## D11 §3 状态机迁移覆盖（20/20）

`state.rs` 每个迁移函数对应全迁移表一行（#1 begin、#2 initialized、#3 fail_initialization、
#4 accept_user_message、#5 complete_round、#6 request_permission、#7 permission_resolved、
#8 permission_exhausted、#9 begin_fanout、#10 join_subagents、#11 begin_delegation、
#12 complete_delegation、#13 fail_delegation、#14 request_review、#15 resolve_review、
#16 pause、#17 resume、#18 fail_unrecoverable、#19 end（任意态）、#20 retry_from_error）。
非法迁移返回 `TransitionError::Illegal`；超时/计数（120s、≥3 次、步数>50 等）由调用方判定后驱动。

## 后续 crate 排期（占位）

| 序 | crate | D11 § | 内容 | 状态 |
|---|---|---|---|---|
| 1 | bbrt-protocol | §2.1 | 全消息类型 + 编解码 | 已落（骨架，测试全量覆盖） |
| 2 | bbrt-session | §2.2/§3 | 状态机已落；manager/loop_runner/pending/wal/recovery/emitter/interrupt/types 待落 | 进行中 |
| 3 | bbrt-hostapi | §2.9 | stdio 传输（半行缓冲/背压 8MB）、握手、OBO 代理、心跳 | 未开始 |
| 4 | bbrt-store | §2.8 | SQLite 封装、迁移、§11 001_init.sql | 未开始 |
| 5 | bbrt-sec | §2.5 | 门控、三级记忆、危险命令规则、沙箱、审计哈希链、脱敏 | 未开始 |
| 6 | bbrt-context | §2.3 | 预算、compaction、关键文件 map、摘录 | 未开始 |
| 7 | bbrt-tools | §2.4 | 注册表、执行管线、内置工具 | 未开始 |
| 9 | bbrt-aigw | §2.7 | SSE 客户端、重试降档、计量 | 未开始 |
| 10 | bbrt（bin） | §1.2 | 进程入口、装配 | 未开始 |

## 已知 TODO / 开放点

- **REQ 回执消息未定义类型**：checkpoint.restore（回执{ok,newSnapshotId}）、user.message/permission.response/tools.reload 的成对回执在 D11 §4 未命名消息类型，暂无法落成枚举变体；需 D11 回填后补。
- ~~delegating→waiting_review 直连~~、~~stream.delta channel=tool~~：随委派域退役失效（2026-11-19）。
- **骨架占位字段**：user.message.attachments[]（引用字符串）、preview.diff 字段、RiskLevel 分级口径，待 09/10 篇细化对齐。
- bbrt-protocol 消息簇拆分（messages/runtime.rs 等 D11 §2.1 文件级结构）待消息量增长后执行，当前单文件可维护。
