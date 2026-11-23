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

# ---- 1.5 历史清单合并（2026-11-23）----
# gen-manifest 只扫本地 out/release/v*/——本地清理旧产物后历史会丢；
# 发布前拉服务器现有 release-info.json，把其 releases 并入本次清单（版本号去重，本次覆盖）。
OLD_INFO=$(mktemp)
if ssh "$HOST" "cat '$UPDATES_DIR/release-info.json'" > "$OLD_INFO" 2>/dev/null && [ -s "$OLD_INFO" ]; then
  python3 - "$OLD_INFO" "$OUT/release-info.json" <<'PY'
import json, sys
old_path, new_path = sys.argv[1], sys.argv[2]
try:
    old = json.load(open(old_path))
except Exception:
    sys.exit(0)  # 服务器清单损坏：跳过合并（本次清单照发）
new = json.load(open(new_path))
by_ver = {r["version"]: r for r in (old.get("releases") or [])}
for r in (new.get("releases") or []):
    by_ver[r["version"]] = r  # 本次数据覆盖同版本
def key(v):
    return tuple(int(x) for x in v.split("."))
merged = sorted(by_ver.values(), key=lambda r: key(r["version"]), reverse=True)
new["releases"] = merged
with open(new_path, "w", encoding="utf-8") as f:
    json.dump(new, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"[publish] 历史清单合并完成：releases 共 {len(merged)} 个（本次 v{new['version']}）")
PY
else
  echo "[publish] 服务器无既有清单（首次发布）：跳过历史合并"
fi
rm -f "$OLD_INFO"

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
