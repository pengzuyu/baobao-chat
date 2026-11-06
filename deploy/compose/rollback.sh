#!/usr/bin/env bash
# =============================================================================
# BaobaoWork docker-compose 回滚脚本（16 篇 §4.4 回滚路径 / §3.4 双形态升级表）
# 用法：./rollback.sh [TAG]   （缺省使用 .env 中的 BBW_PREVIOUS_TAG）
# 原则：
#  · 保留上一 tag 一键切回（N-1 镜像由 upgrade.sh 通过 BBW_PREVIOUS_TAG 记录）
#  · DB 依赖迁移向后兼容承诺：仅迁移窗口内可直接回滚；
#    超出窗口的回滚 = 恢复备份（./restore.sh，RTO 走 §4.6）
#  · K8s 形态等价操作为 `helm rollback`（§3.4 对比表）
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

fail() { echo "[rollback] ✘ $*" >&2; exit 1; }

[ -f .env ] || fail "缺少 .env（先执行 cp .env.tpl .env）"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

TAG="${1:-${BBW_PREVIOUS_TAG:-}}"
[ -n "$TAG" ] || fail "未指定回滚 TAG：./rollback.sh <TAG>，或先执行过一次 upgrade.sh"
echo "[rollback] 回滚目标 TAG=${TAG}（当前 ${BBW_IMAGE_TAG}）"

echo "[rollback] ⚠ 迁移窗口检查：若升级包包含 DB 迁移，直接回滚依赖“仅向后兼容变更”承诺（16 篇 §4.4）。"
echo "[rollback] ⚠ 破坏性变更必须拆分为多窗口渐进执行；超出窗口请改走恢复备份（./restore.sh）。"
read -r -p "确认在迁移窗口内、允许直接切回镜像？输入 yes 继续: " CONFIRM
[ "$CONFIRM" = "yes" ] || fail "未确认，退出（未做任何变更）"

wait_healthy() { # $1=服务名 $2=超时秒
  local svc="$1" tmo="${2:-180}" waited id
  for id in $(docker compose ps -aq "$svc"); do
    waited=0
    until [ "$(docker inspect --format '{{.State.Health.Status}}' "$id")" = "healthy" ]; do
      sleep 5
      waited=$((waited + 5))
      [ "$waited" -ge "$tmo" ] && fail "服务 ${svc}（${id}）健康检查超时（${tmo}s）"
    done
  done
  echo "[rollback] ✔ ${svc} 健康"
}

# 拉取并逐服务切回（顺序同 §4.4：服务先切、接入层最后；media 需通话避让确认）
BBW_IMAGE_TAG="$TAG" docker compose pull --ignore-buildable || fail "镜像拉取失败（N-1 镜像应保留在本地 Registry）"
BBW_IMAGE_TAG="$TAG" docker compose up -d --no-deps --force-recreate app
wait_healthy app

if docker compose config --services | grep -q '^media$'; then
  read -r -p "media 检测到：确认通话避让窗口后输入 yes 继续: " CONFIRM_MEDIA
  [ "$CONFIRM_MEDIA" = "yes" ] || fail "media 未确认避让（app 已回滚）"
  BBW_IMAGE_TAG="$TAG" docker compose up -d --no-deps --force-recreate media
  wait_healthy media
fi

BBW_IMAGE_TAG="$TAG" docker compose up -d --no-deps --force-recreate nginx-lb
wait_healthy nginx-lb

# 写回 .env
sed -i.bak "s/^BBW_IMAGE_TAG=.*/BBW_IMAGE_TAG=${TAG}/" .env
rm -f .env.bak

docker compose ps
echo "[rollback] ✔ 回滚完成：BBW_IMAGE_TAG=${TAG}"
echo "[rollback] 后续：执行冒烟用例并观察 SLO（§4.4 第 4 步）；客户端不受影响（服务端先升后客户端，协议兼容窗口 ≥6 个月）。"
