package httpx

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	errx "github.com/baobaochat/server/internal/platform/errors"
)

// Limiter 内存令牌桶限流（阶段一单机；多实例后换 Redis，键分 租户/用户/Agent 三档——D02 §6）
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64          // 每秒补充令牌数
	burst   int              // 桶容量
	now     func() time.Time // 可注入时钟（测试）
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter rate=每秒令牌，burst=峰值额度
func NewLimiter(rate float64, burst int) *Limiter {
	return &Limiter{
		buckets: map[string]*bucket{},
		rate:    rate,
		burst:   burst,
		now:     time.Now,
	}
}

// Allow 取令牌；返回是否放行、建议重试等待、剩余额度
func (l *Limiter) Allow(key string) (bool, time.Duration, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(l.burst), last: now}
		l.buckets[key] = b
	} else {
		// 按流逝时间补充令牌，封顶 burst
		b.tokens = math.Min(float64(l.burst), b.tokens+now.Sub(b.last).Seconds()*l.rate)
	}
	b.last = now
	if b.tokens < 1 {
		retry := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
		return false, retry, 0
	}
	b.tokens--
	return true, 0, int(b.tokens)
}

// RateLimit 限流中间件；keyFn 提取限流键（IP/用户/Agent 三档由装配处决定）
func RateLimit(l *Limiter, keyFn func(r *http.Request) string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ok, retry, remaining := l.Allow(keyFn(r))
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
			if !ok {
				w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retry.Seconds()))))
				Fail(w, r, errx.NewWithDetails(errx.CodeRateLimited, "rate limited", map[string]int{
					"retry_after_seconds": int(math.Ceil(retry.Seconds())),
				}))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ClientIP 取对端 IP（RemoteAddr 去端口；反代场景阶段二接 X-Forwarded-For 白名单）
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
