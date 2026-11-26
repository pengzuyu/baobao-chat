// 供应商注册表（0023 表驱动多供应商，19 篇 §3.1/§3.3/§6.5 蓝图的 v0.1 落地）：
// ai_provider（公司级 owner NULL / 个人 BYOK owner=uid）+ ai_route_rule（对话默认档
// 一条 active + embed/rerank 可选档，candidates=[{provider_id, model, priority}] 主备降级）
// 的读写与热装配。2026-11-26 单档化：对话 fast/strong 双档退役为 default（基线直改
// CHECK，不做数据迁移——存量库重建或手工改约束）。
// 密钥经 kms（AES-256-GCM）加密落 api_key_ref，明文只在内存；接口只回掩码。
package aigw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/kms"
)

// MaxPersonalProviders 个人 BYOK 上限（防滥用；策略阈值不进库约束）
const MaxPersonalProviders = 5

// ModelDef 可用模型清单项（ai_provider.models JSONB）
type ModelDef struct {
	ID    string `json:"id"`              // 上游真实模型名（如 glm-4.7）
	Label string `json:"label,omitempty"` // 展示名（缺省同 id）
}

// ProviderInput 创建/更新入参（管理端 ownerID=0→公司级；个人通道 ownerID=uid）
type ProviderInput struct {
	Name    string     `json:"name"`
	Kind    string     `json:"kind"` // v0.1 开放 openai_compatible/mock（GLM/Qwen/DeepSeek/vLLM 全走前者）
	BaseURL string     `json:"baseUrl"`
	APIKey  string     `json:"apiKey"`           // 创建可空（内网无鉴权上游）；更新空=保留原值
	Models  []ModelDef `json:"models"`           // 至少 1 项
	Status  int        `json:"status,omitempty"` // 更新用：1 enabled 2 disabled（0=不改）
}

// ProviderDTO 出参（密钥只回掩码；ownerID 空=公司级）
type ProviderDTO struct {
	ID      int64      `json:"id"`
	Name    string     `json:"name"`
	Kind    string     `json:"kind"`
	BaseURL string     `json:"baseUrl"`
	KeyMask string     `json:"keyMask"` // ****last4（无 key=空）
	OwnerID *int64     `json:"ownerId,omitempty"`
	Models  []ModelDef `json:"models"`
	Status  int        `json:"status"`
}

// RouteCandidateDTO 路由候选（ai_route_rule.candidates 条目）
type RouteCandidateDTO struct {
	ProviderID int64  `json:"providerId"`
	Model      string `json:"model"`
	Priority   int    `json:"priority"`
}

// RouteRuleDTO 一条 active 路由（tier=default/embed/rerank）
type RouteRuleDTO struct {
	Tier       string              `json:"tier"`
	Candidates []RouteCandidateDTO `json:"candidates"`
}

// Registry 表驱动注册表（CRUD + 热装配 + 路由治理 + 探活）
type Registry struct {
	pool     *pgxpool.Pool
	kms      *kms.KMS // 可空=未配置主密钥（带 key 的 provider 创建将被拒绝）
	router   *Router
	tenantID int64 // 部署租户（v0.1 单租户；多租户分桶阶段二）
}

// NewRegistry 构造（不立即装配——NewModule 内先 Reload）
func NewRegistry(pool *pgxpool.Pool, router *Router, k *kms.KMS, tenantID int64) *Registry {
	return &Registry{pool: pool, kms: k, router: router, tenantID: tenantID}
}

// ---- CRUD ----

func validateInput(in *ProviderInput, forUpdate bool) error {
	in.Name = strings.TrimSpace(in.Name)
	in.BaseURL = strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	if forUpdate && in.Name == "" && in.BaseURL == "" && in.APIKey == "" && len(in.Models) == 0 && in.Status == 0 {
		return errx.New(errx.CodeBadRequest, "无待更新字段")
	}
	if !forUpdate || in.Name != "" {
		if in.Name == "" || len([]rune(in.Name)) > 64 {
			return errx.New(errx.CodeBadRequest, "name 必填且 ≤64 字")
		}
	}
	if !forUpdate || in.BaseURL != "" {
		if !strings.HasPrefix(in.BaseURL, "http://") && !strings.HasPrefix(in.BaseURL, "https://") {
			return errx.New(errx.CodeBadRequest, "baseUrl 须以 http(s):// 开头")
		}
	}
	if !forUpdate {
		switch in.Kind {
		case "openai_compatible", "mock":
		default:
			return errx.New(errx.CodeBadRequest, "kind 仅支持 openai_compatible/mock（v0.1）")
		}
	}
	seen := map[string]bool{}
	for i := range in.Models {
		in.Models[i].ID = strings.TrimSpace(in.Models[i].ID)
		if in.Models[i].ID == "" {
			return errx.New(errx.CodeBadRequest, "models[].id 必填")
		}
		if seen[in.Models[i].ID] {
			return errx.New(errx.CodeBadRequest, "models 重复: "+in.Models[i].ID)
		}
		seen[in.Models[i].ID] = true
	}
	if !forUpdate && len(in.Models) == 0 {
		return errx.New(errx.CodeBadRequest, "models 至少 1 项（可用探活从上游拉取）")
	}
	if in.Status != 0 && in.Status != 1 && in.Status != 2 {
		return errx.New(errx.CodeBadRequest, "status 仅 1/2")
	}
	return nil
}

func (reg *Registry) encryptKey(plain string) (string, error) {
	if plain == "" {
		return "", nil // 无鉴权上游（内网 vLLM）
	}
	if reg.kms == nil {
		return "", errx.New(errx.CodeDependencyDown, "服务端未配置 BBC_KMS_MASTER_KEY，无法保存密钥")
	}
	ref, err := reg.kms.Encrypt(plain)
	if err != nil {
		return "", errx.New(errx.CodeInternal, "密钥加密失败")
	}
	return ref, nil
}

// CreateProvider 创建（ownerID=0→公司级；>0→个人 BYOK，≤MaxPersonalProviders 个/人）后热装配
func (reg *Registry) CreateProvider(ctx context.Context, in ProviderInput, tenantID, ownerID int64) (*ProviderDTO, error) {
	if err := validateInput(&in, false); err != nil {
		return nil, err
	}
	keyRef, err := reg.encryptKey(in.APIKey)
	if err != nil {
		return nil, err
	}
	var owner *int64
	if ownerID > 0 {
		var n int
		if err := reg.pool.QueryRow(ctx,
			`SELECT count(*) FROM ai_provider WHERE tenant_id=$1 AND owner_user_id=$2`, tenantID, ownerID).Scan(&n); err != nil {
			return nil, err
		}
		if n >= MaxPersonalProviders {
			return nil, errx.New(errx.CodeBadRequest, fmt.Sprintf("个人供应商已达上限 %d 个", MaxPersonalProviders))
		}
		owner = &ownerID
	}
	modelsJSON, _ := json.Marshal(in.Models)
	endpoints := fmt.Sprintf(`[{"url":%s}]`, mustJSONString(in.BaseURL))
	var id int64
	err = reg.pool.QueryRow(ctx, `
		INSERT INTO ai_provider (id, tenant_id, owner_user_id, name, kind, endpoints, api_key_ref, models, status)
		SELECT COALESCE(max(id),0)+1, $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, 1 FROM ai_provider
		RETURNING id`,
		tenantID, owner, in.Name, in.Kind, endpoints, keyRef, string(modelsJSON)).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // uk_ai_provider_owner_name
			return nil, errx.New(errx.CodeBadRequest, "同名供应商已存在: "+in.Name)
		}
		return nil, err
	}
	if err := reg.Reload(ctx); err != nil {
		log.Printf("[aigw] provider 建后装配失败（配置已保存）: %v", err)
	}
	return reg.GetProvider(ctx, id)
}

// UpdateProvider 更新（apiKey 空=保留；校验 owner 归属）后热装配
func (reg *Registry) UpdateProvider(ctx context.Context, id int64, in ProviderInput) (*ProviderDTO, error) {
	if err := validateInput(&in, true); err != nil {
		return nil, err
	}
	old, err := reg.GetProvider(ctx, id)
	if err != nil {
		return nil, err
	}
	keyRef := ""
	if in.APIKey != "" {
		keyRef, err = reg.encryptKey(in.APIKey)
		if err != nil {
			return nil, err
		}
	}
	// 增量合并（空字段=不改）
	name, base, models, status := old.Name, old.BaseURL, old.Models, old.Status
	if in.Name != "" {
		name = in.Name
	}
	if in.BaseURL != "" {
		base = in.BaseURL
	}
	if len(in.Models) > 0 {
		models = in.Models
	}
	if in.Status != 0 {
		status = in.Status
	}
	modelsJSON, _ := json.Marshal(models)
	endpoints := fmt.Sprintf(`[{"url":%s}]`, mustJSONString(base))
	tag, err := reg.pool.Exec(ctx, `
		UPDATE ai_provider SET name=$2, endpoints=$3::jsonb,
			api_key_ref=CASE WHEN $4<>'' THEN $4 ELSE api_key_ref END,
			models=$5::jsonb, status=$6, updated_at=now()
		WHERE id=$1`,
		id, name, endpoints, keyRef, string(modelsJSON), status)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, errx.New(errx.CodeBadRequest, "同名供应商已存在: "+name)
		}
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, errx.New(errx.CodeNotFound, "供应商不存在")
	}
	if err := reg.Reload(ctx); err != nil {
		log.Printf("[aigw] provider 改后装配失败（配置已保存）: %v", err)
	}
	return reg.GetProvider(ctx, id)
}

// DeleteProvider 删除（被 active 路由引用时拒绝——先改路由再删）后热装配
func (reg *Registry) DeleteProvider(ctx context.Context, id int64) error {
	routes, err := reg.GetRoutes(ctx)
	if err != nil {
		return err
	}
	for _, rr := range routes {
		for _, c := range rr.Candidates {
			if c.ProviderID == id {
				return errx.New(errx.CodeBadRequest, fmt.Sprintf("供应商被 %s 档路由引用，先调整路由", rr.Tier))
			}
		}
	}
	tag, err := reg.pool.Exec(ctx, `DELETE FROM ai_provider WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errx.New(errx.CodeNotFound, "供应商不存在")
	}
	return reg.Reload(ctx)
}

// GetProvider 单查（密钥掩码）
func (reg *Registry) GetProvider(ctx context.Context, id int64) (*ProviderDTO, error) {
	rec, err := reg.loadOne(ctx, id)
	if err != nil {
		return nil, err
	}
	return rec.dto(), nil
}

// ListProviders 列表：ownerScope="corp"=公司级（管理端，含停用）；"mine"=个人（owner=uid）；
// "shared"=公司级启用中（用户设置页下拉）
func (reg *Registry) ListProviders(ctx context.Context, ownerScope string, uid int64) ([]ProviderDTO, error) {
	q, args := `SELECT id, tenant_id, owner_user_id, name, kind, endpoints, api_key_ref, models, status
		FROM ai_provider WHERE tenant_id=$1`, []any{reg.tenantID}
	switch ownerScope {
	case "corp":
		q += ` AND owner_user_id IS NULL`
	case "mine":
		q += ` AND owner_user_id=$2`
		args = append(args, uid)
	case "shared":
		q += ` AND owner_user_id IS NULL AND status=1`
	}
	q += ` ORDER BY id`
	rows, err := reg.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProviderDTO{}
	for rows.Next() {
		rec, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		// 掩码需明文末 4 位：行内解密（内存短暂持有，仅回显掩码）
		if rec.keyRef != "" && reg.kms != nil {
			if plain, kerr := reg.kms.Decrypt(rec.keyRef); kerr == nil {
				rec.hasKey, rec.keyPlain = true, plain
			}
		}
		out = append(out, *rec.dto())
	}
	return out, rows.Err()
}

// ---- 装配（Reload）----

type providerRec struct {
	id       int64
	tenant   *int64
	owner    *int64
	name     string
	kind     string
	baseURL  string
	keyRef   string
	models   []ModelDef
	status   int
	hasKey   bool
	keyPlain string
}

func (r *providerRec) dto() *ProviderDTO {
	d := &ProviderDTO{ID: r.id, Name: r.name, Kind: r.kind, BaseURL: r.baseURL,
		OwnerID: r.owner, Models: r.models, Status: r.status}
	if r.hasKey {
		d.KeyMask = kms.MaskKey(r.keyPlain)
	}
	return d
}

func scanProvider(row pgx.Row) (*providerRec, error) {
	var r providerRec
	var endpoints []byte
	var models []byte
	var keyRef *string
	if err := row.Scan(&r.id, &r.tenant, &r.owner, &r.name, &r.kind, &endpoints, &keyRef, &models, &r.status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errx.New(errx.CodeNotFound, "供应商不存在")
		}
		return nil, err
	}
	var eps []struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(endpoints, &eps)
	if len(eps) > 0 {
		r.baseURL = eps[0].URL
	}
	_ = json.Unmarshal(models, &r.models)
	if r.models == nil {
		r.models = []ModelDef{}
	}
	if keyRef != nil && *keyRef != "" {
		r.keyRef = *keyRef
	}
	return &r, nil
}

func (reg *Registry) loadOne(ctx context.Context, id int64) (*providerRec, error) {
	row := reg.pool.QueryRow(ctx,
		`SELECT id, tenant_id, owner_user_id, name, kind, endpoints, api_key_ref, models, status FROM ai_provider WHERE id=$1`, id)
	rec, err := scanProvider(row)
	if err != nil {
		return nil, err
	}
	if rec.keyRef != "" && reg.kms != nil {
		plain, kerr := reg.kms.Decrypt(rec.keyRef)
		if kerr == nil {
			rec.hasKey, rec.keyPlain = true, plain
		}
	}
	return rec, nil
}

// Reload 热装配：ai_provider(enabled) → Router 供应商池；ai_route_rule(active,
// default/embed/rerank) → 档位候选（替换 env/mock 兜底装配；embed/rerank 未配
// 表时不覆盖 → mock 兜底恒可用，D24 N3a）。单行解密失败跳过并登记日志。
func (reg *Registry) Reload(ctx context.Context) error {
	rows, err := reg.pool.Query(ctx,
		`SELECT id, tenant_id, owner_user_id, name, kind, endpoints, api_key_ref, models, status
		FROM ai_provider WHERE status=1 AND (tenant_id IS NULL OR tenant_id=$1)`, reg.tenantID)
	if err != nil {
		return err
	}
	entries := map[int64]*providerEntry{}
	for rows.Next() {
		rec, err := scanProvider(rows)
		if err != nil {
			rows.Close()
			return err
		}
		var prov Provider
		switch rec.kind {
		case "mock":
			prov = NewMockProvider(rec.id, rec.name)
		default:
			key := ""
			if rec.keyRef != "" {
				if reg.kms == nil {
					log.Printf("[aigw] provider#%d 跳过：存有密钥但未配置 BBC_KMS_MASTER_KEY", rec.id)
					continue
				}
				plain, kerr := reg.kms.Decrypt(rec.keyRef)
				if kerr != nil {
					log.Printf("[aigw] provider#%d 跳过：密钥解密失败（%v）", rec.id, kerr)
					continue
				}
				key = plain
			}
			prov = &OpenAICompatProvider{IDOf: rec.id, NameOf: rec.name,
				Cfg: OpenAICompatConfig{BaseURL: rec.baseURL, APIKey: key}}
		}
		entries[rec.id] = &providerEntry{prov: prov, owner: rec.owner, tenant: rec.tenant, models: rec.models}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	reg.router.SetProviders(entries)

	// active 路由（tenant 覆盖优先/高 version 优先——按 version 升序读，后写覆盖）
	routeRows, err := reg.pool.Query(ctx,
		`SELECT tier, candidates FROM ai_route_rule
		WHERE status='active' AND (tenant_id IS NULL OR tenant_id=$1) ORDER BY version`, reg.tenantID)
	if err != nil {
		return err
	}
	defer routeRows.Close()
	tiers := map[string][]Candidate{}
	for routeRows.Next() {
		var tier string
		var candsJSON []byte
		if err := routeRows.Scan(&tier, &candsJSON); err != nil {
			return err
		}
		var cands []RouteCandidateDTO
		_ = json.Unmarshal(candsJSON, &cands)
		list := make([]Candidate, 0, len(cands))
		for _, c := range cands {
			e := entries[c.ProviderID]
			if e == nil { // 供应商已删/停用：候选失效，跳过
				continue
			}
			list = append(list, Candidate{Provider: e.prov, Model: c.Model, Priority: c.Priority})
		}
		if len(list) > 0 {
			sort.SliceStable(list, func(i, j int) bool { return list[i].Priority < list[j].Priority })
			tiers[tier] = list
		}
	}
	for tier, list := range tiers {
		if tier == TierDefault || tier == TierEmbed || tier == TierRerank {
			reg.router.SetTier(tier, list) // D24：embed/rerank 放开表驱动（未配时 NewRouter mock 兜底不覆盖）
		}
	}
	return routeRows.Err()
}

// ---- 路由治理（默认档主备）----

// GetRoutes 当前 active 路由（default/embed/rerank；无配置返回空）
func (reg *Registry) GetRoutes(ctx context.Context) ([]RouteRuleDTO, error) {
	rows, err := reg.pool.Query(ctx,
		`SELECT tier, candidates FROM ai_route_rule
		WHERE status='active' AND (tenant_id IS NULL OR tenant_id=$1) ORDER BY version`, reg.tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]RouteRuleDTO{}
	for rows.Next() {
		var tier string
		var candsJSON []byte
		if err := rows.Scan(&tier, &candsJSON); err != nil {
			return nil, err
		}
		var cands []RouteCandidateDTO
		_ = json.Unmarshal(candsJSON, &cands)
		if cands != nil {
			out[tier] = RouteRuleDTO{Tier: tier, Candidates: cands}
		}
	}
	list := make([]RouteRuleDTO, 0, len(out))
	for _, t := range []string{TierDefault, TierEmbed, TierRerank} {
		if rr, ok := out[t]; ok {
			list = append(list, rr)
		}
	}
	return list, rows.Err()
}

// PutRoutes 整表替换 default/embed/rerank 路由（版本化：旧 active→archived，新
// version+1 active；D24 N3a 放开 embed/rerank 档——管理员经此配 bbc-embed/bbc-rerank
// 上游）。候选校验：供应商存在且启用、公司级（个人 BYOK 不进路由表）、model 在清单。
// 2026-11-26 单档化：对话只认 default 档，fast/strong 不再受理（旧包管理页提交会被拒）。
func (reg *Registry) PutRoutes(ctx context.Context, rules []RouteRuleDTO, tenantID, uid int64) error {
	for _, rr := range rules {
		switch rr.Tier {
		case TierDefault, TierEmbed, TierRerank:
		default:
			return errx.New(errx.CodeBadRequest, "tier 仅 "+TierDefault+"/"+TierEmbed+"/"+TierRerank)
		}
		if len(rr.Candidates) == 0 {
			return errx.New(errx.CodeBadRequest, rr.Tier+" 档至少 1 个候选（主选）")
		}
		for _, c := range rr.Candidates {
			e := reg.router.EntryOf(c.ProviderID)
			if e == nil || (e.tenant != nil && *e.tenant != tenantID) {
				return errx.New(errx.CodeBadRequest, fmt.Sprintf("候选供应商不存在或未启用: %d", c.ProviderID))
			}
			if e.owner != nil {
				return errx.New(errx.CodeBadRequest, fmt.Sprintf("候选 %d 是个人供应商，不可入租户默认路由", c.ProviderID))
			}
			found := false
			for _, m := range e.models {
				if m.ID == c.Model {
					found = true
					break
				}
			}
			if !found {
				return errx.New(errx.CodeBadRequest, fmt.Sprintf("模型 %s 不在供应商 %d 清单内", c.Model, c.ProviderID))
			}
		}
	}
	tx, err := reg.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, rr := range rules {
		candsJSON, _ := json.Marshal(rr.Candidates)
		if _, err := tx.Exec(ctx,
			`UPDATE ai_route_rule SET status='archived' WHERE status='active' AND tier=$1 AND (tenant_id IS NULL OR tenant_id=$2)`,
			rr.Tier, tenantID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ai_route_rule (id, tenant_id, version, tier, candidates, status, created_by)
			SELECT COALESCE(max(id),0)+1, $1, COALESCE(max(version),0)+1, $2, $3::jsonb, 'active', $4 FROM ai_route_rule`,
			tenantID, rr.Tier, string(candsJSON), uid); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return reg.Reload(ctx)
}

// ---- 探活 / 拉取模型清单 ----

// ProbeRaw 直连上游探活（创建表单"测试连通/拉取模型"用；key 可空=无鉴权上游）
func ProbeRaw(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	return probeModels(ctx, baseURL, apiKey)
}

// ProbeByID 已建供应商探活（行内密钥解密后直连）
func (reg *Registry) ProbeByID(ctx context.Context, id int64) ([]string, error) {
	rec, err := reg.loadOne(ctx, id)
	if err != nil {
		return nil, err
	}
	return probeModels(ctx, rec.baseURL, rec.keyPlain)
}

func probeModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		return nil, errx.New(errx.CodeBadRequest, "baseUrl 须以 http(s):// 开头")
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, baseURL+"/models", nil)
	if err != nil {
		return nil, errx.New(errx.CodeBadRequest, "baseUrl 非法")
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, errx.New(errx.CodeDependencyDown, "上游连接失败: "+err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<10))
		return nil, errx.New(errx.CodeDependencyDown, fmt.Sprintf("上游 %d: %s", resp.StatusCode, string(b)))
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return nil, errx.New(errx.CodeDependencyDown, "响应非 OpenAI /models 形态")
	}
	out := make([]string, 0, len(body.Data))
	for _, m := range body.Data {
		if m.ID != "" {
			out = append(out, m.ID)
		}
	}
	return out, nil
}
