// 最小 OIDC RP（Relying Party）示例 —— D28 批4/Q4。
//
// 演示 bbw OIDC OP 的标准接入全链：discovery 自动发现端点 → 授权码 + PKCE(S256)
// → ID Token 经 jwks 公钥本地验签（库内完成：签名/iss/aud/exp/nonce 全校验）
// → userinfo 拉取。任何语言的标准 OIDC 库（spring-security / passport / next-auth /
// Grafana Generic OAuth）接线方式同理——填 issuer + client_id + 回调地址即可。
//
// 启动（服务端 :8090 已起 + 管理后台「登录接入」已建 client，回调填 http://localhost:7070/cb）：
//
//	BBW_CLIENT_ID=bbw-xxxxxxxxxxxx go run .
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"

	httphelper "github.com/zitadel/oidc/v3/pkg/http"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	"github.com/zitadel/oidc/v3/pkg/oidc"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func randString() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("rand: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

var page = template.Must(template.New("done").Parse(`<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>RP 示例 · 登录成功</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#111;color:#eee;
max-width:720px;margin:40px auto;padding:0 16px}pre{background:#000;border:1px solid #333;
border-radius:8px;padding:12px;overflow:auto;font-size:12px}h2{font-size:16px}a{color:#6ea8ff}</style>
</head><body>
<h2>✅ 登录成功（ID Token 已通过 jwks 公钥本地验签）</h2>
<p><a href="/login">再登一次</a>（浏览器持有 bbw 会话时应免密直达）</p>
<h3>ID Token Claims</h3>
<pre>{{.Claims}}</pre>
<h3>Userinfo（access token 调用）</h3>
<pre>{{.Userinfo}}</pre>
</body></html>`))

func main() {
	issuer := env("BBW_ISSUER", "http://127.0.0.1:8090/oauth2")
	clientID := env("BBW_CLIENT_ID", "")
	port := env("PORT", "7070")
	redirectURI := env("BBW_REDIRECT_URI", "http://localhost:"+port+"/cb")
	if clientID == "" {
		log.Fatalf("BBW_CLIENT_ID 必填：先在 bbw 管理后台「管理 · 登录接入」新建客户端，回调地址填 %s", redirectURI)
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		log.Fatal(err)
	}
	cookieHandler := httphelper.NewCookieHandler(key, key, httphelper.WithUnsecure())

	provider, err := rp.NewRelyingPartyOIDC(context.Background(), issuer, clientID, "", redirectURI,
		[]string{oidc.ScopeOpenID, oidc.ScopeProfile, oidc.ScopeEmail},
		rp.WithPKCE(cookieHandler),
	)
	if err != nil {
		log.Fatalf("RP 装配失败（discovery 不可达或 client 未注册）: %v", err)
	}

	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<p>bbw RP 示例已就绪</p><p><a href="/login">使用 BaobaoChat 登录</a></p>`)
	})
	http.Handle("/login", rp.AuthURLHandler(func() string { return randString() }, provider))
	http.Handle("/cb", rp.CodeExchangeHandler[*oidc.IDTokenClaims](
		func(w http.ResponseWriter, r *http.Request, tokens *oidc.Tokens[*oidc.IDTokenClaims], state string, _ rp.RelyingParty) {
			claims, _ := json.MarshalIndent(tokens.IDTokenClaims, "", "  ")
			info, infoErr := rp.Userinfo[*oidc.UserInfo](r.Context(), tokens.AccessToken, tokens.Type(), tokens.IDTokenClaims.GetSubject(), provider)
			infoJSON := []byte(fmt.Sprintf("userinfo 失败: %v", infoErr))
			if infoErr == nil && info != nil {
				infoJSON, _ = json.MarshalIndent(info, "", "  ")
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_ = page.Execute(w, map[string]string{"Claims": string(claims), "Userinfo": string(infoJSON)})
		}, provider))

	log.Printf("RP 示例已启动: http://localhost:%s（issuer=%s client=%s 回调=%s）", port, issuer, clientID, redirectURI)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
