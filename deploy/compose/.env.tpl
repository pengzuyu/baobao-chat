# =============================================================================
# BaobaoChat docker-compose 环境配置模板（16 篇 §3.4 双形态等价配置键）
# -----------------------------------------------------------------------------
# 用法：cp .env.tpl .env && vim .env    （.env 已被 .gitignore 排除，不入 git）
#
# 等价性约定：本文件每个【统一配置键】与 Helm values 一一对应（行内 “helm:” 注释），
#   同一组镜像、同一套配置键、两份编排——Docker 与 K8s 均为一等公民。
#   - docker-compose 来源：本 .env（敏感值经 volumes/ 挂载或环境注入）
#   - K8s 来源：ConfigMap bbc-config / Secret bbc-db、bbc-s3（见 helm/bbc/values.yaml）
#   - 敏感配置不入 git、不入镜像、不入日志（16 篇 §5.3）
# =============================================================================

# -----------------------------------------------------------------------------
# 0. 镜像与副本（helm: global.imageRegistry / global.imageTag / app.replicaCount）
# -----------------------------------------------------------------------------
# 应用镜像统一走内部 Registry；BBC_IMAGE_TAG 与 Helm 侧 global.imageTag 必须同 tag
# 锁定（16 篇 §3.4“版本由同一 tag 锁定”）。生产建议在 docker-compose.yml 中追加
# @sha256 digest 双重钉死。
BBC_IMAGE_REGISTRY=registry.example.com/baobaochat
BBC_IMAGE_TAG=0.1.0
# make server-image 构建用基础镜像源（内网覆盖；空=官方默认 golang:1.22-alpine /
# alpine:3.20。例：BBC_GO_BUILDER=docker.m.daocloud.io/library/golang:1.22-alpine，
# 或先 docker pull 代理源再 docker tag 别名成默认名——两者等效）
# BBC_GO_BUILDER=golang:1.22-alpine
# BBC_RUNTIME_IMAGE=alpine:3.20
# app 副本数（compose 侧实际用 `docker compose up -d --scale app=N`；此键供脚本与
# Helm values app.replicaCount 对齐，默认 2=滚动升级+单实例冗余，16 篇 §3.1）
BBC_APP_REPLICAS=2
# 启用的 profiles 组合（compose 原生变量；helm 侧对应 modules.*）：
#   core(必选，全栈：app/nginx-lb/依赖) media ops mail——按站点形态叠加；
#   deps=开发依赖子组（dev-up.sh 用，不起 app 容器）；测试全栈保持 core 即可
COMPOSE_PROFILES=core
# 迁移目录（已退役保留：2026-11-16 迁移收口为 bbc-server 内嵌单基线 0001_init.sql，
# app-init 不再执行 SQL；此挂载仅作人工排查用）
BBC_MIGRATIONS_DIR=../../server/migrations

# -----------------------------------------------------------------------------
# 1. 域名与公共运行时（helm: global.domain / config.logLevel / config.*）
# -----------------------------------------------------------------------------
BBC_PUBLIC_DOMAIN=bbc.example.internal        # helm: global.domain（对外 https/wss 域名）
BBC_LOG_LEVEL=info                            # helm: config.logLevel（生产默认 INFO，16 篇 §6.2）
BBC_UPDATE_CHANNEL=stable                     # helm: config.updateChannel（stable|beta，16 篇 §4.2）
BBC_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318   # helm: config.otelEndpoint

# -----------------------------------------------------------------------------
# 2. 模块启停（helm: modules.*；compose 侧 media/mail 由 profiles 控制）
# -----------------------------------------------------------------------------
# bbc-server 为模块化单体，--enable 控制启用域（D02 §2；auth/org/message 不可关闭）
BBC_APP_MODULES=auth,org,message,file,kb,eco,admin,audit,notify,aigw

# -----------------------------------------------------------------------------
# 3. PostgreSQL（helm: secrets.dbDsn → Secret bbc-db；只读副本 DSN 走 secrets.dbReadDsn）
# -----------------------------------------------------------------------------
# —— compose 侧基础设施自管键（K8s 侧由 CNPG Operator/StatefulSet 管理，不入 values）——
POSTGRES_USER=bbc
POSTGRES_PASSWORD=bbc_change_me              # ★上线必改；与下方 DSN 保持一致
POSTGRES_DB=bbc
# pgvector / zhparser 扩展：官方 postgres 镜像未内置，生产需自建镜像预装（13 篇），
# init/01-init.sh 中 CREATE EXTENSION 失败会跳过并提示。
# —— 统一配置键（与 Helm 完全一致；K8s 来源为 Secret bbc-db）——
BBC_DB_DSN=postgres://bbc:bbc_change_me@pg:5432/bbc?sslmode=disable
BBC_DB_RO_DSN=                               # 空=读回落主库；主从档位填写副本 DSN（16 篇 §3.3）
# —— 认证与运行时（helm: secrets.jwtSecret → Secret bbc-auth；K8s 侧对应键）——
BBC_JWT_SECRET=bbc_jwt_change_me_0123456789abcdef0123456789abcdef   # ★上线必改：≥32 字节随机串（03 篇 §2.2；空则回退开发默认密钥并打警告）
# KMS 主密钥（aigw 供应商密钥信封加密；helm: secrets.kmsMasterKey → Secret bbc-secrets）：
# base64(32B)，openssl rand -base64 32 生成；空=带密钥的供应商无法创建/装配（仅警告不阻断）。
# ★密钥丢失/更换则存量 kms:v1 密文作废需重存
BBC_KMS_MASTER_KEY=
BBC_SEED_DEMO=0                              # 演示种子数据（alice/bob 口令 demo-pass-123）：联调置 1 免 admin bootstrap；部署保持 0
# —— OIDC Provider（D28 批次 Q1：生态应用统一登录；密钥生成 openssl ecparam -name prime256v1 -genkey -noout）——
BBC_OIDC_SIGNING_KEY=                        # 生态应用用 BaobaoChat 账号登录（IdP）时必需；空=临时密钥仅联调（重启已签 token 失效）。
                                             # 支持原始 PEM 或 base64 包裹单行（.env 用后者）：bash scripts/release/gen-oidc-key.sh 生成
BBC_OIDC_ISSUER=                             # 对外 issuer（生产形如 https://你的域名/oauth2；空=按监听地址推导本地默认）
# —— 品牌白标（D31：与构建侧 brand/brand.json 对齐；改 scheme 必须与客户端同步重出包）——
BBC_BRAND_NAME=                              # 产品显示名（OIDC 等待页/nginx 官网占位等文案源；空=BaobaoChat）
BBC_DEEP_LINK_SCHEME=                        # 桌面端深链 scheme（空=bbc；须与客户端 brand.json identity 一致，否则深链确认登录静默失效）
BBC_MAIL_DOMAIN=                             # 生成邮箱后缀（/setup 首超管+批量导入 工号@该域；空=bbc.io；2026-11-18 由 BBC_BOOTSTRAP_MAIL_DOMAIN 改名通用化）
# BBC_DATA_DIR=/data                         # 文件域本地盘（容器内固定 /data 挂 bbc-data 卷，一般无需覆盖；对象存储阶段二替换）

# -----------------------------------------------------------------------------
# 4. Redis（helm: externalServices.redis.address → ConfigMap；仅缓存/队列，AOF 优先关闭）
# -----------------------------------------------------------------------------
BBC_REDIS_ADDR=redis:6379

# -----------------------------------------------------------------------------
# 5. 对象存储 RustFS/S3（D29：MinIO→RustFS；helm: externalServices.s3.* → ConfigMap；凭据 → Secret bbc-s3）
#    rustfs 服务与 rustfs-init 均直接复用 BBC_S3_ACCESS_KEY/SECRET_KEY，无需单独根凭据键
# -----------------------------------------------------------------------------
BBC_S3_ENDPOINT=http://rustfs:9000
# 预签名对外基址（D25）：空=回落本地盘（不启用对象存储）；启用后客户端直传/直下走它。
# compose 域名形态 http(s)://<对外host>/oss（nginx 已带 /oss/ 代理）；内网直连形态 http://<host>:9000
BBC_S3_PUBLIC_ENDPOINT=
BBC_S3_USE_PATH_STYLE=true                   # RustFS/S3 兼容实现须 path-style；云 S3 置 false
BBC_S3_BUCKET=bbc-data                       # helm: externalServices.s3.bucket（版本化）
BBC_S3_BACKUP_BUCKET=bbc-backup              # helm: externalServices.s3.backupBucket（独立凭据，§4.6）
BBC_S3_ACCESS_KEY=bbc_rustfs_change_me       # helm: secrets.s3AccessKey  ★上线必改
BBC_S3_SECRET_KEY=bbc_rustfs_secret_change_me # helm: secrets.s3SecretKey  ★上线必改

# -----------------------------------------------------------------------------
# 6. TLS 与企业 CA（helm: ingress.tls.secretName + tls.caBundle；15 篇 §3.1）
# -----------------------------------------------------------------------------
# 证书放置：deploy/compose/volumes/certs/tls.crt|tls.key（fullchain），企业 CA 根证书
# ca.crt 同目录。客户端 pinning 的是根 CA，叶证书可无感轮换（16 篇 §4.7）。
# 生产由内部 CA 签发；开发自签一键生成见 scripts/dev-up.sh。
BBC_TLS_CERT_FILE=/etc/nginx/certs/tls.crt
BBC_TLS_KEY_FILE=/etc/nginx/certs/tls.key
BBC_TLS_CA_FILE=/etc/nginx/certs/ca.crt

# -----------------------------------------------------------------------------
# 7. 特性开关：BBC_FEATURE_* 随 2026-11 瘦身移除（服务端零读取的装饰配置）
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# 8. AI 网关上游（helm: aiGateway.* / secrets.aiUpstreamApiKey；19 篇）
# -----------------------------------------------------------------------------
BBC_AI_UPSTREAM_BASE_URL=     # 如 http://vllm.internal:8000/v1；空=aigw 仅代理已注册路由
BBC_AI_UPSTREAM_API_KEY=      # helm: secrets.aiUpstreamApiKey（经 KMS/信封解密后注入，§5.3）

# -----------------------------------------------------------------------------
# 11. 首次初始化（helm: jobs.adminBootstrap.*；16 篇 §2.2 初始化工具）
# -----------------------------------------------------------------------------
# 内置平台管理员引导密码：留空则 init/01-init.sh 只打印引导命令，由运维在管理台完成
BBC_ADMIN_BOOTSTRAP_PASSWORD=

# -----------------------------------------------------------------------------
# 12. 可观测栈（ops profile；K8s 侧为独立监控 release/namespace，16 篇 §3.2）
# -----------------------------------------------------------------------------
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=grafana_change_me     # ★上线必改（helm 侧: 独立 grafana release 管理）

# -----------------------------------------------------------------------------
# 13. 邮件栈（mail profile；22 篇：stalwart 一体或 docker-mailserver 组件组二选一）
# -----------------------------------------------------------------------------
MAIL_DOMAIN=mail.example.internal            # helm: mail.domain
MAIL_ADMIN_PASSWORD=mail_change_me           # helm: secrets.mailAdminPassword ★上线必改
# 首次启用前必须完成 DNS 五项检测：MX / SPF / DKIM / DMARC / autodiscover（22 篇 §8）

# PostgreSQL 镜像（官方 tag 国内拉取慢时可指内网 Harbor；pgvector 版为 kb_chunk 预备）
# POSTGRES_IMAGE=172.16.105.109:30003/pengzuyu/postgres-pgvector:16
