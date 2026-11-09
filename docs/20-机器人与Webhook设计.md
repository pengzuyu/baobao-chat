# 20 - 机器人与 Webhook 设计

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1 |
| 上游文档 | [00-总体](00-产品总体设计说明书.md) · [03-身份与权限](03-身份认证与权限体系.md) · [04-IM](04-IM即时通讯设计.md) · [10-生态应用](10-生态应用接入与技能分发设计.md) · [14-协议](14-通信协议设计.md) |
| 本篇定位 | bot 域分册：Bot 身份模型、Incoming/Outgoing Webhook、机器人消息渲染（bot_card）、bot 管理台与安全合规 |
| 关联 detail | 管理台页面并入 [detail/D10](detail/D10-管理后台模块详细设计.md)；群内入口对齐 [detail/D03](detail/D03-IM模块详细设计.md) 群管理；PIM 样式对齐 D03 消息流 |

---

## 1. 概述

### 1.1 定位与动机

企业 IM 的标配能力是**系统与群的双向通道**：CI 构建结果、监控告警、OA 审批通知要能自动进群（系统 → 群）；群里的 @机器人 请求、审批结果要能推给外部系统（群 → 系统）。当前设计（00~18 篇）完全缺失该体系，本篇补齐 bot 域：

```
Incoming Webhook ──► 外部系统(CI/监控/OA/工单) ──► bot ──► 群消息(bot_card)
Outgoing 订阅    ──► 群事件(@bot/过滤词/审批/Agent任务) ──► bot ──► 外部系统回调 URL
@bot 唤醒        ──► 群成员 @bot ──► (阶段四)转发 webhook 或转 Agent 会话
```

服务形态：bot 域为 **message-svc 内的 bot 模块**（模块化单体，02 篇），不新增独立服务；Incoming 入口端点挂在 gateway 的 HTTPS 路由上（`/hook/*` 前缀）。

### 1.2 bot 与生态应用（10 篇）的关系

| 维度 | bot（本篇） | 生态应用 eco_app（10 篇） |
|---|---|---|
| 方向 | **系统 → 群** 的入口（外部系统把内容投进 IM） | **Agent → 系统** 的出口（Agent 经 connector 调外部系统工具） |
| 形态 | 特殊 user（user.type=bot）+ webhook 凭证 | AppManifest + 工具/技能包 + 服务端 connector |
| 消费者 | 群成员（人读消息） | Agent Runtime（机器调工具） |
| 凭证 | webhook token / HMAC secret（bot 侧） | KMS 凭证引用（服务端代持） |
| 关系 | **互补、可同注册**：同一个内部系统（如 OA）既登记 eco_app（给 Agent 提供 oa.* 工具），又创建同名 bot（把审批结果投进群）；管理台登记页提供"关联应用"字段互相链接 | |

### 1.3 范围与阶段

| 阶段 | 内容 |
|---|---|
| 本期（阶段三） | bot 身份与凭证、Incoming（HMAC 签名/限流/会话授权）、Outgoing（事件订阅/重试/死信）、bot_card 渲染、BOT-01 管理页、群设置入口、@bot 消息推 webhook（被动应答仅此一种） |
| 阶段四预留 | 互动卡片按钮回调、@bot 唤醒转 Agent 会话、bot 市场（§9） |
| 明确不做 | 跨租户 bot（禁止，§7.7）、bot 代替 Agent 执行任务（bot 不持有工具，纯消息通道） |

## 2. 角色与场景

### 2.1 角色与权限

| 角色 | 能力 | 依据 |
|---|---|---|
| 应用管理员 / 被授权开发者 | 创建/停用/删除 bot、查看与轮换 token、配置订阅、查看死信 | 权限点 `bot:manage`（默认授予应用管理员，可再授予开发者自定义角色） |
| 群主 / 群管理员 | 把 bot 安装进群、移除、审批安装申请 | 权限点 `bot:install`（群主默认持有，随群角色生效） |
| 普通成员 | @bot、查看 bot 消息与名片、举报 | 无需权限点 |
| 租户管理员 | bot 全局策略（全局限流、安装审批开关、是否允许公有外网回调） | admin:policy:manage |
| 外部系统 | 调 Incoming 端点发消息 / 作为 Outgoing 接收方验签 | webhook token + HMAC |

### 2.2 典型场景

```
S1 CI/监控告警进群（Incoming）：GitLab CI 流水线结束 → POST /hook/bot/{hook_id}（HMAC 签名）
   → bot "CI 助手" 在 #研发群 发 bot_card（构建结果/耗时/提交人）→ @失败时 at 责任人
S2 值班机器人（Incoming+Outgoing 组合）：排班系统每天 09:00 推值班表卡片进 #运维群；
   群成员 @值班bot "今天谁值班" → Outgoing(msg.created @bot) 推排班系统 → 系统回投答案卡片
S3 群消息推外部（Outgoing）：#客服群 订阅过滤词"投诉|退款" → 命中消息推工单系统创建工单
S4 审批结果外送（Outgoing）：租户审批工单办结 → admin.approval.updated 事件推 OA 回调
S5 Agent 任务完成通知（Outgoing）：委派编码任务完成 → agent 任务完成事件推需求系统更新状态
S6 互动卡片（阶段四预留）：卡片带 [通过][拒绝] 按钮 → 回调外部系统（协议见 §9.1）
```

## 3. 架构与信息结构

### 3.1 总体架构

```
┌─ 外部系统 ─────────────┐        ┌─ 外部系统（接收方）──────────────┐
│ CI / 监控 / OA / 排班  │        │ 工单 / 舆情 / 需求系统           │
└──────┬─────────────────┘        └─────────▲───────────────────────┘
       │ POST /hook/bot/{hook_id}           │ POST 回调 URL（带签名，重试 1/5/15min）
       │ + HMAC-SHA256 签名                  │
┌──────▼────────────────────────────────────┴──────────────────────────────┐
│ gateway(/hook 路由) ──► message-svc · bot 模块                            │
│   ├ Incoming: 验签/防重放 → 限流(30/min/bot) → 目标会话授权(3031)          │
│   │            → 敏感词(3005) → 以 bot 身份发消息(bot_card) → 审计         │
│   ├ Outgoing: 事件源(msg.created/@bot·审批结果·agent 任务完成) → 订阅匹配   │
│   │            → 投递队列(重试 1/5/15min) → 死信(bot_delivery_log)+告警    │
│   └ 凭证: webhook token(secret_hash, 轮换宽限, IP 白名单可选)              │
└──────┬────────────────────────────────────────────────────────────────────┘
       ▼ 复用 04 篇消息主干
conversation(群) ── conversation_member(role=bot 的 bot 成员) ── message(type=bot_card)
       ▲ 通知/告警                          审计 ──► audit-svc(15 篇哈希链)
       │ 管理告警(死信)                      管理 ──► admin-svc(BOT-01, D10)
```

### 3.2 Bot 身份模型（bot = 特殊 user）

| 设计点 | 约定 |
|---|---|
| 身份 | bot 是**特殊用户**：`user.type = bot`（03 篇 user 表扩展，见下方回填提示）；bot 的消息 sender 即该 user_id，复用 04 篇消息/成员/同步全链路 |
| 归属 | 归属租户（tenant_id）+ 可选挂靠部门（dept_id，用于通讯录分组展示与范围管理）；**禁止跨租户**（§7.7） |
| 通讯录 | bot 不占员工编号段（employee_no 用 `bot-` 前缀独立段）；不出现在组织树，出现在"机器人"独立通讯录页签（bot:manage 或全体可见，租户策略） |
| 登录态 | bot **永不登录**：无 password_hash/MFA/设备，auth 域对 type=bot 拒绝签发用户 token（1005 类语义） |
| 激进扩展最小化 | user 表仅加 `type` 一列 + `bot_profile` 外联（bot 专有属性全部放 bot 表，不污染 user 表） |

> **回填提示：03 篇 §8 user 表需新增 `type` 列（human/bot，默认 human）并补充"bot 用户禁止登录"约束——本文件不修改原文，需回填 [03-身份认证与权限体系](03-身份认证与权限体系.md) 与 [13-数据模型](13-数据模型与存储设计.md) §3.1。**

### 3.3 凭证模型（webhook token）

| 项 | 设计 |
|---|---|
| 独立凭证 | 每个 webhook 一对凭证：`hook_id`（URL 组成部分，随机不可枚举）+ `secret`（HMAC 密钥）；**与用户/Agent 凭证体系完全独立**，泄漏不波及账号 |
| 展示 | secret 仅创建与轮换时一次性明文展示（管理台复制），库中只存 `secret_hash`；列表页显示尾 4 位 |
| 轮换 | 管理台一键轮换：新 secret 立即生效，旧 secret 保留宽限期 24h（双 secret 并行验签），宽限期内收到旧签名成功也写审计告警提示切换 |
| IP 白名单 | 可选配置（CIDR 列表）；配置后来源 IP 不在名单 → 3030；适合出口 IP 稳定的内部系统 |
| 存储 | secret_hash 落 bot_webhook（bcrypt/argon2id 同 03 篇口令哈希口径）；secret 明文零留存（与 19 篇"密钥不出网关"同原则） |

### 3.4 页面结构

#### 3.4.1 BOT-01 机器人管理（管理台，D10 模块树新增"机器人"入口）

```
┌─ 机器人管理（bot:manage 显隐）──────────────────────────────────────────┐
│ [+ 创建机器人]  [全部 ▾] 搜索…                                          │
│ 名称          │ 归属   │ 状态   │ Incoming │ Outgoing │ 近7天投递 │ 操作  │
│ CI 助手       │ 研发部 │ ● 启用 │ 1 hook  │ 2 订阅   │ 1.2k     │ 管理   │
│ 值班 bot      │ 运维部 │ ● 启用 │ 1 hook  │ 1 订阅   │ 340      │ 管理   │
│ ── 管理抽屉 ── 基本信息 │ Webhook(token 查看/轮换/IP 白名单) │           │
│                事件订阅 │ 投递记录(含死信重放) │ 停用/启用/删除          │
└─────────────────────────────────────────────────────────────────────────┘
```

- 创建/停用/轮换/删除均走 12 篇二次验证 A 档；删除仅在该 bot 已移出全部会话后允许。
- "关联应用"字段：链接到 10 篇 eco_app（同注册关系，§1.2）。

#### 3.4.2 群设置-添加机器人入口（对齐 D03 群管理，不重复设计）

- 位置：群设置侧栏"群机器人"页签（成员列表下方），入口与"D03 群管理"既有信息架构并列一行。
- 行为：群主/群管理员点 [+ 添加] → 选择租户内启用 bot → 直接安装（`bot:install`）；租户开启"安装审批"开关时，任意成员可发起申请、**群主审批**（复用 04 篇 conv.apply 审批流语义，kind 扩展 bot）。
- 安装成功 = bot 以 `conversation_member.role=bot` 入会（§5）；bot **建议不计入**群人数上限（04 篇 3010 的 member_count 口径排除 role=bot，属回填 04 篇的口径修订）。

#### 3.4.3 PIM 消息流 bot_card 样式（一小节，不与 D03 重复）

```
┌──────────────────────────────────────────┐
│ 🤖BOT CI 助手 · 今天 14:32               │  ← BOT 徽标(名称前缀角标) + bot 专属头像底色
│ ┌─ 卡片标题: 流水线 #1284 失败 ──────────┐ │
│ │ 分支 feat/ai-gw  提交 zhangsan        │ │  bot_card body: {title, sections[], links[], level}
│ │ 耗时 3m12s  单测 42/43  ❌ 构建       │ │  level: info|warn|error(左边框色)
│ │ [查看构建日志 ↗]  [@张三]              │ │  链接仅渲染白名单域(§7.3)
│ └────────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

- **BOT 徽标**：所有 bot 消息（含 text/markdown 类型）名称前统一角标，与 04 篇 agent_card 的 Agent 标识视觉区分。
- **bot_card 类型**：04 篇 §1.2 消息类型全集**新增第 11 项** `bot_card`，body `{title, sections[], links[], at_user_ids[], level}`，渲染规则：标题加粗、sections 键值对列表、links 按钮跳转（外链走客户端安全浏览器确认）；纯文本降级渲染（旧客户端前向兼容，14 篇 §8 未知类型忽略+埋点）。
- @bot 消息在消息流内高亮 bot 名（复用 04 篇 @提及渲染，target uid 即 bot 的 user_id）。

## 4. 核心流程

### 4.1 bot 创建与安装

```
① 应用管理员 BOT-01 [+创建] → 填名称/头像/归属部门/描述(→ A 档二次验证)
② 系统创建 user(type=bot) + bot 记录 → 默认 status=disabled(未装凭证前不可用)
③ 创建 Incoming webhook → 生成 hook_id+secret(一次性展示) → 复制 URL 与签名说明(§6.3)
④ 群主在群设置安装 bot → conversation_member(role=bot) → 审计(install)
⑤ 管理台停用 → §4.5 即时失效语义
```

### 4.2 Incoming Webhook 投递（外部 → 群）

```
外部系统 ── POST /hook/bot/{hook_id} ──► gateway
  ① 定位 webhook(hook_id) + bot.status=active + webhook.status=active
  ② 验签: X-BBW-Signature = "sha256=" + HMAC-SHA256(secret, ts + "." + raw_body)
     · ts 超过 ±5min → 3030(防重放)；IP 白名单(若配)不匹配 → 3030
  ③ 限流: 令牌桶 默认 30 msg/min/bot(租户可配 10–120) → 超限 3032 + Retry-After
  ④ 目标授权: body.target.conv_id ∈ webhook.targets(授权会话集) 且 bot 仍是该会话成员
     → 否则 3031(投递目标未授权)
  ⑤ 内容安检: msg_type(text|markdown|bot_card) 校验 + 敏感词(04 篇同库, 命中 3005 拒投)
  ⑥ 发送: 以 bot 的 user_id 走 message 主干(04 篇 seq 分配/扇出/同步)
  ⑦ 审计: bot 维度记录(谁调的 hook、发到哪、digest) → 入口返回 {code:0, msg_id, seq}
失败响应即回即退: 3030/3031/3032/3005/9001(模板非法), 错误体含 trace_id(14 篇 §5.2)
```

### 4.3 Outgoing 事件订阅投递（群/系统事件 → 外部）

| 环节 | 设计 |
|---|---|
| 事件源（本期） | ① `msg.created`：指定群的全部消息或**过滤词命中**或**仅 @该 bot**（三选一模式）② 审批结果：12 篇审批工单办结（通过/拒绝/撤回）③ agent 任务完成：**`agent.task.completed`**——宿主上报 notify 域生成（14 篇 §3.3；委派/专家 run 终态，字段对齐 D16 agent_run 快照；原 17 篇 delegate_task 触发口径由本事件取代） |
| 订阅配置 | bot_webhook(direction=out) 的 `targets.event_types[]` + 源范围（conv_ids / 全租户审批 / 指定用户 Agent 任务）；事件订阅不存在（webhook 已删/停用）→ 投递记录 3033 |
| 投递协议 | HTTP POST 回调 URL，body 为事件信封 `{event, bot_id, ts, data}`；头 `X-BBW-Timestamp` + `X-BBW-Signature`（同 §4.2 算法，secret 为 out 方向独立 secret） |
| 重试 | 目标返回 非 2xx/超时(10s) → 重试队列按 **1min/5min/15min** 退避，共 4 次尝试 |
| 死信 | 4 次皆失败 → `bot_delivery_log.status=dead` → notify 服务向 bot 管理员（bot:manage 持有者）发**管理告警**（IM 卡片+管理台红点）；死信可人工重放（BOT-01 投递记录页） |
| 顺序 | 不保证事件顺序（按 webhook 并发投递）；信封带 `event_id`（幂等键），接收方按 event_id 去重（§6.3 文档说明） |

### 4.4 @bot 唤醒路由

```
群成员 @bot 发消息(04 篇 mentions 命中 bot user_id)
  ├─ 本期: 若该 bot 配置了 outgoing msg.created(@bot 模式)订阅 → 按事件推 webhook
  │        (S2 值班场景: 外部系统收到后回投 Incoming 卡片应答)
  ├─ 阶段四: bot 可配置"转 Agent 会话"(挂接 08 篇专家/技能, bot 充当群内 Agent 入口)
  └─ 未配置任何路由: 仅消息内高亮, 不触发任何投递(静默)
```

### 4.5 bot 停用即时失效（< 1s）

```
管理台停用/删除 ─► 写 DB(status) + Redis 失效标记 t:{tid}:bot:disabled:{bot_id}(无 TTL, 显式清除)
  ├─ Incoming 端点: 每请求先查失效标记(进程本地缓存 TTL ≤1s + Redis 兜底) → 命中 3030
  ├─ Outgoing 投递: 队列消费前复查 → 立即停止, 在途记录转 dead(原因=bot_disabled)
  ├─ 群内: WS 推送 bot.updated(§6.4) → 客户端名片缓存失效, 已发历史消息保留并显示"已停用"
  └─ 消息发送侧: bot 身份的消息写入路径同样复查(防绕过端点直写)
```

## 5. 数据模型

> **回填提示：本节 3 张新表（bot / bot_webhook / bot_delivery_log）+ user 表 type 列扩展，必须登记入 [13-数据模型与存储设计](13-数据模型与存储设计.md) §3（新增 §3.9 机器人域，并更新 §3.1 user 表）；conversation_member 增加 role=bot 枚举值（04 篇 §5 回填）。**

| 表 | 字段要点 | 说明 |
|---|---|---|
| bot | id, tenant_id, dept_id(可空), user_id(关联 user.type=bot, UK), name, avatar_file_id, description, owner_user_id(创建/负责开发者), linked_app_id(可空, 关联 eco_app), status(active/disabled), settings jsonb, created_by, created_at, updated_at | bot 主档；停用不改删（历史消息 sender 回链） |
| bot_webhook | id, tenant_id, bot_id, **direction(in/out)**, hook_id(UK, in 方向 URL 组成), callback_url(out 方向), **secret_hash**(现行), prev_secret_hash + prev_expire_at(轮换宽限), **targets jsonb**(in: 授权 conv_id 集合+默认会话; out: event_types+源范围+过滤词/@bot 模式), ip_allowlist jsonb(可空), rate_limit(默认 30/min), status(active/disabled), rotated_at, created_at | 一 bot 多 webhook（in/out 各多条）；删除=级联停投递 |
| bot_delivery_log（按月分区） | id, tenant_id, bot_id, webhook_id, event_id(UK, 幂等), event_type, payload_digest(不存正文, 同 19 篇口径), target_url, attempt(0–3), next_retry_at, status(pending/sent/dead), response_code, error_brief, created_at | Outgoing 投递记录/死信队列载体；Incoming 成功投递只记审计不占本表 |

Redis key（登记 13 篇 §5）：`t:{tid}:bot:disabled:{bot_id}`（停用标记）、`t:{tid}:bot:rl:{bot_id}`（限流桶）、`t:{tid}:bot:retryq`（Outgoing 重试队列，Redis Stream，消费 worker 在 bot 模块内）。

## 6. 接口设计

### 6.1 Incoming Webhook HTTP 协议（外部系统视角）

```
POST https://{host}/hook/bot/{hook_id}
Headers:
  Content-Type: application/json
  X-BBW-Timestamp: 1760000000            (unix 秒, ±5min 窗口)
  X-BBW-Signature: sha256=abcdef…        (HMAC-SHA256(secret, "{ts}.{raw_body}") hex)
Body(msg_type 三选一):
  { "msg_type": "text",     "target": {"conv_id": "…"}, "text": "构建完成" }
  { "msg_type": "markdown", "target": {…}, "md": "**标题**\n- 项1" }        (04 篇受限 Markdown)
  { "msg_type": "bot_card", "target": {…}, "card": {"title": "…", "sections": […],
      "links": […], "at_user_ids": ["u1"], "level": "error"} }
响应: { "code": 0, "data": { "msg_id": "…", "seq": 1301 }, "trace_id": "…" }
  · target.conv_id 必须在授权集内(§4.2-④)；省略 target = 发往 webhook 配置的默认会话
  · at_user_ids 上限 10 人；@全体需群策略允许(04 篇 3014 口径沿用)
```

### 6.2 管理 REST（`/api/v1/bots`，遵 14 篇 §5，用户 token）

| API | 说明 | 权限点 |
|---|---|---|
| POST /bots · GET /bots?status=&dept= · GET /bots/{id} | 创建（A 档验证）/列表/详情 | bot:manage（列表为全体可见的精简视图，见 3.2 通讯录） |
| PATCH /bots/{id} · POST /bots/{id}/disable · /enable · DELETE /bots/{id} | 改信息/停启用/删除（删除需先移出全部会话） | bot:manage + A 档 |
| POST /bots/{id}/webhooks · PATCH /webhooks/{wid} · POST /webhooks/{wid}/rotate | 创建/配置（targets、IP 白名单、限流）/轮换（一次性返回新 secret） | bot:manage + A 档 |
| GET /bots/{id}/deliveries?status=dead · POST /deliveries/{id}/replay | 死信查询/重放 | bot:manage |
| POST /convs/{id}/bots/{bot_id} · DELETE /convs/{id}/bots/{bot_id} | 安装/移出会话 | bot:install（群主/群管理员） |

### 6.3 Outgoing 接收方签名验证（交付给外部的文档说明）

```
接收方验签步骤（写入 webhook 配置页的"接入文档"抽屉，随 secret 一并提供）:
1) 取请求头 X-BBW-Timestamp(ts) 与原始请求体 raw_body
2) 计算 expect = HMAC-SHA256(secret, "{ts}.{raw_body}") 的 hex
3) 与 X-BBW-Signature("sha256=" 前缀剥离后) 恒时比较；不等 → 丢弃并记日志
4) |now − ts| > 5min → 丢弃(防重放)；event_id 幂等去重(重复投递是正常现象)
5) 响应 2xx 即确认；非 2xx 或 10s 超时将按 1/5/15min 重试, 4 次失败进入死信
secret 轮换流程: 管理员轮换 → 新旧双 secret 24h 并行 → 接收方在宽限期内切换验签密钥
  → 宽限期结束旧 secret 失效(宽限期内旧签名命中会告警提示尽快切换)
```

### 6.4 WS 事件（命名 `域.动作`，**需登记入 [14-协议](14-通信协议设计.md) §3**）

| type | 方向 | payload 摘要 | 说明 |
|---|---|---|---|
| bot.updated | S→C | `{bot_id, user_id, kind: disabled/enabled/profile_changed/installed/removed, conv_id?}` | 客户端失效 bot 名片/徽标缓存（§4.5 <1s 生效的端侧配合）；installed/removed 仅推会话成员 |

### 6.5 错误码（3xxx 段顺延，**需登记入 [14-协议](14-通信协议设计.md) §7**）

| code | 含义 | 触发 |
|---|---|---|
| 3030 | 无效 bot token / 签名（含时间戳越窗、IP 白名单不匹配、bot/webhook 已停用） | §4.2-①② |
| 3031 | 投递目标未授权（conv_id 不在授权集、bot 非该会话成员、目标会话已解散） | §4.2-④、Outgoing 侧目标失效 |
| 3032 | 频率超限（超过 bot 级或租户级限流，附 Retry-After） | §4.2-③、§7.4 |
| 3033 | 事件订阅不存在（webhook 删除/停用后仍有存量事件） | §4.3 |

与既有码边界：3005（敏感词拦截）、3007（IM 频率限制，人发消息口径）沿用；bot 通道专用 3032 与之区分，便于客户端与管理台差异化提示。

### 6.6 权限点（**需登记入 [03-身份与权限体系](03-身份认证与权限体系.md) §4.1 与 [12-管理后台](12-管理后台设计.md) 权限点字典**）

| 权限点 | 默认角色 | 说明 |
|---|---|---|
| `bot:manage` | 应用管理员 | bot 创建/停用/删除、webhook 与 token 管理、订阅配置、死信处置 |
| `bot:install` | 群主、群管理员（会话内生效，非全局角色） | 安装/移除会话机器人；租户开启审批开关时成员可申请、群主审批 |

## 7. 边界与安全

| # | 主题 | 设计 |
|---|---|---|
| 1 | 全动作审计 | 创建/停用/删除/轮换/安装/移除/订阅变更/死信重放全部入 audit-svc（15 篇哈希链，subject=操作者）；Incoming 每次成功投递记 bot 维度审计（调用方 IP、hook_id、conv_id、内容 digest 不存正文） |
| 2 | 敏感词 | bot 消息与人类消息**同一词库同一拦截路径**（04 篇 sensitive_word，命中 3005 拒投并告警 bot 管理员）；外部内容不因"机器发送"豁免 |
| 3 | 内容安全 | bot_card 模板服务端校验（字段白名单、sections ≤ 20 项、总长 ≤ 4000 字）；links 域名需租户白名单（管理台维护，防钓鱼外链）；markdown 渲染走 04 篇受限 Markdown（禁 script/iframe） |
| 4 | 防滥用/全局限流 | bot 级默认 30 msg/min（§4.2）之上叠加**租户级全局上限**（默认 600 msg/min/tenant，防止某 bot 凭证被盗后刷屏全租户）；超限 3032 并安全告警（15 篇告警通道） |
| 5 | 停用即失效 | §4.5 双层（端点+消息写入路径）复查，进程本地缓存 TTL ≤1s，实测目标 <1s；配合 bot.updated 推送端侧缓存失效 |
| 6 | 凭证与传输 | secret 仅哈希落库、一次性展示、24h 轮换宽限（§3.3）；全链路 TLS（15 篇）；/hook 入口独立限流与 WAF 规则（防爆破 hook_id） |
| 7 | 跨租户禁止 | bot 的 targets/回调配置强制校验同租户资源（conv_id、用户）；不提供任何跨租户 bot 形态（设计期明确禁止，非策略开关，§9.3） |
| 8 | 外发数据面 | Outgoing 事件体只含必要字段（审批：工单号/状态/发起人；消息：摘要+过滤词命中，**不含全文**，除非订阅模式显式选择全文且租户策略允许）；投递记录不存正文（payload_digest） |

## 8. 与其它模块依赖

| 模块 | 依赖内容 |
|---|---|
| 03 身份权限 | user.type=bot 扩展（回填）；bot:manage / bot:install 权限点登记；bot 用户禁止登录约束 |
| 04 IM | bot 复用消息主干（seq/扇出/同步）；bot_card 第 11 类消息类型（回填 §1.2）；conversation_member role=bot；敏感词同库；conv.apply 审批流复用（bot 安装审批） |
| 10 生态应用 | 同注册互链（linked_app_id）；接入文档风格与凭证代持原则对齐 |
| 08/17 Agent | agent 任务完成事件源（delegate_task 终态）；阶段四 @bot 转 Agent 会话 |
| 12 管理后台 | BOT-01 页面（D10 模块树登记）、二次验证、权限点字典登记、全局策略下发 |
| 13 数据模型 | 本篇 3 表 + user 表扩展登记（§5 回填提示）；Redis key 登记 |
| 14 协议 | bot.updated 事件登记 §3；3030–3033 错误码登记 §7 |
| 15 安全 | 审计入哈希链；告警通道（死信/限流暴增/旧签名命中）；/hook 入口加固 |
| 16 部署 | Outgoing 投递 worker 与重试队列容量；/hook 端点独立限流参数纳入网关配置 |

## 9. 开放问题

1. **互动卡片回调协议**（阶段四）：bot_card 按钮点击的回调语义（回调给外部系统 or 走 IM 事件通道双向）、按钮操作鉴权（点击人身份是否传递给外部系统）、防重放与幂等——需与 04 篇消息交互、15 篇外发数据面联合设计。
2. **bot 市场**：租户内官方 bot 模板库（CI/监控/值班预置模板，一键创建）是否做？与 10 篇技能市场、00 篇阶段四"技能市场"是否合并为同一分发设施？
3. **跨租户 bot 禁止**的例外压力：集团多子公司（同一平台多租户）是否需要"平台级官方 bot"（如全员公告 bot）？若需要，引入 platform: 前缀的受控例外还是坚持各租户独立部署同款 bot？
4. @bot 转 Agent 会话（阶段四）的权限边界：bot 在群内代表谁发起 Agent 会话（@者 OBO）？群内高敏策略（04 篇 08/09 篇预授权）如何联动？
5. Outgoing 大订阅量下的投递容量：单租户千级订阅 × 高频 msg.created 时，Redis Stream 扇出是否够用，是否需预研 NATS（02 篇开放问题 1 同源）。
