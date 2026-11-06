// Package aigw AI 网关模块装配（docs/19）：
// 环境注入（BBW_AIGW_*）→ 路由/限流/配额/计量 → Gateway HTTP 接入层。
package aigw

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/baobaowork/server/internal/platform/authjwt"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Options 环境装配项（默认 < 环境变量）
type Options struct {
	DevToken      string // BBW_AIGW_DEV_TOKEN：开发/联调令牌（空=禁用）
	MonthlyTokens int64  // BBW_AIGW_MONTHLY_TOKENS：月度 token 配额（0=不限）
	RatePerMin    float64
	Burst         float64
}

func loadOptions() Options {
	o := Options{DevToken: os.Getenv("BBW_AIGW_DEV_TOKEN"), RatePerMin: 30, Burst: 10}
	if v, err := strconv.ParseInt(os.Getenv("BBW_AIGW_MONTHLY_TOKENS"), 10, 64); err == nil && v > 0 {
		o.MonthlyTokens = v
	}
	if v, err := strconv.ParseFloat(os.Getenv("BBW_AIGW_RATE_PER_MIN"), 64); err == nil && v > 0 {
		o.RatePerMin = v
	}
	if v, err := strconv.ParseFloat(os.Getenv("BBW_AIGW_BURST"), 64); err == nil && v > 0 {
		o.Burst = v
	}
	return o
}

// Module 网关模块外壳
type Module struct {
	Gateway *Gateway
	Router  *Router
	Meter   *Meter
	Quota   *Quota
}

// pgxHourSink pgxpool 小时表写入适配
type pgxHourSink struct{ pool *pgxpool.Pool }

// ExecUpsert ai_usage_hourly 聚合 upsert（id=毫秒时间戳*1000+序号，PK 冲突概率可忽略）
func (s pgxHourSink) ExecUpsert(ctx context.Context, dim MeterDim, hour time.Time, requests, prompt, completion, errs int64) error {
	id := time.Now().UnixMilli()*1000 + (dim.Provider % 1000)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ai_usage_hourly (id, tenant_id, hour_bucket, user_id, svc_subject, session_id, scene, tier, provider_id,
			requests, prompt_tokens, completion_tokens, total_tokens, errors)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11+$12, $13)
		ON CONFLICT (tenant_id, hour_bucket, user_id, svc_subject, session_id, scene, tier, provider_id)
		DO UPDATE SET requests = ai_usage_hourly.requests + EXCLUDED.requests,
			prompt_tokens = ai_usage_hourly.prompt_tokens + EXCLUDED.prompt_tokens,
			completion_tokens = ai_usage_hourly.completion_tokens + EXCLUDED.completion_tokens,
			total_tokens = ai_usage_hourly.total_tokens + EXCLUDED.total_tokens,
			errors = ai_usage_hourly.errors + EXCLUDED.errors,
			updated_at = now()`,
		id, dim.Tenant, hour, dim.User, dim.Svc, dim.Session, dim.Scene, dim.Tier, dim.Provider,
		requests, prompt, completion, errs)
	return err
}

// NewModule 装配（pool 可空 → 计量仅内存；verify 为 auth 域校验函数，可为 nil=仅开发令牌通道）
func NewModule(pool *pgxpool.Pool, verify func(token string) (*authjwt.Claims, error)) *Module {
	opts := loadOptions()
	mock := NewMockProvider(1, "mock-echo")
	upstream := envLoadOpenAICompat()
	router := NewRouter(mock, upstream)
	meter := NewMeter(nil)
	if pool != nil {
		meter = NewMeter(pgxHourSink{pool: pool})
	}
	gw := NewGateway(verify, router, NewLimiter(opts.RatePerMin, opts.Burst), NewQuota(opts.MonthlyTokens), meter, opts.DevToken)
	return &Module{Gateway: gw, Router: router, Meter: meter, Quota: nil}
}
