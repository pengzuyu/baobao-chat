#!/usr/bin/env bash
# =============================================================================
# build-desktop.sh —— macOS/Linux 桌面发布出包（D21）
#
# 单变量 BBC_PUBLIC_URL 决定全局后台地址（v0.1 统一 http，D21 口径）：
#   前端   VITE_API_BASE = $BBC_PUBLIC_URL/api/v1（临时 .env.production，WS 自动推导）
#   壳/Rust BBC_RT_GATEWAY 编译期缺省 = $BBC_PUBLIC_URL（build.rs 注入两级缺省链）
#   更新器 endpoints = $BBC_PUBLIC_URL/update/latest.json（--config 覆盖，域名不进库）
#
# 用法（各平台对应系统机上执行）：
#   BBC_PUBLIC_URL=http://bbc.example.internal \
#     bash scripts/release/build-desktop.sh
# 环境变量：
#   BBC_PUBLIC_URL               必填，http(s)://域名（不带尾斜杠、不带 /api 前缀）
#   TAURI_SIGNING_PRIVATE_KEY    updater minisign 私钥（内容或路径）+ TAURI_SIGNING_PASSWORD
#                                缺失时须 BBC_ALLOW_UNSIGNED=1（试包可、发布不可）
#   BBC_TRIPLES                  覆盖目标：macOS 默认 "x86_64-apple-darwin
#                                aarch64-apple-darwin"，Linux 默认 "x86_64-unknown-linux-gnu"
# 产物：out/release/v<ver>/<platform>/（platform= updater 清单键，如 darwin-x86_64），
#       随后 scripts/release/gen-manifest.mjs + publish.sh 汇总发布。
# Linux 前置：libwebkit2gtk-4.1-dev build-essential libssl-dev 等（Tauri v2 官方依赖）。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRIPLES_STR="${BBC_TRIPLES:-}"

# ---- 0. 环境校验 ----
URL="${BBC_PUBLIC_URL:-}"
[[ "$URL" =~ ^https?://[^/]+/?$ ]] || {
  echo "[build-desktop] BBC_PUBLIC_URL 必填且形如 http://bbc.example.internal（不带路径）" >&2
  exit 1
}
URL="${URL%/}"

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if [ "${BBC_ALLOW_UNSIGNED:-0}" = 1 ]; then
    echo "[build-desktop] ⚠ 无签名私钥（BBC_ALLOW_UNSIGNED=1）：出包无 .sig，仅可本地试装、不可发布" >&2
  else
    echo "[build-desktop] 缺 TAURI_SIGNING_PRIVATE_KEY（+TAURI_SIGNING_PASSWORD）——updater 签名必需；本地试包可 BBC_ALLOW_UNSIGNED=1" >&2
    exit 1
  fi
fi

case "$(uname -s)" in
  Darwin) [ -n "$TRIPLES_STR" ] || TRIPLES_STR="x86_64-apple-darwin aarch64-apple-darwin" ;;
  Linux)  [ -n "$TRIPLES_STR" ] || TRIPLES_STR="x86_64-unknown-linux-gnu" ;;
  *) echo "[build-desktop] 本脚本跑 macOS/Linux；Windows 用 scripts/release/build-desktop.ps1" >&2; exit 1 ;;
esac

VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/client/src-tauri/tauri.conf.json'))['version'])")"
OUT_BASE="$ROOT/out/release/v$VERSION"

[ -d "$ROOT/client/node_modules" ] || { echo "[build-desktop] 先装依赖：npm --prefix client install" >&2; exit 1; }

# 品牌产物一致性门禁（D31）：brand/brand.json 改动未跑生成器则拒绝出包
node "$ROOT/scripts/brand/gen.mjs" --check

# ---- 1. 编译期注入的临时文件（trap 保证清理，域名不进 git）----
ENV_PROD="$ROOT/client/.env.production"
REL_CONF="$ROOT/client/src-tauri/tauri.release.conf.json"
INSECURE=$([[ "$URL" == http://* ]] && echo true || echo false)
cleanup() { rm -f "$ENV_PROD" "$REL_CONF"; }
trap cleanup EXIT

cat > "$ENV_PROD" <<EOF
# build-desktop.sh 生成（临时，勿提交）：v0.1 统一 http（D21）
VITE_API_BASE=$URL/api/v1
EOF

cat > "$REL_CONF" <<EOF
{
  "plugins": {
    "updater": {
      "endpoints": ["$URL/update/latest.json"],
      "dangerousInsecureTransportProtocol": $INSECURE,
      "requireSignedVersion": true
    }
  }
}
EOF
echo "[build-desktop] v$VERSION · 网关=$URL · insecureTransport=$INSECURE"

# ---- 2. 逐 triple：sidecar → tauri build → 收集产物 ----
platkey() {
  case "$1" in
    x86_64-apple-darwin)        echo darwin-x86_64 ;;
    aarch64-apple-darwin)       echo darwin-aarch64 ;;
    x86_64-unknown-linux-gnu)   echo linux-x86_64 ;;
    *) echo ""; return 1 ;;
  esac
}

for TRIPLE in $TRIPLES_STR; do
  PLAT="$(platkey "$TRIPLE")" || { echo "[build-desktop] 不认识的 triple: $TRIPLE" >&2; exit 1; }
  OUT="$OUT_BASE/$PLAT"
  echo
  echo "===== [$TRIPLE → $PLAT] ====="

  BBC_BBRT_TRIPLE="$TRIPLE" bash "$ROOT/scripts/prepare-bbrt-sidecar.sh"

  (cd "$ROOT/client" && ./node_modules/.bin/tauri build \
      --target "$TRIPLE" --config "$REL_CONF")

  # 收集 bundle 产物（tauri build --target 落 target/<triple>/release/bundle/）。
  # 精准按文件模式收（整目录 cp 会卷入 icon.icns/bundle_dmg.sh 等中间产物）；
  # .app 目录不收——updater 走 .app.tar.gz、官网直链给 .dmg。
  BUNDLE="$ROOT/client/src-tauri/target/$TRIPLE/release/bundle"
  mkdir -p "$OUT"
  shopt -s nullglob
  for f in "$BUNDLE/macos/"*.app.tar.gz "$BUNDLE/macos/"*.app.tar.gz.sig \
           "$BUNDLE/dmg/"*.dmg \
           "$BUNDLE/appimage/"*.AppImage "$BUNDLE/appimage/"*.AppImage.sig \
           "$BUNDLE/deb/"*.deb; do
    cp "$f" "$OUT/"
  done
  shopt -u nullglob
  echo "[build-desktop] 产物已收至 ${OUT}："
  (cd "$OUT" && ls -lh | awk 'NR>1 {printf "    %10s  %s\n", $5, $9}')
done

echo
echo "[build-desktop] 完成：$OUT_BASE"
echo "[build-desktop] 下一步（任一机器）：node scripts/release/gen-manifest.mjs && bash scripts/release/publish.sh"
