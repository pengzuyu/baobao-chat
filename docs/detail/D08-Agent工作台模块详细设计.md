# D08 - Agent 工作台模块详细设计（UI 层）

> **D19 落地注记（2026-11-10）**：§B 工作区组已随 D19 实施——workspace 登记/列表走协议 workspace.register/list/forget（agent_workspace 表接线，realpath upsert）；「打开目录」=系统选择器（plugin-dialog）即显式信任（§4.4 精细确认登记阶段二）；会话列表持久恢复=session.list REQ；新会话默认=日常对话（无工作目录），项目会话绑定目录且沙箱根=该目录。过程显示（§3.3 思考/工具卡）已对齐 change-my-life 效果（流式展开/自动折叠/工具组汇总条）。详见 D19。


> **⚠ 2026-11-10 口径修订**：§3.2 PAG-02 聊天内嵌 Agent 轻量卡的「仅结论 ≤500 字/20 轮上限/固定只读白名单/审批超时自动拒」口径已按用户裁决**作废**——内嵌形态升级为「聊天壳里的完整 Agent 体验」（完整过程透明卡+聊天页审批弹框）。**最终口径以 [D18-IM 内嵌 Agent 卡详细设计](D18-IM内嵌Agent卡详细设计.md) 为准**；本篇 PAG-02 段留作历史。

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（详细设计阶段） |
| 上游 | [D01-客户端总体](D01-客户端总体详细设计.md) · [08-Agent总体](../08-AI-Agent总体设计.md) · [09-工具与安全](../09-AI-Agent工具与安全设计.md) · [17-编码智能体协作](../17-本地编码智能体协作设计.md) · [14-协议](../14-通信协议设计.md) |
| 下游 | [D11-AgentRuntime内部](D11-AgentRuntime内部详细设计.md)（本文 UI 命令/事件与其内部协议一一对应） |
| 模板说明 | 按 D01 §13 篇章模板；"模型"章只含客户端本地表，Runtime 侧全量 DDL 见 D11 §11 |

---

## 1. 概述与范围

### 1.1 定位

Agent 工作台是 Agent 能力的唯一 UI 载体，覆盖两种会话形态（08 篇 §3.2）：

| 形态 | 载体 | 本篇覆盖 |
|---|---|---|
| ① 聊天内嵌 | IM 消息流中的轻量卡（PAG-02，@Agent 触发） | 卡片渲染 + 追问入口 + 升级路径 |
| ② 独立工作台 | 主导航"Agent"页（PAG-01/03 为核心） | 全部 12 个页面/卡片族 |

### 1.2 范围边界

| 做 | 不做 |
|---|---|
| 会话/审批/委派/检查点/记忆/后端管理的全部页面与交互 | Runtime 内部实现（状态机细节、上下文引擎、沙箱管线 → D11） |
| 本地 Tauri 命令与 IPC 事件的 UI 侧契约 | stdio JSONL 协议内部语义（→ D11 §4，本文只消费其镜像事件） |
| 审批卡/委派卡等组件族的状态机（UI 级） | 权限门控判定顺序、危险命令规则库（09 篇 §4，UI 只呈现判定结果） |
| 会话分享卡片（agent_card）的发送侧与接收侧渲染 | agent_card 消息类型的 msg.send 通道细节（04 篇） |

### 1.3 关键约束（继承）

- 权限模式三档 `ask / auto-edit / full-auto`（09 篇 §3.3）；内嵌形态固定 `ask`。
- 权限点：`agent:session:use`（页面准入）、`agent:tool:run_command`（终端流能力显隐）、`agent:mode:full_auto`、`agent:delegate:use`。
- Agent 流量不走 WSS（14 篇 §3.3）：UI 一切会话内状态经本地 Tauri 事件；服务端仅推 `agent.revoked` / `agent.policy.updated` / `ai.quota.warning`。
- 错误码 8xxx（14 篇 §7）；UI 按 code 映射文案，`8010-8012/8020-8035` 全部登记映射。

## 2. 页面与路由

| 页面 ID | 名称 | 路由 / 挂载点 | 权限点 | 概要来源 |
|---|---|---|---|---|
| PAG-01 | 工作台主页（三栏） | `/agent` | agent:session:use | 08 §3.3 |
| PAG-02 | 聊天内嵌 Agent 轻量卡 | `/im/c/:convId` 消息流内 | agent:session:use | 08 §3.2 |
| PAG-03 | 会话视图细节（中栏渲染规范） | `/agent/s/:sessionId` | 同上 | 08 §3.3 |
| PAG-04 | 审批卡片族（命令/编辑/批量/OBO/简报） | PAG-01/03 右栏 + 中栏内联 | 同上 | 09 §3.4、17 §4 |
| PAG-05 | 委派任务卡 | PAG-03 中栏内联 | agent:delegate:use | 17 §6.1 |
| PAG-06 | 检查点与恢复 | PAG-01 右栏 / 弹层 | 同上 | 08 §4.4 |
| PAG-07 | 权限模式切换器 | PAG-03 会话头部 | full-auto 需 agent:mode:full_auto | 09 §3.3 |
| PAG-08 | 紧急停止与崩溃恢复 | 全局浮层 / PAG-03 顶横幅 | — | 09 §4.6 |
| PAG-09 | 后端管理设置 | `/agent/settings/backends` | agent:delegate:use | 17 §6.3 |
| PAG-10 | 会话分享到 IM 卡片 | PAG-03 分享弹窗 | — | 08 §4.8 |
| PAG-11 | 三级记忆管理页 | `/agent/memory` | 同上 | 09 §4.2 |
| PAG-12 | 被阻止操作查看 | `/agent/blocked` | 同上 | 09 §5.1 |

## 3. 页面详细设计

### 3.1 PAG-01 工作台主页

```
┌─ Agent ────────────────────────────────────────────────────────────────────┐
│ [🆕 新会话] [🔍 搜索会话]                                   Runtime: ●健康   │
├──────────┬──────────────────────────────────────────────┬─────────────────┤
│ 会话列表  │  PAG-03 会话视图（无选中=空态引导）             │ 待审批队列 (2)   │
│ ●修复登录 │  ┌──────────────────────────────────────────┐ │ ┌命令卡 cargo..┐ │
│  [内置]   │  │ 会话头部: 模式[PAG-07] 模型 工作区 ■⏸     │ │ │ y / n / a    │ │
│ ◐退款接口 │  ├──────────────────────────────────────────┤ │ └──────────────┘ │
│  [zcode]  │  │  流式对话区（markdown 增量）               │ │ ┌编辑卡 ±12───┐ │
│ ○周报     │  │  工具事件流（折叠卡）                       │ │ └──────────────┘ │
│ ○暂停中   │  │  终端输出区（流式）                         │ ├─ 检查点栈 ──────┤│
│──────────│  │  文件改动时间线（底部）                      │ │ cp3 14:02 [恢复]│
│ 📁 工作区  │  ├──────────────────────────────────────────┤ │ cp2 13:58 [恢复]│
│ ~/code/   │  │ [输入框  /指令  ^升档  📎附件     发送]     │ │ (拖拽调整顺序)   │
│ 最近: …   │  └──────────────────────────────────────────┘ │                  │
└──────────┴──────────────────────────────────────────────┴─────────────────┘
```

| 区块 | 内容与规则 |
|---|---|
| A 会话列表 | 每项：状态点 + 标题 + **backend 徽标**（会话发生过委派时显示 `[zcode]`/`[claude]`/`[内置]`，取 agent_session.backend）+ 相对时间；排序按 updated_at 倒序；状态点色：●运行绿 / ◐等待审批橙 / ○暂停灰 / ✕错误红 / ▪已结束灰 |
| B 工作区组 | 最近打开（agent_workspace，≤5 条）+ "打开目录"（系统选择器 → 信任确认，08 §4.4） |
| C 会话头部 | 模式指示器（PAG-07）、模型档位 `[快 v]`、工作区路径（悬停显全路径）、运行状态、暂停 ⏸ / 停止 ■（■=紧急停止语义，走 INT-AG-12） |
| D 中栏 | PAG-03 细化；右侧由工具事件/审批卡实时流入 |
| E 右栏（**L 档起**） | 待审批队列 + 检查点栈；M/S 档降级为浮层（§7） |
| F Runtime 状态条 | 宿主心跳结果（08 §6.1：20s ping/5s pong）：●健康 / ◐重启中(n/3) / ✕不可用（点击展开 PAG-08 恢复界面） |

数据绑定：会话列表 = TanStack Query `['agent','sessions']`（本地库经 Tauri 命令 session_list）；实时状态由 IPC 事件 `session.state` 精准失效。

六态表（会话列表）：

| 态 | 触发 | 呈现 |
|---|---|---|
| loading | 首次进入 | 条形骨架 ×8（>300ms 才显示） |
| empty | 无任何会话 | 插画 + "从一个任务开始，或打开一个项目工作区" + [新建会话][打开工作区] |
| error | 本地库/命令失败 | 错误码文案（8xxx）+ 重试 + trace_id 折叠 |
| offline | WSS 断开 | **顶部横幅**；工作台本地功能不受影响（Agent 不依赖 WSS），仅分享/IM 联动按钮置灰 |
| forbidden | 无 agent:session:use | 锁图标 + "未开通 Agent，请联系管理员" |
| degraded | Runtime 崩溃重启中 | 黄条 "Agent 引擎重启中…第 n 次"，会话置灰暂停 |

### 3.2 PAG-02 聊天内嵌 Agent 轻量卡

```
┌ 用户: @Agent 公司差旅报销的流程是什么？                        14:02 ┐
┌ 🤖 Agent ──────────────────────────── 轻量会话 #a-77 ────────┐
│ 结论（markdown，≤500 字，无工具原文）：                        │
│ 1. 提交入口：OA-报销中心…                                     │
│ 2. 审批链：直属上级 → 财务…（依据《差旅制度v4》§3）             │
│ 来源: [kb:行政空间/差旅制度v4] [doc:报销操作指南#12]           │
├──────────────────────────────────────────────────────────────┤
│ [💬 追问…] [🖨 转到工作台继续] [⤴ 引用回复]                    │
└──────────────────────────────────────────────────────────────┘
```

| 区块 | 规则 |
|---|---|
| 触发 | 输入框 Agent 按钮或消息内 @Agent；以内嵌会话（form=embedded，固定 ask 模式，不绑工作区）聚合为一个卡片（同 conv 内追问追加到同一卡） |
| 结论区 | 仅最终结论 + 来源引用（untrusted 内容按 09 §7.3 带来源边框渲染）；不显示工具事件流与原始 stdout（08 §3.2） |
| 追问 | 展开内联输入框（单行），回复追加进卡片尾部；工具运行时显示 shimmer 行 |
| 转到工作台 | 携带结论与来源摘要新建 workbench 会话（不继承上下文与权限记忆，与 08 §4.8 接收方语义一致） |
| 失败 | 卡内红字错误（8xxx）+ 重试；超时 120s 的审批在内嵌形态直接拒绝（只读工具居多，罕见） |

### 3.3 PAG-03 会话视图细节（中栏渲染规范）

```
┌─ 消息流（虚拟滚动，key=eventId）──────────────────────────────┐
│ 👤 user        帮我修复登录超时 bug（📎 logs.zip）              │
│ 🤖 agent       ▸ 思考摘要（折叠，默认收起，点击展开）…          │
│   我先定位相关代码…                                            │
│ ┌─ ▸ tool.search_files ── ok ── 0.4s ─────────────────────┐   │
│ │   输入: {query:"session timeout"}  结果: 12 处命中(摘要)   │   │
│ └─────────────────────────────────────────────────────────┘   │
│ ┌─ ▾ tool.edit_file auth.rs (+8/-4) ── 已批准 ── 1.2s ────┐   │
│ │   输入(可展开) | diff 预览(±行高亮) | 结果摘要             │   │
│ └─────────────────────────────────────────────────────────┘   │
│ ┌─ 终端: cargo test --lib ── exit 0 ──────────────────────┐   │
│ │ running 12 tests … 12 passed        [复制][停止]          │   │
│ └─────────────────────────────────────────────────────────┘   │
│ ▸ 子任务: 3 个并行探查（subagent 折叠行）                       │
├─ 文件改动时间线 ──────────────────────────────────────────────┤
│ 14:02 auth.rs +8/-4 ⛁cp3   14:05 session.rs +2/-2             │
├─ [输入: 继续…  /斜杠指令  ^升档  📎  📤分享(PAG-10)]  [发送] ──┤
│  (吸底时)                     [↓ 回到底部 (12)]                │
└──────────────────────────────────────────────────────────────┘
```

| 渲染对象 | 规范 |
|---|---|
| 流式 markdown | `stream.delta` 增量拼接；**50ms 批量 flush**；代码块增量高亮（逐 token 着色，避免整块重渲）；`channel=reasoning` 的 delta 进入"思考摘要"折叠区不进入正文 |
| 工具调用折叠卡 | 头部：图标+工具名+状态(运行中 spinner/ok/失败/被阻止)+耗时；展开体：输入参数（JSON 树，敏感值已脱敏）、结果摘要（默认 ≤10 行）、[查看全文]（agent_tool_detail 命令按需拉取）；`source=backend` 的卡加后端徽标（17 §3.3） |
| 终端输出区 | run_command 专属：等宽字体、stdout/stderr 双色、滚动视窗固定 ≤500 行（更早收进 [加载更早]）、截断横幅 "[已截断，头尾各 50%]" |
| 思考摘要折叠 | 默认收起一行 "思考中… / 已推理 1.2k tokens"；展开仅显示 reasoning 摘要，不显示未脱敏原始内容 |
| 子 Agent 行 | `subagent.event` 聚合为一条折叠行 "3 个并行探查"，展开见各子任务 delta/结论摘要 |
| 文件改动时间线 | 底部固定高度条带；每项=时间+文件+±行数+检查点标记 ⛁cpN（点击→PAG-06 定位） |
| 输入框 | Enter 发送 / Shift+Enter 换行；`/`唤出斜杠指令菜单（/strong /compact /brief…）；`^`升档按钮（模型档位）；📎 附件（本地文件路径或拖入，D01 §10） |

六态：loading=打开会话时从 agent_event 镜像回放骨架；error=8012 时整个流置灰 + "只读快照"横幅；其余态随 PAG-01。

### 3.4 PAG-04 审批卡片族

**3.4.1 命令确认卡**（permission.request，preview.kind=command）

```
┌─ ⚠ 命令执行请求 ── risk:高 ────────────── 剩余 118s ──────┐
│ 工作目录: ~/code/bbw-server（白名单内 ✓）                  │
│ 命令(可编辑): [ cargo test --lib                 ] ✎改后执行│
│ 危险标识: 🚫 sudo 提权 → 已按规则拒绝（8021）   ← 命中拒绝类 │
│          ⚠ 规则未命中 · 快模型分类: 中危(构建类) ← 需确认    │
│ 记忆: [●本次] [○本会话(前缀 cargo test)] [○永久(需开启)]    │
│ [y] 允许   [n] 拒绝   [a] 本会话允许同类                    │
└────────────────────────────────────────────────────────────┘
```

规则：命令文本框可编辑（回传 editedArgs，09 §6.1）；命中"直接拒绝类"规则时按钮只有 [知道了]，卡变红（8021/8020）；倒计时 120s 到期自动置灰→timeout 态（=拒绝）；`a` 的记忆粒度=命令前缀（09 §4.2）。高危工具无 [永久]（除非设置开启且租户允许）。

**3.4.2 编辑 diff 卡**（preview.kind=diff；write_file/edit_file/git_commit）

```
┌─ 编辑请求: auth.rs (+8/-4) ─────────── [跳转文件] [全部接受] [拒绝] ┐
│ @@ -120,7 +120,9 @@ fn verify(token) {                            │
│  120  let claims = decode(token)?;                          普通    │
│ -121  if claims.exp < now() { return Err(Timeout); }        − 红   │
│ +121  let drift = now() - claims.exp;                       + 绿   │
│ +122  if drift > CLOCK_SKEW { return Err(Timeout); }               │
│ [x] hunk1 ✓  [x] hunk2 ✓  [ ] hunk3 ✗(逐hunk拒绝)                  │
│ [y]允许 [n]拒绝 [a]本会话允许(路径 *.rs)                    ────────┘
└────────────────────────────────────────────────────────────────────┘
```

规则：复用 `shared/ui/DiffView`；行内 +/- 高亮（加绿底红底）；hunk 复选框取消=该 hunk 拒绝（回传 accepted_hunks）；[跳转文件]=在系统编辑器/内置查看器打开当前文件；auto-edit+ 模式下该卡默认不出现（矩阵 A），仅注入时间线摘要行。

**3.4.3 批量审批条**（右栏顶部，队列 ≥2 时出现）

```
┌ 已选 2/3 项（仅同类低/中危）  [全部允许] [全部拒绝] [逐条审批] ┐
```
规则：多选仅允许同类且风险 ≤中（09 §3.4.3）；高危卡永不入批量；一次确认覆盖多个 hunk/多个只读命令。

**3.4.4 OBO 授权提示卡**（preview.kind=obo，D08 扩展枚举）

```
┌─ 🔑 Agent 请求以你的身份访问公司资源（首次）─────────────────┐
│ 目标: 知识库检索（kb_query）                                 │
│ 申请 scope: ☑ kb:query:use  ☐ doc:file:view（同批未勾选）    │
│ 说明: 使用你的 OBO 令牌（≤15min 有效），操作以你的名义审计     │
│ [仅本次允许] [本会话允许] [拒绝]                              │
└──────────────────────────────────────────────────────────────┘
```
规则：每 scope 独立勾选；同意=permission.response(allow, scope)；scope 清单来自 09 §3.1 工具目录；OBO 令牌本体永不过 WebView（08 §3.1），卡内不显示令牌值。

**3.4.5 任务简报卡**（Task Brief，delegate.brief 事件驱动）

```
┌─ 📋 任务简报（可编辑）→ 委派给 [zcode ▾健康✓] ──────────────┐
│ 目标(task): 在 order-svc 增加 POST /refunds 退款接口   [✎]   │
│ 工作区: /Users/dev/repos/order-svc                          │
│ 约束(constraints): 遵循现有分层 / Go 1.22 / 禁新框架  [✎±]   │
│ 上下文摘录(context):                                        │
│  ├ kb:《订单域接口规范v3》→ 错误码/鉴权要求      [来源↗]      │
│  ├ doc:接口约定#42 → 请求响应结构                [来源↗]      │
│  └ im:与PM确认结论 → 仅支持整单退款               [来源↗]      │
│ 验收(acceptance): make build 通过 / 单测覆盖退款分支  [✎±]   │
│ 禁忌(forbidden): 修改 db/migration、触碰部署脚本      [✎±]   │
│ 将获得能力: 文件编辑（auto-edit 档）· 命令:白名单内           │
│ [确认委派] [编辑后委派] [取消]                               │
└──────────────────────────────────────────────────────────────┘
```
规则：来源可溯=每个摘录可点开来源（kb/doc/im 跳转对应模块只读视图）；首次委派必经此卡（17 §6.2 步骤 2）；[确认委派] 触发 delegate_launch 回传编辑后的 brief。

### 3.5 PAG-05 委派任务卡

```
┌─ 委派任务 #dt-101 ── [zcode ✓v2.3] ── 状态: 运行中 04:32 ──┐
│ 后端选择器: (●)zcode✓ (○)Claude Code✓ (○)内置 (○)自动       │
│ ▸ 实时输出（折叠流，默认摘要行）: 解析简报 → Read×12 …       │
│ ▸ 子会话事件明细: Read api.go ✓ / Edit refund.go ✓ / …      │
│ 工具统计: Read×12 Edit×3 Grep×7   资源: CPU 12% MEM 210MB   │
│ [⏹ 取消(SIGINT 优雅)] [➕ 追加指令…]                         │
│ ── 完成后 → 自动进入审查 ────────────────────────────────────│
│ ┌ 审查: 3 个文件改动 (checkpoint #cp5) ────────────────────┐ │
│ │ api_refund.go +86/-4 [逐hunk diff][拒绝hunk]             │ │
│ │ [全部接受] [全部拒绝→恢复到 cp5]                          │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

| 区块 | 规则 |
|---|---|
| 后端选择器 | 优先级展示：用户指定 > 项目配置(AGENTS.md preferred_backend，标 `项目` 徽标) > 用户默认设置 > 自动（17 §4）；徽标=健康状态（探测 ✓/✗/版本不符 8031/策略禁用 8032 置灰） |
| 实时输出折叠流 | delegate.event 归一化事件流；默认收起为一行摘要（阶段+工具计数），展开=虚拟滚动明细 |
| 子会话事件明细 | 后端 tool_use 事件（source=backend 的 tool.call/result）列表，点击复用 PAG-03 工具折叠卡展开 |
| 取消/追加 | 取消走 delegate_cancel(graceful)：先 SIGINT，UI 提示 "已发送中断，3s 后强杀"；追加指令=内联输入框 → delegate_input |
| 审查区 | delegate.end 后内联展开：逐文件 diff（复用 3.4.2）+ checkpoint 引用；接受=落盘归档，拒绝=一键恢复 cp（PAG-06 危险确认） |

### 3.6 PAG-06 检查点与恢复

```
┌─ 检查点栈（右栏）────────────────────────────┐
│ cp5 14:32 委派#dt-101 前   3 文件  [对比][恢复]│
│ cp4 14:02 修改 auth.rs 前   1 文件  [对比][恢复]│
│ cp3 13:58 pre-command      2 文件  [对比][恢复]│
│ [+ 手动创建]                  (可拖拽排序展示) │
└───────────────────────────────────────────────┘
┌─ 恢复确认（危险弹窗）─────────────────────────┐
│ 将逆向应用 cp4 之后的全部工作区改动（2 个文件）  │
│ 恢复前会自动创建当前状态快照 cp6                │
│ 输入 "恢复" 以确认          [取消][红色:恢复]   │
└───────────────────────────────────────────────┘
```
规则：[对比]=该检查点与当前工作区的 diff（DiffView 弹层）；恢复前自动快照（08 §4.4）；非 git 工作区此栏显示 "建议 git init" 提示条。创建时机提示：自动检查点在时间线打 ⛁ 标记并在 toast 提示 "已创建检查点 cp4"。

### 3.7 PAG-07 权限模式切换器

```
会话头部: 权限模式 [auto-edit ▾] ──┬─ (●) ask       每次写文件/命令都询问        ─┐
                                   │  (●) auto-edit 自动改文件；命令与外发仍询问 ←当前│
                                   │  (○) full-auto 除"永不全自动"外自动 [需权限点]  │
                                   └─ tooltip: 各档能力矩阵摘要（09 §4.1.1 缩略）  ─┘
```
规则：点击指示器弹三选；`Cmd/Ctrl+Shift+M` 循环切换；升档 →full-auto 二次确认（确认弹窗含能力说明），无 agent:mode:full_auto 则置灰 + "找管理员开通"；降档即时生效；切换动画=指示器胶囊滑动 200ms + 全局 toast "本会话已切换为 auto-edit（即时生效，不影响其它会话）"；内嵌形态此控件只读显示 "ask（内嵌固定）"。

### 3.8 PAG-08 紧急停止与崩溃恢复

```
┌─ ⏹ 紧急停止（触发后全屏遮罩 600ms）────────────────────────┐
│   停止中…（旋转图标）→ 已停止                               │
│   结果: 当前命令进程组已杀 · 循环已暂停 · 3 个未决审批已作废   │
│   审计已记录 emergency_stop        [查看会话][关闭]          │
└─────────────────────────────────────────────────────────────┘
┌─ ⚠ Agent 引擎崩溃恢复横幅（PAG-03 顶部，degraded 态）──────┐
│ Runtime 已重启 (2/3)。正在恢复会话 "修复登录超时"…            │
│ 事件重放进度 ▓▓▓▓▓▓▓░░░ 72%（1,436/1,994 条）               │
│ [从最后检查点恢复会话] [仅查看只读快照]                       │
└─────────────────────────────────────────────────────────────┘
```
规则：紧急停止三入口（全局快捷键 Cmd/Ctrl+Shift+. / 托盘 / 工作台 ■）一致语义（09 §4.6），UI 均走 agent_emergency_stop 命令；崩溃横幅由宿主 runtime.state 事件驱动；重放失败（8012）→ 横幅变红 "恢复失败，已降级只读快照" + [新建会话续接]。

### 3.9 PAG-09 后端管理设置（`/agent/settings/backends`）

```
┌─ 设置 → Agent → 编码后端 ─────────────────────────────────┐
│ ⚠ 租户策略: 允许 zcode / Claude Code / 内置（管理员配置）    │
│ ┌ zcode        ✓已检测  /usr/local/bin/zcode  v2.3  [默认▾]┐│
│ │  能力: 编辑✓ 命令✓ 续接✓   冒烟: ✓ 320ms  [重新探测]      ││
│ ├ Claude Code  ✓已检测  ~/.claude/claude       v1.6  [设默认]┤│
│ ├ Codex        ✗未安装  [查看安装引导↗]（不代装，17 §9）     ││
│ └ 内置引擎     ✓始终可用（兜底）                     [设默认]┘│
│ 默认后端优先级: 用户默认 > 项目配置 > 自动(健康+复杂度)       │
└─────────────────────────────────────────────────────────────┘
```
六态：loading=探测中（每行 spinner）；degraded=租户策略禁用某后端（置灰+锁+8032）；其余同通用。

### 3.10 PAG-10 会话分享到 IM 卡片

```
┌─ 分享会话结论到会话 ────────────────────────────┐
│ 结论(可编辑, ≤500字): [模型生成结论…]            │
│ 附件: ☑ auth.rs(+8/-4) ☑ conclusion.md ☐ logs.zip│
│ 元信息: 模型 fast · 34 步 · 12 分钟              │
│ 发送到: [选择会话/群 (搜索)]   [取消] [发送]      │
└──────────────────────────────────────────────────┘
```
规则：conclusion 由 session_share_prepare 取模型缓存结论（用户可编辑）；附件仅会话产物（工作区相对路径→自动 file_upload 上传后引用，敏感命中先打码 09 §7.2）；发送=宿主直发 msg.send(type=agent_card)（用户点击即确认，不经 Runtime 工具链）；接收方渲染=只读快照卡 + "以此为模板继续追问"（08 §4.8）。

### 3.11 PAG-11 三级记忆管理页（`/agent/memory`）

```
┌─ 设置 → Agent → 记忆授权 ──────────────────────────────────┐
│ 会话内记忆(3): 本次会话结束后自动失效                         │
│  · run_command 前缀 "cargo test"     会话 #s-9   [撤销]      │
│ 永久允许(2):                          [撤销永久授权]          │
│  · edit_file 路径 *.rs      2025-11-02 授权  [撤销][详情]     │
│  · http_fetch 域名 intranet.corp …          [撤销]           │
│ ☐ 允许高危工具永久记忆（需租户策略允许）                      │
└─────────────────────────────────────────────────────────────┘
```
规则：数据=agent_tool_grant + allow.json；撤销永久=删除规则并即时生效（下发 tools.reload 语义）；来源卡（source_card）悬停显示当时审批卡摘要。

### 3.12 PAG-12 被阻止操作查看（`/agent/blocked`）

```
┌─ 被阻止的操作（agent_sandbox_violation）────────────────────┐
│ 筛选: [全部▾] [会话▾] [类型: 路径/网络/资源/规则/危险命令▾]    │
│ 14:05 #s-9 危险命令  sudo rm -rf /  → 拒绝(规则 R-07)  [上下文]│
│ 14:03 #s-9 路径逃逸  ../secrets/id_rsa → 8024 拦截     [上下文]│
│ 13:58 #s-9 网络出站  evil.com:443 → 8025 拦截+杀进程   [上下文]│
└─────────────────────────────────────────────────────────────┘
```
规则：列表分页（cursor）；[上下文]=跳转 PAG-03 定位对应事件 seq；此页只读，用于透明化"Agent 尝试过但被拦下的操作"。

## 4. 交互详细设计

### 4.1 交互事件表（INT-AG）

| ID | 交互 | 触发 | 行为 | 反馈/边界 |
|---|---|---|---|---|
| INT-AG-01 | 流式渲染 | stream.delta 到达 | 缓冲区 50ms 批量 flush；虚拟滚动追加 | 距底 <40px 自动吸底；用户上滚即停随并显示 [↓回到底部(新n)] 浮标；点击/回到底部恢复吸随 |
| INT-AG-02 | 工具卡折叠展开 | 点击卡头 | 展开=输入参数 JSON 树+结果摘要+耗时；收起一行 | 全文按需 agent_tool_detail；展开态记入会话 UI 偏好 |
| INT-AG-03 | 审批快捷键 | 会话聚焦时 y/n/a | y=允许(once)、n=拒绝、a=会话内允许 | 作用于右栏**当前选中**审批卡（Tab/方向键切换选中）；命令卡聚焦时输入框优先，快捷键需先点选卡 |
| INT-AG-04 | diff 逐 hunk 操作 | hunk 复选框/按钮 | 取消勾选=拒绝该 hunk；提交时回传 accepted_hunks | 全部 hunk 被拒=整卡拒绝；拒绝 hunk 理由回填给模型 |
| INT-AG-05 | 委派后端选择 | 简报卡/委派卡选择器 | 顺序：用户指定>项目配置>默认>自动 | 置灰项 tooltip 显示原因（8030/8031/8032）；选"自动"显示将选结果 |
| INT-AG-06 | 委派输出实时滚动 | delegate.event | 折叠流追加+摘要行计数刷新；展开时虚拟滚动 | 同 INT-AG-01 吸底规则；输出上限 1MB 截断提示 |
| INT-AG-07 | 追加指令 | 委派卡 ➕ | 内联输入框 → delegate_input(text) | 运行中才可用；完成后变为 [新任务续接]（resume 语义） |
| INT-AG-08 | 委派取消 | 委派卡 ⏹ | delegate_cancel(graceful=true) | 提示 "SIGINT 已发送，3s 未退出将强杀进程树"；取消后卡进入 cancelled 态 |
| INT-AG-09 | 检查点恢复确认 | PAG-06 [恢复] | 危险弹窗（输入"恢复"确认）→ checkpoint_restore | 恢复前自动建当前快照；恢复期间输入框禁用+进度条 |
| INT-AG-10 | 权限模式切换 | PAG-07 | 胶囊滑动动画 200ms；toast 说明生效范围 | 升档需二次确认+权限点校验；切换即时生效于下一工具调用，进行中未决审批不追溯改判 |
| INT-AG-11 | OBO 续签提示 | obo.expiring 事件 | 静默续签（默认无 UI）；失败→黄条 "登录态失效，会话已暂停" | 暂停期间输入可编辑但不发送；恢复登录后自动续跑 |
| INT-AG-12 | 紧急停止 | Cmd/Ctrl+Shift+. / 托盘 / ■ | 全屏遮罩停止动画（600ms）→ 结果清单 toast | 三入口一致；审计 emergency_stop；未决审批全部作废 |
| INT-AG-13 | 崩溃恢复 | runtime.state(crashed) | 横幅+事件重放进度条（已重放/总数） | 完成自动续接；8012 → 只读快照横幅；重试 3 次耗尽 → 停止自动重启 |
| INT-AG-14 | 分享卡片 | PAG-03 📤 | 弹窗选结论/附件 → session_share | conv 搜索复用 im 的会话选择器（shared/components）；离线时发送按钮禁用 |
| INT-AG-15 | 新建会话 | [🆕 新会话] | 若无工作区先引导选择（系统目录选择器+信任确认） | 活跃会话 ≥3 时提示关闭旧会话（08 §7） |
| INT-AG-16 | 会话切换/搜索 | 列表点击 / 搜索框 | 路由 `/agent/s/:id`；状态与滚动位置存 feature store | 断点切换不丢状态（D01 §5.2） |
| INT-AG-17 | 斜杠指令 | 输入框 `/` | 菜单：/strong 升档 /compact 手动压缩 /brief 生成简报 | 指令以 user.message 文本下发（08 §6.1），非 UI 本地命令 |
| INT-AG-18 | 批量审批 | 右栏多选 | 同类 ≤中危一次允许/拒绝 | 高危不参与；逐条卡保留决策来源=bulk |
| INT-AG-19 | 记忆撤销 | PAG-11 [撤销] | 删除 grant/规则，即时生效 | 撤销永久记忆需普通确认弹窗；toast "已撤销" |
| INT-AG-20 | 命令卡编辑 | 命令框 ✎ | 编辑后 [y] 回传 editedArgs | 编辑不改变风险重判（Runtime 重走判定，09 §4.3） |
| INT-AG-21 | 内嵌卡追问 | PAG-02 [💬 追问] | 内联输入→agent_input(embedded session) | 追问追加进同卡；卡内消息上限 20 轮后提示转工作台 |
| INT-AG-22 | 转到工作台 | PAG-02 / 分享卡 | 新建 workbench 会话注入 conclusion+来源摘要 | 不继承上下文/权限记忆；新会话摘要行注明来源会话 |
| INT-AG-23 | 文件拖入 | 拖入工作台 | 投放高亮→作为上下文附件（路径引用） | ≤20 个/次（D01 §10）；越出工作区的文件提示"将以只读路径引用" |
| INT-AG-24 | 时间线跳转 | 点击时间线项/⛁cp | 定位到对应事件 seq / 打开 PAG-06 对比 | 检查点被清理后置灰 |

### 4.2 状态机（UI 级）

**审批卡状态机**（agent_approval_cache.state）：

```
waiting ──允许(y/批量)──► approved
waiting ──拒绝(n/批量)──► rejected
waiting ──120s 超时──────► timeout（语义=拒绝，UI 灰显"已超时拒绝"）
waiting ──紧急停止/会话paused/崩溃──► cancelled（作废，可由恢复流程重发新 requestId）
approved/rejected/timeout/cancelled：终态，卡片折叠进历史（时间线保留决策标签）
```

**委派任务卡状态机**（delegate_task.status）：

```
preparing ──确认委派(delegate_launch ack)──► running
running ──delegate.end(exit 0, diff 提取)──► completed ──自动──► reviewing
running ──exit ≠0 / 8033─────────────────► failed（[重试][改用内置])
running ──用户取消/8034───────────────────► cancelled
running ──宿主/Runtime 崩溃───────────────► failed(8033) 并提示重放后续接
reviewing ──[全部接受]───────────────────► accepted（落盘+归档+审计）
reviewing ──[全部拒绝/逐hunk拒绝]─────────► rejected_restored（恢复到前置 cp）
```

### 4.3 快捷键 / 右键 / 拖拽

| 类别 | 项 |
|---|---|
| 快捷键 | Cmd/Ctrl+Shift+. 紧急停止（全局）；Cmd/Ctrl+Shift+M 模式循环；y/n/a 审批（选中卡）；Cmd+F 会话内搜索（PAG-03 事件流过滤）；Esc 关闭浮层 |
| 右键 | 会话右键：重命名/置顶/分享/导出事件镜像/结束会话；工具卡右键：复制参数/复制结果/查看审计条目；时间线项右键：打开文件/对比检查点/复制路径 |
| 拖拽 | 文件拖入=上下文附件（INT-AG-23）；右栏审批卡可拖拽排序（仅展示顺序，不改判定顺序——判定在 Runtime 串行） |

## 5. 接口详细设计

### 5.1 本地 Tauri 命令表（UI→宿主 Rust 核心，`invoke()` 白名单）

| 命令 | 参数（字段级） | 返回 | 说明/错误 |
|---|---|---|---|
| agent_start_session | workspace_id?: string, form: 'embedded'\|'workbench', mode: PermissionMode, model_policy: 'fast'\|'strong'\|'auto', title?: string, context_ref?: string（升级自内嵌卡时携带） | { session_id } | 活跃 >3 → 8001 系提示；宿主转发 stdio session.start |
| agent_input | session_id: string, text: string, attachments?: {kind:'local_path',path:string}[] | { ok: true } | 转发 user.message；发送后 UI 乐观上屏 |
| agent_stop | session_id: string, reason: 'user'\|'archived' | { ok } | 结束会话（session.end） |
| agent_pause / agent_resume | session_id | { ok } | 对应 session.pause/resume |
| agent_emergency_stop | — | { killed_pids: number[], cancelled_requests: string[] } | 全局紧急停止（09 §4.6） |
| agent_set_mode | session_id, mode: PermissionMode | { ok, effective: PermissionMode } | 宿主校验权限点后转发；失败 2001 |
| agent_approve | request_id, scope: 'once'\|'session'\|'permanent', edited_args?: object, accepted_hunks?: number[] | { ok } | 转 permission.response(allow)；permanent 需租户允许 |
| agent_reject | request_id, reason?: string, rejected_hunks?: number[] | { ok } | 转 permission.response(deny)；reason 回填模型 |
| agent_tool_detail | call_id: string | { args_full, result_full, truncated, exit_code? } | 工具卡"查看全文"按需拉取（结果全文在 Runtime，08 §6.1） |
| agent_compact | session_id | { ok } | 手动触发压缩（/compact 同） |
| agent_restore_session | session_id | { ok, replayed_events: number } | 崩溃后从检查点+事件镜像重放（8012 时返回错误） |
| checkpoint_create | session_id, reason: 'manual' | { checkpoint_id } | 手动检查点 |
| checkpoint_restore | checkpoint_id | { ok, new_snapshot_id } | 恢复（自动先快照） |
| delegate_launch | session_id, backend?: 'zcode'\|'claude'\|'generic'\|'builtin', task_brief: TaskBrief(见 §6.3) | { delegate_task_id } | 8030/8031/8032/8035；工作区互斥锁 |
| delegate_input | delegate_task_id, text | { ok } | 追加指令（send_input） |
| delegate_cancel | delegate_task_id, graceful: boolean | { ok } | false=立即 SIGKILL 树 |
| delegate_review | delegate_task_id, decision: 'accept'\|'reject', rejected_hunks?: number[] | { ok, restored_checkpoint_id? } | 审查结论；reject 自动恢复 cp |
| backend_detect | types?: string[] | { results: BackendProbe[] } | 探测+版本+最小 headless 冒烟 |
| backend_set_default | backend_id | { ok } | 用户默认后端 |
| memory_list | scope?: 'permanent'\|'session' | { grants: ToolGrant[] } | allow.json + 内存记忆 |
| memory_revoke | grant_id | { ok } | 撤销并即时生效 |
| blocked_list | session_id?, kind?, cursor?, limit? | { items, next_cursor } | agent_sandbox_violation 分页 |
| session_list / session_get | cursor? / session_id | 分页 / 详情 | 本地库读 |
| session_share_prepare | session_id | { conclusion, files: string[], model, steps, duration } | 取模型缓存结论（必要时向 Runtime 请求生成） |
| session_share | session_id, conv_id, conclusion: string(≤500), file_refs: string[] | { msg_seq } | 宿主直发 msg.send(type=agent_card)（04 篇通道） |
| workspace_pick / workspace_list | — / — | { path } / { items } | 系统选择器 / 最近打开（含信任确认） |

**示例 JSON**：

```json
// invoke('agent_start_session', {...})
{ "workspace_id": "ws-01H...", "form": "workbench", "mode": "auto-edit", "model_policy": "auto" }
// →
{ "session_id": "sess-01J..." }

// invoke('agent_approve', {...})  // 命令卡：改命令 + 会话记忆
{ "request_id": "pr-1042", "scope": "session",
  "edited_args": { "command": "cargo test --lib -- --nocapture", "cwd": "/Users/dev/code/bbw-server" } }
// →
{ "ok": true }

// invoke('delegate_launch', {...})
{ "session_id": "sess-01J...", "backend": "zcode",
  "task_brief": {
    "task": "在 order-svc 增加 POST /refunds 退款接口",
    "workspace": "/Users/dev/repos/order-svc",
    "constraints": ["遵循现有分层", "Go 1.22"],
    "context": [ { "source": "kb:公司空间/订单域接口规范v3", "excerpt": "错误码/鉴权要求…" } ],
    "acceptance": ["make build 通过"],
    "forbidden": ["修改 db/migration"]
  } }
// →
{ "delegate_task_id": "dt-01J..." }
```

### 5.2 UI 订阅的 IPC 事件表（宿主→WebView，事件名 `agent::<type>`，payload=stdio 协议镜像 + 宿主补充，协议字段定义见 08 §6.1 与 D11 §4）

| 事件 | 触发时机 | 关键字段（UI 消费） | UI 落点 |
|---|---|---|---|
| agent::stream.delta | 模型流式增量 | session_id, delta, seq, channel(text/reasoning) | PAG-03 正文/思考折叠（INT-AG-01） |
| agent::stream.done | 一轮生成结束 | session_id, finish_reason, usage | 状态点→idle；用量入头部 |
| agent::tool.call | 工具调用开始 | call_id, tool, args(脱敏), risk, source(self/backend), parallel | 工具折叠卡创建（运行中） |
| agent::tool.result | 工具调用结束 | call_id, ok, summary, truncated, exit_code?, blocked?{rule,kind} | 卡片状态更新；blocked→时间线红标 |
| agent::permission.request | 需确认 | request_id, tool, risk, reason, preview{kind: command/diff/obo, …}, options[] | PAG-04 卡入右栏队列+倒计时 |
| agent::permission.response | 宿主回执镜像 | request_id, decision, scope | 卡终态（多端/快捷键一致） |
| agent::compaction.event | 压缩开始/完成 | phase, freed_tokens, kept_rounds | 中栏黄条 "已压缩 42k tokens[展开归档]" |
| agent::checkpoint.created | 检查点建立 | checkpoint_id, files_changed[], reason | 检查点栈+时间线 ⛁ 标记 |
| agent::model.switched | 档位切换 | from, to, reason | 头部档位徽标动画+tooltip |
| agent::session.state | 状态迁移 | session_id, state(D11 §3 枚举) | 会话列表状态点/头部 |
| agent::subagent.spawn / subagent.event / subagent.join | 子 Agent 生命周期 | sub_id, phase(spawn/delta/done/fail), summary, parent_id | 子任务折叠行（PAG-03） |
| agent::delegate.brief | 简报生成 | brief(TaskBrief), backend_suggestion | 任务简报卡（PAG-04.5） |
| agent::delegate.event | 委派归一化事件 | delegate_task_id, kind(output/tool_use/tool_result/warning/meta), payload | 委派卡折叠流+计数 |
| agent::delegate.end | 子进程退出 | delegate_task_id, exit_code, changed_files[], checkpoint_id, summary | 卡→reviewing+审查区 |
| agent::error | 协议级错误 | code(8xxx), message, fatal, session_id? | toast/横幅；fatal→PAG-08 |
| agent::runtime.state（宿主生成） | 心跳/崩溃/重启进度 | state(healthy/restarting/crashed), attempt, replay{done,total} | PAG-01 状态条/PAG-08 横幅 |
| agent::obo.expiring（宿主生成） | 到期前 2min | session_ids[], renewing: boolean | 静默；失败黄条（INT-AG-11） |

### 5.3 服务端接口关联（无新增 REST）

- 策略拉取：`GET /api/v1/agent/policies`（09 §6.2）——会话启动前宿主拉取，UI 消费其布尔结果（full-auto 可用性、高危永久记忆开关）。
- 云备份 4 个 API（08 §6.3）：设置页开关，不在工作台主流程。
- WS：`agent.revoked` → 会话冻结横幅；`agent.policy.updated` → 即时生效提示条；`ai.quota.warning` → 头部用量黄条。

## 6. 模型设计（客户端本地表 + UI 侧 TS 类型）

> Runtime 侧全量 10 表 DDL 见 D11 §11；此处仅列 UI 直接读写的三张（列定义与 D11 一致）。

```sql
CREATE TABLE agent_session (            -- 与 D11 §11 同源
  id            TEXT PRIMARY KEY,       -- sess-<ulid>
  workspace_id  TEXT,                   -- FK agent_workspace.id
  title         TEXT NOT NULL DEFAULT '新会话',
  form          TEXT NOT NULL DEFAULT 'workbench' CHECK(form IN ('embedded','workbench')),
  mode          TEXT NOT NULL DEFAULT 'ask' CHECK(mode IN ('ask','auto-edit','full-auto')),
  backend       TEXT,                   -- 委派后端 zcode|claude|generic|builtin（17 篇增列；NULL=未委派）
  model_policy  TEXT NOT NULL DEFAULT 'auto',
  status        TEXT NOT NULL DEFAULT 'idle',   -- D11 §3 状态机枚举
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  ended_at      INTEGER, summary        TEXT
);
CREATE INDEX idx_agent_session_updated ON agent_session(updated_at DESC);

CREATE TABLE delegate_task (            -- 与 D11 §11 同源
  id                TEXT PRIMARY KEY,   -- dt-<ulid>
  parent_session_id TEXT NOT NULL REFERENCES agent_session(id),
  backend_type      TEXT NOT NULL,
  task_brief        TEXT NOT NULL,      -- JSON TaskBrief
  status            TEXT NOT NULL DEFAULT 'preparing'
    CHECK(status IN ('preparing','running','completed','failed','cancelled',
                     'reviewing','accepted','rejected_restored')),
  child_session_ref TEXT,               -- 后端续接句柄（--resume 等）
  exit_code INTEGER, result_summary TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
CREATE INDEX idx_delegate_task_session ON delegate_task(parent_session_id, created_at DESC);

CREATE TABLE agent_approval_cache (     -- D08 新增：右栏审批队列缓存（宿主写/UI 读）
  request_id  TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES agent_session(id),
  tool        TEXT NOT NULL,
  risk        TEXT NOT NULL CHECK(risk IN ('low','mid','high')),
  args_digest TEXT NOT NULL,            -- 打码后摘要（09 §4.5）
  preview     TEXT,                     -- JSON：{kind:'command'|'diff'|'obo', ...}
  options     TEXT NOT NULL,            -- JSON：["once","session","permanent"?]
  state       TEXT NOT NULL DEFAULT 'waiting'
    CHECK(state IN ('waiting','approved','rejected','timeout','cancelled')),
  created_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,         -- created_at+120000
  decided_at  INTEGER
);
CREATE INDEX idx_approval_waiting ON agent_approval_cache(session_id, state, created_at);
```

核心 TS 类型（`features/agent/model/`）：

```ts
export type PermissionMode = 'ask' | 'auto-edit' | 'full-auto';
export type SessionStatus = 'starting'|'idle'|'running'|'waiting_permission'|'waiting_review'
  |'subagent_fanout'|'delegating'|'paused'|'error'|'ended';
export type RiskLevel = 'low' | 'mid' | 'high';
export type GrantScope = 'once' | 'session' | 'permanent';
export type ApprovalCardState = 'waiting'|'approved'|'rejected'|'timeout'|'cancelled';
export type DelegateStatus = 'preparing'|'running'|'completed'|'failed'|'cancelled'
  |'reviewing'|'accepted'|'rejected_restored';

export interface AgentSession {
  id: string; workspaceId?: string; title: string;
  form: 'embedded' | 'workbench'; mode: PermissionMode;
  backend?: 'zcode'|'claude'|'generic'|'builtin';
  modelPolicy: 'fast'|'strong'|'auto'; status: SessionStatus;
  createdAt: number; updatedAt: number; endedAt?: number; summary?: string;
}
export interface TaskBrief {
  task: string; workspace: string;
  constraints: string[];
  context: { source: string; excerpt: string }[];   // source: kb:… / doc:… / im:…
  acceptance: string[]; forbidden: string[];
}
export interface PermissionRequest {
  requestId: string; tool: string; risk: RiskLevel;
  reason: string;                                    // 触发规则/分类结果
  preview:
    | { kind: 'command'; command: string; cwd: string; dangerFlags: string[] }
    | { kind: 'diff'; file: string; hunks: DiffHunk[]; addLines: number; delLines: number }
    | { kind: 'obo'; scopes: string[]; target: string };
  options: GrantScope[]; expiresAt: number;
}
export interface DiffHunk { index: number; header: string; lines: { type: '+'|'-'|' '; text: string }[] }
export interface DelegateTask {
  id: string; parentSessionId: string; backendType: string;
  brief: TaskBrief; status: DelegateStatus; childSessionRef?: string;
  exitCode?: number; changedFiles?: { path: string; add: number; del: number }[];
  checkpointId?: string;
}
export interface Checkpoint { id: string; sessionId: string; reason: string;
  filesChanged: string[]; createdAt: number }
export interface BackendProbe { type: string; installed: boolean; path?: string;
  version?: string; capabilities: string[]; smokeMs?: number;
  disabledByPolicy?: boolean; errorCode?: number }   // 8030/8031/8032
export interface ToolGrant { id: string; tool: string; pattern: string;
  scope: GrantScope; grantedAt: number; sourceCard?: string }
export interface AgentCardPayload {          // 08 §4.8
  session_ref: { id: string; title: string };
  conclusion: string; files: string[];
  model: string; steps: number; duration: number;
}
```

## 7. 响应式适配（四档断点）

| 页面 | XL ≥1600 | L 1280–1599 | M 1024–1279 | S 720–1023 |
|---|---|---|---|---|
| PAG-01 | 三栏全展开（右栏固定 304px） | 三栏；右栏默认浮层化可固定（**审批队列 L 档起可用**） | 左栏收窄 56px 图标条（悬停抽屉）；右栏强制浮层（审批入口=徽标按钮） | 单栏：会话列表⇄会话视图两级导航；审批队列/检查点=底部抽屉 |
| PAG-03 | 消息流+时间线同屏；工具卡双列摘要 | 同 XL 单列 | 时间线折叠为头部下拉 | 终端输出区默认折叠 |
| PAG-04 | 卡片全宽预览 | 同 | diff 卡横向滚动（不换行挤压） | 命令卡编辑框 100% 宽 |
| PAG-05 | 委派卡+审查区并列 | 审查区跟帖式内联 | 输出明细默认折叠 | 后端选择器改纵向列表 |
| PAG-06/09/11/12 | 弹层/页面双形态 | 同 | 弹层宽度上限 90% | 全屏页 |
| PAG-02 | IM 单栏卡片自适应 | 同 | 同 | 同 |

性能响应点：流式 50ms 批刷（INT-AG-01）；事件流虚拟滚动（key=eventId，react-virtuoso）；diff 懒渲染（屏外 hunk 占位）；审批卡倒计时用单个全局 ticker 避免每卡一 timer；会话切换不销毁订阅（事件按 session_id 分流缓存）。

## 8. 模块划分（features/agent/，文件级）

```
src/features/agent/
├─ pages/
│  ├─ WorkbenchPage/            # PAG-01：/agent（三栏装配）
│  │  ├─ index.tsx  SessionListPane.tsx  WorkspacePane.tsx  RuntimeStatusBar.tsx
│  ├─ SessionViewPage/          # PAG-03：/agent/s/:id
│  │  ├─ index.tsx  SessionHeader.tsx  MessageStream.tsx  TerminalPane.tsx
│  │  ├─ TimelineBar.tsx  Composer.tsx  SlashMenu.tsx
│  ├─ BackendsSettingsPage/     # PAG-09
│  ├─ MemoryPage/               # PAG-11
│  ├─ BlockedOpsPage/           # PAG-12
├─ components/
│  ├─ approvals/                # PAG-04 族
│  │  ├─ CommandCard.tsx  DiffApprovalCard.tsx  BulkApprovalBar.tsx
│  │  ├─ OboScopeCard.tsx  TaskBriefCard.tsx  ApprovalQueue.tsx  useApprovalHotkeys.ts
│  ├─ delegate/                 # PAG-05
│  │  ├─ DelegateTaskCard.tsx  BackendSelector.tsx  DelegateOutputFeed.tsx
│  │  ├─ DelegateReviewPanel.tsx
│  ├─ checkpoints/              # PAG-06：CheckpointStack.tsx  CheckpointDiffModal.tsx
│  ├─ stream/                   # ToolCallCard.tsx  ReasoningCollapse.tsx  SubagentRow.tsx
│  ├─ emergency/                # PAG-08：EmergencyOverlay.tsx  CrashRecoveryBanner.tsx
│  ├─ share/                    # PAG-10：ShareModal.tsx
│  └─ embedded/                 # PAG-02：EmbeddedAgentCard.tsx（供 im 渲染）
├─ api/
│  ├─ commands.ts               # §5.1 全部 invoke 封装
│  ├─ events.ts                 # §5.2 listen() 注册与分发
│  └─ queries.ts                # Query hooks + key（['agent','sessions'] 等）
├─ store/
│  ├─ sessionStore.ts           # 当前会话/滚动吸底/折叠偏好（Zustand）
│  └─ approvalStore.ts          # 审批队列 UI 态（缓存表镜像+倒计时）
├─ model/                       # §6.3 TS 类型
└─ events.ts                    # 对外广播：'agent:share-sent' / 'agent:open-workbench'
```

跨模块交互点（走 `shared/bus`，禁止横向 import，D01 §12.2）：

| 对端 | 通道 | 内容 |
|---|---|---|
| im | bus `im:render-agent-card` | PAG-02 内嵌卡、接收侧 agent_card 渲染（im 提供消息上下文，agent 提供组件） |
| im | bus `agent:share-sent` | 分享成功后失效 im 会话 Query 并 toast |
| eco | bus `eco:open-skill-manager` | 会话头部"技能"入口跳转技能管理（D09 域）；技能加载结果经 tools.reload→runtime.state 回流 |
| settings | 设置 bus（挂载点注册） | PAG-09/11 作为设置二级页注册进 `/settings/agent` 导航；通用设置读取 Agent 偏好（默认模式/默认后端） |
| shared/ui | DiffView / Badge / Skeleton | 审批 diff 卡、状态点、骨架复用 |

## 9. 边界与异常

| 场景 | 处理 |
|---|---|
| 审批积压（用户离开） | 单卡 120s 超时=拒绝；≥3 次超时自动 paused（09 §7.4）→ 状态点灰 + 横幅 |
| Runtime 不可用且重启耗尽 | 工作台只读态：历史会话可浏览（本地库），新输入禁用；PAG-08 提供重试 |
| 委派中 Runtime 崩溃 | 委派子进程由宿主接管清理（BBW_SANDBOX 标记扫描）；恢复后 delegate_task 标 failed(8033) 待续接 |
| 会话被吊销（agent.revoked） | 会话卡片锁定 + "已被管理员吊销"；未决审批全部 cancelled |
| 策略热变更（agent.policy.updated） | 黄条 "安全策略已更新，进行中的相关工具调用将重新确认"（09 §6.3） |
| 同工作区并发会话 | 新会话提示 "另一会话正在使用此工作区" 冲突风险（08 §7）+ 委派互斥 8035 |
| 离线分享 | session_share 禁用（依赖 msg.send）；分享弹窗保留草稿 |
| 输出超限（8022/8023） | 终端区显示终止原因横幅；工具卡 blocked 标签 |
| 哈希链告警（8027） | 全局高危横幅 "本地审计校验失败"（次数少、必须显眼），入口 PAG-12 |

## 10. 开放问题

1. **消息命名统一**：08 §6.1 为 `tool.call/tool.result/checkpoint.event/session.started`，本篇 UI 事件表与 D11 统一采用 `tool.call / checkpoint.created / session.ready` 细化命名——需回填概要篇 08 §6.1 一次对齐（见 D11 §4 登记）。
2. preview.kind=obo、`channel(reasoning)`、`delegate.brief` 为 D08/D11 联合新增字段/消息，需在 14 篇事件注册表补登记说明（本地协议不走 WS 注册表，但文档一致性需要）。
3. 内嵌卡追问轮数上限（当前 20）与上下文携带量是否可配——阶段三实测。
4. 多显示器下紧急停止遮罩只覆盖主窗口是否足够（是否需要系统级 toast 联动）。
5. 会话内搜索（Cmd+F）是否需要索引 agent_event 全文（当前：仅工具名/文件名/文本前缀过滤）。
