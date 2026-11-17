# D18 - IM 内嵌 Agent 卡详细设计

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（2026-11-10 定稿，本轮实施范围见 §7） |
| 上游文档 | [08-AI-Agent总体设计](../08-AI-Agent总体设计.md) §3.2 形态① · [D03-IM模块](D03-IM模块详细设计.md) · [D08-Agent工作台](D08-Agent工作台模块详细设计.md) PAG-02 · [09-工具与安全](../09-AI-Agent工具与安全设计.md) |
| 本篇范围 | 会话模型 · 触发与卡片形态 · 数据与落流协议 · 审批弹框 · 安全设计（本轮未实施） · 改动清单与分期 |
| 裁决记录 | 2026-11-10 用户拍板：完整过程透明卡（推翻 D08 PAG-02「仅结论」口径）；审批/clarify 聊天页弹框（推翻 OQ-B08 白名单口径）；(用户,会话) 一会话；分阶段更新落流；安全分层随阶段二（本轮复用 agent 既有能力，不做沙箱约束） |

> **⚠ 与上游口径的差异**：D08 §3.2「结论 ≤500 字/仅最终结论+来源/20 轮上限/固定只读白名单」与 OQ-B08「不放开 run_command」按 2026-11-10 用户裁决**作废**——内嵌形态升级为「聊天壳里的完整 Agent 体验」，与工作台的差异只剩 UI 形态与落流行为。

---

## 1. 定位与场景

内嵌卡解决的不是「能不能用 AI」，而是：

1. **AI 产出留在协作现场**——群里 @Agent 的答案以卡片留在消息流，在场者即时可见、后来者翻记录可查；对比去 /agent 页问完还要复制粘贴回群
2. **不懂 AI 的同事零门槛**——@Agent 与 @同事同构，无会话/档位/检查点概念；工作台保留给干重活的人
3. **AI 答案可被讨论**——卡片支持引用回复，讨论围绕答案展开

形态分工：**聊天内嵌 = 问一句/轻协作（完整能力但聊天壳）；工作台 = 重活（三栏监督设施）**。「转到工作台」承担长大后的任务搬家。

## 2. 会话模型

**核心定案：一个 (用户， 会话) 二元组 = 一个常驻 embedded Agent 会话。**

```
alice 在「行政群」 → alice 的 embedded 会话 A（bbrt，跑在 alice 本机）
alice 在「项目群」 → alice 的 embedded 会话 B（与 A 完全独立，上下文不串）
bob   在「行政群」 → bob   的 embedded 会话 C（跑在 bob 本机）
```

| 规则 | 说明 |
|---|---|
| 惰性创建 | 该 (user, conv) 首次触发 @Agent 时 `agent_start_session` 建立 |
| 常驻复用 | 后续 @Agent 直接 `agent_input` 续在同一会话，上下文自动延续 |
| 跨群隔离 | conv 维度分会话，行政群内容永不进入项目群上下文 |
| 跨人隔离 | Agent 跑在各自桌面本机，物理隔离，天然不可能共用 |
| 映射存储 | `convId → sessionId` 映射存 IndexedDB bbc-local meta（D01 §12.2-5 禁 localStorage 存业务数据）；bbrt 侧即普通会话（SQLite 持久） |
| 复用既有能力 | workspace 必填 → 沿用工作台最近会话的工作区（无历史则弹目录选择）；mode 固定 `ask`（弹框审批）；模型路由同工作台 |
| 与工作台并存 | embedded 会话出现在工作台会话列表（同 store 同 runtime），可随时去工作台打开 |

**bbrt/协议零改动**：embedded = 普通会话 + 前端路由差异。title 约定 `聊天: {会话名}` 便于区分。

## 3. 交互形态

### 3.1 触发

- **主入口：输入框 Agent 按钮**（MessageInput 旁 🤖 开关——点亮后本条消息走 Agent 而非 msg.send，输入框顶部出现「Agent 模式」状态条可取消）
- **补充：文本 `@Agent ` 前缀检测**（前端拦截不下发，等价点亮开关）
- 范围：单聊 + 普通群；广播群 v0.1 不开（publisher-only 语义与 Agent 回复冲突，登记开放问题）

### 3.2 发起者视角：活动卡（实时）

```
┌ 🤖 Agent ── 聊天: 行政群 · #s-77 ── 运行中 ● ──────────┐
│ ▸ 思考摘要（折叠，默认收起）                             │
│ ✓ search_files "差旅报销" ── 0.4s ── 12 处命中          │
│ ✓ kb_query "报销流程" ── 0.8s ── 3 篇                  │
│ ▸ 正在生成结论▍（流式 markdown）                        │
├──────────────────────────────────────────────────────┤
│ [💬 追问…]（内联单行输入，回复追加进卡） [🖨 转到工作台]    │
└──────────────────────────────────────────────────────┘
```

- 流式渲染与工具行复用工作台组件逻辑（StreamMessage/ToolCard 的卡片化变体）
- **审批弹框**：approval.requested 事件 → 聊天主窗 antd Modal（命令可编辑 + 批准/拒绝 + 记忆三档，复用 PermissionCard 逻辑；120s 超时自动拒绝照旧）
- 失败：卡内红字 8xxx + [重试]；**不设轮次上限、不设结论字数上限**（完整体验定位）
- 紧急停止：全局 ⌘⇧. 已覆盖（杀 bbrt 进程，含 embedded 会话）

### 3.3 接收者视角：落流卡（分阶段更新）

- 首个阶段完成即落流一条 `agent_card` 消息；**每完成一次工具调用/阶段结束，PATCH 更新该消息**（复用 msg.updated 扇出，接收端近实时看到卡「分步长出」）
- 终态（done/failed/cancelled）最后更新一次并收起运行态
- 接收者操作：仅静态查看 + [⤴ 引用回复] 照常。~~[在我端继续]~~ **2026-11-10 用户裁决移除**：每人只与自己的 agent 对话，不做跨人续聊入口（原实现本就是点击者自己的 agent+注入卡片文字，因语义易混淆砍除；想追问者自行 @Agent 新开）
- 历史卡为静态快照（不回放流式）

### 3.4 页面效果参考（change-my-life agent-web，2026-11-10 用户指定——仅效果参考，非逻辑）

实现时过程展示组件对齐 change-my-life/agent-web 的成熟模式（React 版重写）：

**① 思考卡（ThinkingCard 模式）**
- 独立小卡：图标 + 标题（流式=「思考中...」呼吸 pulse 动画；完成=「思考过程」）+ chevron
- **流式中强制展开；思考结束自动折叠**（watch streaming 翻转 expanded）
- max-height 0.22s 过渡；展开态内部滚动（≤300px）+ 流式期间自动跟底

**② 工具组（ToolCallGroup 模式）**
- 灰底汇总条：「正在执行 (N 个工具)」（进行中图标 pulse）/「活动： N 个工具调用」（完成）；**进行中默认展开、完成后折叠**
- 每工具一行 code 样式：`name — 参数摘要`（优先 path/command/query 等代表性字段，截断 ~60 字；BaobaoChat 加结果摘要列——落流 stages 已有 summary）
- 子任务卡（SubagentCard/DelegateCard）**插在其发生时的父 phase 之后**，按执行顺序而非全部堆尾

**③ 运行中 vs 完成态（核心视觉规则）**
- 运行中：思考卡+工具组实时展开 + 最终答案流式 markdown + 瞬态状态行（spinner +「正在思考...」+ **实时已用时计时**，300ms tick）
- 完成态：**过程整体折叠为「活动摘要条」**——`▸ N 轮 LLM 调用 · N 次工具调用 · 耗时 Xs`，点击展开逐轮详情（第 N 轮 LLM + 静态思考卡 + 工具组 + 中间轮正文）
- **落流卡（接收者视角）与刷新后的发起者卡统一用完成态形态**——从消息历史渲染即为折叠摘要条，天然一致

**④ 审批卡（HITL confirm 模式）**
- 卡内「以下工具调用需要你的确认」列表（工具名 + 参数 JSON pre）+ [允许执行][拒绝] 按钮
- 终态回显：✅ 已允许，继续执行… / ⛔ 已拒绝；**刷新后挂起的确认照常恢复并可操作**；有未决确认时锁定输入框

**⑤ 补充指令标签（steer 模式）**
- 运行中发出的补充指令在消息流里带「补充」角标（对应 delegate.input 补充通道的可见化）

**⑥ 刷新恢复语义**
- 发起者刷新页面：活动卡状态从**消息流内已落流的 agent_card（分阶段快照）**恢复——进行中则重接 agent://event 流继续实时渲染（conv→session 映射在 IndexedDB 不丢）；已结束则渲染为完成态折叠摘要条
- 失败/停止的醒目呈现：红字错误框 + 停止提示条（⏹️ 已停止 / ⏭️ 已被新消息打断同款语义：紧急停止/取消）

### 3.5 升级/继续的上下文机制（2026-11-10 修订：自读制）

**不搬运内容**——升级（转到工作台）与继续（在我端继续）均只传 conv_id：新会话首条 user 消息为一条指令，让 agent 调 `im_history` 工具（mcpgw 新增，low 风险只读+成员校验）自读会话最近消息（含此前 agent_card 结论提炼行），自行建立上下文。依据：(用户,会话) 本就固定一会话，消息流即事实源；文本注入既冗余又截断失真。协议级 `context_ref`（D08 §419 设计）随阶段二。「在我端继续」= 点击者自己的 (人,会话) embedded 会话（每人只与自己的 agent 对话，2026-11-10 用户裁决原则）。

## 4. 数据与协议

### 4.1 agent_card 消息体（落流卡）

```json
{
  "kind": "embedded_agent",
  "session_id": "s-77",
  "status": "running | done | failed | cancelled",
  "stages": [
    { "t": "thinking", "digest": "…", "ts": 1762780000 },
    { "t": "tool", "name": "kb_query", "status": "ok", "ms": 800, "summary": "3 篇命中" },
    { "t": "conclusion", "md": "## 报销流程\n1. …" }
  ],
  "sources": ["kb:行政空间/差旅制度v4"],
  "rounds": 3
}
```

- 服务端视为不透明 JSON（与 call_card 先例同口径，透传落库）
- 客户端按 `kind` 渲染；未知 kind 回退 `[卡片]` 摘要（前向兼容）

### 4.2 更新通道（服务端唯一新增）

`PATCH /api/v1/messages/{id}/agent-card`，body `{stages, status, sources}`：
- 校验：sender=发起者本人 && 消息 type=agent_card && kind=embedded_agent
- service `UpdateAgentCard` → repo 更新 body → eventbus TopicMsgUpdated → gateway msg.updated 扇出（多端同步）
- 频率：仅阶段边界触发（工具完成/结论完成/终态），非 delta 级

### 4.3 前端事件路由

- agent store `handleEvent` 按 sessionId 路由机制不变；聊天卡组件订阅自身 sessionId 的事件（活动卡状态本地维护）
- 卡片渲染组件放 `shared/components`（im 与 agent 共用，规避 features 横向 import；D08 §660 `im:render-agent-card` bus 设计简化为共享组件直用）
- conv→session 映射：IndexedDB meta 读写（`agent_embedded_map` key）

### 4.4 触发链路（零协议改动）

```
ChatPage（Agent 模式点亮）→ 前端查 conv→session 映射
  ├─ 无 → invoke agent_start_session(workspace=最近, mode=ask, title="聊天: {会话名}") → 记映射
  └─ 有 → invoke agent_input(sessionId, 消息文本)
流式事件 agent://event → 前端按 sessionId 路由 → 活动卡渲染
阶段完成 → invoke agent_input? 否——落流/更新走 REST（http.ts）：msg.send(agent_card) / PATCH agent-card
```

## 5. 安全设计（⚠ 本轮未实施，随阶段二落地）

**威胁模型**：群聊既是注入源（任何人可发诱导提示词）又是外泄通道（Agent 输出落流全员可见）。工作台形态输出仅本人可见，内嵌形态打开了泄洪口——五层纵深防御：

| 层 | 机制（阶段二实施） | 拦截效果 |
|---|---|---|
| ① 沙箱路径硬约束 | embedded 文件工具硬限制在绑定工作区内（bbrt-sec sandbox/path 既有能力）——工作区外（~/.ssh 等）物理不可达 | 工作区外敏感文件断根 |
| ② 落流前脱敏 | agent_card 内容发出前过 masking（密钥/密码/token/证书模式打码；bbrt-sec masking 既有基础）；群聊强制开 | 工作区内敏感内容出去即打码 |
| ③ 审批记忆降级 | embedded 会话审批记忆最高「本会话」，移除「永久」档 | 防一次手滑永久放行 |
| ④ 注入防御提示词 | embedded system prompt 加固：拒绝「读取并外发凭证/密钥/配置」类指令 | 拦明显攻击（软） |
| ⑤ 审计与总闸 | run 记录可回放 + killswitch（既有，随内嵌卡生效） | 事后追溯+紧急止血 |

**v0.1 现状口径**：复用 agent 既有防线（ask 档逐工具审批弹框 + 既有 gate/沙箱默认行为 + run 审计 + 紧急停止），不做上述增量——**群聊内嵌存在提示词注入致敏感信息外泄的残余风险，已知并接受**（内部工具阶段一容忍度；阶段二五层齐上收口）。

## 6. 改动清单（本轮）

| 层 | 改动 | 量级 |
|---|---|---|
| 服务端 message | `UpdateAgentCard`（service+repo+REST PATCH+测试）；msg.send 类型透传已支持零改动 | ~80 行 |
| 壳桥 | 零改动（agent_start_session 现有参数够用；workspace 由前端传入） | 0 |
| bbrt/协议 | 零改动（embedded=普通会话） | 0 |
| 前端 IM | MessageInput Agent 开关+@Agent 检测；AgentEmbeddedCard 活动卡（流式/工具行/审批 Modal/追问/失败重试）；MessageBubble 渲染 agent_card 落流卡+[在我端继续]；conv 映射 IndexedDB | 大头 |
| 前端 agent | 审批 Modal 复用 PermissionCard 逻辑；「转到工作台」注入跳转 | 中 |
| 通知 | run 终态 agent_done 通知链复用（embedded 会话同口径） | 0 |

## 7. 分期

| 期 | 内容 |
|---|---|
| **v0.1（本轮）** | §2/§3/§4 全量 + §6 改动；安全=既有防线原样 |
| 阶段二 | §5 五层安全 + 协议 context_ref 升级 + 广播群支持评估 + 落流卡渲染精化（参考成熟产品效果） |

## 8. 开放问题（登记）

1. 广播群是否开内嵌 Agent（publisher 语义与 Agent 回复的冲突口径）
2. 落流卡在消息搜索/收藏中的 digest 口径（v0.1 `[卡片]`，后续取 conclusion 首行）
3. 多设备：embedded 会话为本地 SQLite，换设备不延续（与工作台同口径，跨设备随云备份体系）
4. 群聊 Agent 使用计量/配额是否单列 scene（现 scene=chat，混计）
