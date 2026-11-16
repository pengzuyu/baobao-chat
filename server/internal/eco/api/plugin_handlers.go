// 插件市场 REST 壳（D22 §3.2 / L1；注册挂在 handlers.go 两个 Register 内）。
package ecoapi

import (
	"io"
	"net/http"
	"strconv"

	ecoservice "github.com/baobaochat/server/internal/eco/service"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/httpx"
)

// ── 用户面 ──

// handlePluginUploadPrivate 个人上传（方案 A：draft 仅本人可见可装；管理员
// publish 审核后进公共市场；multipart package=zip+notes）
func handlePluginUploadPrivate(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(ecoservice.PluginMaxPackageBytes + 1<<20); err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "multipart 解析失败（包体 ≤10MB）"))
			return
		}
		file, _, err := r.FormFile("package")
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "缺 package 文件域（zip）"))
			return
		}
		defer file.Close()
		pkg, err := io.ReadAll(io.LimitReader(file, ecoservice.PluginMaxPackageBytes+1))
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "包体读取失败"))
			return
		}
		dto, err := svc.UploadPluginPrivate(r.Context(), tenantOf(r), actorOf(r), pkg, r.FormValue("notes"))
		respond(w, r, dto, err)
	}
}

func handlePluginCatalog(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		list, err := svc.PluginCatalog(r.Context(), tenantOf(r), actorOf(r),
			q.Get("q"), q.Get("category"), q.Get("component"))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handlePluginDetail(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, vers, err := svc.PluginDetail(r.Context(), tenantOf(r), actorOf(r), r.PathValue("plugin_id"))
		respond(w, r, map[string]any{"plugin": e, "versions": vers}, err)
	}
}

func handlePluginInstall(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Version string `json:"version"`
		}
		if !decode(w, r, &req) {
			return
		}
		dto, err := svc.InstallPlugin(r.Context(), tenantOf(r), actorOf(r), r.PathValue("plugin_id"), req.Version)
		respond(w, r, dto, err)
	}
}

func handlePluginDownload(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pkg, version, err := svc.DownloadPlugin(r.Context(), tenantOf(r), actorOf(r), r.PathValue("plugin_id"), r.URL.Query().Get("version"))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition",
			`attachment; filename="plugin-`+r.PathValue("plugin_id")+`-`+version+`.zip"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(pkg)))
		_, _ = w.Write(pkg)
	}
}

func handlePluginUninstall(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respond(w, r, map[string]bool{"ok": true},
			svc.UninstallPlugin(r.Context(), tenantOf(r), actorOf(r), r.PathValue("plugin_id")))
	}
}

func handleMyPlugins(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.MyPlugins(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

// ── 管理面 ──

// handlePluginUpload 发布：multipart（package=zip 必填；notes/policy 可选表单域）
func handlePluginUpload(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(ecoservice.PluginMaxPackageBytes + 1<<20); err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "multipart 解析失败（包体 ≤10MB）"))
			return
		}
		file, _, err := r.FormFile("package")
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "缺 package 文件域（zip）"))
			return
		}
		defer file.Close()
		pkg, err := io.ReadAll(io.LimitReader(file, ecoservice.PluginMaxPackageBytes+1))
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "包体读取失败"))
			return
		}
		policy := formInt(r, "policy")
		dto, err := svc.UploadPlugin(r.Context(), tenantOf(r), actorOf(r), pkg, r.FormValue("notes"), policy)
		respond(w, r, dto, err)
	}
}

func handlePluginAdminList(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListPluginsAdmin(r.Context(), tenantOf(r))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handlePluginVersions(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListPluginVersionsAdmin(r.Context(), tenantOf(r), r.PathValue("plugin_id"))
		respond(w, r, map[string]any{"items": list}, err)
	}
}

func handlePluginVersionPublish(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respond(w, r, map[string]bool{"ok": true},
			svc.PublishPluginVersion(r.Context(), tenantOf(r), r.PathValue("plugin_id"), r.PathValue("version")))
	}
}

func handlePluginUpdate(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req ecoservice.PluginMetaReq
		if !decode(w, r, &req) {
			return
		}
		respond(w, r, map[string]bool{"ok": true},
			svc.UpdatePluginMeta(r.Context(), tenantOf(r), r.PathValue("plugin_id"), req))
	}
}

func handlePluginDelist(svc *ecoservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respond(w, r, map[string]bool{"ok": true},
			svc.DelistPlugin(r.Context(), tenantOf(r), r.PathValue("plugin_id")))
	}
}

// ── helpers ──

func formInt(r *http.Request, key string) int {
	n, _ := strconv.Atoi(r.FormValue(key))
	return n
}
