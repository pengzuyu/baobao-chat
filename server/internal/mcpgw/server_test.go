// mcpgw 契约测试：JSON-RPC 分发、三层身份（Bearer/_meta.bbcObo 双通道、
// OBO scope 防线二、act 归因审计）、kb_query 参数校验与业务失败语义。
// 用例与 bbrt-mcp（client 侧）行为镜像——两侧契约以此共同冻结。
package mcpgw

import (
	"context"
	"encoding/base64"
	"fmt"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/baobaochat/server/internal/platform/authjwt"
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
	// B1 只读九件的调用记录
	orgSearches    []map[string]any
	imConvsCalls   []map[string]any
	imSearchCalls  []map[string]any
	docReads       []map[string]any
	kbSpacesCalls  []map[string]any
	kbNodesCalls   []map[string]any
	calendarCalls  []map[string]any
	fileListCalls  []map[string]any
	presenceCalls  int
	docWrites      []map[string]any
	groupCreates   []map[string]any
	groupInvites   []map[string]any
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
		OrgSearch: func(_ context.Context, tenantID int64, q string, limit int) (any, error) {
			f.orgSearches = append(f.orgSearches, map[string]any{"tenant": tenantID, "q": q, "limit": limit})
			return []map[string]any{{"uid": "12", "display_name": "张三", "employee_no": "E001", "org_path": "/公司/研发部"}}, nil
		},
		ImConvs: func(_ context.Context, uid int64, query string) (any, error) {
			f.imConvsCalls = append(f.imConvsCalls, map[string]any{"uid": uid, "query": query})
			return map[string]any{"items": []map[string]any{{"id": "5", "type": 1, "name": "张三", "peerUid": "12", "lastMsgDigest": "明天见"}}}, nil
		},
		ImSearch: func(_ context.Context, uid int64, p ImSearchParams) (any, error) {
			f.imSearchCalls = append(f.imSearchCalls, map[string]any{"uid": uid, "keyword": p.Keyword, "conv_id": p.ConvID, "limit": p.Limit})
			return map[string]any{"items": []map[string]any{{"msg_id": 77, "conv_id": 5, "snippet": "报销流程…"}}}, nil
		},
		DocRead: func(_ context.Context, tenantID, uid, docID int64) (any, error) {
			f.docReads = append(f.docReads, map[string]any{"tenant": tenantID, "uid": uid, "doc_id": docID})
			return map[string]any{"doc": map[string]any{"id": "3", "title": "部署手册", "status": "ready"}, "chunks": []map[string]any{{"seq": 1, "content": "第一章…"}}}, nil
		},
		KbSpaces: func(_ context.Context, tenantID, uid int64) (any, error) {
			f.kbSpacesCalls = append(f.kbSpacesCalls, map[string]any{"tenant": tenantID, "uid": uid})
			return []map[string]any{{"id": "1", "name": "公司知识库", "space_type": "company"}}, nil
		},
		KbNodes: func(_ context.Context, tenantID, uid, spaceID, parentID int64) (any, error) {
			f.kbNodesCalls = append(f.kbNodesCalls, map[string]any{"tenant": tenantID, "uid": uid, "space_id": spaceID, "parent_id": parentID})
			return map[string]any{"dirs": []map[string]any{{"id": "2", "name": "运维"}}, "docs": []map[string]any{}}, nil
		},
		CalendarQuery: func(_ context.Context, tenantID int64, year, month int) (any, error) {
			f.calendarCalls = append(f.calendarCalls, map[string]any{"tenant": tenantID, "year": year, "month": month})
			return map[string]any{"year": year, "days": []map[string]any{{"date": fmt.Sprintf("%04d-01-01", year), "type": "holiday"}}}, nil
		},
		FileList: func(_ context.Context, tenantID, uid, convID int64) (any, error) {
			f.fileListCalls = append(f.fileListCalls, map[string]any{"tenant": tenantID, "uid": uid, "conv_id": convID})
			return []map[string]any{{"id": "91", "name": "报告.pdf", "size": 1024}}, nil
		},
		PresenceSnapshot: func() map[int64]string {
			f.presenceCalls++
			return map[int64]string{7: "online", 12: "offline", 3: "away"}
		},
		DocWrite: func(_ context.Context, tenantID, uid, spaceID, nodeID int64, title, format, content string) (any, error) {
			f.docWrites = append(f.docWrites, map[string]any{
				"tenant": tenantID, "uid": uid, "space_id": spaceID, "node_id": nodeID,
				"title": title, "format": format, "content": content,
			})
			return map[string]any{"id": "9", "title": title, "status": "ready"}, nil
		},
		GroupCreate: func(_ context.Context, uid int64, name string, memberIDs []string) (any, error) {
			f.groupCreates = append(f.groupCreates, map[string]any{"uid": uid, "name": name, "members": memberIDs})
			return map[string]any{"id": "77", "type": 2, "name": name, "memberCount": len(memberIDs) + 1}, nil
		},
		GroupInvite: func(_ context.Context, uid, convID int64, uids []string) error {
			f.groupInvites = append(f.groupInvites, map[string]any{"uid": uid, "conv_id": convID, "uids": uids})
			return nil
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
	if len(tools) != 18 {
		t.Fatalf("供给应为 18 工具（六件+B1 九件+B2 doc_write+B4 群管理两件）: %d 项", len(tools))
	}
	// 风险级与 09 篇 §3.1 权威表逐项对齐（客户端 gate 按此分档）
	want := map[string]string{
		"kb_query": "low", "im_send": "high", "im_history": "low", "file_upload": "medium",
		"mail_read": "low", "mail_send": "high",
		"org_search": "low", "im_convs": "low", "im_search": "low", "doc_read": "low",
		"kb_spaces": "low", "kb_nodes": "low", "calendar_query": "low",
		"file_list": "low", "presences": "low", "doc_write": "high",
		"group_create": "high", "group_invite": "high",
	}
	got := map[string]string{}
	for _, tl := range tools {
		m := tl.(map[string]any)
		got[m["name"].(string)] = m["annotations"].(map[string]any)["x-bbc-risk"].(string)
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
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"架构","top_k":5},"_meta":{"bbcAct":"agent:sess-1"}}}`, tok)
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
	// stdio 语义身份随行：无 Authorization 头，OBO 在 params._meta.bbcObo
	f := newFixture(t)
	obo := f.mint(t, "9", true, "kb:query:use")
	body := `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"x"},"_meta":{"bbcObo":"` + obo + `","bbcAct":"expert:ppt:a1"}}}`
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
	body := `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"kb_query","arguments":{"keyword":"x"},"_meta":{"bbcObo":"` + obo + `"}}}`
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
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"app_write","arguments":{}}}`, tok)
	if code := errCode(t, decode(t, rec)); code != codeUnknownTool {
		t.Fatalf("未知工具应 -32003（app_write 为 09 篇类别占位名，未供给），得到 %v", code)
	}
}

func TestCallImSendTextAndCard(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "7", false)
	// text 形态
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"text","text":"部署完成"},"_meta":{"bbcAct":"agent:s1"}}}`, tok)
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
	body := `{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"text","text":"x"},"_meta":{"bbcObo":"` + obo + `"}}}`
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
	b := `{"jsonrpc":"2.0","id":33,"method":"tools/call","params":{"name":"file_upload","arguments":{"filename":"a.txt","content_b64":"` + b64 + `"},"_meta":{"bbcObo":"` + obo + `"}}}`
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
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"mail_send","arguments":{"to":["E100002@corp.company.internal"],"subject":"评审邀请","body":"请审阅","cc":["E100003@corp.company.internal"]},"_meta":{"bbcAct":"agent:sess-m"}}}`, tok)
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
	body := `{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"mail_send","arguments":{"to":["x@corp.company.internal"],"subject":"s","body":"b"},"_meta":{"bbcObo":"` + obo + `"}}}`
	rec = post(t, f2.gw, body, "")
	if c := errCode(t, decode(t, rec)); c != -32002 {
		t.Fatalf("OBO 缺 scope 应 -32002: %v", c)
	}
}

// im_history（D18 §3.5 agent 自读上下文）：默认 limit=50 透传、结果行进 text 通道
func TestCallImHistory(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"im_history","arguments":{"conv_id":7},"_meta":{"bbcAct":"agent:sess-2"}}}`, tok)
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

// ── B1 只读九件（2026-11-23）：happy path + 默认值 + OBO scope + uids 过滤 ──

// org_search：happy path 透传 tenant/uid，默认 limit=20
func TestCallOrgSearch(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"org_search","arguments":{"query":"zhangsan"}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("应成功: %v", res)
	}
	if text := res["content"].([]any)[0].(map[string]any)["text"].(string); !strings.Contains(text, "张三") {
		t.Fatalf("org_search 结果缺失: %s", text)
	}
	if len(f.orgSearches) != 1 || f.orgSearches[0]["limit"] != 20 || f.orgSearches[0]["q"] != "zhangsan" {
		t.Fatalf("OrgSearch 参数（默认 limit=20）: %+v", f.orgSearches)
	}
	// 空关键词 → -32602
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"org_search","arguments":{}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != codeInvalidParams {
		t.Fatalf("缺 query 应 -32602: %v", c)
	}
}

// im_convs + im_search：人名→conv_id 反查入口 + 全局检索投影
func TestCallImConvsAndSearch(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"im_convs","arguments":{"query":"张三"}}}`, tok)
	if res := decode(t, rec)["result"].(map[string]any); res["isError"] == true {
		t.Fatalf("im_convs 应成功: %v", res)
	}
	if len(f.imConvsCalls) != 1 || f.imConvsCalls[0]["query"] != "张三" {
		t.Fatalf("ImConvs 参数: %+v", f.imConvsCalls)
	}
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"im_search","arguments":{"keyword":"报销","conv_id":5,"limit":30}}}`, tok)
	if res := decode(t, rec)["result"].(map[string]any); res["isError"] == true {
		t.Fatalf("im_search 应成功: %v", res)
	}
	if len(f.imSearchCalls) != 1 || f.imSearchCalls[0]["keyword"] != "报销" || f.imSearchCalls[0]["conv_id"] != int64(5) {
		t.Fatalf("ImSearch 参数: %+v", f.imSearchCalls)
	}
}

// doc_read/kb_spaces/kb_nodes：KB 全文通道与结构浏览
func TestCallKbReadTools(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"doc_read","arguments":{"doc_id":3}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if text := res["content"].([]any)[0].(map[string]any)["text"].(string); !strings.Contains(text, "部署手册") || !strings.Contains(text, "chunks") {
		t.Fatalf("doc_read 应含 meta+chunks: %s", text)
	}
	post(t, f.gw, `{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"kb_spaces","arguments":{}}}`, tok)
	post(t, f.gw, `{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"kb_nodes","arguments":{"space_id":1}}}`, tok)
	if len(f.kbSpacesCalls) != 1 || len(f.kbNodesCalls) != 1 || f.kbNodesCalls[0]["parent_id"] != int64(0) {
		t.Fatalf("kb_spaces/kb_nodes 参数: %+v %+v", f.kbSpacesCalls, f.kbNodesCalls)
	}
	// 缺 space_id → -32602
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"kb_nodes","arguments":{}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != codeInvalidParams {
		t.Fatalf("缺 space_id 应 -32602: %v", c)
	}
}

// calendar_query：默认当前年；file_list：conv_id=0 我的云盘
func TestCallCalendarAndFileList(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"calendar_query","arguments":{}}}`, tok)
	if res := decode(t, rec)["result"].(map[string]any); res["isError"] == true {
		t.Fatalf("calendar_query 应成功: %v", res)
	}
	if len(f.calendarCalls) != 1 || f.calendarCalls[0]["year"] != time.Now().Year() {
		t.Fatalf("CalendarQuery 默认年: %+v", f.calendarCalls)
	}
	post(t, f.gw, `{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"file_list","arguments":{"conv_id":5}}}`, tok)
	if len(f.fileListCalls) != 1 || f.fileListCalls[0]["conv_id"] != int64(5) {
		t.Fatalf("FileList 参数: %+v", f.fileListCalls)
	}
}

// presences：全量快照 uid 升序；uids 过滤
func TestCallPresences(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"presences","arguments":{}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	var v struct {
		Items []map[string]string `json:"items"`
	}
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatalf("presences 结果非法: %v", err)
	}
	if len(v.Items) != 3 || v.Items[0]["uid"] != "3" || v.Items[2]["uid"] != "12" {
		t.Fatalf("presences 全量应 3 条 uid 升序: %+v", v.Items)
	}
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"presences","arguments":{"uids":[7]}}}`, tok)
	text = decode(t, rec)["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if err := json.Unmarshal([]byte(text), &v); err != nil || len(v.Items) != 1 || v.Items[0]["uid"] != "7" {
		t.Fatalf("presences uids 过滤应仅 1 条: %+v err=%v", v.Items, err)
	}
}

// B1 工具 OBO scope 防线二：doc_read 缺 doc:file:view → -32002 不触域
func TestB1OboMissingScopeDenied(t *testing.T) {
	f := newFixture(t)
	obo := f.mint(t, "9", true, "kb:query:use") // 无 doc:file:view
	body := `{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"doc_read","arguments":{"doc_id":3},"_meta":{"bbcObo":"` + obo + `"}}}`
	rec := post(t, f.gw, body, "")
	if c := errCode(t, decode(t, rec)); c != codeScopeDenied {
		t.Fatalf("OBO 缺 scope 应 -32002，得到 %v", c)
	}
	if len(f.docReads) != 0 {
		t.Fatal("scope 拒绝不得触达域服务")
	}
}

// ── B2 写批（2026-11-23）：doc_write + im_send 扩 file ──

// doc_write：happy 透传 + 校验 + OBO scope
func TestCallDocWrite(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"doc_write","arguments":{"space_id":1,"title":"部署手册","content":"# 一\n步骤…","format":"markdown"}}}`, tok)
	res := decode(t, rec)["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("doc_write 应成功: %v", res)
	}
	if len(f.docWrites) != 1 || f.docWrites[0]["space_id"] != int64(1) ||
		f.docWrites[0]["format"] != "markdown" || f.docWrites[0]["node_id"] != int64(0) {
		t.Fatalf("DocWrite 参数: %+v", f.docWrites)
	}
	// 缺 title → -32602；format 非法 → -32602
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"doc_write","arguments":{"space_id":1,"content":"x"}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != codeInvalidParams {
		t.Fatalf("缺 title 应 -32602: %v", c)
	}
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"doc_write","arguments":{"space_id":1,"title":"t","content":"x","format":"html"}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != codeInvalidParams {
		t.Fatalf("format 非法应 -32602: %v", c)
	}
	// OBO 缺 doc:file:edit → -32002 不触域
	f2 := newFixture(t)
	obo := f2.mint(t, "9", true, "doc:file:view") // 无 edit
	body := `{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"doc_write","arguments":{"space_id":1,"title":"t","content":"x"},"_meta":{"bbcObo":"` + obo + `"}}}`
	rec = post(t, f2.gw, body, "")
	if c := errCode(t, decode(t, rec)); c != codeScopeDenied {
		t.Fatalf("OBO 缺 scope 应 -32002，得到 %v", c)
	}
	if len(f2.docWrites) != 0 {
		t.Fatal("scope 拒绝不得触达域服务")
	}
}

// im_send 扩 file：body={file_id,name}；缺 file_id → -32602；name 缺省 "file"
func TestCallImSendFile(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"file","file_id":91,"name":"报告.pdf"}}}`, tok)
	if res := decode(t, rec)["result"].(map[string]any); res["isError"] == true {
		t.Fatalf("im_send file 应成功: %v", res)
	}
	if len(f.imSends) != 1 {
		t.Fatalf("imSends: %+v", f.imSends)
	}
	var b struct {
		FileID int64  `json:"file_id"`
		Name   string `json:"name"`
	}
	body := f.imSends[0]["body"].(string) // fixture 以字符串记录 body
	if err := json.Unmarshal([]byte(body), &b); err != nil || b.FileID != 91 || b.Name != "报告.pdf" {
		t.Fatalf("file body 应含 file_id/name: %s err=%v", body, err)
	}
	if f.imSends[0]["msg_type"] != "file" {
		t.Fatalf("msg_type 应透传 file: %+v", f.imSends[0])
	}
	// name 缺省
	post(t, f.gw, `{"jsonrpc":"2.0","id":26,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"file","file_id":91}}}`, tok)
	body2 := f.imSends[1]["body"].(string)
	if err := json.Unmarshal([]byte(body2), &b); err != nil || b.Name != "file" {
		t.Fatalf("name 缺省应 file: %s err=%v", body2, err)
	}
	// 缺 file_id → -32602
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":27,"method":"tools/call","params":{"name":"im_send","arguments":{"conv_id":5,"msg_type":"file"}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != codeInvalidParams {
		t.Fatalf("缺 file_id 应 -32602: %v", c)
	}
}

// ── B4 群管理两件（2026-11-23）：happy + 校验 + OBO scope ──

func TestCallGroupTools(t *testing.T) {
	f := newFixture(t)
	tok := f.mint(t, "9", false)
	rec := post(t, f.gw, `{"jsonrpc":"2.0","id":28,"method":"tools/call","params":{"name":"group_create","arguments":{"name":"项目组","member_uids":["12","15"]}}}`, tok)
	if res := decode(t, rec)["result"].(map[string]any); res["isError"] == true {
		t.Fatalf("group_create 应成功: %v", res)
	}
	if len(f.groupCreates) != 1 || f.groupCreates[0]["name"] != "项目组" || len(f.groupCreates[0]["members"].([]string)) != 2 {
		t.Fatalf("GroupCreate 参数: %+v", f.groupCreates)
	}
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":29,"method":"tools/call","params":{"name":"group_invite","arguments":{"conv_id":77,"uids":["20"]}}}`, tok)
	if res := decode(t, rec)["result"].(map[string]any); res["isError"] == true {
		t.Fatalf("group_invite 应成功: %v", res)
	}
	if len(f.groupInvites) != 1 || f.groupInvites[0]["conv_id"] != int64(77) {
		t.Fatalf("GroupInvite 参数: %+v", f.groupInvites)
	}
	// 空成员 → -32602；缺 name → -32602
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"group_create","arguments":{"name":"x","member_uids":[]}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != codeInvalidParams {
		t.Fatalf("空成员应 -32602: %v", c)
	}
	rec = post(t, f.gw, `{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"group_invite","arguments":{"uids":["1"]}}}`, tok)
	if c := errCode(t, decode(t, rec)); c != codeInvalidParams {
		t.Fatalf("缺 conv_id 应 -32602: %v", c)
	}
	// OBO 缺 im:conv:manage → -32002 不触域
	f2 := newFixture(t)
	obo := f2.mint(t, "9", true, "im:message:send")
	body := `{"jsonrpc":"2.0","id":32,"method":"tools/call","params":{"name":"group_create","arguments":{"name":"x","member_uids":["1"]},"_meta":{"bbcObo":"` + obo + `"}}}`
	rec = post(t, f2.gw, body, "")
	if c := errCode(t, decode(t, rec)); c != codeScopeDenied {
		t.Fatalf("OBO 缺 scope 应 -32002，得到 %v", c)
	}
	if len(f2.groupCreates) != 0 {
		t.Fatal("scope 拒绝不得触达域服务")
	}
}
