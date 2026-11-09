// 供应商池与 p: 直达引用解析测试（0023；不依赖 PG——Router 内存面）。
package aigw

import (
	"testing"

	errx "github.com/baobaowork/server/internal/platform/errors"
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
		{"bbw-vision", 42, errx.CodeAIGWRouteNotDefined},       // 未知别名
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
	// 无表数据：档位别名回落 env/mock 兜底装配（E2E 兼容）
	r := NewRouter(NewMockProvider(1, "mock-echo"), nil)
	if c, err := r.ResolveFor(1, 42, AliasStrong); err != nil || len(c) == 0 {
		t.Fatalf("档位别名应回落兜底: %+v %v", c, err)
	}
	// 表驱动 SetTier 后替换生效
	r.SetTier("strong", []Candidate{{Provider: NewMockProvider(100, "corp"), Model: "glm-4.7", Priority: 1}})
	c, err := r.ResolveFor(1, 42, AliasStrong)
	if err != nil || c[0].Model != "glm-4.7" || c[0].Provider.ID() != 100 {
		t.Fatalf("表驱动候选应生效: %+v %v", c, err)
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
