#!/usr/bin/env bash
# =============================================================================
# BaobaoChat 备份脚本——compose 单机实现（16 篇 §4.6 备份与恢复）
# 内容：
#  1 磁盘水位预检（§6.5：>80% 告警 / >85% 阻断）
#  2 PG 逻辑备份：pg_dump -Fc（小规模快速恢复通道）
#  3 WAL 归档确认：pg_switch_wal 强制切换并确认归档目录增长（RPO≤5min 前提）
#  4 PG 基础备份占位：pg_basebackup 物理全量（PITR 基线）
#    ★ 生产替换为 pgBackRest / WAL-G → 对象存储 bbw-backup 桶（独立凭据、
#      不可删除 30 天，§4.6）；本脚本为占位实现
#  5 配置与密钥备份：.env + TLS 证书 tar 打包（0600；
#    ★ 生产应 KMS 信封加密、KEK 双人分持，15 篇 §3.3）
#  6 保留策略：pg dump 保留最近 7 份
# 用法：./backup.sh [BACKUP_DIR=... 可用环境变量覆盖]
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

fail() { echo "[backup] ✘ $*" >&2; exit 1; }

[ -f .env ] || fail "缺少 .env（先执行 cp .env.tpl .env）"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

BACKUP_DIR="${BACKUP_DIR:-./volumes/backup}"
TS="$(date +%Y%m%d-%H%M%S)"
PGUSER_="${POSTGRES_USER:-bbw}"
PGDATABASE_="${POSTGRES_DB:-bbw}"
KEEP_DUMPS="${BBW_BACKUP_KEEP:-7}"

mkdir -p "$BACKUP_DIR"

# ---------------------------------------------------------------------------
# 1. 磁盘水位预检
# ---------------------------------------------------------------------------
USAGE_PCT=$(df -P . | awk 'NR==2 {gsub("%","",$5); print $5}')
[ "$USAGE_PCT" -lt 85 ] || fail "磁盘水位 ${USAGE_PCT}% ≥ 85%，备份中止（§4.8 归档/扩容后重试）"
[ "$USAGE_PCT" -lt 80 ] || echo "[backup] ⚠ 磁盘水位 ${USAGE_PCT}% ≥ 80%（P2 告警阈，§6.5）"

# ---------------------------------------------------------------------------
# 2. PG 逻辑备份（pg_dump -Fc，自定义压缩格式）
# ---------------------------------------------------------------------------
echo "[backup] 2/6 pg_dump 逻辑备份 → ${BACKUP_DIR}/pg-${TS}.dump ..."
docker compose exec -T pg pg_dump -U "$PGUSER_" -d "$PGDATABASE_" -Fc \
  > "${BACKUP_DIR}/pg-${TS}.dump" \
  || fail "pg_dump 失败（检查 pg 容器健康与磁盘空间）"

# ---------------------------------------------------------------------------
# 3. WAL 归档确认（RPO ≤ 5 min 的前提，§4.6）
# ---------------------------------------------------------------------------
echo "[backup] 3/6 WAL 归档确认 ..."
WAL_BEFORE=$(docker compose exec -T pg sh -c 'ls /wal_archive/wal 2>/dev/null | wc -l' | tr -d '[:space:]')
docker compose exec -T pg psql -U "$PGUSER_" -d postgres -qtc 'SELECT pg_switch_wal();' >/dev/null
sleep 3
WAL_AFTER=$(docker compose exec -T pg sh -c 'ls /wal_archive/wal 2>/dev/null | wc -l' | tr -d '[:space:]')
if [ "${WAL_AFTER:-0}" -gt "${WAL_BEFORE:-0}" ]; then
  echo "[backup] ✔ WAL 归档正常（${WAL_BEFORE} → ${WAL_AFTER} 段）"
else
  fail "WAL 归档未增长：archive_command 异常（备份不完整，禁止继续升级流程，§4.4 预检）"
fi

# ---------------------------------------------------------------------------
# 4. PG 基础备份占位（PITR 基线；生产换 pgBackRest/WAL-G，见文件头注释）
# ---------------------------------------------------------------------------
echo "[backup] 4/6 pg_basebackup 物理基础备份（占位实现）..."
docker compose exec -T pg sh -c "rm -rf /wal_archive/base/${TS} && pg_basebackup -U ${PGUSER_} -D /wal_archive/base/${TS} -Fp -Xs" \
  || fail "pg_basebackup 失败（确认 wal_level=replica 且磁盘充足）"
echo "[backup] ✔ 基础备份：pg-wal-archive 卷 base/${TS}/（含 pg_wal）"

# ---------------------------------------------------------------------------
# 5. 配置与密钥备份（★ 生产 KMS 加密，15 篇 §3.3）
# ---------------------------------------------------------------------------
echo "[backup] 5/6 配置与证书备份 ..."
umask 077
tar -czf "${BACKUP_DIR}/conf-${TS}.tar.gz" .env volumes/certs 2>/dev/null \
  || tar -czf "${BACKUP_DIR}/conf-${TS}.tar.gz" .env \
  || fail "配置打包失败"
echo "[backup] ✔ conf-${TS}.tar.gz（权限 0600；含 .env 与 TLS 证书——妥善离线保管）"

# ---------------------------------------------------------------------------
# 6. 保留策略：dump 保留最近 N 份（§4.6“不可删除 30 天”由对象存储桶策略兜底）
# ---------------------------------------------------------------------------
ls -1t "${BACKUP_DIR}"/pg-*.dump 2>/dev/null | tail -n +$((KEEP_DUMPS + 1)) | while IFS= read -r f; do
  rm -f "$f" && echo "[backup] 清理过期 dump：$(basename "$f")"
done

echo "[backup] ✔ 备份完成：${BACKUP_DIR}（${TS}）"
echo "[backup] 提醒：季度演练需实测 PITR 恢复到隔离环境并记录 RTO/RPO（§4.6 清单①）。"
