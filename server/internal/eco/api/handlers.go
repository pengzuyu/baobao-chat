// REST 壳（用户面 authed；清单/下载只读公开——Agent 拉取端点，内网口径登记；
// 公司库发布挂 adminOnly 由 main 装配）。
package ecoapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	ecoservice "github.com/baobaowork/server/internal/eco/service"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/httpx"
)

// RegisterUserRoutes 用户面（个人库：发布/我的清单/下架/删除；authed）
func RegisterUserRoutes(mux *http.ServeMux, authed func(http.HandlerFunc) http.Handler, svc *ecoservice.Service) {
	mux.Handle("POST /api/v1/eco/experts", authed(handlePublish(svc, false)))
	mux.Handle("GET /api/v1/eco/experts/mine", authed(handleList(svc)))
	mux.Handle("DELETE /api/v1/eco/experts/{id}", authed(handleDelete(svc)))
	mux.Handle("POST /api/v1/eco/experts/{id}/unpublish", authed(handleUnpublish(svc)))
}

// RegisterPublicRoutes 公开只读（Agent 拉取：清单+下载；无凭证——内网单租户口径，
// 发布/删除面走 authed；多租户/外网部署时收紧，登记）
func RegisterPublicRoutes(mux *http.ServeMux, svc *ecoservice.Service) {
	mux.HandleFunc("GET /api/v1/eco/experts", func(w http.ResponseWriter, r *http.Request) {
		// 公开只读：scope 白名单 company|all（mine 需登录态走 /mine）
		scope := r.URL.Query().Get("scope")
		if scope == "" || scope == "mine" {
			scope = "all"
		}
		list, err := svc.List(r.Context(), tenantOf(r), 0, scope)
		respond(w, r, list, err)
	})
	mux.HandleFunc("GET /api/v1/eco/experts/{id}/download", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "id 非法"))
			return
		}
		e, gerr := svc.Download(r.Context(), tenantOf(r), id)
		if gerr != nil {
			httpx.Fail(w, r, gerr)
			return
		}
		w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
		_, _ = io.WriteString(w, e.Manifest)
	})
}

// RegisterAdminRoutes 公司库（adminOnly 由 main 注入守卫）
func RegisterAdminRoutes(mux *http.ServeMux, adminOnly func(http.HandlerFunc) http.Handler, svc *ecoservice.Service) {
	mux.Handle("POST /api/v1/admin/eco/experts", adminOnly(handlePublish(svc, true)))
	mux.Handle("GET /api/v1/admin/eco/experts", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.List(r.Context(), tenantOf(r), actorOf(r), "company")
		respond(w, r, list, err)
	}))
}

func handlePublish(svc *ecoservice.Service, asCompany bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Manifest string `json:"manifest"`
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 128<<10))
		if err != nil || len(raw) == 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 读取失败/为空"))
			return
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 解析失败"))
			return
		}
		e, perr := svc.Publish(r.Context(), tenantOf(r), actorOf(r), ecoservice.PublishReq{
			Manifest: body.Manifest, AsCompany: asCompany,
		})
		respond(w, r, e, perr)
	}
}

func handleList(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.List(r.Context(), tenantOf(r), actorOf(r), "mine")
		respond(w, r, list, err)
	}
}

func handleDelete(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.Delete(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleUnpublish(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.Unpublish(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "id 非法"))
		return 0, false
	}
	return id, true
}

func respond(w http.ResponseWriter, r *http.Request, data any, err error) {
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.OK(w, r, data)
}

func actorOf(r *http.Request) int64 {
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	return uid
}

func tenantOf(r *http.Request) int64 { return 1 }
