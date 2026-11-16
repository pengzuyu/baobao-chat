package httpx

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/baobaochat/server/internal/platform/authjwt"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// Middleware 标准 HTTP 中间件
type Middleware func(http.Handler) http.Handler

// Chain 依序包裹：mw[0] 最外层。
// 固定顺序（D02 §6）：trace → recovery → access-log → rate-limit → auth → tenant → perm(占位)
func Chain(h http.Handler, mw ...Middleware) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

// Trace 生成/透传 trace_id 并注入 ctx 与响应头
func Trace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(TraceIDHeader)
		if id == "" {
			id = newTraceID()
		}
		w.Header().Set(TraceIDHeader, id)
		next.ServeHTTP(w, r.WithContext(TraceIDContext(r.Context(), id)))
	})
}

// Recovery panic 兜底：不外泄栈，只回 9004 + trace_id
func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[panic] trace=%s %s %s: %v\n%s", TraceID(r.Context()), r.Method, r.URL.Path, rec, debug.Stack())
				Fail(w, r, errx.New(errx.CodeInternal, "internal error"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// AccessLog 访问日志（阶段一 stdout；阶段二结构化+采样）
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("[http] %s %s %d %s trace=%s", r.Method, r.URL.Path, rec.status, time.Since(start), TraceID(r.Context()))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Hijack 透传：WS Upgrade 需要接管连接，包装层不实现 Hijacker 会把 /ws/connect 打死
// （http.Hijacker 断言失败 → "response writer not hijackable"）
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf(" underlying ResponseWriter 不支持 Hijack: %T", s.ResponseWriter)
	}
	return hj.Hijack()
}

// TokenVerifier 令牌校验函数（装配处注入 signer.Parse 的适配）
type TokenVerifier func(ctx context.Context, token string) (*authjwt.Claims, error)

// ClaimsContext / Claims 读写鉴权结果
func ClaimsContext(ctx context.Context, c *authjwt.Claims) context.Context {
	return context.WithValue(ctx, ctxClaims, c)
}

func Claims(ctx context.Context) *authjwt.Claims {
	if v, ok := ctx.Value(ctxClaims).(*authjwt.Claims); ok {
		return v
	}
	return nil
}

// TenantIDContext / TenantID 租户上下文
func TenantIDContext(ctx context.Context, tid int64) context.Context {
	return context.WithValue(ctx, ctxTenantID, tid)
}

func TenantID(ctx context.Context) int64 {
	if v, ok := ctx.Value(ctxTenantID).(int64); ok {
		return v
	}
	return 0
}

// Auth Bearer 校验：过期拒 1003，其余无效拒 1004（D02 §6）
func Auth(verify TokenVerifier) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := r.Header.Get("Authorization")
			const prefix = "Bearer "
			if !strings.HasPrefix(h, prefix) {
				Fail(w, r, errx.New(errx.CodeAuthTokenRevoked, "missing bearer token"))
				return
			}
			claims, err := verify(r.Context(), strings.TrimPrefix(h, prefix))
			if err != nil {
				if err == authjwt.ErrExpired {
					Fail(w, r, errx.New(errx.CodeAuthTokenExpired, "token expired"))
				} else {
					Fail(w, r, errx.New(errx.CodeAuthTokenRevoked, "token invalid"))
				}
				return
			}
			next.ServeHTTP(w, r.WithContext(ClaimsContext(r.Context(), claims)))
		})
	}
}

// Tenant 租户注入占位：从 claims 取 tenant 进 ctx。
// TODO(阶段二)：PG 连接池按请求 SET app.tenant（RLS 会话变量，03 篇 §3.2）
func Tenant(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := Claims(r.Context())
		if c == nil {
			Fail(w, r, errx.New(errx.CodeAuthTokenRevoked, "no claims"))
			return
		}
		next.ServeHTTP(w, r.WithContext(TenantIDContext(r.Context(), c.TenantID)))
	})
}
