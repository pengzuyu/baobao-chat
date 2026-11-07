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
	"github.com/baobaowork/server/internal/kb"
	kbapi "github.com/baobaowork/server/internal/kb/api"
	kbrepo "github.com/baobaowork/server/internal/kb/repo"
	kbservice "github.com/baobaowork/server/internal/kb/service"
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

	// 知识库域（D07 阶段一务实版）：摄入管线同步版（嵌入经网关 bbw-embed）+
	// 混合检索（向量余弦 + 关键词 ILIKE，RRF 融合，权限前置过滤）
	var kbRepo kbrepo.Repo
	if pgPool != nil {
		kbRepo = kbrepo.NewPostgres(pgPool)
		if kp, ok := kbRepo.(*kbrepo.Postgres); ok {
			if vOK, ver := kp.VectorMode(); vOK {
				log.Printf("kb 检轨：pgvector %s（kb_chunk.embedding=vector(1024)，<=> 余弦排序）", ver)
			} else {
				log.Printf("kb 检轨：pgvector 不可用 → embedding 降级 float8[]（内存余弦 + ILIKE 兜底，登记）")
			}
		}
	} else {
		kbRepo = kbrepo.NewMemory()
	}
	// 嵌入链路：优先 HTTP 自调本服务网关 /v1/embeddings（bbw-embed，开发令牌通道——
	// 与真实调用方同路径：鉴权/限流/计量全过）；未配开发令牌时直调网关 Router 的
	// mock 供应商（联调零配置兜底）。测试注入假 EmbedFn 不走网络（任务约束）
	var kbEmbed kbservice.EmbedFn
	if devTok := os.Getenv("BBW_AIGW_DEV_TOKEN"); devTok != "" {
		kbEmbed = kbservice.GatewayEmbedFn("http://127.0.0.1"+cfg.HTTPAddr, devTok, nil)
		log.Printf("kb 嵌入链路：HTTP 网关 http://127.0.0.1%s/v1/embeddings（bbw-embed，开发令牌）", cfg.HTTPAddr)
	} else if cands, ok := aigwMod.Router.Route(aigw.AliasEmbed); ok && len(cands) > 0 {
		prov := cands[0].Provider
		kbEmbed = func(ctx context.Context, in []string) ([][]float32, error) {
			v, _, err := prov.Embed(ctx, in)
			return v, err
		}
		log.Println("kb 嵌入链路：直调网关 Router mock 供应商（未配 BBW_AIGW_DEV_TOKEN，1024 维确定性向量）")
	}
	kbMod := kb.NewModule(kbservice.Options{
		Embedder: kbEmbed,
		// 文件来源摄入：经 file 域票据通道取内容（IssueTicket 校验 owner/成员 →
		// Download 一次性票据回放流；跨模块不引 file 包，D02 §4 依赖规则）
		OpenFile: func(ctx context.Context, tenantID, userID, fileID int64) (kbservice.FileSource, error) {
			t, err := fileSvc.IssueTicket(ctx, tenantID, userID, fileID)
			if err != nil {
				return kbservice.FileSource{}, err
			}
			tok := strings.TrimPrefix(t.URL, "/api/v1/files/dl?t=")
			target, rc, err := fileSvc.Download(ctx, tok)
			if err != nil {
				return kbservice.FileSource{}, err
			}
			ext := ""
			if i := strings.LastIndex(target.Name, "."); i >= 0 {
				ext = strings.ToLower(target.Name[i+1:])
			}
			return kbservice.FileSource{
				Name: target.Name, Ext: ext, ContentType: target.ContentType,
				Size: target.Size, Body: rc,
			}, nil
		},
	}, kbRepo)
	kbSvc := kbMod.API()

	// 知识库 REST（D07 §5.1 阶段一务实版 10 项；摄入同步返回，jobs 为 docs 简版）
	mux.Handle("GET /api/v1/kb/spaces", authed(handleKBListSpaces(kbSvc)))
	mux.Handle("POST /api/v1/kb/spaces", authed(handleKBCreateSpace(kbSvc)))
	mux.Handle("GET /api/v1/kb/spaces/{id}/nodes", authed(handleKBListNodes(kbSvc)))
	mux.Handle("POST /api/v1/kb/spaces/{id}/nodes", authed(handleKBCreateNode(kbSvc)))
	mux.Handle("POST /api/v1/kb/spaces/{id}/docs", authed(handleKBIngest(kbSvc)))
	mux.Handle("GET /api/v1/kb/docs/{id}", authed(handleKBGetDoc(kbSvc)))
	mux.Handle("GET /api/v1/kb/docs/{id}/chunks", authed(handleKBGetChunks(kbSvc)))
	mux.Handle("POST /api/v1/kb/docs/{id}/reingest", authed(handleKBReingest(kbSvc)))
	mux.Handle("POST /api/v1/kb/query", authed(handleKBQuery(kbSvc)))
	mux.Handle("GET /api/v1/kb/jobs", authed(handleKBJobs(kbSvc)))

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

// ── 知识库 REST 壳（D07 阶段一务实版）──

// handleKBListSpaces 可见空间列表（个人空间惰性创建；?type= 过滤）
func handleKBListSpaces(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		spaces, err := svc.ListSpaces(r.Context(), tenant, uid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if typ := r.URL.Query().Get("type"); typ != "" {
			filtered := make([]kbapi.SpaceDTO, 0, len(spaces))
			for _, s := range spaces {
				if s.SpaceType == typ {
					filtered = append(filtered, s)
				}
			}
			spaces = filtered
		}
		httpx.OK(w, r, map[string]any{"items": spaces})
	}
}

// handleKBCreateSpace 新建空间（dept|company；personal 幂等返回惰性创建结果）
func handleKBCreateSpace(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		space, err := svc.CreateSpace(r.Context(), tenant, uid, req.Type, req.Name)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, space)
	}
}

// handleKBListNodes 目录懒加载（?parent_id= 缺省空间根：子目录 + 目录下文档）
func handleKBListNodes(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		spaceID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		parentID, _ := strconv.ParseInt(r.URL.Query().Get("parent_id"), 10, 64)
		children, err := svc.ListNodes(r.Context(), tenant, uid, spaceID, parentID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, children)
	}
}

// handleKBCreateNode 新建目录（7014 同名 / >10 层 9001）
func handleKBCreateNode(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		spaceID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Name     string `json:"name"`
			ParentID int64  `json:"parent_id"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		node, err := svc.CreateNode(r.Context(), tenant, uid, spaceID, req.ParentID, req.Name)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, node)
	}
}

// handleKBIngest 摄入（同步版 v0.1）：body {title?, text?, format?, file_id?, node_id?}
// —— text 粘贴 / file_id 引用 D06 文件二选一；返回即终态（ready/failed+error_msg）
func handleKBIngest(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		spaceID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Title  string `json:"title"`
			Text   string `json:"text"`
			Format string `json:"format"`
			FileID int64  `json:"file_id"`
			NodeID int64  `json:"node_id"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		doc, err := svc.IngestDoc(r.Context(), tenant, uid, spaceID, req.NodeID, req.Title, req.Format, req.Text, req.FileID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, doc)
	}
}

// handleKBGetDoc 文档详情（含状态/版本/错误）
func handleKBGetDoc(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		doc, err := svc.GetDoc(r.Context(), tenant, uid, docID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, doc)
	}
}

// handleKBGetChunks 分块三形态：?outline=1 大纲 / ?around=seq 上下文 / 缺省全量
func handleKBGetChunks(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		ctx := r.Context()
		switch {
		case r.URL.Query().Get("outline") != "":
			items, err := svc.GetOutline(ctx, tenant, uid, docID)
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			httpx.OK(w, r, map[string]any{"items": items})
		case r.URL.Query().Get("around") != "":
			seq, _ := strconv.Atoi(r.URL.Query().Get("around"))
			items, err := svc.ChunksAround(ctx, tenant, uid, docID, seq)
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			httpx.OK(w, r, map[string]any{"items": items})
		default:
			items, err := svc.ListChunks(ctx, tenant, uid, docID)
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			httpx.OK(w, r, map[string]any{"items": items})
		}
	}
}

// handleKBReingest 重摄入（version+1；file 来源重读，源失效 → failed 终态）
func handleKBReingest(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		doc, err := svc.ReingestDoc(r.Context(), tenant, uid, docID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, doc)
	}
}

// handleKBQuery 混合检索（keyword 必填；向量余弦 + ILIKE 两路 RRF 融合）
func handleKBQuery(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req kbapi.QueryReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		resp, err := svc.Query(r.Context(), tenant, uid, req.SpaceIDs, req.Keyword, req.TopK)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleKBJobs jobs 简版（?space_id= 必填，?status= 过滤；docs 列表代，登记）
func handleKBJobs(svc kbapi.KBService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := kbActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		spaceID, err := strconv.ParseInt(r.URL.Query().Get("space_id"), 10, 64)
		if err != nil || spaceID <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "space_id 必填"))
			return
		}
		items, err := svc.ListJobs(r.Context(), tenant, uid, spaceID, r.URL.Query().Get("status"))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}

// kbActor 知识库请求方（tenant + uid）
func kbActor(r *http.Request) (int64, int64, error) {
	uid, err := uidFrom(r)
	if err != nil {
		return 0, 0, err
	}
	return httpx.TenantID(r.Context()), uid, nil
}

// pathID 路径 ID 解析（kb 路由共用）
func pathID(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id <= 0 {
		return 0, errx.New(errx.CodeBadRequest, "路径 ID 非法")
	}
	return id, nil
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
