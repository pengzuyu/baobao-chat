// REST 壳（mail 包内自持——用户面 /api/v1/mail/* 与治理面 /api/v1/admin/mail/*；
// 鉴权链由 main 挂载：用户面走 authed，治理面走 adminOnly——PAD-16 为租户
// 管理员功能）。响应统一 platform/httpx（14 篇 §5）。
package mailapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	mailrepo "github.com/baobaochat/server/internal/mail/repo"
	mailservice "github.com/baobaochat/server/internal/mail/service"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/httpx"
)

// RegisterRoutes 用户面路由（22 §6.1；reply/forward-im/cancel-send 随 mail_card
// 阶段二；drafts D16 已接）
func RegisterRoutes(mux *http.ServeMux, authed func(http.HandlerFunc) http.Handler, svc *mailservice.Service) {
	mux.Handle("GET /api/v1/mail/summary", authed(handleSummary(svc)))
	mux.Handle("GET /api/v1/mail/messages", authed(handleListMessages(svc)))
	mux.Handle("GET /api/v1/mail/messages/{id}", authed(handleGetMessage(svc)))
	mux.Handle("POST /api/v1/mail/messages", authed(handleSend(svc)))
	mux.Handle("POST /api/v1/mail/messages/{id}/read", authed(handleRead(svc)))
	mux.Handle("POST /api/v1/mail/messages/{id}/star", authed(handleStar(svc)))
	mux.Handle("POST /api/v1/mail/messages/{id}/move", authed(handleMove(svc)))
	mux.Handle("GET /api/v1/mail/search", authed(handleSearch(svc)))
	mux.Handle("GET /api/v1/mail/settings", authed(handleGetSettings(svc)))
	mux.Handle("PUT /api/v1/mail/settings", authed(handleUpdateSettings(svc)))
	mux.Handle("GET /api/v1/mail/app-passwords", authed(handleListAppPwd(svc)))
	mux.Handle("POST /api/v1/mail/app-passwords", authed(handleCreateAppPwd(svc)))
	mux.Handle("DELETE /api/v1/mail/app-passwords/{id}", authed(handleRevokeAppPwd(svc)))
	// 共享邮箱（22 §3.4；ACL viewer 读/owner 代发）
	mux.Handle("GET /api/v1/mail/shared", authed(handleSharedList(svc)))
	mux.Handle("GET /api/v1/mail/shared/{mid}/messages", authed(handleSharedMessages(svc)))
	mux.Handle("POST /api/v1/mail/shared/{mid}/messages", authed(handleSendAsShared(svc)))
	// 草稿（D16/22 §3.5：存续写+发送清理）
	mux.Handle("POST /api/v1/mail/drafts", authed(handleSaveDraft(svc)))
	mux.Handle("DELETE /api/v1/mail/drafts/{id}", authed(handleDiscardDraft(svc)))
}

// RegisterAdminRoutes 治理面路由（PAD-16 最小集：域/邮箱治理；
// 别名与 DNS 检测端点随阶段二）
func RegisterAdminRoutes(mux *http.ServeMux, adminOnly func(http.HandlerFunc) http.Handler, svc *mailservice.Service) {
	mux.Handle("GET /api/v1/admin/mail/domains", adminOnly(handleAdminDomains(svc)))
	mux.Handle("GET /api/v1/admin/mail/mailboxes", adminOnly(handleAdminMailboxes(svc)))
	mux.Handle("POST /api/v1/admin/mail/mailboxes", adminOnly(handleAdminOpenMailbox(svc)))
	mux.Handle("POST /api/v1/admin/mail/mailboxes/shared", adminOnly(handleAdminCreateShared(svc)))
	mux.Handle("POST /api/v1/admin/mail/mailboxes/{id}/suspend", adminOnly(handleAdminSuspend(svc)))
	mux.Handle("POST /api/v1/admin/mail/mailboxes/{id}/resume", adminOnly(handleAdminResume(svc)))
}

func handleSummary(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := svc.Summary(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, res, err)
	}
}

func handleListMessages(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		list, err := svc.ListMessages(r.Context(), tenantOf(r), actorOf(r),
			q.Get("folder"), cursor, limit, q.Get("filter"))
		respond(w, r, list, err)
	}
}

func handleGetMessage(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		msg, err := svc.GetMessage(r.Context(), tenantOf(r), actorOf(r), id)
		respond(w, r, msg, err)
	}
}

func handleSend(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req mailservice.SendReq
		if !decode(w, r, &req) {
			return
		}
		res, err := svc.SendMessage(r.Context(), tenantOf(r), actorOf(r), req)
		respond(w, r, res, err)
	}
}

func handleRead(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.MarkRead(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleStar(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		var body struct {
			On bool `json:"on"`
		}
		if !decode(w, r, &body) {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.SetStar(r.Context(), tenantOf(r), actorOf(r), id, body.On))
	}
}

func handleMove(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		var body struct {
			Folder string `json:"folder"`
		}
		if !decode(w, r, &body) {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.Move(r.Context(), tenantOf(r), actorOf(r), id, body.Folder))
	}
}

func handleSearch(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		list, err := svc.Search(r.Context(), tenantOf(r), actorOf(r),
			q.Get("q"), q.Get("attach") == "1" || q.Get("attach") == "true", limit)
		respond(w, r, list, err)
	}
}

func handleGetSettings(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := svc.GetSettings(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, res, err)
	}
}

func handleUpdateSettings(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var set mailrepo.Settings
		if !decode(w, r, &set) {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.UpdateSettings(r.Context(), tenantOf(r), actorOf(r), set))
	}
}

func handleListAppPwd(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListAppPasswords(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, list, err)
	}
}

func handleCreateAppPwd(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		if !decode(w, r, &body) {
			return
		}
		res, err := svc.CreateAppPassword(r.Context(), tenantOf(r), actorOf(r), body.Name)
		respond(w, r, res, err)
	}
}

func handleRevokeAppPwd(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.RevokeAppPassword(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleAdminDomains(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.AdminDomains(r.Context(), tenantOf(r))
		respond(w, r, list, err)
	}
}

func handleAdminMailboxes(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status, _ := strconv.Atoi(r.URL.Query().Get("status"))
		list, err := svc.AdminMailboxes(r.Context(), tenantOf(r), status)
		respond(w, r, list, err)
	}
}

func handleAdminOpenMailbox(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			UserID int64 `json:"user_id"`
		}
		if !decode(w, r, &body) {
			return
		}
		if body.UserID == 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "user_id 必填"))
			return
		}
		mb, err := svc.AdminOpenMailbox(r.Context(), tenantOf(r), body.UserID)
		respond(w, r, mb, err)
	}
}

func handleAdminSuspend(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.AdminSuspendMailbox(r.Context(), tenantOf(r), id))
	}
}

func handleAdminResume(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.AdminResumeMailbox(r.Context(), tenantOf(r), id))
	}
}

// ---------------------------------------------------------------------------
// 薄壳工具
// ---------------------------------------------------------------------------

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 读取失败"))
		return false
	}
	if len(raw) == 0 {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 为空"))
		return false
	}
	if err := json.Unmarshal(raw, v); err != nil {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 解析失败"))
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(key), 10, 64)
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

func tenantOf(r *http.Request) int64 {
	// 单租户阶段一 tenant=1（file 域同款；httpx.Tenant 中间件注入位随多租户）
	return 1
}

func handleSharedList(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.SharedMailboxes(r.Context(), tenantOf(r), actorOf(r))
		respond(w, r, list, err)
	}
}

func handleSharedMessages(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mid, err := strconv.ParseInt(r.PathValue("mid"), 10, 64)
		if err != nil || mid <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "mailbox id 非法"))
			return
		}
		q := r.URL.Query()
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		list, lerr := svc.ListSharedMessages(r.Context(), tenantOf(r), actorOf(r), mid,
			q.Get("folder"), cursor, limit, q.Get("filter"))
		respond(w, r, list, lerr)
	}
}

func handleSendAsShared(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mid, err := strconv.ParseInt(r.PathValue("mid"), 10, 64)
		if err != nil || mid <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "mailbox id 非法"))
			return
		}
		var req mailservice.SendReq
		if !decode(w, r, &req) {
			return
		}
		res, serr := svc.SendAsShared(r.Context(), tenantOf(r), actorOf(r), mid, req)
		respond(w, r, res, serr)
	}
}

func handleAdminCreateShared(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			LocalPart  string `json:"local_part"`
			GovernDept int64  `json:"govern_dept_id"`
		}
		if !decode(w, r, &body) {
			return
		}
		mb, err := svc.AdminCreateSharedMailbox(r.Context(), tenantOf(r), body.LocalPart, body.GovernDept)
		respond(w, r, mb, err)
	}
}

// handleSaveDraft POST /mail/drafts（D16：{to,cc,subject,body,attachments?,draft_id?}→{id}）
func handleSaveDraft(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			mailservice.SendReq
			DraftID int64 `json:"draft_id,string"`
		}
		if !decode(w, r, &req) {
			return
		}
		id, err := svc.SaveDraft(r.Context(), tenantOf(r), actorOf(r), req.SendReq, req.DraftID)
		respond(w, r, map[string]string{"id": strconv.FormatInt(id, 10)}, err)
	}
}

// handleDiscardDraft DELETE /mail/drafts/{id}（发送成功后清理；幂等）
func handleDiscardDraft(svc *mailservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true}, svc.DiscardDraft(r.Context(), tenantOf(r), actorOf(r), id))
	}
}
