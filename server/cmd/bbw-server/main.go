// bbw-server 模块化单体入口（阶段一）。
// 装配：org/auth/message 模块 + 事件总线 + gateway(hub) + HTTP/WS 监听。
// 文档映射：D02 §1/§2/§6；拆分部署（--enable）与 gRPC 化留待阶段三。
package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/baobaowork/server/internal/aigw"
	"github.com/baobaowork/server/internal/auth"
	"github.com/baobaowork/server/internal/auth/api"
	"github.com/baobaowork/server/internal/auth/repo"
	"github.com/baobaowork/server/internal/auth/service"
	"github.com/baobaowork/server/internal/file"
	fileapi "github.com/baobaowork/server/internal/file/api"
	filerepo "github.com/baobaowork/server/internal/file/repo"
	fileservice "github.com/baobaowork/server/internal/file/service"
	filestore "github.com/baobaowork/server/internal/file/store"
	"github.com/baobaowork/server/internal/gateway"
	"github.com/baobaowork/server/internal/message"
	"github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/message/repo"
	"github.com/baobaowork/server/internal/message/service"
	"github.com/baobaowork/server/internal/org"
	"github.com/baobaowork/server/internal/org/api"
	"github.com/baobaowork/server/internal/org/repo"
	"github.com/baobaowork/server/internal/platform/authjwt"
	"github.com/baobaowork/server/internal/platform/config"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
	"github.com/baobaowork/server/internal/platform/httpx"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	cfg := config.Load()
	if len(cfg.JWTSecret) < 32 {
		log.Fatal("BBW_JWT_SECRET 长度需 ≥32 字节")
	}
	signer := authjwt.NewSigner([]byte(cfg.JWTSecret))
	bus := eventbus.New()

	// ── 存储装配：BBW_DB_DSN 非空 → PostgreSQL（迁移 + 三域 PG 仓）；空 → 内存回退 ──
	var (
		orgRepo     orgrepo.Repo
		msgRepo     messagerepo.Repo
		tokenRepo   authrepo.RefreshTokenRepo
		deviceRepo  authrepo.DeviceRepo
		attemptRepo authrepo.LoginAttemptStore
	)
	var pgPool *pgxpool.Pool
	if cfg.DBDSN != "" {
		pool, err := bbwpg.New(context.Background(), cfg.DBDSN) // AfterConnect 会话级 SET app.tenant=1（RLS 兜底）
		if err != nil {
			log.Fatalf("PG 连接失败: %v", err)
		}
		defer pool.Close()
		pgPool = pool
		if err := bbwpg.Migrate(context.Background(), pool); err != nil {
			log.Fatalf("PG 迁移失败: %v", err)
		}
		orgRepo = orgrepo.NewPostgres(pool)
		msgRepo = messagerepo.NewPostgres(pool)
		tokenRepo = authrepo.NewPostgresTokens(pool)
		deviceRepo = authrepo.NewPostgresDevices(pool)
		attemptRepo = authrepo.NewMemory() // 防爆破计数短时态：保留内存（生产 Redis TTL，03 篇 §2.3）
		log.Printf("存储模式：PostgreSQL（RLS app.tenant=%d 兜底已启用）", bbwpg.DefaultTenantID)
	} else {
		orgRepo = orgrepo.NewMemory()
		msgRepo = messagerepo.NewMemory()
		memAuth := authrepo.NewMemory()
		tokenRepo, deviceRepo, attemptRepo = memAuth, memAuth, memAuth
		log.Println("存储模式：memory（未设置 BBW_DB_DSN）")
	}

	// ── 模块装配（D02 §3：构造注入，禁止全局单例） ──
	orgMod := org.NewModule(orgRepo)
	authMod := auth.NewModule(orgMod.API(), signer, cfg, tokenRepo, deviceRepo, attemptRepo)

	// 文件域（D06 阶段一务实版）：本地磁盘存储 + 短期一次性票据下载；
	// 会话成员判定经闭包查 message 仓（跨模块不引 message 包，D02 §4 依赖规则）
	fileStore := filestore.NewLocal(envOr("BBW_DATA_DIR", "./data"))
	var fileRepo filerepo.Repo
	if pgPool != nil {
		fileRepo = filerepo.NewPostgres(pgPool)
	} else {
		fileRepo = filerepo.NewMemory()
	}
	fileMod := file.NewModule(fileservice.Options{
		MaxUploadBytes: 20 << 20, // 单文件 20MB（v0.1 无分片：客户端单请求 multipart 直传，登记）
		TicketTTL:      120 * time.Second,
		IsConvMember: func(ctx context.Context, userID, convID int64) bool {
			m, err := msgRepo.MemberOf(ctx, convID, userID)
			return err == nil && m != nil && m.Status == 1
		},
	}, fileRepo, fileStore)
	fileSvc := fileMod.API()

	msgMod := message.NewModule(msgRepo, bus, messageservice.Options{
		// 发送人名称解析：闭包经 org 仓查询（跨模块不引 org 包，D02 §4 依赖规则）
		NameOf: func(id int64) string {
			if u, err := orgRepo.GetUser(context.Background(), id); err == nil && u != nil {
				return u.DisplayName
			}
			return ""
		},
		// 文件消息校验/回填（D06 阶段一：msg.send type=file/image 的 body.file_id）
		FileCheck:    fileSvc.CheckSendable,
		FileMarkSent: fileSvc.MarkSent,
	})

	hub := gateway.NewHub()
	gw := gateway.New(hub, bus, msgMod.API(), authMod.API().Verify, cfg.WSHeartbeat)

	if cfg.SeedDemoData {
		seedDemo(orgRepo, msgRepo)
	}

	// ── 路由 ──
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.OK(w, r, map[string]string{"status": "ok", "stage": "stage1"})
	})

	// 认证 REST（03 篇 §7）
	authAPI := authMod.API()
	mux.HandleFunc("POST /api/v1/auth/login", handleLogin(authAPI))
	mux.HandleFunc("POST /api/v1/auth/refresh", handleRefresh(authAPI))

	// 受保护路由：auth → tenant（D02 §6 链尾两环）
	authed := func(h http.HandlerFunc) http.Handler {
		return httpx.Chain(h, httpx.Auth(authAPI.Verify), httpx.Tenant)
	}
	mux.Handle("POST /api/v1/auth/obo/token", authed(handleOBO(authAPI)))
	mux.Handle("POST /api/v1/auth/logout", authed(handleLogout(authAPI)))
	mux.Handle("GET /api/v1/me", authed(handleMe))

	// 消息 REST（04 篇 §6.1 摘要：会话列表 + 历史拉取；其余走 WS）
	mux.Handle("GET /api/v1/convs", authed(handleListConvs(msgMod.API())))
	mux.Handle("GET /api/v1/convs/{id}", authed(handleConvDetail(msgMod.API())))
	mux.Handle("GET /api/v1/convs/{id}/members", authed(handleConvMembers(msgMod.API())))
	mux.Handle("GET /api/v1/convs/{id}/messages", authed(handleListMessages(msgMod.API())))
	// TODO(阶段二)：GET /api/v1/convs/{id}/receipts 群已读回执面板（API-IM-06，租户 im.read_receipt 策略联动）
	// 会话交互 REST（D03 §5.1：编辑/撤回/转发/会话态）
	mux.Handle("POST /api/v1/messages/{id}/recall", authed(handleRecallMessage(msgMod.API())))
	mux.Handle("PATCH /api/v1/messages/{id}", authed(handleEditMessage(msgMod.API())))
	mux.Handle("POST /api/v1/messages/forward", authed(handleForward(msgMod.API())))
	mux.Handle("PATCH /api/v1/convs/{id}/state", authed(handleConvState(msgMod.API())))
	// 增量同步（API-IM-01：登录/重连补投）
	mux.Handle("GET /api/v1/sync", authed(handleSync(msgMod.API())))
	// 收藏（D03 §3.8 PIM-08；API-IM-10/11）
	mux.Handle("POST /api/v1/messages/{id}/favorite", authed(handleFavoriteMessage(msgMod.API())))
	mux.Handle("DELETE /api/v1/messages/{id}/favorite", authed(handleUnfavoriteMessage(msgMod.API())))
	mux.Handle("GET /api/v1/favorites", authed(handleListFavorites(msgMod.API())))
	// 全局搜索（D03 §3.7 PIM-07 服务端态；API-IM-12——本地 FTS5 属 Tauri/Rust 侧，不在本路由）
	mux.Handle("GET /api/v1/messages/search", authed(handleSearchMessages(msgMod.API())))
	// 通知中心（D03 §3.9 PIM-09：列表/已读/未读数；推送走 WS notification.new）
	mux.Handle("GET /api/v1/notifications", authed(handleListNotifications(msgMod.API())))
	mux.Handle("POST /api/v1/notifications/read", authed(handleNotificationsRead(msgMod.API())))
	mux.Handle("GET /api/v1/notifications/unread_count", authed(handleUnreadNotificationCount(msgMod.API())))

	// 文件 REST（D06 阶段一务实版：multipart 直传/一次性票据下载/我的文件/软删；
	// check/uploads/complete 分片会话与 shares 外链阶段二，登记）
	mux.Handle("POST /api/v1/files/upload", authed(handleFileUpload(fileSvc)))
	mux.Handle("GET /api/v1/files/me", authed(handleMyFiles(fileSvc)))
	mux.Handle("GET /api/v1/files/{id}/ticket", authed(handleFileTicket(fileSvc)))
	mux.Handle("DELETE /api/v1/files/{id}", authed(handleFileDelete(fileSvc)))
	// dl 不挂鉴权中间件——票据即凭证（120s 一次性；4014 失效/复用）
	mux.HandleFunc("GET /api/v1/files/dl", handleFileDownload(fileSvc))

	// AI 网关（docs/19 §6：OpenAI 兼容入口；独立鉴权链——JWT/OBO/开发令牌，不走 /api/v1 authed）
	aigwMod := aigw.NewModule(pgPool, func(token string) (*authjwt.Claims, error) {
		return authAPI.Verify(context.Background(), token)
	})
	mux.HandleFunc("POST /v1/chat/completions", aigwMod.Gateway.HandleChat)
	mux.HandleFunc("POST /v1/embeddings", aigwMod.Gateway.HandleEmbeddings)

	// WS 接入（14 篇 §2.1：token/did 走查询参数）
	mux.Handle("/ws/connect", http.HandlerFunc(gw.ServeWS))

	// 全局中间件链（D02 §6 固定顺序：trace→recovery→access-log→rate-limit→…）
	limiter := httpx.NewLimiter(50, 100)                                                  // 阶段一按 IP；三档（租户/用户/Agent）阶段二接 Redis
	corsOrigins := strings.Split(envOr("BBW_CORS_ORIGINS", "http://localhost:5173"), ",") // 开发态跨域；生产同源反代空转
	handler := httpx.Chain(mux,
		httpx.Trace,
		httpx.Recovery,
		httpx.CORS(corsOrigins),
		httpx.AccessLog,
		httpx.RateLimit(limiter, httpx.ClientIP),
	)

	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Printf("bbw-server(阶段一) 监听 %s | WS: /ws/connect | 健康检查: /healthz", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	// 优雅退出
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	log.Println("bye")
}

// ── REST handlers（薄壳：解码 → 调 api → 统一响应包） ──

func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return errx.New(errx.CodeBadRequest, "请求体非法")
	}
	return nil
}

func handleLogin(svc authapi.AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req authapi.LoginReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		pair, err := svc.Login(r.Context(), req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, pair)
	}
}

func handleRefresh(svc authapi.AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req authapi.RefreshReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		pair, err := svc.Refresh(r.Context(), req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, pair)
	}
}

type logoutReq struct {
	DID string `json:"did"`
	All bool   `json:"all"`
}

func handleLogout(svc authapi.AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := httpx.Claims(r.Context())
		var req logoutReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		uid, _ := strconv.ParseInt(claims.Subject, 10, 64)
		if err := svc.Logout(r.Context(), uid, req.DID, req.All); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleOBO(svc authapi.AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := httpx.Claims(r.Context())
		var req authapi.OBOReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		uid, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeAuthTokenRevoked, "sub 非法"))
			return
		}
		token, err := svc.IssueOBO(r.Context(), uid, req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]string{"obo_token": token})
	}
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	c := httpx.Claims(r.Context())
	resp := map[string]any{
		"sub":    c.Subject,
		"tenant": c.TenantID,
		"scope":  c.Scope,
		"did":    c.DeviceID,
		"obo":    c.IsOBO(),
	}
	httpx.OK(w, r, resp)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// handleListConvs 会话列表（API-IM-02：filter 阶段二接 user_conv_state 过滤）
func handleListConvs(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := httpx.Claims(r.Context())
		uid, err := strconv.ParseInt(claims.Subject, 10, 64)
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "身份非法"))
			return
		}
		convs, err := svc.ListUserConversations(r.Context(), uid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": convs, "has_more": false})
	}
}

func handleListMessages(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		convID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "会话 ID 非法"))
			return
		}
		// TODO(阶段二)：成员权限校验（非成员拒 3001）
		after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		// order=-seq（缺省）：最新 N 条首屏；after/before 补洞走升序区间（D03 API-IM-04）
		var (
			msgs []messageapi.Message
			gerr error
		)
		if after == 0 && before == 0 && r.URL.Query().Get("order") != "seq" {
			msgs, gerr = svc.ListMessagesLatest(r.Context(), convID, limit)
		} else {
			msgs, gerr = svc.ListMessages(r.Context(), convID, after, before, limit)
		}
		if gerr != nil {
			httpx.Fail(w, r, gerr)
			return
		}
		httpx.OK(w, r, map[string]any{"items": msgs, "has_more": false})
	}
}

// handleConvDetail 会话详情（API-IM-03：conversation 全字段 + group_setting + my + 成员概要）
func handleConvDetail(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		convID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || convID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "会话 ID 非法"))
			return
		}
		detail, err := svc.GetConvDetail(r.Context(), uid, convID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, detail)
	}
}

// handleConvMembers 成员列表（API-IM-05 简版：在群成员含 role/mute_until；分页/role 过滤阶段二）
func handleConvMembers(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		convID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || convID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "会话 ID 非法"))
			return
		}
		members, err := svc.ListMembers(r.Context(), uid, convID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": members, "has_more": false})
	}
}

// handleRecallMessage 撤回（D03 API-IM-07）
func handleRecallMessage(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		msgID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || msgID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "消息 ID 非法"))
			return
		}
		var req struct {
			Reason string `json:"reason"`
		}
		_ = decodeJSON(r, &req) // body 可空
		res, err := svc.Recall(r.Context(), uid, msgID, req.Reason)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleEditMessage 编辑（D03 API-IM-08：body.text）
func handleEditMessage(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		msgID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || msgID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "消息 ID 非法"))
			return
		}
		var req struct {
			Body struct {
				Text string `json:"text"`
			} `json:"body"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.Edit(r.Context(), uid, msgID, req.Body.Text)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleForward 转发（D03 API-IM-09）
func handleForward(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req messageapi.ForwardPayload
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.Forward(r.Context(), uid, req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleConvState 置顶/免打扰/草稿（D03 API-IM-13）
func handleConvState(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		convID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || convID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "会话 ID 非法"))
			return
		}
		var patch messageapi.ConvStatePatch
		if err := decodeJSON(r, &patch); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.UpdateConvState(r.Context(), uid, convID, patch)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleSync 增量同步（API-IM-01：GET ?cursors={"1":10}&limit=100）
func handleSync(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		raw := r.URL.Query().Get("cursors")
		cursors := map[string]int64{}
		if raw != "" {
			if err := json.Unmarshal([]byte(raw), &cursors); err != nil {
				httpx.Fail(w, r, errx.New(errx.CodeIMInvalidCursor, "cursors 非法 JSON"))
				return
			}
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		res, err := svc.Sync(r.Context(), uid, cursors, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// uidFrom 从 auth claims 取 uid（REST 壳统一入口）
func uidFrom(r *http.Request) (int64, error) {
	claims := httpx.Claims(r.Context())
	uid, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil || uid <= 0 {
		return 0, errx.New(errx.CodeBadRequest, "身份非法")
	}
	return uid, nil
}

// ── 搜索与收藏 REST 壳（D03 §3.7 PIM-07 / §3.8 PIM-08）──

// msgIDFrom 路径消息 ID 解析（收藏/取消收藏共用）
func msgIDFrom(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, errx.New(errx.CodeBadRequest, "消息 ID 非法")
	}
	return id, nil
}

// handleFavoriteMessage 收藏（API-IM-10 POST：幂等 UK；上限 1000→3022）
func handleFavoriteMessage(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		msgID, err := msgIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.Favorite(r.Context(), uid, msgID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleUnfavoriteMessage 取消收藏（API-IM-10 DELETE：幂等 no-op，响应 {}）
func handleUnfavoriteMessage(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		msgID, err := msgIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.Unfavorite(r.Context(), uid, msgID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

// handleListFavorites 收藏列表（API-IM-11：cursor/limit/type；type=消息类型过滤）
func handleListFavorites(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		res, err := svc.ListFavorites(r.Context(), uid, r.URL.Query().Get("type"), cursor, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleSearchMessages 服务端态搜索（API-IM-12：keyword 必填；
// from_uid/conv_id/type/from_ts/to_ts/cursor/limit 过滤器 AND 组合）
func handleSearchMessages(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		q := r.URL.Query()
		fromUID, _ := strconv.ParseInt(q.Get("from_uid"), 10, 64)
		convID, _ := strconv.ParseInt(q.Get("conv_id"), 10, 64)
		fromTS, _ := strconv.ParseInt(q.Get("from_ts"), 10, 64)
		toTS, _ := strconv.ParseInt(q.Get("to_ts"), 10, 64)
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		res, err := svc.SearchMessages(r.Context(), uid, messageapi.SearchParams{
			Keyword: q.Get("keyword"), FromUID: fromUID, ConvID: convID, Type: q.Get("type"),
			FromTS: fromTS, ToTS: toTS, Cursor: cursor, Limit: limit,
		})
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// ── 通知中心 REST 壳（D03 §3.9 PIM-09）──

// handleListNotifications 通知列表（API-IM-14：kind 分组 + unread_only + cursor 翻页）
func handleListNotifications(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		q := r.URL.Query()
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		res, err := svc.ListNotifications(r.Context(), uid, q.Get("kind"), q.Get("unread_only") == "1" || q.Get("unread_only") == "true", cursor, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleNotificationsRead 已读（POST：{ids?:[], all?:bool}——ids 单条/多条，all 全部）
func handleNotificationsRead(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req messageapi.NotificationReadPayload
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.MarkNotificationsRead(r.Context(), uid, req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{})
	}
}

// handleUnreadNotificationCount 未读计数（红点数据源；端内 99+ 封顶）
func handleUnreadNotificationCount(svc messageapi.MessageService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.UnreadNotificationCount(r.Context(), uid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// ── 文件 REST 壳（D06 阶段一务实版）──

// handleFileUpload multipart 直传：file + 可选 conv_id（单请求 ≤20MB，无分片）
func handleFileUpload(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		tenant := httpx.TenantID(r.Context())
		// MaxBytesReader 前置兜底（正文超限快速失败；service 内流式判定为权威 4009）
		r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
		mr, err := r.MultipartReader()
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "multipart 请求非法"))
			return
		}
		// multipart part 只能在遍历期间读取（NextPart 会耗尽上一 part）：
		// file part 先转存 OS 临时文件，遍历结束后再流式交给 service
		var (
			tmpFile     *os.File
			fileName    string
			contentType string
			convID      int64
			gotFile     bool
		)
		cleanup := func() {
			if tmpFile != nil {
				tmpFile.Close()
				os.Remove(tmpFile.Name())
			}
		}
		defer cleanup()
		for {
			part, perr := mr.NextPart()
			if perr == io.EOF {
				break
			}
			if perr != nil {
				httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "multipart 解析失败"))
				return
			}
			switch part.FormName() {
			case "file":
				if !gotFile { // 多文件只取首个（D06 §3.3 多文件逐张成消息由端侧拆分）
					tmp, terr := os.CreateTemp("", "bbw-upload-*")
					if terr != nil {
						httpx.Fail(w, r, errx.New(errx.CodeInternal, "临时文件创建失败"))
						return
					}
					if _, cerr := io.Copy(tmp, part); cerr != nil { // 32MB 上限由 MaxBytesReader 兜底
						tmp.Close()
						os.Remove(tmp.Name())
						httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "file 字段读取失败"))
						return
					}
					tmpFile, fileName, contentType, gotFile = tmp, part.FileName(), part.Header.Get("Content-Type"), true
				}
			case "conv_id":
				b, _ := io.ReadAll(io.LimitReader(part, 64))
				convID, _ = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
			default: // 未知字段忽略（向前兼容）
			}
		}
		if !gotFile || tmpFile == nil {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "缺少 file 字段"))
			return
		}
		if _, err := tmpFile.Seek(0, io.SeekStart); err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeInternal, "临时文件读取失败"))
			return
		}
		res, err := svc.Upload(r.Context(), tenant, uid, fileName, contentType, convID, tmpFile)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleMyFiles 我的文件列表（软删排除；v0.1 全量不分页）
func handleMyFiles(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		items, err := svc.ListMine(r.Context(), httpx.TenantID(r.Context()), uid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items, "has_more": false})
	}
}

// handleFileTicket 取下载票据（owner 或 conv 成员；一次性 120s）
func handleFileTicket(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		fileID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || fileID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "文件 ID 非法"))
			return
		}
		res, err := svc.IssueTicket(r.Context(), httpx.TenantID(r.Context()), uid, fileID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleFileDelete owner 软删
func handleFileDelete(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		fileID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || fileID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "文件 ID 非法"))
			return
		}
		if err := svc.SoftDelete(r.Context(), httpx.TenantID(r.Context()), uid, fileID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

// handleFileDownload 票据下载：校验 → 流式回文件（Content-Type/Disposition；票据即凭证无鉴权）
func handleFileDownload(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("t")
		if token == "" {
			httpx.Fail(w, r, errx.New(errx.CodeFileTicketInvalid, "缺少下载票据"))
			return
		}
		target, rc, err := svc.Download(r.Context(), token)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		defer rc.Close()
		w.Header().Set("Content-Type", target.ContentType)
		w.Header().Set("Content-Length", strconv.FormatInt(target.Size, 10))
		w.Header().Set("Content-Disposition",
			mime.FormatMediaType("attachment", map[string]string{"filename": target.Name}))
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, rc)
	}
}

// seedDemo 演示数据：alice/bob（口令 demo-pass-123）+ 单聊会话。
// 幂等：alice 已存在即跳过——PG 模式重启不重复灌数据（users 有 UK(tenant,empno)，
// 重复 INSERT 必失败）；内存模式每次进程内冷启动照常灌。
func seedDemo(orgRepo orgrepo.Repo, msgRepo messagerepo.Repo) {
	ctx := context.Background()
	if u, err := orgRepo.GetUserByLogin(ctx, 1, "alice"); err == nil && u != nil {
		log.Printf("demo 数据已存在（alice uid=%d），跳过 seed", u.ID)
		return
	}
	hash, err := authservice.HashPassword("demo-pass-123")
	if err != nil {
		log.Fatalf("seed: %v", err)
	}
	users := []orgapi.User{
		{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "alice", DisplayName: "Alice",
			Email: "alice@bbw.io", PasswordHash: hash, Status: orgapi.UserStatusActive,
			Scopes: []string{"im:message:send", "agent:session:use"}},
		{TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "bob", DisplayName: "Bob",
			Email: "bob@bbw.io", PasswordHash: hash, Status: orgapi.UserStatusActive,
			Scopes: []string{"im:message:send"}},
	}
	ids := make([]int64, 0, len(users))
	for _, u := range users {
		created, err := orgRepo.CreateUser(ctx, u)
		if err != nil {
			log.Fatalf("seed user: %v", err)
		}
		ids = append(ids, created.ID)
	}
	conv, err := msgRepo.CreateConversation(ctx, messagerepo.Conversation{
		TenantID: 1, Type: messageapi.ConvSingle, Name: "alice-bob",
	})
	if err != nil {
		log.Fatalf("seed conv: %v", err)
	}
	for _, uid := range ids {
		if err := msgRepo.AddMember(ctx, messagerepo.Member{ConvID: conv.ID, UserID: uid}); err != nil {
			log.Fatalf("seed member: %v", err)
		}
	}
	log.Printf("demo 数据就绪：alice/bob（口令 demo-pass-123，租户 1），会话 %d", conv.ID)
}
