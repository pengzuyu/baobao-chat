package oidc

import (
	"testing"

	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// 回归锁定：内网无 TLS 部署（issuer 配 http://）下 RP 直接注册 http:// 回调可用。
// 依据 zitadel/oidc 的校验规则——IsConfidentialType 按 ApplicationType==Web 判定
// （与 PKCE/public 无关），web 类型 + code 流的 http 回调本就放行；本 OP 的
// client 恒为 web 类型。防未来 ApplicationType 或校验入口改动意外收紧内网明文
// 部署能力。issuer 侧 http 由 module.go 的 WithAllowInsecure 分支覆盖，不在此测。
func TestHTTPRedirectAllowedForWebCodeClient(t *testing.T) {
	const httpRedirect = "http://172.16.105.109:9090/oauth2/callback"
	row := &clientRow{ClientID: "bbc-test", Redirect: []string{httpRedirect}}
	c := clientFromRow(row)

	if err := op.ValidateAuthReqRedirectURI(c, httpRedirect, oidc.ResponseTypeCode); err != nil {
		t.Fatalf("web+code 客户端的 http 回调应放行（内网明文部署路径）, err=%v", err)
	}
	// 未注册回调仍拒：放行 http 不等于旁路精确匹配
	if err := op.ValidateAuthReqRedirectURI(c, "http://172.16.105.109:9090/evil", oidc.ResponseTypeCode); err == nil {
		t.Fatal("未注册的回调地址应被拒绝")
	}
}
