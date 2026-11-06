#!/bin/sh
# =============================================================================
# BaobaoWork 首次初始化脚本（幂等，可重复执行）
# 对应设计：16 篇 §2.2 初始化工具 / §3.4 交付物结构；D02 §7 迁移规范
# 运行容器：postgres:16-alpine（app-init 服务，entrypoint 调用本脚本）
#  1. 等待 pg 就绪（pg_isready 轮询）
#  2. 幂等创建只读角色占位 + 按序执行 /migrations/**/*.up.sql（生产通道为
#     `bbw-app migrate`，同镜像 golang-migrate；本脚本为免依赖的兜底实现，
#     手工维护 schema_migrations 表）
#  3. 尝试创建 pgvector/zhparser 扩展（官方镜像未预装则跳过并告警，13 篇）
#  4. 引导内置平台管理员（只打印引导命令/提示，不在脚本中落密码，§5.3）
# =============================================================================
set -euo pipefail

PGHOST="${POSTGRES_HOST:-pg}"
PGPORT="${POSTGRES_PORT:-5432}"
PGUSER="${POSTGRES_USER:-bbw}"
PGDATABASE="${POSTGRES_DB:-bbw}"
export PGHOST PGPORT PGUSER PGDATABASE
# psql 免交互：密码经环境注入（compose 已隔离；不入日志）
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD 未设置}"

log() { echo "[app-init] $*"; }

# ---------------------------------------------------------------------------
# 1. 等待 pg 就绪（最长 ~120s）
# ---------------------------------------------------------------------------
log "等待 PostgreSQL 就绪：${PGHOST}:${PGPORT}/${PGDATABASE} ..."
i=0
until pg_isready -q -t 3; do
  i=$((i + 1))
  if [ "$i" -ge 40 ]; then
    log "错误：PostgreSQL 等待超时（~120s），初始化中止。"
    exit 1
  fi
  sleep 3
done
log "PostgreSQL 已就绪。"

# ---------------------------------------------------------------------------
# 2. 扩展（幂等）：pgvector / zhparser；官方镜像未预装时仅告警不阻断
# ---------------------------------------------------------------------------
log "尝试创建扩展（pgvector / zhparser）..."
psql -v ON_ERROR_STOP=0 -q <<'SQL' || true
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;
SQL
log "扩展检查完成（若上方报错：官方 postgres 镜像未预装，请按 13 篇自建镜像后重跑）。"

# ---------------------------------------------------------------------------
# 3. 依序执行 /migrations/**/*.up.sql（golang-migrate 命名：<域>/NNN_desc.up.sql）
#    已应用的版本记入 schema_migrations，重复执行自动跳过（幂等）
# ---------------------------------------------------------------------------
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
if [ -d "$MIGRATIONS_DIR" ] && [ -n "$(find "$MIGRATIONS_DIR" -name '*.up.sql' -print -quit 2>/dev/null)" ]; then
  log "发现迁移目录：${MIGRATIONS_DIR}，开始应用（顺序 = 路径字典序）..."
  psql -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version BIGINT PRIMARY KEY,
  name    TEXT NOT NULL DEFAULT '',
  dirty   BOOLEAN NOT NULL DEFAULT FALSE
);
SQL
  find "$MIGRATIONS_DIR" -name '*.up.sql' -type f | LC_ALL=C sort | while IFS= read -r file; do
    base=$(basename "$file" .up.sql)
    # 版本号 = 文件名前缀 NNN（golang-migrate 约定）
    version=$(echo "$base" | cut -d_ -f1 | sed 's/^0*//')
    case "$version" in
      ''|*[!0-9]*) log "跳过无法解析版本号的文件：$file"; continue ;;
    esac
    applied=$(psql -tA -q -c "SELECT count(*) FROM schema_migrations WHERE version = ${version}")
    if [ "$applied" != "0" ]; then
      log "已应用，跳过：${base} (v${version})"
      continue
    fi
    log "应用迁移：${file##*/} (v${version}) ..."
    psql -q -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations(version, name, dirty) VALUES (${version}, '${base}', TRUE)" >/dev/null
    if psql -q -v ON_ERROR_STOP=1 -f "$file"; then
      psql -q -v ON_ERROR_STOP=1 -c "UPDATE schema_migrations SET dirty = FALSE WHERE version = ${version}" >/dev/null
      log "完成：${base}"
    else
      log "错误：迁移失败（v${version}），schema_migrations 标记为 dirty。"
      log "修复后删除该行再重跑，或改用 bbw-app migrate（§3.4 正式通道）。"
      exit 1
    fi
  done
  log "迁移应用完毕。"
else
  log "未发现迁移文件（${MIGRATIONS_DIR} 为空或不存在，server/ 尚未落地时属预期）。"
  psql -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', dirty BOOLEAN NOT NULL DEFAULT FALSE)"
fi

# ---------------------------------------------------------------------------
# 4. 内置平台管理员引导（16 篇 §2.2）
#    出于安全：脚本不直接建户；密码不由脚本落盘/落日志（§5.3 敏感配置红线）
# ---------------------------------------------------------------------------
log "--------------------------------------------------------------"
log "数据库初始化完成。接下来请引导内置平台管理员（一次性操作）："
log "  docker compose --profile core exec app bbw-server admin bootstrap \\"
log "      --admin-password <强密码或走 KMS 注入>"
if [ -n "${BBW_ADMIN_BOOTSTRAP_PASSWORD:-}" ]; then
  log "（检测到 BBW_ADMIN_BOOTSTRAP_PASSWORD 非空：请立即改用交互式引导并在 .env 中清空该值）"
fi
log "然后访问 Web 管理台（https://<BBW_PUBLIC_DOMAIN>）完成租户初始化（12 篇）。"
log "--------------------------------------------------------------"
