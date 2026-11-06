#!/usr/bin/env bash
# Agent Runtime ↔ AI 网关互通冒烟（docs/19 联调通道）：
#   bbw-server(mock echo 供应商 + 开发令牌) ← bbrt(stdio 协议脚本)
# 用法：bash scripts/e2e/agent-interop.sh   （需先 cargo build -p bbrt 与 go build）
# 预期：事件分布含 tool.call/tool.result/stream.delta，工具摘要含文件内容。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${BBW_PORT:-18090}"
TMP="$(mktemp -d /tmp/bbrt-interop.XXXXXX)"
TOKEN="interop-tok"

echo "hello from interop" > "$TMP/foo.txt"

# ① 服务端（内存模式 + 网关开发令牌）
(cd "$ROOT/server" && go build -o "$TMP/bbw-server" ./cmd/bbw-server)
BBW_HTTP_ADDR=":$PORT" BBW_AIGW_DEV_TOKEN="$TOKEN" BBW_SEED_DEMO=1 \
  "$TMP/bbw-server" > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1.5

# ② Runtime 输入脚本（握手→会话→读文件→结束）
python3 - "$TMP" <<'PY' > "$TMP/input.jsonl"
import json, sys
tmp = sys.argv[1]
def env(i, t, **p): return json.dumps({"v":1,"id":f"h-{i}","type":t,"payload":p}, ensure_ascii=False)
print(env(1,"initialize",**{"protocolVersion":1,"capabilities":["session"],"dataDir":tmp}))
print(env(2,"session.start",**{"sessionId":"sess-interop","workspace":tmp,"mode":"ask","modelPolicy":"strong","skills":[]}))
print(env(3,"user.message",**{"sessionId":"sess-interop","text":"读一下 foo.txt","attachments":[]}))
print(env(4,"session.end",**{"sessionId":"sess-interop","reason":"normal"}))
PY

# ③ 驱动 bbrt（stdin 保持打开等 turn 收尾）
(cd "$TMP" && BBW_RT_DATA_DIR="$TMP" BBW_RT_GATEWAY="http://127.0.0.1:$PORT" BBW_RT_TOKEN="$TOKEN" \
  "$ROOT/agent/target/debug/bbrt" < <(cat input.jsonl; sleep 5) > out.jsonl 2> err.txt) || true

echo "=== 事件分布 ==="
grep -o '"type":"[a-z.]*"' "$TMP/out.jsonl" | sort | uniq -c | sort -rn
echo "=== 工具结果 ==="
grep -o '"summary":"[^"]*"' "$TMP/out.jsonl" | head -1
echo "=== 日报产物 ==="
ls "$TMP/agent/reports/" 2>/dev/null || echo "(无)"

# 断言核心链路
grep -q '"type":"tool.call"' "$TMP/out.jsonl" && \
grep -q '"type":"tool.result"' "$TMP/out.jsonl" && \
grep -q 'hello from interop' "$TMP/out.jsonl" && \
grep -q '"type":"report.daily"' "$TMP/out.jsonl" && \
  echo "✅ 互通冒烟通过" || { echo "❌ 互通失败，详见 $TMP"; exit 1; }
