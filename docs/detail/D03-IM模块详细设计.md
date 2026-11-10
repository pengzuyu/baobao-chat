# D03 - IM 模块详细设计（消息 · 会话 · 群聊 · 搜索 · 通知）

> **⚠ 2026-11 瘦身二阶段注记**：音视频通话（rtc/LiveKit）、会议（meeting）域与文件分享外链（/s/{code}）已移除——本文涉及 rtc.*/meeting.*/call_card/通话卡片/会议/分享外链的章节已作废，错误码 4010-4012 与 5xxx 段废弃不复用。删除前快照：git 分支 `backup/full-suite-20261109`。

> **⚠ 2026-11 瘦身注记**：文档中心（doc）与 Webhook 机器人（bot）域已移除——本文涉及 doc/bot 的章节（功能项、表结构、事件、错误码、部署组件等）已作废，以代码现状与 14 篇协议注册表的"已废弃"标记为准。生态应用/技能（eco）保留（Agent 运行时供给通道）。删除前快照：git 分支 `backup/full-suite-20261109`。

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（详细设计阶段） |
| 上游 | [04-IM 概要](../04-IM即时通讯设计.md)（一切口径以此为准） · [14-协议](../14-通信协议设计.md) · [D01 客户端总体](D01-客户端总体详细设计.md) · [D02 服务端](D02-服务端模块划分与工程结构.md) |
| 下游 | D04（通话卡片）· D05/D06（文档/文件卡片）· D08（Agent 卡片）· D10（敏感词/策略下发） |
| 本篇范围 | 04 篇全部页面/交互/接口/模型的**字段级细化**；不重复协议框架（14 篇）与设计系统（D01） |

---

## 1. 概述与范围

### 1.1 定位与基线

IM 是第一入口：单聊/群聊/广播群为消息主干，文档卡片、文件消息、通话卡片、Agent 分享卡片作为消息类型落入同一消息流（04 篇 §1.1）。性能与容量基线：峰值 5,000 msg/s（2 万用户租户）；普通群 ≤500 人、广播群 ≤5,000 人；消息按月分区；漫游默认 180 天；本地缓存默认 90 天。

### 1.2 术语（沿用 04/14 篇，不新造）

| 术语 | 口径 |
|---|---|
| conv（会话） | type=1 单聊 / 2 群聊 group / 3 广播群 broadcast |
| seq | 服务端会话内单调序号，渲染与同步的唯一顺序依据 |
| client_msg_id | 客户端 UUID，发送幂等键 |
| 写扩散 / 读扩散 | 普通群 fanout 写 user_conv_state 冗余；广播群仅 latest_seq，进会话拉取 |
| publisher | 广播群唯一可发言角色（`im:broadcast:publish`） |
| outbox | 客户端 sending/failed 待发队列（弱网重发源）；六态/四档断点定义见 D01 §5/§7 |

### 1.3 范围外

通话卡片内容（D04）、文件上传分片与查看器实现（D06）、WOPI 打开文档（D05）、Agent 卡片内容渲染细节（D08）、消息审计检索（audit 域）、端到端加密（15 篇延后项）。

## 2. 页面与路由

| 页面 ID | 页面 | 路由 / 形态 | 说明 |
|---|---|---|---|
| PIM-01 | 消息主页（三栏） | `/im`、`/im/c/:convId`（默认落点） | 会话列表 / 消息流 / 详情栏 |
| PIM-02 | 单聊视图 | `/im/c/:convId`（type=1） | 回执 ✓/✓✓、名片侧栏 |
| PIM-03 | 群聊视图 | `/im/c/:convId`（type=2） | @全体/禁言/公告/群已读 |
| PIM-04 | 广播群只读视图 | `/im/c/:convId`（type=3） | 成员只读；publisher 可发布 |
| PIM-05 | 群管理 | 详情侧栏四 tab（信息/成员/设置/公告），非独立路由 | L 档浮层化 |
| PIM-06 | 入群审批 | 嵌入式：会话内审批卡 + 通知中心条目 + 成员 tab「申请」入口 | conv.apply.handle |
| PIM-07 | 搜索 | 全局 Cmd+K（跨域面板，IM 域结果区）+ 会话内 Cmd+F（浮层） | 两态：本地 FTS5 / 服务端 |
| PIM-08 | 收藏 | `/im/favorites` | 我的收藏平铺列表 |
| PIM-09 | 通知中心 | `/im/notifications` | 聚合 @我/回复/审批/Agent 完成/系统公告 |
| PIM-10 | 消息多选与转发面板 | 消息流顶部批量条 + 转发弹窗（Modal 500） | 逐条/合并转发 |
| PIM-11 | 合并转发详情 | 点击 merge_forward 气泡 → 右侧抽屉（Drawer 400） | 按 origin_conv+origin_seq 拉快照 |
| PIM-12 | 系统消息样式集 | 样式注册表（非路由页），系统消息统一渲染框架 | 见 §3.12 |

路由规则：`/im` 子路由切换不销毁 WSS 连接与未读态（D01 §4.2）；PIM-05/06/10/11 为 PIM-01 内浮层/侧栏形态，Esc 逐层关闭（D01 §9）。列宽与断点行为以 **D01 为准**（导航 56px、列表栏 264px、详情栏 304px；04 篇 §3.1 线框的 60/280/300 为概要示意）。

## 3. 页面详细设计

### 3.1 PIM-01 消息主页（三栏）

```
┌──┬──────────────┬──────────────────────────────────┬──────────────┐
│导│ 会话列表 264px │  消息流 flex:1                    │ 详情栏 304px   │
│航 │┌────────────┐│ ┌ 会话头(名称/公告/通话入口/⋮) 吸顶100 │ 可折叠→图标列  │
│56 ││🔍搜索 ⚙🔔   ││ ├ 消息流(虚拟滚动, 日期分隔, 未读线)   │ 单聊:对方名片  │
│px ││[＋新建▾]    ││ ├ 正在输入指示 / 已读回执             │ 群聊:四tab     │
│   ││ 置顶区(≤30) ││ ├ 引用回复条(悬浮于输入框上)          │ (PIM-05)     │
│💬●││ 普通区(时间↓)││ ├ 富文本输入框 + 表情/@/附件/语音      │              │
│📞 ││ 列表项×N    ││ └ 发送按钮(态)                      │              │
│   │└────────────┘│                                  │              │
└──┴──────────────┴──────────────────────────────────┴──────────────┘
   M 档:列表栏收窄 56px 悬停抽屉      S 档:列表⇄内容两级导航
```

| 区块 | 内容与规则 | 数据绑定 |
|---|---|---|
| A 列表头 | 搜索框（点击→PIM-07 全局态）、新建下拉（发起单聊/建群/建广播群*）、通知铃铛（红点=未读通知） | `['im','notifications','badge']`；*广播群入口仅 `im:group:create_broadcast` 可见 |
| B 会话列表 | 虚拟滚动；置顶区（≤30，区内按 last_msg_ts↓）→ 普通区（last_msg_ts↓）；排序细则见 INT-IM-09 | `['im','convs',filter]`；msg.new/conv.updated/badge.updated 精准失效 |
| C 消息流 | 按 conv.type 分发 PIM-02/03/04 | `['im','messages',convId,cursor]` + WS 增量 |
| D 详情栏 | 单聊=名片；群聊=PIM-05；广播群=信息+发布者名单 | `['im','conv',convId]` |

**会话列表项组件**（B 区行内，高 64px）：

| 元素 | 规则 |
|---|---|
| 头像 40px | 单聊=对方头像；群=群头像，无则前 9 名成员九宫格；广播群=📣 默认标识 |
| 名称 | 单行省略；置顶项底色 `gray-1`+左侧 2px 主色条 |
| 时间 | 最新消息服务端 ts：今天 `HH:mm`/本周 `周X`/更早 `MM-DD` |
| 摘要 | 类型化：`[图片][文件][语音][视频][文档][卡片][合并转发]`；自己发送加 `我: `；系统消息取文案；有草稿优先显示 `[草稿] xxx`（红色"草稿"前缀） |
| 未读徽标 | 数字（99+ 封顶）；免打扰降级小圆点 ●；@命中加 @ 红标 |
| 右侧图标 | 置顶 📌、免打扰 🔇、Active 指示（当前选中项整行 `primary 浅底`） |

**PIM-01 六态**：

| 态 | 触发 | 表现与允许操作 |
|---|---|---|
| loading | 首次拉取 convs | 列表条形骨架×8；不可操作（>300ms 才显示） |
| empty | 无任何会话 | 插画+"发起第一个会话"+CTA 发起单聊/建群 |
| error | convs 请求失败 | 错误码文案+重试；trace_id 折叠可复制 |
| offline | WSS 断开 | 顶部横幅"连接中…/已离线"；列表/缓存消息可浏览，右下角标记"离线缓存" |
| forbidden | 2004/2005 租户/用户禁用 | 由 auth 层全局处理，本页不单独呈现（登记为不适用） |
| degraded | 扇出降级（04 §7.4 flag） | 黄条"未读数更新可能延迟"；操作不限 |

### 3.2 PIM-02 单聊视图

| 区块 | 内容 | 数据绑定 |
|---|---|---|
| 会话头 | 对方姓名+在线状态点（presence.changed）；[通话▾]（音/视频，bus→rtc）；⋮ 菜单（搜索/置顶/免打扰/举报占位） | `['presence',uid]` |
| 消息流 | 虚拟滚动；日期分隔条；气泡族；撤回占位；回执 ✓/✓✓ | `['im','messages',convId]` |
| 输入区 | 富文本输入框 + 引用回复条 + 表情/截图粘贴/文件/语音入口 | 本地 store + outbox |

**消息气泡族**（组件规格，己方 `primary 浅底` 圆角 12 带尾巴 4；对方 `gray-2`）：

| 类型 | 渲染 | 点击/交互 | 跨模块 |
|---|---|---|---|
| text | 受限 Markdown（粗体/斜体/行内代码/链接/列表），链接卡片化预览不做 | 链接 sys_open_url 系统浏览器 | — |
| image | 240 webp 缩略图，最大边 240px 等比 | 点击 → 720 → 查看器内原图 | bus `im:preview-image` → D06 |
| file | FileCard：图标/名称/大小/进度条/⚠扫描态（file.scan.completed 更新）/⤓下载/拖出 | 拖出=系统下载；"转存为协作文档" | D06 传输、D05 import |
| audio_clip | 语音条：波形（≤60 采样点）+时长（≤60s）+播放进度填充 | 点击播放（本端边下边播） | D06 下载票据 |
| video | 封面 poster+时长角标+▶ | 点击拉流播放（独立浮层） | D06 |
| doc_card | 标题/格式图标/version/updater | 点击经 WOPI 会话打开 | bus `im:open-doc` → D05 |
| agent_card | task_title+summary_md 摘要+artifacts 数 | 点击展开明细（不离开 IM） | bus `im:open-agent-session` → D08 |
| merge_forward | title+count+前 3 条 digest | 点击 → PIM-11 抽屉 | 本篇 |
| system | PIM-12 样式集，居中弱化 | 公告类可"查看全文" | — |
| 引用条 | 任意类型可携带：`reply_to_seq`+快照摘要，气泡顶部 `gray-1`+左 3px 主色条 | 点击定位原消息（闪烁 2s） | — |
| @高亮 | mentions.range 内文本主色+底纹 | 点击 @ 用户 → 名片 popover | — |

**富文本输入框组件**：@选择器（输入 `@` 触发成员过滤面板，↑↓+Enter 选择，含"@全体"——受 mention_all_policy）；表情面板（常用+分类）；截图粘贴（剪贴板图片→发送前预览弹窗，压缩选项走 D06）；引用回复条（消息右键"回复"后悬浮显示，可关闭）；草稿自动保存（INT-IM-10）；发送按钮态：可发送（主色）/不可发送（禁用，空内容或发送中）/禁言（禁用+剩余时长 tooltip 3006）。

**已读回执展示（单聊）**：己方消息尾标——对端 delivered_seq≥seq → ✓；read_seq≥seq → ✓✓；sending → 灰色时钟；failed → 红叹号+重试菜单。

**PIM-02 六态**：loading=消息流 shimmer 行×6；empty=无消息（新会话）"打个招呼吧"+快捷语；error=加载失败+重试（trace_id）；offline=本地缓存渲染+半透明遮罩"离线中，消息进入待发队列"（可撰写，outbox 排队）；forbidden=3019/3001（被移出）→锁图标"你已不在该会话"+仅历史只读（history_visible）；degraded=漫游到期 gap→"加载更早"入口（04 §4.6）。

### 3.3 PIM-03 群聊视图（PIM-02 增量）

| 项 | 规则 |
|---|---|
| 会话头 | 群名(成员数)；点击展开 PIM-05 |
| 公告横幅 | 消息流顶部吸顶 🔔 公告摘要+"查看全文"；更新时红点；可关闭（本端记忆） |
| 群已读 | 租户 `im.read_receipt` 开启时：己方消息下"已读 N/M"，点击开已读回执面板（API-IM-06）；默认仅群主/管理员可见名单 |
| 禁言提示 | 被单人禁言/全员禁言（mute_all_until 且非 owner/admin）→ 输入框禁用条"已被禁言至 HH:mm"；发送返回 3006 同步 UI |
| @全体 | mention_all_policy 判定（3004/3014）；@全体消息全员强提醒（INT-IM-22） |
| 正在输入 | 群聊默认关闭（04 篇开放问题 4，开关待定；能力已实现，TTL 同 INT-IM-11） |

**PIM-03 六态**：同 PIM-02；forbidden 追加 3002 群已解散→"会话已解散"只读页；degraded 追加回执合并上报 60s 粒度（回执延迟提示不展示，登记）。

### 3.4 PIM-04 广播群只读视图

| 视角 | 规则 |
|---|---|
| 普通成员 | 无输入框；替代为灰条"仅发布者可发言"；不支持 @（输入不可用）；表情回应可用但为本地态（不广播全名单，04 §4.5.4） |
| publisher（`im:broadcast:publish`） | 输入框可用，仅 text/file/image/视频；无 @ 与回应面板；发布后走 msg.send（服务端校验 3013 兜底） |
| 消息拉取 | 读扩散：进入会话按游标分页拉取（GET messages），列表未读=latest_seq−read_seq 差值（badge.updated 感知） |

**PIM-04 六态**：loading=骨架；empty="暂无发布"；error/offline 同 PIM-02（离线读本地缓存）；forbidden=3013（非 publisher 发送被拒）→toast 错误文案；degraded=发布积压时"发布中…"长时间 sending（10s×3 后 failed 可重试）。

### 3.5 PIM-05 群管理（四 tab）

```
┌ 详情栏/浮层 ──────────────────┐
│ [群名头像]  成员 128/500       │
│ [信息][成员][设置][公告]  ←tab  │
│ ┌──────────────────────────┐ │
│ │ (tab 内容区, 六态独立)      │ │
└─┴──────────────────────────┴─┘
```

| tab | 内容 | 显隐/权限 |
|---|---|---|
| 信息 | 群名/头像/类型/创建时间/群主/成员数/历史可见性；操作：退群、转让（owner）、解散（owner/租户管理员 `im:group:manage`） | 全员可见；编辑仅 owner/admin（群设置可放开 member） |
| 成员 | 搜索框；成员列表（头像/姓名/部门/角色图标/在线点）；行操作：@、名片、设为/取消管理员、禁言（≤30 天/次）、移出；「申请」入口（PIM-06，仅 owner/admin） | 管理操作按 04 §4.5.1 矩阵显隐 |
| 设置 | join_mode/invite_policy/mention_all_policy/history_visible/全员禁言开关+时长；保存=conv.setting | 仅 owner/admin 可见 tab |
| 公告 | 当前公告全文+发布者+时间；历史列表；编辑入口 | 发布/修改 owner/admin（广播群=publisher） |

**PIM-05 六态**：loading=块骨架；empty=成员空集（不可能，登记不适用）/公告无→"暂无公告"+CTA（有权者）；error=重试；offline=只读展示缓存+禁改（变更进待写队列标"上线后生效"）；forbidden=无群管理角色→设置 tab 隐藏、被移出→整栏锁样式；degraded=成员列表>500 时降级为分页搜索模式（不整表渲染）。

### 3.6 PIM-06 入群审批

审批卡（会话内系统消息位置或通知中心条目）：申请人（头像/姓名/部门）+申请理由（≤200 字）+[同意][拒绝]（仅 owner/admin 可见按钮；member 视角只见结果文案）。

| 态 | 表现 |
|---|---|
| loading | 按钮提交后 1s 内 spinner |
| empty | 「申请」入口无待审→"暂无申请" |
| error | conv.apply.handle 失败→按钮恢复+toast 错误码（3015/3019） |
| offline | 离线不展示审批操作（按钮禁用+"离线"提示） |
| forbidden | 非审批角色→只读卡（无按钮） |
| degraded | 不适用（登记） |

规则：申请 7 天未处理自动过期（status=4，卡片变"已过期"）；同群同人待审唯一（服务端部分唯一索引，§6.1）。

### 3.7 PIM-07 搜索（两态）

形态一：**全局搜索**（Cmd+K，D01 全局面板）→ IM 域结果区（"消息"分组，默认前 8 条+更多）；命中跳其他域由 app 层分发。形态二：**会话内搜索**（Cmd+F）→ 消息流顶部浮层，预置 conv_id，结果侧列（M 档以下为底部抽屉）。

| 项 | 规则 |
|---|---|
| L1 本地态 | 输入即搜：SQLite FTS5（trigram，中文子串），<50ms，无网络可用；标记"本地结果" |
| L2 服务端态 | 回车或点"全网搜索"（本地无结果自动提示升级）：GET /messages/search（zhparser）；标记"漫游期全量" |
| 过滤器 | keyword（必填）、from_uid、conv_id（形态二预置）、type（文件/图片/链接/语音…）、from_ts/to_ts；AND 组合 |
| 结果条目 | 命中片段高亮 + 会话名 + 发送人 + 日期；点击 → 打开会话、拉目标 seq 前后各 20 条、滚动锚点定位+闪烁 2s |

**PIM-07 六态**：loading=服务端态查询时 shimmer×5（本地态无 loading）；empty=本地无结果→提示"全网搜索"CTA / 服务端也无→"未找到相关消息"；error=9003/9005→仅保留本地态+黄条"服务端搜索不可用"；offline=仅本地态可用（面板标注）；forbidden=7002 类不适用（登记）；degraded=9005 依赖降级提示。

### 3.8 PIM-08 收藏

列表页 `/im/favorites`：卡片式平铺（原消息气泡缩略渲染+来源会话+时间）；顶栏筛选（type）+搜索框（标题/文本内容）；点击跳原消息锚点；行操作：取消收藏、转发。上限 1000 条（可配），超限服务端拒绝（错误码映射见 §10 开放问题 2）。六态：loading 骨架×6/empty"暂无收藏，右键消息可收藏"+CTA 去消息/error 重试/offline 读缓存/forbidden 不适用/degraded 不适用（登记）。

### 3.9 PIM-09 通知中心

| 分组 | 来源 | 点击路由 |
|---|---|---|
| @我 | msg.new mentions 命中 | 打开会话定位该 seq |
| 回复我 | reply_to_seq 指向本人消息 | 同上 |
| 入群审批 | conv.apply（推 owner/admin） | PIM-06 审批卡 |
| Agent 完成 | agent 域完成事件（bus） | D08 会话 |
| 系统公告 | notice.broadcast / 群公告变更 | 公告全文弹层 |

聚合规则：同一会话 10s 窗口合并"×3"；1 分钟内 ≤5 条系统通知超出仅计红点（04 §4.8）；勿扰时段只入中心不发系统通知（D01 §8）。六态：loading 骨架/empty"暂无通知"/error 重试/offline 显示本地已聚合项（新事件停聚）/forbidden 不适用/degraded 不适用（登记）。

### 3.10 PIM-10 消息多选与转发面板

入口：消息右键/长按 →「多选」；进入后复选框浮于气泡左侧，顶部批量条替换会话头：`已选 N [转发][收藏][复制][合并转发] [取消]`（Esc 退出）。复制仅全部为 text 时可用；收藏/转发对全部选中项生效（失败逐条 toast）。

转发弹窗（Modal 500）：

```
┌ 转发 ────────────────────┐
│ 🔍 搜索会话/联系人          │
│ ┌ 最近会话 chip ×N ┐       │
│ ├ 会话列表(单选) ─────┤    │
│ │ 方式: (●)合并转发 ( )逐条 │  ←>1条时出现
│ │ [ ] 附言(text ≤500)      │
│ └        [取消] [发送] ─┘  │
└──────────────────────────┘
```

规则：合并 ≤30 条（3021）；合并转发再转发时展开原始条目重组（嵌套 ≤3 层，3021）；逐条转发逐条 msg.send（失败计数反馈）；目标为广播群且非 publisher → 3013 拦截。六态：loading=发送中/empty=无会话（罕见，登记）/error=逐条失败明细/offline=禁发+提示/forbidden=3013 校验前置隐藏广播群目标/degraded 不适用。

### 3.11 PIM-11 合并转发详情

点击 merge_forward 气泡 → 右侧抽屉（Drawer 400）：标题+count+逐条子列表（sender/类型 digest）；子条目点击 → `GET /convs/{origin_conv}/messages?around` 按 origin_conv+origin_seq 拉快照展开全文（无权限/已退群 → 该条置灰"原消息不可见"）。六态：loading 块骨架/empty 不适用/error 重试/offline 只读已缓存条目/forbidden=条目级置灰（不整页锁）/degraded 不适用。

### 3.12 PIM-12 系统消息样式集（注册表）

统一样式：居中、`gray-4` 12px、上下 8px、不参与回执/长按菜单；参数 `{actor, target, group, extra}` 由服务端 body 下发。

| kind | 文案模板 | 附加 |
|---|---|---|
| group.created | {actor} 创建了群聊 | — |
| member.joined | {actor} 邀请 {target} 加入群聊 / {target} 通过申请加入 | 申请通过走后者 |
| member.quit | {actor} 退出了群聊 | — |
| member.removed | {target} 被 {actor} 移出群聊 | — |
| member.role.changed | {target} 被 {actor} 设为管理员/取消管理员 | — |
| owner.transferred | {actor} 将群主转让给 {target} | — |
| member.muted / unmuted | {target} 被 {actor} 禁言至 {time} / 被解除禁言 | — |
| mute.all.on / off | 群主/管理员开启了全员禁言（至 {time}） | — |
| announcement.changed | {actor} 修改了群公告 | "查看全文"→公告 tab |
| conv.dissolved | {actor} 解散了该群聊 | 会话转只读 |
| msg.recalled | {actor} 撤回了一条消息 | 占位消息（seq 不断裂） |
| apply.submitted | {actor} 申请加入群聊：{reason} | 附审批卡（PIM-06） |
| broadcast.published | {actor} 发布了新公告 | 仅广播群 |

## 4. 交互详细设计

### 4.1 INT 交互表

| ID | 交互 | 触发 | 行为 | 反馈 | 边界/异常 |
|---|---|---|---|---|---|
| INT-IM-01 | 发送消息 | Enter 发送 / Shift+Enter 换行（D01 §9） | 乐观更新：先落 SQLite(outbox) 再 msg.send；本地临时序 `t-1` 置底 | sending 灰钟→sent 单钩（单聊 ✓ 送达）；toast 不用 | 3004 超长前置校验；3005 敏感词→failed"包含违禁词"（不回显命中词）；3006/3007/3013 禁言/限频/只读 |
| INT-IM-01a | 失败重试 | 点红叹号→菜单[重试][复制内容][删除] | 重试复用原 client_msg_id（幂等回原 seq）；删除仅移除本地 outbox | failed→sending | 自动重试 3 次指数退避后转 failed（14 §2.2） |
| INT-IM-02 | 编辑消息 | 右键「编辑」（仅本人 text 且 ≤5min） | 原 bubble 转入输入框编辑态，PATCH | "已编辑"角标+msg.updated 全端原地更新 | 3008 超窗（菜单项隐藏+服务端兜底）；edit_history 留痕服务端 |
| INT-IM-03 | 撤回 | 右键「撤回」（本人≤24h；`im:message:recall_any` 可撤他人） | POST recall → 本端立即占位，msg.recall 全端 | 占位"张三 撤回了一条消息" | 3003 超窗/3009 无权/3002；文件类仅失效卡片，file 保留在发送者"我的文件" |
| INT-IM-04 | 回复/引用 | 右键/悬浮「回复」 | 输入框上浮引用条（摘要 60 字截断）随消息发送 reply_to_seq+快照 | 对端气泡顶部引用条，点击定位原消息 | 引用目标被撤回→引用条变"原消息已撤回" |
| INT-IM-05 | 转发 | 右键「转发」/多选批量 | PIM-10 面板：逐条 or 合并 ≤30 | 成功 toast+跳转询问 | 3021 超限/嵌套>3；3013 目标只读 |
| INT-IM-06 | 收藏 | 右键「收藏」/多选 | POST favorite | 摘要 toast"已收藏"（含查看入口）；重复收藏幂等 | 上限 1000 拒绝（见 §10-2）；撤回后收藏项显示占位 |
| INT-IM-07 | 置顶/免打扰/标记已读 | 会话右键菜单（D01 §10） | 本地即时生效+PATCH state（API-IM-13）上送；免打扰下 @我 仍穿透通知 | 列表图标/徽标降级小圆点即时刷新 | 置顶上限 30（超出 toast 提示替换最旧，见 §10-8）；离线变更挂待写队列 |
| INT-IM-08 | 未读跳转 | 点列表项徽标（非会话本体） | 打开会话→虚拟列表锚点定位**第一条未读 seq**，其上插入"以下为未读"分隔线 | 定位闪烁 1 次 | 本地缺该 seq→先补洞再定位；无缓存→拉 after=first_unread 前 20 条 |
| INT-IM-09 | 会话排序 | —（规则项） | 置顶区(≤30, last_msg_ts↓) > 普通区(last_msg_ts↓)；hidden 会话不显示，新消息自动恢复；dissolved 沉底灰显（history_visible 时） | — | 草稿不影响排序；离线用本地冗余 ts |
| INT-IM-10 | 草稿多端同步 | 切换会话即存 + 输入防抖 500ms | local_conv_state.draft 即写；上送 PATCH state（≤2000 字）；conv.updated(kind=state) 推其他端 | 列表"[草稿]"前缀 | 3020 超限（输入框计数器 2000 硬限）；清除=发送成功或手动清空同步空串 |
| INT-IM-11 | 正在输入 | 输入事件节流 2.5s 发 msg.typing | 对端显示"对方正在输入…"（会话头副标题/群=输入条），**TTL 5s** 过期消失；stop 不发（静默） | 弱化灰字动画 | 瞬时事件不重试不落库（14 §9-1）；群聊默认关闭（§10-6） |
| INT-IM-12 | 已读上报 | ①进入会话且消息进入可视区 ②新消息在可视区追加 ③窗口聚焦且会话当前打开 | msg.read{conv_id, read_seq=连续最大可视 seq}；节流 1s 合并 | 对端 ✓✓/已读数+1 | 只进不退；多端取最大；降级时合并 60s 粒度（04 §7.5） |
| INT-IM-13 | 虚拟滚动与锚点 | 消息流 | react-virtuoso，key=`{convId}:{seq}`；上滑翻页 prepend；底部跟随（用户上滚停止→"回到底部"浮标+新消息计数） | 骨架占位 prepend | sending 消息临时序置底；seq 空洞后台补洞不阻塞（补洞失败 3 次提示重试） |
| INT-IM-14 | 多选批量 | 右键「多选」进入 | 见 PIM-10；支持 转发/收藏/复制/合并 | 批量条计数 | Esc/点空白退出；滚动不丢选择 |
| INT-IM-15 | 建群 | 新建▾→发起群聊 | 选成员 ≤499 → conv.create{name, member_ids, type:2}（需 `im:group:create`） | ack 后会话入列表+系统消息 | 3010 上限（选择器预检余量）；单聊发起=选 1 人，服务端去重复用已有单聊 |
| INT-IM-16 | 邀请与入群审批 | 成员 tab「添加」/申请入口 | 邀请：conv.member.add（invite_policy 校验）；join_mode=apply 时被邀端收确认；申请：conv.apply{reason}→审批卡→conv.apply.handle | 系统消息+通知中心双通道 | 3011/3012/3010/3015；申请 7 天过期 |
| INT-IM-17 | 角色与禁言 | 成员行操作 | conv.member.role{uid, role}；单人禁言 conv.setting{mute:{uid, until≤30d}}；全员禁言 conv.setting{mute_all_until} | 系统消息（PIM-12）；被禁者输入框禁用倒计时 | 矩阵校验：admin 不能禁 owner/admin；3009 类无权由 3015/3011 映射 |
| INT-IM-18 | 公告 | 公告 tab 编辑 | conv.setting{announcement} → 全端 conv.updated+系统消息+顶部横幅红点 | 横幅可关闭（本端记忆） | 广播群公告=内容主体（publisher 权限）；历史留侧栏 |
| INT-IM-19 | 转让/解散 | 信息 tab | 转让：conv.member.role{uid, owner}（危险确认弹窗，D01 §8 红色确认）；解散：conv.dissolve（危险确认+全程审计） | 全端 conv.updated(status)→"已解散"只读 | 3016 群主不可退群（引导转让/解散）；广播群可由租户管理员解散 |
| INT-IM-20 | 广播群发布 | publisher 输入框发送 | msg.send（服务端仅 publisher 通过，3013 兜底）；跳过逐端 fanout，仅 latest_seq+badge.updated | 发布者立即见；成员端列表差值未读+1 | 无 @；回应本地态 |
| INT-IM-21 | 搜索两态 | Cmd+K 全局 / Cmd+F 会话内 | 本地 FTS5 即时→回车/无结果升级服务端 | 见 PIM-07 | 离线仅本地态 |
| INT-IM-22 | 通知聚合与红点 | msg.new（非当前会话或窗口失焦） | 会话 10s 窗口合并；系统通知点击→激活窗口→定位 seq；红点=Σ未读（99+），免打扰计小圆点，@未读加 @ 标 | 托盘角标同源（win_set_badge） | @我/@全体穿透会话勿扰（租户可关）；广播新发布穿透用户勿扰（默认开） |
| INT-IM-23 | 表情回应 | 消息右键/悬浮「😊」→选择器 | msg.reaction.set{msg_id, emoji, action}；msg.reaction.new 增量合并 | 气泡底回应条 `😊×3`，悬浮看名单 | 不占 seq/不计未读/不通知；同人同 emoji 幂等；广播群本地态 |
| INT-IM-24 | @提及 | 输入 `@` | 选择器（成员搜索/@全体受策略）→写入 mentions.range | 流内 @ 文本高亮；@我 加底纹 | 3014 @全体被禁；mentions 范围随编辑重算 |
| INT-IM-25 | 消息右键/拖出 | 右键/长按 | 菜单（分组）：回复/引用/复制/转发/收藏/多选/编辑/撤回（条件显隐）；文件卡片可拖出至系统=下载 | 统一右键组件 | 禁止对 system/recalled 显示编辑/撤回 |
| INT-IM-26 | 语音条录制 | 按住 🎙 | im_voice_record_start/stop（Rust 转码 opus）；松开发送、上滑取消 | 波形实时动画+时长 | ≤60s 自动截断；duration/waveform(≤60) 入 body |
| INT-IM-27 | 截图粘贴/文件拖入 | 粘贴/拖入会话区 | 剪贴板图片→发送前预览（压缩选项 D06）；文件→预览列表 ≤20/次（超出 toast 分批） | 投放高亮 | D01 §10 全量遵守 |

### 4.2 状态机

**S1 消息生命周期**（04 §4.1 细化，端内视角）：

```
composing ──Enter──► sending(落库+outbox) ──ack(seq)──► sent
   ▲                    │10s无ack/重试×3                ├─► recalled(占位,≤24h)
   │                    ▼                              ├─► edited(仅text,≤5min,"已编辑")
   └── 复用内容重发 ── failed ──用户删除──► (移出outbox)
sent 展示叠加（不改变状态，按会话游标渲染）:
  单聊: peer delivered_seq≥seq →✓ ; peer read_seq≥seq →✓✓
  群聊: read_count(seq)/member_total → "已读 N/M"
  回执只进不退；多端取最大值
```

**S2 群成员/申请状态**：

```
conversation_member.status: 1 在群 ──退群──► 2 已退            （历史按 history_visible）
                            1 在群 ──移出──► 3 被移出（强制退出会话视图）
conversation_apply.status:  1 待审 ──approve──► 2 通过(→member.status=1)
                            1 待审 ──reject───► 3 拒绝
                            1 待审 ──7d──────► 4 过期
角色: owner ⇄(转让, 危险确认) ; admin ⇄(owner 设置/取消) ; member ; publisher(广播群)
```

**S3 会话列表项状态**（可叠加，优先级右>左）：`普通 ⇄ 未读(数字/@标) ⇄ 免打扰(●) ；叠加：置顶/草稿/Active/已解散(灰) / 离线(角标"待发 N")`。

### 4.3 IM 局部快捷键（追加 D01 §9，不冲突）

| 键 | 作用 |
|---|---|
| Cmd/Ctrl + ↑ | 引用/编辑自己最近一条 text 消息（≤5min 编辑，超窗转引用） |
| Cmd/Ctrl + Shift + A | 会话内 @全体（mention_all_policy 允许时） |
| Esc | 多选模式/搜索浮层/引用条 逐层退出 |

## 5. 接口详细设计

> 通用：REST 走 `/api/v1`，响应包 `{code,data,trace_id}`（14 §5.2）；写操作带 `Idempotency-Key`；分页 `cursor/limit`（默认 20 最大 100）。WS 走 14 §2 信封，此处仅定义 payload。ID 为本篇登记编号。

### 5.1 REST

**API-IM-01 GET /api/v1/sync**（14 §4，登录/重连增量）

| 请求参数 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| cursors | string(map) | 是 | convId:seq 对，≤100 会话/次（14 §9-3） | 各会话本地游标 JSON |
| limit | int | 否 | ≤200，默认 200 | 单会话带回消息上限 |

响应 data：`{convs:[{conv, messages[], latest_seq, unread} | {conv, gap:true, total_behind, fetch_url}], presences[], badges, server_ts}`。示例：`{"code":0,"data":{"convs":[{"conv":{"id":"8831","type":2,"latest_seq":131},"messages":[{"seq":130,"type":"text"}],"unread":2}],"badges":{"total":12},"server_ts":1760000000123},"trace_id":"t-1"}`

错误：9001 参数、3018 非法游标。广播群 convs 项仅 `{conv,latest_seq,unread}`（04 §4.6）。

**API-IM-02 GET /api/v1/convs**

| 请求参数 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| filter | enum | 否 | all/unread/group/single/broadcast | 过滤 |
| cursor/limit | string/int | 否 | ≤100 | 分页 |

响应 items：`{id,type,name,avatar_file_id,latest_seq,last_msg_digest,last_msg_ts,member_count,status, my:{pinned,mute,draft,unread_badge,mention_unread,role}}`。错误：无特有（通用 1xxx/9xxx）。

**API-IM-03 GET /api/v1/convs/{id}**：响应 `conversation 全字段 + group_setting(群) + my{role,mute_until,read_seq} + receipt_policy{enabled,visible_scope}` + 成员概要（owner+前 50）。错误：3019/3001/3002。

**API-IM-04 GET /api/v1/convs/{id}/messages**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| after/before | int | 否 | seq 区间（补洞：after=129&before=131） |
| cursor/limit/order | — | 否 | 翻页；order=-seq |

响应 items=消息对象[]（字段同 msg.new payload）+`next_cursor,has_more,latest_seq`。错误：3019/3001/3018。

**API-IM-05 GET /api/v1/convs/{id}/members**：参数 cursor/limit/role(1-4)。响应 items：`{uid,display_name,avatar,dept_id,role,status,join_at,mute_until,online}`。错误：3019/3001。

**API-IM-06 GET /api/v1/convs/{id}/receipts?msg_seq=**：群已读名单（租户 `im.read_receipt` 开且 visible_scope 允许）。响应 `{msg_seq, member_total, read_count, read:[uid…], unread:[uid…]}`；>200 人群只回计数（名单截断，见 §10-3）。错误：3019/3001/2003（策略关闭）。

**API-IM-07 POST /api/v1/messages/{id}/recall**

| 请求字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| reason | string | 否 | ≤200 | 撤他人（recall_any）时必填，入审计 |

响应：`{msg_id, conv_id, seq, status:2, ts}`。错误：3017/3003/3009/3002。

**API-IM-08 PATCH /api/v1/messages/{id}**

| 请求字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| body.text | string | 是 | ≤5000 字（3004）、敏感词（3005） | 仅 text 消息 |

响应：`{msg_id, seq, body, edited_at, edit_version}`。错误：3008/3009/3017/3004/3005。示例——请求 `{"body":{"text":"发布说明已更新（改）"}}`；响应 data `{"msg_id":"m-991","seq":130,"edited_at":1760000100000,"edit_version":2}`。

**API-IM-09 POST /api/v1/messages/forward**

| 请求字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| target_conv_id | string | 是 | 存在且为成员 | 目标会话 |
| msg_ids | string[] | 是 | ≤30（3021）；嵌套展开后 ≤3 层 | 待转发 |
| mode | enum | 是 | merge/one_by_one | 合并/逐条 |
| note | string | 否 | ≤500 | 附言（随首条发送） |

响应：`{sent_count, failed:[{msg_id, code}]}`。错误：3021/3013/3019/3001。幂等：Idempotency-Key。

**API-IM-10 POST / DELETE /api/v1/messages/{id}/favorite**：请求无 body（POST）。响应 `{favorite_id, created_at}` / DELETE 返回 `{}`。错误：3017/9001（超限映射见 §10-2）。幂等：UK(user_id,msg_id)。

**API-IM-11 GET /api/v1/favorites**：参数 cursor/limit/type。响应 items：`{id, msg:{…消息快照…}, conv:{id,name,type}, created_at}`。

**API-IM-12 GET /api/v1/messages/search**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| keyword | string | 是 | ≤64 字，非空白 |
| from_uid/conv_id/type | — | 否 | 过滤器（04 §4.7） |
| from_ts/to_ts | int(ms) | 否 | 时间段 |
| cursor/limit | — | 否 | 分页 |

响应 items：`{msg:{…}, conv_name, sender_name, highlight:[{start,end}]}`。错误：9001/9003（限流→本地态兜底）/9005（检索依赖降级）。

**API-IM-13 PATCH /api/v1/convs/{id}/state**（**本篇新增提案**，回填 04/14 登记；概要篇仅定义了 user_conv_state 表未定义写接口）

| 请求字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| pinned | bool | 否 | 置顶数 ≤30 | 置顶 |
| mute | bool | 否 | — | 免打扰 |
| draft | string | 否 | ≤2000 字（3020） | 草稿；空串=清除 |
| hidden | bool | 否 | — | 隐藏会话 |

响应：`{state 全字段}`；变更经 `conv.updated(kind=state)` 推送本人其他端（§10-1）。错误：3019/3020/9001。幂等：按字段覆盖，无需 Idempotency-Key（最终一致）。

### 5.2 WS 事件（客户端 → 服务端）

| type | payload 字段表 |
|---|---|
| msg.send | `conv_id*` · `client_msg_id*`(UUID) · `type*`(text/image/file/audio_clip/video/doc_card/agent_card/merge_forward 由 forward 产生) · `body*`(类型化，见 §6.3) · `mentions[]`{uid,all,range:[s,e]} · `reply_to_seq` · `reply_digest`(引用快照{sender,type,digest}，服务端冗余入 ext) |
| msg.read | `conv_id*` · `read_seq*`(连续最大，只增) |
| msg.typing | `conv_id*`（瞬时：不重试/不落库/TTL 5s） |
| msg.reaction.set | `msg_id*` · `emoji*`(unicode，白名单 ≤8 字节) · `action*`(add/remove) |
| pres.set | `status*`(online/away/dnd/invisible) · `clear_at`(away/dnd 自动恢复时间，ms) |
| conv.create | `type*`(1/2/3) · `name`(群必填 ≤50) · `member_ids*`(≤499；type=1 恰 1 人) · `avatar_file_id` |
| conv.quit | `conv_id*` |
| conv.member.add | `conv_id*` · `uids*`(≤100/次，批量预检余量) |
| conv.member.remove | `conv_id*` · `uid*` |
| conv.member.role | `conv_id*` · `uid*` · `role*`(1 owner 转让/2 admin/3 member) |
| conv.setting | `conv_id*` · patch：`name` · `avatar_file_id` · `announcement`(≤2000) · `mute_all_until` · `mute_member{uid,until}` · `join_mode` · `invite_policy` · `mention_all_policy` · `history_visible` |
| conv.dissolve | `conv_id*` |
| conv.apply | `conv_id*` · `reason`(≤200) |
| conv.apply.handle | `apply_id*` · `action*`(approve/reject) |

ack payload 概览：msg.send→`{seq, msg_id, ts}`（幂等重试返回原 seq）；conv.create→`{conv}`；conv.apply→`{apply_id}`；其余→`{}`。非 0 code 走信封 code（3xxx，14 §7）。

### 5.3 WS 事件（服务端 → 客户端）

| type | payload 字段表 |
|---|---|
| msg.new | 消息对象全量：`msg_id` · `conv_id` · `seq` · `client_msg_id` · `sender_id` · `type` · `body` · `mentions[]` · `reply_to_seq` · `ext{reactions,reply_digest}` · `status`(1/2/3) · `ts`；含离线补投（重连 sync 前缓存合流） |
| msg.recall | `msg_id` · `conv_id` · `seq` · `operator_id` · `ts` |
| msg.updated | `msg_id` · `conv_id` · `seq` · `body` · `edited_at` · `edit_version` |
| msg.receipt | `conv_id` · `uid`（对端/群成员） · `delivered_seq` · `read_seq`（客户端按游标刷新 ✓/✓✓/已读 N/M） |
| msg.reaction.new | `msg_id` · `conv_id` · `seq` · `reactions`（全量快照 `{emoji:[uid…]}`，端侧幂等合并） |
| conv.updated | `conv_id` · `kind`(meta/member/setting/status/announcement/state) · `conv`(变更后快照) · `operator_id` · `members_delta[{uid,role,status}]`(kind=member) · `state{pinned,mute,draft}`(kind=state，仅推本人多端) |
| notification.new | `id` · `kind`(mention/reply/apply/agent_done/announcement) · `conv_id` · `title` · `digest` · `count`(同会话 10s 窗口合并后计数) · `ts`（PIM-09：推给目标 user；端内失效 `['im','notifications']` 后 REST 回读真值） |
| badge.updated | `total_unread` · `items[{conv_id, unread_badge, mention_flag}]`（写扩散群冗余；广播群实时差值由本端以 latest_seq−read_seq 计算） |
| presence.changed | `uid` · `status`(online/away/dnd/invisible) · `last_active_ts`（单聊头部/成员列表在线点渲染） |

### 5.4 Rust 本地命令（追加 D01 §12.3）

| 命令 | 参数/返回 | 说明 |
|---|---|---|
| im_voice_record_start / _stop / _cancel | stop→{file_path, duration_ms, waveform[≤60]}；转码 opus/aac | 语音条（INT-IM-26） |
| im_fts_search | {keyword, conv_id?, limit}→[{conv_id, seq, snippet}] | L1 本地搜索（FTS5） |
| im_db_prune | {keep_days:90} | 会话 LRU 清理，FTS 随行删除 |

## 6. 模型设计

### 6.1 服务端表（PostgreSQL，均含 tenant_id + RLS：`tenant_id = current_setting('app.tenant')::bigint`）

```sql
CREATE TABLE conversation (
  id              BIGINT PRIMARY KEY,                  -- 雪花，字符串透出
  tenant_id       BIGINT      NOT NULL,
  type            SMALLINT    NOT NULL,                -- 1单聊 2群聊 3广播群
  name            TEXT        NOT NULL DEFAULT '',
  avatar_file_id  TEXT        NULL,
  owner_id        BIGINT      NULL,                    -- 群主；单聊/广播群可空
  latest_seq      BIGINT      NOT NULL DEFAULT 0,
  last_msg_digest JSONB       NOT NULL DEFAULT '{}',
  last_msg_ts     TIMESTAMPTZ NULL,
  member_count    INT         NOT NULL DEFAULT 0,
  status          SMALLINT    NOT NULL DEFAULT 1,      -- 1 active 2 dissolved
  created_by      BIGINT      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_list ON conversation (tenant_id, status, last_msg_ts DESC);

CREATE TABLE conversation_member (
  id         BIGINT PRIMARY KEY,
  tenant_id  BIGINT NOT NULL, conv_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
  role       SMALLINT NOT NULL DEFAULT 3,              -- 1 owner 2 admin 3 member 4 publisher
  join_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  join_by    BIGINT NULL,
  mute_until TIMESTAMPTZ NULL,                         -- 单人禁言 ≤30天/次
  status     SMALLINT NOT NULL DEFAULT 1,              -- 1在群 2已退 3被移出
  UNIQUE (conv_id, user_id)
);
CREATE INDEX idx_member_user ON conversation_member (user_id, status);

CREATE TABLE message (                                  -- 按月分区，分区键 created_at
  id            BIGINT NOT NULL,
  tenant_id     BIGINT NOT NULL,
  conv_id       BIGINT NOT NULL,
  seq           BIGINT NOT NULL,
  client_msg_id TEXT   NOT NULL,
  sender_id     BIGINT NOT NULL,
  type          TEXT   NOT NULL,                       -- §1.2 全集
  body          JSONB  NOT NULL DEFAULT '{}',
  mentions      JSONB  NULL,
  reply_to_seq  BIGINT NULL,
  ext           JSONB  NULL,                           -- reactions/reply_digest
  status        SMALLINT NOT NULL DEFAULT 1,           -- 1 normal 2 recalled 3 edited
  edited_at     TIMESTAMPTZ NULL,
  edit_history  JSONB NULL,
  ts            TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  UNIQUE (conv_id, seq), UNIQUE (conv_id, client_msg_id)
) PARTITION BY RANGE (created_at);
-- 分区示例：CREATE TABLE message_2026_11 PARTITION OF message
--   FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE INDEX idx_msg_conv_seq ON message (conv_id, seq DESC);
CREATE INDEX idx_msg_fts ON message USING GIN (to_tsvector('zhparser', body->>'text'));
-- seq 分配：Redis INCR t:{tid}:conv:{cid}:seq；重启以分区 max(seq)+1 对齐（04 §4.1）

CREATE TABLE message_receipt (
  tenant_id     BIGINT NOT NULL,
  conv_id       BIGINT NOT NULL, user_id BIGINT NOT NULL,
  delivered_seq BIGINT NOT NULL DEFAULT 0,
  read_seq      BIGINT NOT NULL DEFAULT 0,             -- 只增不减
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conv_id, user_id)
);
CREATE INDEX idx_receipt_read ON message_receipt (conv_id, read_seq);

CREATE TABLE group_setting (
  conv_id           BIGINT PRIMARY KEY,
  tenant_id         BIGINT NOT NULL,
  join_mode         SMALLINT NOT NULL DEFAULT 1,       -- 1直接进 2需审批 3仅邀请
  invite_policy     SMALLINT NOT NULL DEFAULT 1,       -- 1全员可邀 2仅管理
  mention_all_policy SMALLINT NOT NULL DEFAULT 2,      -- 1全员 2仅管理 3禁用
  mute_all_until    TIMESTAMPTZ NULL,
  history_visible   BOOLEAN NOT NULL DEFAULT true,
  announcement      TEXT NULL,
  announcement_ts   TIMESTAMPTZ NULL
);

CREATE TABLE user_conv_state (
  tenant_id    BIGINT NOT NULL,
  user_id      BIGINT NOT NULL, conv_id BIGINT NOT NULL,
  pinned       BOOLEAN NOT NULL DEFAULT false,
  mute         BOOLEAN NOT NULL DEFAULT false,
  draft        TEXT NOT NULL DEFAULT '',               -- ≤2000（3020）
  read_seq     BIGINT NOT NULL DEFAULT 0,
  acked_seq    BIGINT NOT NULL DEFAULT 0,
  unread_badge INT NOT NULL DEFAULT 0,                 -- 写扩散冗余；广播群不落库
  hidden       BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conv_id)
);
CREATE INDEX idx_ucs_conv ON user_conv_state (conv_id); -- fanout 批量写路径

CREATE TABLE conversation_apply (
  id BIGINT PRIMARY KEY, tenant_id BIGINT NOT NULL,
  conv_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status SMALLINT NOT NULL DEFAULT 1,                  -- 1待审 2通过 3拒绝 4过期(7d)
  handled_by BIGINT NULL, handled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uk_apply_pending ON conversation_apply (conv_id, user_id) WHERE status = 1;
CREATE INDEX idx_apply_conv ON conversation_apply (conv_id, status);

CREATE TABLE message_favorite (
  id BIGINT PRIMARY KEY, tenant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL, msg_id BIGINT NOT NULL, conv_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, msg_id)                             -- 上限 1000 应用层校验
);
CREATE INDEX idx_fav_user ON message_favorite (user_id, created_at DESC);

CREATE TABLE sensitive_word (
  id BIGINT PRIMARY KEY, tenant_id BIGINT NOT NULL,
  word TEXT NOT NULL,
  mode SMALLINT NOT NULL DEFAULT 1,                    -- 1拦截 2替换 3审计
  category TEXT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, word)
);
```

### 6.2 客户端 SQLite 本地表（经 IPC，D01 §12.2 规则 5）

```sql
CREATE TABLE local_message (
  conv_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,             -- sending 临时序 -1 递减
  msg_id  TEXT,                         -- ack 后回填
  client_msg_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type    TEXT NOT NULL,
  body    TEXT NOT NULL,                -- JSON
  mentions TEXT, reply_to_seq INTEGER, ext TEXT,
  status  INTEGER NOT NULL DEFAULT 1,   -- 服务端 status
  local_state TEXT NOT NULL DEFAULT 'sent', -- sending/sent/failed（本地态）
  ts      INTEGER NOT NULL,             -- 服务端 ts（展示参考）
  created_at INTEGER NOT NULL,
  UNIQUE (conv_id, client_msg_id)
);
CREATE INDEX idx_lm_seq ON local_message (conv_id, seq);

CREATE VIRTUAL TABLE local_message_fts USING fts5(
  text, conv_id UNINDEXED, seq UNINDEXED, tokenize='trigram'  -- 中文子串（04 §4.7）
);
-- 触发器：INSERT/UPDATE(text)/DELETE 同步 local_message→fts；清理随行删除

CREATE TABLE local_conv (
  conv_id TEXT PRIMARY KEY, type INTEGER NOT NULL,
  name TEXT, avatar TEXT, latest_seq INTEGER DEFAULT 0,
  last_msg_digest TEXT, last_msg_ts INTEGER,
  member_count INTEGER, my_role INTEGER, status INTEGER DEFAULT 1,
  announcement TEXT, receipt_policy INTEGER DEFAULT 0, updated_at INTEGER
);

CREATE TABLE local_conv_state (
  conv_id TEXT PRIMARY KEY,
  pinned INTEGER DEFAULT 0, mute INTEGER DEFAULT 0,
  draft TEXT DEFAULT '', read_seq INTEGER DEFAULT 0, acked_seq INTEGER DEFAULT 0,
  unread_badge INTEGER DEFAULT 0, mention_unread INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0, dirty INTEGER DEFAULT 0     -- 离线变更待回写标记
);

CREATE TABLE outbox (
  client_msg_id TEXT PRIMARY KEY, conv_id TEXT NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT, reply_to_seq INTEGER, reply_digest TEXT,
  state TEXT NOT NULL,                  -- sending/failed
  retry_count INTEGER DEFAULT 0, next_retry_at INTEGER, last_error_code INTEGER,
  created_at INTEGER NOT NULL
);
```

缓存策略：本地默认保留 90 天（可配），按会话 LRU 清理（im_db_prune），FTS 索引随行删除；写入顺序**先落库再渲染**（04 §4.6）。

### 6.3 核心 TS 类型（与服务端 schema 同源生成，存 features/im/model/）

```ts
export type ConvType = 1 | 2 | 3;
export interface Conversation {
  id: string; type: ConvType; name: string; avatarFileId?: string;
  ownerId?: string; latestSeq: number; lastMsgDigest?: LastMsgDigest;
  lastMsgTs?: number; memberCount: number; status: 1 | 2;
}
export type MsgType = 'text'|'image'|'file'|'audio_clip'|'video'
  |'doc_card'|'agent_card'|'merge_forward'|'system'|'call_card';
export type MessageBody =
  | { text: string }                                    // text ≤5000
  | { file_id: string; w?: number; h?: number }         // image
  | { file_id: string; name: string; size: number; ext: string } // file
  | { file_id: string; duration: number; waveform: number[] }    // audio_clip ≤60s
  | { file_id: string; poster_file_id: string; duration: number; size: number } // video
  | { doc_id: string; title: string; format: string; version: number; updater_id: string }
  | { agent_session_id: string; task_title: string; summary_md: string; artifacts: unknown[] }
  | { title: string; count: number; items: MergeItem[] } // merge_forward
  | Record<string, never>;                               // system/call_card
export interface MergeItem { sender_id: string; type: MsgType; digest: string; origin_conv: string; origin_seq: number }
export interface Mention { uid: string; all: boolean; range: [number, number] }
export interface Message {
  msgId: string; convId: string; seq: number; clientMsgId: string;
  senderId: string; type: MsgType; body: MessageBody;
  mentions?: Mention[]; replyToSeq?: number;
  ext?: { reactions?: Record<string, string[]>; reply_digest?: ReplyDigest };
  status: 1 | 2 | 3; editedAt?: number; ts: number;
  localState?: 'sending' | 'sent' | 'failed';           // 仅本端消息
}
export interface ConversationMember {
  uid: string; displayName: string; avatar?: string; deptId?: string;
  role: 1 | 2 | 3 | 4; status: 1 | 2 | 3;
  muteUntil?: number; joinAt: number; online?: boolean;
}
export interface GroupSetting {
  convId: string; joinMode: 1 | 2 | 3; invitePolicy: 1 | 2;
  mentionAllPolicy: 1 | 2 | 3; muteAllUntil?: number;
  historyVisible: boolean; announcement?: string; announcementTs?: number;
}
export interface UserConvState {
  convId: string; pinned: boolean; mute: boolean; draft: string;
  readSeq: number; ackedSeq: number; unreadBadge: number;
  mentionUnread: boolean; hidden: boolean;
}
export interface ReceiptCursor { convId: string; uid: string; deliveredSeq: number; readSeq: number }
export interface OutboxItem extends Omit<OutboxRow, 'state'> {
  state: 'sending' | 'failed'; retryCount: number; nextRetryAt?: number; lastErrorCode?: number;
}
export interface TypingEntry { convId: string; uid: string; expireAt: number } // TTL 5s
```

## 7. 响应式适配（四档逐页）

| 页面 | XL ≥1600 | L 1280–1599 | M 1024–1279 | S 720–1023 |
|---|---|---|---|---|
| PIM-01 | 三栏全展开；消息流可并排引用预览 | 详情栏浮层化（滑出+遮罩，可固定） | 列表栏 56px 图标条悬停抽屉；详情强制浮层 | 列表⇄内容两级导航，左上返回；导航栏保留 |
| PIM-02/03/04 | 气泡最大宽 720px；会话头全功能 | 气泡 max 640px | 气泡 max 78%；@选择器全宽底部面板 | 气泡 max 86%；输入工具栏收"＋"内 |
| PIM-05 | 侧栏常驻 304px | 浮层 360px | 浮层 320px，tab 横向滚动 | 全屏页（返回按钮） |
| PIM-06 | 审批卡常宽 480px | 同 XL | 浮层适配 | 底部抽屉 |
| PIM-07 | 结果三列（过滤/结果/预览） | 两列 | 结果单列+过滤折叠 | 单列；会话内搜索转底部抽屉 |
| PIM-08 | 卡片网格 3 列 | 2 列 | 2 列 | 1 列 |
| PIM-09 | 双栏（分组侧列+列表） | 单栏分组折叠 | 同 L | 同 L |
| PIM-10 | 弹窗 560px 居中 | 520px | 480px | 底部全宽抽屉 |
| PIM-11 | 右抽屉 480px | 440px | 400px 覆盖 80% | 全屏页 |
| PIM-12 | 样式随流宽自适应 | 同 | 同 | 单行截断+点击展开 |

性能响应点（D01 §7.7 在 IM 的落地）：发消息乐观更新（sending 置底）；虚拟滚动+锚点定位（INT-IM-08/13）；图片 240→720→原图三级；会话列表 Query 缓存+WS 精准失效；typing/回执走轻量通道不触发列表重排。断点切换不丢状态（滚动锚点/草稿/多选存 feature store，D01 §5.2）。

## 8. 模块划分（features/im/）

```
src/features/im/
├─ pages/
│  ├─ ImMainPage.tsx            # PIM-01 三栏编排（/im、/im/c/:convId）
│  ├─ ChatView.tsx              # PIM-02/03/04 按 conv.type 分发
│  ├─ GroupManageSidebar.tsx    # PIM-05 四 tab（侧栏/浮层/全屏三形态）
│  ├─ ApplyCard.tsx             # PIM-06 审批卡（会话内+通知中心复用）
│  ├─ SearchPanel.tsx           # PIM-07（全局 Cmd+K 结果区 + 会话内 Cmd+F 浮层）
│  ├─ FavoritesPage.tsx         # PIM-08
│  ├─ NotificationCenterPage.tsx# PIM-09
│  ├─ MultiSelectBar.tsx        # PIM-10a 批量条
│  ├─ ForwardModal.tsx          # PIM-10b 转发面板
│  ├─ MergeForwardDrawer.tsx    # PIM-11
│  └─ systemMessageRegistry.ts  # PIM-12 样式注册表
├─ components/
│  ├─ bubbles/  TextBubble/ImageBubble/FileBubble/AudioBubble/VideoBubble/
│  │            DocCardBubble/AgentCardBubble/MergeForwardBubble/SystemBubble/
│  │            ReplyQuoteBar(引用条)/MentionHighlight
│  ├─ composer/ RichComposer/MentionPicker/EmojiPanel/ScreenshotPreview/ReplyBar/
│  │            VoiceRecorder/SendButton
│  ├─ convList/ ConvListHeader/ConvListItem/PinnedSection/UnreadBadge/DraftTag
│  ├─ stream/   MessageList(virtuoso)/MessageRow/DateDivider/UnreadDivider/
│  │            TypingIndicator/ReadReceiptPanel/ReactionBar/ReactionPicker/
│  │            MsgContextMenu/ScrollToBottomFab
│  └─ panels/   ConvInfoSidebar/MemberList/MemberRowOps/AnnouncementPanel/GroupSettingForm/
│               BroadcastReadOnlyBar
├─ api/
│  ├─ rest.ts                   # API-IM-01~13 封装
│  ├─ ws.ts                     # §5.2/§5.3 事件收发与 ack 关联
│  ├─ hooks.ts                  # Query hooks（key 见 shared/api/keys.ts）
│  └─ search.ts                 # 两态搜索编排（FTS5 ↔ REST 升级）
├─ store/
│  ├─ useImUiStore.ts           # 选中会话/多选模式/浮层开关/滚动锚点
│  ├─ useComposerStore.ts       # 草稿/引用条/@range
│  └─ useOutboxStore.ts         # 发送队列/重试调度
├─ model/                        # §6.3 类型（schema 同源生成入口）
└─ events.ts                     # 对外 bus 事件声明（下表）
```

依赖规则（D01 §12.2）：features/im 不横向 import 其他 feature；跨模块一律 `shared/bus`。登记点：

| 方向 | bus 事件 | 对端模块 | 载荷要点 |
|---|---|---|---|
| 出站 | `im:preview-image` | files(D06) | file_id+消息上下文 → 打开图片查看器 |
| 出站 | `im:open-doc` | doc(D05) | doc_id → WOPI 会话打开 |
| 出站 | `im:open-agent-session` | agent(D08) | agent_session_id → 卡片明细 |
| 出站 | `im:invoke-call` | rtc(D04) | conv_id+成员+音/视频 → 发起通话 |
| 出站 | `im:unread-changed` | app 壳 | 总未读/@数 → 导航徽标+托盘（win_set_badge） |
| 入站 | `files:transfer-progress` / `files:scan-completed` | files | FileCard 进度/⚠态更新 |
| 入站 | `agent:session-shared` | agent | 组装 agent_card 走 msg.send |
| 入站 | `rtc:call-ended` | rtc | 落 call_card 占位（服务端落流为准） |
| 入站 | `doc:updated` | doc | doc_card version/标题刷新 |

服务端归属：message 域（D02 §2），事件总线 topic `msg.created/msg.recalled/conv.updated`；本篇无新增 topic。

## 9. 边界与异常（客户端执行细则，口径见 04 §7）

| 场景 | 处理 |
|---|---|
| 弱网/断网 | outbox 排队；重连成功按序重发（client_msg_id 幂等）；10s×3 → failed+重试菜单；离线可浏览缓存/撰写草稿（六态 offline） |
| seq 空洞 | 不阻塞渲染，后台 GET messages?after&before 补拉；失败 3 次→"消息加载异常，点击重试" |
| 敏感词 | block→failed"包含违禁词"（不回显词）；mask→正常上屏已替换文本；audit→无感知 |
| 扇出降级 | feature flag 下普通群走读扩散路径：列表黄条"未读更新可能延迟"，进会话拉取同广播群 |
| 限频 | 3007 → toast+发送按钮 1s 冷却；@全体 5 次/10min 超限提示 |
| 单聊对方离职 | 会话列表弱化"已停用"；发送返回 2xxx 错误码文案；历史只读 |
| 邀请部分失败 | 批量预检余量；部分成功+失败明细逐条标注（3010） |
| 漫游到期 | gap+fetch_url 翻页"加载更早"；归档分区只读 |
| message-svc 过载 | 降级序自动执行：L2 搜索限流（本地态兜底）→回执 60s 合并→typing 停发；收发最后降级 |
| 被移出/群解散 | conv.updated→强制退出会话视图；历史按 history_visible 只读；forbidden 态呈现 |
| 广播群大未读 | 差值过大（>500）不逐条拉，直接展示"××+ 条新消息，点击查看"入口按需分页 |

## 10. 开放问题

1. **user_conv_state 写接口**：04 篇定义了该表与"草稿多端同步"但未定义写接口；本篇提案 API-IM-13 `PATCH /convs/{id}/state` + `conv.updated(kind=state)` 推送本人多端，**待回填 04/14 篇登记后生效**。
2. **收藏超限错误码**：04 篇"每人上限 1000 条"无专用码；暂映射 9001，建议新增 3022 登记 14 篇。
3. 群已读 >200 人群是否仅显示计数不展开名单（04 §9-1）：API-IM-06 已按"名单截断"预留，策略待定。
4. 收藏分类文件夹（04 §9-2，当前平铺+筛选+搜索）；>5,000 人"频道"模型与广播群合并或并存（04 §9-3）。
5. typing 群聊默认关闭的最终口径（04 §9-4）：本篇按"默认关、能力就绪"实现，开关归租户策略；单聊"免回执"细粒度开关与租户审计冲突（04 §9-5，15 篇评估）。
6. 置顶上限 30 超出时的交互（替换最旧 or 拒绝）——联调时定。
7. PIM-09 通知中心路由现挂 `/im/notifications`；doc/kb/agent 审批通知复用时是否上移 app 层共享路由，D05/D07/D08 联裁定。
8. 合并转发详情按 origin_conv 拉快照时，成员已退群/解散场景的可见性规则细化（现按条目置灰处理）。
