package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/baobaochat/server/internal/platform/authjwt"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// 中间件链顺序：按 D02 §6 固定（trace→recovery→rate-limit→auth→tenant）
func TestChainOrder(t *testing.T) {
	var order []string
	mk := func(name string) Middleware {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		}
	}
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "handler")
		w.WriteHeader(http.StatusOK)
	}), mk("trace"), mk("recovery"), mk("ratelimit"), mk("auth"), mk("tenant"))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	want := []string{"trace", "recovery", "ratelimit", "auth", "tenant", "handler"}
	if len(order) != len(want) {
		t.Fatalf("顺序 %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("顺序 %v, want %v", order, want)
		}
	}
}

func TestTraceAndEnvelope(t *testing.T) {
	h := Trace(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		OK(w, r, map[string]string{"k": "v"})
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if rec.Header().Get(TraceIDHeader) == "" {
		t.Fatal("响应头应带 X-Trace-Id")
	}
	var body Body
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != 0 || body.TraceID == "" || body.Data == nil {
		t.Fatalf("响应包不合规: %+v", body)
	}
}

func TestFailEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(TraceIDContext(r.Context(), "abc123"))
	Fail(rec, r, errx.New(errx.CodeIMContentTooLong, "消息内容超过长度限制"))

	if rec.Code != http.StatusBadRequest { // 3xxx → 400
		t.Fatalf("status=%d", rec.Code)
	}
	var body Body
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Code != 3004 || body.Message == "" || body.TraceID != "abc123" {
		t.Fatalf("失败响应包不合规: %+v", body)
	}
}

func TestRecovery(t *testing.T) {
	h := Recovery(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d", rec.Code)
	}
	var body Body
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Code != errx.CodeInternal {
		t.Fatalf("panic 应映射 9004, got %d", body.Code)
	}
}

// 表驱动：Auth 中间件 1003/1004 语义（D02 §6）
func TestAuthMiddleware(t *testing.T) {
	signer := authjwt.NewSigner([]byte("0123456789abcdef0123456789abcdef"))
	valid, _ := signer.Sign(authjwt.Claims{Subject: "10001", TenantID: 1, JWTID: "j1", ExpiresAt: time.Now().Add(time.Minute).Unix()})
	expired, _ := signer.Sign(authjwt.Claims{Subject: "10001", JWTID: "j2", ExpiresAt: time.Now().Add(-time.Minute).Unix()})
	verify := func(ctx context.Context, tok string) (*authjwt.Claims, error) { return signer.Parse(tok) }

	cases := []struct {
		name     string
		auth     string
		wantCode errx.Code
		wantIn   bool // 期望 claims 进入 handler
	}{
		{"缺头", "", errx.CodeAuthTokenRevoked, false},
		{"非 Bearer", "Basic zzz", errx.CodeAuthTokenRevoked, false},
		{"过期", "Bearer " + expired, errx.CodeAuthTokenExpired, false},
		{"签名非法", "Bearer a.b.c", errx.CodeAuthTokenRevoked, false},
		{"合法", "Bearer " + valid, errx.CodeOK, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var gotIn bool
			h := Auth(verify)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if Claims(r.Context()) != nil {
					gotIn = true
				}
				OK(w, r, nil)
			}))
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if c.auth != "" {
				req.Header.Set("Authorization", c.auth)
			}
			h.ServeHTTP(rec, req)

			var body Body
			_ = json.Unmarshal(rec.Body.Bytes(), &body)
			if body.Code != c.wantCode {
				t.Fatalf("code=%d want=%d", body.Code, c.wantCode)
			}
			if gotIn != c.wantIn {
				t.Fatalf("claims 注入=%v want=%v", gotIn, c.wantIn)
			}
		})
	}
}

func TestTenantMiddleware(t *testing.T) {
	h := Tenant(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if TenantID(r.Context()) != 7 {
			t.Fatalf("tenant 注入失败: %d", TenantID(r.Context()))
		}
		OK(w, r, nil)
	}))
	// 无 claims → 401
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 claims 应 401, got %d", rec.Code)
	}
	// 有 claims → 注入
	rec2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodGet, "/", nil)
	r2 = r2.WithContext(ClaimsContext(r2.Context(), &authjwt.Claims{TenantID: 7}))
	h.ServeHTTP(rec2, r2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("有 claims 应放行, got %d", rec2.Code)
	}
}

func TestRateLimitMiddleware(t *testing.T) {
	l := NewLimiter(1, 2) // 每秒 1 个，突发 2
	now := time.Unix(1760000000, 0)
	l.now = func() time.Time { return now }
	keyFn := func(r *http.Request) string { return "ip-1" }
	h := RateLimit(l, keyFn)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		OK(w, r, nil)
	}))

	// 前两次放行
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次应放行, got %d", i+1, rec.Code)
		}
	}
	// 第三次 429 + Retry-After + 9003
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第三次应 429, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" || rec.Header().Get("X-RateLimit-Remaining") != "0" {
		t.Fatal("限流响应头缺失")
	}
	var body Body
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Code != errx.CodeRateLimited {
		t.Fatalf("应映射 9003, got %d", body.Code)
	}

	// 时间前进 1s → 补充 1 个令牌
	now = now.Add(time.Second)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("补充后应放行, got %d", rec2.Code)
	}

	// 不同 key 互不影响（新 key 自动获得满桶突发额度）
	h3 := RateLimit(l, func(*http.Request) string { return "ip-2" })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { OK(w, r, nil) }))
	rec3 := httptest.NewRecorder()
	h3.ServeHTTP(rec3, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec3.Code != http.StatusOK {
		t.Fatalf("其他 key 应独立限流, got %d", rec3.Code)
	}
}
