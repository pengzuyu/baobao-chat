// 供应商池与 p: 直达引用解析测试（0023；不依赖 PG——Router 内存面）。
package aigw

import (
	"context"
	"testing"

	errx "github.com/baobaochat/server/internal/platform/errors"
)

func newPoolRouter() *Router {
	r := NewRouter(NewMockProvider(1, "mock-echo"), nil)
	owner42 := int64(42)
	owner7 := int64(7)
	tenant1 := int64(1)
	mock := NewMockProvider(100, "corp-glm")
	mine := NewMockProvider(101, "mine-deepseek")
	others := NewMockProvider(102, "others")
	r.SetProviders(map[int64]*providerEntry{
		100: {prov: mock, tenant: &tenant1, models: []ModelDef{{ID: "glm-4.7"}, {ID: "glm-4.7-air"}}},
		101: {prov: mine, tenant: &tenant1, owner: &owner42, models: []ModelDef{{ID: "deepseek-chat"}}},
		102: {prov: others, tenant: &tenant1, owner: &owner7, models: []ModelDef{{ID: "qwen-max"}}},
	})
	return r
}

func TestResolveForRefHappyPath(t *testing.T) {
	r := newPoolRouter()
	// 公司级：任意员工可用其下模型
	c, err := r.ResolveFor(1, 42, "p:100:glm-4.7")
	if err != nil || len(c) != 1 || c[0].Model != "glm-4.7" || c[0].Provider.ID() != 100 {
		t.Fatalf("公司级引用应命中: %+v %v", c, err)
	}
	// 个人 BYOK：owner 本人
	c, err = r.ResolveFor(1, 42, "p:101:deepseek-chat")
	if err != nil || c[0].Provider.ID() != 101 {
		t.Fatalf("本人 BYOK 引用应命中: %+v %v", c, err)
	}
}

func TestResolveForRefGuards(t *testing.T) {
	r := newPoolRouter()
	cases := []struct {
		model string
		uid   int64
		code  errx.Code
	}{
		{"p:999:glm-4.7", 42, errx.CodeAIGWProviderNotFound},   // 不存在
		{"p:102:qwen-max", 42, errx.CodeAIGWProviderForbidden}, // 他人 BYOK
		{"p:100:glm-5", 42, errx.CodeAIGWModelNotAllowed},      // 不在清单
		{"p:abc:glm-4.7", 42, errx.CodeBadRequest},             // 非数字 id
		{"p:100:", 42, errx.CodeBadRequest},                    // 空模型
		{"glm-4.7", 42, errx.CodeBadRequest},                   // 裸具体模型名=绕过路由
		{"bbc-vision", 42, errx.CodeAIGWRouteNotDefined},       // 未知别名
		{"bbc-embed", 42, errx.CodeAIGWRouteNotDefined},        // 能力档别名不在对话白名单
		{"bbc-rerank", 42, errx.CodeAIGWRouteNotDefined},       // 同上
		{"", 42, errx.CodeBadRequest},                          // 空 model
	}
	for _, tc := range cases {
		_, err := r.ResolveFor(1, tc.uid, tc.model)
		if err == nil {
			t.Fatalf("%q 应报错", tc.model)
		}
		if e := errx.From(err); e.Code != tc.code {
			t.Fatalf("%q 应 %d 实际 %d (%s)", tc.model, tc.code, e.Code, e.Msg)
		}
	}
}

func TestResolveForTenantIsolation(t *testing.T) {
	r := newPoolRouter()
	// 租户 2 引用租户 1 的公司级供应商 → 视同不存在（8053，防探测）
	if _, err := r.ResolveFor(2, 42, "p:100:glm-4.7"); errx.From(err).Code != errx.CodeAIGWProviderNotFound {
		t.Fatalf("跨租户引用应 8053: %v", err)
	}
}

func TestResolveForTierFallback(t *testing.T) {
	// 无表数据：默认档别名回落 env/mock 兜底装配（E2E 兼容）
	r := NewRouter(NewMockProvider(1, "mock-echo"), nil)
	if c, err := r.ResolveFor(1, 42, AliasDefault); err != nil || len(c) == 0 {
		t.Fatalf("默认档别名应回落兜底: %+v %v", c, err)
	}
	// 表驱动 SetTier 后替换生效
	r.SetTier(TierDefault, []Candidate{{Provider: NewMockProvider(100, "corp"), Model: "glm-4.7", Priority: 1}})
	c, err := r.ResolveFor(1, 42, AliasDefault)
	if err != nil || c[0].Model != "glm-4.7" || c[0].Provider.ID() != 100 {
		t.Fatalf("表驱动候选应生效: %+v %v", c, err)
	}
}

// TestEnvDefaultModelCompatKeys env 装配的默认档模型键：default 优先，其次兼容
// 单档化前的 strong / fast 键（现有部署 BBC_AIGW_OPENAI_MODELS 不必改）
func TestEnvDefaultModelCompatKeys(t *testing.T) {
	cases := []struct {
		models map[string]string
		want   string
	}{
		{map[string]string{"default": "glm-5.3", "strong": "glm-4.7", "fast": "glm-4.7-air"}, "glm-5.3"},
		{map[string]string{"strong": "glm-4.7", "fast": "glm-4.7-air"}, "glm-4.7"},
		{map[string]string{"fast": "glm-4.7-air"}, "glm-4.7-air"},
		{map[string]string{"embed": "bge-m3"}, ""}, // 只配了能力档：默认档无上游，走 mock
	}
	for i, tc := range cases {
		up := &OpenAICompatProvider{IDOf: 2, NameOf: "up", Cfg: OpenAICompatConfig{BaseURL: "https://x", Models: tc.models}}
		r := NewRouter(NewMockProvider(1, "mock-echo"), up)
		c, err := r.ResolveFor(1, 42, AliasDefault)
		if err != nil || len(c) == 0 {
			t.Fatalf("case %d 应有兜底候选: %+v %v", i, c, err)
		}
		if tc.want == "" {
			if c[0].Provider.ID() != 1 {
				t.Fatalf("case %d 无上游时应只剩 mock: %+v", i, c)
			}
			continue
		}
		// 具体模型名随候选携带（handler 注入请求体，StreamChat 不再做档位映射）
		if c[0].Provider.ID() != 2 || c[0].Model != tc.want || c[0].Priority >= c[len(c)-1].Priority {
			t.Fatalf("case %d 上游候选应居首并带模型名: %+v", i, c)
		}
	}
}

// TestPutRoutesRejectsLegacyTier 单档化后管理端只认 default/embed/rerank：
// fast/strong 提交直接 400（校验先于落库，内存态即可覆盖）
func TestPutRoutesRejectsLegacyTier(t *testing.T) {
	reg := &Registry{}
	ok := RouteCandidateDTO{ProviderID: 100, Model: "glm-4.7", Priority: 1}
	for _, legacy := range []string{"fast", "strong"} {
		err := reg.PutRoutes(context.Background(), []RouteRuleDTO{{Tier: legacy, Candidates: []RouteCandidateDTO{ok}}}, 1, 1)
		if err == nil || errx.From(err).Code != errx.CodeBadRequest {
			t.Fatalf("tier=%s 应 400: %v", legacy, err)
		}
	}
	// default 档缺主选 → 400
	if err := reg.PutRoutes(context.Background(), []RouteRuleDTO{{Tier: TierDefault}}, 1, 1); errx.From(err).Code != errx.CodeBadRequest {
		t.Fatalf("default 档缺主选应 400: %v", err)
	}
}

func TestValidateInputGuards(t *testing.T) {
	bad := []ProviderInput{
		{Name: "", BaseURL: "https://x", Models: []ModelDef{{ID: "m"}}},                     // 空 name
		{Name: "x", BaseURL: "ftp://x", Models: []ModelDef{{ID: "m"}}},                      // 非 http(s)
		{Name: "x", BaseURL: "https://x", Kind: "anthropic", Models: []ModelDef{{ID: "m"}}}, // kind 未开放
		{Name: "x", BaseURL: "https://x", Models: nil},                                      // 空清单
		{Name: "x", BaseURL: "https://x", Models: []ModelDef{{ID: "m"}, {ID: "m"}}},         // 重复模型
		{Name: "x", BaseURL: "https://x", Models: []ModelDef{{ID: " "}}},                    // 空 id
	}
	for i, in := range bad {
		if err := validateInput(&in, false); err == nil {
			t.Fatalf("case %d 应报错: %+v", i, in)
		}
	}
	ok := ProviderInput{Name: "智谱", Kind: "openai_compatible", BaseURL: "https://open.bigmodel.cn/api/paas/v4/",
		Models: []ModelDef{{ID: "glm-4.7"}, {ID: "glm-4.7-air", Label: "Air"}}}
	if err := validateInput(&ok, false); err != nil {
		t.Fatalf("合法输入不应报错: %v", err)
	}
	if ok.BaseURL != "https://open.bigmodel.cn/api/paas/v4" { // 尾斜杠修剪
		t.Fatalf("baseUrl 应去尾斜杠: %s", ok.BaseURL)
	}
}
