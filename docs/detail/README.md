# 详细设计文档库（D 系列）

> **⚠ 2026-11 瘦身二阶段注记**：音视频通话（rtc/LiveKit）、会议（meeting）域与文件分享外链（/s/{code}）已移除——本文涉及 rtc.*/meeting.*/call_card/通话卡片/会议/分享外链的章节已作废，错误码 4010-4012 与 5xxx 段废弃不复用。删除前快照：git 分支 `backup/full-suite-20261109`。

对应概要设计（`docs/` 00–17 篇）的**详细设计阶段**：页面（区块级线框）、交互（事件级）、接口（字段级）、模型（DDL 级）、响应（四档断点 + 六态 + 性能反馈）、模块划分（文件级目录树）。

## 公共规范（所有模块篇必须遵守）

- 设计系统 / 断点 / 六态 / 快捷键 / 前端工程结构 / 篇章模板：**[D01](D01-客户端总体详细设计.md)**
- 服务端模块划分 / 依赖规则 / 事件总线 / 中间件链：**[D02](D02-服务端模块划分与工程结构.md)**
- 协议（信封/事件/错误码/REST 约定）：**[14-通信协议设计](../14-通信协议设计.md)**

## 文档索引

| # | 文档 | 对应概要篇 | 覆盖模块 |
|---|---|---|---|
| D01 | [客户端总体详细设计](D01-客户端总体详细设计.md) | 00/01/02 | 窗口/路由/布局/令牌/六态/反馈/快捷键/工程结构 |
| D02 | [服务端模块划分与工程结构](D02-服务端模块划分与工程结构.md) | 02/13/14 | Go 模块/依赖规则/事件总线/中间件/测试 |
| D03 | IM 模块详细设计 | 04 | 会话列表/消息流/群管理/搜索/通知中心 |
| D06 | 文件与图片模块详细设计 | 07 | 传输管理器/查看器/发送预览/我的文件/外链 |
| D07 | 知识库模块详细设计 | 11 | 三级空间/检索/摄入/授权/敏感治理 |
| D08 | Agent 工作台模块详细设计 | 08/09/17 | 会话视图/审批卡/委派卡/检查点/后端管理 |
| D09 | 生态应用与技能模块详细设计 | 10 | 发布向导/灰度/技能市场/安装管理 |
| D10 | 管理后台模块详细设计 | 12 | 仪表盘/组织/用户/角色/策略/审计/用量 |
| D11 | Agent Runtime 内部详细设计 | 08/09/17 | crate 划分/状态机/stdio 协议/上下文引擎/沙箱管线 |
| D12 | 身份与组织域详细设计 | 03/12 | **多租户隔离与生命周期/权限判定引擎/权限点全字典/认证页面族/通讯录/账号安全/设备管理**；管理端组织·用户·角色页面外壳见 D10，领域机制与 API/模型在本篇 |
| D13 | 变更控制模式与沙箱执行详细设计 | 09/17/D11 | **A**：三档模式（变更前确认/自主/完全控制）能力矩阵·配置层级·升降级交互；**B**：无 Docker 沙箱（bwrap/Seatbelt/JobObject 分层防御·降级矩阵·逃逸测试） |
| D14 | 专家 Agent 与多智能体协作设计 | 08/10/17/D11 | **Team Graph**：专家 Persona 定义（工具/技能/MCP 绑定）·公司库+个人库两级分发·三种协作拓扑·黑板通信·MCP 客户端/服务端两期方案·对 dsh 的采纳决策记录 |
| D15 | Agent 记忆双轨与日报详细设计 | 08/09/D11/D08 | **主动轨**：知识记忆（ZCode 式 memory/*.md+MEMORY.md，工具/规则/会话提炼三写入路径，召回注入）；**被动轨**：活动日志→确定性日报（journal JSONL→reports/YYYY-MM-DD，幂等+回补）；与 09 篇权限三级记忆正交 |
| D16 | [子 Agent 三形态与 Run 记录模型设计](D16-子Agent三形态与Run记录模型设计.md) | 08/17/D11/D14 | **最终口径**：通用子 agent（同主 prompt 全工具）/专家（建议配置+本地覆写）/本机 CLI 委派（零凭证）；**run 记录**：agent_run 统一审计行+调用链字段+事件挂 run_id；同步等待窗 120s+委派直接后台+无时长上限；对上游文档的修订清单 |
| D18 | [IM 内嵌 Agent 卡详细设计](D18-IM内嵌Agent卡详细设计.md) | 08/D03/D08/09 | **(用户,会话) 一会话**·完整过程透明卡（思考/工具/结论，推翻 D08 轻量口径）·审批弹框聊天页（推翻 OQ-B08 白名单）·分阶段更新落流（agent_card+PATCH 通道）·升级=文本注入；安全五层纵深登记阶段二（v0.1 复用 agent 既有能力）；bbrt/协议零改动 |
| D19 | [Agent 项目/日常双区与记忆分级详细设计](D19-Agent项目与日常对话及记忆分级详细设计.md) | 08/D08/D09/D11/D13/D15/D18 | **双区模型**：session.start workspace 空串=日常/非空=项目（realpath 归一+agent_workspace 接线+workspace_id 回填）·**沙箱按会话路由**（修全局 "." 占位缺口：项目会话各自沙箱根、日常 workspace 类工具 8020 拒绝）·**记忆分级**（memory/projects/<目录名-哈希> 分区+类型驱动路由+两段召回）·session.list 持久恢复+workspace 三 REQ·工作台过程显示对齐 change-my-life（思考卡流式展开/工具组汇总条/自动折叠） |
| D20 | [ask-user 提问卡详细设计](D20-ask-user提问卡详细设计.md) | 08/D08/D11/D18/09 | **ZCode 式澄清机制**：ask_user 工具（loop_runner 拦截不走 pipeline）·clarify.request/response 协议对（camelCase 键，**无超时**——等用户或「停止」中断收口 cancelled）·WaitingClarify 状态（#6b/#7b）·三端提问卡（工作台 ClarifyCard/聊天页 Modal/落流卡内嵌条，ClarifyForm 共用）·答案进工具结果（结构化回给模型）·完全镜像 permission 阻塞机制 |
| D21 | [自动更新与官网发布链详细设计](D21-自动更新与官网发布链详细设计.md) | 16/15/D01 | **发布工程**：单变量 BBW_PUBLIC_URL 三链注入（前端 env/壳编译期网关/updater 端点）·v0.1 统一 http 拍板（证书口径澄清与转 https 三步走）·updater 全链（minisign 密钥/静默 6h 检查/关于页更新卡/requireSignedVersion 拒降级）·nginx 80 主入口全路由（补 /v1/ /mcp/ bbrt 生产链路）·update-src/website 落地 bind 卷·gen-manifest/publish 脚本族·官网工程（运行时拉 release-info 自动跟进版本） |
| D22 | [插件系统详细设计](D22-插件系统详细设计.md) | 09/D08/D11/D14 | **插件市场**：Claude Code 插件格式超集（.bbw-plugin 主/三目录名都认）·五类组件一包（skills/工具=MCP/命令/专家/hooks 只读不执行）·工具一律 MCP（进程内不做/dsh 兼容否决）·市场三表+包体 bytea+发布双端校验（zip slip）·PluginPage 市场/已安装/配置表单（SkillTab 并入删除）·落盘多版本+activeVersion 回滚·`mcp.config`/`auth.push`/`config.push` 宿主协议（MCP 装配从 env 走向动态下发）·三变量族身份注入（`${BBW_USER_TOKEN}` HTTP-only/`${CONFIG:*}` 钥匙串/`${PLUGIN_ROOT}`） |
| D23 | [Agent 记忆系统升级详细设计](D23-Agent记忆系统升级详细设计.md) | 08/09/D11/D15/D19 | **公共层换制**（D15 文件族+LRU→journal+USER.md 压实视图）：预算 3000/2400/单条 80 字·十类硬枚举+硬度轴（禁止/授权硬·压实不可删只能显式解除·目标时敏）·压实漏斗（规则→仅软条目进 bbw-fast→硬条目程序拼回→校验失败宁旧勿错）·view=缓存/journal=真相+启动 reconcile·更正=forget+write 零 LLM（条目粒度防同名误伤）·provenance 只进 journal·项目层沿用收口（LRU 废除/hook ≤40 限长/last_used/蒸馏纪律 P1）·不做身份键（人轴外包 OS）·状态类延后·BBW_MEMORY_ROOT 联调隔离·插件 MCP 信任边界（记忆目录不进插件 fs 授权） |

| D24 | [知识库博客化详细设计](D24-知识库博客化详细设计.md) | 11/19/D10/D06 | **两维度轻量博客**（11 篇/D07 重型 RAG 冻结，重型走 D22 插件）：公司知识库+我的笔记两维度·「空间」产品概念消失（多空间/成员制后置）·纯阅读+检索+榜单（无写入 UI，API 留给 AI/OBO）·目录=专栏·保存/投稿分离·浏览量日去重+作者不计·三列榜单（最新/最热窗口/作者榜）只收公共维度·检索三态降级（ILIKE→RRF→rerank）·嵌入切换 epoch 渐进重建·aigw 补 /v1/rerank+真实 Embed+registry 放开两档 |
| D25 | [对象存储与预签名直传设计](D25-对象存储与预签名直传设计.md) | 07/D06/13/16 | **MinIO 替换本地盘**（双副本 404 治本）：aws-sdk-go-v2·双实现回落（BBW_S3_ENDPOINT 空=Local 开发零负担）·仅 >8MB 分片预签名直传（≤8MB 中转保留，07 全量预签名修订）·part_size 4→8MB（S3 ≥5MiB 硬限）·对外端点 nginx 443 `/oss/` 路径代理（strip+Host 透传+签名按去前缀路径算、URL 拼回）·complete=CompleteMultipart+流式 sha 校验+CopyObject(>5GB UploadPartCopy 环)·ticket=预签名 GET 120s+variant(240/720 JPEG 缩略同批，webp 弃)·mc mirror 迁移脚本 file 表零改 |
| D26 | [全站 UI 组件库切换 Ant Design 详细设计](D26-全站UI组件库切换AntDesign详细设计.md) | D01/D24 | **antd 5 换制（除 IM 气泡全量）**：--bbw-* 令牌全量灌 theme 零漂移·表单控件层替换（不强推 Form）·24 处 confirm→Modal.confirm·Button/Skeleton 包装化过渡·15+ 弹窗→Modal/Drawer·kb-tabs/树→Tabs/Tree·toast 统一 message·global.css 10384→≈3000·IM 气泡族/MarkdownText/ctx-menu/Splitter/StateView 保留 |
| D26 | [个人 MCP 接入面设计](D26-个人MCP接入面设计.md) | 09/D11/D14/D16/D22 | **D16 P1-5 补账**（zcode 同款用户自配 MCP）：仅个人自配面·纯客户端本地存储（personal.json+钥匙串真值不落盘，同插件 config 制）·装配第三源 corp>插件>个人（同名跳过防劫持）·变量族 D22 子集（TOKEN HTTP-only 不变）·bbrt-mcp 手写 HTTP 补 https/TLS（rustls ring+webpki-roots）·测试连接走 RT 真实链路（McpTest 协议对+一次性 McpClient）·新 server 重启会话生效（注册表快照限制沿用插件口径） |
| D27 | [主题机制与色彩规范](D27-主题机制与色彩规范.md) | D26/D01 | **黑白反色主题+取色单源机制**（用户拍板「主题色黑」+去毛坯修正）：themeConstants 唯一色源（antdThemeFrom→ConfigProvider / cssVarsFrom→注入 --bbw-* 双轨同源）·分层黑（布局 #0a0a0a/容器 #141414/浮层 #1c1c1c）·灰阶 10 阶中性化·语义色按底调亮度·默认暗色+防闪烁三处同步·开发守则（禁止硬编码色值/新增颜色四步流程/白名单）·验收清单 |

## 模板（D01 §13）

概述与范围 → 页面与路由 → 页面详细设计（线框+六态） → 交互详细设计（INT 事件表+状态机） → 接口详细设计（全参数+示例 JSON） → 模型设计（DDL+TS 类型） → 响应式适配（四档断点） → 模块划分（目录树） → 边界与异常 → 开放问题。
