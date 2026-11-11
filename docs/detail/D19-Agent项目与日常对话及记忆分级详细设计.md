# D19 — Agent 项目/日常双区与记忆分级详细设计

- 编号：D19
- 定稿：2026-11-10
- 关联：08（Agent 总体）/ D08（工作台）/ D09（工具与安全）/ D11（Runtime 内部）/ D13（沙箱）/ D15（记忆双轨）/ D18（IM 内嵌卡）
- 范围：bbrt 协议+store+memory+session+tools、Tauri 壳、客户端 agent 工作台；**服务端零改动**（D15 口径：记忆本地文件唯一权威）

> **落地注记（2026-11-11 · 会话历史加载）**：工作台打开会话此前只显本进程直播流（重启/切列表即空白）。新增协议 `session.history` REQ→`session.history.result`（HistoryItem：user/assistant 原文+tool 名与结果摘要；golden 契约已锁），RT 直读 `agent_event` WAL（会话不须在运行态，历史/结束会话同样可查，与 rename 直落库同口径）；WAL 写入点随之增补——`assistant.done` 加 `text` 回复原文、`tool.result` 加 `ok`/`summary`（旧 WAL 行缺字段渐进降级：assistant 旧轮跳过、tool name-only；recovery 仍只读旧字段不受影响，recovery 借 text 重建上下文留阶段二）。前端 store `selectSession` 即拉 `loadHistoryIfEmpty`（本进程无流时回填，直播中/乐观上屏不覆盖）。IM embedded 会话（D18 与私聊/群聊同一会话身份）在工作台打开即见全程聊天记录——跨端同会话历史互通。mock 桥剧本为内存态不落 WAL，历史返回空（真实链路专用）。

## 1. 背景与定位

用户诉求三件：

1. 工作台像 ZCode 一样分**项目**与**日常对话**：日常不绑目录（轻量问答），项目绑定一个目录（代码开发）；每个项目的经验/习惯属于该项目。
2. 记忆区分**用户级**（身份/偏好，全会话可见）与**项目级**（该项目会话写入与召回）。
3. 工作台思考/工具调用显示无自动折叠、效果差——对齐 change-my-life agent-web（D18 已复刻为 AgentProcessCard，本篇把同款行为落回工作台组件）。

探索确认的既有缺口（本篇一并收口）：

- `agent_workspace` 表在 bbrt SQLite **已建未接线**（session 行 `workspace_id` 恒 None）；
- 工具沙箱根是全局占位 `PathBuf::from(".")`（bbrt main.rs）——**按项目隔离从未真正发生**；
- bbrt-memory 全局单作用域（`project` 只是条目 type 标签不是分区）；
- 宿主会话缓存重启即空（会话列表每次启动清零）。

已拍板决策：项目记忆=本机 dataDir 分区（不写进用户仓库）；持久化=客户端本地（接线 bbrt SQLite，重启可恢复）；布局=左栏两分区。

## 2. 会话模型：项目 / 日常

- **判定**：`session.start.workspace` **空串=日常对话**，非空=项目会话（realpath 归一）。
- **项目登记**：`agent_workspace` 表接线为唯一登记处。两条入口共用 upsert（realpath 唯一、同目录重复打开不换身份、`created_at`/`id` 保留首次值）：
  - 宿主 `workspace.register`（用户「打开项目」显式登记）；
  - `session.start` 带目录自动登记（manager.start 内联）。
  - `is_repo`=.git 探测；`name` 缺省=目录名；`trusted` 恒 true（**D19 简化口径**：系统目录选择对话框是显式动作即视为信任；D08 §4.4 精细信任确认——例外目录/AGENTS.md 声明——登记阶段二）。
- **归属回填**：session.start 带目录时 `agent_session.workspace_id` 回填（修 D11 既留缺口）；恢复路径同样回填。
- **移除**：`workspace.forget` 只删登记行——历史会话 `workspace_id` 置 NULL（归入日常展示）、记忆分区文件不动。
- **IM 内嵌卡联动**（D18 口径修订）：embedded 会话 workspace=最近一个**项目**会话的目录（跳过日常），无项目历史=日常（''）。「转到工作台」沿用 createSession（默认日常）。

## 3. 沙箱按会话路由（安全核心）

**既有五层防线不变**（D09/D13）：①run_command 词法写目标预检（tokenize 提取写操作数+cwd → PathPolicy.validate(Write) → 8020 拒执行）；②realpath 防软链逃逸（8024，新文件走最深存在祖先解析）；③macOS Seatbelt 内核强制（`deny file-write*` 全盘禁写 + 仅工作区 subpath 可写 + 默认断网）；④Baseline 降级档（逐次审批+网络命令全拒+模式压 auto-edit）；⑤进程组/超时/截断/RSS 看门狗。

**本篇改动=「全局一个工作区根」→「按会话解析」**：

- 共享 `SessionWorkspaces` 表（bbrt-session 定义，`session_id → Some(项目目录)/None(日常)`；manager start/end 维护，bin 装配注入 tools 管线）。
- `PipelineExecutor` 执行时按 `call.session_id` 解析执行环境：项目会话→克隆 ExecEnv 覆写 `workspace`+`path_policy`（PathPolicy 按项目根缓存）；日常→**workspace 类工具整体 8020 拒绝**（专用文案「日常对话未绑定工作目录」+ violation 记录）；未登记会话→兜底全局根（单测/嵌入式旧行为；生产兜底根置空=全拒）。
- 效果：A 项目会话的命令**物理上只能写 A 目录**（预检 8020 + Seatbelt 内核双拦），不同项目并发会话（≤3）各自独立沙箱根；日常会话文件/命令/git/search/coding.delegate 全不可用。
- 委派（coding.delegate）在 loop_runner 侧同口径拒绝（8030 域外用 8020 文案）。

**明确边界（登记不做）**：读不设项目墙（09 篇 B10 既定口径：全盘可读+敏感清单 8026 拒读）；Seatbelt 仅 macOS，Linux/Windows 桌面退 Baseline（预检+逐次审批兜底）。

## 4. 记忆分级（bbrt-memory）

- **物理布局**：用户级维持 `{dataDir}/agent/memory/`；项目级 `{dataDir}/agent/memory/projects/<scope_key>/`，`scope_key=<目录名净化>-<路径 FNV-1a 64 哈希 16hex>`（ZCode 风格，如 `baobao-work-72ab07a9e501bc35`；realpath 归一防路径别名）。分区天然继承 4KB/200 条 LRU/脱敏拒写（KnowledgeStore 复用）。
- **路由规则（类型驱动）**：`user` 类恒用户级；`project/feedback/reference` 类在项目会话→项目分区，日常会话→回落用户级。四个写入路径全走该规则：W1 `memory_save` 工具（pipeline 按会话解析 ws）、W2① 启发式（恒 user 类→用户级）、W2② 工具教训 feedback（随会话目录）、W3 会话结束提炼（逐条按类型路由；已有索引喂两域合并头 60 行）。
- **召回**：`recall_scoped(ws, query)`——项目会话注 `[用户记忆]`+`[项目记忆·<分区>]` 两段（单段空则只注另一段），日常仅用户段；子代理 ProbeCtx 同口径。
- **提示词**：SYSTEM_PROMPT 记忆规范补作用域说明（自动路由无需指定）；[项目] 行日常会话显示「日常对话（无工作目录）」。
- **授权记忆（allow.json 三档）不在本篇**：恒用户级，与知识记忆正交（09 篇口径不动）。

## 5. 协议增量（D11 §4 消息表追加）

| 方向 | 消息 | 载荷要点 |
|---|---|---|
| 宿主→RT REQ | `workspace.register` | `{path, name?}` → `workspace.registered{item}`（realpath upsert） |
| 宿主→RT REQ | `workspace.list` | → `workspace.listed{items[]}`（last_opened_at 倒序） |
| 宿主→RT REQ | `workspace.forget` | `{id}` → `workspace.forgot{ok}`（解除会话关联+删行） |
| 宿主→RT REQ | `session.list` | `{limit?}` → `session.listed{items[]}`（agent_session JOIN agent_workspace：id/title/workspace/mode/modelPolicy/modelOverride/status/时间戳/summary；**宿主重启恢复会话列表的数据源**） |
| 宿主→RT REQ | `memory.list` 增参 | `scope?:"user"|"project"` + `workspacePath?`（缺省=user 旧口径兼容；project 无路径=全部分区合并带 workspaceName） |
| 宿主→RT REQ | `memory.delete` 增参 | 同上两参 |
| RT→宿主 UNT | `memory.saved` 增字段 | `scope?`+`workspaceName?`（optional 兼容） |

`session.start.workspace` 语义注记：空串=日常（String 必填，wire 兼容）。

## 6. 壳与客户端

- **Tauri 壳**：`session_list` 数据源换 `session.list` REQ（RT 持久行 camel→snake 归一）+ 宿主缓存叠加（活跃状态/本地模型切换最新；RT 不可用回落纯缓存）；新命令 `workspace_register/workspace_list/workspace_forget`；`memory_list/memory_delete` 透传 scope。
- **工作台左栏两分区**：header 双入口「+ 日常对话」「打开项目」（plugin-dialog 目录选择，参照 TransferSettingsPage 模式）；项目区=登记表 ∪ 会话路径兜底（项目行=名称+短路径+会话数+hover 新会话/移除，可折叠内嵌会话）；日常区=workspace='' 平铺。header 副标题=项目名·路径 or「日常对话 · 无工作目录」。
- **记忆页**：作用域页签「用户记忆/项目记忆」+ 项目下拉；条目 scope 徽标（项目名）；删除带作用域。
- **IM 内嵌卡**：workspace 取最近项目会话（§2）。

## 7. 过程显示对齐 change-my-life（纯客户端组件层）

参考件 `change-my-life/agent-web/src/components/ThinkingCard.vue`+`ToolCallGroup.vue`；D18 已把整卡效果复刻为 AgentProcessCard（IM 用），本篇把同款行为落回工作台组件：

- **ReasoningCollapse 重写**（=ThinkingCard）：流式强制展开（头部呼吸动画 `agc-pulse` + `maxHeight 300↔0` 0.22s 过渡 + 内部跟底滚动），结束自动收起为一行摘要；点击手动切换，streaming 翻转重置回自动态。
- **ToolGroup（新）**（=ToolCallGroup）：连续 tool 条目归组，灰底汇总条「正在执行 (N 个工具)」（图标 pulse）/「N 个工具调用 · 全部完成」；任一运行中=展开、全部落定=自动折叠；单条工具不套组条（直接 ToolCard，避免一次点击变两次）。
- **ToolCard**：运行中自动展开（看实时参数）、结果落定自动收回头部行；blocked 红条带常显保留。
- **TypingState**：加 300ms tick 已用时（对齐 Elapsed；`12.3s`/`1分05秒`）。
- PermissionCard/SubagentCard/DelegateCard 不动（审批卡必须常显）。

## 8. 验收记录（2026-11-10）

| # | 事项 | 状态 |
|---|---|---|
| 协议 | envelope 4 新消息+memory scope 字段+golden 契约测试（golden_d19_*） | [x] cargo test bbrt-protocol 26 例绿 |
| store | list_workspaces/remove_workspace/list_sessions_with_workspace/set_session_workspace+测试 | [x] 33 例绿 |
| memory | 项目分区+scope_key+save/list/delete/recall/get scoped+测试（隔离/别名归一/两段召回） | [x] 全绿 |
| session | manager 接线（realpath 归一+upsert+workspace_id 回填+SessionWorkspaces）、召回分级、SYSTEM_PROMPT、日常拒绝 coding.delegate、W2②/W3 scoped | [x] 全绿 |
| tools | 按会话路由沙箱（session_env/policy_for 缓存/WORKSPACE_BOUND_TOOLS 日常拒绝/memory_save 类型路由）+4 专项测试（A 写 B 拒/日常拒绝/记忆分级/cwd 越界） | [x] tools_suite 42 例绿 |
| bin | 新 REQ 分发+ws_item 投影+兜底根置空 | [x] workspace 52 套件全绿 |
| 壳 | session_list 换源+三命令+memory scope 透传 | [x] cargo check/fmt 绿 |
| 客户端 | bridge/store/两分区列表/双入口/记忆页页签/embedded 取值/过程显示四件 | [x] tsc+vite build 绿 |
| 真机 | 日常拒绝文案/项目会话文件落正确目录/双分区记忆/重启恢复/过程卡动效 | [ ] 待用户验收 |

## 9. 登记不做（阶段二）

- D08 §4.4 精细信任确认（例外目录/AGENTS.md 白名单前缀接线——ToolsConfig.whitelist_prefixes 已留位）
- 流历史回放（老会话点开仍无历史流，meta 列表可恢复已是本篇增量）
- 读级项目墙（全盘可读口径不变）
- Windows/Linux 内核级沙箱（Seatbelt 等价物）
- 授权记忆 allow.json 的项目作用域
- 记忆跨设备云同步（D15 既有阶段二口径）
