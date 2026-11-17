#!/usr/bin/env bash
# =============================================================================
# BaobaoChat frp 实验台自签证书生成（根 CA + 服务端叶证书，SAN 参数化）
# 用法：./gen-cert.sh <SAN> [<SAN>...]
#   SAN = frp/樱花frp 隧道入口的 IP 或域名（客户端实际连接的那个地址）
#   例：./gen-cert.sh 203.0.113.10
#       ./gen-cert.sh 203.0.113.10 node.example.com
# 已有 CA 则复用（换节点重跑时，两台测试机无需重装根证书）。
# 产物（certs/ 不入 git）：
#   ca.{key,crt}     根 CA → 安装到两台测试机系统信任库（见 README §路径B）
#   server.{key,crt} nginx 挂载的叶证书（SAN=隧道入口）
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# Git Bash(msys) 会把 -subj "/CN=..." 误当 POSIX 路径转换成 Windows 路径，关掉参数转换；
# Linux 上该环境变量无副作用。
export MSYS2_ARG_CONV_EXCL="*"

[ $# -ge 1 ] || { echo "用法: $0 <节点IP或域名> [更多SAN...]" >&2; exit 1; }

# SAN 列表：纯 IPv4 → IP:N，其余 → DNS:N
san=""
for entry in "$@"; do
  if [[ "$entry" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    san+="${san:+,}IP:${entry}"
  else
    san+="${san:+,}DNS:${entry}"
  fi
done

mkdir -p certs

# 1) 根 CA（10 年；客户端信任/pin 的就是它；已存在则复用）
if [ ! -f certs/ca.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout certs/ca.key -out certs/ca.crt \
    -subj "/CN=bbc-frp-lab-CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
fi

# 2) 服务端叶证书（825 天，SAN=隧道入口）
openssl req -newkey rsa:2048 -nodes \
  -keyout certs/server.key -out certs/server.csr \
  -subj "/CN=bbc-frp-entry"
cat > certs/san.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${san}
EOF
openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -days 825 -out certs/server.crt -extfile certs/san.ext
rm -f certs/server.csr certs/san.ext

chmod 600 certs/ca.key certs/server.key

echo
echo "✔ 证书就绪：certs/server.crt（SAN: ${san}）"
echo "  两台测试机安装根 CA（README §路径B 有完整命令）："
echo "    Windows(管理员): certutil -addstore -f Root certs\\ca.crt"
echo "    macOS:           sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/ca.crt"
