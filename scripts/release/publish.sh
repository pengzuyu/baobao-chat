#!/usr/bin/env bash
# =============================================================================
# publish.sh —— 发布安装包与更新清单到部署机（D21）
#
# 前置：各平台已跑 build-desktop 出包（out/release/v<ver>/<platform>/ 含 .sig），
#       gen-manifest.mjs 已生成 latest.json / release-info.json（缺则此处自动补跑）。
#
# 用法（在本机或任一汇集了产物的机器执行；rsync + ssh）：
#   BBC_PUBLIC_URL=http://bbc.example.internal \
#   BBC_DEPLOY_HOST=deploy@10.x.x.x \
#   BBC_DEPLOY_ROOT=/opt/baobaochat/deploy/compose \
#     bash scripts/release/publish.sh
#
# 环境变量：
#   BBC_PUBLIC_URL       必填（生成 manifest 绝对 URL）
#   BBC_DEPLOY_HOST      必填（ssh 目标，user@host；免密或代理按需配 ~/.ssh/config）
#   BBC_DEPLOY_ROOT      必填（服务器上 deploy/compose 的绝对路径——更新卷 =
#                        $ROOT/volumes/updates）
#   BBC_ALLOW_PARTIAL=1  缺平台放行（默认四平台齐全才发，防半截发布）
#
# 发布后自检：curl 回读 /update/latest.json 校验版本号。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
URL="${BBC_PUBLIC_URL:?BBC_PUBLIC_URL 必填（http://域名）}"
URL="${URL%/}"
HOST="${BBC_DEPLOY_HOST:?BBC_DEPLOY_HOST 必填（ssh user@host）}"
DEPLOY_ROOT="${BBC_DEPLOY_ROOT:?BBC_DEPLOY_ROOT 必填（服务器上 deploy/compose 绝对路径）}"
UPDATES_DIR="$DEPLOY_ROOT/volumes/updates"

VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/client/src-tauri/tauri.conf.json'))['version'])")"
OUT="$ROOT/out/release/v$VERSION"

# ---- 1. 产物齐套校验（默认四平台；ALLOW_PARTIAL 放行）----
if [ ! -f "$OUT/latest.json" ]; then
  echo "[publish] latest.json 缺失——先补跑 gen-manifest"
  BBC_PUBLIC_URL="$URL" node "$ROOT/scripts/release/gen-manifest.mjs"
fi

MISSING=""
for plat in darwin-x86_64 darwin-aarch64 linux-x86_64 windows-x86_64; do
  if ! ls "$OUT/$plat/"*.sig >/dev/null 2>&1; then MISSING="$MISSING $plat"; fi
done
if [ -n "$MISSING" ] && [ "${BBC_ALLOW_PARTIAL:-0}" != 1 ]; then
  echo "[publish] ✗ 缺平台产物（无 .sig）：$MISSING" >&2
  echo "[publish]   各平台机上跑 build-desktop 后把产物汇到 ${OUT}；确需部分发布加 BBC_ALLOW_PARTIAL=1" >&2
  exit 1
fi
[ -n "$MISSING" ] && echo "[publish] ⚠ BBC_ALLOW_PARTIAL=1：缺平台（${MISSING}）按现状发布"

# ---- 2. rsync 发布（平台子目录随产物目录原样；清单两份置卷根）----
echo "[publish] v$VERSION → $HOST:$UPDATES_DIR"
ssh "$HOST" "mkdir -p '$UPDATES_DIR/releases'"
rsync -a --info=stats1 "$OUT/" "$HOST:$UPDATES_DIR/releases/v$VERSION/"
rsync -a "$OUT/latest.json" "$OUT/release-info.json" "$HOST:$UPDATES_DIR/"

# ---- 3. 回读验证（latest.json 版本 == 本地版本）----
PUBLISHED="$(curl -fsSL --max-time 15 "$URL/update/latest.json" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" || true)"
if [ "$PUBLISHED" = "$VERSION" ]; then
  echo "[publish] ✔ 回读验证通过：$URL/update/latest.json → v$VERSION"
else
  echo "[publish] ✗ 回读验证失败（远端=${PUBLISHED:-不可达}，期望=${VERSION}）——检查 nginx-lb/update-src 与缓存" >&2
  exit 1
fi
echo "[publish] 完成——客户端下次检查更新即见 v$VERSION"
