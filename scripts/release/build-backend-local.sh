#!/usr/bin/env bash
# =============================================================================
# build-backend-local.sh —— 本机出后端部署包（compose 档 + K8s 档；无需 CI）
#
# 为什么可以在 mac 上出：后端产物只有 linux/amd64 镜像（docker buildx 跨平台构建）
# + 静态文件 + helm 包，mac 本机 Docker Desktop / helm / node 已覆盖全部能力；
# Windows 客户端才必须 Windows 环境（那部分走 GitHub Actions）。
#
# 用法：
#   bash scripts/release/build-backend-local.sh 0.1.4
#   BUNDLE=1 bash scripts/release/build-backend-local.sh 0.1.4   # 全量离线（带齐第三方镜像）
#   # 只出 compose 档 / 只出 K8s 档：
#   ONLY=compose bash scripts/release/build-backend-local.sh 0.1.4
#   ONLY=k8s     bash scripts/release/build-backend-local.sh 0.1.4
#
# 镜像两档（BUNDLE 环境变量）：
#   BUNDLE=0（默认）只带自建镜像；第三方（pgvector/nginx/redis/rustfs/aws-cli）
#                   由内网服务器经 daemon.json registry-mirrors 回源拉取
#   BUNDLE=1        全量离线：5 个第三方镜像一并打包（包体约 +500MB）；内网无需
#                   mirror/私服回源，docker load 即得（K8s 档仍需推一次私服 8182）
#
# 前置：Docker Desktop 运行中（buildx 可用）、helm、node/npm。
# 产物：dist/baobaochat-deploy-v<ver>.tar.gz（compose）
#       dist/baobaochat-k8s-v<ver>.tar.gz（K8s）
# =============================================================================
set -euo pipefail

VER="${1:?用法: bash scripts/release/build-backend-local.sh <版本号，如 0.1.4>}"
ONLY="${ONLY:-all}"
BUNDLE="${BUNDLE:-0}"

# 第三方基础镜像（compose core 档需要全部 5 个；K8s 档用前 1/4/5——nginx 由 web 镜像自带）
BASE_IMAGES=(
  "pgvector/pgvector:pg16"
  "redis:7.4.1-alpine3.20"
  "nginx:1.27.4-alpine3.21"
  "rustfs/rustfs:1.0.5"
  "amazon/aws-cli:2.31.4"
)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[build-backend-local] v${VER}（ONLY=${ONLY}）"
docker buildx version >/dev/null 2>&1 || { echo "[build-backend-local] Docker buildx 不可用（启动 Docker Desktop）" >&2; exit 1; }
command -v helm >/dev/null || { echo "[build-backend-local] 缺 helm：brew install helm" >&2; exit 1; }

mkdir -p dist/images

# ---- 0. 基础镜像（BUNDLE=1 全量离线）----
if [ "$BUNDLE" = "1" ] && { [ ! -f "dist/images/base-images.tar.gz" ] || [ "${FORCE:-0}" = "1" ]; }; then
  echo "[build-backend-local] 校验/拉取基础镜像（linux/amd64 × ${#BASE_IMAGES[@]}）"
  for img in "${BASE_IMAGES[@]}"; do
    arch=$(docker image inspect "$img" --format '{{.Architecture}}' 2>/dev/null || echo missing)
    if [ "$arch" != "amd64" ]; then
      echo "[build-backend-local] $img 当前架构=$arch → 拉取 linux/amd64"
      docker pull --platform linux/amd64 "$img"
    else
      echo "[build-backend-local] $img 已是 linux/amd64，跳过"
    fi
  done
  docker save "${BASE_IMAGES[@]}" | gzip > dist/images/base-images.tar.gz
  ls -lh dist/images/base-images.tar.gz
fi

# ---- 1. bbc-app 镜像（linux/amd64）----
if [ ! -f "dist/images/bbc-app-$VER.tar.gz" ] || [ "${FORCE:-0}" = "1" ]; then
  echo "[build-backend-local] 构建 bbc-app:${VER}（linux/amd64）"
  docker buildx build --platform linux/amd64 --load \
    -t "baobaochat/bbc-app:$VER" server/
  docker save "baobaochat/bbc-app:$VER" | gzip > "dist/images/bbc-app-$VER.tar.gz"
else
  echo "[build-backend-local] 复用已有 dist/images/bbc-app-$VER.tar.gz（FORCE=1 强制重建）"
fi

# ---- 2. 官网静态 ----
echo "[build-backend-local] 构建官网静态"
if [ ! -d website/node_modules ]; then
  npm --prefix website install --no-audit --no-fund
fi
npm --prefix website run build >/dev/null

# ---- 3a. compose 部署包 ----
if [ "$ONLY" = "all" ] || [ "$ONLY" = "compose" ]; then
  BBC_DEPLOY_VERSION="$VER" BBC_BUNDLE_IMAGES="$BUNDLE" bash scripts/release/gen-deploy-package.sh
fi

# ---- 3b. K8s 部署包（需接入层 web 镜像）----
if [ "$ONLY" = "all" ] || [ "$ONLY" = "k8s" ]; then
  echo "[build-backend-local] 构建接入层镜像 web:${VER}（linux/amd64）"
  BUILD_DIR="dist/.web-build"
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR/website-dist"
  cp -R website/dist/. "$BUILD_DIR/website-dist/"
  cp deploy/k8s/baobao-chat/web-image/Dockerfile deploy/k8s/baobao-chat/web-image/nginx.conf "$BUILD_DIR/"
  docker buildx build --platform linux/amd64 --load -t "baobaochat/web:$VER" "$BUILD_DIR"
  docker save "baobaochat/web:$VER" | gzip > "dist/images/web-$VER.tar.gz"
  rm -rf "$BUILD_DIR"

  BBC_K8S_VERSION="$VER" BBC_BUNDLE_IMAGES="$BUNDLE" bash scripts/release/gen-k8s-package.sh
fi

echo
echo "[build-backend-local] 完成，产物："
ls -lh dist/*.tar.gz
echo
echo "下一步：拷进内网 → 按包内 INSTALL.md / INSTALL-K8S.md 部署"