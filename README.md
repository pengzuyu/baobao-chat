<div align="center">

# BaobaoChat

**自托管的企业 IM + AI Agent 工作台**

私聊群聊 · 通讯录 · 企业知识库 · 本地执行的 AI Agent · 插件与 MCP

`MIT License` · `Windows / macOS / Linux` · `Docker Compose / Kubernetes`

</div>

---

把「团队聊天」和「能在员工电脑上干活的 AI」放进同一个客户端：服务端完全自托管，
数据不出企业边界；Agent 执行过程全透明，写文件、跑命令要你点头。

- **企业 IM**：私聊、群聊、广播群、通讯录、在线状态、多端同步、文件与图片传输
- **AI Agent 工作台**：Agent 在你本机执行，三档权限 + 审批卡 + 子代理 + 定时任务
- **企业知识库**：公司知识库 + 我的笔记，中文检索带权限过滤，为 Agent 提供可信上下文
- **插件与 MCP**：兼容 Claude Code 格式的插件超集，MCP 三源接入，能力按需下发
- **开放被调用**：壳内 A2A / MCP 服务，Claude Code、zcode 等外部智能体一条命令接入
- **企业治理**：多租户硬隔离、RBAC、OIDC 统一登录、AI 网关、审计哈希链、客户端发布管理

## 能力一览

| 模块 | 能力 |
|---|---|
| **IM 即时通讯** | 私聊 / 群聊 / 广播群；@ 与引用、编辑撤回、转发、已读回执、收藏、表情；通讯录全员可见与自助注册；四档在线状态；全文搜索与通知中心；WSS + seq 游标多端同步 |
| **文件与图片** | 分片上传、断点续传、秒传、缩略图；大文件预签名直传对象存储 |
| **AI Agent 工作台** | 自研 Agent 循环（不依赖 LangChain）；思考 / 工具 / 结论流式可见；项目区与日常区分离；三档权限与内嵌审批卡；子代理（并行探查 / 声明式专家）；后台终端任务；定时任务（cron / 一次性 / 工作日历）；会话记忆与项目进度台账；IM 会话内嵌 Agent 卡 |
| **知识库** | 公司知识库 + 我的笔记两维度；PostgreSQL + pgvector + zhparser 中文检索；摄入管线；权限过滤前置到 SQL；Agent 检索 API 可回溯原文 |
| **插件与 MCP** | skills / commands / agents / hooks / mcp 五类组件；插件市场（上架 / 安装 / 更新 / 撤销）；MCP 三源（企业 > 插件 > 个人）；凭据存系统钥匙串 |
| **开放面（被调用）** | 壳内只监听本机的 A2A 正身 + MCP 脸（默认 `127.0.0.1:8791`）；本机 token 授权；外部会话在任务区可见 |
| **治理与安全** | 多租户 `tenant_id` + PostgreSQL RLS + 存储前缀；RBAC + 数据范围 + 资源 ACL；OIDC 统一登录（生态应用 SSO）；AI 网关（路由 / 配额 / 熔断 / 脱敏 / BYOK）；审计追加写 + 哈希链；工作日日历；客户端发布（上传 → 发布 → 回滚） |
| **部署交付** | Docker Compose 单机全栈 / Kubernetes Helm chart / 内网离线包；品牌白标单源（`brand/`） |

## 和常见方案的区别

| 维度 | BaobaoChat | AI 对话面板（LibreChat / Open WebUI） | 企业 IM（Tailchat / 野火 IM） | AI 应用平台（Dify） |
|---|---|---|---|---|
| 员工之间私聊 / 群聊 | ✅ | ❌ | ✅ | ❌ |
| Agent 在员工本机执行、使用本机权限 | ✅ 本地 sidecar | ⚠️ 服务端容器内工具 | ⚠️ 多为插件中转 | ❌ 服务端工作流 |
| Agent 过程可见 + 分级审批 | ✅ 三档权限 + 内嵌审批卡 | ⚠️ 部分 | ❌ | ⚠️ 部分 |
| 知识库 / RAG | ✅ 两维度 + 权限前置 | ⚠️ 基础 | ⚠️ 插件 | ✅ |
| 多租户 RLS / RBAC / 审计链 | ✅ | ⚠️ 基础 | ⚠️ 群组权限 | ⚠️ 工作空间 |
| 桌面客户端 | ✅ Tauri（Win / macOS / Linux） | ⚠️ Web 为主 | ⚠️ Web / 壳 | ⚠️ Web |
| 白标换名 | ✅ 改一个品牌目录 | ⚠️ 改代码 | ⚠️ 改代码 | ⚠️ 商业版 |

> 对比按「定位差异」而非「谁更强」整理；各项目能力随版本变化，请以官方说明为准。
> 本产品当前**不含**音视频通话、会议、在线文档协作与移动端 App。

## 核心设计

1. **Agent 本地执行** —— 服务端只做鉴权、分发、模型代理与审计，不执行用户代码。
2. **Agent 以用户身份行事（OBO）** —— 短时效 token + `act` 声明 + 双写审计，禁止服务级超级账号。
3. **权限最小化** —— 询问 / 自动编辑 / 全自动三档，危险操作必须确认；不做不经确认的静默拦截。
4. **一切可审计** —— 消息、文档访问、工具调用、管理操作全链留痕，追加写 + 哈希链。
5. **多租户硬隔离** —— `tenant_id` 贯穿所有表与 API，行级安全 + 存储分前缀。
6. **知识库权限前置** —— 检索 SQL 直接注入用户可见集，绝不后过滤。
7. **资源克制** —— 客户端安装包 < 30 MB、空闲内存 < 300 MB、冷启动 < 2 s。

## 技术栈

```
客户端   Tauri 2 + React 18 + TypeScript + Ant Design 5 + Zustand
Agent    Rust sidecar（自研循环，stdio JSONL，OpenAI 兼容流式）
服务端   Go 模块化单体（gateway / auth / org / message / file / kb /
         app-registry / ai-gateway / admin / audit / notify）
数据     PostgreSQL 16（pgvector + zhparser + 分区）· Redis 7
         · 对象存储（S3 兼容 / RustFS）
AI       ai-gateway：GLM / Qwen / DeepSeek / vLLM / Ollama
交付     docker compose / Helm chart / 内网离线包；客户端自动更新（签名 + 灰度）
```

## 快速开始（单机 Compose）

前置：Linux、Docker 24+ 与 Compose v2.20+、4C8G 起步。

```bash
tar xzf baobaochat-deploy-v<ver>.tar.gz
cd baobaochat-deploy-v<ver>
sha256sum -c SHA256SUMS | tail -3

docker load -i images/bbc-app-<ver>.tar.gz
docker load -i images/base-images.tar.gz

cp compose/.env.internal compose/.env
# 三处必改：
#   BBC_PUBLIC_DOMAIN      = <服务器 IP 或域名>（不带协议）
#   BBC_S3_PUBLIC_ENDPOINT = http://<服务器地址>/oss
#   POSTGRES_PASSWORD 与 BBC_DB_DSN 保持一致

cd compose
docker compose --profile core up -d
docker compose ps
```

然后：

1. 浏览器打开 `http://<服务器地址>/`，自动跳转 `/setup` 创建首个超级管理员（空库不预置演示账号）；
2. 管理后台 → **AI 供应商** 填 Base URL、API Key 与模型清单，Agent 即可用；
3. 客户端在管理后台「客户端发布」上传分发——**客户端地址在编译期写死，必须与服务端地址一致**。

详细步骤见 [deploy/compose/README.md](deploy/compose/README.md) 与
[内网部署操作手册](docs/内网部署操作手册-v0.1.5.md)。

## 部署形态

| 形态 | 适用 | 说明 |
|---|---|---|
| Docker Compose | 单机 / 内网小规模（≤2k 用户） | 一条命令拉起全栈：应用、PG、Redis、对象存储、接入层与迁移 |
| Kubernetes（Helm） | 已有 K8s 集群、多副本、自愈 | 迁移 Job、PVC、对象存储初始化、web 接入层 NodePort |
| 内网离线包 | 不能出网的环境 | 全量镜像与安装脚本，部署机一条命令安装 |

两种形态能力等价，数据可平移。

## 边界：不做什么

- ❌ 音视频通话、会议、在线文档协作（相关域已从代码移除）
- ❌ 移动端原生 App
- ❌ 外链文件分享
- ❌ 主动委派 Claude Code / zcode 等外部编码代理——本产品只做「被调用」（外部智能体通过壳内 A2A / MCP 调用本产品能力）

## 设计文档

本仓库同时是项目的设计文档库。

### 基础篇

| # | 文档 | 内容 |
|---|---|---|
| 00 | [产品总体设计说明书](docs/00-产品总体设计说明书.md) | 定位、角色、功能全景、P0 原则、术语、里程碑 |
| 01 | [技术选型说明](docs/01-技术选型说明.md) | Tauri / React / Rust Agent Runtime / Go / PG 选型与理由 |
| 02 | [系统总体架构](docs/02-系统总体架构.md) | 客户端进程模型、服务清单、关键链路、失败域与降级 |
| 03 | [身份认证与权限体系](docs/03-身份认证与权限体系.md) | 登录 / SSO / 令牌、多租户、RBAC、Agent OBO 机制 |
| 14 | [通信协议设计](docs/14-通信协议设计.md) | WSS 信封、事件目录、seq 游标同步、REST 规范、错误码 |

### 功能篇

| # | 文档 | 内容 |
|---|---|---|
| 04 | [IM 即时通讯设计](docs/04-IM即时通讯设计.md) | 私聊 / 群聊、消息生命周期、多端同步、搜索、通知 |
| 07 | [文件与图片传输设计](docs/07-文件与图片传输设计.md) | 分片 / 断点 / 秒传、缩略图、传输管理器 |
| 08 | [AI Agent 总体设计](docs/08-AI-Agent总体设计.md) | 自研 Agent 循环、上下文工程、工作区、子任务 |
| 09 | [AI Agent 工具与安全设计](docs/09-AI-Agent工具与安全设计.md) | 工具目录、三档权限、沙箱、审计、提示注入防御 |
| 10 | [生态应用接入与技能分发设计](docs/10-生态应用接入与技能分发设计.md) | 应用清单 / 注册 / 签名 / 灰度、客户端同步 |
| 11 | [知识库系统设计](docs/11-知识库系统设计.md) | 公司与个人知识、摄入管线、权限过滤检索 |
| 12 | [管理后台设计](docs/12-管理后台设计.md) | 租户 / 组织 / 角色 / 策略 / 审计 |
| 19 | [AI 网关设计](docs/19-AI网关设计.md) | 模型流量唯一出入口：路由 / 熔断 / 计量 / 脱敏 |
| 22 | [邮件设计](docs/22-邮件设计.md) | 私有化邮件栈与统一身份（规划中） |

### 横切篇

| # | 文档 | 内容 |
|---|---|---|
| 13 | [数据模型与存储设计](docs/13-数据模型与存储设计.md) | 表结构汇总、分区、对象存储布局、缓存规范 |
| 15 | [安全设计](docs/15-安全设计.md) | 威胁模型、传输 / 存储 / 密钥、客户端加固、Agent 专项 |
| 16 | [部署运维与非功能设计](docs/16-部署运维与非功能设计.md) | 打包更新、部署两档、容量规划、SLO、备份恢复 |
| 18 | [设计评审与开放问题清单](docs/18-设计评审与开放问题清单.md) | 开放问题裁决与协议冻结判据 |

### 详细设计（docs/detail/）

页面（区块级）、交互（事件级）、接口（字段级）、模型（DDL 级）、六态与响应式、模块划分（文件级）。
入口：[docs/detail/README.md](docs/detail/README.md)。

- 公共规范：D01 客户端设计系统 · D02 服务端模块划分
- 模块篇：D03 IM · D06 文件图片 · D07 知识库 · D08 Agent 工作台 · D09 生态技能 · D10 管理后台 · D12 身份与组织域
- 专题篇：D11 Runtime 内部 · D13 变更控制模式与无 Docker 沙箱 · D14 专家 Agent · D21 自动更新与发布链 · D22 插件系统

## 品牌与白标

产品名、标语、logo、邮箱域全部收敛在 [`brand/`](brand/README.md)：改一个目录、跑一条生成命令，
即可换成自己公司的品牌（MIT 协议允许，含商用与内网分发）。

## 贡献与反馈

- 问题与建议：GitHub Issues
- 安全漏洞：请勿公开提交，通过仓库私密渠道联系维护者

## License

[MIT](LICENSE) —— 自由使用、修改、分发（含商用与内网白标换名换标）；
唯一要求：分发时保留本 LICENSE 文件。