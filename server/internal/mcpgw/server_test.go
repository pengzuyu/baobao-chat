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
	gw        *Gateway
	signer    *authjwt.Signer
	kbArgs    []map[string]any // KBQuery 闭包收到的调用参数
	imSends   []map[string]any // ImSend 闭包收到的参数
	imHistoryCalls []map[string]any // ImHistory 闭包收到的调用参数
	upLoads   []map[string]any // FileUpload 闭包收到的参数
	audits    []AuditEntry
	mailReads []map[string]any
	mailSends []map[string]any
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
		ImSend: func(_ context.Context, tenantID, uid, convID int64, msgType string, body json.RawMessage) (any, error) {
			f.imSends = append(f.imSends, map[string]any{
				"tenant": tenantID, "uid": uid, "conv_id": convID, "msg_type": msgType, "body": string(body),
			})
			return map[string]any{"msg_id": 801, "seq": 42}, nil
		},
		ImHistory: func(_ context.Context, tenantID, uid, convID int64, limit int) ([]string, error) {
			f.imHistoryCalls = append(f.imHistoryCalls, map[string]any{"tenant": tenantID, "uid": uid, "conv_id": convID, "limit": limit})
			return []string{"Alice: 报销流程是什么", "【Agent】(done) 1. 提交入口：OA-报销中心…"}, nil
		},
		FileUpload: func(_ context.Context, tenantID, uid int64, name, contentType string, convID int64, r io.Reader) (any, error) {
			data, _ := io.ReadAll(r)
			f.upLoads = append(f.upLoads, map[string]any{
				"tenant": tenantID, "uid": uid, "name": name, "content_type": contentType,
				"conv_id": convID, "bytes": len(data),
			})
			return map[string]any{"file_id": "91", "name": name, "size": len(data)}, nil
		},
		MailRead: func(_ context.Context, tenantID, uid int64, msgID int64, query, folder string, attachOnly bool, limit int) (any, error) {
			f.mailReads = append(f.mailReads, map[string]any{
				"tenant": tenantID, "uid": uid, "msg_id": msgID, "query": query,
				"folder": folder, "attach_only": attachOnly, "limit": limit,
			})
			if msgID > 0 {
				return map[string]any{"id": msgID, "subject": "方案定稿", "body": "正文"}, nil
			}
			return map[string]any{"items": []map[string]any{{"id": 31, "subject": "方案定稿", "snippet": "请审阅"}}}, nil
		},
		MailSend: func(_ context.Context, tenantID, uid int64, to, cc []string, subject, body, inReplyTo string) (any, error) {
			f.mailSends = append(f.mailSends, map[string]any{
				"tenant": tenantID, "uid": uid, "to": to, "cc": cc,
				"subject": subject, "body": body, "in_reply_to": inReplyTo,
			})
			return map[string]any{"message_id": "m-1", "delivered": to, "undelivered": []any{}}, nil
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
	if len(tools) != 6 {
		t.Fatalf("供给应为 6 工具（kb_query/im_send/im_history/file_upload/mail_read/mail_send）: %d 项", len(tools))
	}
	// 风险级与 09 篇 §3.1 权威表逐项对齐（客户端 gate 按此分档）
	want := map[string]string{
		"kb_query": "low", "im_send": "high", "im_history": "low", "file_upload": "medium",
		"mail_read": "low", "mail_send": "high",
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

// mail_read/mail_send 供给（22 §4.7）：三态读取/发送链路/参数与 scope 防线
func TestMailToolsSupply(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	// ① 列表（folder 默认 inbox）
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"mail_read","arguments":{"limit":5}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("列表应成功: %v", res)
	}
	// ② 检索
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"mail_read","arguments":{"query":"预算"}}}`, tok)
	res = decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("检索应成功: %v", res)
	}
	// ③ 单封详情
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":32,"method":"tools/call","params":{"name":"mail_read","arguments":{"msg_id":31}}}`, tok)
	res = decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true || !strings.Contains(rec.Body.String(), "正文") {
		t.Fatalf("单封应含正文: %v", res)
	}
	// folder 空透传（mail 域侧默认 inbox——域兜底不重复）
	if len(f.mailReads) != 3 || f.mailReads[0]["folder"] != "" || f.mailReads[2]["msg_id"] != int64(31) {
		t.Fatalf("三态读取: %v", f.mailReads)
	}
	// ④ limit 越界
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":33,"method":"tools/call","params":{"name":"mail_read","arguments":{"limit":99}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != -32602 {
		t.Fatalf("limit 越界应 -32602: %v", c)
	}
}

func TestMailSendSupply(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	// 发送成功：主体传播+检查链入域
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"mail_send","arguments":{"to":["E100002@corp.company.internal"],"subject":"评审邀请","body":"请审阅","cc":["E100003@corp.company.internal"]},"_meta":{"bbwAct":"agent:sess-m"}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true || !strings.Contains(rec.Body.String(), "delivered") {
		t.Fatalf("发送应成功: %v", res)
	}
	if len(f.mailSends) != 1 || f.mailSends[0]["uid"] != int64(7) || len(f.mailSends[0]["cc"].([]string)) != 1 {
		t.Fatalf("发送链路: %v", f.mailSends)
	}
	if len(f.audits) != 1 || f.audits[0].Tool != "mail_send" || f.audits[0].Act != "agent:sess-m" {
		t.Fatalf("审计: %+v", f.audits)
	}
	// to 缺失
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"mail_send","arguments":{"subject":"x","body":"y"}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != -32602 {
		t.Fatalf("缺 to 应 -32602: %v", c)
	}
	// OBO 缺 mail scope → 防线二（-32002）
	f2 := newFixture(t)
	obo := f2.mint(t, "9", true, "im:message:send") // 无 mail:agent_tool
	body := `{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"mail_send","arguments":{"to":["x@corp.company.internal"],"subject":"s","body":"b"},"_meta":{"bbwObo":"` + obo + `"}}}`
	rec = post(t, f2.gw, body, "")
	if c := errCode(t, decode(t, rec)); c != -32002 {
		t.Fatalf("OBO 缺 scope 应 -32002: %v", c)
	}
}

// im_history（D18 §3.5 agent 自读上下文）：默认 limit=50 透传、结果行进 text 通道
func TestCallImHistory(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"im_history","arguments":{"conv_id":7},"_meta":{"bbwAct":"agent:sess-2"}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("应成功: %v", res)
	}
	content := res["content"].([]any)[0].(map[string]any)
	text := content["text"].(string)
	if !strings.Contains(text, "报销流程") || !strings.Contains(text, "Agent") {
		t.Fatalf("im_history 行摘要缺失: %s", text)
	}
	if len(f.imHistoryCalls) != 1 || f.imHistoryCalls[0]["limit"] != 50 || f.imHistoryCalls[0]["conv_id"] != int64(7) {
		t.Fatalf("ImHistory 参数（默认 limit=50）: %+v", f.imHistoryCalls)
	}
}
