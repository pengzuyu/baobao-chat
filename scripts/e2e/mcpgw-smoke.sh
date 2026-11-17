#!/usr/bin/env bash
# MCP 网关冒烟（D14 §6 联调通道）：
#   bbc-server(内存模式) ← curl 扮演 MCP client
# 用法：bash scripts/e2e/mcpgw-smoke.sh   （需 go build 可用）
# 预期：mcpgw 握手/发现 6 工具/kb_query 可调。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${BBC_PORT:-18098}"
TMP="$(mktemp -d /tmp/bbc-mcpgw.XXXXXX)"

# ① 服务端（内存模式 + 演示账号）
(cd "$ROOT/server" && go build -o "$TMP/bbc-server" ./cmd/bbc-server)
BBC_HTTP_ADDR="127.0.0.1:$PORT" \
BBC_JWT_SECRET="smoke-secret-0123456789abcdef0123456789" \
BBC_SEED_DEMO=1 \
  "$TMP/bbc-server" > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; rm -rf "$TMP"' EXIT
sleep 1.5

B="http://127.0.0.1:$PORT"
TOKEN=$(curl -s -X POST "$B/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"account":"alice","password":"demo-pass-123"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["access_token"])')

# ② MCP 网关：initialize → tools/list（6 工具）→ kb_query
MCP="$B/mcp/corp"
mcpcall() { curl -s -X POST "$MCP" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "$1"; }

echo "=== mcpgw initialize ==="
mcpcall '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];assert r["serverInfo"]["name"]=="bbc-corp",r;print("server:",r["serverInfo"]["name"],r["protocolVersion"])'

echo "=== mcpgw tools/list（应 5 工具：file_upload/im_send/kb_query/mail_read/mail_send）==="
mcpcall '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | python3 -c 'import sys,json;ts=[t["name"] for t in json.load(sys.stdin)["result"]["tools"]];assert set(ts)=={"kb_query","im_send","file_upload","mail_read","mail_send"},ts;print("tools:",",".join(sorted(ts)))'

echo "=== mcpgw kb_query（空库正常回包）==="
mcpcall '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"架构","top_k":3},"_meta":{"bbcAct":"agent:smoke"}}}' \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];assert r["isError"] is False and "items" in r["content"][0]["text"],r;print("kb_query ok（空库 items=[]）")'

echo "=== 审计日志尾部 ==="
grep -E '\[mcpgw\]' "$TMP/server.log" | tail -4
echo "SMOKE PASS"
