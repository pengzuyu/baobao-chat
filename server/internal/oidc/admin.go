// admin.go：oidc_client 管理 CRUD（admin:app:publish 守卫由 main.go 挂）。
// 一期只开 public client（PKCE-only，D28 §9-4）：client_id 服务端生成；secret 留空。
package oidc

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/baobaochat/server/internal/platform/httpx"
)

type clientCreateReq struct {
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
	Scopes       []string `json:"scopes"`
}

type clientDTO struct {
	ID           int64    `json:"id"`
	ClientID     string   `json:"client_id"`
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
	Scopes       []string `json:"scopes"`
	Status       string   `json:"status"`
	CreatedAt    string   `json:"created_at"`
}

// HandleClientsCreate POST /api/v1/admin/oidc/clients（uid 取登录态 claims——守卫已校验 admin:app:publish）
func (m *Module) HandleClientsCreate() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req clientCreateReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || len(req.RedirectURIs) == 0 {
			httpx.Fail(w, r, errors.New("name/redirect_uris 必填"))
			return
		}
		scopes := req.Scopes
		if len(scopes) == 0 {
			scopes = []string{"openid", "profile"}
		}
		uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
		created, err := m.storage.createClient(r, req.Name, req.RedirectURIs, scopes, uid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, created)
	}
}

// HandleClientsList GET /api/v1/admin/oidc/clients
func (m *Module) HandleClientsList() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		httpx.OK(w, r, map[string]any{"items": m.storage.listClients(r)})
	}
}

// HandleClientsStatus PATCH /api/v1/admin/oidc/clients/{id}/status {status: active|disabled}
func (m *Module) HandleClientsStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == 0 ||
			(req.Status != "active" && req.Status != "disabled") {
			httpx.Fail(w, r, errors.New("id 与 status(active|disabled) 必填"))
			return
		}
		if err := m.storage.setClientStatus(r, req.ID, req.Status); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]bool{"ok": true})
	}
}
