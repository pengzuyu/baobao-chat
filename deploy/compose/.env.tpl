# =============================================================================
# BaobaoWork docker-compose 环境配置模板（16 篇 §3.4 双形态等价配置键）
# -----------------------------------------------------------------------------
# 用法：cp .env.tpl .env && vim .env    （.env 已被 .gitignore 排除，不入 git）
#
# 等价性约定：本文件每个【统一配置键】与 Helm values 一一对应（行内 “helm:” 注释），
#   同一组镜像、同一套配置键、两份编排——Docker 与 K8s 均为一等公民。
#   - docker-compose 来源：本 .env（敏感值经 volumes/ 挂载或环境注入）
#   - K8s 来源：ConfigMap bbw-config / Secret bbw-db、bbw-s3（见 helm/bbw/values.yaml）
#   - 敏感配置不入 git、不入镜像、不入日志（16 篇 §5.3）
# =============================================================================

# -----------------------------------------------------------------------------
# 0. 镜像与副本（helm: global.imageRegistry / global.imageTag / app.replicaCount）
# -----------------------------------------------------------------------------
# 应用镜像统一走内部 Registry；BBW_IMAGE_TAG 与 Helm 侧 global.imageTag 必须同 tag
# 锁定（16 篇 §3.4“版本由同一 tag 锁定”）。生产建议在 docker-compose.yml 中追加
# @sha256 digest 双重钉死。
BBW_IMAGE_REGISTRY=registry.example.com/baobaowork
BBW_IMAGE_TAG=0.1.0
# make server-image 构建用基础镜像源（内网覆盖；空=官方默认 golang:1.22-alpine /
# alpine:3.20。例：BBW_GO_BUILDER=docker.m.daocloud.io/library/golang:1.22-alpine，
# 或先 docker pull 代理源再 docker tag 别名成默认名——两者等效）
# BBW_GO_BUILDER=golang:1.22-alpine
# BBW_RUNTIME_IMAGE=alpine:3.20
# app 副本数（compose 侧实际用 `docker compose up -d --scale app=N`；此键供脚本与
# Helm values app.replicaCount 对齐，默认 2=滚动升级+单实例冗余，16 篇 §3.1）
BBW_APP_REPLICAS=2
# 启用的 profiles 组合（compose 原生变量；helm 侧对应 modules.*）：
#   core(必选，全栈：app/nginx-lb/依赖) media ops mail——按站点形态叠加；
#   deps=开发依赖子组（dev-up.sh 用，不起 app 容器）；测试全栈保持 core 即可
COMPOSE_PROFILES=core
# 迁移目录（golang-migrate，按域分目录；D02 §7）。首次初始化时挂载进 app-init。
BBW_MIGRATIONS_DIR=../../server/migrations

# -----------------------------------------------------------------------------
# 1. 域名与公共运行时（helm: global.domain / config.logLevel / config.*）
# -----------------------------------------------------------------------------
BBW_PUBLIC_DOMAIN=bbw.example.internal        # helm: global.domain（对外 https/wss 域名）
BBW_LOG_LEVEL=info                            # helm: config.logLevel（生产默认 INFO，16 篇 §6.2）
BBW_UPDATE_CHANNEL=stable                     # helm: config.updateChannel（stable|beta，16 篇 §4.2）
BBW_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318   # helm: config.otelEndpoint

# -----------------------------------------------------------------------------
# 2. 模块启停（helm: modules.*；compose 侧 media/mail 由 profiles 控制）
# -----------------------------------------------------------------------------
# bbw-server 为模块化单体，--enable 控制启用域（D02 §2；auth/org/message 不可关闭）
BBW_APP_MODULES=auth,org,message,file,kb,eco,admin,audit,notify,aigw

# -----------------------------------------------------------------------------
# 3. PostgreSQL（helm: secrets.dbDsn → Secret bbw-db；只读副本 DSN 走 secrets.dbReadDsn）
# -----------------------------------------------------------------------------
# —— compose 侧基础设施自管键（K8s 侧由 CNPG Operator/StatefulSet 管理，不入 values）——
POSTGRES_USER=bbw
POSTGRES_PASSWORD=bbw_change_me              # ★上线必改；与下方 DSN 保持一致
POSTGRES_DB=bbw
# pgvector / zhparser 扩展：官方 postgres 镜像未内置，生产需自建镜像预装（13 篇），
# init/01-init.sh 中 CREATE EXTENSION 失败会跳过并提示。
# —— 统一配置键（与 Helm 完全一致；K8s 来源为 Secret bbw-db）——
BBW_DB_DSN=postgres://bbw:bbw_change_me@pg:5432/bbw?sslmode=disable
BBW_DB_RO_DSN=                               # 空=读回落主库；主从档位填写副本 DSN（16 篇 §3.3）
# —— 认证与运行时（helm: secrets.jwtSecret → Secret bbw-auth；K8s 侧对应键）——
BBW_JWT_SECRET=bbw_jwt_change_me_0123456789abcdef0123456789abcdef   # ★上线必改：≥32 字节随机串（03 篇 §2.2；空则回退开发默认密钥并打警告）
BBW_SEED_DEMO=0                              # 演示种子数据（alice/bob 口令 demo-pass-123）：联调置 1 免 admin bootstrap；部署保持 0
# BBW_DATA_DIR=/data                         # 文件域本地盘（容器内固定 /data 挂 bbw-data 卷，一般无需覆盖；对象存储阶段二替换）

# -----------------------------------------------------------------------------
# 4. Redis（helm: externalServices.redis.address → ConfigMap；仅缓存/队列，AOF 优先关闭）
# -----------------------------------------------------------------------------
BBW_REDIS_ADDR=redis:6379

# -----------------------------------------------------------------------------
# 5. 对象存储 MinIO/S3（helm: externalServices.s3.* → ConfigMap；凭据 → Secret bbw-s3）
# -----------------------------------------------------------------------------
BBW_S3_ENDPOINT=http://minio:9000
BBW_S3_USE_PATH_STYLE=true                   # MinIO 必须 path-style；云 S3 置 false
BBW_S3_BUCKET=bbw-data                       # helm: externalServices.s3.bucket（版本化）
BBW_S3_BACKUP_BUCKET=bbw-backup              # helm: externalServices.s3.backupBucket（独立凭据，§4.6）
BBW_S3_ACCESS_KEY=bbw_minio_change_me        # helm: secrets.s3AccessKey  ★上线必改
BBW_S3_SECRET_KEY=bbw_minio_secret_change_me # helm: secrets.s3SecretKey   ★上线必改
# —— compose 侧基础设施自管键（MinIO 根凭据，与上面两键保持一致）——
MINIO_ROOT_USER=bbw_minio_change_me
MINIO_ROOT_PASSWORD=bbw_minio_secret_change_me

# -----------------------------------------------------------------------------
# 6. TLS 与企业 CA（helm: ingress.tls.secretName + tls.caBundle；15 篇 §3.1）
# -----------------------------------------------------------------------------
# 证书放置：deploy/compose/volumes/certs/tls.crt|tls.key（fullchain），企业 CA 根证书
# ca.crt 同目录。客户端 pinning 的是根 CA，叶证书可无感轮换（16 篇 §4.7）。
# 生产由内部 CA 签发；开发自签一键生成见 scripts/dev-up.sh。
BBW_TLS_CERT_FILE=/etc/nginx/certs/tls.crt
BBW_TLS_KEY_FILE=/etc/nginx/certs/tls.key
BBW_TLS_CA_FILE=/etc/nginx/certs/ca.crt

# -----------------------------------------------------------------------------
# 7. 特性开关：BBW_FEATURE_* 随 2026-11 瘦身移除（服务端零读取的装饰配置）
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# 8. AI 网关上游（helm: aiGateway.* / secrets.aiUpstreamApiKey；19 篇）
# -----------------------------------------------------------------------------
BBW_AI_UPSTREAM_BASE_URL=     # 如 http://vllm.internal:8000/v1；空=aigw 仅代理已注册路由
BBW_AI_UPSTREAM_API_KEY=      # helm: secrets.aiUpstreamApiKey（经 KMS/信封解密后注入，§5.3）

# -----------------------------------------------------------------------------
# 11. 首次初始化（helm: jobs.adminBootstrap.*；16 篇 §2.2 初始化工具）
# -----------------------------------------------------------------------------
# 内置平台管理员引导密码：留空则 init/01-init.sh 只打印引导命令，由运维在管理台完成
BBW_ADMIN_BOOTSTRAP_PASSWORD=

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
