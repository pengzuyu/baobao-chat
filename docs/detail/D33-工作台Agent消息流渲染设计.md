# D33 工作台 Agent 消息流渲染设计（zcode 式平铺流 + 类型化块 + 子 agent 侧栏）

- 日期：2026-11-17 ｜ 状态：**批0-4 编码完成已推（dcf559e→9d3f2bb→9a7d29b→0c91768→387d7c7），程序侧验证全绿（cargo test / tsc / vite build / 壳 check），剩 §5 真机验收（归用户）**
- **2026-11-19 修订（用户走查）**：右栏由「上下文栏（概览/运行/详情固定 tab）」改为**内容坞**——左栏不再出现 run 记录；子 agent 过程按**主会话归属/隔离**（切会话整条 tab 条切换，绝不跨会话共用）、多子 agent=多可关闭 tab、可拖宽 + 右上角收起/展开；无固定 tab，未来 browser/文件等内容同坞扩展（拍板 #3 与 §3.6 已改写）。
- 前置：[D08](D08-Agent工作台模块详细设计.md)（PAG-03 会话视图）、[D18](D18-IM内嵌Agent卡详细设计.md)（§3.4 六条效果规则 / stages 投影）、[D19](D19-Agent项目与日常对话及记忆分级详细设计.md)（§7 过程显示对齐 change-my-life）、[D16](D16-子Agent三形态与Run记录模型设计.md)（run 模型）、[D22](D22-插件系统详细设计.md)（技能格式/装配）、[D26](D26-全站UI组件库切换AntDesign详细设计.md)（antd 换制）
- 动机（用户 2026-11-17 需求原话归纳）：工作台 agent 显示弃「回合卡片」形态，改为 zcode 式消息流——不同类型消息（思考/工具/技能/子 agent/MCP/中间结果）**各自专属形态**；工具细分（读/写/编辑/终端）要丰富；最终正文输出时中间过程完整折叠为一行统计（总耗时）；点子 agent 卡在右侧栏以其完整过程（与主渲染器同款）查看。现状四个硬缺口见 §2。

## 1. 拍板点（勿重提）

| # | 决策 | 内容 |
|---|------|------|
| 1 | **工作台中栏弃卡片改平铺流** | 回合不再包 AgentProcessCard 大卡；过程条目平铺（无头像、全宽、类型化块）；收口后过程折叠为一行统计+正文常开。**用户消息：2026-11-17 二改修订——回归右对齐主色气泡**（黑白反色：主色底+基色字，token 随 D27 主题/accent 切换联动；初版「也改平铺块」作废），agent 侧保持平铺流 |
| 2 | **skill 感知 = 显式 `skill` 内置工具**（Claude Code 同款） | 不是 shell 读文件、不做 skill_manage（装卸已有 tools.reload 通道）；工具名 `skill`、args `{name}`、**结果=SKILL.md 正文**（天然注入上下文）；走现有 toolCall/toolResult 通道——时间线天然工具卡、WAL 自动记录、risk 取 frontmatter（high 可挂审批）、协议零扩展；**移除隐式触发词注入**（match_for 自动注入路径退役）——技能加载统一显式调用，机制单一可见 |
| 3 | **子 agent 侧栏 = 右栏内容坞，动态 tab 管理**（2026-11-19 修订，取代旧「AgentContextSidebar 固定四 tab + 运行详情加宽 480」） | 右栏=**通用内容坞**：无固定 tab；每个子 agent run=一个可关闭 tab（中栏子任务卡「查看过程」或头部「历史子任务」下拉才创建——点击才开，不自动建）；**DockTab 带 sessionId=归属主会话，只渲染当前会话的 tab**（切会话整条 tab 条切换、不共用，保证子 agent 可追溯到调用它的会话）；tab 内容复用 `AgentStreamView`（与中栏同款）；宽度可拖（默认 400，280~760，右向拖拽反向）、右上角完全收起/展开；未来 browser/文件等同坞按 `DockTab.type` 扩展 |
| 4 | **IM 内嵌卡不动，工作台新写**（修订 2026-11-11「两处同一实现」拍板） | AgentProcessCard 归 IM 落流卡/发起者卡专用（服务端 stages 协议不动）；工作台新写 `features/agent/components/stream/` 组件族；MarkdownText 等原子件继续共用；stagesFromStream 投影归 IM 卡专用 |
| 5 | **Rust 协议三件套纳入本批** | ① skill 工具（见 #2）；② `subagent.trace` 过程事件（probe 每步文本/工具外发+WAL）+ `run.history` 回放 REQ；③ WAL `tool.call` 行补 args_masked + `HistoryItem::Tool` 加 args（重启回放保真） |
| 6 | MCP 无独立事件 | MCP 工具走 toolCall 统一通道，名 `mcp.{server}.{tool}`——UI 按前缀拆解渲染（server 徽标），协议零改动 |
| 7 | 历史回放保真度口径 | WAL 仍是摘要级：reasoning/审批/澄清/系统行不入历史（既定口径延续）；工具卡因 args_masked 补记而保真（命令/路径/diff 重启可见）；旧行无 args → None 降级 |

## 2. 现状锚点（2026-11-17 逐行核对）

**渲染层**：`client/src/features/agent/components/TurnBubble.tsx`（回合气泡：`groupTurns` L155 分组 / `renderProcessItems` L85 过程条目 / memo 逐条引用比较 L250）；过程卡= `shared/components/AgentProcessCard.tsx`（IM+工作台共用；`agentStatsText` L205 统计口径「用时·N次LLM调用·N次工具·N个子agent」；ThinkingCollapse L72 流式展开收尾折叠；ToolRow L119 终端行）；工具卡 `components/ToolCard.tsx`（单一泛型卡：图标按名前缀 L19、run_command 特判「终端」）；工作台三栏 `pages/AgentWorkbenchPage.tsx`（右栏 aside 304px 挂 AgentContextSidebar L548-570）；`store/agent.ts`（StreamItem 联合 L26-84 / handleEvent L684 / stampTurnDone L361=收口打点 turnDoneAt−ts / historyToStreamItem L282 args 合成空）。

**协议层**：wire 权威 `bbrt-protocol/src/envelope.rs`（RuntimeToHost L779-：stream.delta(channel text/reasoning)、tool.call(args_masked=JSON字符串/risk/parallel/source self)、tool.result(ok/summary/truncated/exit_code/blocked/duration_ms)、permission/clarify、subagent.spawn/event/join、delegate.*；HistoryItem L390-三态）；**skill 零事件**（`bbrt-session/src/skills.rs`：match_for 命中→render 拼正文→loop_runner.rs:732 注入 system 组装，全程静默）；**子 agent 过程不外发**（`subagent.rs` run_probe：drain L559 整段收集、工具执行只写进程内 history；WAL 仅 subagent.spawn/input/cancel/event 摘要行；child_session_ref 仅委派非空）；WAL `agent_event` 表（run_id 列已建，003 迁移）；`tool.call` WAL 行只记 `{call_id,tool}`（loop_runner.rs:949）——args 不落库；**真机 self 工具 args 是 JSON 字符串**（bridge.rs:188 包 Value::String）而前端类型声明是对象——终端卡头部命令在真机实际显示不出（存量坑，批2 归一化修复）；壳事件泵（`agent_bridge.rs` L492+）对非 delta 事件类型无关透传（normalize_event 通用键名转换），新 wire 类型无需改泵。

## 3. 机制设计

### 3.1 skill 显式工具（bbrt-tools builtin）

- 注册：`skill` 工具，入参 `{name: string}`；执行 = `SkillIndex` 按 name 精确查找 → 命中返回正文（`# 技能: {name}（risk: …）\n{body}`，即现 render 单条格式；工具结果天然进模型上下文）；未命中返回错误摘要（可用技能名列表，引导重试）。
- 装配：SkillIndex 以 `Arc<Mutex<>>` 注入 pipeline（与 tools.reload 重扫共用同一实例；tools.reload{reason:skill} 后新技能即刻可调）。
- risk：取技能 frontmatter risk（low/medium/high）——high 经既有 gate 可挂审批；`static_category` 增 `skill` 只读类目（不属修改面）。
- 索引区改版：`render_index` 文案「可用技能目录，提及名称或关键词即可加载对应技能」→「可用技能目录，调用 skill 工具加载对应技能」；**`match_for`/`render` 隐式注入退役**（loop_runner.rs:732 组装段 skills 区块只放索引区文本；skills.rs 两函数标记废弃保留供测试）。
- probe 子 agent：ProbeCtx.skills 同源（subagent.rs:126 同样只走索引区，不再 match_for 注入）。
- 前端：`tool='skill'` → SkillCard（§3.5）；args.name 头部直显。

### 3.2 subagent.trace 过程事件（probe）

- wire（envelope.rs 新增 NTF）：`subagent.trace { session_id, sub_id, item }`，item 三态：
  - `{ kind: "text", text }` —— 每模型轮整段一次（probe drain 本就整段收集，无逐 token）
  - `{ kind: "tool_call", call_id, tool, args_masked, risk }` —— 工具发起（脱敏后）
  - `{ kind: "tool_result", call_id, ok, summary, duration_ms }` —— 工具落定
- 发射点（run_probe 循环）：drain 后 text 非空 → trace(text)；每个 tc 执行前 → trace(tool_call)；execute 返回 → trace(tool_result)。
- 持久化：每个 trace 同步 `wal.append_run(session_id, run_id, "subagent.trace", payload)`（agent_event.run_id 列既有）。
- bridge.rs 映射：risk `medium→mid` 与 tool.call 同口径；events.rs 加 SessionEvent::SubagentTrace。
- 范围：v0.1 仅 probe（探查是 fan-out 主力）；expert 登记阶段二（expert.rs 循环同构可后续套用；原 team 随协作图退役 2026-11-19）。
- 前端路由：trace 按 runId 进 `sideStreams`，**不进主时间线**（主流仍只有 spawn 卡+done 摘要，防噪音）。

### 3.3 run.history 回放 REQ

- `HostToRuntime::RunHistory { run_id }` → `RuntimeToHost::RunHistoryResult { run_id, items: Vec<HistoryItem> }`（照 session.history 模式：main.rs 分发 + store `events_by_run(run_id)` 查询 + 投影）。
- 投影 `wal_run_history(events)`：`subagent.spawn` 行 → `User{task}`（payload 已含 task 截断 60 字）；`subagent.trace` text → `Assistant{text}`；tool_call/tool_result 按 call_id 配对 → `Tool{call_id, tool, ok, summary, args}`；其余行忽略。
- 透传链：Tauri command `run_history`（agent_commands.rs 照 session_history）→ bridge `runHistory(runId)` → store `loadRunHistory`。
- 运行详情：probe/expert/terminal 统一走 run.history 回放（原 delegate 的 childSessionRef 子会话历史随委派域退役 2026-11-19；原 team 随协作图退役同日）。

### 3.4 WAL args 保真（历史回放）

- loop_runner.rs `tool.call` WAL 行 payload 补 `"args": {args_masked}`（JSON 字符串原样入 payload 字段）。
- `HistoryItem::Tool` 加 `args: Option<String>`（envelope + wal_history 透传；旧行 None 降级——「旧行可缺」惯例；recovery 只读 call_id/name/summary，不受影响，崩溃恢复上下文不进 args）。
- 前端 HistoryItem 类型同步；historyToStreamItem 把 args parse 进合成 toolCall（工具卡重启保真）。

### 3.5 工作台平铺渲染器（`features/agent/components/stream/`）

回合结构（`TurnBlock`）：`[UserBlock 用户平铺块] → 过程条目平铺（运行中全显示）→ 正文`；**收口后**过程折叠为一行 `✓ 用时42秒 · 5次LLM调用 · 8次工具 · 1个子agent`（复用 agentStatsText 文案与算法，总耗时=turnDoneAt−ts）+ 正文常开；点击折叠行展开平铺过程；**未决 permission/clarify 与 error 行强制展开**（口径延续）。TypingState 空态保留。

类型化块规范：

| 条目 | 组件 | 形态 |
|---|---|---|
| user | `UserBlock` | **右对齐主色气泡**（2026-11-17 二改：黑白反色主色底+基色字，token 随 D27 主题/accent 切换联动；maxWidth 88%） |
| reasoning | `ReasoningBlock` | 灰底块「思考中…/思考过程」：**流式输出中=默认单行 ticker**（当前行=最后非空行，不折行、超宽横向滚动、自动跟尾、换行切新行；点击可临时展开看全文）；**输出完毕=自动折叠只留标题行不展示内容**，点开才展开全部（≤300px 滚动）——2026-11-17 三改定稿，与共享 ThinkingCollapse 分叉（IM 不受影响） |
| agentText（中间轮） | `MidText` | 弱化正文段（左边框+次要色，zcode 中间说明段形态） |
| agentText（最终） | 正文 | 全宽 MarkdownText + 流式光标 |
| tool | `ToolBlock`（家族分流） | 见下表 |
| skill | `SkillCard` | tool='skill' 专属：🧩 技能名 + 已加载正文摘要（展开看全文） |
| subagent | `SubagentCard`（改造） | 折叠头行 + 状态/耗时 + **「查看过程」入口**→右栏运行详情 tab；运行中补充指令/取消保留 |
| permission/clarify | `PermissionCard/ClarifyCard`（平铺化） | 交互不变，容器去卡套 |
| system/error | `SystemRow/ErrorRow`（迁移） | 居中灰条 / 红字行，不变 |

工具家族（`toolFamilies.ts` 的 `classifyTool(tool)`，内置 snake_case 工具名映射；无 delete_file 工具——本产品无删除面，未知名按 generic 兜底如实显示）：

| family | 内置名 | 头部 | 展开体 |
|---|---|---|---|---|
| fileRead | read_file / list_dir | Read / LS | 「读取/列目录」+路径(+行区间) | 参数+结果摘要（行数等） |
| fileWrite | write_file | Write | 「写入」+路径 · N行/N字节（args.content 计算） | 内容预览 |
| fileEdit | edit_file | Edit/Update | 「编辑」+路径 | **old/new 全量红绿行 diff**（精确替换语义，无需 diff 算法；外部 old_string/new_string 同取） |
| search | search_files | Grep/Glob | 「搜索」+query | 参数+命中摘要 |
| terminal | run_command | Bash/Shell | 「终端」+`$ 命令` 单行截断 | 命令全文+输出块+exit code |
| git | git_* | — | 「Git」+动作词（状态/差异/提交/推送） | 参数+结果 |
| web | http_fetch | WebFetch/WebSearch | 「网络」+URL/查询 | 参数+结果摘要 |
| memory | memory_* | — | 「记忆」+动作词 | 参数+结果 |
| mcp | mcp.{server}.{tool} | mcp__s__t | server 徽标「MCP · {server}」+工具名 | 参数+结果 |
| internal | subagent.adjust/cancel、task.wait | 「内部」+工具名 | 参数+结果 |
| generic | 兜底 | 兜底 | 图标+工具名+关键参数（现 ToolCard 形态） | 参数 JSON+结果 |

头行统一：图标+动作词+关键参数（单行截断）+ 状态（运行中 Spin/ok·耗时/失败·exit/blocked 红条带）；**运行中自动展开、落定折叠**（D19 口径延续）；blocked 8020-8026 文案映射沿用 ToolCard 现表。

`AgentStreamView`：条目→块的分发器，**中栏与右栏内容坞（子 agent 过程 tab）共用**；memo 逐条引用比较（对齐 TurnBubble 口径，appendDelta 保旧条目引用稳定是前提，不破坏）。

### 3.6 右栏内容坞（2026-11-19 修订，取代原「aside tab 化 + 运行详情」）

- **形态**：右栏=通用内容坞 `AgentRightDock`（原 `AgentContextSidebar` 删除）；**无固定 tab**——内容全部按需打开，无 tab 时整坞不渲染（不占宽）。
- **会话归属/隔离（硬口径）**：每个 `DockTab` 带 `sessionId`（调用子 agent 的主会话）+ `key=subagent:<runId>`；内容坞**只渲染 `sessionId === 当前会话` 的 tab**——切会话=整条 tab 条与激活 tab 一起换（`dockActiveBySession` 按会话记忆），A 会话的 tab 绝不出现在 B 会话下（含 IM 内嵌/定时任务等后台会话），子 agent 过程始终可追溯到发起它的会话；tab tooltip 另带「所属会话标题」双保险。
- **入口（点击才开）**：① 中栏子任务卡「查看过程」→ `openRunTab(sessionId, runId, taskDigest)`；② 中栏头部「历史子任务」下拉（仅当前会话有 run 记录时出现，最近 20 条）——覆盖重启后子任务卡不在会话流里的历史 run 回看（`subagent.spawn` 不入 session.history 投影）。
- **tab 形态**：antd `Tabs type="editable-card"`（可关闭、无 + 号）；label=类型标签（探查/专家/终端，按 `runsBySession` 反查）+ 摘要截断 + 运行中圆点；关闭激活 tab 回落同会话最后一个，全关即坞隐藏。
- **数据**：直播 `sideStreams[runId]`（`subagentSpawn` 播种 user 条目=taskDigest；`subagentTrace` 投影：text→agentText、tool_call/result→tool 条目按 callId 配对）；打开时若空 → `loadRunHistory(runId)` 回放（run.history REQ，D33 §3.3 不变）。
- **布局**：`useSplitWidth('agent-dock', 400, 280, 760, 'right')` + `SplitHandle`（中栏与坞之间；右侧栏向右拖=变窄）+ `paneRef` 拖动直写；**收起/展开**：展开态按钮在坞 tab 条最右（右上角），收起态按钮在中栏 header 最右（运行中 tab 带圆点）。原「运行详情激活即 304→480」动态加宽退役。
- **扩展点**：`DockTab.type` 当前仅 `'subagent'`；未来 browser/文件打开等内容增 type 后同坞渲染（内容区通用化，对齐 zcode 右栏定位）。

## 4. 批次划分（每批一提交一推送）

| 批 | 层 | 内容 | 量级 |
|---|---|---|---|
| 0 | 文档 | 本篇 + README 索引 + D08 文首修订注记 | 小 |
| 1 | Rust | skill 工具（builtin+pipeline+索引区改版+隐式注入退役）/ subagent.trace（envelope+events+bridge+subagent 发射+WAL）/ run.history REQ / WAL args 补记 + HistoryItem.args / 测试（roundtrip+wal_history+trace+skill） | 大 |
| 2 | 前端桥/store | normalizeEvent：subagent.trace case + **toolCall.args 字符串归一化（存量坑修复）**；AgentEvent/HistoryItem 类型；runHistory 链路（command+bridge）；sideStreams+activeRunView+subagentTrace 投影+loadRunHistory；mock 剧本补 skill/trace | 中 |
| 3 | 前端渲染 | stream/ 组件族（AgentStreamView/TurnBlock/UserBlock/ReasoningBlock/MidText/SkillCard/ToolBlock+toolFamilies/SystemRow/ErrorRow）+ Permission/Clarify/Subagent 平铺化 + AgentWorkbenchPage 中栏切换 | 大 |
| 4 | 前端右栏 | AgentContextSidebar Tabs 化 + 运行详情视图 + SubagentCard 入口 + aside 动态宽 | 中 |
| 5 | 验证 | cargo test / tsc / vite build（不做浏览器 UI 测试——既定口径）+ 本篇 §5 验收清单追记 | 小 |

**落地记录（2026-11-17）**：批0 dcf559e / 批1 9d3f2bb（cargo test 全绿：roundtrip 计数 23/38 + D33 golden×5 + wal_history args + wal_run_history + skill 三态 + skills_loop 新口径两用例）/ 批2 9a7d29b / 批3 0c91768（退役删除 TurnBubble/ToolCard/ToolGroup/StreamMessage 四组件）/ 批4 387d7c7；批5 验证：agent workspace `cargo test` 全绿、`tsc -b` 0 错、`vite build` 成功（7.2s）、壳 `cargo check` 通过（唯一 warning 为既有 TEMP 排错宏非本次引入）。

**落地记录（2026-11-19 右栏内容坞修订）**：左栏任务区移除 run 记录（`AgentSessionList` 去 `runs`）；`AgentContextSidebar` 删除 → 新增 `AgentRightDock`（动态 tab/会话隔离/可关闭/右上角收起）；store 以 `dockTabs + dockActiveBySession + dockCollapsed` 承载（`taskRuns`/`activeRunView` 退役，`taskRuns` 全量拉取链路删除）；`useSplitWidth` 增 `side='right'`；中栏头部新增「历史子任务」下拉（当前会话 run 回看）。验证：`tsc --noEmit` 0 错 + `vite build` 成功（7.7s）。

## 5. 真机验收清单（归用户；批5 追记证据）

| # | 项 | 口径 |
|---|---|---|
| 1 | 思考卡 | 流式展开、段末自动折叠、收口后在折叠过程区内 |
| 2 | 工具族形态 | 读（路径+行区间）/写（路径+行数字节）/编辑（红绿 diff）/终端（$ 命令+输出+exit）/git/搜索/MCP 徽标；运行中展开落定折叠 |
| 3 | 技能 | 消息提及技能场景 → 模型调 skill 工具 → 时间线 SkillCard；索引区文案为新口径 |
| 4 | 收口折叠 | 完成后过程折叠一行（用时/LLM/工具/子agent 统计），只留正文；点击展开 |
| 5 | 子 agent 内容坞 | 点子任务卡「查看过程」→ 右栏打开该 run 过程 tab（与中栏同款平铺流，运行中/完成后均可看）；并行多子任务=多 tab 可切换/逐个关闭；切会话后右栏只显示该会话的 tab（不串台），切回恢复原激活 tab；拖分界条调宽（刷新保持）、右上角收起/展开（收起态中栏 header 展开钮带运行中圆点）；重启 App 后经「历史子任务」下拉回看旧 run |
| 6 | 重启保真 | 重启 App 打开历史会话：工具卡仍有命令/路径/diff（args 保真）；旧会话（升级前数据）降级不报错 |
| 7 | IM 零变化 | 聊天内嵌 agent 卡/落流卡形态与改前一致 |
| 8 | 用户消息 | 平铺块形态，发送/流式收口正常 |
| 9 | 中间正文 | 工具轮之间的说明段弱化展示，最终正文常开 |

## 6. 坑与遗留登记

- **args 双形态坑（存量）**：self 工具 args=JSON 字符串 / backend=对象——批2 normalizeEvent 统一 parse（parseToolArgs，失败回落 {}）；mock 桥已发对象不受影响。
- **ToolCard/ToolRow 的 toolCallCommand 在真机 self 形态下取不到 command**——随归一化修复自然痊愈。
- **mem 中 streams/sideStreams 均内存态**：刷新即失、重开走历史回放（摘要级口径见拍板 #7）。
- ~~委派后端外部工具名映射表（Read/Edit/Bash…）~~：随委派域退役删除（2026-11-19）。
- **【发现项·D16 遗留缺口，本篇不修】probe 子 agent 工具执行绕审批门**：`run_probe`（subagent.rs）对每步工具直接 `ctx.tools.execute()`，不经 `check()` 门控——与模块注释「写操作走同一审批/沙箱」不符（沙箱词法层仍拦 8020-8026，但矩阵/审批/记忆层缺位）。主循环路径正常。修复需 probe 循环接入 check→NeedConfirm 等待链（审批卡挂到侧栏运行详情），建议另立项或并入 D16 遗留清理。
- **subagent.trace WAL 行 payload 为 camelCase**（SubagentTraceItem 序列化原样），与主循环 WAL 行（snake_case 手拼）风格不一致——wal_run_history 投影按 camelCase 取键，读侧已对齐；登记备将来 WAL 键名统一时收敛。

## 7. 登记不做（阶段二）

- 子 agent 逐 token 流式 trace（现整段，IPC 省）；probe reasoning 不外发（现状丢弃）。
- expert 的 trace（expert.rs 循环同构，后续套用）。
- 隐式触发词注入的「自动加载」提示行（机制整体移除，见拍板 #2）。
- 思考/审批/澄清入历史回放（WAL 摘要级既定口径）。

## 8. 对上游文档的修订清单

| 上游 | 原文口径 | 修订 |
|---|---|---|
| D08 §3.3 | PAG-03 中栏「回合气泡/思考摘要折叠行/工具折叠卡」规范 | 中栏渲染规范由 D33 §3.5 接管（本篇文首已加注记） |
| D18 §3.4 / D19 §7 | 「两处同一实现」AgentProcessCard 共用 | 工作台侧改 D33 平铺流；AgentProcessCard 归 IM 专用（原子件仍共用） |
| D22 §2.1 | 技能「触发词命中自动注入」 | 改显式 skill 工具调用（索引区引导）；触发词注入退役 |
| D08 §8 | stream/ 组件规划 | 目录落位 `features/agent/components/stream/`（本篇落地） |

## 9. 开放问题（登记）

1. 运行详情 tab 是否需要「复制全文/导出」动作——用户验收后定。
2. subagent trace 的 WAL 行量：长跑 probe（60 步上限）≈百余行/任务——量级可接受，暂不采样。
3. skill 工具结果很长（技能正文全量）时 tool.result summary 截断口径：沿用管线统一截断，不单独放宽。
