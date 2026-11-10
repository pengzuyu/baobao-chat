#!/usr/bin/env bash
# =============================================================================
# prepare-bbrt-sidecar.sh —— bbrt 随包分发前置（16 篇 §5.1 / EXECUTION-PLAN A4）
#
# Tauri externalBin 约定：client/src-tauri/binaries/bbrt-<target-triple>[.exe]
# （tauri.macos.conf.json / tauri.linux.conf.json 声明 "binaries/bbrt"，构建时
#  自动拼 triple 后缀）。本脚本编译 bbrt 并按当前 host triple 落位。
#
# 用法：
#   bash scripts/prepare-bbrt-sidecar.sh              # host triple（常规打包）
#   BBW_BBRT_TRIPLE=aarch64-apple-darwin \
#     bash scripts/prepare-bbrt-sidecar.sh            # 交叉/显式指定（如 universal 包前置）
#   BBW_BBRT_PROFILE=debug bash ...                   # 默认 release
#
# 平台限制（bbrt-agent-unix-only）：bbrt 在 Windows 编不过（compile_error 兜底），
# Windows 包不随带 sidecar（tauri.conf 主文件不含 externalBin），本脚本在
# Windows 下直接报错退出。
# 验收口径（16 篇 L370）：sidecar <30MB，超限即失败（防体积回归）。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT/agent"
DEST_DIR="$ROOT/client/src-tauri/binaries"
PROFILE="${BBW_BBRT_PROFILE:-release}"
LIMIT_MB=30

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "[prepare-bbrt-sidecar] Windows 不支持：bbrt 编不过（compile_error 兜底），Windows 包不随带 sidecar" >&2
    exit 1
    ;;
esac

TRIPLE="${BBW_BBRT_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
[ -n "$TRIPLE" ] || { echo "[prepare-bbrt-sidecar] 无法探测 host triple（rustc -vV）" >&2; exit 1; }

echo "[prepare-bbrt-sidecar] cargo build -p bbrt --${PROFILE}（triple=${TRIPLE}）"
(cd "$AGENT_DIR" && cargo build -p bbrt --"$PROFILE")

BIN="$AGENT_DIR/target/$PROFILE/bbrt"
[ -f "$BIN" ] || { echo "[prepare-bbrt-sidecar] 构建产物缺失: $BIN" >&2; exit 1; }

SIZE_MB=$(du -m "$BIN" | cut -f1)
echo "[prepare-bbrt-sidecar] bbrt 大小: ${SIZE_MB}MB（验收上限 ${LIMIT_MB}MB）"
[ "$SIZE_MB" -le "$LIMIT_MB" ] || {
  echo "[prepare-bbrt-sidecar] 超出 16 篇 L370 验收上限——检查符号是否已 strip/改 opt-level=s" >&2
  exit 1
}

mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/bbrt-$TRIPLE"
cp "$BIN" "$DEST"
echo "[prepare-bbrt-sidecar] 落位: $DEST"
echo "[prepare-bbrt-sidecar] 完成——随后 npm --prefix client run tauri build 即随包分发"
