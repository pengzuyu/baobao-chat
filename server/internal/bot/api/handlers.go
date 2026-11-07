// REST 壳（bot 包内自持——管理面 /api/v1/bots 与凭证面 /hook/bot/{hook_id}；
// 鉴权链由 main 挂载：管理面走 authed，hook 面无 Cookie/JWT——签名即凭证，
// 同 file dl 票据先例）。响应统一走 platform/httpx（14 篇 §5 信封）。
package botapi

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"

	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/httpx"
)

// RegisterAdminRoutes 管理面路由（authed = main 的 auth → tenant 链包装器；
// bot:manage / bot:install 权限点 v0.1 缺省放行登记——03 篇权限点字典接线后收口，
// 同 rtc 先例；会话安装的群主判定在服务层经 MemberRole 闭包执行）
func RegisterAdminRoutes(mux *http.ServeMux, authed func(http.HandlerFunc) http.Handler, svc BotService) {
	mux.Handle("POST /api/v1/bots", authed(handleCreateBot(svc)))
	mux.Handle("GET /api/v1/bots", authed(handleListBots(svc)))
	mux.Handle("GET /api/v1/bots/{id}", authed(handleGetBot(svc)))
	mux.Handle("POST /api/v1/bots/{id}/disable", authed(handleSetStatus(svc, false)))
	mux.Handle("POST /api/v1/bots/{id}/enable", authed(handleSetStatus(svc, true)))
	mux.Handle("POST /api/v1/bots/{id}/webhooks", authed(handleCreateWebhook(svc)))
	mux.Handle("POST /api/v1/bots/webhooks/{wid}/rotate", authed(handleRotate(svc)))
	mux.Handle("POST /api/v1/convs/{id}/bots/{bot_id}", authed(handleInstall(svc)))
	mux.Handle("DELETE /api/v1/convs/{id}/bots/{bot_id}", authed(handleUninstall(svc)))
}

// HandleHookDeliver Incoming 端点（POST /hook/bot/{hook_id}——外部系统视角 20 篇 §6.1）
func HandleHookDeliver(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hookID := r.PathValue("hook_id")
		raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 读取失败"))
			return
		}
		res, derr := svc.Deliver(r.Context(), hookID,
			r.Header.Get("X-BBW-Timestamp"), r.Header.Get("X-BBW-Signature"),
			raw, clientIP(r))
		if derr != nil {
			httpx.Fail(w, r, derr)
			return
		}
		httpx.OK(w, r, res)
	}
}

func handleCreateBot(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor := actorOf(r)
		var req CreateBotReq
		if err := decode(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		bot, err := svc.CreateBot(r.Context(), tenantOf(r), actor, req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, bot)
	}
}

func handleListBots(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status, _ := strconv.Atoi(r.URL.Query().Get("status"))
		bots, err := svc.ListBots(r.Context(), tenantOf(r), status)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": bots})
	}
}

func handleGetBot(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		bot, err := svc.GetBot(r.Context(), tenantOf(r), id)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, bot)
	}
}

func handleSetStatus(svc BotService, active bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.SetBotStatus(r.Context(), tenantOf(r), actorOf(r), id, active); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleCreateWebhook(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req CreateWebhookReq
		if err := decode(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		dto, reveal, err := svc.CreateIncomingWebhook(r.Context(), tenantOf(r), id, req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"webhook": dto, "secret": reveal})
	}
}

func handleRotate(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid, err := pathID(r, "wid")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		reveal, err := svc.RotateSecret(r.Context(), tenantOf(r), wid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, reveal)
	}
}

func handleInstall(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		convID, botID, err := convBotIDs(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.Install(r.Context(), tenantOf(r), actorOf(r), convID, botID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleUninstall(svc BotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		convID, botID, err := convBotIDs(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.Uninstall(r.Context(), tenantOf(r), actorOf(r), convID, botID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

// ── 壳工具 ──

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		return errx.New(errx.CodeBadRequest, "请求体非法")
	}
	return nil
}

func pathID(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id <= 0 {
		return 0, errx.New(errx.CodeBadRequest, "路径 ID 非法")
	}
	return id, nil
}

func convBotIDs(r *http.Request) (int64, int64, error) {
	convID, err := pathID(r, "id")
	if err != nil {
		return 0, 0, err
	}
	botID, err := pathID(r, "bot_id")
	if err != nil {
		return 0, 0, err
	}
	return convID, botID, nil
}

func tenantOf(r *http.Request) int64 { return httpx.TenantID(r.Context()) }
func actorOf(r *http.Request) int64 {
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	return uid
}

// clientIP 来源 IP（白名单/审计口径；XFF 首跳优先，反代场景语义与 httpx.ClientIP 对齐）
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range strings.Split(xff, ",") {
			if p := strings.TrimSpace(part); p != "" {
				return p
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
