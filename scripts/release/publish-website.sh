#!/usr/bin/env bash
# =============================================================================
# publish-website.sh —— 官网构建与发布（D21）
#
# 用法（rsync + ssh）：
#   BBW_DEPLOY_HOST=deploy@10.x.x.x \
#   BBW_DEPLOY_ROOT=/opt/baobaochat/deploy/compose \
#     bash scripts/release/publish-website.sh
#
# 环境变量：
#   BBW_DEPLOY_HOST   必填（ssh 目标；官网卷 = $BBW_DEPLOY_ROOT/volumes/website）
#   BBW_DEPLOY_ROOT   必填（服务器上 deploy/compose 绝对路径）
#   BBW_VERIFY_URL    可选（发布后回读验证的站点地址，默认 http://<host>/）
#
# 步骤：npm install（缺 node_modules 时）→ vite build → rsync dist/ → 卷目录
#       （--delete 清旧资产）→ curl 回读验证首页可达。
# 官网与版本发布解耦：下载区数据运行时拉 /update/release-info.json。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${BBW_DEPLOY_HOST:?BBW_DEPLOY_HOST 必填（ssh user@host）}"
DEPLOY_ROOT="${BBW_DEPLOY_ROOT:?BBW_DEPLOY_ROOT 必填（服务器上 deploy/compose 绝对路径）}"
WEBSITE_DIR="$DEPLOY_ROOT/volumes/website"
VERIFY_URL="${BBW_VERIFY_URL:-http://$(echo "$HOST" | sed 's/^[^@]*@//')/}"

[ -d "$ROOT/website" ] || { echo "[publish-website] website/ 工程缺失" >&2; exit 1; }

echo "[publish-website] 构建官网（website/）"
[ -d "$ROOT/website/node_modules" ] || npm --prefix "$ROOT/website" install --no-audit --no-fund
npm --prefix "$ROOT/website" run build

echo "[publish-website] rsync → $HOST:$WEBSITE_DIR"
ssh "$HOST" "mkdir -p '$WEBSITE_DIR'"
rsync -a --delete --info=stats1 "$ROOT/website/dist/" "$HOST:$WEBSITE_DIR/"

# 回读验证品牌名取 brand/brand.json（D31：换牌部署后门禁不再认死上游名）
BRAND_NAME="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/brand/brand.json','utf8')).name)")"
if curl -fsSL --max-time 15 "$VERIFY_URL" | grep -q "$BRAND_NAME"; then
  echo "[publish-website] ✔ 回读验证通过：$VERIFY_URL"
else
  echo "[publish-website] ✗ 回读验证失败（$VERIFY_URL 未含 $BRAND_NAME 字样）——检查 nginx-lb / website 服务" >&2
  exit 1
fi
