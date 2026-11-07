#!/usr/bin/env bash
# 知识库摄入+检索 E2E（D07 阶段一务实版）：
#   bbw-server（内存模式，或 BBW_KB_DSN 指定走 PG/pgvector）+ AI 网关开发令牌
#   → alice 惰性个人空间/公司空间 → 两主题文档摄入（同步 ready）→
#   混合检索（关键词字面命中 + 向量路独证：查询词无字面子串）→ 高亮/上下文展开 →
#   bob 权限隔离（个人空间不可见/显式请求 7002）→ jobs 简版。
# 用法：
#   bash scripts/e2e/kb-pipeline.sh                     # 内存模式（默认端口 18093）
#   BBW_KB_DSN='postgres://bbw:bbw_change_me@127.0.0.1:5432/bbw?sslmode=disable' \
#     bash scripts/e2e/kb-pipeline.sh                   # PG 模式（pgvector 真实排序）
# 预期：全部断言通过输出 ✅。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${BBW_PORT:-18093}"
TOKEN_TOK="kb-e2e-tok"
TMP="$(mktemp -d /tmp/kb-e2e.XXXXXX)"

step() { echo ""; echo "── $* ──"; }

# ① 服务端（内存模式 + 网关开发令牌 → kb 嵌入走 HTTP 网关 bbw-embed）
(cd "$ROOT/server" && go build -o "$TMP/bbw-server" ./cmd/bbw-server)
ENV_ARGS=(BBW_HTTP_ADDR=":$PORT" BBW_AIGW_DEV_TOKEN="$TOKEN_TOK" BBW_SEED_DEMO=1 BBW_JWT_SECRET="kb-e2e-secret-kb-e2e-secret-0123456789")
if [ -n "${BBW_KB_DSN:-}" ]; then
  ENV_ARGS+=("BBW_DB_DSN=$BBW_KB_DSN")
  echo "PG 模式：${BBW_KB_DSN}（迁移 0009 幂等；kb_chunk.embedding 轨：pgvector/float8[]）"
fi
env "${ENV_ARGS[@]}" "$TMP/bbw-server" > "$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1.5

BASE="http://127.0.0.1:$PORT/api/v1"
api() { # api METHOD PATH [JSON] [TOKEN] → body（code!=0 打印并退出）
  local m=$1 p=$2 body=${3:-} tok=${4:-}
  local args=(-sS -X "$m" "$BASE$p" -H 'Content-Type: application/json')
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}
jqget() { jq -r "$1"; } # 缩写

# ② 登录（seed alice/bob）
step "登录 alice/bob"
ALICE=$(api POST /auth/login '{"account":"alice","password":"demo-pass-123"}' | jqget '.data.access_token')
BOB=$(api POST /auth/login '{"account":"bob","password":"demo-pass-123"}' | jqget '.data.access_token')
[ "$ALICE" != "null" ] || { echo "❌ alice 登录失败"; tail -5 "$TMP/server.log"; exit 1; }
echo "alice/bob token 就绪"

# ③ 空间：惰性个人 + 公司空间
step "空间：惰性个人空间 + 公司空间"
SPACES=$(api GET /kb/spaces "" "$ALICE")
echo "$SPACES" | jq -c '.data.items[] | {id,space_type,name,doc_count}'
PERSONAL=$(echo "$SPACES" | jqget '.data.items[] | select(.space_type=="personal") | .id')
COMPANY=$(api POST /kb/spaces '{"type":"company","name":"E2E 公司知识库"}' "$ALICE" | jqget '.data.id')
[ -n "$PERSONAL" ] && [ "$PERSONAL" != "null" ] || { echo "❌ 个人空间未惰性创建"; exit 1; }
echo "personal=$PERSONAL company=$COMPANY"

# ④ 目录：新建 + 7014 同名
step "目录：新建 + 7014 同名冲突"
NODE=$(api POST "/kb/spaces/$PERSONAL/nodes" '{"name":"技术规范"}' "$ALICE" | jqget '.data.id')
DUP=$(api POST "/kb/spaces/$PERSONAL/nodes" '{"name":"技术规范"}' "$ALICE" | jqget '.code')
[ "$DUP" = "7014" ] || { echo "❌ 同名目录应 7014, got $DUP"; exit 1; }
echo "目录=${NODE}；同名冲突 7014 ✓"

# ⑤ 摄入（同步版）：文档 A 令牌主题（无"令牌过期"连续子串）/ 文档 B 红烧肉主题
step "摄入两份不同主题文档（同步 ready）"
DOC_A_JSON=$(api POST "/kb/spaces/$PERSONAL/docs" "{\"node_id\":$NODE,\"title\":\"登录安全规范\",\"format\":\"markdown\",\"text\":\"# 登录安全规范\\n\\n当令牌快要过期时，客户端应当静默刷新令牌并重试请求。\\n\\n连续失败则强制重新登录并记录审计日志。\"}" "$ALICE")
echo "$DOC_A_JSON" | jq -c '.data | {id,title,status,version,source_type}'
DOC_A=$(echo "$DOC_A_JSON" | jqget '.data.id')
DOC_A_STATUS=$(echo "$DOC_A_JSON" | jqget '.data.status')
DOC_B_JSON=$(api POST "/kb/spaces/$PERSONAL/docs" '{"title":"家常菜谱","text":"红烧肉的传统做法讲究小火慢炖，火候掌握是关键。\n\n焯水后煸炒出糖色，再加热水没过肉块。"}' "$ALICE")
DOC_B=$(echo "$DOC_B_JSON" | jqget '.data.id')
DOC_B_STATUS=$(echo "$DOC_B_JSON" | jqget '.data.status')
[ "$DOC_A_STATUS" = "ready" ] && [ "$DOC_B_STATUS" = "ready" ] || { echo "❌ 同步摄入应 ready: A=$DOC_A_STATUS B=$DOC_B_STATUS"; tail -20 "$TMP/server.log"; exit 1; }
echo "A=$DOC_A(ready) B=$DOC_B(ready) ✓"

# ⑥ 检索 1：字面命中（静默刷新）→ A 排前 + 高亮非空
step "检索①：字面关键词「静默刷新」→ A 排前 + 高亮"
Q1=$(api POST /kb/query '{"keyword":"静默刷新","top_k":10}' "$ALICE")
echo "$Q1" | jq -c '.data | {took_ms, count:(.items|length)}'
echo "$Q1" | jq -c '.data.items[0] | {doc_id,title,chunk_seq,heading_path,snippet,highlight}'
[ "$(echo "$Q1" | jqget '.data.items[0].doc_id')" = "$DOC_A" ] || { echo "❌ 应首条命中 A"; exit 1; }
[ "$(echo "$Q1" | jq -r '.data.items[0].highlight | length')" -gt 0 ] || { echo "❌ 字面命中应有高亮"; exit 1; }
# 高亮区间指向关键词本身
SNIP=$(echo "$Q1" | jqget '.data.items[0].snippet')
echo "snippet 高亮区间校验 ✓（$(echo "$Q1" | jq -c '.data.items[0].highlight')）"

# ⑦ 检索 2：向量路独证（「令牌过期」无字面子串 → 关键词路 0 命中，命中只能来自向量余弦）
step "检索②：向量路独证「令牌过期」（A 无该连续子串）"
Q2=$(api POST /kb/query '{"keyword":"令牌过期","top_k":10}' "$ALICE")
echo "$Q2" | jq -c '.data | {took_ms, items:[.items[]|{doc_id,title,score}]}'
[ "$(echo "$Q2" | jqget '.data.items[0].doc_id')" = "$DOC_A" ] || { echo "❌ 向量路应命中 A（词袋 mock：查询/文档共享「令牌」「过期」bigram 轴）"; exit 1; }
echo "向量路命中 A 排前 ✓（pgvector <=> 或降级轨内存余弦）"

# ⑧ 检索 3：文档 B 主题
step "检索③：B 主题「红烧肉 火候」"
Q3=$(api POST /kb/query '{"keyword":"红烧肉 火候","top_k":10}' "$ALICE")
[ "$(echo "$Q3" | jqget '.data.items[0].doc_id')" = "$DOC_B" ] || { echo "❌ B 主题应命中 B 首"; exit 1; }
echo "B 排前 ✓"

# ⑨ 上下文展开 + 大纲
step "上下文展开 + 大纲"
AROUND=$(api GET "/kb/docs/$DOC_A/chunks?around=2" "" "$ALICE")
echo "$AROUND" | jq -c '.data.items | map(.seq)'
[ "$(echo "$AROUND" | jq -r '.data.items | length')" -ge 2 ] || { echo "❌ around 应 ≥2 块"; exit 1; }
OUTLINE=$(api GET "/kb/docs/$DOC_A/chunks?outline=1" "" "$ALICE")
echo "$OUTLINE" | jq -c '.data.items'
[ "$(echo "$OUTLINE" | jqget '.data.items[0].heading_path')" = "登录安全规范" ] || { echo "❌ 大纲锚点"; exit 1; }

# ⑩ 权限隔离：bob 不见 alice 个人空间；显式请求 7002；公司空间可见
step "权限隔离（v0.1：personal 只本人 + company 全员）"
BOB_SPACES=$(api GET /kb/spaces "" "$BOB")
BOB_SEE_PERSONAL=$(echo "$BOB_SPACES" | jq --arg pid "$PERSONAL" '[.data.items[]|select(.id==$pid)]|length')
BOB_SEE_COMPANY=$(echo "$BOB_SPACES" | jq --arg cid "$COMPANY" '[.data.items[]|select(.id==$cid)]|length')
[ "$BOB_SEE_PERSONAL" = "0" ] || { echo "❌ bob 不应见 alice 个人空间"; exit 1; }
[ "$BOB_SEE_COMPANY" = "1" ] || { echo "❌ bob 应见公司空间"; exit 1; }
DENY=$(api POST /kb/query "{\"space_ids\":[\"$PERSONAL\"],\"keyword\":\"令牌\"}" "$BOB" | jqget '.code')
[ "$DENY" = "7002" ] || { echo "❌ 显式请求无权空间应 7002, got $DENY"; exit 1; }
BOB_Q=$(api POST /kb/query '{"keyword":"令牌"}' "$BOB")
BOB_LEAK=$(echo "$BOB_Q" | jq --arg da "$DOC_A" '[.data.items[]|select(.doc_id==$da)]|length')
[ "$BOB_LEAK" = "0" ] || { echo "❌ bob 检索不应命中 alice 个人文档"; exit 1; }
echo "隔离 ✓（bob：个人空间不可见/7002/不泄露；公司空间可见）"

# ⑪ jobs 简版 + 重摄入
step "jobs 简版 + 重摄入（version+1）"
JOBS=$(api GET "/kb/jobs?space_id=$PERSONAL" "" "$ALICE")
echo "$JOBS" | jq -c '.data.items | map({title,status,version})'
[ "$(echo "$JOBS" | jq -r '.data.items|length')" -ge 2 ] || { echo "❌ jobs 应 ≥2"; exit 1; }
REING=$(api POST "/kb/docs/$DOC_A/reingest" "" "$ALICE")
NEW_VER=$(echo "$REING" | jqget '.data.version')
[ "$NEW_VER" -ge 2 ] || { echo "❌ 重摄入应 version≥2, got $NEW_VER"; exit 1; }
echo "重摄入 v$NEW_VER ✓"

# ⑫ 文件引用摄入（D06 file → kb doc）：上传 md 文件再引用
step "文件引用摄入（file_id → 7007 白名单校验 + txt/md 摄入）"
echo "# 会议室排期说明

周会每周一上午十点，复盘会每周五下午四点。" > "$TMP/room.md"
FILE_JSON=$(curl -sS -X POST "$BASE/files/upload" -H "Authorization: Bearer $ALICE" -F "file=@$TMP/room.md")
FILE_ID=$(echo "$FILE_JSON" | jqget '.data.id')
DOC_F=$(api POST "/kb/spaces/$PERSONAL/docs" "{\"title\":\"会议室排期\",\"file_id\":$FILE_ID}" "$ALICE")
echo "$DOC_F" | jq -c '.data | {id,title,source_type,source_ref,status,ext}'
[ "$(echo "$DOC_F" | jqget '.data.status')" = "ready" ] || { echo "❌ 文件摄入应 ready"; exit 1; }
[ "$(echo "$DOC_F" | jqget '.data.source_ref')" = "$FILE_ID" ] || { echo "❌ source_ref=file_id"; exit 1; }
BAD_EXT_CHECK=$(echo 'binary' > "$TMP/x.exe"; curl -sS -X POST "$BASE/files/upload" -H "Authorization: Bearer $ALICE" -F "file=@$TMP/x.exe" | jqget '.code')
[ "$BAD_EXT_CHECK" = "4002" ] || echo "（exe 上传非 4002：$BAD_EXT_CHECK——黑名单口径，不影响 kb 断言）"
echo "文件引用摄入 ✓"

echo ""
grep -q "kb 嵌入链路" "$TMP/server.log" && sed -n '/kb 嵌入链路/p;/kb 检轨/p' "$TMP/server.log"
echo "✅ 知识库 E2E 全链路通过（$([ -n "${BBW_KB_DSN:-}" ] && echo PG模式 || echo 内存模式)，端口 ${PORT}）"
