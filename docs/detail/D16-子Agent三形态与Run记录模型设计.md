# D16 - 子 Agent 形态与 Run 记录模型设计

> **口径修订（2026-11-19）**：原「三形态」中的**类型 3 本机 CLI 委派**（bbrt-delegate：claude/zcode/generic 三后端、简报确认、diff 审查、DelegateCard）已**整域退役**；**会诊/协作图（team）**（Team Graph 三拓扑、黑板通信、TeamRun/NodeRun、FastCaster 组队选角）已**整域退役**（迁移 006）。run 模型与统一后台任务体系保留并推广到 **terminal 后台命令**（run_command 超时转后台）。现存形态=通用子 agent（probe）/专家（expert）+ terminal 后台任务，全部共用 agent_run 审计行。下方历史内容中涉及委派/team 的行已标注或改写，未标注的段落视为历史留档。

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（2026-11-09 定稿） |
| 上游 | [08-总体](../08-AI-Agent总体设计.md) §4.5 · [09-工具与安全](../09-AI-Agent工具与安全设计.md) · [detail/D11](D11-AgentRuntime内部详细设计.md) · [detail/D14](D14-专家Agent与多智能体协作设计.md) |
| 定位 | 子 Agent 形态的**最终口径**（与上游文档冲突处以本篇为准，见 §8）＋ run 记录模型（执行记录 / 调用链 / 审计 / 同步异步）；原三形态现为「通用子 agent / 专家 + terminal 后台任务」 |

---

## 1. 决策记录（用户裁决 2026-11-09）

> ① **类型 1＝通用子 agent**：不做声明式定义。system prompt、技能、记忆侧写、工具、MCP 与主 agent 完全一致，唯一区别是上下文历史清零＋收到主 agent 派发的任务提示词。原"只读探查"（08 §4.5）并入为一种**任务写法**（"只调查不改"），不再是独立机制与独立白名单。
> ② **类型 2＝专家**：与主 agent **共享工作空间**（桌面端形态下每个用户在自己机器/工作区运行，跨用户污染天然不存在，不做 workspace 隔离）。配置＝**建议配置（上游 manifest）＋本地覆写**三层模型（§6），用户可随意加工具、接自己的 MCP；无记忆。
> ③ **类型 3＝客户本机的 agent 能力**（Claude Code / zcode / opencode 等 headless CLI）：**不调用 BaobaoChat 后端能力**，模型流量走该 CLI 自己的账号；零公司凭证（OBO/模型 key 一个不传），公司上下文由编排层检索后以文本注入简报。
> ④ **同步/异步**：探查/专家 spawn 后同步等待 **120s**，超窗转后台；terminal 后台命令由 run_command 显式 `background:true` 或同步跑满 300s 自动转后台。**不设最大执行时长**——不做超时终止，仅用户主动 cancel/interrupt。
> ⑤ **run 落库一期仅本机 SQLite**；服务端上收（run 摘要 / agent_session_backup）阶段二。
> ⑥ **一次调用＝一次 run＝一条可重放审计流水**（修订 D14 决策②"无会话记录"：有审计记录、无可续聊会话、无记忆）。
> ⑦ **完成通知本地环先行**（2026-11-09 补记）：后台 run 完成时若工作台不可见（非 /agent 路由/窗口隐藏）弹**本机系统通知**（tauri-plugin-notification，懒申请权限，降级静默）；跨端 `agent_done`（服务端 user_notification → 多端推送）待服务端建立 agent 事件源后做。
> ⑧ **补充机制＝运行中调整**（2026-11-09 补记）：统一通道——探查/专家/terminal run 在执行前经 bg_hub 注册 per-run 指令通道（`subagent.adjust`/`subagent.cancel` 工具 + 宿主 `run.cancel` 协议，按 run_id 定向）：**Input 注入为 user 轮（"[主 Agent 补充指令]"前缀，下一模型轮生效）**、**Cancel 优雅取消（cancelled 终态，部分结果保留）**（原「委派侧 `delegate.input` 下发」子句随委派域退役删除，2026-11-19）。主 Agent 侧新增 `subagent.adjust`/`subagent.cancel` 工具（薄门面+专用路径拦截，经 hub 同通道）。**完成后追问（resume）不在此列**，另行立项。

## 2. 形态统一视图（最终版；原类型 3 委派已退役）

| 维度 | 类型 1 通用子 agent | 类型 2 专家 | （原类型 3 本机 CLI 委派——已退役） |
|---|---|---|---|
| 定义方式 | 无定义（内置通用形态） | manifest（建议配置）＋本地覆写 | 后端适配器（claude/zcode/generic，17 篇） |
| 工作空间 | 主工作区 | 主工作区（共享） | — |
| system prompt | **同主 agent**（同一组装管线） | persona（独立增量） | 后端自身 |
| 工具 | 全量注册表，同九步门控 | 白名单 ∩ 覆写 ∩ 硬上限 | 后端自身工具（权限模式映射约束） |
| MCP | 主会话 MCP | 主 MCP ∪ 个人自接 MCP（仅覆写层可加，§6） | 无（零凭证） |
| 记忆 | 共享主记忆侧写（同主注入，只读） | 无 | 后端自有 |
| 上下文 | 独立窗口（历史清零），预算可配 | 独立窗口（manifest 约束） | 后端自有会话（--resume 续接） |
| 鉴权 | 同主（OBO 同用户，act=agent:{session}） | 同主＋act=expert:{personaId}:{runId} | 零凭证，简报文本注入 |
| 审计 | run(kind=probe) | run(kind=expert, def_ref=id@ver) | —（kind=delegate 已删除；terminal 见下） |
| 等待窗 | 120s → 转后台 | 120s → 转后台 | 直接后台 |
| 产物 | 摘要回填主上下文（subagent.join） | 摘要/产物回填 | diff 审查卡＋checkpoint 回滚 |
| 时长上限 | 无（max_steps/token 预算防循环失控，非限时） | 无（同左） | 无（仅用户 cancel） |

**编排准则**（非硬编码）：只读任务可并行 fan-out，写任务串行并走审批；子 agent 的审批卡上行时标注来源 run，经同一 permission 通道路由。

## 3. Run 记录模型（对应总体要求 1/3）

### 3.1 数据结构（本地 SQLite，migration 003）

```sql
CREATE TABLE agent_run (
    id               TEXT PRIMARY KEY,   -- r-{seq}，持久发号（跨重启唯一）
    session_id       TEXT NOT NULL,      -- 父会话（发起 spawn 的主会话）
    root_session_id  TEXT NOT NULL,      -- 调用链根会话（顶层 run＝父会话 id）
    parent_run_id    TEXT NOT NULL DEFAULT '', -- 父 run（嵌套子任务用；顶层恒空）
    parent_call_id   TEXT NOT NULL DEFAULT '', -- 触发本次 run 的工具调用 id（terminal=run_command call_id）
    kind             TEXT NOT NULL,      -- probe | expert | terminal
    def_ref          TEXT NOT NULL DEFAULT '', -- builtin.probe / {expertId}@{version} / shell
    status           TEXT NOT NULL,      -- running | done | failed | cancelled | interrupted
    eta_hint_ms      INTEGER NOT NULL DEFAULT 0,
    eta_actual_ms    INTEGER NOT NULL DEFAULT 0,
    summary          TEXT NOT NULL DEFAULT '',  -- 结果摘要（join 回填内容的截断快照）
    -- （原 child_session_ref 委派续接句柄列已随 005 迁移删除）
    actor            TEXT NOT NULL DEFAULT '',  -- OBO subject 快照（鉴权审计）
    created_at       INTEGER NOT NULL,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER
);
ALTER TABLE agent_event ADD COLUMN run_id TEXT NOT NULL DEFAULT '';
```

- **发号**：`r-{max(seq)+1}`，store 内单连接互斥下自增，跨重启不重号。
- **事件归属**：主循环事件 run_id=''；子 agent 的 spawn/join/tool/result/delta 里程碑事件带 run_id——**一条 run ＋ 其事件流即可完整重放一次调用**（审计口径）。
- **状态机**：`running → done | failed | cancelled | interrupted`；`interrupted` 仅崩溃恢复写入（§3.2）。探查/专家原进程内临时 id（sub-{ms}-{i}/act-{ms}-{seq}）废弃，一律换持久 run_id。
- **遗留表**：`delegate_task`（001 篇 DDL，从未接线）与 `coding_backend` 已由 005 迁移删除（2026-11-19 委派域退役同批）。

### 3.2 崩溃恢复语义

- recovery 重放按 `subagent.* / terminal.*` 与 agent_run 表收口：恢复时将所有 status=running 的 run 置 `interrupted`（terminal 后台进程组由启动侧收口；原 bbrt-delegate 孤儿扫描已随 crate 删除）。
- 恢复后 UI 在会话流标记"子任务已中断"，可重发；不做 run 级断点续跑（一次性语义）。

## 4. 调用链（对应总体要求 2）

- 本地链：`root_session_id → session → run(run_id) → 事件`；过程明细统一走 `subagent.trace`（probe/terminal 同构）。
- **三处断链修复**（P0-2，历史）：① `delegate_bridge` 的 `LaunchOpts.parent_session_id` 传空串；② 指令路由由广播改为按 run_id 定向（现为 `respond_run_cancel`→bg_hub.route）；③ DelegateEnd 上行字段补齐（随委派域退役删除）；下述明细为历史留档：原 bridge.rs DelegateEnd 上行丢 changed_files/checkpoint_id/child_session_ref。
- 服务端侧：aigw 归因头 `X-BBC-Agent-Session`＋`X-BBC-Scene(chat/expert)` 已有，后续把 run_id 带入归因头即可在 `ai_usage_hourly` 上串起成本链（阶段二，随 run 上收；delegate 场景已随委派域退役）。

## 5. 同步/异步与 ETA（对应总体要求 6）

| 形态 | spawn 后行为 | 超窗/完成 | 取结果 |
|---|---|---|---|
| 探查/专家（类型 1/2） | 主 turn 同步等待 **120s**（可配） | 超窗→转后台，turn 继续；完成→`subagent.join` 回填＋通知 | run 面板 `runs.list/get/cancel`；join 自动回填 |
| terminal 后台命令 | 显式 `background:true` 或同步超 300s 自动转后台，turn 立即返回任务 id | 完成时 task.wait 可取回 exit+输出；主 Agent 经 bg_hub park 回执（失败也回填） | `subagent.cancel`（SIGINT→宽限→SIGKILL 进程组）或宿主 `run.cancel` |

- **ETA**：静态初值表（kind×def_ref）＋store 内按 def_ref 滚动统计最近 N 次 `eta_actual_ms` 修正；spawn 时写 run.eta_hint_ms 并随 `subagent.spawn` 事件上行展示。
- **无最大执行时长**：不做超时终止（8034 留档不启用）；护栏仅 max_steps/token 预算（循环安全）与用户 cancel。转后台后 UI 显示已运行时长＋ETA。
- **通知**：完成→本地 Tauri 通知＋（IM 在线时）`user_notification.kind=agent_done`（服务端已预留枚举）。
- **实现要点**：后台任务事件循环移出 turn 线程（专用线程＋通道，会话不再 Busy）；探查/专家等待窗由 turn 线程限时 wait，超窗把 join 挂到后台完成时投递；terminal 后台命令由专用收割线程轮询 `try_wait` 并落终态。

## 6. 专家建议配置＋本地覆写（对应总体要求 5）

```
生效配置 = 上游 manifest（建议配置，签名担责）
         → 用户本地覆写（可加工具/加 MCP/调步数/调预算/调档位）
         → 硬上限（不可覆写：租户策略 ∩ 用户自身权限档位 ∩ 运行时注册表真实存在）
```

- **覆写唯一红线**：专家权限不得高于用户给主 agent 授权的档位（防提权；高危工具该审批仍审批）。
- **override 文件**：`{dataDir}/eco/experts/{id}.override.yaml`，与 manifest 同 schema 子集；上游新版本→保留覆写、UI 提示 diff。
- **个人 MCP 自接**：用户在客户端设置的个人 MCP server 配置里注册；**只能经覆写层引用**（上游 manifest 不得携带非公司网关的 server，防公司专家夹带外部端点）；凭证由编排层保管（KMS/OBO），不给专家明文 key。
- **闭环**：改完可"另存为我的专家"发到个人库（usr.{uid}. 前缀通道已有），形成 建议配置→本地魔改→再发布。
- 类型 1 无声明式定义（决策①），不参与 eco 分发。

## 7. 落地清单

| 优先级 | 项 | 内容 |
|---|---|---|
| P0-1 | run 记录模型 | migration 003＋发号＋探查/专家（委派线已退役）接线写库＋事件带 run_id |
| P0-2 | 调用链断链修复 | §4 三处 |
| P0-3 | 后台化 | 事件循环出 turn 线程＋直接后台＋完成通知（原委派异步化扩为统一后台任务体系，含 terminal） |
| P0-4 | 客户端可见性 | Tauri 壳 agent_* 接线＋subagent.* 渲染子任务卡（120s 窗/转后台状态/审批标注来源 run；delegate.* 已退役） |
| P1-5 | 专家启用＋覆写层 | experts 装配启用、override 合并、diff 提示、另存为个人专家、个人 MCP 配置面 |
| P1-6 | ETA＋转后台通知链 | 静态表＋滚动统计、等待窗、agent_done 通知、runs 面板 |
| P1-7 | 通用子 agent 化 | subagent 挂全量工具＋主 prompt 组装复用；只读探查并入任务写法 |
| P2 | 恢复/审计强化 | recovery 子 agent 分支重放（interrupted 标记随 P0-1 落库先行）、agent_audit_meta 哈希链、run 摘要服务端上收 |

## 8. 对上游文档的修订点

| 上游 | 原文 | 修订 |
|---|---|---|
| 08 §4.5 | 探查子 Agent 只读白名单工具集、专用快路径 | 通用化：同主 prompt＋全量工具（同门控）；"只读探查"为任务写法（P1-7） |
| D14 决策② | 子 Agent 无会话记录 | 修订为：**无可续聊会话、无记忆，但每次调用落 run 审计流水**（本篇 §3） |
| ~~17 篇 §6/错误码~~ | ~~8034 委派软超时 30min~~ | **取消超时语义**：无最大执行时长，仅用户 cancel（决策④；8034 已随委派域退役） |
| ~~17 篇 §4~~ | ~~委派同步阻塞 turn~~ | 后台化后 turn 立即返回（P0-3；委派形态已退役，口径沿用至 terminal） |
| D14 §2 manifest | constraints 无 workspace 字段 | 维持无字段：专家共享主工作区（决策②） |
