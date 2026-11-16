// web.go：授权等待页 + web 兜底账密登录 + IdP 浏览器会话（D28 §5.2/§5.3，v0.2）。
// 服务端 html/template 单页（零前端工程依赖——「仅桌面端」拍板不冲突口径 §5.2）。
// Q1 为纯 web 路径：desktop 深链确认（§5.1/6 位码）在批次 Q2 叠加。
package oidc

import (
	"html/template"
	"net/http"
	"strings"
	"time"
)

const sessionCookie = "bbw_oidc_session"

var pageTpl = template.Must(template.New("wait").Parse(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BaobaoChat · 统一登录</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#000; color:#fff; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .card { width:320px; padding:32px; border:1px solid #333; border-radius:12px; background:#0a0a0a; }
  h1 { font-size:18px; margin:0 0 6px; }
  p.sub { color:#888; font-size:13px; margin:0 0 24px; }
  label { display:block; font-size:12px; color:#999; margin:14px 0 6px; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:10px 12px;
         border:1px solid #333; border-radius:8px; background:#000; color:#fff; font-size:14px; }
  button { width:100%; margin-top:24px; padding:10px; border:0; border-radius:8px;
         background:#fff; color:#000; font-size:14px; font-weight:600; cursor:pointer; }
  .err { color:#e06c5a; font-size:13px; margin-top:12px; min-height:18px; }
</style>
</head>
<body>
<div class="card">
  <h1>使用 BaobaoChat 账号登录</h1>
  <p class="sub">{{.AppName}}</p>
  <form method="POST" action="/oauth2/web-login">
    <input type="hidden" name="id" value="{{.ID}}">
    <label>工号</label>
    <input type="text" name="account" autocomplete="username" autofocus required>
    <label>密码</label>
    <input type="password" name="password" autocomplete="current-password" required>
    <button type="submit">登录并授权</button>
    <div class="err">{{.Error}}</div>
  </form>
</div>
</body>
</html>`))

type waitPageData struct {
	ID      string
	AppName string
	Error   string
}

// registerWebRoutes 等待页/兜底登录（挂 /oauth2 子树，provider 之外的我们的路由）。
func (m *Module) registerWebRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/wait", m.handleWait)
	mux.HandleFunc("/web-login", m.handleWebLogin)
}

// handleWait GET /oauth2/wait?id=：有效 web 会话 → 直接认领+回跳（SSO 免密，v0.2 拍板 7）；
// 否则渲染账密表单。
func (m *Module) handleWait(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "缺少 id", http.StatusBadRequest)
		return
	}
	appName := "应用"
	if c, err := m.storage.clientRow(r.Context(), m.defaultTenant, m.clientIDOfRequest(r, id)); err == nil {
		appName = c.Name
	}
	if uid := m.storage.webSessionUser(r.Context(), sessionToken(r)); uid > 0 {
		m.approveAndRedirect(w, r, id, uid)
		return
	}
	_ = pageTpl.Execute(w, waitPageData{ID: id, AppName: appName})
}

// handleWebLogin POST /oauth2/web-login：账密校验（复用 auth 防爆破）→ 建 7 天滑动
// web 会话（HttpOnly cookie）→ 认领授权请求 → 回跳 authorize callback。
func (m *Module) handleWebLogin(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "表单解析失败", http.StatusBadRequest)
		return
	}
	id := r.PostFormValue("id")
	account := strings.TrimSpace(r.PostFormValue("account"))
	password := r.PostFormValue("password")

	renderErr := func(msg string) {
		appName := "应用"
		if c, err := m.storage.clientRow(r.Context(), m.defaultTenant, m.clientIDOfRequest(r, id)); err == nil {
			appName = c.Name
		}
		_ = pageTpl.Execute(w, waitPageData{ID: id, AppName: appName, Error: msg})
	}
	if id == "" || account == "" || password == "" {
		renderErr("请填写工号与密码")
		return
	}
	u, err := m.auth.VerifyOIDCWebLogin(r.Context(), m.defaultTenant, account, password)
	if err != nil {
		renderErr("账号或密码错误")
		return
	}
	token, err := m.storage.createWebSession(r.Context(), u.ID, r.UserAgent(), clientIP(r))
	if err == nil {
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookie,
			Value:    token,
			Path:     "/oauth2",
			MaxAge:   int((7 * 24 * time.Hour).Seconds()),
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   !m.insecure,
		})
	}
	m.approveAndRedirect(w, r, id, u.ID)
}

// approveAndRedirect 认领授权请求并 302 回 op 的 authorize callback（签 code → RP）。
func (m *Module) approveAndRedirect(w http.ResponseWriter, r *http.Request, id string, uid int64) {
	if err := m.storage.completeAuthRequest(r.Context(), id, i64toa(uid)); err != nil {
		http.Error(w, "授权请求不存在或已过期", http.StatusBadRequest)
		return
	}
	http.Redirect(w, r, m.callbackURL(r.Context(), id), http.StatusFound)
}

func (m *Module) clientIDOfRequest(r *http.Request, id string) string {
	ar, err := m.storage.loadAuthRequest(r.Context(), id)
	if err != nil {
		return ""
	}
	return ar.ClientID
}

func sessionToken(r *http.Request) string {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return host
}
