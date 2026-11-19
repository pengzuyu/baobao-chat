// 路由层与控制面（docs/19 §3.2/§3.3/§4.2/§4.6/§6.7）：
// 档位别名 → 候选供应商序列；p: 直达引用解析（0023 多供应商）；
// 入口令牌桶（8050）；月度 token 配额（8005）；
// 计量内存累加 + 小时表 upsert（表见迁移 0003，DB 缺席时仅内存）。
package aigw

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	errx "github.com/baobaochat/server/internal/platform/errors"
)

// 档位别名（§3.2：调用方只允许别名或 p: 引用；具体模型名 9001、未知别名 8052）
const (
	AliasFast   = "bbc-fast"
	AliasStrong = "bbc-strong"
	AliasEmbed  = "bbc-embed"
	AliasRerank = "bbc-rerank" // D24：kb 重排档（/v1/rerank；mock 词面重叠兜底）
	// RefPrefix 直达引用前缀：p:<provider_id>:<model>（0023 表驱动多供应商）
	RefPrefix = "p:"
)

// Candidate 候选（§3.3 版本化路由表条目；表驱动/环境兜底两装配共用）
type Candidate struct {
	Provider Provider
	Model    string // 该候选上游具体模型名（空=provider 自行按档位映射，env 兜底装配路径）
	Priority int    // 小者先
}

// providerEntry 表驱动供应商登记项（p: 引用解析的元数据面）
type providerEntry struct {
	prov   Provider
	owner  *int64 // nil=公司级（全员可用其下模型）；非 nil=个人 BYOK（仅 owner）
	tenant *int64 // nil=平台级（任意租户）；否则须与调用方租户一致
	models []ModelDef
}

// Router 档位路由 + 直达引用（默认表；租户覆盖/灰度/熔断状态机阶段二接 Redis §7.6）
type Router struct {
	mu        sync.RWMutex
	tier      map[string][]Candidate   // fast/strong/embed
	providers map[int64]*providerEntry // 表驱动池（registry.Reload 装配；env/mock 装配不进池）
}

// NewRouter 装配：mock 恒可用；上游经环境注入后按优先级排前（§3.3 私有/直连优先原则不适用 v0.1，取"真实上游优先于 mock"）
func NewRouter(mock Provider, upstream *OpenAICompatProvider) *Router {
	r := &Router{tier: map[string][]Candidate{}, providers: map[int64]*providerEntry{}}
	chat := []Candidate{{Provider: mock, Priority: 10}}
	if upstream != nil && upstream.Cfg.Models["strong"] != "" {
		chat = append([]Candidate{{Provider: upstream, Priority: 1}}, chat...)
	}
	fast := []Candidate{{Provider: mock, Priority: 10}}
	if upstream != nil && upstream.Cfg.Models["fast"] != "" {
		fast = append([]Candidate{{Provider: upstream, Priority: 1}}, fast...)
	}
	r.tier["strong"] = chat
	r.tier["fast"] = fast
	// embed/rerank：mock 兜底恒可用（联调零配置）；管理端配表路由后由 Reload 覆盖
	// （registry 放开 embed/rerank 档表驱动——D24 N3a：管理员可配嵌入/重排供应商）
	r.tier["embed"] = []Candidate{{Provider: mock, Priority: 1}}
	r.tier["rerank"] = []Candidate{{Provider: mock, Priority: 1}}
	return r
}

// Route 选主：按优先级（v0.1 无熔断态，逐候选尝试由 handler 承担 §4.4 降级链）
func (r *Router) Route(alias string) ([]Candidate, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.tier[tierOf(alias)]
	return c, ok
}

// SetTier 表驱动装配：替换档位候选（registry.Reload 调用；fast/strong/embed/rerank 四档）
func (r *Router) SetTier(tier string, cands []Candidate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tier[tier] = cands
}

// SetProviders 表驱动装配：整体替换供应商池（registry.Reload 调用）
func (r *Router) SetProviders(entries map[int64]*providerEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers = entries
}

// EntryOf 供应商池查询（me/settings 校验与 DTO 组装共用；不存在返回 nil）
func (r *Router) EntryOf(id int64) *providerEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.providers[id]
}

// ResolveFor model 解析统一入口（§3.2 引用扩展，0023）：
//
//	bbc-fast/bbc-strong → 档位路由（表驱动 active 路由，无则 env/mock 兜底装配）
//	p:<id>:<model>      → 直达引用：存在且启用（8053）→ 公司级或本人（8054）→ 清单内（8055）
//	其余                → 8052（bbc- 未知别名）/ 9001（具体模型名绕过路由）
func (r *Router) ResolveFor(tenant, uid int64, model string) ([]Candidate, error) {
	if model == "" {
		return nil, errx.New(errx.CodeBadRequest, "model 必填")
	}
	if model == AliasFast || model == AliasStrong {
		r.mu.RLock()
		c, ok := r.tier[tierOf(model)]
		r.mu.RUnlock()
		if !ok || len(c) == 0 {
			return nil, errx.New(errx.CodeAIGWRouteNotDefined, "路由档位未配置: "+model)
		}
		return c, nil
	}
	if !strings.HasPrefix(model, RefPrefix) {
		if strings.HasPrefix(model, "bbc-") {
			return nil, errx.New(errx.CodeAIGWRouteNotDefined, "路由档位未配置: "+model)
		}
		return nil, errx.New(errx.CodeBadRequest, "model 仅允许档位别名（bbc-fast/bbc-strong）或直达引用（p:<供应商ID>:<模型>）")
	}
	parts := strings.SplitN(model, ":", 3)
	if len(parts) != 3 || parts[1] == "" || parts[2] == "" {
		return nil, errx.New(errx.CodeBadRequest, "直达引用格式: p:<供应商ID>:<模型>")
	}
	pid, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || pid <= 0 {
		return nil, errx.New(errx.CodeBadRequest, "直达引用的供应商ID须为正整数")
	}
	r.mu.RLock()
	e := r.providers[pid]
	r.mu.RUnlock()
	if e == nil || (e.tenant != nil && *e.tenant != tenant) {
		// 跨租户/不存在/已停用同判 8053（防探测）
		return nil, errx.New(errx.CodeAIGWProviderNotFound, "供应商不存在或已停用: "+parts[1])
	}
	if e.owner != nil && *e.owner != uid {
		return nil, errx.New(errx.CodeAIGWProviderForbidden, "无权引用该供应商（非公司级且非本人）")
	}
	for _, m := range e.models {
		if m.ID == parts[2] {
			return []Candidate{{Provider: e.prov, Model: parts[2]}}, nil
		}
	}
	return nil, errx.New(errx.CodeAIGWModelNotAllowed, "模型不在该供应商清单内: "+parts[2])
}

// ---- 入口限流（§4.1-②：租户×用户令牌桶，8050 附 Retry-After）----

// Limiter 每用户令牌桶（内存版；Redis 版阶段二多副本共享）
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // 每秒补充
	burst   float64
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter 构造（默认 30 次/分钟突发 10：Agent 会话档口径）
func NewLimiter(ratePerMin, burst float64) *Limiter {
	if ratePerMin <= 0 {
		ratePerMin = 30
	}
	if burst <= 0 {
		burst = 10
	}
	return &Limiter{buckets: map[string]*bucket{}, rate: ratePerMin / 60.0, burst: burst}
}

// Allow 取一令牌；拒绝时返回建议等待秒数（Retry-After）
func (l *Limiter) Allow(key string) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		l.buckets[key] = &bucket{tokens: l.burst - 1, last: now}
		return true, 0
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := int((1 - b.tokens) / l.rate)
	if wait < 1 {
		wait = 1
	}
	return false, wait
}

// ---- 月度配额（§4.6：请求前查；超限 8005；Redis 计数阶段二，小时表对账）----

// Quota 内存月度 token 配额（subject=tenant:user 粒度；limit<=0 不限）
type Quota struct {
	mu    sync.Mutex
	used  map[string]int64
	limit int64
}

// NewQuota 构造（limit<=0 = 不限量）
func NewQuota(limit int64) *Quota {
	return &Quota{used: map[string]int64{}, limit: limit}
}

// Check 请求前检查（§4.6）
func (q *Quota) Check(subject string) bool {
	if q.limit <= 0 {
		return true
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.used[subject] < q.limit
}

// Add 计量回填
func (q *Quota) Add(subject string, tokens int64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.used[subject] += tokens
}

// UsedOf 测试/观测探针
func (q *Quota) UsedOf(subject string) int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.used[subject]
}

// ---- 计量开票（§6.7：请求开票 → 内存聚合 → 小时表 upsert；正文不落库 §7.3）----

// MeterDim 计量维度（UK 对齐 ai_usage_hourly）
type MeterDim struct {
	Tenant   int64
	User     int64
	Svc      string // svc:kb；用户调用空
	Session  string // X-BBC-Agent-Session
	Scene    string // chat/embed/rerank/expert
	Tier     string
	Provider int64
}

// HourSink 小时表写入端（module.go 用 pgxpool 适配；测试/内存模式为 nil）
type HourSink interface {
	ExecUpsert(ctx context.Context, dim MeterDim, hour time.Time, requests, prompt, completion, errors int64) error
}

// Meter 使用量累加器
type Meter struct {
	mu    sync.Mutex
	rows  map[MeterDim]*meterRow
	sink  HourSink // 可空：仅内存聚合
	idSeq atomic.Int64
}

type meterRow struct {
	Requests    int64
	Prompt      int64
	Completion  int64
	Errors      int64
	UpdatedHour time.Time
}

// NewMeter 构造（sink 可空 → 仅内存）
func NewMeter(sink HourSink) *Meter {
	return &Meter{rows: map[MeterDim]*meterRow{}, sink: sink}
}

// Invoice 开票（tokens 实际值；hour 截断对齐 UK）
func (m *Meter) Invoice(dim MeterDim, prompt, completion int64, isErr bool) {
	m.mu.Lock()
	hour := time.Now().UTC().Truncate(time.Hour)
	row, ok := m.rows[dim]
	if !ok || !row.UpdatedHour.Equal(hour) {
		row = &meterRow{UpdatedHour: hour}
		m.rows[dim] = row
	}
	row.Requests++
	row.Prompt += prompt
	row.Completion += completion
	if isErr {
		row.Errors++
	}
	m.mu.Unlock()
	if m.sink != nil {
		_ = m.sink.ExecUpsert(context.Background(), dim, row.UpdatedHour, row.Requests, row.Prompt, row.Completion, row.Errors)
	}
}

// Snapshot 观测/测试探针（聚合行拷贝）
func (m *Meter) Snapshot() map[MeterDim]meterRow {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[MeterDim]meterRow, len(m.rows))
	for k, v := range m.rows {
		out[k] = *v
	}
	return out
}

var _ = context.Background // 保留 ctx 导入位（flush 异步化阶段二）
