#!/usr/bin/env bash
# =============================================================================
# BaobaoChat 恢复脚本——compose 单机实现（16 篇 §4.6 恢复流程）
# 用法：./restore.sh [pg dump 文件路径]   （缺省取 BACKUP_DIR 下最新一份）
# 恢复流程（§4.6）：停应用 → 恢复库 → 校验 → 重启 → 冒烟
#  · 本脚本实现“逻辑备份恢复”（pg_dump/pg_restore 通道，适用误操作/小灾难）
#  · PITR（基础备份 + WAL 前滚至目标时点）为演练级流程，见文件尾注释；
#    RTO 目标 ≤30 min、RPO ≤5 min（以季度演练实测为准）
#  · 恢复完成后必须：RLS/审计链校验（15 篇 §4.2）→ 应用冒烟 → 再切流
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

fail() { echo "[restore] ✘ $*" >&2; exit 1; }

[ -f .env ] || fail "缺少 .env（先执行 cp .env.tpl .env）"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

BACKUP_DIR="${BACKUP_DIR:-./volumes/backup}"
PGUSER_="${POSTGRES_USER:-bbc}"
PGDATABASE_="${POSTGRES_DB:-bbc}"

# 定位 dump 文件
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP=$(ls -1t "${BACKUP_DIR}"/pg-*.dump 2>/dev/null | head -n 1 || true)
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || fail "未找到可用的 pg dump 文件（${BACKUP_DIR}/pg-*.dump）"
echo "[restore] 恢复源：${DUMP}"

echo "[restore] ⚠ 恢复将用备份覆盖当前数据库 ${PGDATABASE_}（当前数据将改名保留为 ${PGDATABASE_}_pre_restore）"
read -r -p "确认继续？输入 YES: " CONFIRM
[ "$CONFIRM" = "YES" ] || fail "未确认，退出"

# ---------------------------------------------------------------------------
# 1. 停应用流量（nginx-lb + app；media 视站点配置一并停止）
# ---------------------------------------------------------------------------
echo "[restore] 1/5 停止应用（保留 pg/redis/rustfs）..."
docker compose stop nginx-lb app >/dev/null 2>&1 || true
docker compose stop media >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 2. 恢复到临时库并校验
# ---------------------------------------------------------------------------
echo "[restore] 2/5 恢复到临时库 ${PGDATABASE_}_restore ..."
docker compose exec -T pg psql -U "$PGUSER_" -d postgres -qtc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${PGDATABASE_}', '${PGDATABASE_}_restore') AND pid <> pg_backend_pid();" >/dev/null
docker compose exec -T pg psql -U "$PGUSER_" -d postgres -qc "DROP DATABASE IF EXISTS ${PGDATABASE_}_restore;"
docker compose exec -T pg psql -U "$PGUSER_" -d postgres -qc "CREATE DATABASE ${PGDATABASE_}_restore;"
docker compose exec -T pg pg_restore -U "$PGUSER_" -d "${PGDATABASE_}_restore" --no-owner < "$DUMP" \
  || fail "pg_restore 失败（dump 损坏或版本不兼容；检查备份文件）"

TABLES=$(docker compose exec -T pg psql -U "$PGUSER_" -d "${PGDATABASE_}_restore" -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public';" | tr -d '[:space:]')
echo "[restore] ✔ 临时库表数量：${TABLES}（为 0 视为异常）"
[ "${TABLES:-0}" -gt 0 ] || fail "恢复后 public schema 无表，中止"

# ---------------------------------------------------------------------------
# 3. 原库改名保留 + 切换
# ---------------------------------------------------------------------------
echo "[restore] 3/5 切换数据库（原库保留为 ${PGDATABASE_}_pre_restore）..."
docker compose exec -T pg psql -U "$PGUSER_" -d postgres -qc "DROP DATABASE IF EXISTS ${PGDATABASE_}_pre_restore;"
docker compose exec -T pg psql -U "$PGUSER_" -d postgres -qc "ALTER DATABASE ${PGDATABASE_} RENAME TO ${PGDATABASE_}_pre_restore;"
docker compose exec -T pg psql -U "$PGUSER_" -d postgres -qc "ALTER DATABASE ${PGDATABASE_}_restore RENAME TO ${PGDATABASE_};"

# ---------------------------------------------------------------------------
# 4. 重启应用
# ---------------------------------------------------------------------------
echo "[restore] 4/5 重启应用 ..."
docker compose up -d app
if docker compose config --services | grep -q '^media$'; then docker compose up -d media; fi
docker compose up -d nginx-lb

# ---------------------------------------------------------------------------
# 5. 校验与收尾（§4.6：RLS/审计链校验 → 冒烟 → 切流）
# ---------------------------------------------------------------------------
echo "[restore] 5/5 校验 ..."
echo "[restore] 必做校验清单："
echo "  ① RLS 与审计哈希链校验（15 篇 §4.2：chain.verify.failures 应为 0）"
echo "  ② 应用冒烟：登录 / 发消息 / 上传 / 文档编辑 / Agent 委派审计"
echo "  ③ 观察通过后再开放客户端流量（切流），并记录本次 RTO 实测值"
echo "[restore] ✔ 恢复完成。确认无误后可清理：DROP DATABASE ${PGDATABASE_}_pre_restore;"

cat <<'PITR'
------------------------------------------------------------------
PITR（时点恢复）流程提示——compose 占位实现（§4.6 目标 RPO≤5min）：
  1) 停止应用与 pg；清空 pg-data 卷
  2) 用 pg-wal-archive 卷 base/<ts>/ 基础备份恢复数据目录
     （restore_command = cp /wal_archive/wal/%f %p）
  3) 创建 recovery_target_time（恢复至目标时点）并启动 pg 前滚
  4) 前滚完成后执行上述校验清单
  ★ 生产环境建议直接采用 pgBackRest/WAL-G（对象存储 bbc-backup 桶，
    独立凭据、WORM 30 天），并纳入季度演练清单①实测 RTO/RPO
------------------------------------------------------------------
PITR
