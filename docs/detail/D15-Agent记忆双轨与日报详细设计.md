# D15 - Agent 记忆双轨与日报详细设计

> **D19 落地注记（2026-11-10）**：知识记忆已分级——用户级维持 {dataDir}/agent/memory/；项目级新增 {dataDir}/agent/memory/projects/<目录名-哈希>/ 分区（scope_key）。写入按类型路由：user 类→用户级，project/feedback/reference 类随会话工作目录落项目分区（日常回落用户级）；召回注入 [用户记忆]+[项目记忆] 两段；memory.list/delete 增 scope/workspacePath 参数、memory.saved 事件带 scope。本篇 §2.1「每用户一个扁平目录」口径由 D19 修订。


| 项 | 内容 |
|---|---|
| 文档版本 | v0.2（v0.1 基础上：W1 引导语落实、W2② 接线、W3 提炼落地、召回 Top-K 关键词档；用户需求"像 ZCode 一样自动保存记忆 + 日常总结（主动轨/被动轨），skill 进化不做"） |
| 上游 | [08-Agent总体](../08-AI-Agent总体设计.md) · [09-工具与安全](../09-AI-Agent工具与安全设计.md)（三级记忆=**权限授予**记忆，与本篇**知识记忆**正交） · [D11](D11-AgentRuntime内部详细设计.md)（数据目录/stdio 协议/事件镜像） · [D08](D08-Agent工作台模块详细设计.md)（UI 消费） |
| 范围界定 | 本篇只做**知识型长期记忆**与**活动日报**；09 篇三级记忆（工具授权 allow.json）不变；技能进化（skill evolution）明确**不做** |

---

## 1. 概念与边界

| 概念 | 定义 | 类比 |
|---|---|---|
| **主动轨（active track）** | 会话进行中，Agent 主动沉淀的**知识记忆**：用户偏好、项目事实、决策、教训 | ZCode 的 memory/*.md + MEMORY.md 索引 |
| **被动轨（passive track）** | 会话之外，由**活动日志确定性聚合**出的日报：今天开了几个会话、跑了什么工具、改了什么、错在哪 | ZCode 的会话日志 → 每日总结 |
| 权限三级记忆 | 09 §4.2 工具授权记忆（allow.json） | **不在本篇**，正交共存 |

双轨关系：主动轨是"语义层"（为什么/是什么），被动轨是"流水层"（做了什么/多久）；日报尾部引用当日新增记忆条目（`memory_saved` 计数 + 标题列表），形成交叉印证。

不做（登记防重提）：技能进化（用户拍板）；记忆跨设备云同步（阶段二随多端）；记忆编辑 UI 之外的服务端存储（本地文件唯一权威）。

## 2. 主动轨：知识记忆（bbrt-memory/knowledge）

### 2.1 存储布局（ZCode 式文件存储，SQLite 之外的第二类本地存储）

```
{dataDir}/agent/memory/
├─ MEMORY.md            # 索引：一行一条 `- [标题](文件名.md) — 钩子摘要`（启动时注入上下文）
└─ <slug>.md            # 单条记忆：frontmatter + 正文（一文件一事实）
```

单条格式（frontmatter 与正文均为 UTF-8，文件名 = slug.kebab）：

```markdown
---
name: <slug>
title: <一句话标题≤40字>
type: user | project | feedback | reference   # 用户偏好/项目事实/工作方式反馈/外部指针
created_at: 2026-11-06T23:20:00+08:00
updated_at: <同左>
session: <sess-id>            # 产生该记忆的会话
links: [<其他slug>]           # 关联记忆（可悬空，标记待补）
---

<事实正文；feedback/project 类型追加 **Why:** 与 **How to apply:** 两行>
```

硬性约束：单条正文 ≤4KB；总条数 ≤200，超限按 `updated_at` 最旧淘汰（LRU，淘汰前在日报记 `memory_evicted`）；`MEMORY.md` 与条目文件**同事务性写入**（先写条目再重写索引；崩溃恢复时以目录扫描重建索引，索引可重建故非权威）。

### 2.2 写入路径（谁在什么时候写）

| # | 路径 | 触发 | 实现 |
|---|---|---|---|
| W1 | 模型工具 `memory.save{title, type, body, links?}` | 系统提示携带正式记忆使用规范（何时记/四类怎么选/先查重再写/不记清单），引导模型在学到持久事实时调用（工具注册表登记，风险级=低，全档放行——只写本机记忆目录） | knowledge::save()；引导语在 loop_runner SYSTEM_PROMPT（v0.2 已落实） |
| W2 | 规则触发（免模型兜底） | ① 用户消息匹配"记住/以后/下次…"模式 → 即时提取候选（标题=首 40 字）② 同一工具同一错误连续 ≥2 次 → 自动记 feedback 教训（loop_runner 工具轮喂 ErrorTracker，v0.2 已接线） | heuristic 模块，可关（`memory.heuristic=off`；开关随配置系统接线，v0.1 恒开） |
| W3 | 会话结束提炼 | session.ended 时把会话转录（User/Assistant 文本轮，总量 ≤8K 字符）交 bbc-fast 提炼为 ≤3 条候选 JSON，逐条过 save（同题去重兜底）；失败/不可解析静默跳过，不阻塞收口 | loop_runner::distill_memories（v0.2 已落地；原"依赖压缩摘要"改为独立提炼调用） |

写入规则：**同题更新不重复**——新条目 title 与既有条目相似（slug 相等或 title 完全相等）→ 原地更新正文与 updated_at（保留 created_at），否则新增。删除仅经 UI（memory.delete），无 TTL 自动删。

### 2.3 召回注入（怎么被用）

- 注入点：D11 §2.3 assemble() 的"项目上下文"区块内拼 `[记忆]` 段（system 消息）。
- 分档（v0.2）：条目 ≤50 → `MEMORY.md` 全量（≤200 行，超限截断+提示；条数少时成本可忽略）；条目 >50 → **Top-K 关键词精排**（`recall_for(当前用户消息)`）：query 分词（CJK 2-gram + ASCII 整词）对条目评分（命中 title ×3、钩子行 ×1），按分降序取前 50 条（索引行格式 + 尾注）；全零分退化为 updated_at 新→旧取前 50（保注入面非空且偏新）。
- 向量档（阶段二）：关键词档的语义升级，待服务端真 embedding（bge-m3）接入后评估本地/云端取舍（开放问题 1）。
- 边界：记忆属**trusted** 内容（本机用户/Agent 写入）；引用时逐条带来源 session id。

### 2.4 协议增量（D11 §4 表追加，stdio JSONL）

| 方向 | type | 语义 | payload | ack |
|---|---|---|---|---|
| RT→宿主 | memory.saved | 记忆写入/更新 | sessionId, name, title, type, updated(bool) | UNT |
| RT→宿主 | memory.evicted | 记忆淘汰 | sessionId?, name, reason=capacity | UNT |
| 宿主→RT | memory.list | UI 列表查询 | — | REQ→{items:[{name,title,type,updated_at,hook}]} |
| 宿主→RT | memory.delete | UI 删除 | name | REQ→{ok} |

## 3. 被动轨：活动日报（bbrt-memory/digest）

### 3.1 活动日志（journal，先于日报的原始层）

复用 D11 §9.1 事件镜像思想，v0.1 在 bbrt-memory 内自持轻量 JSONL（`{dataDir}/agent/journal/YYYY-MM-DD.jsonl`，一行一事件，写前 append+flush），事件集（ActivityEvent，枚举可扩展）：

```
session.started {session, workspace, mode}
session.ended   {session, summary?, duration_ms}
tool.executed   {session, tool, ok, duration_ms, risk}
tool.blocked    {session, tool, code}            # 8020-8026 沙箱/门控拦截
file.changed    {session, path, kind:edit|create|delete}
checkpoint.created {session, reason}
delegate.launched / delegate.ended {session, backend, exit_code}
memory.saved    {session, title, type}
```

设计要点：**确定性聚合，不依赖 LLM**（弱网/离线可用）；单日文件按行流式读（内存 O(1)）；journal 保留 90 天（im_db_prune 同节奏清理）。D11 wal.rs（SQLite 事件镜像）落地后，journal 保留为"跨会话活动层"并与 WAL 同源双写（开放问题 2）。

### 3.2 日报生成

触发（三个，均幂等——同日重跑覆盖同名产物）：
1. `session.ended` 落地后异步重算当日；
2. Runtime 启动时回补：扫描 journal 目录，凡"有日志但无对应日报"的过去日期逐日补生成（覆盖崩溃漏算）；
3. 跨日定时器（本地午夜，进程活跃时）。

产物：`{dataDir}/agent/reports/YYYY-MM-DD.md`（人读）+ `YYYY-MM-DD.json`（UI 消费），内容（全部来自当日 journal 聚合）：

```markdown
# 2026-11-06 Agent 日报
- 会话 3 个（累计 2h14m）；工作区 baobao-chat、docs-site
- 工具调用 47 次：read_file×21 edit_file×9 run_command×8 …；被拦截 2 次（8021 危险命令 / 8024 链接逃逸）
- 文件变更 12：edit×9 create×3；检查点 4（pre-edit×3 manual×1）
- 委派 1 次（claude，exit 0）；失败教训 1 条
- 今日记忆 +3：「端口 8090 约定」「用户偏好先方案后落笔」「Gitee 远端」
## 会话明细
| 会话 | 工作区 | 时长 | 工具 | 结果 |
| … |
```

### 3.3 协议增量

| 方向 | type | 语义 | payload | ack |
|---|---|---|---|---|
| RT→宿主 | report.daily | 日报产出/更新 | date, path, stats{sessions,tools,blocked,files,memorySaved} | UNT |
| 宿主→RT | report.list | UI 日报列表 | {limit?} | REQ→{items:[{date, stats}]} |

## 4. 安全与隐私

| 面 | 约束 |
|---|---|
| 脱敏 | 写入 memory/journal 前复用 bbrt-sec masking（AK/SK/JWT/私钥打码）；记忆正文含密钥特征 → 拒写并提示 |
| 本地性 | 记忆/日报/journal 均不离开设备；不上服务端、不入审计上报明文（审计仅 metadata：条数与类型） |
| 注入面 | 记忆注入上下文时打 trusted 标；日报/记忆**不进**子 Agent 上下文（子 Agent 一次性，D14 裁决） |
| 可审计 | memory.delete/report 读取不产生网络行为；journal 哈希链随 D11 审计链统一（阶段二） |

## 5. crate 落点（agent workspace）

```
bbrt-memory/src/
├─ lib.rs          # 导出 + MemoryEngine 装配（knowledge + journal + digest）
├─ knowledge/
│  ├─ mod.rs       # save/list/delete/recall（§2.1-2.3 全逻辑）
│  ├─ store.rs     # 文件存储：frontmatter 解析/序列化、索引重建、LRU
│  └─ heuristic.rs # W2 规则触发（正则模式 + 连续错误计数）
├─ journal.rs      # ActivityEvent JSONL 追加/按日读（§3.1）
└─ digest.rs       # 日报聚合与回补（§3.2，md+json 双产物）
```

依赖：serde/serde_json（+ tmpdir 测试）；不依赖 SQLite（文件即权威）；被 bbrt-session 依赖（会话事件喂 journal；session.ended 触发日报）。

## 6. 测试要点（与实现同仓库落地）

| 类 | 用例 |
|---|---|
| 知识 | 增/查/删；同题更新不重复（created_at 保留）；LRU 淘汰+索引重建；正文含密钥特征拒写；recall 注入截断 |
| 启发 | "记住…"模式命中；连续同错 2 次→教训；开关关闭无副作用 |
| 日志 | 追加/读回；跨日文件切换；坏行容忍（跳过+计数） |
| 日报 | 聚合数字与 journal 一致；幂等重跑；启动回补漏日；空日不出产物 |
| 协议 | memory.saved/report.daily payload 序列化（**嵌套 struct 自带 rename_all=camelCase**——7698c52 教训） |

## 7. 开放问题

1. 记忆精排向量档与 pgvector 服务端检索的关系（本地优先 vs 云端备份）——关键词档 v0.2 已落，向量档阶段二。
2. journal 与 D11 SQLite 事件镜像（agent_event）双写合并时机。
3. 日报推送 IM（agent_card 消息"昨日 Agent 日报"）的开关与租户策略——用户明确"生态可不要"，暂只做本地+工作台展示。
4. 用户身份注入（会话级 system 区块携带账号/组织/角色）——协议增量涉及 D11 §4 表，待 D11 侧编辑收口后落（v0.2 已有设计，见阶段裁决记录）。
