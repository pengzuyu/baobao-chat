#!/usr/bin/env bash
# MCP 网关 + 机器人域冒烟（D14 §6 / 20 篇阶段一联调通道）：
#   bbw-server(内存模式) ← curl 扮演 MCP client 与外部 webhook 调用方
# 用法：bash scripts/e2e/mcpgw-bot-smoke.sh   （需 go build 可用）
# 预期：mcpgw 握手/发现 4 工具/kb_query 可调；bot 建档/装凭证/坏签名 3030/
#   好签名未装会话 3031（正向投递路径由 internal/bot 单测与 handlers 测试覆盖）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${BBW_PORT:-18098}"
TMP="$(mktemp -d /tmp/bbw-mcpgw-bot.XXXXXX)"

# ① 服务端（内存模式 + 演示账号）
(cd "$ROOT/server" && go build -o "$TMP/bbw-server" ./cmd/bbw-server)
BBW_HTTP_ADDR="127.0.0.1:$PORT" \
BBW_JWT_SECRET="smoke-secret-0123456789abcdef0123456789" \
BBW_SEED_DEMO=1 \
  "$TMP/bbw-server" > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; rm -rf "$TMP"' EXIT
sleep 1.5

B="http://127.0.0.1:$PORT"
TOKEN=$(curl -s -X POST "$B/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"account":"alice","password":"demo-pass-123"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["access_token"])')

# ② MCP 网关：initialize → tools/list（4 工具）→ kb_query
MCP="$B/mcp/corp"
mcpcall() { curl -s -X POST "$MCP" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "$1"; }

echo "=== mcpgw initialize ==="
mcpcall '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];assert r["serverInfo"]["name"]=="bbw-corp",r;print("server:",r["serverInfo"]["name"],r["protocolVersion"])'

echo "=== mcpgw tools/list（应 4 工具：kb_query/doc_read/im_send/file_upload）==="
mcpcall '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | python3 -c 'import sys,json;ts=[t["name"] for t in json.load(sys.stdin)["result"]["tools"]];assert set(ts)=={"kb_query","doc_read","im_send","file_upload"},ts;print("tools:",",".join(sorted(ts)))'

echo "=== mcpgw kb_query（空库正常回包）==="
mcpcall '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"架构","top_k":3},"_meta":{"bbwAct":"agent:smoke"}}}' \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];assert r["isError"] is False and "items" in r["content"][0]["text"],r;print("kb_query ok（空库 items=[]）")'

# ③ 机器人域：建档 → 启用 → 装凭证 → 坏签名 3030 → 好签名未装会话 3031
echo "=== bot 建档（建即停用）+ 启用 + 装 webhook ==="
curl -s -X POST "$B/api/v1/bots" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"CI 助手","description":"冒烟"}' | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];assert d["status"]==2,d;print("bot id:",d["id"],"status:disabled(建即停用)")'
curl -s -X POST "$B/api/v1/bots/101/enable" -H "Authorization: Bearer $TOKEN" >/dev/null
HOOK_JSON=$(curl -s -X POST "$B/api/v1/bots/101/webhooks" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"default_conv_id":1}')
echo "$HOOK_JSON" > "$TMP/hook.json"
HOOK_ID=$(python3 -c 'import json;print(json.load(open("'"$TMP"'/hook.json"))["data"]["secret"]["hook_id"])')
SECRET=$(python3 -c 'import json;print(json.load(open("'"$TMP"'/hook.json"))["data"]["secret"]["secret"])')
echo "hook: ${HOOK_ID:0:12}…（secret 已取，库外零留存校验由单测覆盖）"

BODY='{"msg_type":"text","text":"pipeline done"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')

echo "=== bot 坏签名（应 3030）==="
curl -s -X POST "$B/hook/bot/$HOOK_ID" -H "X-BBW-Timestamp: $TS" \
  -H "X-BBW-Signature: sha256=0000000000000000000000000000000000000000000000000000000000000000" \
  -H 'Content-Type: application/json' -d "$BODY" \
  | python3 -c 'import sys,json;assert json.load(sys.stdin)["code"]==3030;print("3030 ok")'

echo "=== bot 好签名未装会话（应 3031；正向投递由 internal/bot 测试覆盖）==="
curl -s -X POST "$B/hook/bot/$HOOK_ID" -H "X-BBW-Timestamp: $TS" \
  -H "X-BBW-Signature: sha256=$SIG" -H 'Content-Type: application/json' -d "$BODY" \
  | python3 -c 'import sys,json;assert json.load(sys.stdin)["code"]==3031;print("3031 ok")'

echo "=== 审计日志尾部 ==="
grep -E '\[mcpgw\]|\[bot\]' "$TMP/server.log" | tail -4
echo "SMOKE PASS"
