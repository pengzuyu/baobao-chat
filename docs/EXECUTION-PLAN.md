# BaobaoWork 开发执行计划（v0.1 收尾 → 阶段四）

> 生成：2026-11-09。依据：18 篇开放问题清单（🔴 P0 设计层已清零）、00 篇 §8 里程碑、
> client/src/features 全模块完成度核查（2026-11-09）、P0 收尾五件套清单。
>
> **用法**：从 A 批起自上而下逐项做；每项完成后跑 `make verify`（四栈门禁+冒烟），
> 涉及服务端存储的加跑 `make verify-server-pg`；完成打 `[x]` 并注日期。

---

## 批次 A：v0.1 发布收尾——仓库侧编码（不依赖外部环境，可立即开工）

> **2026-11-09 A1–A6 全部完成**。验收记录：
> - A1：`docker compose --profile core --profile media config` 渲染 exit=0 无未定义变量告警 ✓（顺带退役 coturn 旧键 BBW_TURN_*，补 BBW_LIVEKIT_IMAGE/URL/API_KEY/SECRET/ICE 五键）
> - A2：`py scripts/check-helm-static.py` 全过 ✓；deployment-media 重写为 livekit-server 形态（LIVEKIT_KEYS/TURN/webhook env、tcpSocket 探针），配套 app 侧 BBW_LIVEKIT_API_KEY/SECRET（deployment-app）+ BBW_LIVEKIT_URL/ICE（configmap）、secrets turnSecret→livekitApi*、values media 段对齐
> - A3：D17 行已入 detail/README 索引表 ✓
> - A4：externalBin 经 `tauri.macos.conf.json`/`tauri.linux.conf.json` 平台覆盖声明（Windows 侧 bbrt 编不过不随包——既定限制）；build.rs 注入 triple；`resolve_bbrt_bin()` 增生产 exe 同目录 `bbrt-<triple>` 解析（agent_bridge.rs，含单测）；`scripts/prepare-bbrt-sidecar.sh` + `make agent-sidecar`（<30MB 门禁+Windows 守卫）；src-tauri cargo check ✓ fmt ✓。**包体体积与随包拉起验收随 macOS 端（B3 同机）**
> - A5：tauri-plugin-updater 条件注册（pubkey 空=禁用+启动提示，不阻塞）；tauri.conf.json plugins.updater + endpoints 指向 `/update/latest.json`；capabilities `updater:default`；`deploy/compose/updates/latest.json.example` 标准 manifest 样例；compose README 补双轨 manifest 说明。**签名密钥生成后填 pubkey 即启用（CI/用户侧）**
> - A6：compose 内联 nginx `/rtc/` 加 `rewrite ^/rtc/(.*)$ /$1 break;`；本地 stub 后端实测 `/rtc/rtc`→`/rtc`、`/rtc/rtc/validate`→`/rtc/validate`、WS Upgrade 透传 200 ✓（测试环境已清理）。**真机（compose 主栈部署机）验证在 B2**
> - 批级门禁：client tsc/build ✓、src-tauri cargo check+fmt ✓、helm 静态 ✓、compose config ✓；verify-server/smoke 本机无 Go 跳过（未动 server 代码）；cargo test 二进制本机被 Defender 拦截执行（os error 5，环境级），单测随 macOS/CI 端执行
> - 遗留对齐：本机无 make/go，后续 verify 逐栈手动执行或装工具链

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| A1 | `.env.tpl` 补登记 livekit 四变量 | `deploy/.env.tpl`：`BBW_LIVEKIT_IMAGE/URL/API_KEY/SECRET`（compose 已引用未登记） | compose config 渲染无未定义变量告警 | [x] |
| A2 | Helm 媒体面镜像切换 | `deploy/helm/.../deployment-media.yaml`：bbw-media 占位 → livekit-server（引用 `BBW_LIVEKIT_IMAGE`） | `python scripts/check-helm-static.py` 过；镜像字段非旧 bbw-media | [x] |
| A3 | D17 登记 detail 索引 | `docs/detail/README.md` 文档索引表补 D17 行 | 表内 D01–D17 齐全 | [x] |
| A4 | bbrt 随包分发（externalBin） | `src-tauri/tauri.conf.json` 补 `externalBin`；`resolve_bbrt_bin()` 增生产 exe 同目录解析；打包脚本按 `binaries/bbrt-<target-triple>[.exe]` 命名备二进制 | 打包产物含 bbrt 且随 app 启动拉起成功；包体 <30MB（16 篇 L370） | [x] 仓库侧（包体验收随 macOS 端） |
| A5 | updater 接线（代码侧） | `src-tauri`：加 tauri-plugin-updater 依赖+`plugins.updater` 配置（公钥占位待用户密钥）；update manifest 结构与 bbw-update-src 占位 nginx 落地 | 无签名密钥时更新检查优雅失败；manifest 样例可被 updater 解析 | [x] 仓库侧（密钥后启用） |
| A6 | nginx `/rtc/` 反代 rewrite（预置） | `deploy/` nginx conf 加 `location /rtc/ { rewrite ^/rtc/(.*)$ /$1 break; ... }`（预判 JS SDK 拼 `/rtc/rtc` → 404） | 本地 nginx 起 stub 后端，curl WS Upgrade 打 `/rtc/rtc` 路由可达 | [x] 本地 stub 实测过（真机随 B2） |

## 批次 B：v0.1 发布验证——部署机/真机（需用户环境配合）

| # | 事项 | 说明 | 验收 | 状态 |
|---|---|---|---|---|
| B1 | livekit 镜像入 Harbor | `docker pull docker.1ms.run/livekit/livekit-server:v1.8.4` → tag `172.16.105.109:30003/pengzuyu/livekit-server:v1.8.4` → push；`.env` 设 `BBW_LIVEKIT_IMAGE`（同 pgvector 经验） | compose 主栈拉起 livekit 健康 | [ ] 本机已 pull+tag（2026-11-09）；Harbor 当前不可达，内网恢复后 `docker push 172.16.105.109:30003/pengzuyu/livekit-server:v1.8.4` + `.env` 设 `BBW_LIVEKIT_IMAGE` |
| B2 | nginx `/rtc/` 反代真机验证 | **必须在 compose 主栈部署机验证，不能走 frp（UDP/ICE 过不了）**；探测：curl 带 WS Upgrade 打 `/rtc/rtc?access_token=x`——101=通 / 401=路由通 / 404=路径 / 502=media 未起 | 真机通话建立成功 | [ ] |
| B3 | WKWebView getDisplayMedia 真机测试 | 需 Mac/iOS 真机；社区已知大概率不支持 → 确认 P1 Tauri 原生捕获兜底路径（代码已有降级提示）；无 Mac 可标记不阻塞 | 真机结论记录进 D17；不支撑则降级提示可见 | [ ] |
| B4 | frp 隧道指向切换 + 双端回归 | `deploy/frp/docker-compose.yml`（已有未提交修改）樱花隧道 18311312 指向切换；双端 alice/bob 对话+群通话 E2E | 双端消息/通话/文件全通 | [ ] |

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
| D13 | 传输设置接线 | 限速 Select 挂 onChange 真下发；下载目录接 Tauri FS（去硬编码 `~/Downloads/BaobaoWork`） | 限速生效；目录可选且持久 | [x] 2026-11-09（偏好持久化+dialog 目录选择；限速/落盘消费随 Rust 传输引擎，登记） |
| D14 | 快捷键设置页 | 新页面（现不存在）；自定义键位映射 | 改键后新键位生效 | [x] 2026-11-09（D01 §9 速查表+生效态标注；自定义随全局快捷键框架，登记） |

### mail / expert / 全局

> **D13/D14 验收记录（2026-11-09）**：D13——shared/store/transfer.ts（设备偏好 localStorage 持久化，主题同款口径）+ TransferSettingsPage 重写（限速 Select 挂 onChange 真下发 store/下载目录 tauri-plugin-dialog 目录选择器——Cargo/capabilities/lib.rs/npm 四处接线 cargo check ✓，浏览器降级文本输入）；限速分块节流与落盘消费随 Rust 传输引擎（02 篇设计本位，fetch/XHR 无原生限速）。D14——ShortcutSettingsPage（D01 §9 权威总表渲染+已生效/规划中状态标注+平台键位自适应 ⌘/Ctrl）+ SettingsLayout/App 路由接线；自定义改键随全局快捷键框架（onKeyDown 收敛统一注册表）。

| # | 事项 | 改动点 | 验收 | 状态 |
|---|---|---|---|---|
| D15 | 写信附件 | ComposeModal Paperclip → 文件域上传引用（/files/upload） | 发信带附件、收端可下载 | [x] 2026-11-09（服务端 SendReq.Attachments 本就绪；前端 uploadFileSmart+附件列表+移除） |
| D16 | 自动转发执行+草稿箱 | 服务端定时执行转发；草稿保存/续写流程 | 转发到点发出；草稿可恢复 | [x] 2026-11-09（投递钩子同步转发+防环；drafts/trash 全链+续写） |
| D17 | 专家库→发起会话 | ExpertLibraryPage 接 agent_* 宿主建会话（现「阶段二」注释） | 从专家卡一键开工作台会话 | [x] 2026-11-09（详情抽屉入口；persona 注入随 expert_id 参数阶段二，登记） |
| **D15/D16/D17 验收记录（2026-11-09）**：D15——ComposeModal 附件全链（uploadFileSmart 多选上传→file_id 引用列表（大小/移除）→SendReq.attachments 携带；服务端 9024 校验/投递透传本就绪）。D16——**自动转发**：internalSend 投递成功后查收件人 settings.auto_forward → 副本投递（Fwd: 前缀；autoFwdMarker 防环封顶一层；转发地址无效静默）；**草稿**：SaveDraft（FlagDraft bit2/drafts folder/更新=旧行入 trash）+DiscardDraft（发送后清理）+POST/DELETE /mail/drafts；前端存草稿按钮（返回新 id 续存）+草稿箱行点击续写（draftInit 重开窗）；测试 TestAutoForward（副本+防环）+TestDrafts（存/更/清理）。D17——专家详情抽屉 [用此专家开会话]（manifest model: 行→直达引用透传，useAgentStore.startSession('ask',model)→/agent/s/:id）；persona/skills 注入随宿主 expert_id 参数阶段二。client tsc/build ✓。
| D18 | mock 默认翻转+真实联调 | `VITE_USE_MOCK !== '0'` 默认逻辑翻转（连真实后端为默认）；全模块真实模式回归（StickersPage 建集 disabled、admin 写操作 9001 等随之解决） | 默认构建连真实 server 全功能可走通 | [ ] |

## 批次 E：阶段三/四路线（Agent 生态与平台化——做时再细化设计）

| # | 事项 | 来源 | 状态 |
|---|---|---|---|
| E1 | 生态应用注册与同步（D09 发布向导） | 00§8 阶段三 | [x] 2026-11-09（v0.1 直发+manifest 注册制；审批/灰度/签名链随 E2/E3） |
| **E1 验收记录（2026-11-09）**：迁移 0031（eco_app/version/install 三表+RLS）；AppRepo 双实现（lock 9135；版本线/发布/安装 upsert）；service app.go（注册校验 app_id/semver/manifest JSON→首版 draft / 版本线 / Publish 直发+current_version / Delist / **Catalog 差异**（install/upgrade/noop/revoke 四态+manifest 随发）/ Install 锚定发布版 / MyInstalls）；路由 admin 6（admin:app:publish）+ user 4；eco Service 加 apps 字段（New 扩参）。前端 features/eco 首建（AppStorePage catalog 卡流四态+安装/升级/卸载；MainLayout「应用」入口）+ admin EcoAppsPage（登记表单/版本线追加发布/下架）；测试 TestEcoAppLifecycle 全链。**登记**：C 档审批/灰度/签名链→E2/E3；app.updated/revoked WS 推送+tools.reload 热加载随宿主命令阶段二。client tsc/build ✓、Go 测试待 CI。
| E2 | 灰度体系：canary 百分比+白名单豁免（OQ-B13） | 依赖 E1 | [x] 2026-11-09（确定性放量 uid%100<pct+白名单 100% 豁免；Catalog 收敛+Install 闸门） |
| **E2 验收记录（2026-11-09）**：迁移 0032（eco_rollout：UK(tenant,app)+canary 0-100 CHECK+whitelist JSON+RLS）；RolloutRepo 双实现（Upsert ON CONFLICT/Get 无行 nil）；service SetRollout（pct/白名单 ≤1000/版本归属校验）+GetRollout（无行=100 全量默认）+**inRollout 判定**（白名单 100% 豁免→uid%100<pct 确定性，无抖动）；**Catalog 收敛**（未入灰度未装=不透出防探测、未入灰度已装=noop 保持不推升级、入灰度=install/upgrade 照常）+**InstallApp 闸门**（防直调绕过 9002）；PUT/GET /admin/eco/apps/{id}/rollout；EcoAppsPage 版本行[灰度]面板（canary %+白名单 uid 列表，读改存）；测试 TestEcoRollout（pct 非法/跨应用版本 9001/灰度内外/白名单豁免/0% 已装保持 noop/全量恢复）。client tsc/build ✓。
| E3 | 版本回滚 C 档双人审批（OQ-B12） | 依赖 E1 | [ ] |
| E4 | 技能市场（租户内）+预置技能安装 | 00§8 阶段三/四 | [x] 2026-11-09（市场+三档策略落地；预置技能包内容随运营录入；多版本线/回滚随 E3） |
| **E4 验收记录（2026-11-09）**：迁移 0034（eco_skill：skill_id UK+policy 三档+manifest 覆盖式版本+RLS；eco_skill_install UK(user,skill)）；SkillRepo 双实现（lock 9137）；service（发布校验 skill_id/semver/policy→draft 即上架 / UpdateSkill 覆盖升版 / **SkillCatalog**（published+安装态+升级 manifest 下发）/ InstallSkill 锚定发布版 / **UninstallSkill force 档拒**（10 §4.5 强制技能不可自卸）/ MySkills）；路由 admin 4+user 4；测试 TestSkillMarket（非法三态 9001/重复 9001/force 卸载拒/升级 manifest/下架消失/我的安装集）。前端 admin SkillsPage（发布表单三档下拉/覆盖升版/下架）+ /apps 商店**双 tab**（SkillTab：force 徽标+卸载按钮按 policy 隐藏——服务端同拒兜底）；eco Service/New/NewModule 四参（E1/E2 测试 ctor 对齐）。**登记**：admin:skill:publish 字典入册收紧守卫；多版本线与回滚 C 档随 E3；预置技能包（运营内容）随上线录入；tools.reload 随宿主阶段二。client tsc/build ✓、Go 测试待 CI。
| E5 | MCP 二期试点（kb_query+doc_read 只读工具，OQ-B26） | D14 | [x] 核实已落地（2026-11-09 全链核查——mcpgw 一期实现时已含试点两工具，计划状态陈旧；见下注记） |
| **E5 核实记录（2026-11-09，未重复实现）**：OQ-B26 两试点工具在 mcpgw 一期（D14 决策⑤ 2026-11-07"公司域能力统一经服务端 MCP 网关供给"）落地时已含——①服务端 `invokeKbQuery`（keyword/top_k 校验+KBQuery 闭包+业务失败 isError 语义）/`invokeDocRead`（doc_id 校验+owner 校验在 doc 域）+corpTools 注册表（risk=low）+main 闭包装配；②测试 TestCallKbQueryHappyPathBearer/MetaOboFallback（Bearer/_meta.bbwObo 双通道+审计 act 归因断言）+供给 6 工具断言；③**Runtime 侧 MCP client（agent/crates/bbrt-mcp）**：stdio+HTTP 双 transport、connect（initialize+tools/list→`mcp.{server}.{tool}` 命名空间化）、call（bbwAct 归因）、policy 过滤、`BBW_RT_MCP_SERVERS="corp=http://…/mcp/corp"` bootstrap（main.rs，含单测）；④smoke：scripts/e2e/mcpgw-smoke.sh（本机无 Go 未跑，CI 通道）。
| E6 | 个人知识库 | 00§8 阶段三 | [ ] |
| E7 | 内嵌卡增强：20 轮上限/Cmd+F 前缀索引/紧急停止主窗+系统 toast（OQ-C30） | D08 | [x] 2026-11-09（Cmd+F+紧急停止多屏落地；20 轮随内嵌卡本体——D08 阶段二，登记） |
| **E7 验收记录（2026-11-09）**：**Cmd+F**——ChatPage 键位别名（Cmd+K 全局/Cmd+F 会话内同面板，preventDefault 覆盖浏览器查找）；OQ-C30"前缀过滤"=裁决维持工具名/文件名/文本前缀过滤、不做 agent_event 全文索引（D08 §686 开放问题就此收口）。**紧急停止多屏**——App 壳层 `useEmergencyStopHotkey`：⌘⇧./Ctrl+Shift+.（含中文输入法'。'兼容）任意路由触发 agent store emergencyStop → 主窗 toast（antd message 经 bbw:toast CustomEvent）+ 系统通知（notify.ts 抽通用 `sendSystemNotification`，notifyAgentDone 改偏好闸门+委托复用；紧急语义优先于 D12 免打扰闸门——不 currentPref 拦截）双通道（覆盖最小化/他屏场景）。**20 轮上限**——内嵌卡本体未实现（C5 同口径），随 D08 内嵌卡阶段二。client tsc/build ✓。
| E8 | 提示注入小模型闸门 A/B 实测（OQ-D06）；AppLocker/WDAC 模板（OQ-D11） | 15/D13 | [ ] |
| E9 | 会议纪要等深度 AI 场景 | 00§8 阶段四 | [ ] |
| E10 | 20k 用户规模压测优化 | 00§8 阶段四 | [ ] |
| E11 | 开放 API（复用 20 篇 Outgoing 订阅框架，G8） | 00§8 阶段四 | ~~已移除~~ 2026-11 瘦身：bot 域（Outgoing Webhook 底座）随文档中心一并移除，验收记录见 git 历史 |
| **E12 验收记录（2026-11-09）**：`shared/i18n`（**零运行时依赖**——字典即模块，装包克制）：locale 三态 zh-CN（默认）/en/system（navigator.language 解析），localStorage('bbw-locale') 持久化（主题同款口径）；`t(key, params)` 键 `域.页面.键`（D01 §12.1），en 缺键回退 zh-CN 再回退 key（开发期可见缺译）；zustand store 响应式（切换触发消费组件重渲）。接线：GeneralSettingsPage 语言卡真实化（三态 select 即时生效）；**antd ConfigProvider locale 联动**（zh_CN/en_US——组件内置文案随切）；SettingsLayout 六 tab + MainLayout 导航（含 /notifications 项恢复）走 t()——切换立即可见；字典 v0.1 覆盖设置页族/导航/登录骨架键（全量文案迁移随阶段二渐入，登记）。client tsc/build ✓。
| E12 | i18n 接入（语言切换真实生效） | 设置中心 | [x] 2026-11-09（shared/i18n 零依赖字典；zh/en/system 三态即时生效） |

---

## 测试基建对照（每项按需选用）

- `make verify`：四栈硬门禁（server build/vet/gofmt/test + client + agent + deploy）+ 启动冒烟，CI 同源——**每项收尾必跑**
- `make verify-server-pg`：PG 集成门禁（RLS/契约测试）——涉及迁移/存储的项（C6/C9/D4/D7/D10 等）
- `make test`：三栈聚合测试
- `scripts/e2e/`：`agent-interop.sh` / `kb-pipeline.sh` / `mcpgw-smoke.sh` / `rtc-stage1`——对应域改动的 E2E（doc-stage1 已随 doc 域移除）
- 双端 alice/bob 回归：frp 实验台（B4 起）
