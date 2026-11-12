// 接入层（docs/19 §4.1/§6.1/§6.2/§6.3）：
// /v1/chat/completions（SSE 流式+非流式）与 /v1/embeddings；
// 鉴权（用户 JWT / OBO / 开发令牌）→ 限流 8050 → 配额 8005 → 路由 → 供应商 →
// SSE 透传 + X-BBW-Usage 终帧 + [DONE] → 计量开票。
package aigw

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/baobaowork/server/internal/platform/authjwt"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// Claims 入口身份（JWT 或开发令牌降级形态）
type Claims struct {
	Subject  string
	TenantID int64
	IsOBO    bool
	IsSvc    bool // sub 前缀 svc:
}

// Gateway HTTP 接入层
type Gateway struct {
	verify   func(token string) (*authjwt.Claims, error)
	router   *Router
	limiter  *Limiter
	quota    *Quota
	meter    *Meter
	devToken string // BBW_AIGW_DEV_TOKEN：开发/联调通道（空=禁用）
	// agentKillOn 平台总闸（D9：on → OBO 请求 503 拒；nil=未装配）
	agentKillOn func() bool
}

// NewGateway 装配（module.go 调用）
func NewGateway(verify func(token string) (*authjwt.Claims, error), router *Router, limiter *Limiter, quota *Quota, meter *Meter, devToken string, agentKillOn func() bool) *Gateway {
	return &Gateway{verify: verify, router: router, limiter: limiter, quota: quota, meter: meter, devToken: devToken, agentKillOn: agentKillOn}
}

// oboGate OBO 请求总闸（D9）：killswitch on → 503（非 OBO 请求不受影响）
func (g *Gateway) oboGate(who *Claims) error {
	if who.IsOBO && g.agentKillOn != nil && g.agentKillOn() {
		return errx.New(errx.CodeAuthOBOKillswitch, "Agent 平台总闸已拉下（紧急停止）")
	}
	return nil
}

// auth 提取并校验身份（§6.1：Bearer；开发令牌映射 dev 身份）
func (g *Gateway) auth(r *http.Request) (*Claims, error) {
	h := r.Header.Get("Authorization")
	token := strings.TrimSpace(strings.TrimPrefix(h, "Bearer"))
	if token == "" {
		return nil, errx.New(errx.CodeAuthTokenRevoked, "缺少 Bearer 令牌")
	}
	if g.devToken != "" && token == g.devToken {
		return &Claims{Subject: "dev-agent", TenantID: 1}, nil
	}
	if g.verify == nil {
		return nil, errx.New(errx.CodeAuthTokenRevoked, "网关未配置鉴权")
	}
	c, err := g.verify(token)
	if err != nil {
		return nil, err
	}
	return &Claims{Subject: c.Subject, TenantID: uid2Tenant(c.TenantID), IsOBO: c.IsOBO(), IsSvc: strings.HasPrefix(c.Subject, "svc:")}, nil
}

func uid2Tenant(t int64) int64 {
	if t <= 0 {
		return 1
	}
	return t
}

func uidOf(c *Claims) int64 {
	n, _ := strconv.ParseInt(c.Subject, 10, 64)
	return n
}

// writeErr OpenAI 风格错误体 + 本篇 8xxx code（§6.2）
func writeErr(w http.ResponseWriter, status int, code int, msg string, retryAfter int) {
	w.Header().Set("Content-Type", "application/json")
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"code": code, "message": msg, "type": "bbw_ai_gateway"},
	})
}

// HandleChat POST /v1/chat/completions
func (g *Gateway) HandleChat(w http.ResponseWriter, r *http.Request) {
	who, err := g.auth(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, int(errx.From(err).Code), "鉴权失败", 0)
		return
	}
	if gerr := g.oboGate(who); gerr != nil {
		writeErr(w, http.StatusServiceUnavailable, int(errx.From(gerr).Code), gerr.Error(), 30)
		return
	}
	var req ChatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 9001, "请求体非法", 0)
		return
	}
	// model 解析（§3.2 引用扩展，0023）：档位别名（表驱动路由，env/mock 兜底）或
	// p:<id>:<model> 直达引用（公司级或本人供应商 + 清单内校验，8053/8054/8055）
	alias := req.Model
	if alias == AliasEmbed { // chat 入口不接受 embed 档（维持既有口径）
		writeErr(w, http.StatusNotFound, 8052, "路由档位未配置: "+alias, 0)
		return
	}
	candidates, rerr := g.router.ResolveFor(who.TenantID, uidOf(who), alias)
	if rerr != nil {
		e := errx.From(rerr)
		writeErr(w, resolveStatus(e.Code), int(e.Code), e.Msg, 0)
		return
	}
	// 限流（8050 + Retry-After）
	if ok, wait := g.limiter.Allow(who.Subject); !ok {
		writeErr(w, http.StatusTooManyRequests, 8050, "网关限流", wait)
		return
	}
	// 配额（8005；subject=tenant:user 月度 token）
	quotaKey := fmt.Sprintf("%d:%s", who.TenantID, who.Subject)
	if !g.quota.Check(quotaKey) {
		writeErr(w, http.StatusForbidden, int(errx.CodeAgentModelQuota), "模型配额超限", 0)
		return
	}

	scene := headerOr(r, "X-BBW-Scene", "chat")
	session := r.Header.Get("X-BBW-Agent-Session")
	dim := MeterDim{Tenant: who.TenantID, User: uidOf(who), Svc: svcSubject(who), Session: session, Scene: scene, Tier: tierLabel(alias)}

	// 供应商链（§4.4：逐候选降级——以「首帧产出或错误」为选定依据：StreamChat 异步，
	// 连接失败/上游 5xx 在首帧前经 Err+close 暴露，此时切下一候选；全尽 8051(503)。
	// 候选命中后将具体模型名注入请求。TTFB 无超时（上游 hang=请求挂起，客户端超时兜底；
	// per-candidate TTFB 超时阶段二，19 篇 §4.2 熔断配套）
	var res *ProviderResult
	var replay string
	hasReplay := false
	for _, c := range candidates {
		creq := req
		if c.Model != "" {
			creq.Model = c.Model
		}
		r2 := c.Provider.StreamChat(r.Context(), &creq)
		f, ok := <-r2.Frames // 阻塞至首帧/关闭（goroutine 内先置 Err 再 close，happens-before）
		dim.Provider = c.Provider.ID()
		if !ok && r2.Err != nil {
			log.Printf("[aigw] 候选降级 provider=%d model=%s err=%v", c.Provider.ID(), creq.Model, r2.Err)
			continue // 本候选失败 → 降级下一候选
		}
		res = r2
		if ok {
			replay, hasReplay = f, true
		}
		break
	}
	if res == nil {
		writeErr(w, http.StatusServiceUnavailable, 8051, "供应商不可用（全部候选失败）", 0)
		return
	}
	// SSE 回传（§6.2：透传帧 → X-BBW-Usage 终帧 → [DONE]）
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-BBW-Request-Id", r.Header.Get("Idempotency-Key"))
	w.WriteHeader(http.StatusOK)

	var usage *UsageOpenAI
	failed := false
	emit := func(frame string) {
		if frame == "[DONE]" {
			return // 终止符由网关统一补发
		}
		if u := usageOfFrame(frame); u != nil {
			usage = u
		}
		fmt.Fprintf(w, "data: %s\n\n", frame)
		if flusher != nil {
			flusher.Flush()
		}
	}
	if hasReplay {
		emit(replay) // 选定候选时已取出的首帧
	}
	for frame := range res.Frames {
		emit(frame)
	}
	if res.Err != nil {
		// 流中失败：状态码已 200 不可改——以错误帧收束（调用方按断流/8051 语义处理）
		failed = true
		errFrame, _ := json.Marshal(map[string]any{
			"error": map[string]any{"code": 8051, "message": res.Err.Error(), "type": "bbw_ai_gateway"},
		})
		fmt.Fprintf(w, "data: %s\n\n", errFrame)
	}
	if usage == nil {
		usage = &UsageOpenAI{PromptTokens: estimateTokens(req.Messages), CompletionTokens: 0}
	}
	// 终帧（§6.2 X-BBW-Usage；request_id 对账口径）
	usageFrame, _ := json.Marshal(map[string]any{
		"request_id":        r.Header.Get("Idempotency-Key"),
		"prompt_tokens":     usage.PromptTokens,
		"completion_tokens": usage.CompletionTokens,
		"tier":              tierLabel(alias),
	})
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", usageFrame)
	if flusher != nil {
		flusher.Flush()
	}
	// 计量开票 + 配额回填
	g.meter.Invoice(dim, int64(usage.PromptTokens), int64(usage.CompletionTokens), failed)
	g.quota.Add(quotaKey, int64(usage.Total()))
}

// HandleEmbeddings POST /v1/embeddings（§6.3：bbw-embed，1024 维）
func (g *Gateway) HandleEmbeddings(w http.ResponseWriter, r *http.Request) {
	who, err := g.auth(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, int(errx.From(err).Code), "鉴权失败", 0)
		return
	}
	if gerr := g.oboGate(who); gerr != nil {
		writeErr(w, http.StatusServiceUnavailable, int(errx.From(gerr).Code), gerr.Error(), 30)
		return
	}
	var req struct {
		Model string          `json:"model"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 9001, "请求体非法", 0)
		return
	}
	if req.Model != AliasEmbed {
		writeErr(w, http.StatusNotFound, 8052, "路由档位未配置: "+req.Model, 0)
		return
	}
	var inputs []string
	if len(req.Input) > 0 && req.Input[0] == '"' {
		var one string
		_ = json.Unmarshal(req.Input, &one)
		inputs = []string{one}
	} else {
		_ = json.Unmarshal(req.Input, &inputs)
	}
	if len(inputs) == 0 || len(inputs) > 64 {
		writeErr(w, http.StatusBadRequest, 9001, "input 1-64 条", 0)
		return
	}
	if ok, wait := g.limiter.Allow(who.Subject); !ok {
		writeErr(w, http.StatusTooManyRequests, 8050, "网关限流", wait)
		return
	}
	candidates, ok := g.router.Route(AliasEmbed)
	if !ok || len(candidates) == 0 {
		writeErr(w, http.StatusNotFound, 8052, "路由档位未配置: embed", 0)
		return
	}
	vecs, usage, err := candidates[0].Provider.Embed(r.Context(), candidates[0].Model, inputs)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, 8051, "供应商不可用: "+err.Error(), 0)
		return
	}
	dim := MeterDim{Tenant: who.TenantID, User: uidOf(who), Svc: svcSubject(who), Scene: "embed", Tier: "embed", Provider: candidates[0].Provider.ID()}
	g.meter.Invoice(dim, int64(usage.PromptTokens), 0, false)
	data := make([]map[string]any, len(vecs))
	for i, v := range vecs {
		data[i] = map[string]any{"embedding": v, "index": i}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-BBW-Request-Id", r.Header.Get("Idempotency-Key"))
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "usage": usage, "model": AliasEmbed})
}

// Total usage 汇总
func (u *UsageOpenAI) Total() int {
	if u.TotalTokens > 0 {
		return u.TotalTokens
	}
	return u.PromptTokens + u.CompletionTokens
}

// HandleRerank POST /v1/rerank（D24 N3a：bbw-rerank；kb Query RRF 候选重排消费）。
// 结构同 HandleEmbeddings：鉴权→OBO 闸→解码→限流→路由→调用→计量开票
func (g *Gateway) HandleRerank(w http.ResponseWriter, r *http.Request) {
	who, err := g.auth(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, int(errx.From(err).Code), "鉴权失败", 0)
		return
	}
	if gerr := g.oboGate(who); gerr != nil {
		writeErr(w, http.StatusServiceUnavailable, int(errx.From(gerr).Code), gerr.Error(), 30)
		return
	}
	var req struct {
		Model     string   `json:"model"`
		Query     string   `json:"query"`
		Documents []string `json:"documents"`
		TopN      int      `json:"top_n"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 9001, "请求体非法", 0)
		return
	}
	if req.Model != AliasRerank {
		writeErr(w, http.StatusNotFound, 8052, "路由档位未配置: "+req.Model, 0)
		return
	}
	if strings.TrimSpace(req.Query) == "" {
		writeErr(w, http.StatusBadRequest, 9001, "query 必填", 0)
		return
	}
	if len(req.Documents) == 0 || len(req.Documents) > 64 {
		writeErr(w, http.StatusBadRequest, 9001, "documents 1-64 条", 0)
		return
	}
	if ok, wait := g.limiter.Allow(who.Subject); !ok {
		writeErr(w, http.StatusTooManyRequests, 8050, "网关限流", wait)
		return
	}
	candidates, ok := g.router.Route(AliasRerank)
	if !ok || len(candidates) == 0 {
		writeErr(w, http.StatusNotFound, 8052, "路由档位未配置: rerank", 0)
		return
	}
	hits, usage, err := candidates[0].Provider.Rerank(r.Context(), candidates[0].Model, req.Query, req.Documents, req.TopN)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, 8051, "供应商不可用: "+err.Error(), 0)
		return
	}
	dim := MeterDim{Tenant: who.TenantID, User: uidOf(who), Svc: svcSubject(who), Scene: "rerank", Tier: "rerank", Provider: candidates[0].Provider.ID()}
	g.meter.Invoice(dim, int64(usage.PromptTokens), 0, false)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-BBW-Request-Id", r.Header.Get("Idempotency-Key"))
	_ = json.NewEncoder(w).Encode(map[string]any{"results": hits, "usage": usage, "model": AliasRerank})
}

func headerOr(r *http.Request, k, def string) string {
	if v := r.Header.Get(k); v != "" {
		return v
	}
	return def
}

// resolveStatus 网关解析类错误码 → HTTP 状态（8053 不存在 404 · 8054 越权 403 · 8055/9001 参数 400 · 8052 路由 404）
func resolveStatus(code errx.Code) int {
	switch code {
	case errx.CodeAIGWProviderForbidden:
		return http.StatusForbidden
	case errx.CodeAIGWProviderNotFound, errx.CodeAIGWRouteNotDefined:
		return http.StatusNotFound
	default:
		return http.StatusBadRequest
	}
}

// tierLabel 计量/终帧的档位标注：别名→档位名；p: 直达引用→direct
func tierLabel(model string) string {
	if strings.HasPrefix(model, RefPrefix) {
		return "direct"
	}
	return tierOf(model)
}

func svcSubject(c *Claims) string {
	if c.IsSvc {
		return c.Subject
	}
	return ""
}
