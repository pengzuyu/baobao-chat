#!/usr/bin/env bash
# =============================================================================
# gen-oidc-key.sh —— OIDC Provider 签名密钥生成（2026-11-23）
#
# 什么时候需要：要让**生态应用/第三方系统用 BaobaoChat 账号登录**时
# （BaobaoChat 作为 OIDC 身份提供方 IdP）。纯内部使用（聊天/Agent/文件）不需要。
#
# 输出：可直接追加进 deploy/compose/.env 的两行（含说明注释）
#   BBC_OIDC_SIGNING_KEY=<base64 包裹的 P-256 私钥 PEM 单行>
#   BBC_OIDC_ISSUER=<对外地址>            ← 需你按实际访问地址改
#
# 用法：
#   bash scripts/release/gen-oidc-key.sh                # 打印到终端（复制进 .env）
#   bash scripts/release/gen-oidc-key.sh >> compose/.env # 直接追加
#
# 说明：
# - 私钥 = ES256 签 token 用；JWKS 公钥端点自动暴露，生态应用验签用
# - 轮换：换本行值 + 重启 app；已签发 token ≤15 分钟内自然失效，应用重拉 JWKS 自动恢复
# - 多行 PEM 塞不进 .env，故产 base64 单行（服务端 loadSigningKey 自动识别解码）
# - K8s 形态：把同一串填进 values 的 secrets.oidcSigningKey，issuer 填 config.oidcIssuer
# =============================================================================
set -euo pipefail

command -v openssl >/dev/null || { echo "[gen-oidc-key] 缺 openssl" >&2; exit 1; }

KEY=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null \
      | base64 | tr -d '\r\n')

[ -n "$KEY" ] || { echo "[gen-oidc-key] 私钥生成失败" >&2; exit 1; }

cat <<EOF
# ---- OIDC Provider 签名密钥（$(date +%F) 生成）----
# 用途：生态应用用 BaobaoChat 账号登录（IdP 签 token 的私钥；base64 包裹 PEM 单行）
# 轮换=换本值并重启 app：已签 token ≤15min 内失效，生态应用重拉 JWKS 自动恢复
BBC_OIDC_SIGNING_KEY=${KEY}
# 对外 issuer（生态应用填的授权地址，= 客户端访问 BaobaoChat 的入口地址，末尾不带斜杠）
# compose 例：BBC_PUBLIC_DOMAIN 同值；K8s 例：http://<NODE_IP>:30808
BBC_OIDC_ISSUER=CHANGE_ME
EOF