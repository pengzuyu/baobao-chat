#!/bin/sh
# 本地盘 → 对象存储一次性迁移（D25 §6；file 表零改——sha 内容键不变；D29 载体 mc→aws-cli）。
# 源布局 {SRC}/files/{tenant}/{sha前2}/{sha} → 目标 bbw-data 桶 t/{tenant}/{sha前2}/{sha}。
# 幂等：aws s3 sync 按 size 比对，已迁对象跳过；可重复执行/断点续跑。
#
# 用法：./migrate-files-to-s3.sh [源目录]
#   源目录默认 ./volumes/files-src——先把宿主上的旧 data/files 目录（或 bbw-data 卷导出）
#   拷到该处（只读挂载进 aws-cli 容器）。
# 前提：compose 栈已起（rustfs 健康）、.env 的 BBW_S3_* 与 bbw-data 桶已初始化。
set -eu
CD=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$CD/volumes/files-src}
[ -d "$SRC/files" ] || { echo "用法: $0 [源目录]（需含 files/{tenant}/…，默认 volumes/files-src）"; exit 1; }

echo "[migrate] 源：$SRC/files → s3://bbw-data/t/*"
docker compose -f "$CD/docker-compose.yml" --env-file "$CD/.env" run --rm \
  --entrypoint /bin/sh -v "$SRC/files:/src:ro" -e AWS_ENDPOINT_URL=http://rustfs:9000 rustfs-init -c '
    set -eu
    total=0
    for t in $(ls /src); do
      [ -d "/src/$t" ] || continue
      n=$(aws s3 sync --size-only "/src/$t" "s3://bbw-data/t/$t" | tee /dev/stderr | wc -l)
      total=$((total + n))
      echo "[migrate] 租户 $t：本次搬运 $n 个对象"
    done
    echo "[migrate] 完成（sync 幂等，重复执行只补差异）"
  '
echo "[migrate] 提醒：缩略变体无需迁移（服务端票据期惰性生成，D25 §5）"
