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
#   BBC_BBRT_TRIPLE=aarch64-apple-darwin \
#     bash scripts/prepare-bbrt-sidecar.sh            # 交叉/显式指定（如 universal 包前置）
#   BBC_BBRT_PROFILE=debug bash ...                   # 默认 release
#
# 平台（2026-11-23 Windows 移植后）：macOS/Linux/Windows 三平台皆可（procgrp.rs
# 平台层——unix 进程组 / Windows Job Object）；Windows 产物名带 .exe（externalBin
# 约定）。MSYS/Git-Bash 下可用，或用 build-desktop.ps1 内联等价步骤。
# 验收口径（16 篇 L370）：sidecar <30MB，超限即失败（防体积回归）。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT/agent"
DEST_DIR="$ROOT/client/src-tauri/binaries"
PROFILE="${BBC_BBRT_PROFILE:-release}"
LIMIT_MB=30

TRIPLE="${BBC_BBRT_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
[ -n "$TRIPLE" ] || { echo "[prepare-bbrt-sidecar] 无法探测 host triple（rustc -vV）" >&2; exit 1; }

# 显式 --target：交叉 triple（如 arm 机器出 x86_64 包，D21 双架构出包）时产物
# 落 target/<triple>/；此前只改落位名不改 target，交叉时会拿 host 架构二进制冒名。
if ! rustup target list --installed 2>/dev/null | grep -q "^${TRIPLE}$"; then
  echo "[prepare-bbrt-sidecar] 缺 target 工具链 ${TRIPLE}：rustup target add ${TRIPLE}" >&2
  exit 1
fi

echo "[prepare-bbrt-sidecar] cargo build -p bbrt --target ${TRIPLE} --${PROFILE}"
(cd "$AGENT_DIR" && cargo build -p bbrt --target "$TRIPLE" --"$PROFILE")

# Windows triple 产物带 .exe（Tauri externalBin 命名约定同构）
BIN_EXT=""
case "$TRIPLE" in *-windows-*) BIN_EXT=".exe" ;; esac
BIN="$AGENT_DIR/target/$TRIPLE/$PROFILE/bbrt${BIN_EXT}"
[ -f "$BIN" ] || { echo "[prepare-bbrt-sidecar] 构建产物缺失: $BIN" >&2; exit 1; }

SIZE_MB=$(du -m "$BIN" | cut -f1)
echo "[prepare-bbrt-sidecar] bbrt 大小: ${SIZE_MB}MB（验收上限 ${LIMIT_MB}MB）"
[ "$SIZE_MB" -le "$LIMIT_MB" ] || {
  echo "[prepare-bbrt-sidecar] 超出 16 篇 L370 验收上限——检查符号是否已 strip/改 opt-level=s" >&2
  exit 1
}

mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/bbrt-$TRIPLE${BIN_EXT}"
cp "$BIN" "$DEST"
echo "[prepare-bbrt-sidecar] 落位: $DEST"
echo "[prepare-bbrt-sidecar] 完成——随后 npm --prefix client run tauri build 即随包分发"
