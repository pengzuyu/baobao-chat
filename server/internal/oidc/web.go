// web.go：授权等待页 + web 兜底账密登录 + IdP 浏览器会话 + desktop 确认链端点
// （D28 §5.1-§5.3，批次 Q1/Q2）。服务端 html/template 单页（零前端工程依赖——
// 「仅桌面端」拍板不冲突口径 §5.2）。
package oidc

import (
	"encoding/json"
	"errors"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"

	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/httpx"
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
  .card { width:340px; padding:32px; border:1px solid #333; border-radius:12px; background:#0a0a0a; }
  h1 { font-size:18px; margin:0 0 6px; }
  p.sub { color:#888; font-size:13px; margin:0 0 18px; }
  .code-box { border:1px dashed #444; border-radius:8px; padding:12px; text-align:center; margin-bottom:14px; }
  .code-box .label { font-size:12px; color:#999; }
  .code-box .code { font-size:32px; letter-spacing:8px; font-weight:700; font-variant-numeric:tabular-nums; }
  #hint { font-size:13px; color:#999; line-height:1.6; margin-bottom:14px; min-height:20px; }
  #hint a { color:#fff; }
  details { border-top:1px solid #222; padding-top:14px; }
  summary { font-size:13px; color:#888; cursor:pointer; margin-bottom:4px; }
  label { display:block; font-size:12px; color:#999; margin:12px 0 6px; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:10px 12px;
         border:1px solid #333; border-radius:8px; background:#000; color:#fff; font-size:14px; }
  button { width:100%; margin-top:18px; padding:10px; border:0; border-radius:8px;
         background:#fff; color:#000; font-size:14px; font-weight:600; cursor:pointer; }
  .err { color:#e06c5a; font-size:13px; margin-top:12px; min-height:18px; }
</style>
</head>
<body>
<div class="card">
  <h1>使用 BaobaoChat 账号登录</h1>
  <p class="sub">{{.AppName}}</p>
  <div class="code-box">
    <div class="label">桌面端确认码（双端核对一致再确认）</div>
    <div class="code">{{.Code6}}</div>
  </div>
  <div id="hint">正在等待桌面端确认…若未弹出，<a href="bbw://auth?req={{.ID}}">点此唤起 BaobaoChat</a>；核对上方确认码与桌面端卡片一致后再点头像。</div>
  <details>
    <summary>桌面端不在身边？使用工号密码登录</summary>
    <form method="POST" action="/oauth2/web-login">
      <input type="hidden" name="id" value="{{.ID}}">
      <label>工号</label>
      <input type="text" name="account" autocomplete="username" required>
      <label>密码</label>
      <input type="password" name="password" autocomplete="current-password" required>
      <button type="submit">登录并授权</button>
      <div class="err">{{.Error}}</div>
    </form>
  </details>
</div>
<script>
  // 深链唤起（无 desktop 的浏览器静默无动作，300ms 后回落密码表单可见）
  setTimeout(function(){ try { window.location.href = 'bbw://auth?req={{.ID}}'; } catch (e) {} }, 400);
  // 状态轮询（desktop 确认卡完成认领 → 回跳 authorize callback 签 code）
  var timer = setInterval(function () {
    fetch('/oauth2/wait/status?id={{.ID}}').then(function (r) { return r.json(); }).then(function (d) {
      var hint = document.getElementById('hint');
      if (d.status === 'approved') {
        clearInterval(timer);
        location.href = '/oauth2/authorize/callback?id={{.ID}}';
      } else if (d.status === 'denied') {
        clearInterval(timer); hint.textContent = '授权已被拒绝。';
      } else if (d.status === 'expired' || d.status === 'missing' || d.status === 'consumed') {
        clearInterval(timer); hint.textContent = '请求已过期，请回到应用重新发起登录。';
      }
    }).catch(function () {});
  }, 2000);
</script>
</body>
</html>`))

type waitPageData struct {
	ID      string
	AppName string
	Code6   string
	Error   string
}

// registerWebRoutes 等待页/兜底登录/desktop 确认端点（挂 /oauth2 子树）。
func (m *Module) registerWebRoutes(sub *http.ServeMux) {
	sub.HandleFunc("/wait", m.handleWait)
	sub.HandleFunc("/wait/status", m.handleWaitStatus)
	sub.HandleFunc("/web-login", m.handleWebLogin)
	// desktop 确认链（Q2）：desktop access token 鉴权——服务端由此得知确认的是谁
	authed := httpx.Auth(m.auth.Verify)
	sub.Handle("/confirm/info", authed(http.HandlerFunc(m.handleConfirmInfo)))
	sub.Handle("/confirm", authed(http.HandlerFunc(m.handleConfirm)))
}

// handleWait GET /oauth2/wait?id=：有效 web 会话 → 直接认领+回跳（SSO 免密，v0.2 拍板 7）；
// 否则渲染确认码+深链+密码兜底表单。
func (m *Module) handleWait(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "缺少 id", http.StatusBadRequest)
		return
	}
	data := waitPageData{ID: id, AppName: "应用", Code6: "—— ——"}
	if info, err := m.storage.confirmInfo(r.Context(), id); err == nil {
		data.AppName = info.AppName
		if info.Status == "pending" && info.Age <= confirmTTL {
			data.Code6 = info.Code6
		} else if info.Status != "pending" {
			http.Error(w, "授权请求已过期或已处理", http.StatusBadRequest)
			return
		}
	}
	if uid := m.storage.webSessionUser(r.Context(), sessionToken(r)); uid > 0 {
		m.approveAndRedirect(w, r, id, uid)
		return
	}
	_ = pageTpl.Execute(w, data)
}

// handleWaitStatus GET /oauth2/wait/status?id=：等待页轮询（public，只回状态不回身份）。
func (m *Module) handleWaitStatus(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": m.storage.waitStatus(r.Context(), id)})
}

// handleConfirmInfo GET /oauth2/confirm/info?id=：desktop 确认卡数据（Bearer=desktop 登录态）。
// 含 covered_by_grant——已有授权覆盖时卡降级轻量形态（免 6 位码，D28 §5.1）。
func (m *Module) handleConfirmInfo(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	info, err := m.storage.confirmInfo(r.Context(), id)
	if err != nil || info.Status != "pending" || info.Age > confirmTTL {
		httpx.Fail(w, r, errx.New(errx.CodeAuthBrowserLoginExpired, "确认请求不存在或已过期"))
		return
	}
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	httpx.OK(w, r, map[string]any{
		"app_name":         info.AppName,
		"client_id":        info.ClientID,
		"scopes":           info.Scopes,
		"code":             info.Code6,
		"covered_by_grant": m.storage.grantCovered(r.Context(), uid, info.ClientID, info.Scopes),
		"expires_in_sec":   int((confirmTTL - info.Age).Seconds()),
	})
}

// handleConfirm POST /oauth2/confirm {id, code}：desktop 确认卡点头像提交。
// 1010=请求过期 · 1012=码不匹配（错 3 次作废）。
func (m *Module) handleConfirm(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "id 必填"))
		return
	}
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	left, err := m.storage.tryConfirm(r.Context(), req.ID, req.Code, uid)
	if err != nil {
		switch {
		case errors.Is(err, errExpiredReq):
			httpx.Fail(w, r, errx.New(errx.CodeAuthBrowserLoginExpired, err.Error()))
		case errors.Is(err, errCodeInvalidated):
			httpx.Fail(w, r, errx.NewWithDetails(errx.CodeAuthConfirmMismatch, err.Error(),
				map[string]int{"attempts_left": 0}))
		case errors.Is(err, errCodeMismatch):
			httpx.Fail(w, r, errx.NewWithDetails(errx.CodeAuthConfirmMismatch, err.Error(),
				map[string]int{"attempts_left": left}))
		default:
			httpx.Fail(w, r, err)
		}
		return
	}
	httpx.OK(w, r, map[string]bool{"ok": true})
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
		data := waitPageData{ID: id, AppName: "应用", Error: msg}
		if info, err := m.storage.confirmInfo(r.Context(), id); err == nil {
			data.AppName = info.AppName
			data.Code6 = info.Code6
		}
		_ = pageTpl.Execute(w, data)
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
	if err := m.storage.completeAuthRequest(r.Context(), id, i64toa(uid), []string{"pwd"}); err != nil {
		http.Error(w, "授权请求不存在或已过期", http.StatusBadRequest)
		return
	}
	http.Redirect(w, r, m.callbackURL(r.Context(), id), http.StatusFound)
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
