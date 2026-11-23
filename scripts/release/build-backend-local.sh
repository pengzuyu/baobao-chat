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
#   # 只出 compose 档 / 只出 K8s 档：
#   ONLY=compose bash scripts/release/build-backend-local.sh 0.1.4
#   ONLY=k8s     bash scripts/release/build-backend-local.sh 0.1.4
#
# 前置：Docker Desktop 运行中（buildx 可用）、helm、node/npm。
# 产物：dist/baobaochat-deploy-v<ver>.tar.gz（compose）
#       dist/baobaochat-k8s-v<ver>.tar.gz（K8s）
# =============================================================================
set -euo pipefail

VER="${1:?用法: bash scripts/release/build-backend-local.sh <版本号，如 0.1.4>}"
ONLY="${ONLY:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[build-backend-local] v${VER}（ONLY=${ONLY}）"
docker buildx version >/dev/null 2>&1 || { echo "[build-backend-local] Docker buildx 不可用（启动 Docker Desktop）" >&2; exit 1; }
command -v helm >/dev/null || { echo "[build-backend-local] 缺 helm：brew install helm" >&2; exit 1; }

mkdir -p dist/images

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
  BBC_DEPLOY_VERSION="$VER" bash scripts/release/gen-deploy-package.sh
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

  BBC_K8S_VERSION="$VER" bash scripts/release/gen-k8s-package.sh
fi

echo
echo "[build-backend-local] 完成，产物："
ls -lh dist/*.tar.gz
echo
echo "下一步：拷进内网 → 按包内 INSTALL.md / INSTALL-K8S.md 部署"