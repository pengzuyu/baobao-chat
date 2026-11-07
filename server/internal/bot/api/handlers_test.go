// 壳层测试：/hook/bot/{hook_id} 端点（签名即凭证，无 JWT）与管理面路由
// （经 httpx.Auth 仿真链注入 claims——与 main 真实挂载同构）。
package botapi_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	botapi "github.com/baobaowork/server/internal/bot/api"
	"github.com/baobaowork/server/internal/bot/repo"
	botservice "github.com/baobaowork/server/internal/bot/service"
	"github.com/baobaowork/server/internal/platform/authjwt"
	"github.com/baobaowork/server/internal/platform/httpx"
)

func newTestService(t *testing.T) (botapi.BotService, *botservice.Options) {
	t.Helper()
	now := time.Unix(1760000000, 0)
	opts := botservice.Options{
		CreateUser: func(context.Context, int64, string) (int64, error) { return 777, nil },
		MemberRole: func(_ context.Context, convID, userID int64) int {
			if convID == 9 && userID == 777 {
				return botapi.MemberRoleBot // 默认会话内 bot 已安装
			}
			return 0
		},
		AddMember: func(context.Context, int64, int64, int) error { return nil },
		SendMsg: func(context.Context, int64, int64, string, json.RawMessage, []string) (int64, int64, error) {
			return 501, 13, nil
		},
		Now: func() time.Time { return now },
	}
	return botservice.NewService(opts, botrepo.NewMemory()), &opts
}

// ready 建 bot→启用→装 webhook（经服务面走真实路径）
func ready(t *testing.T, svc botapi.BotService) *botapi.SecretReveal {
	t.Helper()
	ctx := context.Background()
	b, err := svc.CreateBot(ctx, 1, 42, botapi.CreateBotReq{Name: "CI 助手"})
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	if err := svc.SetBotStatus(ctx, 1, 42, b.ID, true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	_, reveal, err := svc.CreateIncomingWebhook(ctx, 1, b.ID, botapi.CreateWebhookReq{DefaultConvID: 9})
	if err != nil {
		t.Fatalf("webhook: %v", err)
	}
	return reveal
}

func signHex(secret, ts string, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func postHook(t *testing.T, svc botapi.BotService, reveal *botapi.SecretReveal, ts, sig, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/hook/bot/"+reveal.HookID, strings.NewReader(body))
	req.SetPathValue("hook_id", reveal.HookID)
	req.Header.Set("X-BBW-Timestamp", ts)
	req.Header.Set("X-BBW-Signature", sig)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	botapi.HandleHookDeliver(svc)(rec, req)
	return rec
}

func TestHookEndpointDelivers(t *testing.T) {
	svc, _ := newTestService(t)
	reveal := ready(t, svc)
	body := `{"msg_type":"text","target":{"conv_id":"9"},"text":"构建完成"}`
	ts := "1760000000" // 服务层固定时钟（newTestService Now）
	rec := postHook(t, svc, reveal, ts, signHex(reveal.Secret, ts, body), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("投递应 200: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Code int `json:"code"`
		Data struct {
			MsgID string `json:"msg_id"`
			Seq   int64  `json:"seq"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("回包: %v", err)
	}
	if resp.Code != 0 || resp.Data.MsgID != "501" || resp.Data.Seq != 13 {
		t.Fatalf("回包内容: %s", rec.Body.String())
	}
}

func TestHookEndpointBadSignature403(t *testing.T) {
	svc, _ := newTestService(t)
	reveal := ready(t, svc)
	body := `{"msg_type":"text","text":"x"}`
	rec := postHook(t, svc, reveal, "1760000000", "sha256="+strings.Repeat("0", 64), body)
	if rec.Code == http.StatusOK {
		t.Fatal("坏签名不得 200")
	}
	if !strings.Contains(rec.Body.String(), "3030") {
		t.Fatalf("应含 3030: %s", rec.Body.String())
	}
}

func TestHookEndpointGetRejected(t *testing.T) {
	svc, _ := newTestService(t)
	req := httptest.NewRequest(http.MethodGet, "/hook/bot/x", nil)
	rec := httptest.NewRecorder()
	botapi.HandleHookDeliver(svc)(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET 应 405: %d", rec.Code)
	}
}

// 仿真 main 的 authed 链（httpx.Auth + httpx.Tenant），claims 走 stub verifier
func authedStub() func(http.HandlerFunc) http.Handler {
	verify := func(_ context.Context, _ string) (*authjwt.Claims, error) {
		return &authjwt.Claims{Subject: "42", TenantID: 1}, nil
	}
	return func(h http.HandlerFunc) http.Handler {
		return httpx.Chain(h, httpx.Auth(httpx.TokenVerifier(verify)), httpx.Tenant)
	}
}

func TestAdminRoutesCreateAndList(t *testing.T) {
	svc, _ := newTestService(t)
	mux := http.NewServeMux()
	botapi.RegisterAdminRoutes(mux, authedStub(), svc)

	// 创建
	req := httptest.NewRequest(http.MethodPost, "/api/v1/bots", strings.NewReader(`{"name":"值班 bot"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("创建应 200: %d %s", rec.Code, rec.Body.String())
	}
	// 列表
	req = httptest.NewRequest(http.MethodGet, "/api/v1/bots", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "值班 bot") {
		t.Fatalf("列表应含新 bot: %d %s", rec.Code, rec.Body.String())
	}
	// webhook 创建（一次性 secret 回显）
	req = httptest.NewRequest(http.MethodPost, "/api/v1/bots/101/webhooks",
		strings.NewReader(`{"default_conv_id":9}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "secret") {
		t.Fatalf("webhook 创建应回 secret: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminRoutesRequireAuth(t *testing.T) {
	svc, _ := newTestService(t)
	mux := http.NewServeMux()
	deny := func(_ context.Context, _ string) (*authjwt.Claims, error) {
		return nil, errors.New("bad token")
	}
	botapi.RegisterAdminRoutes(mux, func(h http.HandlerFunc) http.Handler {
		return httpx.Chain(h, httpx.Auth(httpx.TokenVerifier(deny)), httpx.Tenant)
	}, svc)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bots", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatal("鉴权失败不得 200")
	}
}
