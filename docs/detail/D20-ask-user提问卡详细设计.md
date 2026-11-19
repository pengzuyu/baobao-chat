# D20：ask_user 提问卡详细设计（ZCode 式澄清机制）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（2026-11-11 定稿即实施） |
| 上游文档 | [D08-Agent工作台](D08-Agent工作台模块详细设计.md) 审批卡机制 · [D11](D11-Agent%20Runtime内部详细设计.md) §3 状态机/§4 协议 · [D18](D18-IM内嵌Agent卡详细设计.md) 审批三端同步 · 09 篇工具与安全 |
| 本篇范围 | ask_user 工具 · clarify.request/response 协议对 · 会话状态 WaitingClarify · 三端提问卡 UI · 测试与冒烟 |
| 裁决记录 | 2026-11-11 用户拍板：立项做 ZCode 式提问卡（此前 D18 裁决「审批/clarify 聊天页弹框」中 clarify 从未实现——agent 需要澄清只能正文提问，不可点选、三端无感知） |

## 1. 定位

Agent 在**关键决策点**向用户发起结构化提问（ZCode AskUserQuestion 形态）：
选项点选作答（可多选/可自由补充），答案作为工具结果回给模型继续本轮。与正文提问的差异：可点选（降低回答成本）、三端同感（私聊/群聊/工作台任何一端可答）、答案进工具结果（模型拿到的是结构化输入而非下一轮 user 消息）。

**何时问**（SYSTEM_PROMPT 规范）：方案取舍、破坏性操作确认、意图实质歧义等影响后续大量工作的关键点；能合理自决的不问；一次一个问题、选项 2-4 个（label+description 说明取舍）。

## 2. 机制（完全镜像 permission 阻塞机制）

```
模型 emit ask_user 工具调用
  └ loop_runner::run_tool 按名拦截（门控内嵌口径，不走 pipeline 门控/执行）
     ├ 状态机 running→waiting_clarify（#6b）
     ├ SessionEvent::ClarifyRequest → bin bridge 映射 protocol ClarifyRequest（UNT）
     │   + BrtSink 路由表登记 question_id→session_id
     │   + WAL append("clarify.request")
     ├ 阻塞等待 clarify_rx：loop { recv_timeout(1s) + 查中断旗标 }   ← 唯一差异点：
     │   **不超时**（permission 是 120s=拒绝；clarify 一直等，用户「停止」
     │   置位中断旗标 → cancelled 收口，工具结果=Blocked「用户已中断本轮」）
     ├ 收到 ClarifyAnswer → 状态机 #7b 回 running + WAL clarify.resolved
     └ 工具结果 Ok{summary:"用户回答：{answers}；补充：{free_text}"} ← 模型下一轮可见
```

| 对比项 | permission.request | clarify.request |
|---|---|---|
| 触发 | 门控 NeedConfirm（任意工具） | ask_user 工具显式调用 |
| 超时 | 120s=拒绝 | **无超时**（可中断） |
| 回执 | decision allow/deny + scope | answers[] + freeText |
| 会话态 | waiting_permission | waiting_clarify |
| 路由 | request_id→session（BrtSink.pending） | question_id→session（同表） |

**崩溃恢复**：WAL 重放识别 clarify.request/resolved（recovery.rs）；未决提问与审批同口径作废（不重挂提问卡，会话按 interrupted 收口）。

## 3. 协议（bbrt-protocol envelope.rs）

- UNT `clarify.request`：`{questionId, question, header?, options:[{label, description?}], multiSelect}`——camelCase wire；无 expiresAt（不超时）
- REQ `clarify.response`：`{questionId, answers:[label...], freeText?}`——**键必须 camelCase**（snake 键会被会话循环按超时/拒绝口径收口，2026-11-11 审批排查实证）
- SessionState 增 `waiting_clarify`（协议枚举有意无 non_exhaustive——一处加，编译期逼出全部同步点）
- golden 契约：`golden_clarify_request_and_response`（wire 锁定）+ 状态名表含 waiting_clarify

## 4. 各层改动

| 层 | 改动 | 位置 |
|---|---|---|
| 协议 | 两消息变体 + ClarifyOption + WaitingClarify | bbrt-protocol/src/envelope.rs |
| 状态机 | request_clarify(#6b)/clarify_resolved(#7b) | bbrt-session/src/state.rs |
| 会话循环 | clarify_tx/rx channel + run_ask_user 拦截（1s 轮询可中断等待）+ SYSTEM_PROMPT 提问规范 | bbrt-session/src/loop_runner.rs |
| 路由 | manager.respond_clarify + bin bridge 路由登记/映射 + main.rs dispatch arm | manager.rs / bbrt/src/bridge.rs / main.rs |
| 恢复 | WAL recognize + 未决作废 + 中断 turn 收口含 waiting_clarify | recovery.rs |
| 工具 | ask_user_def（Low/ReadOnly，**不进 WORKSPACE_BOUND_TOOLS**——日常会话也可问；无执行体，loop_runner 拦截） | bbrt-tools/src/builtin/ask_user.rs |
| 壳 | agent_clarify_respond 命令（camelCase fire） | src-tauri/src/agent_commands.rs |
| 前端事件 | clarifyRequest/clarifyResponse 事件 + normalizeEvent 两 case + respondClarify 桥 | bridge/types.ts + bridge/tauri.ts |
| 前端 store | StreamItem kind:'clarify'（answer null/answered/cancelled）+ 入流+系统通知（无超时 timer）+ respondClarify 全流扫描 + selectPendingClarifies + composer waiting_clarify 禁用 | store/agent.ts |
| 三端 UI | ①工作台流内 ClarifyCard（TurnBubble case+未决强制展开）②聊天页 EmbeddedAgentSync 第二 Modal（与审批并列，clarify 优先）③落流卡内嵌提问条（快捷单选；多选/补充走弹框）——ClarifyForm 三端共用 | components/ClarifyCard.tsx 等 |
| mock | 第 3 轮剧本（提问→waiting_clarify→作答→按答案收尾）+ interrupt/emergencyStop 未决作废 | bridge/mock.ts |

## 5. 边界与口径

- **不超时**：与审批 120s 的差异是本质的——问题是给用户看的，用户可能不在场；「停止」是唯一收口路径（收口后 agent 收到 Blocked「用户已中断本轮」，轮次 interrupted 收 idle 可继续追问）。
- **mid-turn 状态事件不发**：与 permission 同口径——waiting_clarify 状态迁移不单独发 session.state 事件（回合级才报）；三端 UI 由流内 clarify 条目驱动（同审批条目驱动模式）。会话列表状态点/输入框禁用兜底由 running 态覆盖。
- **stagesFromStream 不进卡**：clarify 条目不投影为落流卡 stages 步骤（同 permission 口径），提问卡是覆盖层交互件。
- **答案进工具结果**：模型拿到的是 tool 消息（"用户回答：方案A；补充：…"），不是 user 轮——多轮追问=再次调用 ask_user。
- **「其他」自由输入**：UI 常规选项外提供补充输入框（ZCode Other 同款）；answers 至少一项或 freeText 非空才可提交。
- 日常会话（无工作目录）可用 ask_user（不设工作区墙）。

## 6. 测试与验证（全绿）

- bbrt-protocol：golden 双契约 + 状态名表 + 全类型 roundtrip（29 过）
- bbrt-session：状态机 #6b/#7b 合法/非法（36 过）+ loop 三件套——回答继续（回答注入工具结果）/中断 cancelled（report.interrupted）/坏参数 9001 不发卡（26 过）
- bbrt-tools：ask_user 注册与 required 契约断言（42 过）
- 全 workspace：52 套全绿
- 端到端冒烟：`examples/clarify_smoke.rs` + 假网关（ask_user tool_call SSE）→ 真 bbrt 全链——clarify.request 壳侧 emit 可达 + 回答注入工具结果 + 回合收口 idle（PASS）
- 前端：tsc + vite build ✓；真机验收待用户（三端触发提问卡/点选继续/停止中断/系统通知）

## 7. 开放问题

- mid-turn 状态事件（waiting_permission/waiting_clarify 单独上报 session.state）——现口径不发；若要列表状态点实时翻转需 permission/clarify 一起补（登记，随用随做）。
- 群聊接收者视角：他人会话里的落流卡提问条仅发起者本人可答（答题=与自己 agent 交互），接收者静态查看——与审批条同口径。
