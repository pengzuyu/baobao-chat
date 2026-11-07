#!/usr/bin/env bash
# =============================================================================
# BaobaoWork 一键开发环境拉起脚本
#  · 初始化 deploy/compose/.env（首次从 .env.tpl 复制）
#  · 生成开发用自签 TLS 证书（volumes/certs/；生产换内部 CA 签发，15 篇 §3.1）
#  · 启动 compose core 依赖（pg16 / redis7 / minio / update-src / app-init）
#  · 打印前端 / 后端本地 dev 命令
# 幂等：可重复执行。用法：./scripts/dev-up.sh（或 make dev-up）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_DIR="${ROOT}/deploy/compose"

log() { echo "[dev-up] $*"; }

# ---------------------------------------------------------------------------
# 1. .env 初始化（仅首次；已存在则跳过，敏感值由开发者自行维护）
# ---------------------------------------------------------------------------
cd "$COMPOSE_DIR"
if [ ! -f .env ]; then
  cp .env.tpl .env
  log "已生成 deploy/compose/.env（模板默认值，开发可直接用；上线前必改密码）"
else
  log "检测到 .env，跳过初始化"
fi

# ---------------------------------------------------------------------------
# 2. 开发自签证书（生产：内部 CA 签发 fullchain，15 篇 §3.1；本脚本只服务开发）
# ---------------------------------------------------------------------------
CERT_DIR="./volumes/certs"
if [ ! -f "${CERT_DIR}/tls.crt" ]; then
  mkdir -p "$CERT_DIR"
  log "生成开发自签证书（SAN=localhost,127.0.0.1）..."
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "${CERT_DIR}/tls.key" -out "${CERT_DIR}/tls.crt" \
    -subj "/CN=bbw-dev" \
    -addext "subjectAltName=DNS:localhost,DNS:bbw.example.internal,IP:127.0.0.1" \
    >/dev/null 2>&1
  # 开发根 CA = 自签证书本身（客户端 pinning 语义与生产一致，15 篇 §3.1）
  cp "${CERT_DIR}/tls.crt" "${CERT_DIR}/ca.crt"
  log "证书就绪：${CERT_DIR}/tls.{crt,key} + ca.crt"
fi

# ---------------------------------------------------------------------------
# 3. 拉起开发依赖（deps 子组：pg / redis / minio / update-src / app-init；
#    不起 app 容器与 nginx-lb——开发流为宿主直跑 server。全栈容器化测试：
#    make server-image 先构建镜像，再 COMPOSE_PROFILES=core docker compose up -d）
# ---------------------------------------------------------------------------
log "启动 compose 开发依赖（deps：pg / redis / minio / update-src / app-init）..."
COMPOSE_PROFILES=deps docker compose up -d

log "等待核心依赖健康 ..."
for svc in pg redis minio; do
  waited=0
  until [ "$(docker compose ps -aq "$svc" | head -n1 | xargs -I{} docker inspect --format '{{.State.Health.Status}}' {})" = "healthy" ]; do
    sleep 3
    waited=$((waited + 3))
    if [ "$waited" -ge 90 ]; then
      log "⚠ $svc 健康等待超时（90s），继续执行——排查：docker compose logs $svc"
      break
    fi
  done
done
docker compose ps

# ---------------------------------------------------------------------------
# 4. 后续步骤提示（本机直连用 127.0.0.1；compose 内网用服务名）
# ---------------------------------------------------------------------------
cat <<'EOF'

[dev-up] ✔ 依赖就绪。后续开发命令：

  · 后端（server/，宿主机直跑，依赖走 127.0.0.1）：
      make server-run
    或：
      cd server && BBW_DB_DSN='postgres://bbw:bbw_change_me@127.0.0.1:5432/bbw?sslmode=disable' \
        BBW_REDIS_ADDR=127.0.0.1:6379 BBW_S3_ENDPOINT=http://127.0.0.1:9000 \
        BBW_S3_ACCESS_KEY=bbw_minio_change_me BBW_S3_SECRET_KEY=bbw_minio_secret_change_me \
        go run ./cmd/bbw-server --enable auth,org,message,file,doc,kb,eco,admin,audit,notify,aigw

  · 前端（client/）：        make client-dev     （首次先 make client-install）
  · Agent Runtime（agent/）： make agent-build
  · 数据库迁移（server/migrations 由 app-init 首次自动应用；日常新增迁移后）：
      docker compose --profile core run --rm --no-deps app migrate
      （正式通道：bbw-app migrate，16 篇 §3.4）

  · 常用：make dev-down 停依赖 | make dev-clean 清数据卷 | make compose-logs 看 app 日志
  · 运维面板（可选）：COMPOSE_PROFILES=core,ops 后 docker compose up -d
      → Prometheus http://127.0.0.1:9090 · Grafana http://127.0.0.1:3000（admin）

EOF
