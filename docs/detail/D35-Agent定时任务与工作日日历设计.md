# D35 Agent 定时任务与工作日日历（纯本地调度）

- 日期：2026-11-19 ｜ 状态：**批0-4 编码完成（程序侧验证全绿：go test / cargo test --workspace / tsc / vite build），剩 §8 真机验收（归用户）**
- 上游：[D08](D08-Agent工作台模块详细设计.md)（本地优先执行 P0-2）· [D11](D11-AgentRuntime内部详细设计.md)（stdio 协议/状态机）· [D32](D32-Agent安全模式重构设计.md)（权限矩阵/三档模式）· [D33](D33-工作台Agent消息流渲染设计.md)（内嵌审批卡）· [D10](D10-管理后台模块详细设计.md)（管理台壳）· [12 篇](../12-管理后台设计.md) · [14 篇](../14-通信协议设计.md)
- 动机（用户 2026-11-19 需求原话归纳）：当前系统没有定时任务；要支持 cron 周期与一次性（执行后停用）、只在工作日执行（工作日日历由管理员统一维护，含工作日/节假日/周末）、内网无外网时的日历 JSON 导入、管理员页面展示今年 12 个月日历；到点执行的是**用户自己本地 Agent 的任务**。

## 1. 拍板点（勿重提）

| # | 决策 | 内容 |
|---|------|------|
| 1 | **纯本地调度** | 任务存储/调度/执行/历史全在 Tauri 壳（`{appData}/agent-runtime/schedules/`）；服务端**不存任务、不调度、不推送触发**。用户原话：「不用跟服务端交互什么呀，完全可以本地保留自己的定时任务」。唯一服务端交互=只读拉取管理员维护的日历并缓存 |
| 2 | **三种调度类型互斥** | `cron`（5 字段）/ `once`（执行后自动停用）/ `workday`（每个工作日 HH:mm）。**没有通用“非工作日跳过/顺延”逻辑**——是否命中非工作日完全由类型决定 |
| 3 | **错过补偿** | cron/workday 到点未执行（应用关闭/睡眠错过）→ 记 `missed` 跳过；once → 宽限 24h 内下次启动补跑一次，超期置 `expired` 停用 |
| 4 | **权限=任务级三档模式** | 复用现有 `ask`/`auto-edit`/`full-auto`（full-auto 即「完全控制」，适合固定确定任务，创建时二次确认）。**不做壳层白名单自动放行/拒绝**；需要审批时 Run 停在会话里，用户在会话内用 D33 内嵌审批卡批准 |
| 5 | **clarify（ask_user）硬禁用** | 不能只靠提示词。`session.start` 新增 `unattended:true`；runtime 三层保障=工具面移除 + 调用分支防御 + SYSTEM_PROMPT 约束；子 agent/专家工具面同步过滤 |
| 6 | **日历=租户级、默认规则+例外覆盖** | 默认周一~五工作日/六日周末；表内只存例外（节假日/调休上班/手工改的周末）。内网**不调任何外网接口**，只做 JSON 导入；管理页 `/admin/calendar` 展示今年 12 个月 |
| 7 | **应用必须运行** | 关窗退出即不跑（当前壳无托盘/开机自启，另立项）；最小化照跑。当前壳无单实例保护，调度引擎需文件锁防双开重复触发 |

## 2. 架构与进程边界

```
┌─ Tauri 壳（Rust） ───────────────────────────────────────────┐
│ schedule 模块                                                │
│  ├─ 本地存储 {appData}/agent-runtime/schedules/              │
│  │   tasks.json / runs.jsonl / calendar-<year>.json          │
│  ├─ 调度线程（condvar + 最长 60s 醒一次）                     │
│  │   到点 → AgentHost.start_session(unattended=true, ...)    │
│  │        → user.message(prompt)                             │
│  ├─ 事件泵旁路：跟踪定时会话状态（running/waiting_permission  │
│  │   /idle/error/ended）→ 更新本地 run 记录 + emit 前端事件    │
│  └─ 日历同步：reqwest 带宿主 token GET /api/v1/workday-calendar│
│                → 缓存本地，离线用缓存                          │
└───────────────▲──────────────────────────────────────────────┘
                │ agent://event（现有）+ schedule://event（新增）
┌───────────────┴──────────────┐       ┌──────────────────────────┐
│ WebView（React）              │       │ 服务端 bbc-server          │
│  定时任务页 / 审批跳转 / 通知   │       │  workday 日历域（仅此）     │
└──────────────────────────────┘       └──────────────────────────┘
```

服务端不执行用户代码（D08 P0-2 不破）：到点由本地 Runtime 执行，日历只是配置数据。

## 3. 本地数据模型

### 3.1 `tasks.json`

```jsonc
{
  "version": 1,
  "tasks": [{
    "id": "sct-<uuid>",
    "name": "每日待办整理",
    "prompt": "把今天的待办整理成清单……",     // 非空
    "workspace": "",                          // ""=日常对话；非空=项目目录
    "schedule": { "type": "workday", "time": "09:00" },
    // cron: {"type":"cron","expr":"0 9 * * 1-5"}
    // once: {"type":"once","at":1763600000000}   // epoch ms（本地时区展示）
    "modelPolicy": "auto",                    // auto|fast|strong
    "model": null,                            // 直达引用 p:<provider_id>:<model>
    "mode": "ask",                            // ask|auto-edit|full-auto
    "approvalTimeoutSecs": 1800,              // 0=不超时
    "status": "active",                       // active|paused|completed|expired
    "nextRunAt": 1763600000000,               // epoch ms；null=不再触发
    "lastRunAt": null,
    "createdAt": 1763500000000,
    "updatedAt": 1763500000000
  }]
}
```

### 3.2 `runs.jsonl`

每行一条，追加写；加载时按 task 保留最近 50 条，文件超 5000 行时重写压缩。

```jsonc
{ "id":"scr-<uuid>", "taskId":"sct-...", "plannedAt":..., "startedAt":...,
  "finishedAt":..., "status":"success|failed|missed|expired|waiting_approval",
  "sessionId":"sess-...", "error":null, "summary":null }
```

### 3.3 `calendar-<year>.json`

```jsonc
{ "year": 2026, "fetchedAt": 1763500000000,
  "days": [{ "date":"2026-10-01", "type":"holiday", "name":"国庆节" }] }
```

`days` 为服务端合并默认规则后的全量结果（365/366 条），客户端直接按日查表。

### 3.4 单实例锁

`schedules/.scheduler-lock/`：**原子目录 + 心跳文件**（`fs::create_dir` 原子抢占；心跳每 ≤60s 更新，>180s 视为陈旧可清理）。**不引第三方依赖**（原设想的 fs2 方案作废）。抢锁失败=本实例不启动调度线程（任务仍由另一实例执行），任务页显示「本机已有另一个实例在运行定时调度」。进程退出锁目录随 Drop 清理。

## 4. 调度引擎

### 4.1 cron 解析

自研 5 字段（分 时 日 月 周）最小解析器（不引第三方库）：
- 支持 `*`、`n`、`a-b`、`*/n`、`a-b/n`、逗号列表；周 0/7=周日
- 匹配语义：分/时/月/周按集合匹配；日与周同时受限时取 OR（cron 惯例）
- 非法表达式在创建时拒绝（前端 + 壳双校验），不允许保存

### 4.2 下次触发计算

| 类型 | next_run_at |
|---|---|
| cron | 从候选时刻（含秒=0）逐分钟前进，取第一个匹配且 > now 的时刻；最多向前搜索 366 天 |
| once | 固定 `at`（一次性） |
| workday | 从当前日期起逐日找“日历为工作日”的日期，取该日 HH:mm，> now；最多搜索 400 天 |

日历缺失/未同步：按默认规则（周一~五）计算，任务页显示黄条「日历未同步，按默认规则」。

### 4.3 主循环

1. 启动即做**补跑扫描**（见 §4.4），再进入循环
2. `next_wake = min(所有 active 任务的 next_run_at, now+60s)`
3. 醒来遍历到期任务：
   - `workday` 且当天非工作日 → 记 `missed`（原因 non_workday），推进 next_run_at
   - once 且 `now - at > 24h` → 置 `expired`，记 `expired`
   - 执行前置检查：Runtime 就绪 + token 有效；失败记 `failed`，不自动重试
   - 起会话：`title="[定时] {name}"`，mode=任务模式，unattended=true，approvalTimeoutSecs=任务配置
   - `user.message`：prompt 前加一行 `【定时任务·无人值守】`（双保险；系统提示词另加）
   - run 记 `running`，写 `sessionId`
4. 任务增删改/启停/日历更新 → 重算并唤醒线程

### 4.4 补跑扫描（启动时）

- `cron`/`workday`：`next_run_at < now` → 记一条 `missed`，按类型推进到下一个未来时刻
- `once`：`now - at <= 24h` → 立即补跑；`> 24h` → `expired`
- 应用运行中系统睡眠：线程唤醒后同样按上述规则处理（超过 60s 的迟到按 missed 记）

### 4.5 运行状态跟踪

壳在事件泵旁路监听定时会话（`sessionId → runId` 映射）：
- `session.state=running` → run `running`
- `session.state=waiting_permission` → run `waiting_approval`，emit `schedule://event {kind:"approval_waiting"}`
- `session.state=idle`（曾 running）→ run `success`，emit `run_finished`
- `session.state=error/ended` 或 `session.ended` → `failed`（带 summary）
- 等待期间应用重启：`recovery.rs` 既有口径未决 permission 作废，run 记 `failed`；任务页提供「立即执行」重跑

## 5. 权限与无人值守

### 5.1 三档模式（任务级选，复用 D32）

| 模式 | 定时执行行为 | 适用 |
|---|---|---|
| `ask` 按需审批 | 每个受控工具发 `permission.request`，Run 停在 `waiting_permission` | 每步过目 |
| `auto-edit` 自动编辑 | 文件改动/常规命令自动执行；高危等审批 | 半自动任务 |
| `full-auto` 完全控制 | 全部自动执行，不弹审批 | 固定确定任务；创建时二次确认+警示 |

### 5.2 审批链路（审批 UI 零新增）

1. Runtime 发 `permission.request`（现有）→ 壳事件泵转 `agent://event` → 会话工具卡内嵌 `PermissionControls`（D33 已有）
2. 触达入口三件：
   - 本地系统通知「定时任务『名称』等待审批」（tauri-plugin-notification；审批类建议不受免打扰静默）
   - 定时任务页 run 状态「等待审批」+「去审批」→ 打开对应会话并定位待审批工具卡
   - 会话列表该项显示待审批徽标
3. 等待窗口=`approvalTimeoutSecs`（默认 1800；0=不超时，需配合「取消运行」）；超时走现有拒绝语义（8002）

### 5.3 clarify 硬禁用（三层）

1. **工具面**：`unattended=true` 时组装工具剔除 `ask_user`（`loop_runner.rs` 组装处过滤；注意 `pick_tools` 的“全量回退”兜底，disabled 场景不得回退）
2. **调用防御**：`loop_runner.rs` 的 `ask_user` 特殊分支在 unattended 下直接返回 `Blocked`（“无人值守执行不支持提问，请按最合理默认继续”）
3. **系统提示词**：unattended 会话追加「本次为定时/无人值守执行：不能向用户提问；不确定时按最合理默认继续，并在结论中说明假设」
4. 子 agent（`ProbeCtx`）/专家（`ExpertCtx`）增加 `unattended` 并同步过滤工具面；防止子上下文提问挂死

### 5.4 协议变更（唯一动 Runtime 的点）

```jsonc
// HostToRuntime::SessionStart 追加（serde default 兼容旧宿主/旧 golden）
{ "unattended": true, "approvalTimeoutSecs": 1800 }
```

| 层 | 改动 |
|---|---|
| `bbrt-protocol` | `SessionStart { unattended: bool(default), approval_timeout_secs: Option<u64> }` |
| `bbrt-hostapi` | 无新消息类型；`KNOWN_HOST_TYPES` 不变 |
| `bbrt` main | `StartParams` 透传 → `SessionRunner` |
| `bbrt-session` | runner 增 `unattended: bool`；`permission_timeout` 按会话覆盖；工具面过滤；SYSTEM_PROMPT 追加；子 agent/专家透传 |
| Tauri 壳 | `start_session` 增两参数并写入 payload |

`approvalTimeoutSecs=0` 内部用极大 Duration（`recv_timeout` 不支持无限）；普通会话默认 120s 不变。

## 6. 服务端日历域

### 6.1 表（迁移 `0004_workday_calendar.sql`）

```sql
-- 仅存“默认规则之外”的日期（节假日/调休上班/手工改的周末）；
-- 默认规则=周一~五工作日、六日周末，读取时合并。
CREATE TABLE IF NOT EXISTS public.workday_calendar (
    tenant_id  bigint      NOT NULL,
    day        date        NOT NULL,
    day_type   smallint    NOT NULL,              -- 1=工作日(含调休) 2=周末 3=节假日
    name       text        NOT NULL DEFAULT '',   -- 节假日名/调休说明
    source     text        NOT NULL DEFAULT 'manual', -- default|manual|import
    updated_by bigint      NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, day)
);
```

### 6.2 接口

| 方法/路径 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/workday-calendar?year=2026` | 登录 | 合并默认规则返回全年 365/366 天（客户端同步用） |
| `GET /api/v1/admin/workday-calendar?year=2026` | `admin:calendar:manage` | 同上（管理页用，含 source 区分默认/已设置） |
| `PUT /api/v1/admin/workday-calendar/days` | 同上 | 批量 upsert 例外 `{days:[{date,type,name}]}`（≤366） |
| `POST /api/v1/admin/workday-calendar/reset` | 同上 | 恢复默认 `{dates:[...]}`（删例外；空体=整年） |
| `POST /api/v1/admin/workday-calendar/import` | 同上 | `{year,mode:"merge"|"replace",days,...}`；`dryRun:true` 返回差异预览 |
| `GET /api/v1/admin/workday-calendar/export?year=2026` | 同上 | 导出全年合并 JSON（附件下载） |

导入校验：`version=1`、年份匹配、日期属所选年、类型枚举合法、无重复日期；`replace`=先清该年例外再写。

### 6.3 标准 JSON（导入/导出）

```jsonc
{ "version": 1, "year": 2026, "region": "CN",
  "days": [
    { "date": "2026-10-01", "type": "holiday",  "name": "国庆节" },
    { "date": "2026-10-10", "type": "workday",  "name": "调休上班" },
    { "date": "2026-11-21", "type": "weekend",  "name": "" }
  ] }
```

`type`: `workday|weekend|holiday`（wire 用英文；DB day_type 1/2/3）。省略日期=默认规则。

内网：服务端不调外网；`scripts/holiday-export.mjs`（Node 18+）在外网机取公开节假日 API → 生成上述 JSON → 带回内网在管理页导入。导入先 `dryRun` 预览差异（新增/变更/删除条数）再确认。

### 6.4 错误码（新开 9040–9049，先登记 14 篇）

| 码 | 语义 |
|---|---|
| 9040 | 日历参数非法（年份越界/日期不属于该年/重复日期） |
| 9041 | 日历导入格式非法（缺字段/枚举非法/version 不支持） |
| 9042 | 日历导入年份不匹配 |
| 9043 | 日历条目数超限（>366） |

### 6.5 审计

所有管理端写操作（upsert/reset/import）写 `admin_operation` + 审计事件（操作人/年份/变更条数/来源）；只读接口不写审计。

## 7. 页面

### 7.1 用户端：定时任务页（`/agent/schedules`）

- 入口：工作台左栏新增「定时任务」（或工作台头部入口；与「会话」并列）
- 列表列：名称 / 类型与时间 / 下次执行 / 上次结果 / 状态开关
- 新建/编辑抽屉：
  - 名称、提示词（多行）、工作目录（现有 workspace 选择器，空=日常）
  - 类型三选一：cron（输入框 + 预设：每天 9:00 / 每周一 9:30 / 每月 1 日 / 自定义）/ 一次性（日期时间选择）/ 每个工作日（时间选择）
  - 执行模式三选一（ask / auto-edit / full-auto）+ 说明文案；full-auto 二次确认
  - 审批等待：30 分钟 / 2 小时 / 不超时（默认 30 分钟）
  - 模型（档位；可选直达引用）
- 运行历史：最近 50 条，状态色 + 耗时 + 「打开会话」；`waiting_approval` 显示「去审批」
- 日历状态条：已同步至 X / 未同步（默认规则）；「立即同步」按钮

### 7.2 管理端：工作日日历页（`/admin/calendar`）

- 挂 `AdminLayout` TABS（`CalendarDays` 图标）
- 年份切换（默认今年，允许前后 2 年）；**12 个月迷你日历网格**（每格 7 列，日号 + 三色底 + 节假日名）
- 图例：工作日（含调休）/ 周末 / 节假日；`source=default` 与已设置用浅色/深色区分
- 交互：点击日期弹小面板改类型+名称；**区间批量**（起止日期+类型，编辑后保存）；整月快捷设置；「恢复默认」
- 顶部：导入 / 导出 / 保存（批量编辑后保存）；导入走 dryRun 差异预览 → 确认
- 底部统计：今年工作日 X 天、周末 Y 天、节假日 Z 天

## 8. 批次与验证

| 批 | 内容 | 验证 |
|---|---|---|
| 0 | 本篇落稿 + 错误码/权限/索引登记 | ✅ 已落 |
| 1 | 服务端日历域（迁移 0004、internal/workday、路由、错误码、权限点）+ 管理页 12 月日历 + 导入导出 + 外网脚本 | ✅ `go test ./...` 全绿（workday 7 组用例） |
| 2 | 壳 schedule 域（store/engine/commands/单实例锁/日历同步）+ 定时任务页 + 审批触达 | ✅ `cargo test` 15 组；`tsc` 0 错；`vite build` 7.9s |
| 3 | Runtime unattended 协议 + ask_user 禁用 + 子 agent/专家过滤 | ✅ `cargo test --workspace` 全绿（新增 protocol roundtrip + 2 组 session 用例） |
| 4 | 全量自测 + 真机验收 | 程序侧 ✅；真机见下（归用户） |

**真机验收清单**
1. cron 任务每天 9:00 到点自动起会话并完成；一次性任务执行后自动停用
2. workday 任务：节假日不触发；调休周六触发；日历未同步时按默认规则并有提示
3. 三档模式：ask 停在工具卡等批准（通知/徽标/去审批跳转可用）；auto-edit 写文件自动、高危等批准；full-auto 全程不弹审批
4. clarify 不再出现：任务里诱导提问也不发 `clarify.request`（工具面已无 ask_user）
5. 错过补偿：关应用跨过 cron 时间→启动记 missed；一次性 24h 内启动补跑、超期 expired
6. 双开应用：只有一个实例在调度；关窗退出不跑，最小化照跑
7. 内网：管理页导入 JSON（先预览后确认）生效；客户端同步后按新日历执行
8. 等待审批中重启应用：run 记 failed，可「立即执行」重跑

## 9. 边界与遗留登记

- **应用关闭即不调度**：要常驻需补托盘 + 开机自启（独立小批次）
- **任务不跨设备同步**：本地方案的自然结果；P1 可加任务 JSON 导出/导入
- **时区**：workday 判定用设备本地时区；跨时区办公场景未覆盖
- **服务端无任务视图**：管理员只能看到日历，看不到用户任务（本地设计使然）
- **审批通知不受免打扰**：本版建议审批类通知绕过 DND，是否单开关待真机后定
- **cron 秒级不支持**：最小粒度=分钟（5 字段）

## 10. 实现落点（编码完成记录）

| 层 | 文件 |
|---|---|
| 服务端日历域 | `server/migrations/0004_workday_calendar.sql`、`server/internal/workday/{api,repo,service,module}.go`、`server/cmd/bbc-server/main.go`（用户只读 + admin 五路由）、`errors/codes.go` 9040-9043、`admin/api/perms.go` `admin:calendar:manage`、`admin` 域 `RecordAudit` 通用审计 |
| 管理页 | `client/src/features/admin/api/workday.ts`、`pages/CalendarPage.tsx`、`App.tsx` 路由、`AdminLayout` 页签 |
| 壳调度 | `client/src-tauri/src/schedule/{mod,cron,calendar}.rs`、`lib.rs` 装配 + 10 个 `schedule_*` 命令、`agent_bridge.rs` `start_session` 增参 + token/gateway getter |
| Runtime | `bbrt-protocol` SessionStart 两字段、`bbrt/src/main.rs` 透传、`bbrt-session` manager/runner（工具面过滤 + 分支防御 + SYSTEM_PROMPT + 权限窗口）、subagent/expert 上下文 `unattended` |
| 用户页 | `client/src/features/agent/bridge/schedule.ts`、`pages/SchedulesPage.tsx`、`AgentSubNav` 页签、`App.tsx` 路由 + 事件通知 + 登录后日历同步 |
| 运维脚本 | `scripts/holiday-export.mjs`（外网机取数 → 标准 JSON） |

**实现与设计的差异登记**：
1. 单实例锁改为原子目录 + 心跳（不引 fs2，见 §3.4）
2. 管理页批量从“拖选”改为“区间批量 + 整月快捷”（交互更稳，功能等价）
3. 新增启动时清理“上次进程遗留 running/waiting_approval run → failed”（§4.5 的重启口径落到实处）
4. workday 到点二次校验日历（防止 next_run_at 计算后管理员改了节假日）；日历同步成功后重算全部 workday 任务
5. 一次性时间创建时要求晚于当前（前端校验），避免建出来永不触发