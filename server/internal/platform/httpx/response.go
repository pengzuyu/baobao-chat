// Package httpx 统一 REST 响应包与中间件链（14 篇 §5.2 / D02 §6）。
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"

	errx "github.com/baobaochat/server/internal/platform/errors"
)

// TraceIDHeader 响应头回传 trace_id（14 篇 §7：9004/9005 靠 trace_id 排查）
const TraceIDHeader = "X-Trace-Id"

// 上下文键（不导出类型，防跨包伪造）
type ctxKey int

const (
	ctxTraceID ctxKey = iota
	ctxClaims
	ctxTenantID
)

// TraceIDContext 注入 trace_id
func TraceIDContext(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxTraceID, id)
}

// TraceID 取当前 trace_id（无则空串）
func TraceID(ctx context.Context) string {
	if v, ok := ctx.Value(ctxTraceID).(string); ok {
		return v
	}
	return ""
}

func newTraceID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "trace-unknown"
	}
	return hex.EncodeToString(b)
}

// Body 统一响应包：成功 {code:0,data,trace_id}；失败 {code,message,details,trace_id}
type Body struct {
	Code    errx.Code `json:"code"`
	Data    any       `json:"data,omitempty"`
	Message string    `json:"message,omitempty"`
	Details any       `json:"details,omitempty"`
	TraceID string    `json:"trace_id"`
}

// OK 200 + code 0
func OK(w http.ResponseWriter, r *http.Request, data any) {
	write(w, r, http.StatusOK, errx.CodeOK, data, "")
}

// Fail 业务失败：错误归一化 + 按错误码段映射 HTTP 状态。
// 服务端错段（9xxx）同步落详情日志：归一化对客户端吃掉内部细节（14 篇 §7 安全口径），
// 「靠 trace_id 排查」必须由日志侧补全原始错误，否则 trace_id 无从查起
// （2026-11-27 客户端发布验签 9004 事故的排查卡点：访问日志只有一行 500）。
func Fail(w http.ResponseWriter, r *http.Request, err error) {
	e := errx.From(err)
	if e.Code >= 9000 {
		log.Printf("[http] %s %s %d trace=%s err=%v", r.Method, r.URL.Path, HTTPStatus(e.Code), TraceID(r.Context()), err)
	}
	write(w, r, HTTPStatus(e.Code), e.Code, nil, e.Msg)
}

func write(w http.ResponseWriter, r *http.Request, status int, code errx.Code, data any, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Body{Code: code, Data: data, Message: msg, TraceID: TraceID(r.Context())})
}

// HTTPStatus 错误码段 → HTTP 状态（段语义见 14 篇 §7）
func HTTPStatus(code errx.Code) int {
	switch {
	case code == errx.CodeOK:
		return http.StatusOK
	case code >= 1000 && code < 2000:
		return http.StatusUnauthorized
	case code >= 2000 && code < 3000:
		return http.StatusForbidden
	case code == errx.CodeRateLimited:
		return http.StatusTooManyRequests
	case code == errx.CodeNotFound:
		return http.StatusNotFound
	case code == errx.CodeDependencyDown:
		return http.StatusServiceUnavailable
	case code == errx.CodeInternal:
		return http.StatusInternalServerError
	default:
		return http.StatusBadRequest
	}
}
