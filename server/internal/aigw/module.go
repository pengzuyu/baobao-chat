// Package aigw AI 网关模块装配（docs/19）：
// 装配优先级（0023）：ai_provider/ai_route_rule 表驱动 → 环境注入（BBW_AIGW_*）→ mock 兜底；
// 限流/配额/计量 → Gateway HTTP 接入层。
package aigw

import (
	"context"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/baobaowork/server/internal/platform/authjwt"
	"github.com/baobaowork/server/internal/platform/kms"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Options 环境装配项（默认 < 环境变量）
type Options struct {
	DevToken      string // BBW_AIGW_DEV_TOKEN：开发/联调令牌（空=禁用）
	MonthlyTokens int64  // BBW_AIGW_MONTHLY_TOKENS：月度 token 配额（0=不限）
	RatePerMin    float64
	Burst         float64
	// AgentKillOn 平台总闸（D9；main 注入 admin 域——on 时 OBO 请求 503）
	AgentKillOn func() bool
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
	Gateway  *Gateway
	Router   *Router
	Registry *Registry // 表驱动注册表（内存模式 nil——CRUD 不可用，走 env/mock）
	Meter    *Meter
	Quota    *Quota
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

// NewModule 装配（pool 可空 → 计量仅内存、无表驱动注册表；verify 为 auth 域校验函数，
// 可为 nil=仅开发令牌通道）
func NewModule(pool *pgxpool.Pool, verify func(token string) (*authjwt.Claims, error), agentKillOn func() bool) *Module {
	opts := loadOptions()
	opts.AgentKillOn = agentKillOn
	mock := NewMockProvider(1, "mock-echo")
	upstream := envLoadOpenAICompat()
	router := NewRouter(mock, upstream)
	meter := NewMeter(nil)
	var reg *Registry
	if pool != nil {
		meter = NewMeter(pgxHourSink{pool: pool})
		k, err := kms.New(os.Getenv("BBW_KMS_MASTER_KEY"))
		if err != nil {
			log.Fatalf("[aigw] BBW_KMS_MASTER_KEY 非法（需 base64(32B)，openssl rand -base64 32）: %v", err)
		}
		if k == nil {
			log.Println("[aigw] 未配置 BBW_KMS_MASTER_KEY：带密钥的供应商无法创建/装配（无密钥上游不受影响）")
		}
		reg = NewRegistry(pool, router, k, 1) // v0.1 单租户=1；多租户分桶阶段二
		if err := reg.Reload(context.Background()); err != nil {
			log.Printf("[aigw] 表驱动装配失败，降级 env/mock 装配: %v", err)
		} else {
			router.mu.RLock()
			n := len(router.providers)
			router.mu.RUnlock()
			if n > 0 {
				log.Printf("[aigw] 表驱动装配：供应商池 %d 个（fast/strong active 路由生效）", n)
			}
		}
	}
	gw := NewGateway(verify, router, NewLimiter(opts.RatePerMin, opts.Burst), NewQuota(opts.MonthlyTokens), meter, opts.DevToken, opts.AgentKillOn)
	return &Module{Gateway: gw, Router: router, Registry: reg, Meter: meter, Quota: nil}
}
