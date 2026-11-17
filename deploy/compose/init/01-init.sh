#!/bin/sh
# =============================================================================
# BaobaoChat 首次初始化脚本（幂等，可重复执行）
# 对应设计：16 篇 §2.2 初始化工具 / §3.4 交付物结构；D02 §7 迁移规范
# 运行容器：postgres:16-alpine（app-init 服务，entrypoint 调用本脚本）
#  1. 等待 pg 就绪（pg_isready 轮询）
#  2. 尝试创建 pgvector/zhparser 扩展（官方镜像未预装则跳过并告警，13 篇）
#  3. schema 迁移：bbc-server 启动时内嵌应用（单基线 0001_init.sql，权威通道）
#  4. 引导内置平台管理员（只打印引导命令/提示，不在脚本中落密码，§5.3）
# =============================================================================
set -euo pipefail

PGHOST="${POSTGRES_HOST:-pg}"
PGPORT="${POSTGRES_PORT:-5432}"
PGUSER="${POSTGRES_USER:-bbc}"
PGDATABASE="${POSTGRES_DB:-bbc}"
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
# 3. 数据库 schema（2026-11-16 squash 收口：单一终态基线 0001_init.sql）
#    执行通道 = bbc-server 内嵌 Migrate（单通道权威，启动时自动应用并记
#    schema_migrations 版本；此前本脚本的 *.up.sql 字典序执行段已移除——
#    其 find 模式与实际文件命名不匹配，从未真正执行过）。本容器只负责
#    pg 就绪等待与扩展预装。
# ---------------------------------------------------------------------------
log "schema 迁移由 bbc-server 启动时内嵌应用（0001 终态基线），本容器不执行 SQL。"

# ---------------------------------------------------------------------------
# 4. 内置平台管理员引导（16 篇 §2.2）
#    主通道：Web 初始化向导——打开客户端自动进入向导页，填管理员工号/姓名/口令
#    即完成（向导仅在系统无任何用户时出现，建户即永久关闭）。
#    出于安全：脚本不直接建户；密码不由脚本落盘/落日志（§5.3 敏感配置红线）
# ---------------------------------------------------------------------------
log "--------------------------------------------------------------"
log "数据库初始化完成。打开客户端（https://<BBC_PUBLIC_DOMAIN>）即进入初始化"
log "向导：填写管理员工号/姓名/口令即完成引导并自动登录（仅首次可用）。"
log "兜底通道（向导不可用时）："
log "  docker compose --profile core exec app bbc-server admin bootstrap \\"
log "      --admin-password <强密码或走 KMS 注入>"
if [ -n "${BBC_ADMIN_BOOTSTRAP_PASSWORD:-}" ]; then
  log "（检测到 BBC_ADMIN_BOOTSTRAP_PASSWORD 非空：请立即改用交互式引导并在 .env 中清空该值）"
fi
log "然后访问 Web 管理台（https://<BBC_PUBLIC_DOMAIN>）完成租户初始化（12 篇）。"
log "--------------------------------------------------------------"
