# BaobaoChat 开发执行计划（v0.1 收尾 → 阶段四）

> 生成：2026-11-09。依据：18 篇开放问题清单（🔴 P0 设计层已清零）、00 篇 §8 里程碑、
> client/src/features 全模块完成度核查（2026-11-09）、P0 收尾五件套清单。
>
> **用法**：从 A 批起自上而下逐项做；每项完成后跑 `make verify`（四栈门禁+冒烟），
> 涉及服务端存储的加跑 `make verify-server-pg`；完成打 `[x]` 并注日期。
>
> **⚠ 2026-11-10 瘦身二阶段（产品范围收口）**：音视频通话（rtc/LiveKit）、会议（meeting）
> 域与文件分享外链整体移除；主打收口「Agent + Agent 插件 + 本地 claude code/zcode 委派 + 日常聊天」。
> 随之关闭：B1-B4 全部（LiveKit 镜入 Harbor/nginx /rtc/ 真机/getDisplayMedia/frp 回归——对象已不存在；
> frp 随移动端+外网接入正式关闭）、E3 双人审批、E8 提示注入闸门实测、E9 会议纪要、E10 20k 压测。
> 孤儿表清理见迁移 0035；删除前快照 `backup/full-suite-20261109`。
>
> **⚠ 2026-11-17 bbw→bbc 全仓改名（清 baobao-work 旧名残留）**：全仓 bbw/BBW→bbc/BBC
> （env 前缀 ~110 名、wire 值：AI 别名 bbc-fast 等/_meta.bbcObo/X-BBC-* 头/MCP serverInfo 与工具
> bbc_agent_chat、cookie/JWKS kid/client_id 前缀、深链 scheme `bbc://`（推翻 D31 该项锁定，见其篇内追记）、
> 部署资源：PG bbc 库/桶 bbc-data/helm chart bbc/K8s 对象 bbc-*、客户端持久化键 bbc-*、
> CSS 令牌 --bbc-*、CLI bin `bbc`/`bbc ask`）。**零兼容硬切**：老数据（IndexedDB bbw-local/备份
> verifier/checkpoint refs/bbw-agent/旧插件包/浏览器会话）全部作废；**存量环境推倒重建**（compose down -v
> + K8s 重建，.env 已 sed 保值换名）。批：a507277(前端)/7df04cf+fd76230(服务端)/7d29e64(agent+壳+CLI)/
> cae99df(部署+品牌)/本批(文档)。bbrt 家族名不动（bb=baobao 非 baobao-work）。
> 开发注意：tauri dev 改带 `BBC_RT_GATEWAY`；PG 集成门禁 env 改 `BBC_PG_TEST_DSN`。

---

## 批次 A：v0.1 发布收尾——仓库侧编码（不依赖外部环境，可立即开工）

> **2026-11-09 A1–A6 全部完成**。验收记录：
> - A1：`docker compose --profile core --profile media config` 渲染 exit=0 无未定义变量告警 ✓（顺带退役 coturn 旧键 BBC_TURN_*，补 BBC_LIVEKIT_IMAGE/URL/API_KEY/SECRET/ICE 五键）
> - A2：`py scripts/check-helm-static.py` 全过 ✓；deployment-media 重写为 livekit-server 形态（LIVEKIT_KEYS/TURN/webhook env、tcpSocket 探针），配套 app 侧 BBC_LIVEKIT_API_KEY/SECRET（deployment-app）+ BBC_LIVEKIT_URL/ICE（configmap）、secrets turnSecret→livekitApi*、values media 段对齐
> - A3：D17 行已入 detail/README 索引表 ✓
> - A4：externalBin 经 `tauri.macos.conf.json`/`tauri.linux.conf.json` 平台覆盖声明（Windows 侧 bbrt 编不过不随包——既定限制）；build.rs 注入 triple；`resolve_bbrt_bin()` 增生产 exe 同目录 `bbrt-<triple>` 解析（agent_bridge.rs，含单测）；`scripts/prepare-bbrt-sidecar.sh` + `make agent-sidecar`（<30MB 门禁+Windows 守卫）；src-tauri cargo check ✓ fmt ✓。**包体体积与随包拉起验收随 macOS 端（B3 同机）**
> - A5：tauri-plugin-updater 条件注册（pubkey 空=禁用+启动提示，不阻塞）；tauri.conf.json plugins.updater + endpoints 指向 `/update/latest.json`；capabilities `updater:default`；`deploy/compose/updates/latest.json.example` 标准 manifest 样例；compose README 补双轨 manifest 说明。**签名密钥生成后填 pubkey 即启用（CI/用户侧）**
> - A6：compose 内联 nginx `/rtc/` 加 `rewrite ^/rtc/(.*)$ /$1 break;`；本地 stub 后端实测 `/rtc/rtc`→`/rtc`、`/rtc/rtc/validate`→`/rtc/validate`、WS Upgrade 透传 200 ✓（测试环境已清理）。**真机（compose 主栈部署机）验证在 B2**
> - 批级门禁：client tsc/build ✓、src-tauri cargo check+fmt ✓、helm 静态 ✓、compose config ✓；verify-server/smoke 本机无 Go 跳过（未动 server 代码）；cargo test 二进制本机被 Defender 拦截执行（os error 5，环境级），单测随 macOS/CI 端执行
> - 遗留对齐：本机无 make/go，后续 verify 逐栈手动执行或装工具链

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| A1 | `.env.tpl` 补登记 livekit 四变量 | `deploy/.env.tpl`：`BBC_LIVEKIT_IMAGE/URL/API_KEY/SECRET`（compose 已引用未登记） | compose config 渲染无未定义变量告警 | [x] |
| A2 | Helm 媒体面镜像切换 | `deploy/helm/.../deployment-media.yaml`：bbc-media 占位 → livekit-server（引用 `BBC_LIVEKIT_IMAGE`） | `python scripts/check-helm-static.py` 过；镜像字段非旧 bbc-media | [x] |
| A3 | D17 登记 detail 索引 | `docs/detail/README.md` 文档索引表补 D17 行 | 表内 D01–D17 齐全 | [x] |
| A4 | bbrt 随包分发（externalBin） | `src-tauri/tauri.conf.json` 补 `externalBin`；`resolve_bbrt_bin()` 增生产 exe 同目录解析；打包脚本按 `binaries/bbrt-<target-triple>[.exe]` 命名备二进制 | 打包产物含 bbrt 且随 app 启动拉起成功；包体 <30MB（16 篇 L370） | [x] 仓库侧（包体验收随 macOS 端） |
| A5 | updater 接线（代码侧） | `src-tauri`：加 tauri-plugin-updater 依赖+`plugins.updater` 配置（公钥占位待用户密钥）；update manifest 结构与 bbc-update-src 占位 nginx 落地 | 无签名密钥时更新检查优雅失败；manifest 样例可被 updater 解析 | [x] 仓库侧（密钥后启用） |
| A6 | nginx `/rtc/` 反代 rewrite（预置） | `deploy/` nginx conf 加 `location /rtc/ { rewrite ^/rtc/(.*)$ /$1 break; ... }`（预判 JS SDK 拼 `/rtc/rtc` → 404） | 本地 nginx 起 stub 后端，curl WS Upgrade 打 `/rtc/rtc` 路由可达 | [x] 本地 stub 实测过（真机随 B2） |

## 批次 B：v0.1 发布验证——部署机/真机（需用户环境配合）

| # | 事项 | 说明 | 验收 | 状态 |
|---|---|---|---|---|
| B1 | livekit 镜像入 Harbor | ~~随 rtc 域移除关闭（2026-11-10）~~ | — | [x] 关闭（rtc 域移除） |
| B2 | nginx `/rtc/` 反代真机验证 | ~~随 rtc 域移除关闭（/rtc/ 路由已撤）~~ | — | [x] 关闭（rtc 域移除） |
| B3 | WKWebView getDisplayMedia 真机测试 | ~~随 rtc/meeting 域移除关闭（屏幕共享不再存在）~~ | — | [x] 关闭（rtc 域移除） |
| B4 | frp 隧道指向切换 + 双端回归 | ~~随外网接入正式关闭（2026-11-10，移动端+外网方向不再挂账）~~ | — | [x] 关闭（外网接入关闭） |

## 批次 C：🟡 P1 裁决落地（阶段一开发期内定，小项为主）

> **2026-11-09 C 批 13/13 清零**（C6 当日专项落地）。验收记录：
> - C1 ✅ typing 群聊默认关：MessageInput 加 `typingEnabled` prop（ChatPage 传 `type===1` 单聊才发）
> - C2 ✅ 已读仅计数：服务端 `receiptPanelMemberLimit=200`（DTO 加 truncated/readCount/unreadCount）+ 前端计数卡；单测 `TestListReceiptPanelTruncated`（200 边界不截断/201 截断）
> - C3 ✅ 置顶超 30：错误码 3023 + repo `CountPinned`（memory/pg）+ service 校验（重复置顶幂等）+ 前端 3023 回滚乐观态+ann-banner 提示；单测 `TestPinnedLimit`；14 篇错误码表回填
> - C4 ✅ 通知中心上移：`/notifications` 全局路由（旧路径 redirect）+ MainLayout 铃铛入口+未读徽标 + 返回键 navigate(-1)
> - C5 ✅ 零改动收口：IM 内嵌 Agent 卡未实现（D03/D08 阶段二项），无 run_command 通路——随内嵌卡实现时按 B08 白名单落
> - C6 ✅ 云备份零知识全链（OQ-B09）：**服务端** 迁移 0025（agent_session_backup+envelope 列+幂等 UK+RLS）+ 新域 internal/agentbackup（repo 双实现 lock 9132/service：密文本地盘原子落盘+回滚、120s 一次性票据、Idempotency-Key 幂等、32MB 密文上限）+ main 5 路由（POST/GET/restore-ticket/blob/DELETE；create handler 48MB body 通道绕过 decodeJSON 1MB 上限）+ service_test（CRUD/幂等/票据一次性/越权/校验）；**前端** shared/utils/backupCrypto.ts（WebCrypto：PBKDF2-SHA256 210k 双通道 KEK wrap DEK+verifier+6×4 恢复码 120bit）+ agent/api/backup.ts + 设置页 CloudBackupCard（设口令→恢复码一次展示→备份全部→列表/恢复导出 JSON/删除→本机 DEK 缓存+清除→跨设备恢复码解包）；v0.1 取舍：备份体=壳侧会话快照（事件级导出随 RT 协议扩展登记）；client tsc+build ✓、Go 待 CI
> - C7 ✅ 零改动收口：部门群联动机制未实现（user.dept_changed 扇出无 message 消费方），行为天然 manual——随联动实现取默认 manual
> - C8 ✅ 零改动收口：legacy（doc/xls）转换路径不存在（WOPI/onlyoffice 阶段二）——随接入时落确认弹层
> - C9 ✅ 裁决回填：06 篇 §423 注记 B17 拍板（默认 50 租户可配 10–200；协作会话机制未实现，随 WOPI 接线）
> - C10 ✅ 通话记录本端隐藏：RecentCallsPage 隐藏按钮（localStorage 集合过滤）+ footer 审计保留文案（B18）
> - C11 ✅ 零改动收口：扫描等待 UI 不存在（scan_status v0.1 恒 clean，扫描服务阶段二）——随扫描接入时挂通知中心回推
> - C12 ✅ 撤回文件锚点：迁移 0024（file.msg_seq+recalled）+ repo 双实现 `MarkSent(msgSeq)`/`MarkRecalledByMsg` + main 订阅 msg.recalled 联动 + FileDTO 透出 + 群文件「定位」按钮（recalled 置灰 + 提示）；单测 `TestMsgRecalledAnchor`
> - C13 ✅ 挂断并接听端侧：rtcAccept 加 bye_call_id + rtcStore `callWaiting` 等待条态（INT-RTC-16：不弹窗不响铃）+ answer/dismiss 动作 + applyState 终态收起 + RtcOverlay 渲染 [拒接][挂断并接听]
> - 批级验证：client tsc/build ✓；Go 测试代码就绪待 CI/macOS 执行（本机无 Go）

| # | OQ | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|---|
| C1 | B03 | 群聊 typing 默认关 | 核实 im 设置现状，未关则改默认 | 新群默认无 typing 事件 | [x] |
| C2 | B04 | >200 人群已读仅计数不展开名单 | im 已读面板：名单截断 API（已预留）+「仅计数」展示分支 | 大群面板显示计数，请求量受控 | [x] |
| C3 | B06 | 置顶超 30 拒绝+提示 | 前端 toast + 服务端校验 | 第 31 个置顶被拒并有提示 | [x] |
| C4 | B07 | 通知中心上移全局 `/notifications` | 新全局路由，doc/kb/agent 审批复用同一中心 | 三域通知在同一中心聚合展示 | [x]（doc/kb kind 随域接入扩展） |
| C5 | B08 | IM 内嵌 Agent 卡不放开 run_command | 核实内嵌卡工具白名单 | 内嵌卡无 run_command 通路 | [x] 零改动（卡未实现） |
| C6 | B09 | Agent 会话云备份：口令派生+恢复码 | 加密备份链路（较大项，可拆独立排期） | 跨设备凭恢复码恢复会话 | [x] 2026-11-09 落地（零知识全链：见批头注记） |
| C7 | B15 | 部门群联动默认 manual | 核实 D12 默认值 | 异动不自动进/退群 | [x] 零改动（联动未实现） |
| C8 | B16 | legacy 格式转编辑：确认+损失提示 | doc 打开 doc/xls 时确认弹层 | 用户确认后才转编辑 | [x] 零改动（WOPI 阶段二） |
| C9 | B17 | 并发编辑上限默认 50、租户可配 10–200 | 服务端配置项 + admin 租户配置入口 | 51 人被 6002 拒；租户改配生效 | [x] 裁决回填 06 篇（机制随 WOPI） |
| C10 | B18 | 通话记录「删除我的一段」仅本地视图 | rtc 记录页本地删除+文案明示审计保留 | 本端不可见、他端仍可见 | [x] |
| C11 | B22 | 扫描等待「稍后提醒我」 | 依赖 C4 全局通知中心；通知中心回推 | 到点收到提醒通知 | [x] 零改动（扫描未接入） |
| C12 | B24 | 群文件页对已撤回消息文件锚点兜底 | 文件保留、锚点置灰不可跳转 | 撤回后文件在、跳转禁用 | [x] |
| C13 | C06 | 端侧「挂断并接听」busy 配套 | 被叫忙自动放行 + INT-RTC-16 toast（服务端 bye_call_id 原子化已落地 2026-11-07） | 忙线来电一键切换成功 | [x]（真机验收随 B2） |

## 批次 D：阶段二功能补全（内容与会议——按 2026-11-09 完成度核查缺口）

### doc 在线文档（已移除）

> **2026-11 瘦身**：文档中心（doc 域）整体移除（产品定位聚焦 Agent）——D1 文件夹树/D2 协同编辑/D3 分享三项目连代码一并删除，验收记录见 git 历史（`backup/full-suite-20261109` 快照含 D1/D3 全量落地记录）。migrations 0026/0027 保留（历史数据）。

### kb 知识库

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| D4 | 空间授权/成员管理 | 全新 UI+API（现零实现：kb/ 目录无 perm/acl/member） | 空间成员可增删、权限生效 | [x] 2026-11-09 落地（复用 resource_acl/aclSvc 经闭包——见批头注记） |
| D5 | dept 空间接入收口 | 接入部门空间；或先移除新建表单 dept 选项保持一致 | 列表标注与表单行为一致 | [x] 收口为口径对齐（dept 建空间/分组/部门授权生效全链已通——DeptIDsOf 已接 user_dept；过时注释×2 修正） |
| D6 | 摄入任务面板 | 启用死代码 `kb/api/hooks.ts useJobs` | 摄入任务进度可见、失败可重试 | [x] 2026-11-09（KbPage [任务] 面板：processing/failed 两流+失败重试接 reingest） |

### admin 管理后台（现 13 页无空壳，但多处只读）

> **D4/D5/D6 验收记录（2026-11-09）**：
> - D4：**复用既有 resource_acl 基建**（0017 表+org/acl 服务，aclResolve 桩已回填）——kb Options 加 ACLGrant/ACLListGrants/ACLRevoke 三闭包（main 装配转 aclSvc，resourceType="kb.space"，治理者=owner_id 或 perm≥4，owner/admin 折叠映射 11 §2.4）；service ListGrants/AddGrant（perm 合法集 1/3/4、过期校验）/RemoveGrant；3 路由 /kb/spaces/{id}/grants（区别于 /admin/acl 平台管理员入口）；测试 TestKBGrants（治理者校验/授权后 canRead+canWrite 放宽/perm 非法/列表/撤销）。前端 kb.ts 三 API+GrantModal（对象类型/角色/30 天有效期+过期置灰+撤销+7002 只读态）+KbPage [授权] 入口；user/dept 检索选择器随通讯录组件登记。v0.1 无转让故 7011 不触发（owner_id 治理锚点恒在）。
> - D5：核查发现 dept 空间能力已全通（CreateSpace 支持+分组渲染+DeptIDsOf 已接 user_dept 部门展开实时生效）——收口=修正两处过时注释（main.go acl 装配段+KbPage GROUPS）。
> - D6：useJobs 启用——KbPage 工具条 [任务(N)] 折叠面板（processing 流+failed 流带错误摘要+重试接 useReingest）；client tsc/build ✓。
| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| D7 | Agent 工具策略可编辑 | agent_tool_policy 表 + PoliciesPage 只读 JSON → 编辑器 | 策略改后 Agent 工具门面受控 | [x] 2026-11-09（见下注记；生效链路=阶段二 agent.policy.updated 热更） |
| **D7 验收记录（2026-11-09）**：迁移 0028（agent_tool_policy 行级：UK(tenant,subject)/allowed/risk_override/config/RLS——贴 09 §5.2 DDL）；repo ToolPolicyRepo 双实现（lock 9133、Upsert ON CONFLICT 覆盖）；service AgentPolicy 重写为合成快照（default+行覆盖：builtin/app:* 分桶、risk_override JSON 合并、source 切 table、rows 透出）+ UpdateAgentToolPolicy（subject 白名单字符校验、allowed 指针显式 false、risk/config JSON 对象校验）+ DeleteAgentToolPolicy（回落默认、9002）；PUT/DELETE /admin/policies/agent/tools（requirePerm admin:policy:manage）；测试 TestAgentToolPolicy（覆盖合成/risk 合并/app 命名空间/非法字符/非法 JSON/删尽回 default/删不存在 9002）。前端 PoliciesPage 编辑器（内置四行开关+已覆盖徽标+恢复默认+自定义 subject 添加+快照 JSON 折叠）；client tsc/build ✓。bbrt 工具门面消费与 agent.policy.updated 热更随 Agent 域阶段二（登记）。
| D8 | KB 治理写操作 | 空间停用/删除；deny 检索过滤+「部分结果被策略隐藏」合规文案（OQ-D10） | 治理操作生效、deny 命中文案可见 | [x] 2026-11-09（见 D7 注记后追加；deny v0.1 落点=停用过滤+提示） |
| **D8 验收记录（2026-11-09）**：repo SetSpaceStatus/DeleteSpace（级联 chunk/doc/node 四表+bySpace；PG 显式删——0009 无 FK）+ kb service canRead 补 Status 挡（**修缺口：archived 空间原可检索**）+ Query filtered_hint（OQ-D10：可见集<全集→"部分结果被策略隐藏"，不逐条归因）+ GovernSetSpaceStatus/GovernDeleteSpace（personal 7010）；admin 闭包 KBGovern 转调 + 3 路由（archive/activate/DELETE，admin:kb:govern）+ KBSpaceRow/Closure 透 status；测试 TestKBGovernance（停用即刻 7002+检索不命中+指定空间 7002/启用恢复/级联删/7010/filtered_hint）。前端 KbGovernancePage 状态列+停用/启用/删除（confirm+级联警示）+ KbPage 检索黄条；client tsc/build ✓。
| D9 | killswitch 强制力 | AgentGovernancePage 标记位 → OBO 签发闸门真实拦截 | killswitch 后新 OBO 签发被拒 | [x] 2026-11-09（双点：签发 1013+网关 503，见 D10 注记前） |
| **D9 验收记录（2026-11-09）**：错误码 1013 CodeAuthOBOKillswitch；**双点拦截**——① auth IssueOBO 签发闸门（Options.AgentKillOn 闭包，on→1013 拒签）② aigw HandleChat/HandleEmbeddings 每请求闸门（Gateway.agentKillOn，IsOBO 请求 on→503+1013+Retry-After 30s；非 OBO/管理员直连不受影响——存量 OBO token 也拦）；main 前置 var agentKillOn + adminSvc.AgentKillOn 回填（auth/aigw 两闭包捕获引用）；测试 TestOBOGateKillswitch（dev 放行/OBO 503+1013/off 恢复）+ TestIssueOBOKillswitch；AgentGovernancePage 确认弹层与状态文案更新。killswitch 内存态为 v0.1 既定取舍（多实例/持久化随阶段二，与 D8 注记同口径）。
| D10 | 组织挂人+范围授权 | OrgTreePage user_dept 挂人；RolesPage scope 部门范围授权（D12 阶段二） | 用户挂多部门；角色按部门范围生效 | [x] 2026-11-09（scope 判定引擎 S5 随授权消费方接线，登记） |
| **D10 验收记录（2026-11-09）**：org repo 补 DetachUser（primary 卸载→剩余最小 dept_id 接任/卸尽清空，幂等）+ListDeptUsers 双实现；orgapi DeptMembershipReaderWriter 接口；admin 3 路由 /admin/org/depts/{id}/members（GET/POST/DELETE，admin:org:manage；成员名经 orgMod.API GetUser）；GrantRole 全链 scope 透传（UserRole 模型 ScopeType/ScopeDeptID→PG INSERT $5/$6+ListUserRoles 回读→service 四档校验（2/3 须 deptID；缺省 4 全租户与 v0.1 兼容）→handler req→审计字段）；测试 TestUserDeptDetachAndDeptUsers+TestGrantRoleScope。前端：OrgTreePage 成员区（Users 图标展开懒加载/主部门徽标/挂入（设主部门勾选）/移出 confirm）；RolesPage 授予范围四档下拉+部门 ID 输入+授权行范围徽标；client tsc/build ✓。**S5 判定引擎**（scope×资源 owner 部门 path 收敛→2002）随首个按范围收敛的权限点消费方接线（现全部权限点为全租户语义，登记）。
| D11 | 导入增强 | ImportPage Excel 解析（xlsx）；首登强制改密 | Excel 导入成功；首登改密流程通 | [x] 2026-11-09（见下注记） |

### settings 设置中心（现仅主题+Agent 真实）

> **D12 验收记录（2026-11-09）**：迁移 0030（user_notify_pref：PK user+三项+RLS）；messagerepo NotifyPrefRepo 双实现（notify_pref.go：Get 无行 nil/Set upsert ON CONFLICT）；message Options.NotifyPrefs 注入 + GetNotifyPref（无行归一默认双开+off）/SetNotifyPref（dnd 合法集校验）；GET/PATCH /me/notify-pref；测试 TestNotifyPref（默认/upsert 回读/非法 dnd 9001）。前端 settings/api/notifyPref.ts + NotificationSettingsPage 重写（useQuery+乐观更新失败回滚+六态，ServerDrivenNote 退役）；**消费点接通**：notify.ts notifyAgentDone 前查偏好（60s 内存缓存/失败放行）——msg_notify 总开关+免打扰时段（all-day 恒/work-night 22-08 跨夜本地时区）静默系统通知（红点保留）；client tsc/build ✓。

> **D11 验收记录（2026-11-09）**：**Excel**——前端 SheetJS（xlsx@0.18.5）：ImportPage 文件选择（.xlsx/.xls/.csv）→ 首表解析（表头行启发跳过）→ 与 CSV 同一行集管线（预览/提交同 API）。**首登改密全链**——迁移 0029（users.must_change_password）；org User 模型透出+SetPassword 双实现（userCols/INSERT/UPDATE 清位）；admin 导入置位（测试断言）；auth Options.UserSetPassword 闭包（不动 New 签名）+ChangePassword（旧密码 1001/规则 ≥8 位含字母数字/不得同旧→HashPassword→清位）+Login 响应 user.must_change_pwd；路由 POST /me/password（authed）；前端 AuthUser.must_change_pwd+store.changePassword+LoginPage 二步改密表单（token 已发但本页拦截）+RequireAuth mustChange 全路由守卫拦回 /auth；测试 TestChangePassword（1001/规则/改密后新旧密码登录翻转）。client tsc/build ✓、Go 测试待 CI。
### settings 设置中心（现仅主题+Agent 真实）
| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| D12 | 通知设置服务端持久化 | NotificationSettingsPage 本地 useState → 服务端驱动（现明示纯骨架） | 换端设置保留 | [x] 2026-11-09（见上注记） |
| D13 | 传输设置接线 | 限速 Select 挂 onChange 真下发；下载目录接 Tauri FS（去硬编码 `~/Downloads/BaobaoChat`） | 限速生效；目录可选且持久 | [x] 2026-11-09（偏好持久化+dialog 目录选择；限速/落盘消费随 Rust 传输引擎，登记） |
| D14 | 快捷键设置页 | 新页面（现不存在）；自定义键位映射 | 改键后新键位生效 | [x] 2026-11-09（D01 §9 速查表+生效态标注；自定义随全局快捷键框架，登记） |

### mail / expert / 全局

> **D13/D14 验收记录（2026-11-09）**：D13——shared/store/transfer.ts（设备偏好 localStorage 持久化，主题同款口径）+ TransferSettingsPage 重写（限速 Select 挂 onChange 真下发 store/下载目录 tauri-plugin-dialog 目录选择器——Cargo/capabilities/lib.rs/npm 四处接线 cargo check ✓，浏览器降级文本输入）；限速分块节流与落盘消费随 Rust 传输引擎（02 篇设计本位，fetch/XHR 无原生限速）。D14——ShortcutSettingsPage（D01 §9 权威总表渲染+已生效/规划中状态标注+平台键位自适应 ⌘/Ctrl）+ SettingsLayout/App 路由接线；自定义改键随全局快捷键框架（onKeyDown 收敛统一注册表）。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| D15 | 写信附件 | ComposeModal Paperclip → 文件域上传引用（/files/upload） | 发信带附件、收端可下载 | [x] 2026-11-09（服务端 SendReq.Attachments 本就绪；前端 uploadFileSmart+附件列表+移除） |
| D16 | 自动转发执行+草稿箱 | 服务端定时执行转发；草稿保存/续写流程 | 转发到点发出；草稿可恢复 | [x] 2026-11-09（投递钩子同步转发+防环；drafts/trash 全链+续写） |
| D17 | 专家库→发起会话 | ExpertLibraryPage 接 agent_* 宿主建会话（现「阶段二」注释） | 从专家卡一键开工作台会话 | [x] 2026-11-09（详情抽屉入口；persona 注入随 expert_id 参数阶段二，登记） |
| **D15/D16/D17 验收记录（2026-11-09）**：D15——ComposeModal 附件全链（uploadFileSmart 多选上传→file_id 引用列表（大小/移除）→SendReq.attachments 携带；服务端 9024 校验/投递透传本就绪）。D16——**自动转发**：internalSend 投递成功后查收件人 settings.auto_forward → 副本投递（Fwd: 前缀；autoFwdMarker 防环封顶一层；转发地址无效静默）；**草稿**：SaveDraft（FlagDraft bit2/drafts folder/更新=旧行入 trash）+DiscardDraft（发送后清理）+POST/DELETE /mail/drafts；前端存草稿按钮（返回新 id 续存）+草稿箱行点击续写（draftInit 重开窗）；测试 TestAutoForward（副本+防环）+TestDrafts（存/更/清理）。D17——专家详情抽屉 [用此专家开会话]（manifest model: 行→直达引用透传，useAgentStore.startSession('ask',model)→/agent/s/:id）；persona/skills 注入随宿主 expert_id 参数阶段二。client tsc/build ✓。
| D18 | mock 默认翻转+真实联调 | `VITE_USE_MOCK === '1'` 显式开桩（默认连真实后端）；全模块真实模式回归（StickersPage 建集 disabled、admin 写操作 9001 等随之解决） | 默认构建连真实 server 全功能可走通 | [x] 2026-11-10 翻转落地（11 处 USE_MOCK 判定+注释+client/.env.tpl 语义更新；服务端联调回归随真机） |

## 批次 E：阶段三/四路线（Agent 生态与平台化——做时再细化设计）

| # | 事项 | 来源 | 状态 |
|---|---|---|---|
| E1 | 生态应用注册与同步（D09 发布向导） | 00§8 阶段三 | [x] 2026-11-09（v0.1 直发+manifest 注册制；审批/灰度/签名链随 E2/E3） |
| **E1 验收记录（2026-11-09）**：迁移 0031（eco_app/version/install 三表+RLS）；AppRepo 双实现（lock 9135；版本线/发布/安装 upsert）；service app.go（注册校验 app_id/semver/manifest JSON→首版 draft / 版本线 / Publish 直发+current_version / Delist / **Catalog 差异**（install/upgrade/noop/revoke 四态+manifest 随发）/ Install 锚定发布版 / MyInstalls）；路由 admin 6（admin:app:publish）+ user 4；eco Service 加 apps 字段（New 扩参）。前端 features/eco 首建（AppStorePage catalog 卡流四态+安装/升级/卸载；MainLayout「应用」入口）+ admin EcoAppsPage（登记表单/版本线追加发布/下架）；测试 TestEcoAppLifecycle 全链。**登记**：C 档审批/灰度/签名链→E2/E3；app.updated/revoked WS 推送+tools.reload 热加载随宿主命令阶段二。client tsc/build ✓、Go 测试待 CI。
| E2 | 灰度体系：canary 百分比+白名单豁免（OQ-B13） | 依赖 E1 | [x] 2026-11-09（确定性放量 uid%100<pct+白名单 100% 豁免；Catalog 收敛+Install 闸门） |
| **E2 验收记录（2026-11-09）**：迁移 0032（eco_rollout：UK(tenant,app)+canary 0-100 CHECK+whitelist JSON+RLS）；RolloutRepo 双实现（Upsert ON CONFLICT/Get 无行 nil）；service SetRollout（pct/白名单 ≤1000/版本归属校验）+GetRollout（无行=100 全量默认）+**inRollout 判定**（白名单 100% 豁免→uid%100<pct 确定性，无抖动）；**Catalog 收敛**（未入灰度未装=不透出防探测、未入灰度已装=noop 保持不推升级、入灰度=install/upgrade 照常）+**InstallApp 闸门**（防直调绕过 9002）；PUT/GET /admin/eco/apps/{id}/rollout；EcoAppsPage 版本行[灰度]面板（canary %+白名单 uid 列表，读改存）；测试 TestEcoRollout（pct 非法/跨应用版本 9001/灰度内外/白名单豁免/0% 已装保持 noop/全量恢复）。client tsc/build ✓。
| E3 | 版本回滚 C 档双人审批（OQ-B12） | ~~关闭（2026-11-10 范围收口：单人直发维持 v0.1 形态）~~ | — | [x] 关闭 |
| E4 | 技能市场（租户内）+预置技能安装 | 00§8 阶段三/四 | [x] 2026-11-09（市场+三档策略落地；预置技能包内容随运营录入；多版本线/回滚随 E3） |
| **E4 验收记录（2026-11-09）**：迁移 0034（eco_skill：skill_id UK+policy 三档+manifest 覆盖式版本+RLS；eco_skill_install UK(user,skill)）；SkillRepo 双实现（lock 9137）；service（发布校验 skill_id/semver/policy→draft 即上架 / UpdateSkill 覆盖升版 / **SkillCatalog**（published+安装态+升级 manifest 下发）/ InstallSkill 锚定发布版 / **UninstallSkill force 档拒**（10 §4.5 强制技能不可自卸）/ MySkills）；路由 admin 4+user 4；测试 TestSkillMarket（非法三态 9001/重复 9001/force 卸载拒/升级 manifest/下架消失/我的安装集）。前端 admin SkillsPage（发布表单三档下拉/覆盖升版/下架）+ /apps 商店**双 tab**（SkillTab：force 徽标+卸载按钮按 policy 隐藏——服务端同拒兜底）；eco Service/New/NewModule 四参（E1/E2 测试 ctor 对齐）。**登记**：admin:skill:publish 字典入册收紧守卫；多版本线与回滚 C 档随 E3；预置技能包（运营内容）随上线录入；tools.reload 随宿主阶段二。client tsc/build ✓、Go 测试待 CI。
| E5 | MCP 二期试点（kb_query+doc_read 只读工具，OQ-B26） | D14 | [x] 核实已落地（2026-11-09 全链核查——mcpgw 一期实现时已含试点两工具，计划状态陈旧；见下注记） |
| **E5 核实记录（2026-11-09，未重复实现）**：OQ-B26 两试点工具在 mcpgw 一期（D14 决策⑤ 2026-11-07"公司域能力统一经服务端 MCP 网关供给"）落地时已含——①服务端 `invokeKbQuery`（keyword/top_k 校验+KBQuery 闭包+业务失败 isError 语义）/`invokeDocRead`（doc_id 校验+owner 校验在 doc 域）+corpTools 注册表（risk=low）+main 闭包装配；②测试 TestCallKbQueryHappyPathBearer/MetaOboFallback（Bearer/_meta.bbcObo 双通道+审计 act 归因断言）+供给 6 工具断言；③**Runtime 侧 MCP client（agent/crates/bbrt-mcp）**：stdio+HTTP 双 transport、connect（initialize+tools/list→`mcp.{server}.{tool}` 命名空间化）、call（bbcAct 归因）、policy 过滤、`BBC_RT_MCP_SERVERS="corp=http://…/mcp/corp"` bootstrap（main.rs，含单测）；④smoke：scripts/e2e/mcpgw-smoke.sh（本机无 Go 未跑，CI 通道）。
| E6 | 个人知识库 | 00§8 阶段三 | [ ] |
| E7 | 内嵌卡增强：20 轮上限/Cmd+F 前缀索引/紧急停止主窗+系统 toast（OQ-C30） | D08 | [x] 2026-11-09（Cmd+F+紧急停止多屏落地；20 轮随内嵌卡本体——D08 阶段二，登记） |
| **E7 验收记录（2026-11-09）**：**Cmd+F**——ChatPage 键位别名（Cmd+K 全局/Cmd+F 会话内同面板，preventDefault 覆盖浏览器查找）；OQ-C30"前缀过滤"=裁决维持工具名/文件名/文本前缀过滤、不做 agent_event 全文索引（D08 §686 开放问题就此收口）。**紧急停止多屏**——App 壳层 `useEmergencyStopHotkey`：⌘⇧./Ctrl+Shift+.（含中文输入法'。'兼容）任意路由触发 agent store emergencyStop → 主窗 toast（antd message 经 bbc:toast CustomEvent）+ 系统通知（notify.ts 抽通用 `sendSystemNotification`，notifyAgentDone 改偏好闸门+委托复用；紧急语义优先于 D12 免打扰闸门——不 currentPref 拦截）双通道（覆盖最小化/他屏场景）。**20 轮上限**——内嵌卡本体未实现（C5 同口径），随 D08 内嵌卡阶段二。client tsc/build ✓。
| E8 | 提示注入小模型闸门 A/B 实测（OQ-D06）；AppLocker/WDAC 模板（OQ-D11） | ~~关闭（2026-11-10 范围收口）~~ | — | [x] 关闭 |
| E9 | 会议纪要等深度 AI 场景 | ~~随会议域移除关闭~~ | — | [x] 关闭（meeting 域移除） |
| E10 | 20k 用户规模压测优化 | ~~关闭（小团队定位，暂不做规模压测）~~ | — | [x] 关闭 |
| E11 | 开放 API（复用 20 篇 Outgoing 订阅框架，G8） | 00§8 阶段四 | ~~已移除~~ 2026-11 瘦身：bot 域（Outgoing Webhook 底座）随文档中心一并移除，验收记录见 git 历史 |
| **E12 验收记录（2026-11-09）**：`shared/i18n`（**零运行时依赖**——字典即模块，装包克制）：locale 三态 zh-CN（默认）/en/system（navigator.language 解析），localStorage('bbc-locale') 持久化（主题同款口径）；`t(key, params)` 键 `域.页面.键`（D01 §12.1），en 缺键回退 zh-CN 再回退 key（开发期可见缺译）；zustand store 响应式（切换触发消费组件重渲）。接线：GeneralSettingsPage 语言卡真实化（三态 select 即时生效）；**antd ConfigProvider locale 联动**（zh_CN/en_US——组件内置文案随切）；SettingsLayout 六 tab + MainLayout 导航（含 /notifications 项恢复）走 t()——切换立即可见；字典 v0.1 覆盖设置页族/导航/登录骨架键（全量文案迁移随阶段二渐入，登记）。client tsc/build ✓。
| E12 | i18n 接入（语言切换真实生效） | 设置中心 | [x] 2026-11-09（shared/i18n 零依赖字典；zh/en/system 三态即时生效） |

---

## 测试基建对照（每项按需选用）

- `make verify`：四栈硬门禁（server build/vet/gofmt/test + client + agent + deploy）+ 启动冒烟，CI 同源——**每项收尾必跑**
- `make verify-server-pg`：PG 集成门禁（RLS/契约测试）——涉及迁移/存储的项（C6/C9/D4/D7/D10 等）
- `make test`：三栈聚合测试
- `scripts/e2e/`：`agent-interop.sh` / `kb-pipeline.sh` / `mcpgw-smoke.sh`——对应域改动的 E2E（doc-stage1 已随 doc 域移除；rtc-stage1 已随 rtc 域移除）
- 双端 alice/bob 回归：~~frp 实验台（随外网接入关闭）~~ 本机双实例

## 批次 F：IM 内嵌 Agent 卡（D18，2026-11-10 设计定稿）

> 定案：(用户,会话) 一会话常驻；完整过程透明卡（思考/工具/结论）；审批弹框聊天页（OQ-B08 白名单口径作废）；
> 分阶段更新落流（agent_card + PATCH 更新通道）；升级=文本注入；安全五层登记阶段二，v0.1 复用 agent 既有防线。
> bbrt/协议/壳桥零改动；服务端仅 message 域 UpdateAgentCard ~80 行；大头在前端 IM。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| F1 | 服务端 agent_card 更新通道 | message 域 UpdateAgentCard（service+repo+PATCH /messages/{id}/agent-card+msg.updated 扇出+测试） | 发起者 PATCH 后接收端 msg.updated 收到新 body；非发起者/非 agent_card 拒 | [x] 2026-11-10（agentcard.go+TestUpdateAgentCard 六断言：非本人 3017/非法 JSON 9001/扇出 edit_version 递增/text 拒/不存在 3017） |
| F2 | 前端触发与映射 | MessageInput Agent 开关+@Agent 前缀检测；conv→sessionId 映射 IndexedDB；workspace 沿用最近会话 | 同群二次 @ 续同一会话；跨群不串 | [x] 2026-11-10（embedded.ts localMeta 映射；agentFlow init 幂等+alive 校验+workspace=recent；agent_store 增 createSession/sendTextTo+respondPermission 改全流扫描 requestId） |
| F3 | 活动卡组件 | AgentActivityCard（流式/思考折叠/工具行/审批 Modal/追问/失败重试/实时计时/idle 折叠）——UI 按 D18 §3.4 对齐 change-my-life（仅效果）+ store streams 直读 | 发起者端全流程可视可交互 | [x] 2026-11-10（AgentProcessCard shared 纯展示：ThinkingCollapse 呼吸+自动收起/工具行/终态摘要条；审批 antd Modal+记忆三档；MarkdownText 移 shared 供 im/agent 共用） |
| F4 | 落流卡与同步 | msg.send(agent_card) 首阶段落流+阶段边界 PATCH 更新；MessageBubble 渲染落流卡+[在我端继续] | 接收端分步看到卡长出；终态收起 | [x] 2026-11-10（stagesSignature 变化驱动 land/patch、终态收口后 onRetire 退场；落流失败不阻断本地（sig 回退下界重试）；digest=结论首行；刷新恢复=映射中会话运行中则重挂活动卡） |
| F5 | 升级与通知 | 「转到工作台」文本注入新建会话；agent_done 通知链随 embedded 会话复用 | 卡片结论带入新工作台会话 | [x] 2026-11-10（升级/在我端继续均走 createSession+sendTextTo 注入结论与来源 ≤4000 字；agent_done=普通会话子任务通知链天然复用零改动） |

## 批次 G：Agent 项目/日常双区 + 记忆分级 + 工作台过程显示（D19，2026-11-10 实施完成）

> 定案：session.start workspace 空串=日常/非空=项目（realpath 归一）；项目登记接线 agent_workspace（修 workspace_id 悬空）；
> 沙箱按会话路由（修全局 "." 占位：项目会话各自沙箱根、日常 workspace 类工具 8020 拒绝）；
> 记忆分级（memory/projects/<目录名-哈希> 分区+类型驱动路由+两段召回）；session.list 持久恢复（修宿主重启列表清零）；
> 过程显示对齐 change-my-life（思考卡流式展开/工具组汇总条/自动折叠/已用时）。服务端零改动。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| G1 | 协议增量 | workspace.register/list/forget + session.list 四对 REQ/RES + memory scope 字段 + golden 契约 | wire 契约锁定（golden_d19_*）；旧宿主兼容（scope 缺省=user） | [x] 2026-11-10（envelope.rs+lib 导出；cargo test bbrt-protocol 绿） |
| G2 | agent_workspace 接线 | manager.start realpath 归一+upsert+workspace_id 回填；store list/remove/list_with_workspace | session.start 带目录后 agent_session.workspace_id 有值；同目录重开不换身份 | [x] 2026-11-10（bbrt-store 33 例绿） |
| G3 | 沙箱按会话路由 | SessionWorkspaces 共享表；session_env 克隆覆写+policy 缓存；日常 8020 拒绝；coding.delegate 日常拒；兜底根置空 | A 项目会话写 B 目录=预检 8020+Seatbelt 双拦；日常文件/命令/git/search/委派全拒 | [x] 2026-11-10（tools_suite d19_* 四专项 42 例绿） |
| G4 | 记忆分级 | memory/projects 分区+scope_key；save/list/delete/recall/get scoped；类型驱动路由（user→用户级，其余随会话目录）；召回两段 | 项目会话召回含[用户记忆]+[项目记忆]两段；分区互不串；日常仅用户段 | [x] 2026-11-10（bbrt-memory 全绿：隔离/别名归一/两段召回/LRU 继承） |
| G5 | 会话列表持久恢复 | 壳 session_list=bbrt session.list（camel→snake）+宿主缓存叠加；RT 不可用回落缓存 | 宿主重启后工作台会话列表恢复（含项目归组）；活跃状态实时 | [x] 2026-11-10（agent_bridge.rs list_sessions 换源；cargo check 绿；真机验收待做） |
| G6 | 工作台双区 UI | 左栏两分区（项目可折叠内嵌会话+日常平铺）；「+ 日常对话」「打开项目」（plugin-dialog）；header 副标题口径；记忆页作用域页签+项目下拉 | 新建日常=无目录会话；打开项目=登记+项目会话；记忆页可切两域 | [x] 2026-11-10（AgentSessionList 重写+WorkbenchPage 双入口+MemoryPage 页签；tsc/vite build 绿） |
| G7 | 过程显示对齐 | ReasoningCollapse 重写（流式强制展开+呼吸+过渡+自动收起）；ToolGroup 连续归组汇总条；ToolCard 自动展开/折叠；TypingState 已用时 | 思考流式自动展开、结束自动收一行；工具组运行中展开、完成折叠；全程已用时实时 | [x] 2026-11-10（组件层完成；真机动效验收待做） |
| G8 | IM 内嵌联动 | embedded workspace=最近项目会话（跳过日常），无则日常 | D18 实测行为不变（最近工作台会话通常即项目会话） | [x] 2026-11-10（ChatPage agentFlow 取值改 find(x=>x.workspace)） |
| G9 | 文档 | D19 新篇+D08/D11/D15 落地注记+索引 | 设计口径可追溯 | [x] 2026-11-10 |
| G10 | 真机验收 | 日常拒绝文案/项目会话文件落正确目录/双分区记忆/重启恢复/过程卡动效 | 用户真机走查 | [ ] 待验收（随用户未提交 WIP 一并验收提交） |

## 批次 H：ask_user 提问卡（D20，2026-11-11 实施完成待真机验收）

> 定案（用户裁决立项）：ZCode 式 AskUserQuestion——agent 关键决策点向用户发结构化提问，
> 三端（私聊/群聊落流卡/工作台）选项卡点选作答，答案进工具结果回给模型；完全镜像
> permission 阻塞机制；**无超时**（等用户或「停止」中断收口 cancelled）。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| H1 | 协议对 | clarify.request UNT（questionId/question/header?/options/multiSelect）+ clarify.response REQ（camelCase）+ WaitingClarify 状态 + golden 双契约 | wire 锁定；状态名表含 waiting_clarify | [x] 2026-11-11（bbrt-protocol 29 例绿） |
| H2 | 会话机制 | run_tool 拦截 ask_user（同 coding.delegate 先例不走 pipeline）；clarify_tx/rx+1s 轮询可中断等待；#6b/#7b 迁移；WAL 两侧+恢复作废；SYSTEM_PROMPT 提问规范 | 回答注入工具结果；停止=cancelled 收口 interrupted；坏参数 9001 不发卡 | [x] 2026-11-11（loop_tests clarify 三件套+state_machine 36 例绿） |
| H3 | 工具+路由 | ask_user_def（Low/ReadOnly/不进工作区墙=日常可问）+注册；manager.respond_clarify；bin bridge 路由登记+映射+main dispatch arm | specs 可见；question_id→session 路由投递 | [x] 2026-11-11（tools_suite 42 例绿；全 workspace 52 套绿） |
| H4 | 壳+前端 | agent_clarify_respond 命令；clarify 事件 normalize+StreamItem+respondClarify 全流扫描+系统通知（无超时 timer）；三端 UI（ClarifyCard/聊天页 Modal/落流卡内嵌条 ClarifyForm 共用）+mock 第 3 轮剧本+样式 | tsc/vite build 绿；composer waiting_clarify 禁用；未决提问卡强制展开 | [x] 2026-11-11 |
| H5 | 文档 | D20 新篇+detail 索引+本批次 | 口径可追溯 | [x] 2026-11-11 |
| H6 | 端到端冒烟 | examples/clarify_smoke.rs+假网关（ask_user tool_call SSE）→ 真 bbrt 全链 | clarify.request 壳侧 emit 可达+回答注入工具结果+回合收口 idle | [x] 2026-11-11（SMOKE PASS） |
| H7 | 真机验收 | 三端触发提问卡/点选继续拿到答案/多选+补充/停止中断收口/系统通知可见 | 用户真机走查 | [ ] 待验收 |

## 批次 I：工作台微调 + 会话历史加载（2026-11-11 实施完成待真机验收）

> 定案（用户裁决两件）：①新建任务不应有「启动中」态——壳 agent_start_session 本就同步等完
> session.ready 回执才返回，前端 starting 是多余瞬态（且事件泵线程死亡时永久卡死）；
> ②工作台打开会话要能加载聊天记录——IM embedded 与工作台同一会话身份（D18/D19），
> 历史直读 bbrt WAL（服务端零改动）。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| I1 | 「启动中」移除 | 前端 SessionStatus 枚举删 starting（标签/禁用规则/TURN_ACTIVE/IM live 集合同步清）；建会话投影直接 idle；壳 start_session 成功回执后缓存行同步翻 idle；mapSession 瞬态归一兜底；mock 对齐 | 新建任务即「空闲」可输入；无任何 starting 残留路径 | [x] 2026-11-11（tsc/vite build+cargo check+壳 6 例绿） |
| I2 | 输入区 hint 精简 | Composer foot 删「/ 指令 · Enter 发送」span+死样式（禁用态提示仍走 placeholder） | hint 不再显示 | [x] 2026-11-11 |
| I3 | 协议对 | session.history REQ→session.history.result（HistoryItem user/assistant/tool；变体级 camelCase——enum 级 rename_all 不管字段）+ golden 双契约含旧 WAL 降级行 | wire 锁定 | [x] 2026-11-11（bbrt-protocol 30 例绿） |
| I4 | WAL 增补 | assistant.done 加 text 回复原文；tool.result 加 ok/summary（recovery 只读旧字段不受影响；借 text 重建上下文留阶段二） | 历史可渲染完整回合 | [x] 2026-11-11（loop_tests/recovery 全绿） |
| I5 | RT+壳+前端 | main dispatch 直读 events_after→wal_history（会话不须运行态）；壳 session_history 透传；bridge loadHistory；store selectSession 即拉 loadHistoryIfEmpty（空流才回填，直播不覆盖）+historyToStreamItem 回合气泡同构映射 | 工作台打开历史/结束/embedded 会话即见全程记录；重启后不再空白 | [x] 2026-11-11（agent 全 workspace 561 例绿+tsc/vite build+壳 fmt/check 绿；mock 历史返空=剧本内存态） |
| I6 | 文档 | D19 落地注记（会话历史加载）+本批次 | 口径可追溯 | [x] 2026-11-11 |
| I7 | 真机验收 | 新建任务无启动中/日常打开 embedded 会话见 IM 聊天记录/重启后工作台会话历史在/旧会话（WAL 无 text）降级不报错 | 用户真机走查 | [ ] 待验收 |

## 批次 J：审批/提问卡 session_id 协议修复 + 日常默认用户工作区（2026-11-12 实施完成待真机验收）

> 定案（用户裁决）：①真机定位发现 wire 协议 permission.request/clarify.request 不带
> session_id——壳无从路由，审批弹框/提问卡在真机壳链路从未弹过（WAL 实证当日 6 次
> 全 120s timeout；mock 桥自带 sessionId 掩盖）；②日常对话口径修订为 ZCode 式：不绑
> 项目会话（日常/任务/IM embedded）共用用户级默认工作空间 `~/.baobaochat/workspace`，
> 不跟随项目——原「日常=无目录整体 8020 拒绝」废除，越界仍 8020 双拦。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| J1 | 协议补 session_id | envelope PermissionRequest/ClarifyRequest 加 `session_id`（serde default+空不序列化=旧宿主兼容）；bridge.rs map_event 两处透传（原「不带会话字段 D11 原样」废除）；roundtrip 构造+golden 双契约补断言 | wire 含 sessionId；壳 snake_keys 归一自动带过、前端/壳零改动 | [x] 2026-11-12（bbrt-protocol 30 例绿含 golden 新断言） |
| J2 | 日常默认用户工作区 | bbrt-sec `sandbox::default_user_workspace()`（env BBC_RT_DEFAULT_WORKSPACE>~/.baobaochat/workspace）；ToolsConfig.default_workspace 可注入（测试 tmp 免写真实 HOME）；pipeline session_env 日常分支=项目同款沙箱覆写（首用 create_dir_all；签名收口不再 Result）；coding.delegate 日常放开（cwd=exec_ws）；loop_runner exec_ws()（委派简报/checkpoint 同口径；记忆路由 ws_path 不动）；project_line/子代理项目行文案改「用户工作空间」；SYSTEM_PROMPT 记忆段不变 | 日常会话工具可用且只困在默认工作区；越界 8020+violation；A 写 B 仍拒 | [x] 2026-11-12（tools_suite 42 绿——日常专项改「区内可用+越界仍拒」；session 12 套绿） |
| J3 | embedded 恒日常 | ChatPage ensureEmbeddedSession 删「跟随最近项目」恒 workspace=''（sessions 未加载竞态同除） | IM 发起 agent 一律日常=用户工作空间；操作项目=工作台项目会话 | [x] 2026-11-12 |
| J4 | 文档 | D19 顶部落地注记+§2 联动口径修订+本批次 | 口径可追溯 | [x] 2026-11-12 |
| J5 | 真机验收 | ①聊天页让 agent 跑命令→审批框 120s 内弹出（allow 后执行成功）②提问卡弹出可作答③日常会话写 ~/.baobaochat/workspace 内文件成功/写区外被拒④embedded 不再出现「跟随最近项目」目录 | 用户真机走查 | [ ] 待验收 |

## 批次 K：自动更新 + 官网 + 发布打包链（D21，2026-11-12 编码完成待密钥/真机验收）

> 定案（用户裁决 2026-11-12）：v0.1 **统一 http**（内网明文，https 以后再加）；
> 不买平台签名证书（macOS 临时签名/Windows 无 Authenticode——安装包完整性由
> minisign 保证）；macOS 双架构；三台系统机手动跑发布脚本；官网挂同域名根路径。
> 设计与操作手册：[D21](detail/D21-自动更新与官网发布链详细设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| K1 | 打包注入链 | build.rs BBC_PUBLIC_URL→BBC_DEFAULT_GATEWAY + agent_bridge 三级缺省链（修生产包指 127.0.0.1:8090）+ Info.plist ATS 例外 + tauri.windows.conf.json 收敛 NSIS + scripts/release/{set-version.sh, build-desktop.sh/.ps1} + sidecar 交叉 --target 修复 | BBC_PUBLIC_URL 一次注入三链（前端 env/壳网关/updater 端点），域名不进库 | [x] 2026-11-12（130fbbb；壳 check/fmt+set-version 幂等+校验路径实测） |
| K2 | updater 前端全链 | tauri-plugin-process（relaunch）+ 前端 plugin-updater/process 包 + features/settings/updater.ts（zustand store+静默 3s/6h 检查+版本去重）+ AboutPage 更新卡（检查/下载进度/重启安装/Linux deb 官网引导）+ App 静默检查挂载 | 关于页全流程可用；pubkey 填入即活 | [x] 2026-11-12（f67e1bb；tsc/vite build+壳 check 绿） |
| K3 | 服务器侧 | nginx 80 主入口全路由（补 /v1/ /mcp/ bbrt 生产链路+官网 /；443 同步补）+ update-src bind 卷转正（no-store/immutable 分级缓存）+ website 服务 + helm ingress 补 path + gen-manifest.mjs（latest.json+release-info.json）+ publish.sh（齐套校验+rsync+回读验证） | http://域名/update/latest.json 可拉；三平台机出包→publish 全链通 | [x] 2026-11-12（0328d69；check-deploy+gen-manifest 夹具断言全过） |
| K4 | 官网 | website/ 工程（Vite+React+TS 单页：Hero/功能九卡/路线图/下载区）+ 下载区运行时拉 release-info.json 自动跟进版本 + publish-website.sh + Makefile/CI verify 门禁接入 + D21 文档 + docs/16 落地注记 + 本批次 | http://域名/ 可访问；发新版下载区自动更新 | [x] 2026-11-12（本提交；verify-website 绿） |
| K5 | 签名密钥启用 | 用户执行 `npm run tauri signer generate`（口令自设、私钥自管），pubkey 填 tauri.conf.json plugins.updater.pubkey 后提交——updater 壳侧条件注册即活 | lib.rs 启动不再打印「updater 未配置公钥」 | [ ] 待用户出钥 |
| K6 | 真机验收 | ①v0.1.0 装机（Intel+M 各一）②服务器 publish v0.1.1 ③静默提示+关于页检查→下载→重启升级→版本变化 ④Windows NSIS passive/Linux AppImage/deb 引导 ⑤生产包 bbrt 走 http://域名/v1 跑通 IM agent 卡 ⑥官网下载区随发布自动更新 | 用户真机走查（清单详见 D21 §8） | [ ] 待验收 |

## 批次 L：插件系统（D22，2026-11-12 L1-L5 编码完成待真机验收）

> 定案（用户裁决 2026-11-12）：包格式采 **Claude Code 插件格式超集**（`.bbc-plugin/`
> 主、`.claude-plugin/`/`.zcode-plugin/` 三目录名都认）；**工具一律 MCP**（不做进程内
> 工具）；SkillTab **并入**插件页；同生态身份 **HTTP-only 约定**（stdio 只给 USER_ID）；
> hooks 只读不执行；**dsh 兼容否决**。
> 设计：[D22](detail/D22-插件系统详细设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| L1 | 服务端市场 | 迁移 0036（plugin_pkg/plugin_version/plugin_install 三表，包体 bytea ≤10MB）+ repo 双实现（memory 兜底+postgres）+ 发布校验器（清单三目录名/组件存在性/zip slip）+ 用户面 catalog 检索（q/category/component/安装态/hasUpdate）/详情/install/download/mine + 管理面发布/版本 publish/下架/policy + 单测 | go build/vet/test 绿；curl 发包→检索→下载 zip 闭环 | [x] 2026-11-12（a1b618d；含 :8091 curl 冒烟闭环实测） |
| L2 | 客户端插件页 | PluginPage（市场/已安装/详情/配置表单四区）+ 下载落盘双端复跑校验 + plugin-state.json（enabled/activeVersion）多版本管理 + SkillTab.tsx 删除并入 + `/plugins` 路由挂工作台域 | tsc/vite build 绿；真机检索→安装→已安装管理 | [x] 2026-11-12（e5f6416；SkillTab 已删并入） |
| L3 | 装配链 | 宿主装配器（系统级 env 源+插件级 .mcp.json 两源合并+`${PLUGIN_ROOT}` 替换）+ 宿主协议 `mcp.config` 动态下发（McpClient 重配：断开移除/懒连新增）+ SkillIndex 扫描路径扩展（无 triggers 技能 name 兜底触发+索引区）+ tools.reload 接线 | 真机：装带 MCP 插件→会话内出现 `mcp.<server>.*` 工具且调用过审批卡 | [x] 2026-11-12（a5ed35e） |
| L4 | 身份层 | bbrt-mcp 调用层三变量族替换（`${BBC_USER_TOKEN}` HTTP-only/`${CONFIG:*}`/`${PLUGIN_ROOT}`）+ `auth.push`/`config.push` 宿主协议 + 钥匙串接线 + OBO `_meta.bbcObo` 泛化 + 身份使用标识 UI | 真机：HTTP 插件工具带 Bearer 调通同生态服务；config token 注入外部系统头 | [x] 2026-11-12（c87834b；实现收敛：CONFIG/USER_ID 装配静态替换+保存/换号重推，弃 config.push/auth.push——仅 TOKEN 必须动态） |
| L5 | 命令与专家 | `/` 命令列表+模板渲染（$ARGUMENTS/$1..$9，纯客户端注入用户消息）+ agents frontmatter→专家 Persona Manifest 翻译器（走现有专家装配交集） | 真机：/release 出模板；插件专家可被选中会诊 | [x] 2026-11-12（51f4833；IM 聊天页斜杠命令后续登记） |

## 批次 M：Agent 记忆系统升级（D23，2026-11-12 M1-M3 编码完成待真机验收）

> 定案（用户裁决 2026-11-12 九轮讨论）：两层=公共+项目，会话层不做；**公共层换制**
> journal+USER.md 压实视图（硬顶 3000 字/常态 2400/单条 80 字），十类硬枚举+硬度轴
> （禁止/授权硬·压实不可删·目标时敏）；view=缓存 journal=真相（启动 reconcile 自愈）；
> provenance 只进 journal；单写者进程内 Mutex；**不做 tenant/user 身份键**（人轴外包
> OS，P2 同步时一次性迁移）；状态类延后；更正=forget+write 零 LLM；项目层沿用收口
> （两层 LRU 废除/hook ≤40 限长/last_used）；日常 project 类保留 D19 回落（IM embedded
> 主场景不丢教训）。设计：[D23](detail/D23-Agent记忆系统升级详细设计.md)。
> **落地注记**：①hook 限长取**渲染层截断**（hook_of 统一收口）而非硬拒——索引可重建
> 故无损，W2 自动路径长首行不丢教训；②压实结果以 **snapshot op 持久化**（journal 仍
> 只追加永不删行，replay 遇 snapshot 整体替换历史=journal 收敛同机制）；③M3 的
> memory.forget 落 REQ/result 对（UNT 事件与 memory.saved 工具路径同口径后置 P1）。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| M1 | 公共层存储换制 | bbrt-memory 新 global/ 模块（journal.jsonl append/replay/重投影/启动 reconcile）+ 一次性迁移（既有用户级 slug 族→op:add 灌入（四类→十类映射）→USER.md 派生→旧文件 archive/）+ memory_save 双枚举路由（global 十类/项目三类）+ W1/W2/W3 三写入路径全改灌 journal + 日常 project 类回落 global + 全局 Mutex 串行 | cargo test global 套件绿（重放幂等/迁移幂等/单条 80 字拒/回落路由）；启动后 USER.md 生成且旧文件入 archive | [x] 2026-11-12（28a40eb；workspace 53 套绿；采集话术进 memory_save 工具描述） |
| M2 | 压实漏斗+工具面 | compact.rs（Compactor trait+prompt 契约+parse）+ reproject 超限路径（硬条目程序拼回不进 LLM/四重校验/snapshot op 持久化）+ bbrt-session FastCompactor（bbc-fast）+ main set_compactor 接线 + memory_forget（tombstone+移除清单 0/1/N 回显）/memory_read（touch last_used+日常 8002 引导）工具与分发 + knowledge/ LRU 废除+hook 渲染层截断 ≤40+last_used | 压实产物 ≤3000 且硬条目逐字保留断言（含「硬条目不进压实输入批次」）；forget 三态；快照后常规写入免压实 | [x] 2026-11-12（4debbf8；FakeCompactor 两套+tools 五断言链） |
| M3 | 协议+记忆页+联调隔离 | memory.forget REQ/result 协议对（golden 锁定）+ MemoryListItem 增 globalType + bbrt list 用户段直读 global replay（带十类标签）/forget 处理臂 + 壳 memory_forget 命令 + 前端桥 forgetMemory（tauri/mock）+store 动作+记忆页 global 条目（十类 chip/撤销走 forget/meta 标注 USER.md）+ MemoryEngine::open_root（BBC_MEMORY_ROOT 覆盖） | tsc/vite build 绿；记忆页用户页签=USER.md 条目可见可删 | [x] 2026-11-12（本提交；顺修 D22 L4 遗漏的 agent_bridge 测试 Shared.user initializer） |
| M4 | 真机验收 | D23 §9 六项走查（十类落盘/回落教训/禁止→解除更正链/压实与断 provider/记忆页/8020+BBC_MEMORY_ROOT） | 用户真机走查 | [ ] |

## 批次 N：知识库博客化（D24，2026-11-13 N0-N6 编码完成待真机验收）

> 定案（用户裁决 2026-11-12 十轮讨论）：**两维度收口**——公司知识库（公共/全员可看可投/
> 全租户唯一）+ 我的文章（个人/仅本人/AI 入库默认落点/不进榜单），**「空间」产品概念消失**
> （kb_space 退化为内部两行：公共迁移种子+个人惰性），多空间/成员制/隔离后置；页面纯
> 阅读+检索+榜单（**无写/编辑/删除 UI**，写入只留 API 给未来 AI/OBO）；目录=专栏保留
> （公共共享树+个人每人一棵，可空=根）；**保存/投稿分离**（保存默认落我的文章、投稿=
> 移动后置）；浏览量**一人一天一篇计 1、作者不计**；**榜单只收公共维度**（最新/最热窗口/
> 作者榜 Top10+个人概览卡，攀比=产品目标）；检索**三态降级**（关键词 ILIKE→RRF→rerank）；
> 嵌入/rerank 走 ai_provider 路由（tier embed/rerank 独立、可与 LLM 不同来源、全 HTTP 接口）；
> **嵌入切换=epoch 渐进重建+关键词兜底**（跨维度清空重建确认；rerank 切换零成本）；图片
> v0.1 只索引 alt+上下文（VLM caption P1）；grants 三件套废弃。
> 设计：[D24](detail/D24-知识库博客化详细设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| N1 | 迁移+维度收口 | 0037（view_count/kb_doc_view/embed_epoch/kb_settings+dept 并入 company 种子+company 唯一索引，embed.go 双登记）+ canRead/canWrite 两分支 + CreateSpace/resolveDeptBinding/grants 三件套及六闭包下线 + EnsureCompanySpace + GET /kb/spaces 固定两行 | go build+test ./internal/kb/... 绿（dept/ACL 用例改写两维度口径）；迁移幂等重放 | [x] 2026-11-12（339b9f3；净 -481 行；:5432 开发库 0036+0037 已应用入账；PG 冒烟绿） |
| N2 | 浏览量/榜单/我的 | POST view（日去重+作者短路）+ GET /kb/me/summary·me/docs·rankings（三榜 Top10+窗口聚合+公共-only）+ Options.UserInfoOfMany（org 闭包装配） | go test 绿（公共-only/作者不计数/日去重/窗口聚合用例） | [x] 2026-11-12（655ff20；15 用例绿） |
| N3 | 检索升级（两提交） | 提交一 aigw：OpenAICompat.Embed 真实调用+registry 放开 embed/rerank 档+AliasRerank/Provider.Rerank/HandleRerank+POST /v1/rerank 注册；提交二 kb：Options.RerankFn+GatewayRerankFn+Query rerank 阶段（候选 30→topK）+epoch（kb_settings 读写/向量路过滤/重建 goroutine/管理端 GET·POST rebuild+7017/7018） | go test ./internal/aigw/... ./internal/kb/... 绿（TestRerank；三态降级/epoch 过滤/重建幂等用例） | [x] 2026-11-12（b667551+22b3a63；aigw 12 用例+kb 17 用例；顺修 N2 docCols view_count 扫描位缺——PG 冒烟拦截） |
| N4 | 前端首页+阅读页 | /kb 子路由重构 + KbHomePage（概览卡/大搜索/榜单三列/最近查看）+ ArticlePage（MarkdownText 增强图片/链接/有序列表+view 上报+大纲锚条）+ SearchPage（检索面板吸收为页面） | tsc 0 错+vite build 绿 | [x] 2026-11-12（dd8069e；「引用到 Agent」bus 桥随旧件退役移出——阅读页 N4 版未带，随 AI 写入批次补） |
| N5 | 前端其余+管理端 | SpaceBrowsePage（目录=专栏面包屑逐层懒加载）+ MyArticlesPage（两维度分组）+ KbGovernancePage 嵌入设置面板（重建触发+进度轮询+跨维度确认）+ 旧件退役（KbPage 707 行/GrantModal/IngestBadge/createSpace+grants api） | tsc+vite build 绿 | [x] 2026-11-12（c6338e6；净 -945 行） |
| N6 | IM 收藏入库 | IngestFromIM 接路由 POST /kb/docs/from-im（spaceID=0 自动个人维度）+ 消息右键「存入知识库」（仅 text 可见+favToast 回显） | go test+tsc+build 绿 | [x] 2026-11-13（8b0c1b6） |
| N7 | 真机验收 | D24 §10 七项走查（首页榜单/浏览量口径/阅读页渲染/维度隔离/检索三态/重建进度/IM 入库） | 用户真机走查（:8090 重启+Tauri） | [ ] |

## 批次 O：全站 UI 组件库切换 Ant Design（D26，2026-11-13 O0 落稿待编码）

> 定案（用户裁决 2026-11-13）：**除 IM 气泡/消息流结构外全量切 antd 5**（Arco 否决——已在
> 依赖/主题桥接已通/组件面最大）；风格基线=--bbc-* 令牌全量灌 antd theme（零观感漂移，
> 只换手感）；表单=控件层替换不强推 Form 重写；24 处 window.confirm 全换 Modal.confirm；
> toast 统一 antd message；Button/Skeleton 包装化过渡（调用点 API 零改动）；global.css
> 10384→≈3000 行；保留自研=IM 气泡族/MarkdownText/ctx-menu/Splitter/StateView 壳/Logo。
> 设计：[D26](detail/D26-全站UI组件库切换AntDesign详细设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| O1 | 主题基线+基础层+kb 样板 | antdThemeFrom 亮暗单源+ConfigProvider 全量令牌；Button/Skeleton/Empty/Avatar 包装化；kb 域 Tabs/Tree/Modal×2/Input 换装 | 亮暗混排无肉眼差异；kb 全链等价（开文章/建目录/建文章） | [x] 2026-11-13（**口径修订：用户拍板旧组件自研样式一律退役走 antd 原生观感、不仿旧观感**，零漂移仅保主题令牌基线；antd 5.29 无 Tabs cardGap 令牌已略；global.css 10384→9895；真机走查归 D26 §7） |
| O2 | admin 域 15 页 | admin-table→Table、表单控件全换、内联弹窗×2→Modal、confirm×14→Modal.confirm | 任一表格页分页排序+表单保存+危险确认红钮 | [x] 2026-11-13（15 页+ProviderModelsEditor 全量：admin-table×14→antd Table（分页 20/hideOnSinglePage，Skills/EcoApps/Plugins 版本线→expandable）；表单件 input/select/textarea→Input/Input.TextArea/Select（admin 域原生件清零，仅留两处隐藏 file picker）；RolesPage role-editor+OrgDirectory CreateUserModal 两内联弹窗→antd Modal/Form；window.confirm×15→Modal.confirm（危险操作 danger 红钮）；PoliciesPage admin-tabs→antd Tabs+策略 checkbox→Switch；UsagePage/OrgDirectory admin-chip→Segmented；AiProviders 对齐（双表 Table 化+Drawer 表单 Form 化+RoutesPanel 四档 Select 化）；ProviderModelsEditor chips→Tag.CheckableTag；EcoApps 灰度面板→Modal+InputNumber；tag/admin-status→antd Tag；页面 error/ok 条→Alert；shared Button 包装增补 size/icon/danger 透传（可选参数，调用点零改）；data-testid 全保留；tsc+vite build 绿）；**补充轮**（用户再拍板：旧自研样式一处不留，全走 antd 默认）——结构层全退：AdminLayout settings-nav→antd Menu（选中态随路由）、admin-panel→Card、admin-card→Card+Statistic、Dashboard 趋势占比/Dashboard admin-bar→Progress、AuditPage admin-timeline→antd Timeline、Policies 策略行→List（actions=Switch+恢复默认）、Roles 授权区→Card+List、**OrgDirectory 组织树→antd Tree**（titleRender 行内 ops/内联建子部门/双击改名——样板对齐 kb ArticleTree，org-node 全退役）、KbGovernance 嵌入面板→Card+Progress、公告历史→List、表情集卡片→Card、各页头→Flex+Typography.Title、admin-mono→Typography.Text code、发布/表单块 eco-reg→Space/Form、加载更多→Flex 居中——**admin 域 className 归零**（布局内联 style）；tsc+vite build 再绿 |
| O3 | settings+auth+contacts+mail+expert+eco | 表单件+弹窗（compose/settings-drawer/exp×2/plugin-drawer）+confirm 清零 | 各域表单等价+弹窗 Esc/遮罩关闭 | [x] 2026-11-13（20 文件全量换装+**旧自研样式零保留**（O2 补充轮口径全域适用）：settings 10 文件——SettingsLayout settings-nav→antd Menu（对齐 AdminLayout 含拖宽）、General 主题三选卡→Segmented、AgentSettings 表→Table+四件 antd 化、McpSettings 服务表→Table+编辑器 9 件 antd+confirm→Modal.confirm、Notification→List.Item actions、Shortcut→Table（Text keyboard）、About/CloudBackup→Card+List+Progress+Alert、ServerDrivenNote→Alert、auth 三件收尾（login 壳内联+Card、UserPicker 下拉内联+token）；contacts 整页——组织树→antd Tree（titleRender hover Popover 详情卡/双击发聊）、搜索下拉→Popover+Menu、档案区→Card+Descriptions+Breadcrumb、闪烁高亮→WAAPI 内联动画、className 归零；mail——ComposeModal→Modal+Form（附件隐藏 file input 保留+Tag closable）、SettingsDrawer→Drawer+Form+专用密码 Card/List、MailPage 三栏内联+Menu 分组邮箱+Badge 未读+Segmented+List；expert——卡片→Card hoverable、详情→Drawer、编辑器→Modal+Form、下架→Modal.confirm；eco——PluginPage→Tabs+Upload（zip）+Drawer（本地状态 Switch+权限 List+Input.Password）、AppStore→Card+四态 Tag、confirm×3→Modal.confirm；**六域 className 归零**（grep 0）+原生表单件清零（仅 2 隐藏 file picker）+window.confirm/alert 清零；data-testid 全保留；tsc+vite build 绿；三子代理并行执行+主会话统一门禁）真机验收归 O7 |
| O4 | agent 工作台 | 会话列表/设置卡/报告/记忆页表单件+弹窗（过程卡/StreamMessage 保留） | 工作台全链回归 | [x] 2026-11-13（8 文件换装+旧类零保留：Workbench 三栏内联+状态 Tag+模式 Dropdown、SessionList→antd Menu inline（分区/项目分组/运行数/嵌入徽标）、ContextSidebar→Card+Descriptions+List、Composer→Input.TextArea（聚焦/IME/斜杠命令导航保真）、SubNav→Menu horizontal、MemoryPage→Segmented+Select+List、ReportsPage→Collapse accordion、ModelThinkPicker→Popover+Menu+Slider；过程卡族 9 文件+StreamMessage 按保留清单不动；8 文件 className 归零） |
| O5 | IM 外围 | 弹窗×6→Modal/Drawer、ConvInfoSidebar 表单件、favToast→message（气泡/右键/输入区不动） | IM 回归重点走查 | [x] 2026-11-13（9 文件：Forward/CreateConv/ReadReceipt/PersonPicker 壳/FileSendPreview 壳/notif 公告弹层→Modal、MergeForwardDrawer→Drawer、ConvInfoSidebar 控件行 7 件+confirm×3（顺带删 querySelector hack）、favToast/fwdToast→message（时长逐点保真）、公告横幅→Alert banner、startDm window.alert→Modal.error；已读未读 tab→Tabs、搜索→Input.Search、chip→Tag.CheckableTag；PersonPickerCore/预览内容/气泡/输入区按保留清单不动；im 域 modal-mask/bbc-modal/confirm 清零） |
| O6 | CSS 清扫 | global.css 分域删至 ≈3000（基元/弹窗表单段+kb 死代码三节）；legacy 标记防误删 | 行数≤3200+全站 grep 残留=0 | [x] 2026-11-13（**9895→4881 行（-4014）**：grep 驱动逐类零引用裁决（引用证据=className/class=/classList/querySelector 字面量，注释剥离；排除 data-testid 同名与 useSplitWidth 存储 key 假引用；救回动态前缀族/antd .ant-* 联动/conv-item 数组 join 间接引用）——删 766 死类/900 规则/2 无引用 keyframes，45 段墓碑注释；整段退役：设置页族/知识库旧段/管理后台/邮件/Agent 旧类/澄清卡/通讯录页+详情/应用商店/插件页/斜杠命令/专家库/kb 死件三节/转发弹窗/记忆日报/认证登录族等；主会话补充：删孤儿模块 PlaceholderPage+ServerDrivenNote（零 import）及其 CSS 段、拆分同名 @keyframes bbc-shimmer 级联覆盖存量隐患（搜索面板版改名 bbc-shimmer-bg）；**行数 4881>3200 目标偏差**——余量全部为仍被引用的保留面：IM 核心（三栏/对话细节/语音/表情/搜索/收藏/多选/文件/群管理/合并抽屉 ≈1900）+kb 博客体未换装页（首页/检索/壳/阅读/维度 ≈570，阅读排版属保留）+Agent 过程卡族（≈700）+选人器/应用壳/骨架/断点 ≈420——继续压行需换装 kb 博客体页面（批次外，另行立项）；tsc+vite build 绿（CSS 产物 81.5→74.4kB））；**二轮 O6b 2026-11-14（全量收口后）**：4881→**768 行**（自 9895 累计 -92%）——批7-10 换装（kb 博客体/IM 气泡族/输入区/右键/表情/过程卡族/ConvInfo/PersonPicker/StateView/Splitter/壳）后 565 死类全删（AST 上下文感知引用判定；32 处 data-testid 假引用剔除）、keyframes 14→3、CSS 产物 10.03kB（gzip 2.79kB）；存活 55 类全为真引用（agent-md 渲染层/审批 Modal agc-perm/merge-drawer 内容行/Skeleton 内部/im 三栏骨架/闪烁锚点 msg-row--flash），列为后续换装候选 |
| O7 | 真机验收 | D26 §7 五项走查 | 用户真机走查 | [ ] |
| N8 | 正文媒体引用权限（D24 §11 补记） | file_ref 表随 0037 建（file_id/ctx_type/ctx_id/created_by）+ file 域 canAccess 第三判据（EXISTS 可见引用上下文，kb_article 可见性闭包注入——挂门法，否掉文件行打标）+ 正文 bbcfile://{id} 引用语法与 N4 阅读页渲染换票（120s 票据现场取）+ 删除三层（静默删引用/本体删除引用计数提示/全零回收归 D06 登记项）；IM conv_id 旧径不动（message 迁 file_ref 终态另立） | 非作者读者打开公开文章正文图正常显示（旧路径 403）；编辑删图/文章移动不影响其他门 | [ ] |

## 批次 O：对象存储与预签名直传（D25，2026-11-12 设计定稿）

> 动机=compose `nginx-lb→app×2` 双副本 + v0.1 本地盘 = 文件随机 404（部署阻塞项）；compose 内 minio/桶/env 占位已久未接。拍板六条见 D25 §1 勿重提（aws-sdk-go-v2 / nginx /oss 路径代理+Host 透传 / 空 endpoint 回落 Local / 仅 >8MB 直传 / part_size 8MB / JPEG 缩略）。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|------|--------|------|------|
| O1 | 服务端 S3 存储层 | aws-sdk-go-v2 依赖 + store/s3.go（Save/Promote/Open/Head/staging 五法 S3 实现，key=t/{tenant}/{sha2}/{sha}）+ S3Options 双端点构造（endpoint/public/bucket/前缀）+ main.go BBC_S3_ENDPOINT 空回落 Local | go build/test 绿；S3 测试 env 门控（BBC_TEST_S3_ADDR 配了才跑） | [x] 2026-11-12（dc67011；预签名 URL 结构/构造校验/countingReader 离线单测绿；PresignHTTP 手签返回值取 URL+拼回 /oss 前缀） |
| O2 | 预签名编排+缩略图 | init 响应 mode/parts[{no,url,method,expires_at}]（presign 首批 ≤32 张 1h）+ status ?from_part= ListParts 位图+续签 + complete=CompleteMultipart→流式 sha 校验→CopyObject(>5GB UploadPartCopy 环)→建行 + ticket 预签名 GET 120s（对外端点拼前缀）+ ?variant=origin/240/720 + JPEG 缩略生成（240/720 失败不阻塞）+ DTO thumbs | go test 绿；S3 集成链（配 env 后 init→PUT→complete→ticket 全通） | [x] 2026-11-12（3bb9be5；**缩略改票据期惰性生成**（迁移免批处理/失败自愈）；IssueTicket 拆 token 形态保 kb OpenFile 兼容+新增 IssueClientTicket；relay 中转 20MB 硬顶/全局 Local 20MB·S3 2GB·BBC_MAX_UPLOAD_MB；变体六测+全量 24 包绿；S3 真链路以真机验收代替——路径见 D25 §10） |
| O3 | 客户端直传引擎 | uploadFileSmart presign 模式（跟随 mode/parts：PUT 并行 3→失败降 1、403 续签重批不计失败、断点位图跳过）+ sha256Hex 增量流式（TS 实现，弃整块 arrayBuffer）+ downloadUrl 绝对地址直用 + 图片气泡 s240 先糊后清 | tsc + vite build 绿；真机走查归 §9 | [x] 2026-11-12（26f2707；sha256.ts Node crypto 跨验证 12 案例含边界；灯箱懒加载原图；relay 模式 part_size 改用服务端下发值） |
| O4 | 部署接线+迁移 | nginx-lb `/oss/` location（strip+Host 透传）+ minio-init mc cors（PUT/OPTIONS）+ migrate-files-to-minio.sh（mc mirror，file 表零改）+ .env.tpl BBC_S3_PUBLIC_ENDPOINT/BUCKET | compose config 校验；迁移后历史文件可下载 | [x] 2026-11-12（本提交；80/443 双块 /oss/ 同款+request_buffering off；helm values/configmap 对齐 publicEndpoint 缺省回落；sh -n+docker compose config 绿；迁移真机验证归 §9⑥） |
| O5 | 文档收尾 | D25 落地注记（首批实测数据/偏差）+ 本批次 | 口径可追溯 | [x] 2026-11-12（D25 §10 落地注记：缩略惰性修订/sha256 跨验证/依赖清单/集成验证路径/遗留登记） |

## 批次 P：embedded 聊天默认私密化 + 手动同步仅结论卡（D18 §9 修订，2026-11-14）

> 用户裁决（2026-11-14）：Agent 模式**完全私密**（问题不落流，过程+回答仅本机可见）；
> 回合收口入 IndexedDB 待同步池；手动「同步到会话」才把**仅结论** agent_card（无思考/
> 工具过程）发进会话——保护当事人隐私，执行过程永不进会话历史。服务端零改动。
> 设计：[D18 §9](detail/D18-IM内嵌Agent卡详细设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| P1 | 待同步池+同步落流 | embedded.ts：PendingAgentRound/池读写（封顶 20）/pendingSyncBody 仅结论卡/syncRoundToConv（带盐 token 落流+出池）；AGENT_LIVE_STATUSES 迁此；patchAgentCard+stagesSignature 退役；pending.ts zustand 镜像（syncing 防重入）；agent store 增 stampTurnDoneIfOpen | tsc+vite build 绿 | [x] 2026-11-14 |
| P2 | 写路径重构+私密卡区 | EmbeddedAgentSync 重构（收口写入器/重载对账/水合；审批+澄清弹框保留）；EmbeddedPrivateCards 新组件（open 轮实时卡+待同步轮卡，消息流尾部）；AgentCardMsg 导出+privateSync 扩展（跳过校正兜底/两处自动折叠；仅自己可见条/未同步小标/同步页脚） | mock 走查全链 | [x] 2026-11-14（mock 浏览器全链验证：提问零落流→私密实时卡流式→审批弹框正常→收口出同步按钮→同步=仅结论卡落流→刷新重登待同步仍在（IndexedDB）→仅自己保留出池；tsc 零错+vite build 绿） |
| P3 | 入口接线+文案 | ChatPage doSend 私密分支（不落流/跳过 mentions）+agentRunning 并入 embedded 运行态；MessageInput 文案改「Agent 私密问答」口径（徽标/Tooltip/斜杠命令/命令面板） | 徽标与提示口径一致 | [x] 2026-11-14 |
| P4 | 真机验收 | macOS 端 bbrt 真链路（收口/对账/同步落流/审批） | 用户真机走查 | [ ] |

> 过程记录：本批曾于 D26-O7 并行期间完整落地一次，被同工作区并行批次对 im/agent/ 目录
> discard 连环清掉（含两个新文件）；用户裁决等对方提交后以 D26 批8-10 提交版为基底重做，
> 以上 [x] 为重做版状态。

## 批次 Q：OIDC 统一认证与生态接入面（D28，2026-11-16 设计落稿待评审）

> 拍板（2026-11-16）：bbc auth 对外做标准 OIDC Provider（目标=兼容通用第三方应用）；
> 嵌 zitadel/oidc v3（协议正确性由库保证+单二进制保留，自研全套否决）；一期只做生态
> 接入面（桌面自身登录/RT OBO/内生态 HS256 不动）；OIDC 面强制 ES256+jwks；6 位确认码
> 深链点头像授权（03 §2.1.1 骨架反用，错误码 1010-1013 正式启用）。设计：
> [D28](detail/D28-OIDC统一认证与生态接入面设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|------|--------|------|------|
| Q0 | 认证域 P0 欠账（与 OIDC 无依赖可先行） | refresh 落 OS 钥匙串+启动静默刷新直达主界面（03 §2.3）；RT 供给切 /auth/obo/token（act 归因+scope 子集，obo.renew 真换签）；auth_clear_token+did 真实化+改密吊销 refresh | tsc/build/test 绿；重启免重登；服务端日志 act 可见 | [x] 2026-11-16（C1 dbe89e9/C2 db62d6b/C3 cdecbb9/C4 3afc0c8：did 真实化（uuid 落 app 配置目录+登录/静默刷新补 did——此前缺字段对真实后端必 400 已断+WS 同源）；登出链路（apiLogout 吊销 refresh+auth_clear_token 清 Rust 缓存+改密即全端吊销）；refresh 落钥匙串（com.baobaochat.auth service）+restoreLogin 免密直达（App restoring 门防闪跳，显式登出弃凭据）；RT 切 OBO（宿主试签 act=desktop-{did}+scope=用户权限集，失败回落主 token 保底；renew 真换签走独立线程）；reqwest 0.12/uuid v1 新依赖 Cargo.lock 随提；全链 tsc/vite build/cargo check/go build+test 绿——真机走查归 Q5 ⑥⑦⑧） |
| Q1 | OIDC 地基（服务端） | zitadel/oidc v3 依赖+Storage 适配层（oidc_client/auth_request/grant/refresh/**web_session** 五表，迁移 0038 起编——已存在两份 0037 撞号）；ES256 密钥装载（env BBC_OIDC_SIGNING_KEY；轮换窗口收缩候选见 D28 §10）；jwks/discovery/authorize/token（授权码+PKCE）；web-login 兜底（html/template 等待页 + **IdP 浏览器会话 7 天滑动**，D28 v0.2）；oidc_client admin CRUD | 纯 web 路径授权码全链通；7 天内第二应用免密（SSO）；curl 验 jwks | [x] 2026-11-16（c0442fa；zitadel/oidc v3.52.0+internal/oidc 六文件+迁移 0038 六表——较设计增 oidc_access_token 行存（introspection/userinfo 反查+撤销位）；per-app access=JWT(ES256,iss/aud=client_id/sub) refresh=opaque 一次性轮换重放拒；scope 收敛=白名单∩用户权限；等待页账密复用 auth 防爆破（VerifyOIDCWebLogin 三导出面）；修 issuer 上下文缺失致 callback 相对路径 404+token 端点 /oauth2/oauth/token 双前缀两 bug；admin CRUD 只开 public client；compose env 透传；**本地 :8091 冒烟十项全绿**：discovery/jwks/建client/authorize/账密→code(A256GCM)/换token/userinfo/SSO 免密/refresh 轮换/重放拒——标准 RP（Grafana 类）实测归 Q4） |
| Q2 | desktop 确认链 | tauri deep-link 注册 bbc:// + capabilities 白名单；深链路由+确认卡 UI（antd 口径：应用名/logo/scope 人类可读/6 位码/点头像）；POST /oauth2/confirm（desktop access token 鉴权）；等待页深链尝试+轮询；grant 覆盖降级轻量卡。**可整体后置不阻塞 OIDC 上线**（D28 §10 收缩候选④） | 深链全链真机通；6 位码错 3 次作废 | [x] 2026-11-16（Q2a 178b162+Q2b 57cd2f4；服务端：0002 迁移 confirm_attempts（**squash 后首个增量，dev 库因旧版本表判已应用列已手工补**）+6 位码（明文存=双端重展示锚点）+confirm/info+confirm+wait/status 三端点+等待页升级（码大字+深链 400ms 唤起+2s 轮询回跳+密码折叠）；grant 修：upsertGrant 移认领通道（此前仅 offline_access 流落 grant 致覆盖恒 false）；免码轻量=covered 点头像即走；桌面端：deep-link v2.6.3（schemes bbc+capabilities+dev 运行时 register）+lib.rs 路由（冷启动 get_current+运行中 on_open_url→emit oidc://confirm-req）+OidcConfirmCard（antd：scope 人类可读/码核对/倒计时/点头像/未登录自动续跑/1012 次数提示）；http.ts resolveUrl 绝对 URL 直通；curl 冒烟：页面码=卡码/错码 1012/正码 amr=[desktop-confirm]/换token✓/covered 空码✓——真机深链走查归 Q5（dev 重启 tauri dev 使 scheme 注册生效）） |
| Q3 | 授权管理与撤销面 | 用户面「已授权应用」页（oidc_grant 列表+撤销=吊销该应用 refresh）+设备列表补「浏览器会话」远端下线；introspection/revoke/userinfo 端点；admin OIDC 凭证管理（与 eco_app 发布联动）；审计 auth.oidc.* 事件 | 撤销后 introspection 立即 inactive；远端下线浏览器会话即失效 | [x] 2026-11-16（Q3a 6485918+Q3b 46f23a2；服务端 /me grants/sessions 四端点+改密→OIDC 全吊销回调（v0.2 拍板7 清偿）+completeAuthRequest 补禁用拦截（SSO 直达路径漏洞）+**RevokeToken 双路修复**（lib refresh 场景传行id+userID 非空与 access 不可区分——原按 userID 分支致 refresh 吊销静默失效）；introspection 端点行为确认：RFC7662 拒 public client 属规范口径（机密客户端开通即活）；audit 后置（admin 审计表为管理员操作口径）；前端设置「登录与授权」页+admin「登录接入」页；冒烟：revoke 200→refresh 立拒/me 撤销→covered 回 false/会话下线→等待页不再直达；真机走查归 Q5） |
| Q4 | 文档回填与示例 | 03 篇修订（登录方式表+接口表补 /oauth2/*）+14 篇协议登记；examples/ 最小 RP 示例（jwks 本地验签演示）；README/deploy 补 BBC_OIDC_SIGNING_KEY | 通用软件（Grafana 类）OIDC 登录实测通 | [x] 2026-11-16（03 篇 D28 落地注记（OP 端点/§2.1.1 双向/§2.2 令牌补充/OBO 接线/me 授权面/未实现清单）；14 篇 1010-1013 启用状态登记（1011 拒绝按钮/1013 未启用记后置）；README 决策速览第 8 条；compose env 已在 Q1 落；examples/oidc-rp=zitadel rp 标准客户端（discovery+PKCE+jwks 验签+userinfo），**curl 全链实测通**（登录成功页+claims aud=client/amr+userinfo Alice）——「通用 OIDC 库实测」以此完成，Grafana 类通用软件留真机；坑：oidc.IDClaims 是接口须用 *oidc.IDTokenClaims 实例化） |
| Q5 | 真机验收 | D28 §8 八项（标准 RP 兼容/深链点头像/未登录 desktop/无 desktop 兜底/防钓鱼/撤销链/密钥轮换/Q0 三项） | 用户真机走查 | [ ] |

## 批次 R：对象存储后端切换 RustFS（D29，2026-11-16 设计落稿）

> 拍板（2026-11-16）：MinIO 双风险（AGPL 禁入+开源版 2025-09 EOL、2026-02 仓库归档永无补丁）
> → 整体移除换 **RustFS**（Apache-2.0，Ceph s3tests 兼容矩阵背书，桶版本化/预签名/CORS 全支持）；
> SeaweedFS 因桶版本化不完整落选（留 fallback）。Go/前端零协议改动（D25 aws-sdk-go-v2 红利），
> 改动面=deploy 层+集成测试。设计：[D29](detail/D29-对象存储后端切换RustFS设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|------|--------|------|------|
| R0 | 设计落稿 | D29 新增+EXECUTION-PLAN 登记+01 篇 A.1/A.2 MinIO 行改判+D25 顶部注记+detail/README 索引（顺补 D28 行） | 口径可追溯 | [x] 2026-11-16（本提交；本地预检已实证 RustFS 1.0.5：/health/ready+minio 兼容探针通、aws-cli 建桶/put-bucket-versioning/put-bucket-cors 写读全过） |
| R1 | compose/部署切换 | docker-compose（rustfs 服务+rustfs-init aws-cli 化+nginx upstream+卷改名+BBC_S3_ENDPOINT 默认值）+.env.tpl（RUSTFS_* 键）+migrate-files-to-s3.sh 改名 aws cli 化+Makefile/scripts/dev-up.sh+helm values endpoint+backup·restore 注释+main.go 日志文案 | docker compose config 绿；go build+全量 test 绿 | [x] 2026-11-16（本提交；rustfs 服务直接复用 BBC_S3_ACCESS_KEY/SECRET_KEY（凭据单源，MINIO_ROOT_* 键对废除）；healthcheck=/health/ready；init=amazon/aws-cli:2.31.4+AWS_ENDPOINT_URL；活文件 MinIO 措辞顺手清零（代码注释/helm/NOTES），frp 存档与 docs/ 设计篇按 D29 §7 保留；compose core+deps profile config 绿+go build/vet/全量 test 绿） |
| R2 | 集成测试+冒烟 | `BBC_TEST_S3_ADDR` 门控 S3 集成测试（store 层全操作+presign 真链 PUT/GET+UNSIGNED-PAYLOAD 验签+DeleteObjects Content-MD5 断言）；本地 :9100 RustFS 冒烟全绿 | 集成测试对 RustFS 全绿；离线单测不回归 | [x] 2026-11-16（本提交；s3_integration_test.go 五用例对 RustFS 1.0.5 **全绿**：Save/Promote/Open/Head 往返+幂等、CopyTo 幂等、relay staging 位图/清理、**multipart 预签名真链**（预签名 PUT 6MB+1MB 分片=UNSIGNED-PAYLOAD 验签过/ListParts 位图/Complete 合并体逐字节核对/complete 后会话消失/Abort 作废）、预签名 GET+变体 image/jpeg Content-Type+DeleteKey/缺失语义；**UNSIGNED-PAYLOAD 验签与 DeleteObjects（RemoveStaging 路径）实测通过**——D25 §10「门控单测未落」遗留就此清偿；全量离线 test 无回归（未配 env 自动 skip）；冒烟容器即起即清） |
| R3 | 真机验收 | compose 栈全链（并入 D25 §9 六项：>8MB 分片直传/120s 票据/缩略变体//oss/ 前缀签名链/CORS 预检/断点续传） | 用户真机走查 | [ ] |

## 批次 W：品牌白标与构建期注入（D31，2026-11-16 W0-W3 编码完成待真机验收）

> 动机=开源适配：内网自部署方只改 `brand/` 一处（brand.json+logo.svg/icon.png）换名换标出自己的包。改动面=客户端+壳+服务端文案源+部署层。设计：[D31](detail/D31-品牌白标与构建期注入设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|------|--------|------|------|
| W0 | 设计落稿 | D31 新增+detail/README 索引（D30 已被并行占用顺延 D31） | 口径可追溯 | [x] 2026-11-16（400e28e） |
| W1 | 品牌地基 | brand/ 目录（brand.json 五品牌字段+identity 身份区/assets 迁入）+scripts/brand/gen.mjs 五类生成物（shared/brand.ts·壳 brand.rs·tauri.conf patch·logo 复制·index.html title）+Makefile brand/brand-conf 双 target+--check 门禁 | 默认值幂等零 diff；二次运行仍零 diff | [x] 2026-11-16（10ef544；tauri.conf patch 保 schemes 单行风格避免纯格式 diff；icon.png 从 client/app-icon.png git mv） |
| W2 | 前端触点收敛 | 12 文件 14 处改引 shared/brand（Logo alt/登录页/初始化页/关于页/侧栏 tooltip/两处系统通知署名/OIDC 确认卡/device_name/下载目录默认值）+i18n login.title 死键删除+顺收 D30 并行新增 ExtAgentCard 两处 | 全前端 BaobaoChat 硬编码清零；tsc+vite build 绿 | [x] 2026-11-16（2fcc78a） |
| W3 | 壳+服务端+部署参数化 | lib.rs register 改 brand::SCHEME（客户端 scheme 四处定义收敛）；config 三 env（BBC_BRAND_NAME/BBC_DEEP_LINK_SCHEME/BBC_BOOTSTRAP_MAIL_DOMAIN）；oidc 等待页模板 BrandName/Scheme 参数化；/setup+CLI bootstrap 邮箱后缀参数化（demo seed 不动）；compose nginx 占位插值；.env.tpl 三键；publish-website 门禁改读 brand.json；build-desktop.sh/ps1 前置 --check | cargo check/go build/vet/compose config 绿；试换牌 build 绿+回退零残留 | [x] 2026-11-16（c43c4d7；Acme 试换牌全链验证：生成→tsc/vite build 绿→git 回退零残留→--check 复绿；deep-link 日志 bbc:// 字样顺带动态化） |
| W4 | 真机验收 | D31 §6 四项：测试品牌 make brand 出包全变（安装包名/图标/登录页/通知署名）；老包覆盖安装不登出（identifier 不变）；OIDC 深链正常（scheme 未动）；改 brand/ 回退可逆 | 用户真机走查 | [ ] |

## 批次 X：Agent 安全模式重构（D32，2026-11-17 设计定稿待编码）

> 拍板（2026-11-17）：矩阵放宽对齐 ZCode 实战形态（本机实测其 shell 无 OS 沙箱纯权限层）——
> 任意命令 full-auto 自动/网络出站·git push·委派 auto-edit+ 自动/CorpWrite 唯一保留三档确认+Session 记忆；
> 删 Seatbelt（sandbox A 层）留进程生命周期（B）+词法（C），`BBC_SANDBOX=1` 标记保留给 procmgr 孤儿扫描；
> 白名单语义收紧（执行文件/控制运算符形态不匹配）；暗墙三件否决缓议（agent 需拿 token 办事）。
> 设计：[D32](detail/D32-Agent安全模式重构设计.md)。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|------|--------|------|------|
| X0 | 设计落稿 | D32 新增+EXECUTION-PLAN 批次 X+detail/README 索引 | 口径可追溯 | [x] 2026-11-17 |
| X1 | 删 Seatbelt | launcher.rs 收缩纯进程管理器（删 SANDBOX_EXEC 常量/profile/detect/SandboxLevel/DegradedInfo/sandbox-exec 分支）+接线三处（config.rs/main.rs/cmd.rs）+测试同步 | agent cargo test --workspace 全绿；rg sandbox-exec/Seatbelt/SandboxLevel/DegradedInfo 代码零命中；词法层测试无回归 | [x] 2026-11-17（187dd4a；净 -391 行；B 层生命周期+BBC_SANDBOX=1 孤儿标记+violation 记录原样保留；escape_suite B12 行1/3/6 留 L2 断言、行4/5/7/8/9 生命周期用例全绿；顺修 bbrt-mcp fmt 漂移+roundtrip.rs 既有 unused import；581 passed/0 failed+fmt 绿） |
| X2 | 矩阵+词法收紧 | gate.rs 四函数（matrix/classify_action 白名单守卫/memory_allowed CorpWrite=仅 Session）+测试新语义断言+D13/09/D11 文档追记（推翻 D13-A2 部分须注记） | cargo test 全绿（矩阵新断言）；文档追记可 grep | [x] 2026-11-17（矩阵：任意命令 full-auto✅/网络·push·委派 auto-edit+✅/CorpWrite 唯一三档🔶+Session 记忆（NEVER_PERMANENT_TOOLS 扩 file_upload/app_write 六件双保险）；白名单守卫 is_plain_direct_invocation（复合运算符/执行文件形态落任意命令）；confirm_scopes 删 full-auto 任意命令特例臂；测试重写 row4/rows67 拆分/row7 CorpWrite Session/row9 跟档+新增守卫用例；583 passed/0 failed） |
| X3 | 真机验收 | 三档走查：auto-edit 修 bug 全程仅跑测试 1 弹；full-auto 0 弹+高危红卡仍拦；im_send Session 记忆二问变一问 | 用户真机走查 | [ ] |
