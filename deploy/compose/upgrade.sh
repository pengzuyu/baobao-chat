#!/usr/bin/env bash
# =============================================================================
# BaobaoWork docker-compose 升级脚本（16 篇 §4.4 服务端版本升级顺序）
# 用法：./upgrade.sh <新镜像TAG>
#  0 预检：磁盘水位 / 兼容矩阵人工确认 / 备份健康检查
#  1 备份：调用 backup.sh（pg_dump + WAL 归档确认 + 基础备份占位）
#  2 拉取新镜像
#  3 DB 迁移：同镜像 bbw-app migrate（§3.4“同镜像 migrate job”）
#  4 逐服务 recreate：app（含 audit/notify→域服务→auth 全体内嵌）→ onlyoffice
#    → media（通话避让确认）→ nginx-lb 接入层最后切换（§4.4 第 3 步）
#  5 健康检查 + 冒烟提示；失败则提示 rollback.sh
# 前提：已 cp .env.tpl .env，并按站点设置 COMPOSE_PROFILES（如 core,media,docs）
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

NEW_TAG="${1:?用法: ./upgrade.sh <新镜像TAG>，例如 ./upgrade.sh 0.2.0}"
TIMEOUT_HEALTH="${BBW_UPGRADE_HEALTH_TIMEOUT:-180}"

fail() {
  echo "[upgrade] ✘ $*" >&2
  echo "[upgrade] 回滚指引：./rollback.sh <上一TAG>" >&2
  echo "[upgrade] 注意：若本次升级包含 DB 迁移，回滚依赖“仅向后兼容变更”承诺（16 篇 §4.4）；" >&2
  echo "[upgrade] 超出迁移窗口的回滚 = 恢复备份（./restore.sh，RTO 见 §4.6）。" >&2
  exit 1
}

[ -f .env ] || fail "缺少 .env（先执行 cp .env.tpl .env 并修改）"

# 加载 .env（含 COMPOSE_PROFILES / BBW_IMAGE_TAG / DB 凭据）
set -a
# shellcheck disable=SC1091
. ./.env
set +a

OLD_TAG="${BBW_IMAGE_TAG:?}"
echo "[upgrade] 当前 TAG=${OLD_TAG} → 目标 TAG=${NEW_TAG}"

# ---------------------------------------------------------------------------
# 0. 预检
# ---------------------------------------------------------------------------
# 磁盘水位：>85% 阻断（§6.5 告警阈 80%，升级前留余量）
USAGE_PCT=$(df -P . | awk 'NR==2 {gsub("%","",$5); print $5}')
[ "$USAGE_PCT" -lt 85 ] || fail "磁盘水位 ${USAGE_PCT}% ≥ 85%，先按 §4.8 归档/扩容"

# 兼容矩阵人工核对（§4.4 第 0 步：客户端协议兼容窗口 ≥6 个月）
echo "[upgrade] 预检：请确认已核对版本兼容矩阵与升级公告（14 篇 §8 协议兼容窗口）。"
read -r -p "已确认并允许继续升级？输入 yes 继续: " CONFIRM
[ "$CONFIRM" = "yes" ] || fail "未确认，退出（未做任何变更）"

# ---------------------------------------------------------------------------
# 1. 备份（§4.4 第 1 步：PG 备份 + WAL 确认可归档）
# ---------------------------------------------------------------------------
echo "[upgrade] 第 1 步：执行备份 ..."
./backup.sh || fail "备份失败，按 §4.6 检查后重试（升级已中止，未做任何变更）"

# ---------------------------------------------------------------------------
# 2. 拉取新镜像（BBW 自有镜像同一 tag 锁定，§3.4）
# ---------------------------------------------------------------------------
echo "[upgrade] 第 2 步：拉取镜像 TAG=${NEW_TAG} ..."
BBW_IMAGE_TAG="$NEW_TAG" docker compose pull --ignore-buildable || fail "镜像拉取失败（检查 Registry 可达性）"

# ---------------------------------------------------------------------------
# 3. DB 迁移（同镜像 bbw-app migrate；仅向后兼容变更，§4.4 第 2 步）
# ---------------------------------------------------------------------------
echo "[upgrade] 第 3 步：DB 迁移（bbw-app migrate） ..."
BBW_IMAGE_TAG="$NEW_TAG" docker compose run --rm --no-deps app migrate \
  || fail "DB 迁移失败：请查看 migrate 日志；受影响对象见迁移文件（server/migrations）"

# ---------------------------------------------------------------------------
# 4. 逐服务 recreate（§4.4 第 3 步顺序；接入层最后）
# ---------------------------------------------------------------------------
wait_healthy() { # $1=服务名 $2=超时秒
  local svc="$1" tmo="${2:-$TIMEOUT_HEALTH}" waited id
  for id in $(docker compose ps -aq "$svc"); do
    waited=0
    until [ "$(docker inspect --format '{{.State.Health.Status}}' "$id")" = "healthy" ]; do
      sleep 5
      waited=$((waited + 5))
      [ "$waited" -ge "$tmo" ] && fail "服务 ${svc}（${id}）健康检查超时（${tmo}s）"
    done
  done
  echo "[upgrade] ✔ ${svc} 健康"
}

echo "[upgrade] 第 4 步：逐服务 recreate（audit/notify→域服务→auth 内嵌于 app；接入层最后） ..."
# 4.1 app（模块化单体，--enable 全域）
BBW_IMAGE_TAG="$NEW_TAG" docker compose up -d --no-deps --force-recreate app
wait_healthy app

# 4.2 onlyoffice（docs profile 启用时）
if docker compose config --services | grep -q '^onlyoffice$'; then
  BBW_IMAGE_TAG="$NEW_TAG" docker compose up -d --no-deps onlyoffice
  wait_healthy onlyoffice 300
fi

# 4.3 media（§4.4 media 特殊性：通话避让窗口——先确认无进行中通话）
if docker compose config --services | grep -q '^media$'; then
  echo "[upgrade] 检测到 media（media profile）：扩容/重启前请确认通话避让窗口（§4.5：标记 draining → 现有通话结束不迁）。"
  read -r -p "确认当前无进行中通话或已避让？输入 yes 继续: " CONFIRM_MEDIA
  [ "$CONFIRM_MEDIA" = "yes" ] || fail "media 未确认避让（app 已升级，可稍后单独重跑 media 步骤）"
  BBW_IMAGE_TAG="$NEW_TAG" docker compose up -d --no-deps --force-recreate media
  wait_healthy media
fi

# 4.4 接入层最后切换（§4.4：gateway/接入层最后，保证旧客户端协议兼容）
BBW_IMAGE_TAG="$NEW_TAG" docker compose up -d --no-deps --force-recreate nginx-lb
wait_healthy nginx-lb

# ---------------------------------------------------------------------------
# 5. 验证（§4.4 第 4 步：冒烟 + SLO 观察 24h）
# ---------------------------------------------------------------------------
echo "[upgrade] 第 5 步：验证 ..."
docker compose ps
echo "[upgrade] 请执行冒烟用例（登录/发消息/上传/编辑/委派审计），并观察 SLO 24h（§6.6 错误预算）。"

# 成功：写回 .env（记录新 TAG 与上一 TAG 供 rollback.sh）
if grep -q '^BBW_PREVIOUS_TAG=' .env; then
  sed -i.bak "s/^BBW_PREVIOUS_TAG=.*/BBW_PREVIOUS_TAG=${OLD_TAG}/" .env
else
  printf '\n# 由 upgrade.sh 自动维护（rollback.sh 使用）\nBBW_PREVIOUS_TAG=%s\n' "$OLD_TAG" >> .env
fi
sed -i.bak "s/^BBW_IMAGE_TAG=.*/BBW_IMAGE_TAG=${NEW_TAG}/" .env
rm -f .env.bak
echo "[upgrade] ✔ 升级完成：${OLD_TAG} → ${NEW_TAG}（已记 BBW_PREVIOUS_TAG=${OLD_TAG}）"
