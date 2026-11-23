#!/usr/bin/env bash
# =============================================================================
# set-version.sh —— 版本号统一提升（D21）
#
# 版本散落四处（client/package.json、tauri.conf.json、壳 Cargo.toml、agent
# workspace Cargo.toml），此前纯手工同步（AboutPage 注释口径）。本脚本一把改齐，
# 可选打 git tag v<ver>（tag 仅打当前 HEAD，未提交改动会提示）。
#
# 用法：
#   bash scripts/release/set-version.sh 0.2.0          # 只改版本
#   bash scripts/release/set-version.sh 0.2.0 --tag    # 改版本 + git tag v0.2.0
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-}"
TAG=0
[ "${2:-}" = "--tag" ] && TAG=1

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "[set-version] 用法: $0 <semver> [--tag]   例: $0 0.2.0 --tag" >&2
  exit 1
}

for f in \
  "$ROOT/client/package.json" \
  "$ROOT/client/src-tauri/tauri.conf.json" \
  "$ROOT/client/src-tauri/Cargo.toml" \
  "$ROOT/agent/Cargo.toml"; do
  [ -f "$f" ] || { echo "[set-version] 缺文件: $f" >&2; exit 1; }
done

# 替换用 python（sed 对 JSON/带空格正则可读性差）；expect 保证只动该动的那一处
# 解释器兼容：mac/Linux 用 python3；GitHub Windows runner 的 Git Bash 常只有 python
# （WindowsApps 的 python3 是商店占位符，须实际执行验活后再采用）
PY_BIN="$(command -v python3 || true)"
if [ -z "$PY_BIN" ] || ! "$PY_BIN" -c 'import sys' >/dev/null 2>&1; then
  PY_BIN="$(command -v python || true)"
fi
[ -n "$PY_BIN" ] || { echo "[set-version] 需要 python3 或 python" >&2; exit 1; }

"$PY_BIN" - "$VERSION" "$ROOT" <<'PY'
import json, re, sys, pathlib

ver, root = sys.argv[1], pathlib.Path(sys.argv[2])

def sub_file(path, pattern, repl, expect=1):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    new, n = re.subn(pattern, repl, s)
    if n != expect:
        sys.exit(f"[set-version] {p}: 期望替换 {expect} 处，实际 {n} 处（pattern={pattern!r}）")
    p.write_text(new, encoding="utf-8")
    print(f"[set-version] {p.relative_to(root)} -> {ver}")

# package.json（json 字段唯一）
sub_file(root / "client/package.json", r'("version"\s*:\s*)"[^"]*"', rf'\g<1>"{ver}"')
# tauri.conf.json（json 字段唯一）
sub_file(root / "client/src-tauri/tauri.conf.json", r'("version"\s*:\s*)"[^"]*"', rf'\g<1>"{ver}"')
# 壳 Cargo.toml：仅 [package] 段行首 version（rust-version 不带引号匹配）
sub_file(root / "client/src-tauri/Cargo.toml", r'(?m)^version\s*=\s*"[^"]*"', f'version = "{ver}"')
# agent workspace：[workspace.package] 段行首 version
sub_file(root / "agent/Cargo.toml", r'(?m)^version\s*=\s*"[^"]*"', f'version = "{ver}"')
PY

# Cargo.lock 版本随动（离线尽力而为；下次 cargo build 也会自动刷新）
for ws in "$ROOT/agent" "$ROOT/client/src-tauri"; do
  (cd "$ws" && cargo update --workspace --offline >/dev/null 2>&1 \
    && echo "[set-version] $ws/Cargo.lock 已刷新" \
    || echo "[set-version] $ws/Cargo.lock 离线刷新跳过（下次构建自动更新）")
done

if [ "$TAG" = 1 ]; then
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "[set-version] ⚠ 工作区有未提交改动，tag 将打在提交后的 HEAD——请先提交再 --tag（本次跳过打 tag）" >&2
  else
    git -C "$ROOT" tag "v$VERSION"
    echo "[set-version] git tag v${VERSION} 已打"
  fi
fi

echo "[set-version] 完成：v${VERSION}（四处版本已对齐）"