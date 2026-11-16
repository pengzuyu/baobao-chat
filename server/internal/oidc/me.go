// me.go：用户面授权管理 API（D28 批次 Q3）——「已授权应用」列表/撤销 + 浏览器会话
// 列表/远端下线。鉴权=authed（登录态 Bearer），uid 取 claims。
package oidc

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/httpx"
)

func uidFromCtx(r *http.Request) int64 {
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	return uid
}

// HandleMeGrants GET /api/v1/me/oidc/grants：已授权应用列表（含已撤销）
func (m *Module) HandleMeGrants() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		httpx.OK(w, r, map[string]any{"items": m.storage.listGrants(r.Context(), uidFromCtx(r))})
	}
}

// HandleMeGrantRevoke POST /api/v1/me/oidc/grants/revoke {client_id}
// 撤销=grant 置 revoked + 该应用 refresh/access 全灭（introspection 立即 inactive）
func (m *Module) HandleMeGrantRevoke() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ClientID string `json:"client_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ClientID == "" {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "client_id 必填"))
			return
		}
		if err := m.storage.revokeGrant(r.Context(), uidFromCtx(r), req.ClientID); err != nil {
			if errors.Is(err, errNotFound) {
				httpx.Fail(w, r, errx.New(errx.CodeNotFound, "未找到该应用的授权记录"))
				return
			}
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]bool{"ok": true})
	}
}

// HandleMeSessions GET /api/v1/me/oidc/sessions：活跃浏览器会话（IdP 登录态）
func (m *Module) HandleMeSessions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		httpx.OK(w, r, map[string]any{"items": m.storage.listSessions(r.Context(), uidFromCtx(r))})
	}
}

// HandleMeSessionRevoke DELETE /api/v1/me/oidc/sessions/{id}：远端下线单个浏览器会话
func (m *Module) HandleMeSessionRevoke() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "会话 id 非法"))
			return
		}
		if err := m.storage.revokeSession(r.Context(), uidFromCtx(r), id); err != nil {
			if errors.Is(err, errNotFound) {
				httpx.Fail(w, r, errx.New(errx.CodeNotFound, "会话不存在或已下线"))
				return
			}
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]bool{"ok": true})
	}
}
