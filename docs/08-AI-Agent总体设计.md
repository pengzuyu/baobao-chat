# 08 - AI Agent 总体设计

> **⚠ 2026-11 瘦身注记**：文档中心（doc）与 Webhook 机器人（bot）域已移除——本文涉及 doc/bot 的章节（功能项、表结构、事件、错误码、部署组件等）已作废，以代码现状与 14 篇协议注册表的"已废弃"标记为准。生态应用/技能（eco）保留（Agent 运行时供给通道）。删除前快照：git 分支 `backup/full-suite-20261109`。

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1 |
| 上游文档 | [00-总体](00-产品总体设计说明书.md) · [01-技术选型](01-技术选型说明.md) · [02-架构](02-系统总体架构.md) · [03-身份与权限](03-身份认证与权限体系.md) · [14-协议](14-通信协议设计.md) |
| 下游文档 | 09（工具与安全） · 10（生态应用与技能分发） |
| 本篇定位 | Agent Runtime 进程架构、自研核心循环、上下文工程、工作区与检查点、会话形态、子 Agent、模型路由、服务端关联、IM 联动 |

---

## 1. 功能概述

### 1.1 定位

Agent 是 BaobaoWork 的一等公民（00 篇 §2.2）：一个运行在员工本机、以员工本人身份工作的"数字员工"，对标 zcode（Claude Code 类编码代理）对单个项目做开发的能力：

- 打开本地项目工作区，读写代码、执行脚本/命令、使用本人系统权限；
- 访问公司内部内容（文档/知识库/生态应用）**一律以用户身份**（OBO，03 篇 §6）鉴权，Agent 永远没有独立账号；
- Agent Runtime 为 Rust sidecar 独立进程（01 篇 §4），**自研循环，不引入 LangChain/LlamaIndex 等框架**；
- **编排与执行分离（17 篇）**：Runtime 的定位是"**编排者**"——需求澄清、公司上下文收集（KB/文档/生态应用，OBO）、任务拆分、审查与汇总；**编码执行优先委派给用户本机的成熟编码智能体**（zcode / Claude Code 等，headless 适配器，17 篇），本篇 §4.1 的自研编码循环保留为**内置兜底后端**。

### 1.2 设计原则（逐条对齐 00 篇 §5 P0）

| # | 原则 | 在本篇的落地 |
|---|---|---|
| P0-1 | 身份一致性（OBO） | 一切内部 API 访问携带用户 OBO token（scope 子集 + `act` 声明，≤15 min，03 篇 §6）；模型调用亦用用户 token 走 ai-gateway，Runtime 不持有任何模型密钥 |
| P0-2 | 本地优先执行 | Agent 循环、工具执行全部发生在用户设备的 Runtime 进程内；服务端只做鉴权、模型代理、分发与审计，不执行用户代码 |
| P0-3 | 最小权限与显式授权 | 会话级三档权限模式（ask / auto-edit / full-auto）+ 逐工具门控与确认卡（09 篇） |
| P0-4 | 一切可审计 | 本地 JSONL 事件镜像 + 工具调用审计（哈希链）+ 服务端 OBO 审计上报（09 篇 §7） |
| P0-6 | 资源克制 | Runtime 空闲内存预算 < 80 MB；单设备同时活跃会话 ≤ 3；循环可随时暂停/终止 |
| P0-7 | 协议开放与演进 | 工具协议对齐 MCP 概念（10 篇）；stdio JSONL 协议带 `v` 版本号，前向兼容 |
| — | 自研不引框架 | 核心循环 < 2k 行 Rust（01 篇 §4）：框架抽象债与黑盒行为在企业审计场景不可接受 |

### 1.3 能力边界

| 做 | 不做 |
|---|---|
| 本地项目开发（读/写/改/跑测试/构建） | 不执行用户未确认的高危命令（09 篇门控） |
| 编码任务委派本地编码智能体（zcode/Claude Code/内置兜底，17 篇） | 不向子智能体下发任何公司凭证（OBO/模型 Key 只在编排层，17 篇 §5.1） |
| 脚本执行、git 检查点与恢复 | 不跨租户访问（P0-5） |
| 知识库/文档检索与摘要（OBO） | 不代替用户做最终业务审批决策（只准备材料、提交草稿） |
| 生态应用工具调用（OBO，10 篇） | 不常驻后台自动唤醒任务（阶段四评估定时任务） |
| 会话结论以卡片形式分享进 IM | 不在服务端执行任何用户代码 |

## 2. 角色与场景

| 角色 | 典型场景 | 会话形态 | 关键约束 |
|---|---|---|---|
| 普通成员（开发者） | "修复登录超时 bug 并跑通测试" | 工作台 | 检查点、diff 审批、终端流 |
| 普通成员（业务） | "查报销制度并总结成要点" | 聊天内嵌 | kb_query 走 OBO，只读为主 |
| 普通成员（业务） | "把本周改动总结发到项目群" | 工作台 | im_send 高危需确认（09 篇） |
| 部门管理员 | 为部门推荐/强制安装技能包 | — | 10 篇 §4.5 |
| 审计合规员 | 检索 Agent 工具调用与命令审计 | — | 09 篇 §7、12 篇 |
| 租户管理员 | 配置 full-auto 准入、云备份开关、上报策略 | — | 12 篇，事件 `agent.policy.updated`（09 篇） |

## 3. 进程架构与信息架构

### 3.1 进程架构

```
┌──────────────────────────── BaobaoWork 客户端 ────────────────────────────┐
│  UI 进程（WebView: React/TS）                                              │
│   ├ 聊天面板内嵌 Agent（轻量问答，§3.2 形态①）                               │
│   └ Agent 工作台视图（主导航独立页，§3.2 形态②）                              │
│         ▲ Tauri IPC（commands + events，双向；OBO token 永不过 WebView）     │
│  Rust 核心（Tauri 主进程）                                                  │
│   ├ Agent 管理器: sidecar 启停/健康监控/崩溃重启/stdio JSONL 转发            │
│   ├ OBO 令牌代理: 按需签发/静默续签/销毁（03 篇 §6）                          │
│   ├ 本地 SQLite: 会话元数据/事件镜像/检查点（§5.1）                           │
│         ▲ stdio（JSONL 消息，LSP 风格，协议见 §6.1）                          │
│  Agent Runtime（独立 Rust 进程；随客户端分发、版本可独立升级）                 │
│   ├ 会话管理器（多会话，活跃 ≤ 3）                                           │
│   ├ 上下文引擎（token 预算/自动压缩 compaction/关键文件 map，§4.3）           │
│   ├ 工具注册表（内置 + app.* + 技能，合并规则见 10 篇 §4.6）                  │
│   ├ 权限门控（模式×工具×记忆，09 篇 §4.1）                                   │
│   ├ 子 Agent 调度器（只读并行探查，§4.5）                                     │
│   ├ 审计 JSONL 追加日志（哈希链，09 篇 §7）                                   │
│   ├ LLM 客户端 ──(用户 OBO token, HTTPS+SSE)──► ai-gateway ──► 模型         │
│   └ 工具执行 ──(OBO token, REST 直连，不经 WSS[14 篇 §3.3])──►               │
│        kb / doc / im / file / app-registry(生态应用连接器转发, 10 篇)         │
└───────────────────────────────────────────────────────────────────────────┘
```

进程隔离收益（02 篇 §2 要点 3 的展开）：

| 收益 | 说明 |
|---|---|
| 崩溃隔离 | Runtime 崩溃/被杀，客户端（IM/文档/通话）完全不受影响（02 篇 §7 失败域） |
| 独立升级 | Runtime 二进制版本号独立于客户端主程序，经 10 篇分发通道热更，无需发整个客户端 |
| 资源可控 | Runtime 可被暂停（SIGSTOP 语义映射为会话 paused）、终止；空闲时退出，首用时秒级拉起 |
| 演进空间 | stdio JSONL 协议稳定后可暴露为 CLI，开发者可在终端直接使用（01 篇 §4） |

### 3.2 会话形态（两种）

| 维度 | 形态① 聊天面板内嵌 | 形态② 独立 Agent 工作台 |
|---|---|---|
| 入口 | 任意私聊/群聊输入框旁 Agent 按钮；Agent 卡片"追问" | 主导航"Agent"页 |
| 定位 | 轻量问答、检索总结、单文件小改动 | 项目开发、多步任务、终端与文件时间线 |
| 权限模式 | 固定 `ask`（不可切换 full-auto） | 三档可切换（09 篇） |
| 工作区 | 可选绑定（默认不绑） | 必须选择工作区（§4.4） |
| 检查点/恢复 | 无 | 有（右栏检查点列表 + 一键恢复） |
| 终端流 | 不显示原始 stdout，仅摘要 | 显示流式终端输出 |
| 升级路径 | 卡片上"转到工作台继续"，携带上下文摘要新建工作台会话 | — |

### 3.3 工作台信息架构（ASCII 线框）

```
┌───────────────────────────── Agent 工作台 ──────────────────────────────────┐
│ 权限模式: [auto-edit v]  模型: [强 v]  工作区: ~/code/bbw-server  ●运行中  ⏸ ■ │
├──────────┬────────────────────────────────────────────────┬─────────────────┤
│ 会话列表  │  ── 流式对话 / 终端输出 / 文件改动时间线 ──        │ 待审批队列 (2)   │
│ ● 修复登录│                                                 │ ┌命令执行──────┐ │
│ ○ 重构鉴权│  user: 帮我修复登录超时 bug                       │ │ cargo test   │ │
│ ○ 写周报  │  agent: 我先定位相关代码…                         │ │ [y] [n] [a]  │ │
│ ──────── │  v tool: search_files("session timeout")    ok   │ └──────────────┘ │
│ + 新会话  │  v tool: edit_file auth.rs (+8/-4, diff 已批)     │ ┌编辑请求──────┐ │
│          │  > 终端: cargo test --lib                        │ │ auth.rs ±12  │ │
│ 📁 工作区 │    running 12 passed ...                        │ │ [查看diff]    │ │
│ ~/code/  │  ── 文件改动时间线 ──                             │ │ [批准] [拒绝] │ │
│  bbw-svr │  14:02  auth.rs     +8/-4   [检查点 cp3]          │ └──────────────┘ │
│ 最近打开: │  14:05  session.rs +2/-2                          │ 检查点:          │
│ ~/code/  │                                                 │ cp3 14:02 [恢复]│
│  bbw-web │ [输入: 继续任务…                        发送  ^升档│ cp2 13:58 [恢复]│
│          │  到强模型]                                      │ (拖拽审批顺序)   │
└──────────┴────────────────────────────────────────────────┴─────────────────┘
```

| 区域 | 内容 |
|---|---|
| 会话头部 | 权限模式指示器（点击切换三档，09 篇 §3.3）、模型档位、工作区路径、运行状态、暂停/紧急停止 |
| 左栏 | 会话列表（状态点）、新会话、工作区与最近打开（系统目录选择器） |
| 中栏 | 三层混排：模型流式输出（stream.delta）、工具调用卡片（tool.call/result，可展开）、终端流（run_command stdout 流式 + 截断提示）；底部文件改动时间线 |
| 右栏 | 待审批队列（命令卡/编辑卡，支持批量审批与快捷键 y/n/a，09 篇 §3.4）、检查点列表与恢复 |

## 4. 核心流程

### 4.1 自研核心循环（伪代码）

```
function agent_loop(session, task):
  while true:
    # 1) 组装上下文：system + 技能(命中) + 项目 AGENTS.md + 压缩摘要 + 近N轮历史 + 工具结果
    ctx = assemble(session, task)
    if estimate_tokens(ctx) > budget: compact(session)          # §4.3 自动压缩
    # 2) 模型路由：快模型判定复杂度，复杂任务升档（§4.6）
    plan = classify_fast(session, task)
    # 3) ai-gateway 流式调用（用户 OBO token，SSE；工具清单按需注入，10 篇 §4.6）
    resp = ai_gateway.stream(ctx, tools=pick_tools(plan), model=route(plan))
    emit(stream.delta ...)                                       # 流式回 UI
    if resp.finish == "stop": emit(stream.done); break           # 任务完成，待新输入
    # 4) 解析工具调用（一轮 0..n 个）
    for call in resp.tool_calls:
      gate = permission_gate(call)                               # 09 篇 §4.1 门控
      if gate == deny:    append(拒绝理由); continue
      if gate == confirm: emit(permission.request);
                         ans = await_user(timeout=120s)          # 超时视为拒绝
                         if not ans.allow: append(用户拒绝理由); continue
      if call.mutates_workspace and no_recent_checkpoint():
         cp = git_snapshot(session.workspace); emit(checkpoint.event)   # §4.4 修改前快照
      if call.readonly and parallel_safe: results += await spawn_subagent(call)  # §4.5 并行
      else:                               results += await execute(call)         # 修改串行
      append(call, truncate(results))                            # 5) 结果回填（截断/分页）
    # 6) 循环中断条件（§4.2）
    if session.paused or user_offline: suspend(); break
    if steps > MAX_STEPS or consecutive_tool_failures > 3:
       pause_and_ask(session); break
```

### 4.2 循环中断与恢复条件

| 触发 | 状态迁移 | 恢复语义 |
|---|---|---|
| 任务完成（模型 stop） | running → idle | 等待下一条用户输入，上下文保留 |
| 用户暂停 / 紧急停止（09 篇 §4.6） | running → paused | 从最后一个已完成工具调用后继续 |
| 权限确认超时（120 s） | 单调用视为拒绝 | 不中断循环，拒绝理由回填给模型 |
| OBO token 到期且续签失败（60 s 内） | running → paused | 宿主恢复登录态后续签并继续 |
| ai-gateway 连续失败（重试+降档后仍失败，8011） | running → error(paused) | 网络恢复后手动/自动续跑 |
| 步数超限（默认 50 步）或连续工具失败 > 3 | running → paused | 模型向用户说明卡点，等待指示 |
| Runtime 崩溃 | 进程死亡 → 宿主重启 | 检查点 + 事件镜像重放（09 篇 §4.6） |
| 用户登出 / `force.logout` / `agent.revoked` | running → ended | OBO 销毁，会话冻结归档 |

### 4.3 上下文工程

**token 预算分配表**（默认按模型窗口 128k 配置，租户可按档位调整；总预算预留 10% 给模型输出）：

| 区块 | 占比 | 内容 | 注入策略 |
|---|---|---|---|
| system | 5% | 角色定义、循环规则、输出规范、权限与安全规则（09 篇 §6） | 每轮固定 |
| 技能 | 5% | 命中技能的 SKILL.md 正文（10 篇） | 按 trigger 命中/任务相关性选择，仅注入命中项 |
| 项目上下文 | 10% | AGENTS.md + 关键文件 map + git 状态摘要 | 工作区会话固定；关键文件 map 压缩后常驻 |
| 会话历史 | 40% | 近 N 轮完整对话与工具调用 | 压缩对象（下述 compaction） |
| 工具结果 | 30% | 当轮及近期工具输出 | 单条截断（§4.3.3），旧结果降级为摘要 |
| 输出预留 | 10% | 模型生成空间 | 不占用 |

**自动压缩 compaction（状态机）**：

```
idle ──历史区+工具区占用 ≥ 75%──► compacting
compacting: 快模型将"最旧一半轮次"摘要为归档段(bullet)
            + 保留最近 N=6 轮原文
            + 关键文件 map 始终保留(path → 用途一句话 + 关键行号)
            → compaction.event 上报 UI("已压缩 42k tokens，可展开查看归档")
       ──► idle    压缩后仍超限 → 报错 8010 并提示用户精简任务或新建会话
```

- 用户可手动触发压缩/展开归档查看；归档段在上下文中标注 `[已压缩摘要，原文见本地事件镜像]`。
- 压缩本身由快模型执行（§4.6），失败时退化为"直接截断最旧轮次"并告警。

**文件读取摘录策略（行区间）**：

| 规则 | 值 |
|---|---|
| read_file 默认区间 | 起始 400 行或 32 KB（先到为准），带行号返回 |
| 超长文件 | 返回 `total_lines` + 首段内容 + 提示"可指定行区间再读"；模型按需发起点区间请求 |
| 二进制/非 UTF-8 | 拒绝读取内容，仅返回元信息（大小/mtime/类型） |
| 敏感文件 | `.env`、私钥、凭据文件默认拒绝，显式授权后仍打码（09 篇 §6） |

**超长输出截断与分页**：run_command 输出上限 1 MB，超限保留头尾各 50%（09 篇 §4.3）；检索类工具单次最多返回 200 条命中并提示收窄条件；截断结果在上下文中标注 `[truncated, offset=X]`，模型可带 offset/limit 参数分页续读。

### 4.4 工作区模型

**打开工作区流程**：

```
系统目录选择器 → 首次打开信任确认("该目录内文件将被读取/修改")
 → 记入最近打开(agent_workspace) → git 检测(git2 探测 .git, 记录分支/脏文件数)
 → 读取根目录 AGENTS.md(若有) → session.start(携带 workspace)
```

**AGENTS.md 项目约定**（随项目走，团队可提交进仓库，格式对齐业界惯例）：

```
# AGENTS.md（工作区根目录，可选）
## 项目约定
- 后端 Rust(tokio)，前端 React18；模块边界见 docs/
## 常用命令
- 构建: cargo build --workspace
- 测试: cargo test --lib
## 禁忌
- 不要修改 migrations/ 下已发布的迁移文件
- 不要直接 push 到 main 分支
```

**git 集成与检查点 checkpoint**：

| 项 | 设计 |
|---|---|
| 检测 | 打开工作区时自动探测 git 仓库；非 git 目录提示"建议 git init 以启用检查点保护"，仍可工作但无检查点 |
| 时机 | 每个修改类工具（write_file/edit_file/run_command 修改型/git 提交类）**首次执行前**自动创建；同批连续修改共用一个检查点（间隔 > 5 min 或跨任务再建） |
| 实现 | stash 式快照：已跟踪文件的修改以 `git stash create` 等价物落到隐藏 ref `refs/bbw-agent/{session_id}/cp-{n}`；未跟踪新增文件记录清单（不搬移文件） |
| 内容 | checkpoint 记录：ref、未跟踪清单、改动文件列表、触发原因（pre-edit/pre-command/manual） |
| 恢复 | 工作台右栏检查点列表 → "恢复"= 逆向应用该检查点之后的工作区修改（不触碰用户更早的提交），恢复前二次确认并自动先做一次当前状态快照 |
| 上报 | `checkpoint.event` 经 stdio 上报，UI 时间线打检查点标记（§3.3） |

**工作区路径白名单**：会话绑定工作区根目录；一切路径类工具参数经 realpath 解析后必须位于根内（符号链接逃逸检查见 09 篇 §4.3）；用户可在"信任设置"追加例外目录（如 monorepos 的兄弟目录），例外同样受 09 篇沙箱约束。

### 4.5 子 Agent 机制（借鉴 Claude Code 主从架构）

主 Agent 持完整会话上下文负责规划、修改与汇总；子 Agent 是主 Agent 派生的**独立上下文窗口**的轻量执行体，只回传结构化摘要（≤ 2k tokens），不回传原文。

| 维度 | 可并行（探查类） | 不可并行（修改类） |
|---|---|---|
| 工具集 | read_file / list_dir / search_files / glob / kb_query / doc_read（只读子集） | write_file / edit_file / run_command / git 写 / app 写 / im_send |
| 并发 | 最多 3 个子 Agent 同时探查 | 一律主循环串行执行（避免工作区冲突与权限记忆混乱） |
| 上下文 | 独立窗口（不含主历史，仅任务指令） | 主窗口 |
| 寿命 | 单步数 ≤ 15，超限自杀并返回部分结果 | — |
| 失败 | 不阻塞：返回失败原因，主 Agent 汇总时标注并自行补查 | 按主循环失败规则处理 |

分解时机：快模型判定任务 complex（涉及多目录/多文件/多信息源）→ 生成探查子任务清单 → fan-out 并行 → join 汇总 → 主 Agent 基于摘要继续规划修改。子 Agent 事件以 `subagent.event` 上报 UI（中栏折叠显示）。

> 区分三种"派生执行体"：本节**子 Agent** 是 Runtime 进程内的轻量上下文（复用本篇工具集与 09 篇权限模型）；**专家 Agent**（[detail/D14](detail/D14-专家Agent与多智能体协作设计.md)）是带独立工具集/技能/MCP 绑定的受限子会话（公司库+个人库两级，可按协作图组队）；**委派外部编码后端**（17 篇）是独立子进程（zcode/Claude Code），有各自的工具体系，经 CodingBackend 适配器受控运行、事件归一化回流。三者可组合：探查子 Agent 收集上下文 → 专家团队（协作图）分析/评审 → 委派外部后端实现 → 主 Agent 审查 diff。

### 4.6 模型路由

| 档位 | 定位 | 典型用途 | 默认选择 |
|---|---|---|---|
| 快模型 | 低成本低延迟 | 简单问答、检索摘要、compaction、子 Agent 探查、危险命令分类（09 篇） | 日常默认 |
| 强模型 | 高推理能力 | 任务规划、多文件修改、复杂 debug、长上下文综合 | 用户 `/strong` 或自动升档 |

| 升档触发 | 降档/复用 |
|---|---|
| 首轮快模型判定 complex | compaction 摘要生成固定用快模型 |
| 连续 2 次工具执行失败 | 单纯事实查询/文件定位用快模型 |
| 压缩后仍需多步规划 | 子 Agent 探查固定用快模型 |
| 用户显式升档（输入框 ^ 按钮或 /strong） | 升档后连续 3 轮无工具调用且无规划 → 建议降档 |

失败重试与降级：SSE 断流 → 幂等重试（最多 2 次）；429/5xx → 指数退避 3 次 → 强模型降档快模型 → 仍失败则暂停会话并报 8011（含 trace_id，用户可一键重试）。切档经 `model.switched` 上报 UI。

### 4.7 会话生命周期状态机

> **状态枚举权威出处**：细化为 starting + 9 态（含 waiting_review / subagent_fanout / delegating / error，原 active/thinking/tool_running 收敛为 running），完整迁移表见 [detail/D11 §会话状态机](../detail/D11-AgentRuntime内部详细设计.md)。

```
                 ┌──────────── crash(09篇§4.6) ─────────────┐
                 v                                           │
new → starting → active ⇄ thinking ⇄ tool_running            │
                  │    ⇄ waiting_permission                  │
                  │    ⇄ paused(用户/网络/OBO) ──恢复──► active│
                  └────── revoke/logout/手动结束 ──► ended <──┘(restoring→active)
```

事件镜像：所有状态迁移与 stream/tool/permission 事件同步写本地 SQLite `agent_event`（§5.1），既是 UI 恢复源，也是崩溃重放源。

### 4.8 与 IM 联动

**Agent 分享卡片**：工作台/聊天面板"分享到会话"→ `im_send`（OBO，高危需确认）发送 `agent_card` 类型消息（消息类型由 04 篇登记）：

| payload 字段 | 说明 |
|---|---|
| session_ref | 本地会话 ID + 标题 |
| conclusion | 结论摘要（模型生成，≤ 500 字） |
| files[] | 涉及文件/产物引用（工作区相对路径或 file_id） |
| model / steps / duration | 元信息 |

接收方交互：点击卡片 → 打开只读会话快照（同租户且分享者开启共享时）；"以此为模板继续追问" → 在接收方自己的客户端新建会话，仅注入 conclusion + 文件引用摘要，**不继承原上下文与权限记忆**（权限记忆是用户私有且设备本地，09 篇 §4.2）。

**@Agent 进群（阶段四预留，本篇仅预留协议）**：conversation 成员类型预留 `type=agent`（值指向"每位成员各自的 Agent"，无群级 Agent 账号）；群内 @ 触发的是发起人自己的 OBO 会话，回复以 agent_card 落群；上下文按成员隔离。实现细节阶段四定。

## 5. 数据模型

### 5.1 本地（SQLite，客户端数据目录 agent/）

| 表 | 关键字段 | 说明 |
|---|---|---|
| agent_workspace | id, path, name, is_repo, trusted, extra_dirs, last_opened_at | 工作区与最近打开、信任与例外目录 |
| agent_session | id, workspace_id, title, form(embedded/workbench), mode, model_policy, status, created_at, updated_at, ended_at, summary | 会话元数据与状态 |
| agent_event | id, session_id, seq, type, payload(json), created_at | stdio 事件镜像（UI 恢复与崩溃重放源） |
| agent_checkpoint | id, session_id, git_ref, untracked(json), files_changed(json), reason, created_at | 检查点 |
| agent_context | session_id(PK), history(json), archive_summary(json), key_file_map(json), token_usage | 上下文持久化（压缩态存储，恢复会话不丢历史） |

> 权限记忆（grant）、审计日志的本地表在 09 篇 §5 定义；生态应用/技能安装状态本地缓存在 10 篇 §5。

### 5.2 服务端关联

| 关联 | 内容 | 开关 |
|---|---|---|
| 审计上报 | 工具调用审计批量上报 audit 域（字段与策略见 09 篇 §7；OBO 调用的服务端审计见 03 篇 §6.3） | 租户策略，默认仅元数据 |
| 会话云端备份 | 会话元数据 + 事件 JSONL（端侧加密后传 MinIO，服务端不可读明文；**不含工作区文件内容**） | 租户开关，**默认关**（02 篇 §5） |

云端备份表（备份开启时才有数据）：

| 表 | 关键字段 | 说明 |
|---|---|---|
| agent_session_backup | id, tenant_id, user_id, local_session_id, title, enc_alg, events_object_id, size, created_at | 备份索引；对象在 MinIO `t/{tenant}/agent-backup/{user}/` |

## 6. 接口设计

### 6.1 stdio JSONL 消息协议（宿主 ↔ Runtime，14 篇 §1 表列"08 篇附录"）

> **命名权威出处**：消息全表（37 条，含 runtime.ready / session.ready / checkpoint.create / subagent.spawn / delegate.brief 等）以 [detail/D11 §stdio 全消息表](../detail/D11-AgentRuntime内部详细设计.md) 为准；本节为概要示例，命名风格统一为 `域.动作`（如 tool.call → 以 D11 表为准）。

信封（对齐 14 篇风格，UTF-8 每行一条 JSON）：`{"v":1,"id":"h-123|r-456","reply_to":"...?","type":"...","ts":...,"payload":{...}}`；`id` 前缀 h-（宿主）/ r-（Runtime），请求-响应用 `reply_to` 配对。宿主每 20 s 发 `ping`，5 s 未回 `pong` 判定不健康 → 重启 Runtime（09 篇 §4.6）。

| 方向 | type | payload 摘要 | 说明 |
|---|---|---|---|
| 宿主→RT | initialize | protocolVersion, capabilities, 数据目录, 代理配置 | 进程拉起后首次握手 |
| RT→宿主 | initialize.result | runtimeVersion, 支持的工具/能力 | 版本不匹配则宿主换兼容包 |
| 宿主→RT | session.start | sessionId, workspace, mode, modelPolicy, skills[], historyRef | 新建或恢复会话（恢复时带本地上下文指针） |
| RT→宿主 | session.started | sessionId, restored(bool) | |
| 宿主→RT | user.message | text, attachments[] | 用户输入（含 /strong 等斜杠指令） |
| RT→宿主 | stream.delta | sessionId, delta, seq | 模型流式输出增量 |
| RT→宿主 | stream.done | finishReason, usage | 一轮生成结束 |
| RT→宿主 | tool.call | callId, tool, args, risk, parallel(bool) | 工具调用展示（中栏卡片） |
| RT→宿主 | tool.result | callId, ok, summary, truncated(bool) | 结果摘要（全文在 Runtime 内部，按需展开拉取） |
| RT→宿主 | permission.request | requestId, tool, args, reason, preview(diff/command) | 权限确认（卡片区右栏），字段细节 09 篇 §6.1 |
| 宿主→RT | permission.response | requestId, decision(allow/deny), scope(once/session/permanent), editedArgs? | 支持"改命令再执行"回传 |
| RT→宿主 | compaction.event | phase(start/done), freedTokens, keptRounds | 上下文压缩通知 |
| RT→宿主 | checkpoint.event | checkpointId, filesChanged[], reason | 检查点创建 |
| 宿主→RT | checkpoint.restore | checkpointId | 用户点击恢复 |
| RT→宿主 | subagent.event | subId, phase(spawn/delta/done/fail), summary | 子 Agent 生命周期 |
| RT→宿主 | model.switched | from, to, reason | 档位切换 |
| RT→宿主 | session.state | state(见 §4.7) | 状态迁移 |
| 宿主→RT | obo.token | token, exp, scopes | OBO 发放/续签（token 仅此通道，不过 WebView） |
| RT→宿主 | obo.renew | scopes, reason | 主动请求续签 |
| 宿主→RT | session.pause / session.resume | sessionId | 暂停/恢复 |
| 宿主→RT | session.end | sessionId, reason | 结束（正常/登出/revoked） |
| RT→宿主 | session.ended | summary | 结束回执 |
| 宿主→RT | tools.reload | reason(app/skill 更新) | 10 篇热加载触发 |
| 双向 | ping / pong | — | 健康 |
| RT→宿主 | error | code(8xxx), message, fatal(bool) | 协议级错误 |

### 6.2 ai-gateway 调用约定（复用既有接口，非新增）

- `POST /v1/chat/completions`（OpenAI 兼容，SSE），`Authorization: Bearer <OBO token>`；请求头带 `X-BBW-Agent-Session` 供网关按会话计量（01 篇 §5.5、12 篇用量）。
- 工具定义以 OpenAI tools 格式下发，schema 由 10 篇工具注册表生成（对齐 MCP tool jsonschema）。

### 6.3 REST（云端备份，可选开启）

| API | 说明 |
|---|---|
| POST /api/v1/agent/sessions/backups | 创建备份：元数据 + 事件对象预签名上传凭证（Idempotency-Key） |
| GET /api/v1/agent/sessions/backups?cursor= | 我的备份列表 |
| GET /api/v1/agent/sessions/backups/{id}/restore-ticket | 恢复下载凭证（端侧解密） |
| DELETE /api/v1/agent/sessions/backups/{id} | 删除备份 |

### 6.4 Agent 分享卡片（经 04 篇 msg.send 通道）

消息类型 `agent_card`（04 篇 §消息类型登记），payload 见 §4.8 字段表；发送走 `im_send` 工具（OBO `im:message:send`，09 篇高危确认）。

## 7. 边界 / 异常 / 安全

| 场景 | 处理 |
|---|---|
| 超大仓库 / 巨量命中 | search_files 上限 200 条 + 提示收窄；仓库索引懒构建（首用后台建，限速） |
| compaction 后仍超限 | 报 8010，建议精简任务/新建会话/升档更大窗口模型 |
| ai-gateway 故障 | 会话暂停并明确报错；IM 等基础功能不受影响（02 篇 §7，Runtime 独立进程） |
| OBO 续签失败（权限被收回/登出） | 会话 paused；续签即重算 scope（03 篇 §6.4），收敛后继续或提示 |
| 工作区目录被删/移动/网盘路径 | 工具调用失败并提示重新选择；网盘/MDM 排除路径打开时显著告警（性能与安全） |
| 多会话并发 | 活跃 ≤ 3，超出提示关闭旧会话；同工作区并发会话提示冲突风险 |
| 笔记本休眠/进程被挂起 | 恢复后 SSE 已断 → 按断流重试语义续跑；超 10 min 未恢复转 paused |
| 隐私 | 会话内容默认不出本机（除模型调用经 ai-gateway，租户可开脱敏）；云备份端侧加密；不用于训练（租户策略） |
| 安全细则 | 工具门控/沙箱/注入防御/审计统一见 09 篇；生态工具签名与分发见 10 篇 |

## 8. 与其它模块依赖

| 模块 | 依赖内容 |
|---|---|
| 01 技术选型 | Runtime=Rust sidecar、stdio JSONL、自研循环（§4） |
| 02 架构 | 进程模型、OBO 令牌代理位于 Rust 核心、失败域隔离 |
| 03 认证 | OBO 签发/续签/撤销（§6）、权限点 `agent:*`、服务端双写审计 |
| 09 工具与安全 | 工具目录、权限模式与门控、沙箱、审计细节（本篇只定义调用时机与上报通道） |
| 10 生态与技能 | 工具注册表合并、app.* 注入、tools.reload、技能加载 |
| 14 协议 | 错误码 8xxx（本篇使用 8010-8011）、Agent 流量不走 WSS（§3.3） |
| 17 编码智能体协作 | CodingBackend 抽象、coding.* 委派工具、权限模式→子智能体参数映射、delegate.* 审计回流（本篇 Runtime 即编排层） |
| 04 IM | agent_card 消息类型、@Agent 进群预留 |
| 12 管理后台 | 模式准入/云备份/上报策略配置项 |
| 16 部署运维 | Runtime 独立升级通道、内存预算 |

## 9. 开放问题

1. 内嵌聊天形态是否放开 run_command（当前：不允许，仅只读工具 + 单文件编辑确认）。
2. 云备份加密密钥方案：设备密钥派生 vs 用户口令派生（跨设备恢复体验差异大）。
3. 子 Agent 并发数与 token 成本的最优默认值需在阶段三联调实测。
4. AGENTS.md 与技能指令冲突时的优先级（当前实现：项目 AGENTS.md 靠后注入、优先生效；需在文档间统一说明）。
5. CLI 形态（开发者终端直用 Runtime）的鉴权途径：复用客户端钥匙串 or 设备码流程，阶段四定。
