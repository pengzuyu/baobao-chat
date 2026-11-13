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
	// 生态应用用户面（E1/10 §4.3：catalog 差异同步 + 安装）
	mux.Handle("GET /api/v1/eco/apps/catalog", authed(handleAppCatalog(svc)))
	mux.Handle("POST /api/v1/eco/apps/{id}/install", authed(handleAppInstall(svc)))
	mux.Handle("DELETE /api/v1/eco/apps/{id}/install", authed(handleAppUninstall(svc)))
	mux.Handle("GET /api/v1/eco/apps/installed", authed(handleMyInstalls(svc)))
	// 技能市场用户面（E4/10 篇：catalog+安装/卸载/我的）
	mux.Handle("GET /api/v1/eco/skills/catalog", authed(handleSkillCatalog(svc)))
	mux.Handle("POST /api/v1/eco/skills/{id}/install", authed(handleSkillInstall(svc)))
	mux.Handle("DELETE /api/v1/eco/skills/{id}/install", authed(handleSkillUninstall(svc)))
	mux.Handle("GET /api/v1/eco/skills/mine", authed(handleMySkills(svc)))
	// 插件市场用户面（D22 §3.2/L1：检索/详情/安装/下载/卸载/我的/个人上传（方案 A）；
	// mine/catalog 精确段优先于 {plugin_id} 通配——Go 1.22 ServeMux 语义）
	mux.Handle("POST /api/v1/eco/plugins", authed(handlePluginUploadPrivate(svc)))
	mux.Handle("GET /api/v1/eco/plugins/catalog", authed(handlePluginCatalog(svc)))
	mux.Handle("GET /api/v1/eco/plugins/mine", authed(handleMyPlugins(svc)))
	mux.Handle("GET /api/v1/eco/plugins/{plugin_id}", authed(handlePluginDetail(svc)))
	mux.Handle("POST /api/v1/eco/plugins/{plugin_id}/install", authed(handlePluginInstall(svc)))
	mux.Handle("GET /api/v1/eco/plugins/{plugin_id}/download", authed(handlePluginDownload(svc)))
	mux.Handle("DELETE /api/v1/eco/plugins/{plugin_id}/install", authed(handlePluginUninstall(svc)))
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
	// 生态应用管理面（E1/D09 PEC-01..03；守卫=admin:app:publish）
	mux.Handle("POST /api/v1/admin/eco/apps", adminOnly(handleAppRegister(svc)))
	mux.Handle("GET /api/v1/admin/eco/apps", adminOnly(handleAppList(svc)))
	mux.Handle("POST /api/v1/admin/eco/apps/{id}/versions", adminOnly(handleAppAddVersion(svc)))
	mux.Handle("GET /api/v1/admin/eco/apps/{id}/versions", adminOnly(handleAppVersions(svc)))
	mux.Handle("POST /api/v1/admin/eco/apps/{id}/versions/{vid}/publish", adminOnly(handleAppPublish(svc)))
	mux.Handle("POST /api/v1/admin/eco/apps/{id}/delist", adminOnly(handleAppDelist(svc)))
	// 灰度（E2/OQ-B13：canary %+白名单 100% 豁免）
	mux.Handle("PUT /api/v1/admin/eco/apps/{id}/rollout", adminOnly(handleAppSetRollout(svc)))
	mux.Handle("GET /api/v1/admin/eco/apps/{id}/rollout", adminOnly(handleAppGetRollout(svc)))
	// 技能市场管理面（E4/D09 PEC-04；admin:skill:publish 字典未建前同组守卫，登记）
	mux.Handle("POST /api/v1/admin/eco/skills", adminOnly(handleSkillPublish(svc)))
	mux.Handle("GET /api/v1/admin/eco/skills", adminOnly(handleSkillList(svc)))
	mux.Handle("PATCH /api/v1/admin/eco/skills/{id}", adminOnly(handleSkillUpdate(svc)))
	mux.Handle("POST /api/v1/admin/eco/skills/{id}/delist", adminOnly(handleSkillDelist(svc)))
	// 插件市场管理面（D22/L1：上传/版本线/发布/元数据/下架；admin:app:publish
	// 字典未建前同组守卫——同 skills 口径登记）
	mux.Handle("POST /api/v1/admin/eco/plugins", adminOnly(handlePluginUpload(svc)))
	mux.Handle("GET /api/v1/admin/eco/plugins", adminOnly(handlePluginAdminList(svc)))
	mux.Handle("GET /api/v1/admin/eco/plugins/{plugin_id}/versions", adminOnly(handlePluginVersions(svc)))
	mux.Handle("POST /api/v1/admin/eco/plugins/{plugin_id}/versions/{version}/publish", adminOnly(handlePluginVersionPublish(svc)))
	mux.Handle("PATCH /api/v1/admin/eco/plugins/{plugin_id}", adminOnly(handlePluginUpdate(svc)))
	mux.Handle("POST /api/v1/admin/eco/plugins/{plugin_id}/delist", adminOnly(handlePluginDelist(svc)))
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
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.Delete(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleUnpublish(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.Unpublish(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func pathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id <= 0 {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, name+" 非法"))
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

// decode 请求体 JSON 解码（失败即 400 短路）
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "请求体非法: "+err.Error()))
		return false
	}
	return true
}

// ── 生态应用 REST 壳（E1）──

func handleAppRegister(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req ecoservice.AppSvcReq
		if !decode(w, r, &req) {
			return
		}
		dto, err := svc.RegisterApp(r.Context(), tenantOf(r), actorOf(r), req)
		respond(w, r, dto, err)
	}
}

func handleAppList(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListApps(r.Context(), tenantOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handleAppAddVersion(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		var req struct {
			Version  string `json:"version"`
			Manifest string `json:"manifest"`
			HighRisk bool   `json:"high_risk"`
		}
		if !decode(w, r, &req) {
			return
		}
		dto, err := svc.AddAppVersion(r.Context(), tenantOf(r), id, req.Version, req.Manifest, req.HighRisk)
		respond(w, r, dto, err)
	}
}

func handleAppVersions(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		list, err := svc.ListAppVersions(r.Context(), tenantOf(r), id)
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handleAppPublish(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		vid, ok := pathID(w, r, "vid")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.PublishAppVersion(r.Context(), tenantOf(r), actorOf(r), id, vid))
	}
}

func handleAppDelist(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.DelistApp(r.Context(), tenantOf(r), id))
	}
}

func handleAppCatalog(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.Catalog(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handleAppInstall(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		dto, err := svc.InstallApp(r.Context(), tenantOf(r), actorOf(r), id)
		respond(w, r, dto, err)
	}
}

func handleAppUninstall(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.UninstallApp(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleMyInstalls(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.MyInstalls(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handleAppSetRollout(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		var req ecoservice.RolloutReq
		if !decode(w, r, &req) {
			return
		}
		dto, err := svc.SetRollout(r.Context(), tenantOf(r), actorOf(r), id, req)
		respond(w, r, dto, err)
	}
}

func handleAppGetRollout(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		dto, err := svc.GetRollout(r.Context(), tenantOf(r), id)
		respond(w, r, dto, err)
	}
}

// ── 技能市场 REST 壳（E4）──

func handleSkillPublish(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req ecoservice.SkillSvcReq
		if !decode(w, r, &req) {
			return
		}
		dto, err := svc.PublishSkill(r.Context(), tenantOf(r), actorOf(r), req)
		respond(w, r, dto, err)
	}
}

func handleSkillList(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListSkills(r.Context(), tenantOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handleSkillUpdate(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		var req ecoservice.SkillSvcReq
		if !decode(w, r, &req) {
			return
		}
		dto, err := svc.UpdateSkill(r.Context(), tenantOf(r), actorOf(r), id, req)
		respond(w, r, dto, err)
	}
}

func handleSkillDelist(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.DelistSkill(r.Context(), tenantOf(r), id))
	}
}

func handleSkillCatalog(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.SkillCatalog(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handleSkillInstall(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		dto, err := svc.InstallSkill(r.Context(), tenantOf(r), actorOf(r), id)
		respond(w, r, dto, err)
	}
}

func handleSkillUninstall(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.UninstallSkill(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleMySkills(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.MySkills(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}
