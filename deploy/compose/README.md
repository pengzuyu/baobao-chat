# BaobaoChat docker-compose 部署（小规模单 VM 形态）

对应设计：`docs/16-部署运维与非功能设计.md` §3.1 拓扑 / §3.3 容量 / §3.4 双形态等价。
Docker 与 K8s 均为一等公民：同一组镜像、同一套配置键、两份编排（K8s 见 `../helm/bbw/`）。

## 1. 硬件门槛（16 篇 §3.3 容量规划表摘录）

| 档位 | 规模 | 节点规格 | 说明 |
|---|---|---|---|
| 1k 用户档 | ~300 在线 / 600 DAU / ~300 msg/s | **1×VM 8C16G / 500G SSD** | 本目录默认形态 |
| 5k 用户档 | ~1.5k 在线 / 3k DAU / ~1,300 msg/s | 3–4×VM 8C16G 或转小 K8s（3 worker 16C32G） | compose 双 VM 或迁移 Helm |
| 20k 用户档 | 6k 在线 / 12k DAU / 5,000 msg/s | K8s 8–12 worker（`../helm/bbw/values-large.yaml`） | 不建议 compose |

- 磁盘：SSD；MinIO 单节点 2TB 档起步，WAL 归档与备份目录独立监控（水位 >80% 告警）。
- 系统：64 位 Linux，内核 ≥5.x（mediasoup 依赖）；Docker Engine ≥24 + Compose v2.20+。

## 2. 快速开始

```bash
cd deploy/compose
cp .env.tpl .env && vim .env        # 修改域名/密码/镜像仓库；启用组别改 COMPOSE_PROFILES
mkdir -p volumes/certs              # 放置 tls.crt / tls.key / ca.crt（内部 CA 签发）
docker compose up -d                # COMPOSE_PROFILES=core（默认）即可拉起核心链路
docker compose --profile core --profile media up -d          # 或显式多组
```

- 首次启动 `app-init` 自动执行 `init/01-init.sh`：等待 pg → 应用 `server/migrations` → 打印管理员引导命令。
- 升级 / 回滚 / 备份：`./upgrade.sh <TAG>` · `./rollback.sh [TAG]` · `./backup.sh` · `./restore.sh`。

### 2.1 部署形态与文件存储（2026-11-12 拍板：单节点优先，多节点按需选择）

- **应用层**：默认单节点（`--scale app=1`）。多实例（`--scale app=N`）当前**不可直接开**——
  WS 推送/presence/上传会话为进程内状态，跨副本消息不达；需先补跨实例事件总线（登记项，
  见 D25 §10 与 EXECUTION-PLAN 多实例注记）。开启后 ip_hash 仅保证同客户端同副本。
- **文件存储（D25）**：与单/多节点正交。`BBW_S3_PUBLIC_ENDPOINT` 空=本地盘回落（开发机形态）；
  **正式部署（含单节点）建议一律启用 MinIO**——栈内自带、bbw-data 版本化桶、未来加副本文件零迁移；
  多实例为硬性必配。本地盘历史文件经 `./migrate-files-to-minio.sh` 一次性搬入（幂等可续跑）。

## 3. 端口清单（默认发布）

| 端口 | 协议 | 服务 | 方向 | 备注 |
|---|---|---|---|---|
| 443 | tcp | nginx-lb | 客户端 → 服务器 | https/wss 主入口（REST `/api/`、WS `/ws/`、更新源 `/update/`） |
| 80 | tcp | nginx-lb | 客户端 → 服务器 | 仅 301 跳转 + `/healthz` |
| 40000–50100 | **udp** | media | 客户端 ↔ 服务器 | SRTP 媒体段，**独占**（media 组） |
| 3478 | udp+tcp | coturn | 客户端 → 服务器 | TURN/STUN 兜底（media 组，跨园区才启用） |
| 5349 | tcp | coturn | 客户端 → 服务器 | TURN/TLS |
| 25 / 465 / 993 / 143 | tcp | mail | 外部邮件服务器 ↔ | mail 组（22 篇；明文 143 默认关闭） |
| 5432 / 6379 / 9001 / 9090 / 3000 / 9093 | tcp | pg/redis/minio/prometheus/grafana/alertmanager | **仅 127.0.0.1** | 运维调试，经 SSH 隧道访问 |

## 4. 防火墙矩阵（企业内网最小放行集）

| 源 | → 目标:端口 | 协议 | 用途 |
|---|---|---|---|
| 客户端网段 | VM:443 | tcp | 主入口 |
| 跨园区网段 | VM:3478, 5349 | udp/tcp | TURN 兜底（按需） |
| 外部邮件服务器 | VM:25 | tcp | 入站邮件（mail 组） |
| VM → 内部 Registry | 443 | tcp | 拉取 bbw-* 镜像 |
| VM → 内部 AI 推理 | 8000+ | tcp | ai-gateway 上游（19 篇） |
| 运维跳板机 | VM:22 | tcp | SSH（含调试端口隧道） |
| — | VM:5432/6379/9000/9001/3000/9090/9093 | — | **禁止**非本机访问（已绑定 127.0.0.1） |

> 出口最小化：除 Registry、AI 上游、（可选）Apple 公证代理白名单（§4.1 构建侧）外无公网回源；更新源内网化（§4.2）。

## 5. 形态选择判据（16 篇 §3.4）

| 场景 | 形态 |
|---|---|
| ≤2k 用户 / 单 VM / 无自愈要求 | **compose（本目录）** |
| 多租户托管 / HPA 自愈 / 灰度发布 / >5k 用户 | **K8s（`../helm/bbw/`）** |

两者功能完全等价（含 Agent/知识库/文档/通话全部能力），差异只在伸缩、自愈与多租户密度；
禁止出现“仅 K8s 支持”的功能项（托管增强除外）。两者可相互平移（数据卷与对象存储兼容导出）。

## 6. 目录说明

| 文件 | 用途 |
|---|---|
| `docker-compose.yml` | 全量拓扑（profiles：core/media/ops/mail） |
| `.env.tpl` | 全部配置键+中文注释（与 Helm values 一一对应，行内 “helm:” 标注） |
| `init/01-init.sh` | 首次初始化（幂等）：等 pg → 应用 /migrations → 管理员引导提示 |
| `upgrade.sh` / `rollback.sh` | §4.4 顺序升级 / 一键切回 N-1 |
| `backup.sh` / `restore.sh` | §4.6 单机备份恢复（pgBackRest/WAL-G 占位实现） |
| `updates/latest.json.example` | Tauri updater 标准 manifest 样例（CI 签名后投放 `updates-data` 卷） |
| `volumes/` | 证书（`certs/`）、备份产物（`backup/`）等宿主数据（gitignore） |

### 6.1 更新源双轨 manifest（16 篇 §5.1）

| 文件 | 职责 | 生成方 |
|---|---|---|
| `/update/latest.json` | **Tauri updater 事实安装源**：壳 `plugins.updater` 直连，ed25519 验签后安装（样例见 `updates/latest.json.example`） | CI 发布流水线（`tauri signer sign` 各平台包后生成） |
| `/update/update-manifest.json` | **自研渠道/灰度决策清单**（channel/rollout 百分比/force 最低版本）：阶段二壳侧消费决策是否触发更新 | 发布流水线（当前 compose 内联占位） |

启用 updater 前置：`npm --prefix client run tauri signer generate` 生成 ed25519 密钥对——私钥入 CI（`TAURI_SIGNING_PRIVATE_KEY[/PASSWORD]`），公钥填 `client/src-tauri/tauri.conf.json` `plugins.updater.pubkey`（为空时壳自动禁用更新并打启动提示，不阻塞发布）。

## 7. 已知遗留（TODO）

- [ ] BBW 自有镜像（bbw-app/bbw-update-src）随 `server/` 落地构建；distroless 镜像内需内置 `/healthprobe`（compose 健康检查依赖）。
- [ ] 第三方镜像建议在 CI 追加 `@sha256` digest 双重钉死（当前为版本号钉死）。
- [ ] pgvector / zhparser 需自建 postgres 镜像预装（13 篇）；官方镜像占位。
- [ ] 备份生产化：pgBackRest/WAL-G → MinIO `bbw-backup` 桶（独立凭据、WORM 30 天）；当前为 pg_dump + pg_basebackup 占位。
- [ ] mail 组（stalwart）健康探测与 DNS 五项检测（MX/SPF/DKIM/DMARC/autodiscover，22 篇）待接入；或替换为 docker-mailserver 组件组。
- [ ] ops 组看板（16 篇 §6.4 八块）与告警规则（§6.5）制品化分发。
- [ ] media 万口 UDP 映射性能验证；Linux 生产建议改 `network_mode: host`。
