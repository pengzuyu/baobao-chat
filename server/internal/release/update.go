// update.go：公开更新面（裸 JSON——Tauri updater 与官网按原格式直接消费，
// 不走内部 {code,data} 信封）。路径由接入层 nginx 转发：
//   /update/latest.json、/update/release-info.json → 本服务
//   /update/releases/**                            → 对象存储直出（不经本服务）
package release

import (
	"encoding/json"
	"net/http"
	"strings"

	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

// channelOf 解析 ?channel=（缺省 stable；非法值回落 stable）
func channelOf(r *http.Request) string {
	switch r.URL.Query().Get("channel") {
	case ChannelBeta:
		return ChannelBeta
	default:
		return ChannelStable
	}
}

// writeBare 裸 JSON 输出（无信封）
func writeBare(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// HandleLatestManifest GET /update/latest.json?channel=stable
func (m *Module) HandleLatestManifest(w http.ResponseWriter, r *http.Request) {
	base := m.baseURL(schemeOf(r), r.Host)
	mf, err := m.LatestManifest(r.Context(), bbcpg.DefaultTenantID, channelOf(r), base)
	if err != nil {
		http.Error(w, `{"error":"manifest unavailable"}`, http.StatusInternalServerError)
		return
	}
	// 无已发布版本 → 404 让接入层回落静态文件（脚本链路 publish.sh 写的 volumes/updates）
	// ——两套发布链路自动共存：D39 有数据走动态，无数据走静态
	if mf.Version == "" {
		http.NotFound(w, r)
		return
	}
	writeBare(w, mf)
}

// HandleReleaseInfo GET /update/release-info.json?channel=stable
func (m *Module) HandleReleaseInfo(w http.ResponseWriter, r *http.Request) {
	base := m.baseURL(schemeOf(r), r.Host)
	info, err := m.Info(r.Context(), bbcpg.DefaultTenantID, channelOf(r), base)
	if err != nil {
		http.Error(w, `{"error":"release info unavailable"}`, http.StatusInternalServerError)
		return
	}
	if len(info.Releases) == 0 {
		http.NotFound(w, r) // 同上：回落静态清单
		return
	}
	writeBare(w, info)
}

// schemeOf 请求协议推导（接入层透传 X-Forwarded-Proto；无则 http）
func schemeOf(r *http.Request) string {
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		return p
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}
// HandleReleaseDownload GET /update/releases/{key...} —— 制品下载 302 兜底。
// 接入层 nginx 部署形态：该路径由 nginx 直出对象存储，本路由不会被命中；
// 无接入层部署（bbc-app NodePort 直连，现网形态）：本服务 302 到对象存储匿名
// 直链（bbc-releases 桶只读公开，D39）。映射与清单 fileURL 一一对应：
//   /update/releases/<storage_key> → <ObjectPublicBase>/bbc-releases/releases/<storage_key>
func (m *Module) HandleReleaseDownload(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if key == "" || strings.Contains(key, "..") || strings.ContainsAny(key, `\`+"\x00") {
		http.NotFound(w, r) // 防御：空键/路径穿越（ServeMux 已清理路径，此处兜底直调）
		return
	}
	base := strings.TrimSuffix(m.opts.ObjectPublicBase, "/")
	if base == "" {
		http.Error(w, `{"error":"release download not configured"}`, http.StatusNotFound)
		return
	}
	http.Redirect(w, r, base+"/bbc-releases/releases/"+key, http.StatusFound)
}
