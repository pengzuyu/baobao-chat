# D36 Agent 用量与上下文显示设计（输入框状态条 + 桌面端上下文注册表）

- 日期：2026-11-19 ｜ 状态：**编码完成（tsc/vite build + cargo aigw/protocol/session/bbrt 测试全绿），剩真机验收**
- 前置：[D08](D08-Agent工作台模块详细设计.md)（PAG-03 输入区）、[D11](D11-AgentRuntime内部详细设计.md)（stream.done 用量）、[D33](D33-工作台Agent消息流渲染设计.md)（工作台三栏/平铺流）、[19-AI网关设计](../19-AI网关设计.md)（§6.2 usage 终帧）
- 动机（用户 2026-11-19 需求原话归纳）：把运行信息显示在输入框位置——**上下文消耗、占比、缓存命中率**；占比依赖模型最大上下文，上限知识要**放桌面端**（预设知名模型、用户填入时自动填充、支持自定义、K/M 智能单位），**不落服务端**；完全不知道上限时**不显示占比**，只显示已用多少与缓存命中率；重启后打开历史会话要能恢复上次用量。

## 1. 拍板点（勿重提）

| # | 决策 | 内容 |
|---|------|------|
| 1 | **上下文上限完全本地化** | 内置模型预设 + 本机覆盖都存在桌面端（`client/src/shared/utils/modelContext.ts` + agent store localStorage）；服务端**零改动**。未来新增/修正模型上限只需更新桌面应用（或用户本机覆盖），不进 `ai_provider.models`、不加服务端字段/接口 |
| 2 | 上限解析顺序 | 会话实际模型名（wire `usage.model`）→ 会话 `modelOverride` 的 `p:<provider>:<model>` → **本机覆盖**（精确→最长前缀）→ **内置预设**（精确→后缀单位 `-128k/-1m`→最长前缀）；仍解析不到=未知（不显示占比） |
| 3 | 单位与展示 | 统一 **K/M=1024**（128K=131072）；输入接受 `128K`/`1.5M`/`200000`（大小写/空格/逗号容忍）；显示 `128K`/`1M`/`200K`；已用量 `12.3K` |
| 4 | 用量语义 | `上下文`=最近一次 LLM 调用的 `prompt_tokens`（多步轮=最后一次调用，≈当前上下文）；占比=in/上限；缓存命中率=cached/in（上游未上报→`缓存 —`，不臆造 0%） |
| 5 | 缓存/模型名来源 | 只消费上游 SSE 已给字段（chunk `model`、usage `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens`），网关原样透传；Go 服务端不改 |
| 6 | 重启恢复 | WAL `assistant.done` 行增 cached/model；`session.history.result` 增可选 `lastUsage`（最后一条带 usage_in 的行）；前端打开会话即回填，无需等下一轮 |
| 7 | 显示位置 | 输入区底部左侧（权限模式旁）状态条；无用量时不渲染（不占位） |

## 2. 机制

### 2.1 桌面端上下文注册表
- `MODEL_CONTEXT_PRESETS`：常见模型（OpenAI gpt-4.x/gpt-4o/o 系、Anthropic claude、DeepSeek、智谱 glm-4.x、通义 qwen、Kimi/Moonshot、Gemini、Llama、Mistral、Grok）+ 后缀单位识别；匹配时去 `provider/` 前缀、小写、最长前缀优先（覆盖 `gpt-4o-2024-08-06` 这类快照名）。
- 本机覆盖：设置 · Agent →「模型上下文上限（本地）」卡片（模型 ID + 上限行；输入模型 ID 时按预设自动填充；空值=回退预设）；存 localStorage `bbc:agent:model-context`，**不上传服务端**。
- 解析工具：`presetContextWindow` / `resolveContextWindow(modelId, overrides)` / `parseTokenSize` / `formatTokenSize` / `formatTokensUsed`。

### 2.2 运行态数据链（Rust/协议；Go 不改）
1. `bbrt-aigw` SSE 解析：捕获每个 chunk 顶层 `model`；usage 帧解析 `prompt_tokens_details.cached_tokens` 与 `prompt_cache_hit_tokens`；兼容网关 usage 终帧的**顶层** `prompt_tokens/completion_tokens`（上游不回 usage 时网关估算兜底；不覆盖已捕获的 cached/model）。
2. `StreamEvent::Done` 增 `model`；`Usage` 增 `cached_tokens: Option<usize>`（None=未知）。
3. 协议 `Usage` 增可选 `cached_tokens`/`model`（`in`/`out` 不变）；`stream.done.usage` 原样携带。
4. Runtime `loop_runner`：最后一次 Done 的 cached/model 随 `stream.done` 外发；`assistant.done` WAL 行补 `cached_tokens`/`model`（旧行缺省=未知）。
5. `session.history.result` 增可选 `lastUsage`（`wal_last_usage` 倒序取最后一条带 `usage_in` 的 assistant.done）；壳命令透传，前端 `loadHistory` 返回 `{items, usage?}` 并回填 `usageBySession`。
6. 前端 `TurnUsage {in, out, cached?, model?}`；`normalizeEvent` 映射上方/历史两处。

### 2.3 输入框状态条（`ContextUsageMeter`）
- 上限可知：`上下文 12.3K / 128K · 10% · 缓存 76%`（≥80% 警告色 / ≥95% 错误色）
- 上限未知：`上下文 12.3K · 缓存 76%`（**无占比**）
- 缓存未知：`缓存 —`
- tooltip：精确 token 数、上限来源（本机覆盖/内置预设）+模型名、缓存命中 tokens；无上限时提示去设置页补充。
- 注入方式：`Composer` 新增 `statusInfo` 插槽，页面传 `<ContextUsageMeter usage={usageBySession[active]} modelHint={modelOverride} />`。

## 3. 涉及文件

- 前端：`client/src/shared/utils/modelContext.ts`（新）、`features/agent/components/ContextUsageMeter.tsx`（新）、`features/agent/components/Composer.tsx`、`features/agent/pages/AgentWorkbenchPage.tsx`、`features/agent/store/agent.ts`、`features/agent/bridge/{types,tauri,mock}.ts`、`features/settings/components/ModelContextCard.tsx`（新）、`features/settings/pages/AgentSettingsPage.tsx`
- Rust：`agent/crates/bbrt-aigw/src/{types,sse,merge}.rs`、`bbrt-protocol/src/envelope.rs`、`bbrt-session/src/{events,loop_runner,recovery}.rs`、`bbrt/src/{bridge,main}.rs`
- 服务端 Go：**无改动**

## 4. 验收清单（归用户真机）

| # | 项 | 口径 |
|---|---|---|
| 1 | 直选模型 | 选具体模型（如 glm-4.6）对话一轮 → 状态条出现 `上下文 … / 128K · % · 缓存 …` |
| 2 | 档位路由 | 走快/强档位（网关路由到上游具体模型）→ 上游实际 model 被预设命中，占比同样显示 |
| 3 | 本机覆盖 | 设置页把某模型覆盖为 1M → 占比按 1M 变；删除覆盖回到预设；刷新/重启保持 |
| 4 | 未知模型 | 选一个预设未收录、也没覆盖的模型 → 只显示已用量与缓存，不显示占比与上限 |
| 5 | 缓存 | 上游上报缓存命中 → 百分比；未上报 → `缓存 —` |
| 6 | 单位 | 设置页输入 `1.5M`/`128K`/`200000` 往返显示正常；非法输入红框且不落库 |
| 7 | 重启恢复 | 重启 App 打开历史会话 → 状态条立即显示上次用量（含缓存/模型） |
| 8 | 无回归 | 输入/审批/停止/子 agent 内容坞等既有行为不变 |

## 5. 已知边界

- 上游不回 usage 时，网关终帧的 prompt_tokens 是**字符估算**（Go 侧 `estimateTokens`），占比只是近似值；状态条不区分「精确/估算」（v0.1 从简，如需标注再加 estimated 标记）。
- 快照/私有部署别名若不在预设，用户本机覆盖一次即可（精确或前缀匹配）。
- 子 agent 的模型调用不计入状态条（只反映主会话最后一次 `stream.done`）。