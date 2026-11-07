// AI 网关接入层测试（docs/19 §4.1/§6.2/§6.3）：SSE 形态/档位判定/限流/配额/计量/嵌入。
package aigw

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestGateway(quotaLimit int64, devToken string) (*Gateway, *Meter, *Quota) {
	mock := NewMockProvider(1, "mock-echo")
	router := NewRouter(mock, nil)
	meter := NewMeter(nil)
	quota := NewQuota(quotaLimit)
	gw := NewGateway(nil, router, NewLimiter(600, 600), quota, meter, devToken) // 限流放大避免误触
	return gw, meter, quota
}

func postChat(gw *Gateway, body string, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	gw.HandleChat(rec, req)
	return rec
}

func sseFrames(rec *httptest.ResponseRecorder) []string {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(rec.Body.String()))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "data: ") {
			out = append(out, strings.TrimPrefix(line, "data: "))
		}
	}
	return out
}

func TestChatStreamShapeAndUsageFrame(t *testing.T) {
	gw, meter, _ := newTestGateway(0, "dev-tok")
	body := `{"model":"bbw-strong","stream":true,"messages":[{"role":"user","content":"读一下 foo.txt"}],"tools":[{"type":"function","function":{"name":"read_file"}}]}`
	rec := postChat(gw, body, "dev-tok")

	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("Content-Type=%s", ct)
	}
	frames := sseFrames(rec)
	if len(frames) < 3 {
		t.Fatalf("帧数不足: %v", frames)
	}
	// 末两帧：X-BBW-Usage 终帧 + [DONE]（§6.2）
	last := frames[len(frames)-1]
	if last != "[DONE]" {
		t.Fatalf("末帧应为 [DONE]: %s", last)
	}
	var usage map[string]any
	if err := json.Unmarshal([]byte(frames[len(frames)-2]), &usage); err != nil || usage["prompt_tokens"] == nil {
		t.Fatalf("终帧非 usage 形态: %s err=%v", frames[len(frames)-2], err)
	}
	// 首轮应含 tool_calls 帧（echo-agent 启发式命中 foo.txt）
	joined := strings.Join(frames, "\n")
	if !strings.Contains(joined, `"tool_calls"`) || !strings.Contains(joined, `"finish_reason":"tool_calls"`) {
		t.Fatalf("应发起 read_file 工具调用: %v", frames)
	}
	// 计量开票（scene 默认 chat、tier strong、provider=1）
	snap := meter.Snapshot()
	var hit bool
	for dim, row := range snap {
		if dim.Scene == "chat" && dim.Tier == "strong" && dim.Provider == 1 && row.Requests == 1 {
			hit = true
		}
	}
	if !hit {
		t.Fatalf("计量缺失: %+v", snap)
	}
}

func TestChatFinalAnswerAfterToolResult(t *testing.T) {
	gw, _, _ := newTestGateway(0, "dev-tok")
	body := `{"model":"bbw-strong","stream":true,"messages":[
		{"role":"user","content":"读一下 foo.txt"},
		{"role":"assistant","content":"","tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"foo.txt\"}"}}]},
		{"role":"tool","tool_call_id":"read_file:call-1","content":"hello runtime"}]}`
	rec := postChat(gw, body, "dev-tok")
	frames := sseFrames(rec)
	joined := strings.Join(frames, "\n")
	if !strings.Contains(joined, "根据工具结果：hello runtime") {
		t.Fatalf("收尾应引用工具结果: %v", frames)
	}
	if !strings.Contains(joined, `"finish_reason":"stop"`) {
		t.Fatalf("应以 stop 收束: %v", frames)
	}
}

func TestModelAliasGuards(t *testing.T) {
	gw, _, _ := newTestGateway(0, "dev-tok")
	// 具体模型名 → 9001
	rec := postChat(gw, `{"model":"glm-4.7","messages":[{"role":"user","content":"hi"}]}`, "dev-tok")
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), `"code":9001`) {
		t.Fatalf("具体模型名应 9001: %d %s", rec.Code, rec.Body.String())
	}
	// 未知别名 → 8052
	rec = postChat(gw, `{"model":"bbw-vision","messages":[{"role":"user","content":"hi"}]}`, "dev-tok")
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), `"code":8052`) {
		t.Fatalf("未知别名应 8052: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAuthRequired(t *testing.T) {
	gw, _, _ := newTestGateway(0, "") // 无开发令牌且无 JWT 校验
	rec := postChat(gw, `{"model":"bbw-fast","messages":[]}`, "whatever")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无可用鉴权应 401: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRateLimit8050(t *testing.T) {
	mock := NewMockProvider(1, "m")
	gw := NewGateway(nil, NewRouter(mock, nil), NewLimiter(6, 2), NewQuota(0), NewMeter(nil), "dev")
	for i := 0; i < 3; i++ { // burst=2：第 3 次应拒绝
		rec := postChat(gw, `{"model":"bbw-fast","messages":[{"role":"user","content":"hi"}]}`, "dev")
		if i < 2 && rec.Code != 200 {
			t.Fatalf("第 %d 次不应限流: %d", i, rec.Code)
		}
		if i == 2 {
			if rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), `"code":8050`) {
				t.Fatalf("应 8050: %d %s", rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Retry-After") == "" {
				t.Fatal("应带 Retry-After")
			}
		}
	}
}

func TestQuota8005(t *testing.T) {
	gw, _, quota := newTestGateway(100, "dev")
	// 预置配额耗尽
	quota.Add("1:dev-agent", 200)
	rec := postChat(gw, `{"model":"bbw-fast","messages":[{"role":"user","content":"hi"}]}`, "dev")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"code":8005`) {
		t.Fatalf("应 8005: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEmbeddings(t *testing.T) {
	gw, meter, _ := newTestGateway(0, "dev")
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings",
		strings.NewReader(`{"model":"bbw-embed","input":["hello","world"]}`))
	req.Header.Set("Authorization", "Bearer dev")
	rec := httptest.NewRecorder()
	gw.HandleEmbeddings(rec, req)
	if rec.Code != 200 {
		t.Fatalf("code=%d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
			Index     int       `json:"index"`
		} `json:"data"`
		Usage *UsageOpenAI `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Data) != 2 {
		t.Fatalf("data=%d", len(resp.Data))
	}
	if len(resp.Data[0].Embedding) != 1024 {
		t.Fatalf("维度应 1024: %d", len(resp.Data[0].Embedding))
	}
	// 计量 scene=embed
	for dim := range meter.Snapshot() {
		if dim.Scene != "embed" {
			t.Fatalf("scene 应 embed: %+v", dim)
		}
	}
}

func TestMeteringSceneAndSessionHeader(t *testing.T) {
	gw, meter, _ := newTestGateway(0, "dev")
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"bbw-fast","messages":[{"role":"user","content":"普通问题"}]}`))
	req.Header.Set("Authorization", "Bearer dev")
	req.Header.Set("X-BBW-Scene", "delegate")
	req.Header.Set("X-BBW-Agent-Session", "sess-42")
	rec := httptest.NewRecorder()
	gw.HandleChat(rec, req)
	if rec.Code != 200 {
		t.Fatalf("code=%d", rec.Code)
	}
	snap := meter.Snapshot()
	found := false
	for dim, row := range snap {
		if dim.Scene == "delegate" && dim.Session == "sess-42" && row.Requests == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("scene/session 维度缺失: %+v", snap)
	}
}

func TestMockEmbedSemanticSimilarity(t *testing.T) {
	// 词袋语义：同主题文本相似度高、不同主题近正交（KB 自检索的向量层前提）
	mock := NewMockProvider(1, "m")
	vecs, _, _ := mock.Embed(context.Background(), []string{"量子计算的基本原理与应用前景", "量子计算应用前景广阔", "红烧肉的传统做法与火候"})
	a1, a2, b := vecs[0], vecs[1], vecs[2]
	cos := func(x, y []float32) float64 {
		var d float64
		for i := range x {
			d += float64(x[i]) * float64(y[i])
		}
		return d
	}
	if cos(a1, a2) < 0.3 {
		t.Fatalf("同主题相似度应 ≥0.3: %f", cos(a1, a2))
	}
	if cos(a1, b) > 0.15 {
		t.Fatalf("不同主题应近正交: %f", cos(a1, b))
	}
	// 确定性
	vecs2, _, _ := mock.Embed(context.Background(), []string{"量子计算的基本原理与应用前景"})
	a1b := vecs2[0]
	if cos(a1, a1b) < 0.999 {
		t.Fatalf("同文本应同向量: %f", cos(a1, a1b))
	}
}
