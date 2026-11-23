#!/usr/bin/env bash
# =============================================================================
# gen-deploy-package.sh —— 内网离线部署包组装（2026-11-23；CI 与本地通用）
#
# 背景：内网服务器无外网、无源码、无编译环境，只需 Docker + 一个包。本脚本把
# 「compose 编排 + 预填 .env + 官网静态 + bbc-app 镜像 + 安装说明」组装成单包。
#
# 镜像获取策略（2026-11-23 定案，依据内网 Nexus 172.16.19.3）：
#   - bbc-app（内部自建）：随包 docker load，本地 tag baobaochat/bbc-app:<ver>
#     ——无需推私服、无需登录凭据；多机部署时可用 BBC_REGISTRY_PREFIX 改走 8182
#   - 第三方 5 个（pgvector/nginx/redis/rustfs/aws-cli）：compose 默认名，
#     内网服务器经 /etc/docker/daemon.json 的 registry-mirrors（8181 代理
#     Docker Hub）自动回源拉取 ——首次可能慢，之后走私服缓存
#   - BBC_BUNDLE_IMAGES=1：包内带全部 6 镜像（mirror 不可用时的完全离线兜底）
#
# 用法（CI 里由 .github/workflows/deploy-package.yml 调用；本地演练同款）：
#   BBC_DEPLOY_VERSION=0.1.4 bash scripts/release/gen-deploy-package.sh
#   BBC_DEPLOY_VERSION=0.1.4 BBC_BUNDLE_IMAGES=1 bash scripts/release/gen-deploy-package.sh
#
# 环境变量：
#   BBC_DEPLOY_VERSION     必填，版本标签（与镜像 tag 一致）
#   BBC_REGISTRY_PREFIX    可选，多机部署时 bbc-app 的私服前缀
#                          （如 172.16.19.3:8182/baobaochat）；空=本地 load 模式
#   BBC_BUNDLE_IMAGES      可选，1=包内带全部 6 镜像（完全离线兜底）；0=默认
#   BBC_DEPLOY_OUT         可选，产物目录（默认 dist）
#
# 前置（CI/本地约定）：
#   dist/images/bbc-app-<ver>.tar.gz      服务端镜像（docker save | gzip）
#   dist/images/base-images.tar.gz        其余 5 镜像（BBC_BUNDLE_IMAGES=1 时必需）
#   website/dist/                          官网构建产物（npm --prefix website run build）
#
# 产物：<OUT>/baobaochat-deploy-v<ver>.tar.gz（含 SHA256SUMS 与 INSTALL.md）
# =============================================================================
set -euo pipefail

VER="${BBC_DEPLOY_VERSION:?BBC_DEPLOY_VERSION 必填（如 0.1.4）}"
PREFIX="${BBC_REGISTRY_PREFIX:-}"
BUNDLE="${BBC_BUNDLE_IMAGES:-0}"
OUT="${BBC_DEPLOY_OUT:-dist}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$OUT/baobaochat-deploy-v$VER"

[ -f "$OUT/images/bbc-app-$VER.tar.gz" ] || {
  echo "[gen-deploy-package] 缺镜像包 $OUT/images/bbc-app-$VER.tar.gz（先 docker save | gzip）" >&2
  exit 1
}
if [ "$BUNDLE" = "1" ] && [ ! -f "$OUT/images/base-images.tar.gz" ]; then
  echo "[gen-deploy-package] BBC_BUNDLE_IMAGES=1 但缺 $OUT/images/base-images.tar.gz" >&2
  exit 1
fi
[ -d "$ROOT/website/dist" ] || {
  echo "[gen-deploy-package] 缺 website/dist（先 npm --prefix website run build）" >&2
  exit 1
}

rm -rf "$PKG"
mkdir -p "$PKG/compose/volumes/website" "$PKG/images"

# ---- compose 编排（volumes 是运行时数据目录，.gitignore 排除；显式排防误带）----
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='volumes' "$ROOT/deploy/compose/" "$PKG/compose/"
else
  (cd "$ROOT/deploy/compose" && tar cf - --exclude='./volumes' .) | (cd "$PKG/compose" && tar xf -)
fi
rm -f "$PKG/compose/.env"   # 不带本机 .env（模板走 .env.internal）
cp -R "$ROOT/website/dist/." "$PKG/compose/volumes/website/"
cp "$OUT/images/bbc-app-$VER.tar.gz" "$PKG/images/"
[ "$BUNDLE" = "1" ] && cp "$OUT/images/base-images.tar.gz" "$PKG/images/"

# ---- .env.internal：预填镜像源与随机凭据 ----
PW=$(openssl rand -hex 16)
JWT=$(openssl rand -hex 32)
S3AK=$(openssl rand -hex 8)
S3SK=$(openssl rand -hex 16)

# bbc-app 定位：本地 load 模式（默认）或私服前缀模式（多机部署）
if [ -n "$PREFIX" ]; then
  BBC_APP_BLOCK="BBC_IMAGE_REGISTRY=$PREFIX
BBC_IMAGE_TAG=$VER
# bbc-app 已推入私服；内网服务器需 docker login 该私服"
  LOAD_BBC="# bbc-app 从私服拉取（无需 docker load；需先 docker login 私服）"
else
  BBC_APP_BLOCK="BBC_IMAGE_REGISTRY=baobaochat
BBC_IMAGE_TAG=$VER"
  LOAD_BBC="docker load -i images/bbc-app-$VER.tar.gz"
fi

cat > "$PKG/compose/.env.internal" <<EOF
# baobaochat-deploy v$VER 预填配置（gen-deploy-package.sh 生成）
# 部署前只需确认：①BBC_PUBLIC_DOMAIN ②是否沿用本文件随机凭据
# ---------------------------------------------------------------------------
# 自建镜像 bbc-app
$BBC_APP_BLOCK

# 第三方镜像：compose 默认名，经 daemon.json registry-mirrors（8181）回源拉取。
# 仅 PG 需覆盖为 pgvector 版（默认 postgres 官方镜像不含向量扩展）。
POSTGRES_IMAGE=pgvector/pgvector:pg16

# 对外地址（★部署前必改：内网服务器 IP 或域名，不带协议）
BBC_PUBLIC_DOMAIN=CHANGE_ME
COMPOSE_PROFILES=core

# 数据库（随机生成；自定义时 POSTGRES_PASSWORD 与 BBC_DB_DSN 必须同步改）
POSTGRES_USER=bbc
POSTGRES_PASSWORD=$PW
POSTGRES_DB=bbc
BBC_DB_DSN=postgres://bbc:$PW@pg:5432/bbc?sslmode=disable

# 安全凭据（随机生成）
BBC_JWT_SECRET=$JWT
BBC_S3_ACCESS_KEY=$S3AK
BBC_S3_SECRET_KEY=$S3SK

# 对象存储（栈内 RustFS；PUBLIC_ENDPOINT 空=客户端经 nginx /oss/ 代理）
BBC_S3_ENDPOINT=http://rustfs:9000
BBC_S3_PUBLIC_ENDPOINT=
BBC_S3_USE_PATH_STYLE=true
BBC_S3_BUCKET=bbc-data
BBC_S3_BACKUP_BUCKET=bbc-backup

# 缓存
BBC_REDIS_ADDR=redis:6379

# 部署默认
BBC_APP_REPLICAS=1
BBC_LOG_LEVEL=info
BBC_SEED_DEMO=0
EOF

# ---- INSTALL.md ----
if [ "$BUNDLE" = "1" ]; then
  LOAD_BASE='docker load -i images/base-images.tar.gz'
  MIRROR_SECTION='本包已含全部 6 个镜像（docker load 即得），无需私服 mirror。'
else
  LOAD_BASE='# 其余镜像首次由 compose 自动经私服 mirror 拉取（见上方 daemon.json）'
  MIRROR_SECTION='## 前置：Docker 私服配置（必需，否则第三方镜像拉不到）

内网 Nexus 私服（172.16.19.3）：8181=registry-mirror（代理 Docker Hub）·
8182=自建镜像仓库 · 8081=通用仓库（yum/apt/docker-ce 安装源）。

`/etc/docker/daemon.json`：

```json
{
  "insecure-registries": ["172.16.19.3:8181", "172.16.19.3:8182"],
  "registry-mirrors": ["http://172.16.19.3:8181"]
}
```

```bash
systemctl daemon-reload && systemctl restart docker
```

- registry-mirrors 使 `docker pull nginx:1.27.4-alpine3.21` 等自动经私服回源
- 私服未缓存的镜像首次回源可能较慢（多试几次即进缓存）
- 私服登录凭据向运维/公告板《私服使用手册》查询，勿写入本包'
fi

cat > "$PKG/INSTALL.md" <<EOF
# BaobaoChat 内网部署包 v$VER

## 前置
- Docker Engine ≥ 24 + Compose v2.20+（安装源：私服 8081 的 docker-ce 仓库）
- 建议 8C16G / 500G SSD（1k 用户档，16 篇 §3.3）

$MIRROR_SECTION

## 三步部署
\`\`\`bash
cd baobaochat-deploy-v$VER

# 1. 载入内部自建镜像
$LOAD_BBC
$LOAD_BASE

# 2. 配置（★必改 BBC_PUBLIC_DOMAIN）
cp compose/.env.internal compose/.env
vi compose/.env

# 3. 拉起核心链路（nginx-lb/app/pg/redis/rustfs/官网/更新源）
cd compose && docker compose --profile core up -d
\`\`\`

## 首次初始化
- app-init 自动等 pg 就绪并应用 schema 迁移（内嵌 bbc-app 镜像）
- 完成后浏览器开 http://<BBC_PUBLIC_DOMAIN>/ → /setup 创建首超管
- 建管理员时填 AI 供应商（如智谱）与模型——Agent 功能依赖

## 安全
- POSTGRES_PASSWORD / BBC_JWT_SECRET / S3 凭据为随机生成，建议沿用
- 改 POSTGRES_PASSWORD 必须同步改 BBC_DB_DSN
- TLS：v0.1 内网 http；需 https 时证书放 compose/volumes/certs/（tls.crt/tls.key/ca.crt）

## 升级
\`\`\`bash
docker load -i images/bbc-app-<新ver>.tar.gz
cd compose && ./upgrade.sh <新ver>   # 备份→迁移→滚动→健康检查；失败按提示 rollback
\`\`\`

## 多机部署（可选）
单机直接 docker load 即可。若多台服务器，可把 bbc-app 推入私服 8182 一次：
\`\`\`bash
docker tag baobaochat/bbc-app:$VER 172.16.19.3:8182/baobaochat/bbc-app:$VER
docker login 172.16.19.3:8182 && docker push 172.16.19.3:8182/baobaochat/bbc-app:$VER
# 之后出包用 BBC_REGISTRY_PREFIX=172.16.19.3:8182/baobaochat 生成 .env.internal 即可免 load
\`\`\`

## 客户端分发
- 安装包经 http://<BBC_PUBLIC_DOMAIN>/update/ 分发（latest.json + 各平台包）
- 官网 http://<BBC_PUBLIC_DOMAIN>/ 展示下载区（自动跟 release-info.json）
- 客户端须用同一 BBC_PUBLIC_URL=http://<BBC_PUBLIC_DOMAIN> 构建
EOF

# ---- 校验和 ----
( cd "$PKG" && find . -type f ! -name SHA256SUMS -print0 | xargs -0 sha256sum > SHA256SUMS )

# ---- 最终 tar ----
( cd "$OUT" && tar czf "baobaochat-deploy-v$VER.tar.gz" "baobaochat-deploy-v$VER" )
echo "[gen-deploy-package] 完成：$OUT/baobaochat-deploy-v$VER.tar.gz"
echo "[gen-deploy-package] 内容："
( cd "$PKG" && find . -type f | sort | head -30 )