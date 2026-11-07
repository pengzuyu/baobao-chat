// mcpgw 契约测试：JSON-RPC 分发、三层身份（Bearer/_meta.bbwObo 双通道、
// OBO scope 防线二、act 归因审计）、kb_query 参数校验与业务失败语义。
// 用例与 bbrt-mcp（client 侧）行为镜像——两侧契约以此共同冻结。
package mcpgw

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/baobaowork/server/internal/platform/authjwt"
)

const testSecret = "test-secret-0123456789abcdef0123456789abcdef"

type fixture struct {
	gw       *Gateway
	signer   *authjwt.Signer
	kbArgs   []map[string]any // KBQuery 闭包收到的调用参数
	docCalls []int64          // DocRead 闭包收到的 docID
	imSends  []map[string]any // ImSend 闭包收到的参数
	upLoads  []map[string]any // FileUpload 闭包收到的参数
	audits   []AuditEntry
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{signer: authjwt.NewSigner([]byte(testSecret))}
	f.gw = &Gateway{opts: Options{
		Verify: func(_ context.Context, token string) (*authjwt.Claims, error) {
			return f.signer.Parse(token)
		},
		KBQuery: func(_ context.Context, tenantID, uid int64, spaceIDs []string, keyword string, topK int) (any, error) {
			f.kbArgs = append(f.kbArgs, map[string]any{
				"tenant": tenantID, "uid": uid, "space_ids": spaceIDs, "keyword": keyword, "top_k": topK,
			})
			return map[string]any{"items": []map[string]any{{"doc_id": "d1", "title": "架构"}}, "took_ms": 3}, nil
		},
		DocRead: func(_ context.Context, tenantID, uid, docID int64) (any, error) {
			f.docCalls = append(f.docCalls, docID)
			return map[string]any{"id": "12", "title": "周报", "content_md": "# 周", "owner_id": "7"}, nil
		},
		ImSend: func(_ context.Context, tenantID, uid, convID int64, msgType string, body json.RawMessage) (any, error) {
			f.imSends = append(f.imSends, map[string]any{
				"tenant": tenantID, "uid": uid, "conv_id": convID, "msg_type": msgType, "body": string(body),
			})
			return map[string]any{"msg_id": 801, "seq": 42}, nil
		},
		FileUpload: func(_ context.Context, tenantID, uid int64, name, contentType string, convID int64, r io.Reader) (any, error) {
			data, _ := io.ReadAll(r)
			f.upLoads = append(f.upLoads, map[string]any{
				"tenant": tenantID, "uid": uid, "name": name, "content_type": contentType,
				"conv_id": convID, "bytes": len(data),
			})
			return map[string]any{"file_id": "91", "name": name, "size": len(data)}, nil
		},
		Audit: func(_ context.Context, e AuditEntry) { f.audits = append(f.audits, e) },
	}}
	return f
}

// mint 签发测试令牌（OBO 时携带 Actor 与 scope）
func (f *fixture) mint(t *testing.T, subject string, obo bool, scopes ...string) string {
	t.Helper()
	now := time.Now().Unix()
	c := authjwt.Claims{
		Subject: subject, TenantID: 1, Scope: scopes,
		JWTID: authjwt.NewJTI(), IssuedAt: now, ExpiresAt: now + 600,
	}
	if obo {
		c.Actor = &authjwt.Actor{AgentSessionID: "sess-1"}
	}
	tok, err := f.signer.Sign(c)
	if err != nil {
		t.Fatalf("签发令牌失败: %v", err)
	}
	return tok
}

// post 发一帧 JSON-RPC（auth 为空则不带 Authorization 头）
func post(t *testing.T, gw *Gateway, body, auth string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp/corp", strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	rec := httptest.NewRecorder()
	gw.HandleMCP(rec, req)
	return rec
}

// decode 解 JSON-RPC 回包
func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("回包非法 JSON: %v: %s", err, rec.Body.String())
	}
	return v
}

func errCode(t *testing.T, v map[string]any) float64 {
	t.Helper()
	e, ok := v["error"].(map[string]any)
	if !ok {
		t.Fatalf("期望 JSON-RPC error，得到: %v", v)
	}
	return e["code"].(float64)
}

func TestInitializeHandshake(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bbrt","version":"0.1"}}}`, tok)
	if rec.Code != 200 {
		t.Fatalf("initialize 状态码 %d", rec.Code)
	}
	res := decode(t, rec)["result"].(map[string]any)
	if res["protocolVersion"] != "2024-11-05" {
		t.Fatalf("协议版本回声失败: %v", res)
	}
	if res["serverInfo"].(map[string]any)["name"] != ServerName {
		t.Fatalf("serverInfo.name: %v", res)
	}
}

func TestInitializeWithoutTokenRejected(t *testing.T) {
	f := newFixture(t)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`, "")
	if code := errCode(t, decode(t, rec)); code != codeUnauthorized {
		t.Fatalf("无令牌应 -32001，得到 %v", code)
	}
}

func TestToolsListDeclaresRiskAnnotation(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, tok)
	tools := decode(t, rec)["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 4 {
		t.Fatalf("供给应为 4 工具（kb_query/doc_read/im_send/file_upload）: %d 项", len(tools))
	}
	// 风险级与 09 篇 §3.1 权威表逐项对齐（客户端 gate 按此分档）
	want := map[string]string{
		"kb_query": "low", "doc_read": "low", "im_send": "high", "file_upload": "medium",
	}
	got := map[string]string{}
	for _, tl := range tools {
		m := tl.(map[string]any)
		got[m["name"].(string)] = m["annotations"].(map[string]any)["x-bbw-risk"].(string)
	}
	for name, risk := range want {
		if got[name] != risk {
			t.Fatalf("%s 风险级应为 %s，得到 %v（全集: %v）", name, risk, got[name], got)
		}
	}
}

func TestCallKbQueryHappyPathBearer(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"架构","top_k":5},"_meta":{"bbwAct":"agent:sess-1"}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("应成功: %v", res)
	}
	content := res["content"].([]any)[0].(map[string]any)
	if content["type"] != "text" {
		t.Fatal("content 应为 text 通道")
	}
	if !strings.Contains(content["text"].(string), `"doc_id":"d1"`) {
		t.Fatalf("text 应含 KB 结果 JSON: %v", content["text"])
	}
	// 闭包收到主体上下文（② 传播 → 防线三依据）
	if len(f.kbArgs) != 1 || f.kbArgs[0]["uid"] != int64(7) || f.kbArgs[0]["top_k"] != 5 {
		t.Fatalf("KBQuery 参数: %v", f.kbArgs)
	}
	// 审计（③ 归因）
	if len(f.audits) != 1 || !f.audits[0].OK || f.audits[0].Subject != 7 || f.audits[0].Tool != "kb_query" || f.audits[0].Act != "agent:sess-1" {
		t.Fatalf("审计行: %+v", f.audits)
	}
}

func TestCallKbQueryMetaOboFallback(t *testing.T) {
	// stdio 语义身份随行：无 Authorization 头，OBO 在 params._meta.bbwObo
	f := newFixture(t)
	obo := f.mint(t, "9", true, "kb:query:use")
	body := `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"x"},"_meta":{"bbwObo":"` + obo + `","bbwAct":"expert:ppt:a1"}}}`
	rec := post(t, f.gw, body, "")
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("OBO 带 scope 应放行: %v", res)
	}
	if f.kbArgs[0]["uid"] != int64(9) {
		t.Fatalf("主体应取 OBO sub=9: %v", f.kbArgs)
	}
	if f.audits[0].OBO != true || f.audits[0].Act != "expert:ppt:a1" {
		t.Fatalf("审计应记 OBO 与专家归因: %+v", f.audits)
	}
}

func TestCallOboMissingScopeDenied(t *testing.T) {
	f := newFixture(t)
	obo := f.mint(t, "9", true, "im:message:send") // 无 kb:query:use
	body := `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"x"},"_meta":{"bbwObo":"` + obo + `"}}}`
	rec := post(t, f.gw, body, "")
	if code := errCode(t, decode(t, rec)); code != codeScopeDenied {
		t.Fatalf("OBO 缺 scope 应 -32002，得到 %v", code)
	}
	if f.audits[0].OK || f.audits[0].ErrCode != "-32002" {
		t.Fatalf("审计应记失败: %+v", f.audits)
	}
	if len(f.kbArgs) != 0 {
		t.Fatal("scope 拒绝不得触达域服务")
	}
}

func TestCallNoTokenRejected(t *testing.T) {
	f := newFixture(t)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"x"}}}`, "")
	if code := errCode(t, decode(t, rec)); code != codeUnauthorized {
		t.Fatalf("应 -32001，得到 %v", code)
	}
}

func TestCallDocReadHappyPathAndScope(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"doc_read","arguments":{"doc_id":12}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("应成功: %v", res)
	}
	if !strings.Contains(res["content"].([]any)[0].(map[string]any)["text"].(string), "content_md") {
		t.Fatal("doc_read 应回正文")
	}
	if len(f.docCalls) != 1 || f.docCalls[0] != 12 {
		t.Fatalf("DocRead 参数: %v", f.docCalls)
	}
	// OBO 缺 doc:file:view → 防线二拒绝
	obo := f.mint(t, "9", true, "kb:query:use")
	body := `{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"doc_read","arguments":{"doc_id":12},"_meta":{"bbwObo":"` + obo + `"}}}`
	if code := errCode(t, decode(t, post(t, f.gw, body, ""))); code != codeScopeDenied {
		t.Fatalf("OBO 缺 doc:file:view 应 -32002，得到 %v", code)
	}
	// doc_id 非法
	bad := `{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"doc_read","arguments":{"doc_id":0}}}`
	if code := errCode(t, decode(t, post(t, f.gw, bad, tok))); code != codeInvalidParams {
		t.Fatalf("doc_id 缺失应 -32602，得到 %v", code)
	}
}

func TestCallDocReadBusinessErrorIsToolResult(t *testing.T) {
	// 非 owner → doc 域 6005 业务失败（isError 结果，模型可读原因）
	f := newFixture(t)
	f.gw.opts.DocRead = func(context.Context, int64, int64, int64) (any, error) {
		return nil, context.DeadlineExceeded
	}
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"doc_read","arguments":{"doc_id":99}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] != true {
		t.Fatalf("业务失败应 isError=true: %v", res)
	}
	if f.audits[0].OK || f.audits[0].Tool != "doc_read" || f.audits[0].ErrCode != "tool_error" {
		t.Fatalf("审计应记 doc_read 业务失败: %+v", f.audits)
	}
}

func TestCallUnknownTool(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"doc_write","arguments":{}}}`, tok)
	if code := errCode(t, decode(t, rec)); code != codeUnknownTool {
		t.Fatalf("未知工具应 -32003（doc_write 高危，供给随 D05 协作升级另定），得到 %v", code)
	}
}

func TestCallImSendTextAndCard(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	// text 形态
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"text","text":"部署完成"},"_meta":{"bbwAct":"agent:s1"}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("应成功: %v", res)
	}
	if len(f.imSends) != 1 || f.imSends[0]["uid"] != int64(7) || f.imSends[0]["conv_id"] != int64(5) ||
		f.imSends[0]["msg_type"] != "text" || !strings.Contains(f.imSends[0]["body"].(string), "部署完成") {
		t.Fatalf("ImSend 参数: %+v", f.imSends)
	}
	// agent_card 形态：card 原样透传
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"agent_card","card":{"kind":"task_done","title":"构建完成"}}}}`, tok)
	if decode(t, rec)["result"].(map[string]any)["isError"] == true {
		t.Fatal("agent_card 应成功")
	}
	if !strings.Contains(f.imSends[1]["body"].(string), "task_done") {
		t.Fatalf("card 应原样透传: %+v", f.imSends[1])
	}
	// 参数校验：枚举外 msg_type / text 缺失 / conv_id 缺失
	for _, args := range []string{
		`{"conv_id":5,"msg_type":"markdown"}`,
		`{"conv_id":5,"msg_type":"text"}`,
		`{"msg_type":"text","text":"x"}`,
	} {
		body := `{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"im_send","arguments":` + args + `}}`
		if code := errCode(t, decode(t, post(t, f.gw, body, tok))); code != codeInvalidParams {
			t.Fatalf("im_send 参数 %s 应 -32602", args)
		}
	}
	// OBO 缺 im:message:send → 防线二拒绝（高风险工具 scope 强制）
	obo := f.mint(t, "9", true, "kb:query:use")
	body := `{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"text","text":"x"},"_meta":{"bbwObo":"` + obo + `"}}}`
	if code := errCode(t, decode(t, post(t, f.gw, body, ""))); code != codeScopeDenied {
		t.Fatal("OBO 缺 im:message:send 应 -32002")
	}
}

func TestCallFileUploadHappyAndValidation(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	b64 := base64.StdEncoding.EncodeToString([]byte("hello-bytes-123"))
	body := `{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"file_upload","arguments":{"filename":"报告.txt","content_b64":"` + b64 + `","content_type":"text/plain","conv_id":5}}}`
	rec := post(t, f.gw, body, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("应成功: %v", res)
	}
	if len(f.upLoads) != 1 || f.upLoads[0]["bytes"] != len("hello-bytes-123") || f.upLoads[0]["conv_id"] != int64(5) {
		t.Fatalf("FileUpload 参数: %+v", f.upLoads)
	}
	// b64 非法 / filename 缺失 / content 空
	for _, args := range []string{
		`{"filename":"a.txt","content_b64":"!!非法!!"}`,
		`{"content_b64":"` + b64 + `"}`,
		`{"filename":"a.txt","content_b64":""}`,
	} {
		b := `{"jsonrpc":"2.0","id":32,"method":"tools/call","params":{"name":"file_upload","arguments":` + args + `}}`
		if code := errCode(t, decode(t, post(t, f.gw, b, tok))); code != codeInvalidParams {
			t.Fatalf("file_upload 参数 %s 应 -32602", args)
		}
	}
	// OBO 缺 file:upload → 拒绝
	obo := f.mint(t, "9", true, "im:message:send")
	b := `{"jsonrpc":"2.0","id":33,"method":"tools/call","params":{"name":"file_upload","arguments":{"filename":"a.txt","content_b64":"` + b64 + `"},"_meta":{"bbwObo":"` + obo + `"}}}`
	if code := errCode(t, decode(t, post(t, f.gw, b, ""))); code != codeScopeDenied {
		t.Fatal("OBO 缺 file:upload 应 -32002")
	}
	// 域业务失败（如超 20MB）→ isError 结果
	f.gw.opts.FileUpload = func(context.Context, int64, int64, string, string, int64, io.Reader) (any, error) {
		return nil, context.DeadlineExceeded
	}
	rec = post(t, f.gw, body, tok)
	if decode(t, rec)["result"].(map[string]any)["isError"] != true {
		t.Fatal("域失败应 isError=true")
	}
}

func TestCallInvalidParams(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	for _, args := range []string{`{}`, `{"keyword":""}`, `{"keyword":"` + strings.Repeat("长", 513) + `"}`, `{"keyword":"x","top_k":21}`} {
		body := `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"kb_query","arguments":` + args + `}}`
		if code := errCode(t, decode(t, post(t, f.gw, body, tok))); code != codeInvalidParams {
			t.Fatalf("参数 %s 应 -32602", args)
		}
	}
}

func TestKbBusinessErrorIsToolResultNotRpcError(t *testing.T) {
	// MCP 语义：业务失败 = isError 结果（模型自行处置），非 JSON-RPC error
	f := newFixture(t)
	f.gw.opts.KBQuery = func(context.Context, int64, int64, []string, string, int) (any, error) {
		return nil, context.DeadlineExceeded
	}
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"x"}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] != true {
		t.Fatalf("业务失败应 isError=true: %v", res)
	}
}

func TestUnknownMethod(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":10,"method":"resources/list","params":{}}`, tok)
	if code := errCode(t, decode(t, rec)); code != codeMethodNotFound {
		t.Fatalf("应 -32601，得到 %v", code)
	}
}

func TestNotificationAcceptedSilently(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`, tok)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("通知应 202，得到 %d", rec.Code)
	}
}

func TestPing(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":11,"method":"ping"}`, tok)
	if decode(t, rec)["result"] == nil {
		t.Fatal("ping 应回空 result")
	}
}

func TestGetRejected(t *testing.T) {
	f := newFixture(t)
	req := httptest.NewRequest(http.MethodGet, "/mcp/corp", nil)
	rec := httptest.NewRecorder()
	f.gw.HandleMCP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET 应 405，得到 %d", rec.Code)
	}
}
