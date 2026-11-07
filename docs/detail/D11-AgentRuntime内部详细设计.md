# D11 - Agent Runtime 内部详细设计（Rust 运行时）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（详细设计阶段） |
| 上游 | [08-Agent总体](../08-AI-Agent总体设计.md) · [09-工具与安全](../09-AI-Agent工具与安全设计.md) · [17-编码智能体协作](../17-本地编码智能体协作设计.md) · [14-协议](../14-通信协议设计.md) · [D02-服务端工程](D02-服务端模块划分与工程结构.md) |
| 下游 | Runtime 实现仓库（bbrt-* workspace）；UI 侧消费契约见 [D08](D08-Agent工作台模块详细设计.md) |
| 模板说明 | 按 D01 §13 适配：**无页面章**，以 crate 划分 / 内部协议（stdio 全消息表）/ 会话状态机替代；模型章为本地 SQLite 全表 DDL |

---

## 1. 概述与 crate 总览

### 1.1 定位

08 篇定义了 Runtime 的**行为规格**（循环、上下文、检查点、协议语义）；本篇给出**内部实现设计**：进程内 crate 划分（到文件级）、会话状态机全图、stdio JSONL 协议全消息表、上下文引擎与工具管线算法、子 Agent 调度器、委派适配器内部、崩溃恢复 WAL 与重放、宿主交互、本地库 DDL。

硬性约束（继承）：自研不引框架、核心循环 <2k 行；空闲内存 <80MB；单设备活跃会话 ≤3；一切门控在 Rust、不信任模型输出与非用户内容。

### 1.2 crate 依赖总览

```
                    ┌──────────── bbrt（bin，进程入口/装配） ────────────┐
                    │  bbrt-session ──► bbrt-context / bbrt-tools        │
                    │       │             │          │                   │
                    │       │             ▼          ▼                   │
                    │       │        bbrt-sec ◄── bbrt-delegate          │
                    │       ▼                                          │
                    │  bbrt-aigw   bbrt-store   bbrt-hostapi   bbrt-protocol
                    └────────────────────────────────────────────────────┘
依赖方向（CI cargo-deny 强制，禁止环）：
protocol ← 所有（仅依赖 serde/serde_json）
store ← session/sec/tools/delegate（SQLite 唯一写入方）
sec ← tools/delegate/session（门控与审计被复用）
context ← session/tools（预算与摘录）
aigw/hostapi/delegate ← session（被循环驱动）
tools 与 delegate 互不依赖（coding.* 工具在 tools 侧定义门控，执行转发给 delegate 的事件桥由 session 装配）
```

| crate | 一句话职责 |
|---|---|
| bbrt-protocol | stdio JSONL 编解码、全消息类型、版本协商 |
| bbrt-session | 会话管理、状态机、事件镜像 WAL、崩溃恢复 |
| bbrt-context | token 预算、compaction、关键文件 map、read_file 摘录 |
| bbrt-tools | 工具注册表、执行管线、内置工具实现 |
| bbrt-sec | 权限门控、三级记忆、危险命令规则库、沙箱、审计哈希链、脱敏 |
| bbrt-delegate | CodingBackend trait、claude/zcode/通用适配器、事件归一化、进程组管理 |
| bbrt-aigw | ai-gateway SSE 客户端、重试降档、计量上报 |
| bbrt-store | SQLite 封装、迁移、查询 |
| bbrt-hostapi | 与宿主的 stdio 传输、OBO 令牌获取/续签、心跳 |
| bbrt-mcp | MCP client：连接管理（stdio/SSE）、list_tools 动态发现、OBO 注入调用、断连降级（D14 §6） |

## 2. crate 划分（文件级）

### 2.1 bbrt-protocol

职责：宿主↔Runtime 全消息的编解码与类型定义；不含任何业务逻辑；所有消息为 `#[non_exhaustive]`（前向兼容，14 篇 §8）。

```
bbrt-protocol/src/
├─ lib.rs            # 导出
├─ envelope.rs       # Envelope{v,id,reply_to,type,ts,payload}；id 前缀 h-/r-
├─ codec.rs          # 行式 JSONL 编解码（255KB/行上限、BOM/空行容忍、半行缓冲）
├─ version.rs        # PROTOCOL_VERSION=1；协商语义（§10.2）
└─ messages/
   ├─ mod.rs         # enum Message（全类型汇总 + try_from/to_payload）
   ├─ runtime.rs     # initialize / initialize.result / runtime.ready / ping / pong / error
   ├─ session.rs     # session.start/ready/pause/resume/end/ended/state
   ├─ stream.rs      # stream.delta{channel} / stream.done
   ├─ tool.rs        # tool.call / tool.result
   ├─ permission.rs  # permission.request / permission.response
   ├─ checkpoint.rs  # checkpoint.create / checkpoint.created / checkpoint.restore
   ├─ compaction.rs  # compaction.event
   ├─ model.rs       # model.switched
   ├─ subagent.rs    # subagent.spawn / subagent.event / subagent.join
   ├─ delegate.rs    # delegate.launch/brief/event/cancel/end/review/input
   ├─ host.rs        # user.message / obo.token / obo.renew / tools.reload / checkpoint.create(宿主侧)
   └─ common.rs      # RiskLevel/PermissionMode/GrantScope/Decision 等共享枚举
```

关键类型：`Envelope`、`Message`（enum）、`ProtocolError{code:u32, fatal:bool}`。依赖：serde、serde_json。

### 2.2 bbrt-session

职责：多会话生命周期（活跃 ≤3）、单会话状态机（§3）、核心循环驱动（08 §4.1 伪码的可执行化）、事件镜像 WAL 与崩溃重放、未决权限请求表、暂停/恢复语义。

```
bbrt-session/src/
├─ lib.rs
├─ manager.rs        # SessionManager：session.start 分发、活跃上限、广播路由
├─ session.rs        # Session：状态机结构、迁移函数（全部走 transition() 统一出口）
├─ loop_runner.rs    # agent_loop 编排：组装→路由→流式→工具轮→中断检查
├─ pending.rs        # PendingPermission 表：request_id→(call, deadline=120s, 通知任务)
├─ wal.rs            # 事件镜像 WAL（§9.1 格式；先落盘后执行）
├─ recovery.rs       # 崩溃重放（§9.2）：checkpoint+事件序列→会话重建
├─ emitter.rs        # 出站消息统一出口：协议发送 + WAL 追加 + agent_event 落库（同事务语义）
├─ interrupt.rs      # 暂停/紧急停止/步数与失败计数（MAX_STEPS=50、连续失败>3）
└─ types.rs          # SessionConfig / SessionSnapshot / ReplayReport
```

关键类型：`Session{id, workspace, mode, state, ctx: ContextHandle, budget, counters}`、`Transition{from, to, reason, ts}`。依赖：protocol、context、tools、sec、store、aigw、delegate、hostapi。

### 2.3 bbrt-context

职责：上下文组装与预算（08 §4.3）、compaction 状态机、关键文件 map、read_file 摘录与截断分页。

```
bbrt-context/src/
├─ lib.rs
├─ budget.rs         # BudgetTable（§5.1 公式）；estimate（字符≈token 启发式 + 校准表）
├─ assemble.rs       # assemble()：system+技能+项目(AGENTS.md+file_map+git 摘要)+历史+工具结果
├─ compaction.rs     # compact()（§5.2 伪码）；归档段标注 [已压缩摘要]
├─ file_map.rs       # path→(用途一句话, 关键行号)；压缩后常驻；容量上限 64 条 LRU
├─ excerpt.rs        # read_file 摘录（§5.3）：行区间/32KB/二进制/敏感拒读/offset 分页
├─ truncate.rs       # 输出截断：1MB 头尾各 50%、检索 200 条、[truncated, offset=X] 标注
└─ types.rs          # Round / ToolResultRef / ArchiveSummary
```

依赖：protocol（compaction 事件）、sec（敏感判定、脱敏标记 trust）、store（agent_context 持久化）、aigw（快模型摘要调用）。

### 2.4 bbrt-tools

职责：工具注册表（三来源合并：本地内置 + mcp.*（bbrt-mcp 连接期发现，含生态 app.*，D14 §6.1）+ 技能，10 篇 §4.6）、执行管线（§6）、本地内置工具实现（**仅文件/命令/git/检索类本地能力**；公司域工具 kb_query/doc_*/im_send/file_upload 不再硬编码，经 MCP 网关动态供给，09 篇 §3.1 注记）；coding.* 三工具是 delegate 的薄门面（定义 inputSchema/风险级，执行转交 session 装配的事件桥）。

```
bbrt-tools/src/
├─ lib.rs
├─ registry.rs       # ToolRegistry：注册/热重载(tools.reload)/按需注入(pick_tools)
├─ pipeline.rs       # execute_pipeline()（§6 伪码）
├─ dispatcher.rs     # 只读并行判定（parallel_safe 白名单）与串行化
└─ builtin/
   ├─ fs.rs          # read_file / list_dir / write_file / edit_file
   ├─ search.rs      # search_files(grep/glob，命中 ≤200)
   ├─ cmd.rs         # run_command（转 sec.sandbox 执行）
   ├─ git.rs         # git_status / git_diff / git_commit / git_push（钥匙串注入）
   ├─ http.rs        # http_fetch（内网白名单 GET）
   └─ coding.rs      # coding.delegate / coding.resume / coding.cancel（→ bbrt-delegate）
```

依赖：protocol、sec、context（摘录/截断）、store（审计元数据）、hostapi（OBO token 取用）、mcp（网关工具执行转发）。

### 2.5 bbrt-sec

职责：09 篇全部安全机制的内化：门控判定顺序、三级记忆、危险命令规则库、沙箱（路径/网络/资源/进程组）、审计哈希链、脱敏、注入检测。沙箱的 **OS 原生实现**（Linux bubblewrap/cgroups、macOS Seatbelt/rlimit、Windows Job Object/Restricted Token）、降级矩阵与逃逸测试套件以 [D13 Part B](D13-变更控制模式与沙箱执行详细设计.md) 为权威。

```
bbrt-sec/src/
├─ lib.rs
├─ gate.rs           # permission_gate()：①策略②权限点③矩阵④记忆⑤不可信⑥confirm（09 §4.1）
├─ policy.rs         # 租户策略缓存（GET /agent/policies + agent.policy.updated 失效；缺失按最严档）
├─ memory.rs         # 三级记忆：内存(once/session) + allow.json(permanent)
├─ danger_rules.rs   # 规则正则库（热更）+ 快模型分类兜底（<300ms 目标）
├─ audit.rs          # JSONL 哈希链（prev_hash/hash=sha256 链）、批量上报、锚点校验
├─ masking.rs        # 打码模式库（AK/SK、JWT、password=、私钥块…）+ args_digest
├─ injection.rs      # untrusted 指纹标记/匹配、注入特征库、强制 confirm 规则
└─ sandbox/
   ├─ mod.rs         # SandboxCtx：白名单装载与校验入口
   ├─ path.rs        # realpath ∈ 工作区+例外目录
   ├─ symlink.rs     # 符号链接逃逸检查（openat2/realpath/GetFinalPathNameByHandle）
   ├─ network.rs     # 出站白名单（内网 CIDR+ai-gateway）；越权外联即杀（尽力+监控）
   ├─ resource.rs    # CPU≤2 核/内存≤2GB/并发命令≤4
   └─ os/{linux,macos,windows}.rs   # 09 §7.1 矩阵的平台实现
```

依赖：protocol、store、hostapi（分类用的快模型经 session 转发 aigw）。

### 2.6 bbrt-delegate

职责：17 篇委派体系：CodingBackend trait 与三个适配器、事件归一化、进程组管理、健康检查、任务简报构造。

```
bbrt-delegate/src/
├─ lib.rs
├─ backend.rs        # trait CodingBackend（§8.1 方法表）+ BackendRegistry
├─ claude.rs         # Claude Code 适配器（stream-json 解析、参数映射 §8.2）
├─ zcode.rs          # zcode 适配器（对等实现，差异隔离于此）
├─ generic.rs        # 通用 CLI（行文本→stream.delta；仅 auto-edit+ 可用）
├─ builtin.rs        # 内置后端桥（进程内 08 篇循环，天然归一化）
├─ normalize.rs      # 子智能体事件→本协议事件（§8.3 映射表）
├─ procmgr.rs        # 进程组：新 pgid + BBW_SANDBOX=1 标记；取消协议（§8.4）；遗留进程扫描清理
├─ health.rs         # detect(--version) + 最小 headless 冒烟（§8.5）；版本能力矩阵
├─ workspace_lock.rs # 同工作区互斥文件锁（8035）
└─ brief.rs          # TaskBrief 结构化构造与校验（forbidden 转子进程约束）
```

依赖：protocol、sec（审计/注入）、store（delegate_task/coding_backend）。

### 2.7 bbrt-aigw

职责：ai-gateway 调用（HTTPS+SSE、用户 OBO token、X-BBW-Agent-Session 头）、失败重试与降档（08 §4.6）、用量计量。

```
bbrt-aigw/src/
├─ lib.rs
├─ client.rs         # POST /v1/chat/completions（OpenAI 兼容）；SSE 流解析→stream.delta
├─ retry.rs          # 断流幂等重试≤2；429/5xx 退避 3 次；强→快降档；仍败→8011 暂停
├─ usage.rs          # usage 上报宿主（计量聚合，12 篇）
└─ types.rs          # ChatReq/Chunk/ToolCall/Usage
```

依赖：protocol、hostapi（OBO token）。

### 2.8 bbrt-store

职责：SQLite 唯一封装；WAL 模式；迁移版本化；§11 全表 DDL 的唯一权威。

```
bbrt-store/src/
├─ lib.rs            # 连接管理（agent/ 目录、busy_timeout=5s、foreign_keys=on）
├─ migrations/       # 001_init.sql …（向前滚移，只增不改）
└─ queries/          # session.rs event.rs checkpoint.rs context.rs grant.rs
                      # audit_meta.rs violation.rs backend.rs delegate.rs
```

依赖：protocol（事件 payload 类型）。被 session/sec/tools/delegate 依赖。

### 2.9 bbrt-hostapi

职责：stdin/stdout 传输层、协议握手与版本协商、OBO 令牌生命周期代理、心跳应答。

```
bbrt-hostapi/src/
├─ lib.rs
├─ stdio.rs          # 行读写、背压（写缓冲 8MB 上限→fatal error）
├─ handshake.rs      # initialize 握手（§10.2）
├─ obo.rs            # OBO 令牌缓存（内存+过期表）；到期前 2min 发 obo.renew（§10.1）
└─ heartbeat.rs      # ping→pong（20s 周期由宿主发起，本侧只应答）
```

依赖：protocol。

### 2.10 bbrt-mcp（2026-11-07 裁决新增，D14 §6）

职责：MCP client——公司域 MCP 网关与个人/外部 MCP server 的连接管理、工具发现与受控调用。

```
bbrt-mcp/src/
├─ lib.rs
├─ transport.rs      # stdio（本地子进程）/ SSE+HTTP（远程网关）；帧式与重连经验复用 aigw/hostapi
├─ conn.rs           # 连接管理：initialize 握手、健康探测、断连重连（指数退避）与降级
├─ discovery.rs      # list_tools → 以 mcp.{server}.{tool} 命名空间注入 bbrt-tools 注册表
│                    # （风险级取 server 清单声明，缺失默认"中"；数量上限并入 10 篇 §4.6 规则）
├─ call.rs           # tools/call：从 hostapi OboCache 取主体令牌**逐请求注入**（sub=用户传播，
│                    # D14 §6.2 三层身份）；连接凭证仅 ① 连接层，由网关/配置代持
└─ policy.rs         # 租户策略缓存（mcp.{server}.* 通配禁用）；断连/未注册 → 注册表标灰，调用拒绝 8002
```

依赖：protocol、hostapi（OBO 令牌）；被 tools 依赖（网关工具执行转发）。**不依赖 session**——连接生命周期与宿主进程一致，非会话级。

**实现顺序（当前排期）**：checkpoint 接线（§4 预留消息落地）→ **bbrt-mcp（本节）** → 技能注入（tools.reload+技能索引）→ 探查子 Agent fanout（§7）→ 专家装配器（D14）。公司域工具（kb_query/doc_*/im_send/file_upload）的供给迁移随本 crate 落地，`builtin/corp.rs` 直连 REST 路线废止（09 篇 §3.1 注记）。

## 3. 会话状态机全图

内部 9 态（+starting）；`session.state` 上报即用此枚举（D11 细化，见 §4 与开放问题 1）：

```
                 session.start
      ┌────────────► starting ──初始化失败(工作区无效/8012)──► error ──┐
      │              │ ready(初始化完成, 发 session.ready)             │
      │              ▼                                               │
      │◄──新输入(user.message)── idle ──┐                             │
      │                               │ 进入循环                      │
      │   ┌────────────────────────── running ◄──────────────────┐   │
      │   │        │        │           │            │           │   │
      │   │ 需确认(permission.request, 120s 计时)                   │   │
      │   │        ▼        │           │            │           │   │
      │   │  waiting_permission         │            │           │   │
      │   │   │允许/拒绝(回填理由)─►running           │           │   │
      │   │   │超时=拒绝(计数+1)─►running             │           │   │
      │   │   │累计≥3 次超时────►paused               │           │   │
      │   │        │ complex 判定→fan-out             │           │   │
      │   │        ▼                                  │           │   │
      │   │  subagent_fanout ──join 汇总完成──►running │           │   │
      │   │        │ coding.delegate 确认后启动        │           │   │
      │   │        ▼                                  │           │   │
      │   │    delegating ──delegate.end+diff提取──────┼──►waiting_review
      │   │        │                                  │           │   │
      │   │        ▼ (审查卡: 接受/拒绝恢复)            │           │   │
      │   │    waiting_review ──decision──►running / ended          │   │
      │   │                                             │         │   │
      │   │ 用户暂停/OBO 续签失败(60s)/8011/步数>50/    │         │   │
      │   │ 连续工具失败>3/休眠>10min/紧急停止          │         │   │
      │   └───────────────► paused ──resume/续签成功/网络恢复──► running│
      │                                                                │   │
      └── 任务完成(模型 stop)◄── running                                │   │
      ── session.end(正常/登出/agent.revoked) ──► ended ◄──(任意态)───────┘
                                   error ──用户重试/恢复成功──► paused→running
```

全迁移表（超时与条件）：

| # | from → to | 触发条件 | 超时/阈值 | 上报 |
|---|---|---|---|---|
| 1 | (new)→starting | session.start | — | session.state(starting) |
| 2 | starting→idle | 工作区加载、上下文恢复完成 | 恢复重放 >30s → error(8012) | session.ready |
| 3 | starting→error | 工作区无效/重放损坏 | — | error(8012, fatal=false) |
| 4 | idle→running | user.message（有效任务文本） | — | session.state(running) |
| 5 | running→idle | 模型 finish=stop（任务完成） | — | stream.done + state(idle) |
| 6 | running→waiting_permission | 门控第⑥步 confirm | 120s/次 | permission.request |
| 7 | waiting_permission→running | 允许/拒绝/单次超时（=拒绝，理由回填） | — | permission.response 镜像 |
| 8 | waiting_permission→paused | 累计 ≥3 次超时（09 §7.4） | — | state(paused) |
| 9 | running→subagent_fanout | 快模型判定 complex 且任务可并行探查 | 全部子任务 ≤15 步 | subagent.spawn×n |
| 10 | subagent_fanout→running | join 汇总（含失败子任务的失败标注） | 单子任务 >15 步自杀 | subagent.join |
| 11 | running→delegating | coding.delegate 确认通过、子进程 spawn 成功 | 工作区锁获取失败 → 拒绝 8035 | delegate.launch ack + delegate.event |
| 12 | delegating→running | delegate.end(exit=0)，diff 已提取并建 cp | — | delegate.end |
| 13 | delegating→error | 子进程异常退出/委派超时 | 软超时默认 30min（可配）→8034 | error(8033/8034) |
| 14 | running→waiting_review | 委派完成/编排层判定需用户审查 | 无自动超时（等待用户） | —（UI 审查卡） |
| 15 | waiting_review→running | 接受/拒绝并恢复 cp 后继续 | — | delegate.review ack |
| 16 | running→paused | 用户暂停 / OBO 到期 60s 续不上 / 8011 / 步数>50 / 连续失败>3 / 休眠>10min / 紧急停止 | 紧急停止=未决权限作废 | state(paused) |
| 17 | paused→running | session.resume / 续签成功 / 网络恢复重试 | — | state(running) |
| 18 | running→error | 不可恢复错误（压缩后仍超限 8010 等） | — | error(code) |
| 19 | 任意→ended | session.end（正常/登出/revoked）；OBO 销毁、进程清理 | — | session.ended(summary) |
| 20 | error→paused | 用户选择重试（可续跑错误） | — | state(paused) |

不变量：transition() 是唯一出口，每次迁移同步 WAL（§9.1）与 `session.state` 消息；waiting_permission 期间其余工具调用排队（严格串行）；delegating 期间同工作区锁持有。

## 4. stdio JSONL 全消息表（宿主 ↔ Runtime）

信封（08 §6.1）：`{"v":1,"id":"h-…|r-…","reply_to":"…?","type":"…","ts":…,"payload":{…}}`，UTF-8 每行一条。**ack 语义分三类**：
- `REQ`（请求）：接收方必须回 `reply_to` 指向的成对结果；宿主请求 Runtime 10s 未回 → 宿主重发或判不健康；
- `NTF`（通知）：单方向，无需回执（可靠性由事件镜像+重放保证）；
- `UNT`（上行通知）：Runtime→宿主事件流，宿主转发 UI；无需 ack。

全表（v1；★=D11 细化/新增，其余源自 08 §6.1 / 17 §8）：

| 方向 | type | 语义 | payload 字段 | 触发时机 | ack |
|---|---|---|---|---|---|
| 宿主→RT | initialize | 握手 | protocolVersion, capabilities[], dataDir, proxyConfig | 进程拉起后首条 | REQ→initialize.result |
| RT→宿主 | initialize.result | 握手回执 | runtimeVersion, tools[], capabilities[] | 收 initialize | 回执 |
| RT→宿主 | runtime.ready ★ | 就绪信号 | runtimeVersion, activeSessions=0, walHealthy | 握手后、进入服务态前 | NTF |
| 宿主→RT | session.start | 新建/恢复会话 | sessionId, workspace, mode, modelPolicy, skills[], historyRef(恢复指针), backendHint? | 用户新建/崩溃恢复 | REQ→session.ready |
| RT→宿主 | session.ready ★（=08 session.started 细化） | 会话可用 | sessionId, restored(bool), replayedEvents?, warnings[] | 初始化/重放完成 | 回执 |
| 宿主→RT | user.message | 用户输入 | sessionId, text, attachments[], slash?(/strong…) | 用户发送/斜杠指令 | REQ（回执=接受入队） |
| RT→宿主 | stream.delta | 流式增量 | sessionId, delta, seq, channel(text\|reasoning)★ | SSE chunk 到达 | UNT |
| RT→宿主 | stream.done | 一轮生成结束 | sessionId, finishReason, usage{in,out} | SSE 结束 | UNT |
| RT→宿主 | tool.call | 工具调用展示 | callId, sessionId, tool, args(脱敏), risk, parallel, source(self\|backend)★ | 管线第 0 步（含后端归一化事件） | UNT |
| RT→宿主 | tool.result | 工具结果摘要 | callId, ok, summary, truncated, exitCode?, blocked?{rule,kind}, durationMs★ | 管线第 8 步 | UNT |
| RT→宿主 | permission.request | 权限确认 | requestId, tool, risk, args, reason, preview{kind:command/diff/obo, …}, options[once/session/permanent?] | 门控第⑥步 | UNT（等待下行 response，120s） |
| 宿主→RT | permission.response | 确认回执 | requestId, decision(allow/deny), scope, editedArgs?, acceptedHunks? | 用户 y/n/a | REQ |
| 宿主→RT | checkpoint.create ★ | 手动建检查点 | sessionId, reason=manual | PAG-06 [+手动创建] | REQ→checkpoint.created |
| RT→宿主 | checkpoint.created ★（=08 checkpoint.event 细化） | 检查点已建 | checkpointId, sessionId, filesChanged[], reason(pre-edit/pre-command/manual/delegate/pre-restore), gitRef | 修改类工具首次执行前/委派启动前/恢复前/手动 | UNT |
| 宿主→RT | checkpoint.restore ★ | 恢复 | checkpointId | 用户确认恢复 | REQ→checkpoint.restored {ok, newCheckpointId}（恢复前自动建 pre-restore 保护快照；2026-11-07 落地命名） |
| RT→宿主 | checkpoint.restored | 恢复回执 | ok, newCheckpointId, error | 同上 | REQ 成对回执 |
| RT→宿主 | compaction.event | 压缩通知 | sessionId, phase(start/done), freedTokens, keptRounds | §5.2 | UNT |
| RT→宿主 | model.switched | 档位切换 | sessionId, from, to, reason(auto/user/降档) | §路由规则 | UNT |
| RT→宿主 | subagent.spawn ★ | 子 Agent 派生 | sessionId, subId, taskDigest, toolSubset | §7 fan-out | UNT |
| RT→宿主 | subagent.event | 子 Agent 事件 | subId, phase(spawn/delta/done/fail), summary | 子循环内 | UNT |
| RT→宿主 | subagent.join ★ | 汇总完成 | sessionId, results[{subId, ok, summary≤2k}] | 全部 join/自杀 | UNT |
| RT→宿主 | delegate.brief ★ | 简报待确认 | sessionId, brief{task,workspace,constraints[],context[{source,excerpt}],acceptance[],forbidden[]}, backendSuggestion | 编排层生成简报后、启动前 | UNT（等待 delegate.launch） |
| 宿主→RT | delegate.launch | 确认委派（17 §8） | sessionId, delegateTaskId, backend, taskBrief(可被用户编辑), mode, workspace | 用户确认简报 | REQ→回执{pid} |
| RT→宿主 | delegate.event | 委派归一化事件 | delegateTaskId, kind(output/tool_use/tool_result/warning/meta), payload | §8.3 归一化 | UNT |
| 宿主→RT | delegate.input ★ | 追加指令（17 send_input） | delegateTaskId, text | 用户追加 | REQ |
| 宿主→RT | delegate.cancel | 取消委派（17 §8） | delegateTaskId, graceful | 用户取消/紧急停止 | REQ |
| RT→宿主 | delegate.end | 子进程退出 | delegateTaskId, exitCode, summary, changedFiles[], checkpointId, childSessionRef | finalize() | UNT |
| 宿主→RT | delegate.review ★（17 §8 的确认侧） | 审查结论 | delegateTaskId, decision(accept/reject), rejectedHunks? | 用户审查 | REQ |
| 宿主→RT | session.pause / session.resume | 暂停/恢复 | sessionId | 用户/宿主 | REQ |
| RT→宿主 | session.state | 状态迁移 | sessionId, state(§3 枚举), reason | transition() | UNT |
| 宿主→RT | session.end | 结束 | sessionId, reason(normal/logout/revoked) | 用户/登出/吊销 | REQ |
| RT→宿主 | session.ended | 结束回执 | sessionId, summary | 清理完成 | 回执 |
| 宿主→RT | obo.token | OBO 发放/续签 | token, exp, scopes[] | 宿主主动/应 obo.renew | NTF |
| RT→宿主 | obo.renew | 请求续签 | scopes[], reason(expiring/insufficient) | 到期前 2min / scope 不足 | REQ（回执=obo.token 或 error） |
| 宿主→RT | tools.reload | 工具热重载 | reason(app/skill/policy) | 10 篇通道/策略变更 | REQ |
| 双向 | ping / pong | 健康 | — | 宿主每 20s ping，RT 立即 pong；5s 未回判不健康 | ping=REQ |
| RT→宿主 | error | 协议级错误 | code(8xxx), message, fatal(bool), sessionId? | 任一环节失败 | NTF；fatal=true 时 Runtime 退出前flush WAL |

编解码规则：未知 type → 忽略+计数上报（前向兼容，14 §8）；payload 校验失败 → error(9001, fatal=false)；半行/超长行 → codec 缓冲丢弃并 error。

## 5. 上下文引擎（bbrt-context）

### 5.1 token 预算公式与分配表

```
W      = min(模型窗口, 租户上限)        # 默认 128k
T_out  = 10% × W                        # 输出预留（不占用）
T_ctx  = W − T_out
区块预算（T_ctx 的占比）：
  system 5% | 技能 5% | 项目上下文 10% | 会话历史 40% | 工具结果 30%
软上限：estimate(history) + estimate(tool_results) ≥ 75% × (40%+30%)×T_ctx → 触发 compaction
estimate()：启发式（CJK 1字≈1token / ASCII 4字符≈1token）+ 每模型校准表修正
弹性规则：技能/项目块未用满时，余量让渡给历史+工具结果（按 4:3）；任何区块不得挤占 T_out
```

### 5.2 compaction 算法伪码

```
function compact(session):
  emit(compaction.event, phase=start)
  keep  = 最近 N=6 轮原文
  old   = history − keep                       # 最旧一半轮次优先
  # 关键文件 map 始终保留（path→用途一句话+关键行号），不入压缩
  archive = aigw.fast_model.summarize(old)     # bullet 摘要，≤2k tokens
  if archive.failed:                           # 快模型失败→退化
     archive = truncate_oldest(old); warn("压缩退化为截断")
  session.history = [archive 标注"[已压缩摘要，原文见本地事件镜像]"] + keep
  persist(agent_context, 压缩态)               # 恢复会话不丢历史
  emit(compaction.event, phase=done, freedTokens, keptRounds=6)
  if estimate(session) > T_ctx: error(8010)    # 提示精简任务/新建会话/更大窗口模型
```

手动压缩：用户 /compact → 同流程；归档段可展开（UI 从事件镜像取原文，不回上下文）。

### 5.3 read_file 摘录策略实现要点

| 要点 | 实现 |
|---|---|
| 默认区间 | 起始 400 行或 32KB（先到为准）；带行号返回 |
| 超长文件 | 返回 total_lines + 首段 + 提示"可指定行区间再读"；模型带 offset/limit 分页续读（结果标注 [truncated, offset=X]） |
| 二进制/非 UTF-8 | 拒读内容，仅返回元信息（size/mtime/类型嗅探） |
| 敏感文件 | .env*/ *.pem / id_rsa* / *credentials* / .npmrc 默认拒（8026）；显式授权后仍打码（masking 先于进上下文） |
| trust 标记 | 本地工作区文件=trusted；所有进入上下文的段带 trust 标签（§注入防御输入） |
| 大文件写绕过 | 文件类工具结果只回摘要+行数，强制模型再 read_file 摘录（09 §7.4） |

### 5.4 关键文件 map

维护：工具结果中出现的路径（read/edit/search 命中）→ 一句话用途 + 关键行号；LRU ≤64 条；compaction 不清除；随 agent_context 持久化。

## 6. 工具执行管线（bbrt-tools/pipeline.rs）

```
function execute_pipeline(session, call):
  # 0) 展示
  emit(tool.call, callId, tool, args=masking(args), risk)
  # 1) 风险级判定
  risk = registry.risk(tool)（mcp.*/app.* 取 server/生态清单，缺失默认"中"；未注册 → 拒绝 8002）
  # 2) 权限模式矩阵检查（gate①→③）
  d1 = sec.gate.policy(tool)            # 租户禁用 → 8006
  d2 = sec.gate.perm_point(tool)        # run_command/full-auto 权限点 → 8002
  d3 = sec.gate.matrix(mode, tool)      # 09 §4.1.1：A 放行 / X 拒绝 / C 走确认
  # 3) 三级记忆查询（gate④）
  if sec.memory.match(tool, args):      # once/session/permanent（参数模式匹配）
     decision=allow, source=memory      # 审计记 decision_source
  # 4) 需确认 → permission.request
  if need_confirm:
     emit(permission.request, preview(kind: command/diff/obo))
     ans = await(permission.response, timeout=120s)   # 超时=deny；editedArgs/acceptedHunks 生效
     if deny: append(拒绝理由); emit(tool.result, ok=false, blocked=…); return
  # 5) 沙箱校验（09 §4.3 [3][4][5]）
  sandbox.check_paths(args)  ∉ 白名单/符号链接逃逸 → 8020/8024（写 agent_sandbox_violation）
  sandbox.check_network(args) 越白名单 → 8025 + 杀进程
  # 6) 执行（按注册表来源分派）
  result = dispatch_by_source(call)      # builtin.execute（本地工具，沙箱内执行）
                                         # | mcp.call(call, obo)（网关/外部 MCP 工具：OboCache 取主体
                                         #   令牌逐请求注入，连接凭证由 bbrt-mcp 持有，D14 §6.2）
                                         # | coding.* → delegate 事件桥（§8）
                                         # 超时默认 300s（1–600s）→ 取消（本地 SIGKILL 进程组 8023 / MCP 侧取消请求）
                                         # 输出累计 1MB 截断头尾各 50%；资源超限→杀+8022（本地进程）
  # 7) 结果脱敏
  result = masking(result)               # 打码先于上下文/UI/审计 args_digest
  # 8) 审计 JSONL 追加（哈希链）
  sec.audit.append({ts, session_id, call_id, tool, args_digest, result_digest,
                    decision, decision_source, prev_hash→hash})
  # 9) 回填上下文
  ctx.push_tool_result(truncate(result)) # 单条截断/分页；旧结果降级摘要
  emit(tool.result, ok, summary, truncated, exit_code, durationMs)
```

只读并行：read_file/list_dir/search_files/glob/kb_query/doc_read 且 parallel_safe → 可交子 Agent（§7）或并行分发；修改类一律主循环串行（08 §4.5）。修改类首次执行前：`git_snapshot()` → checkpoint.created(pre-edit)（同批共用，间隔 >5min 或跨任务再建，08 §4.4）。

## 7. 子 Agent 调度器（session/loop_runner + tools/dispatcher）

```
function fanout(session, subtasks):        # 触发：快模型判定 complex（多目录/多文件/多信息源）
  subs = subtasks.take(3)                  # 并发 ≤3（探查类，只读子集）
  for s in subs:
     ctx = 独立上下文 = system(只读探查角色) + 任务指令（仅 s，无主历史） 
         + 工具子集 {read_file, list_dir, search_files, glob, kb_query, doc_read}
     emit(subagent.spawn, subId, taskDigest, toolSubset)
     spawn(sub_loop, steps_limit=15, model=快)
  join:                                    # 任一失败不阻塞
     done → summary ≤2k tokens（不回传原文）
     超步自杀(>15) → 返回部分结果 + fail 标注
     emit(subagent.join, results[])
  主 Agent 基于摘要继续规划（失败项自行补查或标注）
```

约束：子 Agent 复用 09 篇权限模型（只读子集天然 A 放行）；子 Agent 事件全部入 WAL 与审计；子 Agent 不产生检查点（无修改）。

## 8. 委派适配器内部（bbrt-delegate）

### 8.1 CodingBackend trait 方法表

| 方法 | 入参 | 出参/行为 |
|---|---|---|
| detect() | — | BackendProbe{installed, path, version, capabilities} |
| probe_health() | — | ok / 降级原因（版本不符 8031 / 未登录 / 冒烟失败） |
| launch(task_brief, opts{mode, workspace, env_allow}) | 简报+权限映射 | 子进程（新进程组）+ 会话句柄 |
| stream_events() | — | 归一化事件流（§8.3） |
| send_input(text) | 追加指令 | —（17 模式 C 续接基础） |
| cancel(graceful) | bool | §8.4 取消协议 |
| finalize() | — | {summary, changed_files, session_ref}（续接句柄） |

### 8.2 权限模式 → 启动参数映射（claude 适配器；启动前由编排层校验映射表声明）

| 本产品模式 | claude 参数 | 效果 |
|---|---|---|
| ask | `--permission-mode plan` + `--disallowedTools "Edit,Write,NotebookEdit,Bash"` | 只读探查+产出方案；改代码需用户切模式 |
| auto-edit | `--permission-mode acceptEdits` + `--allowedTools "Read,Edit,Write,Glob,Grep"`（Bash 入 disallowed） | 文件编辑放行、任意命令禁止 |
| full-auto | `--permission-mode bypassPermissions` 受门控换算 + `--allowedTools "Bash(cargo build:*),Bash(cargo test:*),…"`（白名单命令映射） | 编辑+白名单命令（构建/测试） |

固定参数：`claude -p "<简报>" --output-format stream-json --verbose`，cwd=工作区。**zcode 对等**：等价 headless CLI，参数语义同名映射（`--mode read-only|edit|full` + 工具白名单/确认开关），具体以 zcode CLI 正式文档为准（差异全部隔离在 zcode.rs，17 §11.1）。**通用 CLI**：无法表达细粒度限制 → 仅允许 auto-edit 以上委派 + 强 diff 审查（17 §5.2 原则：子智能体自主性不得超过用户授权档位）。

### 8.3 事件归一化映射表

| 子智能体原始事件（stream-json 等） | 归一化为 | 审批联动 |
|---|---|---|
| system/init 元信息 | delegate.event(kind=meta) | — |
| assistant 流式文本 | stream.delta（source=backend） | — |
| tool_use（编辑/命令） | tool.call（source=backend, risk 按映射） | 按权限模式：自动放行 / 升级审批卡（PAG-04） |
| tool_result | tool.result | — |
| 权限询问（headless 下不应出现） | delegate.event(kind=warning) | 终止+建议改参数组合（17 §3.3） |
| 进程退出 | delegate.end{exitCode, changedFiles, childSessionRef} | 触发 diff 审查卡（waiting_review） |

全部归一化事件同步写审计（kind 前缀 delegate.* / child.tool_use，字段含父会话 ID、任务 ID、后端类型与版本，17 §5.3）。

### 8.4 进程组取消协议

```
cancel(graceful=true):  SIGINT(pgid) → 等 3s → 未退出则 SIGKILL 整进程树（递归 pgid/任务对象）
cancel(graceful=false): 直接 SIGKILL 树
启动即：setsid/posix_spawn setpgid/Job Object + env BBW_SANDBOX=1
Runtime 启动时扫描"带标记且父进程已死"的遗留进程并清理（09 §4.6）
```

### 8.5 健康检查

detect：`<bin> --version`（超时 5s）；冒烟：最小 headless 调用（如 `claude -p "ping" --output-format json`，超时 30s，测 3 次）；版本能力矩阵决定可用参数集（不兼容 → 8031，提示锁定版本或降级，17 §9）。

## 9. 崩溃恢复（bbrt-session/wal.rs + recovery.rs）

### 9.1 事件镜像 WAL 格式

- 存储：SQLite `agent_event`（§11）+ 同步 JSONL 双写；**写前日志**：每个出站/入站事件先 `INSERT agent_event(seq 单调)` 并 fsync，再执行对应动作（工具先写意图再执行）。
- 记录：`(id, session_id, seq, type, payload, created_at)`；会话启动时记 `session.start`（含 historyRef）、结束时记 `session.ended`（WAL 闭合标记）。
- 每会话检查点 LSN：`agent_checkpoint.last_event_seq`——该检查点建立时的事件序号。

### 9.2 重放协议

```
function recover(sessionId):
  cp = 最后一个 checkpoint（工作区状态基线）
  evts = agent_event where session_id=? and seq > cp.last_event_seq 顺序读取
  1) 完整性校验：seq 连续 + 首事件为 session.start + 末态一致；断裂/缺失 → 8012
  2) 重建：状态迁移事件重放 state 机 → 终态；stream/tool 事件重建时间线与上下文（压缩态从 agent_context 恢复）
  3) 未决处理：执行中的工具调用视为失败并回填理由；未决 permission.request 全部作废（重发新 requestId 重问）
  4) emit(session.ready, restored=true, replayedEvents=n)
  损坏（8012）→ 会话降级只读快照（UI 供用户新建会话续接，08 §9 / 09 §4.6）
```

宿主侧重启策略：pong 超时/进程退出 → 指数退避重启 ≤3 次 → 仍失败停止自动重启并提示（PAG-08）。

## 10. 与宿主交互（bbrt-hostapi）

### 10.1 OBO 令牌获取/续签

| 时机 | 行为 |
|---|---|
| 会话启动 | 需要 OBO 的首个公司域工具调用前，若缓存无有效 token → `obo.renew(scopes)`（REQ）等待 `obo.token` |
| 到期前 2min | 定时器触发 `obo.renew`（静默，UI 无感）；成功则原会话继续 |
| 续签失败/宿主拒绝 | 60s 宽限内重试；仍失败 → 会话 `paused`，UI 提示恢复登录（08 §4.2） |
| scope 收敛 | 续签返回的 scopes 小于所需 → 重算（03 §6.4）：收敛后可继续则继续，否则 permission.request(obo) 重新向用户申请 |
| 令牌边界 | token 仅存 Runtime 进程内存；不过 WebView、不下发子智能体（17 §5.1）、不写日志与审计明文 |

### 10.2 stdio 协议版本协商（v 字段）

initialize 携带 `protocolVersion`（宿主支持集）；Runtime 返回 `initialize.result.runtimeVersion + protocolVersion`；不一致时：大版本不同 → 宿主换发兼容版本 Runtime 包（08 §3.1 独立升级通道）；小版本差异 → 双方按"未知字段忽略、未知 type 跳过并计数"运行。`runtime.ready` 在握手完成后发出，宿主以此为"可接收 session.start"信号。

## 11. 本地 SQLite schema 全表 DDL（bbrt-store/migrations/001_init.sql）

```sql
-- 数据目录：客户端 agent/ 子目录；WAL 模式；busy_timeout=5000
CREATE TABLE agent_workspace (
  id             TEXT PRIMARY KEY,             -- ws-<ulid>
  path           TEXT NOT NULL UNIQUE,         -- realpath
  name           TEXT NOT NULL,
  is_repo        INTEGER NOT NULL DEFAULT 0,   -- git 探测
  trusted        INTEGER NOT NULL DEFAULT 0,   -- 信任确认（08 §4.4）
  extra_dirs     TEXT,                         -- JSON: 例外目录[]
  last_opened_at INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE agent_session (
  id            TEXT PRIMARY KEY,              -- sess-<ulid>
  workspace_id  TEXT REFERENCES agent_workspace(id),
  title         TEXT NOT NULL DEFAULT '新会话',
  form          TEXT NOT NULL DEFAULT 'workbench' CHECK(form IN('embedded','workbench')),
  mode          TEXT NOT NULL DEFAULT 'ask' CHECK(mode IN('ask','auto-edit','full-auto')),
  backend       TEXT,                          -- 委派后端 zcode|claude|generic|builtin（17 篇增列）
  model_policy  TEXT NOT NULL DEFAULT 'auto' CHECK(model_policy IN('fast','strong','auto')),
  status        TEXT NOT NULL DEFAULT 'idle',  -- §3 状态机枚举
  share_enabled INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  summary       TEXT
);
CREATE INDEX idx_session_status ON agent_session(status, updated_at DESC);

CREATE TABLE agent_event (                     -- 事件镜像 WAL（§9.1）
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES agent_session(id),
  seq         INTEGER NOT NULL,                -- 会话内单调
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,                   -- JSON
  created_at  INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX idx_event_session ON agent_event(session_id, seq);

CREATE TABLE agent_checkpoint (
  id             TEXT PRIMARY KEY,             -- cp-<ulid>
  session_id     TEXT NOT NULL REFERENCES agent_session(id),
  git_ref        TEXT,                         -- refs/bbw-agent/{session}/cp-{n}
  untracked      TEXT,                         -- JSON: 未跟踪文件清单
  files_changed  TEXT NOT NULL,                -- JSON: [{path,add,del}]
  reason         TEXT NOT NULL CHECK(reason IN('pre-edit','pre-command','manual','delegate','pre-restore')),
  last_event_seq INTEGER NOT NULL,             -- 重放起点（§9.2）
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_cp_session ON agent_checkpoint(session_id, created_at DESC);

CREATE TABLE agent_context (                   -- 上下文持久化（压缩态）
  session_id      TEXT PRIMARY KEY REFERENCES agent_session(id),
  history         TEXT NOT NULL,               -- JSON: 近 N 轮
  archive_summary TEXT,                        -- JSON: 归档摘要段
  key_file_map    TEXT,                        -- JSON: path→{usage,lines}
  token_usage     TEXT NOT NULL,               -- JSON: {in,out,by_model}
  updated_at      INTEGER NOT NULL
);

CREATE TABLE agent_tool_grant (                -- 三级记忆（09 §4.2）
  id          TEXT PRIMARY KEY,
  session_id  TEXT,                            -- scope=session 时归属会话
  tool        TEXT NOT NULL,
  pattern     TEXT NOT NULL,                   -- 命令前缀/路径通配/域名
  scope       TEXT NOT NULL CHECK(scope IN('once','session','permanent')),
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,                         -- once=立即；session=会话结束
  source_card TEXT                             -- 审批卡摘要（PAG-11 展示）
);
CREATE INDEX idx_grant_tool ON agent_tool_grant(tool, scope);
-- permanent 同步镜像至文件 agent/allow.json（09 §4.2，不上云）

CREATE TABLE agent_audit_meta (                -- 审计 JSONL 索引与链头
  session_id  TEXT PRIMARY KEY REFERENCES agent_session(id),
  file_path   TEXT NOT NULL,                   -- agent/audit/{session}.jsonl
  events      INTEGER NOT NULL DEFAULT 0,
  first_ts    INTEGER, last_ts INTEGER,
  chain_head  TEXT NOT NULL,                   -- 哈希链头（锚定上报）
  anchored_at INTEGER,
  report_mode TEXT NOT NULL DEFAULT 'metadata' CHECK(report_mode IN('off','metadata','full'))
);

CREATE TABLE agent_sandbox_violation (         -- 被阻止操作（09 §5.1）
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agent_session(id),
  kind       TEXT NOT NULL CHECK(kind IN('path','network','resource','rule','danger-cmd')),
  detail     TEXT NOT NULL,                    -- 打码后
  code       INTEGER NOT NULL,                 -- 8020-8026
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_violation_session ON agent_sandbox_violation(session_id, ts DESC);

CREATE TABLE coding_backend (                  -- 17 §7
  id           TEXT PRIMARY KEY,               -- 类型即 id（zcode/claude/generic:bin/builtin）
  type         TEXT NOT NULL,
  path         TEXT,
  version      TEXT,
  capabilities TEXT NOT NULL,                  -- JSON: {edit,command,resume,smoke_ms}
  enabled      INTEGER NOT NULL DEFAULT 1,     -- 租户策略禁用→0（8032）
  is_default   INTEGER NOT NULL DEFAULT 0,
  detected_at  INTEGER NOT NULL
);

CREATE TABLE delegate_task (                   -- 17 §7
  id                TEXT PRIMARY KEY,          -- dt-<ulid>
  parent_session_id TEXT NOT NULL REFERENCES agent_session(id),
  backend_type      TEXT NOT NULL,
  task_brief        TEXT NOT NULL,             -- JSON TaskBrief
  status            TEXT NOT NULL DEFAULT 'preparing' CHECK(status IN
                    ('preparing','running','completed','failed','cancelled',
                     'reviewing','accepted','rejected_restored')),
  child_session_ref TEXT,                      -- --resume 等续接句柄
  exit_code         INTEGER,
  result_summary    TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER
);
CREATE INDEX idx_delegate_parent ON delegate_task(parent_session_id, created_at DESC);
-- D08 的 agent_approval_cache（宿主侧 UI 缓存表）不属 Runtime 库，DDL 见 D08 §6.1
```

## 12. 边界与异常

| 场景 | 机制 |
|---|---|
| 活跃会话 >3 | manager 拒绝 session.start，回 error（提示关闭旧会话） |
| 事件镜像磁盘写失败 | WAL 降级：暂停会话+error（审计不可丢）；恢复后补写 |
| 委派期间用户手动改仓库 | finalize 提取 diff 基线不一致 → 重建 checkpoint 基线并提示（17 §9） |
| 快模型分类不可用 | 危险命令识别保守 confirm（09 §4.4）；compaction 退化截断 |
| OBO token 泄漏面 | 仅 Runtime 内存+宿主通道；日志/审计/子进程全链路不可见明文 |
| 休眠/进程挂起 | 恢复后 SSE 按断流重试；>10min 未恢复 → paused |
| 同工作区双会话 | 委派互斥文件锁（8035）；提示冲突风险 |
| 内存预算 | 空闲 <80MB：上下文压缩态存储、事件镜像批量 flush、闲置会话 30min 无活动转 archived（可恢复） |
| 审计哈希链断裂 | 8027 告警（UI 高危横幅），本批不上报，标记待人工核验 |

## 13. 开放问题

1. **session.state 枚举差异**：08 §4.7 为 starting/active/thinking/tool_running/waiting_permission/paused/ended；D11 细化为 §3 的 9+1 态（active/thinking/tool_running 收敛为 running，新增 waiting_review/subagent_fanout/delegating/error）。建议回填 08 篇统一，UI（D08 §6.3 TS 类型）已按 D11 枚举。
2. **消息命名回填**：`session.ready`（原 session.started）、`checkpoint.created`（原 checkpoint.event）、新增 `runtime.ready/checkpoint.create/subagent.spawn/subagent.join/delegate.brief/delegate.input/delegate.review/stream.delta.channel` 需在 08 §6.1 / 17 §8 登记对齐（D08 开放问题 1/2 同源）。
3. token 估算启发式的按模型校准表来源（离线标定 vs 网关返回 usage 回填）——阶段三定。
4. 委派软超时默认 30min 的合理性（长任务如全量测试可能超）与"无超时+仅提示"档位。
5. cgroup 委派不可用（共享开发机）时资源限制自动降级策略的检测与提示（09 §9.5）。
6. WAL 双写（SQLite+JSONL）是否可合并为单写（SQLite WAL 模式性能实测后定）。
