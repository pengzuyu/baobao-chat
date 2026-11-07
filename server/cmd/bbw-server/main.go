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
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/baobaowork/server/internal/admin"
	adminapi "github.com/baobaowork/server/internal/admin/api"
	adminrepo "github.com/baobaowork/server/internal/admin/repo"
	adminservice "github.com/baobaowork/server/internal/admin/service"
	"github.com/baobaowork/server/internal/aigw"
	"github.com/baobaowork/server/internal/auth"
	"github.com/baobaowork/server/internal/auth/api"
	"github.com/baobaowork/server/internal/auth/repo"
	"github.com/baobaowork/server/internal/auth/service"
	"github.com/baobaowork/server/internal/bot"
	botapi "github.com/baobaowork/server/internal/bot/api"
	botrepo "github.com/baobaowork/server/internal/bot/repo"
	botservice "github.com/baobaowork/server/internal/bot/service"
	"github.com/baobaowork/server/internal/doc"
	docapi "github.com/baobaowork/server/internal/doc/api"
	docrepo "github.com/baobaowork/server/internal/doc/repo"
	docservice "github.com/baobaowork/server/internal/doc/service"
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
	"github.com/baobaowork/server/internal/mail"
	mailapi "github.com/baobaowork/server/internal/mail/api"
	mailrepo "github.com/baobaowork/server/internal/mail/repo"
	mailservice "github.com/baobaowork/server/internal/mail/service"
	"github.com/baobaowork/server/internal/mcpgw"
	"github.com/baobaowork/server/internal/meeting"
	meetingapi "github.com/baobaowork/server/internal/meeting/api"
	meetingrepo "github.com/baobaowork/server/internal/meeting/repo"
	meetingservice "github.com/baobaowork/server/internal/meeting/service"
	"github.com/baobaowork/server/internal/message"
	"github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/message/repo"
	"github.com/baobaowork/server/internal/message/service"
	"github.com/baobaowork/server/internal/org"
	orgacl "github.com/baobaowork/server/internal/org/acl"
	"github.com/baobaowork/server/internal/org/api"
	"github.com/baobaowork/server/internal/org/repo"
	"github.com/baobaowork/server/internal/platform/authjwt"
	"github.com/baobaowork/server/internal/platform/config"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
	"github.com/baobaowork/server/internal/platform/httpx"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
	"github.com/baobaowork/server/internal/rtc"
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

	// 文件域（D06 阶段一+阶段二 server 侧）：本地磁盘存储 + 一次性票据下载 +
	// 分片上传会话（check 秒传/uploads/PATCH 分片/complete）+ 分享外链；
	// 会话成员判定经闭包查 message 仓（跨模块不引 message 包，D02 §4 依赖规则）
	fileStore := filestore.NewLocal(envOr("BBW_DATA_DIR", "./data"))
	var fileRepo filerepo.Repo
	var fileShares filerepo.ShareRepo
	var fileTransfers filerepo.TransferRepo
	if pgPool != nil {
		fileRepo = filerepo.NewPostgres(pgPool)
		fileShares = filerepo.NewPostgresShares(pgPool)
		fileTransfers = filerepo.NewPostgresTransfers(pgPool)
	} else {
		fileRepo = filerepo.NewMemory()
		fileShares = filerepo.NewMemoryShares()
		fileTransfers = filerepo.NewMemoryTransfers()
	}
	fileMod := file.NewModule(fileservice.Options{
		MaxUploadBytes: 20 << 20, // 单文件 20MB（multipart 直传与 complete 合并共用上限）
		TicketTTL:      120 * time.Second,
		IsConvMember: func(ctx context.Context, userID, convID int64) bool {
			m, err := msgRepo.MemberOf(ctx, convID, userID)
			return err == nil && m != nil && m.Status == 1
		},
	}, fileRepo, fileShares, fileTransfers, fileStore)
	fileSvc := fileMod.API()

	// 管理域仓储先行（D10 阶段一务实版）：敏感词库热更闭包需在 message 装配前就绪
	// （词库权威源属 admin 域，message 域 3005 校验经闭包实时读，D02 §4 跨域不引包）
	var adminStore adminrepo.Repo
	if pgPool != nil {
		adminStore = adminrepo.NewPostgres(pgPool)
	} else {
		adminStore = adminrepo.NewMemory()
	}

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
		// 敏感词热更源（D10 策略页增删即时生效 3005；阶段一单租户 tenant=1）
		SensitiveWordSource: func() []string {
			words, err := adminStore.EnabledSensitiveWords(context.Background(), 1)
			if err != nil {
				return nil // 读失败放行（词库不可用不应阻断全量消息，fail-open 登记阶段二收紧）
			}
			return words
		},
	})

	hub := gateway.NewHub()
	// WS 鉴权链追加用户态校验（D10 禁用即踢线的承接环）：JWT 通过但用户已禁用 → 拒绝，
	// 客户端重连风暴收敛为持续 offline（refresh 已吊销，静默刷新失败登出兜底）
	wsVerify := func(ctx context.Context, token string) (*authjwt.Claims, error) {
		c, err := authMod.API().Verify(ctx, token)
		if err != nil {
			return nil, err
		}
		uid, perr := strconv.ParseInt(c.Subject, 10, 64)
		if perr != nil {
			return nil, perr
		}
		if u, uerr := orgRepo.GetUser(ctx, uid); uerr == nil && u.Status != orgapi.UserStatusActive {
			return nil, errx.New(errx.CodeUserDisabled, "用户已禁用")
		}
		return c, nil
	}
	gw := gateway.New(hub, bus, msgMod.API(), wsVerify, cfg.WSHeartbeat)

	// ── rtc 通话域（D04 阶段一务实版）：服务端纯信令 + call_card 落流 ──
	// 推送经 hub 扇出（进程内直调 rtc service，无需 eventbus——通话推送瞬态无落库语义，登记）；
	// 通话记录=IM 流内 call_card 消息，服务端不建表（CallRegistry 内存态）；权限 rtc:call:start
	// v0.1 无权限点字典缺省放行（03 篇登记后接入）。
	rtcMod := rtc.NewModule(gateway.RtcPusher{Hub: hub}, rtcCardSink{msgs: msgMod.API()}, rtc.Options{
		// 会话/成员校验经 message 仓闭包（跨模块不引 message 包，D02 §4 依赖规则）
		IsConvActive: func(ctx context.Context, convID int64) bool {
			c, err := msgRepo.GetConversation(ctx, convID)
			return err == nil && c != nil && c.Status == messageapi.ConvActive
		},
		// 群呼全员 ringing 目标集（D04 阶段二 join 模式）
		ConvMembersOf: func(ctx context.Context, convID int64) []int64 {
			ids, err := msgRepo.MembersOf(ctx, convID)
			if err != nil {
				return nil
			}
			return ids
		},
		// 被叫忙放行（OQ-C06 配套：端侧收 ringing 自动回 busy / bye_call_id 挂旧接新）
		AllowBusyCallee: true,
		IsConvMember: func(ctx context.Context, convID, userID int64) bool {
			m, err := msgRepo.MemberOf(ctx, convID, userID)
			return err == nil && m != nil && m.Status == 1
		},
		NameOf: func(id int64) string {
			if u, err := orgRepo.GetUser(context.Background(), id); err == nil && u != nil {
				return u.DisplayName
			}
			return ""
		},
	})
	gw.MountRTC(rtcMod.API())

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

	// 文件 REST（D06 阶段一+阶段二 server 侧：multipart 直传/一次性票据下载/
	// 我的文件/软删 + check 秒传/分片会话/complete + 分享外链）
	mux.Handle("POST /api/v1/files/upload", authed(handleFileUpload(fileSvc)))
	mux.Handle("GET /api/v1/files/me", authed(handleMyFiles(fileSvc)))
	// 路由修正：原 /files/{id}/ticket 与 /files/convs/{id}、/files/uploads/{id} 在 Go≥1.22
	// mux 下互为二义（seg2 通配 vs 字面量 + seg3 字面量 vs 通配，各自更具体）→ 启动即 panic；
	// 改字面量前缀段消除（API-FL-05 语义不变，路径形态调整登记）
	mux.Handle("GET /api/v1/files/ticket/{id}", authed(handleFileTicket(fileSvc)))
	mux.Handle("DELETE /api/v1/files/{id}", authed(handleFileDelete(fileSvc)))
	// 分片上传会话（07 §4.1 本地盘形态：PATCH 直传，无预签名；对象存储化阶段三换）
	mux.Handle("GET /api/v1/files/convs/{id}", authed(handleFileConvFiles(fileSvc)))
	mux.Handle("GET /api/v1/files/transfers", authed(handleFileTransfers(fileSvc)))
	mux.Handle("POST /api/v1/files/check", authed(handleFileCheck(fileSvc)))
	mux.Handle("POST /api/v1/files/uploads", authed(handleFileUploadInit(fileSvc)))
	mux.Handle("GET /api/v1/files/uploads/{id}", authed(handleFileUploadStatus(fileSvc)))
	mux.Handle("PATCH /api/v1/files/uploads/{id}/{no}", authed(handleFileUploadPart(fileSvc)))
	mux.Handle("POST /api/v1/files/uploads/{id}/complete", authed(handleFileUploadComplete(fileSvc)))
	// 分享外链（07 §4.4：访问仍需登录——authed；dl 票据即下载凭证）
	mux.Handle("POST /api/v1/files/{id}/share", authed(handleFileShare(fileSvc)))
	mux.Handle("GET /api/v1/files/s/{code}", authed(handleFileShareResolve(fileSvc)))
	mux.Handle("DELETE /api/v1/files/s/{code}", authed(handleFileShareRevoke(fileSvc)))
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

	// 文档中心域（D05 阶段一务实版）：纯 markdown 原生文档（无 WOPI/OnlyOffice），
	// doc_file/doc_version 两表；v0.1 全 owner 私有（scope 恒 personal，ACL 阶段二）
	var docRepo docrepo.Repo
	if pgPool != nil {
		docRepo = docrepo.NewPostgres(pgPool)
	} else {
		docRepo = docrepo.NewMemory()
	}
	docMod := doc.NewModule(docservice.Options{}, docRepo)
	docSvc := docMod.API()

	// 文档中心 REST（D05 §5.1 阶段一务实版 11 项；WOPI session/preview/import/
	// permissions/templates/move/audit/彻底删除阶段二，登记见 docs 裁剪表）
	mux.Handle("GET /api/v1/doc/files", authed(handleDocListFiles(docSvc)))
	mux.Handle("POST /api/v1/doc/files", authed(handleDocCreateFile(docSvc)))
	mux.Handle("GET /api/v1/doc/files/{id}", authed(handleDocGetFile(docSvc)))
	mux.Handle("PATCH /api/v1/doc/files/{id}", authed(handleDocRenameFile(docSvc)))
	mux.Handle("DELETE /api/v1/doc/files/{id}", authed(handleDocTrashFile(docSvc)))
	mux.Handle("PUT /api/v1/doc/files/{id}/content", authed(handleDocSaveContent(docSvc)))
	mux.Handle("GET /api/v1/doc/files/{id}/versions", authed(handleDocListVersions(docSvc)))
	mux.Handle("POST /api/v1/doc/files/{id}/versions/{v}/restore", authed(handleDocRestoreVersion(docSvc)))
	mux.Handle("GET /api/v1/doc/trash", authed(handleDocListTrash(docSvc)))
	mux.Handle("POST /api/v1/doc/trash/{id}/restore", authed(handleDocRestoreFromTrash(docSvc)))
	mux.Handle("POST /api/v1/doc/files/{id}/share", authed(handleDocShare(docSvc)))

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

	// mailAPI 前置声明（mcpgw 闭包捕获引用；mail 模块装配于后段，调用在运行期完成）
	var mailAPI *mailservice.Service

	// ── MCP 网关供给层（D14 §6 裁决 2026-11-07）：公司域工具包成 MCP server
	// 暴露，Runtime bbrt-mcp 连接期 initialize+tools/list 发现（mcp.corp.* 命名
	// 空间），tools/call 携带 OBO 逐请求传播（三层身份：连接/主体/归因）；
	// kb_query+doc_read（OQ-B26 试点）+ im_send/file_upload（09 篇 §3.1 全量）。
	// 独立鉴权链（Bearer=用户 JWT/OBO，同 aigw 口径），不走 /api/v1 authed ──
	mcpgwMod := mcpgw.NewModule(mcpgw.Options{
		Verify: func(_ context.Context, token string) (*authjwt.Claims, error) {
			return authAPI.Verify(context.Background(), token)
		},
		// 跨域闭包（D02 §4：mcpgw 不横向依赖 kb/doc 包；数据过滤在域服务=防线三）
		KBQuery: func(ctx context.Context, tenantID, uid int64, spaceIDs []string, keyword string, topK int) (any, error) {
			return kbSvc.Query(ctx, tenantID, uid, spaceIDs, keyword, topK)
		},
		DocRead: func(ctx context.Context, tenantID, uid, docID int64) (any, error) {
			return docSvc.GetFile(ctx, tenantID, uid, docID)
		},
		// im_send：以发起用户身份走消息主干（成员/敏感词/频率校验在 message 域；
		// 幂等键 mcp- 前缀与 bot-/REST 客户端段隔离）
		ImSend: func(ctx context.Context, tenantID, uid, convID int64, msgType string, body json.RawMessage) (any, error) {
			res, err := msgMod.API().Send(ctx, uid, messageapi.SendPayload{
				ConvID:      messageapi.ConvID(strconv.FormatInt(convID, 10)),
				ClientMsgID: "mcp-" + strconv.FormatInt(time.Now().UnixNano(), 36),
				Type:        msgType, Body: body,
			})
			if err != nil {
				return nil, err
			}
			return map[string]any{"msg_id": res.MsgID, "seq": res.Seq, "ts": res.TS}, nil
		},
		// file_upload：b64 已解码为流，直接交 file 域（去重/20MB 上限/软删归域）
		FileUpload: func(ctx context.Context, tenantID, uid int64, name, contentType string, convID int64, r io.Reader) (any, error) {
			return fileSvc.Upload(ctx, tenantID, uid, name, contentType, convID, r)
		},
		// 22 §4.7 Agent 邮件工具：read 三态（msg_id 单封/query 检索/folder 列表，
		// 空透传由 mail 域默认 inbox）；send 检查链在域内=人与 Agent 同权（22 §7）
		MailRead: func(ctx context.Context, tenantID, uid int64, msgID int64, query, folder string, attachOnly bool, limit int) (any, error) {
			if msgID > 0 {
				return mailAPI.GetMessage(ctx, tenantID, uid, msgID)
			}
			if query != "" {
				return mailAPI.Search(ctx, tenantID, uid, query, attachOnly, limit)
			}
			return mailAPI.ListMessages(ctx, tenantID, uid, folder, 0, limit, "")
		},
		MailSend: func(ctx context.Context, tenantID, uid int64, to, cc []string, subject, body, inReplyTo string) (any, error) {
			return mailAPI.SendMessage(ctx, tenantID, uid, mailservice.SendReq{
				To: to, Cc: cc, Subject: subject, Body: body, InReplyTo: inReplyTo,
			})
		},
		Audit: func(_ context.Context, e mcpgw.AuditEntry) {
			log.Printf("[mcpgw] tool=%s tenant=%d subject=%d obo=%v act=%s ok=%v err=%s %dms",
				e.Tool, e.TenantID, e.Subject, e.OBO, e.Act, e.OK, e.ErrCode, e.Duration)
		},
	})
	mux.HandleFunc("POST /mcp/corp", mcpgwMod.API().HandleMCP)

	// ── 管理域（D10 阶段一务实版）──
	// 跨域聚合闭包注入（D02 §4：admin 域不横向依赖业务包）：
	//   org 计数/列表/状态 · hub 在线与踢线 · message 今日会话/消息 · kb 文档 · file 存储 ·
	//   AI 用量（PG=ai_usage_hourly 聚合 / 内存=aigw Meter snapshot）· auth 吊销
	orgAdmin := orgMod.AdminAPI()
	msgStats, _ := msgRepo.(messagerepo.StatsReader)    // Memory/Postgres 均实现（可选接口）
	kbStats, _ := kbRepo.(kbrepo.DocStatsReader)        // 同上
	fileStats, _ := fileRepo.(filerepo.FileStatsReader) // 同上
	usageMode := "memory"
	usageRows := func(_ context.Context, tenantID int64, days int) ([]adminapi.UsageRow, error) {
		cutoff := time.Now().UTC().AddDate(0, 0, -(days - 1)).Truncate(24 * time.Hour)
		rows := []adminapi.UsageRow{}
		for dim, row := range aigwMod.Meter.Snapshot() { // 内存模式：进程内计量快照（无历史日，登记）
			if dim.Tenant != tenantID || row.UpdatedHour.Before(cutoff) {
				continue
			}
			rows = append(rows, adminapi.UsageRow{
				Date: row.UpdatedHour.UTC().Format("2006-01-02"), Tier: dim.Tier, Scene: dim.Scene,
				Requests: row.Requests, PromptTokens: row.Prompt,
				CompletionTokens: row.Completion, TotalTokens: row.Prompt + row.Completion,
			})
		}
		return rows, nil
	}
	if pgPool != nil {
		if ur, ok := adminStore.(adminrepo.UsageReader); ok {
			usageRows, usageMode = ur.UsageRows, "pg"
		}
	}
	// 管理员白名单（BBW_ADMIN_ACCOUNTS，empno 逗号分隔）：PG 模式 scopes 不落库时的判定兜底
	adminAccounts := []string{}
	for _, s := range strings.Split(envOr("BBW_ADMIN_ACCOUNTS", ""), ",") {
		if s = strings.TrimSpace(s); s != "" {
			adminAccounts = append(adminAccounts, s)
		}
	}
	if len(adminAccounts) > 0 {
		log.Printf("admin 白名单（BBW_ADMIN_ACCOUNTS）：%v", adminAccounts)
	}
	adminOpts := adminservice.Options{
		UsersTotal:     orgAdmin.CountUsers,
		OnlineNow:      func() int64 { return int64(hub.OnlineCount()) },
		KickUser:       hub.KickUser,
		RevokeSessions: func(ctx context.Context, userID int64) error { return authAPI.Logout(ctx, userID, "", true) },
		AdminAccounts:  adminAccounts,
		UsageRows:      usageRows,
		UsageMode:      usageMode,
	}
	if msgStats != nil { // 可选接口断言失败（理论不发生）时对应指标降级为 0
		adminOpts.ConvsActiveSince = msgStats.CountActiveConvsSince
		adminOpts.MsgsSince = msgStats.CountMsgsSince
	}
	if kbStats != nil {
		adminOpts.KBDocs = kbStats.CountDocs
	}
	if fileStats != nil {
		adminOpts.FileBytes = fileStats.SumStorageBytes
	}
	// 角色仓储（PAD-08）：PG/内存双模；内置角色种子幂等灌入（阶段二换正式 RBAC 装配）
	var roleStore adminrepo.RoleRepo
	if pgPool != nil {
		roleStore = adminrepo.NewPostgresRoles(pgPool)
	} else {
		roleStore = adminrepo.NewMemoryRoles()
	}
	seedBuiltinRoles(roleStore)
	// 公告仓储 + 广播闭包（PAD-15：org 活跃用户 → message 域全员通知 kind=announcement）
	var noticeStore adminrepo.NoticeRepo
	if pgPool != nil {
		noticeStore = adminrepo.NewPostgresNotices(pgPool)
	} else {
		noticeStore = adminrepo.NewMemoryNotices()
	}
	adminOpts.HashPassword = authservice.HashPassword
	// KB 空间总览（PAD-10）：kb repo 全量空间（绕过用户可见性）+ 逐空间文档计数
	adminOpts.KBSpaces = func() []adminservice.KBSpaceClosure {
		spaces, err := kbRepo.ListSpaces(context.Background(), 1)
		if err != nil {
			return nil
		}
		out := make([]adminservice.KBSpaceClosure, 0, len(spaces))
		for _, sp := range spaces {
			docs, derr := kbRepo.ListDocsBySpace(context.Background(), 1, sp.ID)
			n := int64(0)
			if derr == nil {
				n = int64(len(docs))
			}
			out = append(out, adminservice.KBSpaceClosure{
				ID: sp.ID, OwnerID: sp.OwnerID, DocCount: n,
				Quota: sp.QuotaBytes, Used: sp.UsedBytes, Type: sp.SpaceType, Name: sp.Name,
			})
		}
		return out
	}
	// Agent 计量聚合（PAD-14）：aigw Meter Snapshot 按（tenant,user）聚合 chat/delegate/expert 场景
	adminOpts.AgentUsage = func(tenantID int64) []adminservice.AgentUsageRow {
		type acc struct {
			req, tok, last int64
			sessions       map[string]bool
		}
		m := map[int64]*acc{}
		for dim, row := range aigwMod.Meter.Snapshot() {
			if dim.Tenant != tenantID || dim.User == 0 || dim.Scene == "embed" {
				continue
			}
			a := m[dim.User]
			if a == nil {
				a = &acc{sessions: map[string]bool{}}
				m[dim.User] = a
			}
			a.req += row.Requests
			a.tok += row.Prompt + row.Completion
			if dim.Session != "" {
				a.sessions[dim.Session] = true
			}
			if h := row.UpdatedHour.UnixMilli(); h > a.last {
				a.last = h
			}
		}
		out := make([]adminservice.AgentUsageRow, 0, len(m))
		for uid, a := range m {
			out = append(out, adminservice.AgentUsageRow{
				UserID: uid, Requests: a.req, Tokens: a.tok,
				Sessions: len(a.sessions), LastHour: a.last,
			})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Requests > out[j].Requests })
		return out
	}
	adminOpts.CreateUser = func(ctx context.Context, u orgapi.User) (orgapi.User, error) {
		return orgRepo.CreateUser(ctx, u)
	}
	adminOpts.BroadcastNotice = func(ctx context.Context, tenantID int64, title, digest string) int {
		users, _, err := orgAdmin.ListUsers(ctx, orgapi.UserListFilter{TenantID: tenantID, Status: orgapi.UserStatusActive, Limit: 5000})
		if err != nil {
			log.Printf("[admin] 公告广播取用户失败: %v", err)
			return 0
		}
		ids := make([]int64, 0, len(users))
		for _, u := range users {
			ids = append(ids, u.ID)
		}
		return msgMod.API().BroadcastNotice(ctx, tenantID, title, digest, ids)
	}
	adminMod := admin.NewModule(orgAdmin, orgMod.API(), adminStore, roleStore, noticeStore, adminOpts)
	adminSvc := adminMod.API()
	// 管理路由守卫：auth → tenant → 管理员判定（v0.1 scope/白名单；403 用既有 2003，D10 无新码）
	adminOnly := func(h http.HandlerFunc) http.Handler {
		return httpx.Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid, err := uidFrom(r)
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			if !adminSvc.IsAdmin(r.Context(), httpx.TenantID(r.Context()), uid) {
				httpx.Fail(w, r, errx.New(errx.CodePermACLDenied, "需要管理员权限"))
				return
			}
			h(w, r)
		}), httpx.Auth(authAPI.Verify), httpx.Tenant)
	}
	mux.Handle("GET /api/v1/admin/dashboard", adminOnly(handleAdminDashboard(adminSvc)))
	mux.Handle("GET /api/v1/admin/users", adminOnly(handleAdminUsers(adminSvc)))
	mux.Handle("PATCH /api/v1/admin/users/{id}", adminOnly(handleAdminUserPatch(adminSvc)))
	mux.Handle("POST /api/v1/admin/users/{id}/disable", adminOnly(handleAdminUserStatus(adminSvc, orgapi.UserStatusDisabled)))
	mux.Handle("POST /api/v1/admin/users/{id}/enable", adminOnly(handleAdminUserStatus(adminSvc, orgapi.UserStatusActive)))
	mux.Handle("GET /api/v1/admin/policies/agent", adminOnly(handleAdminAgentPolicy(adminSvc)))
	mux.Handle("GET /api/v1/admin/policies/sensitive-words", adminOnly(handleAdminListWords(adminSvc)))
	mux.Handle("POST /api/v1/admin/policies/sensitive-words", adminOnly(handleAdminAddWord(adminSvc)))
	mux.Handle("DELETE /api/v1/admin/policies/sensitive-words/{id}", adminOnly(handleAdminDeleteWord(adminSvc)))
	mux.Handle("GET /api/v1/admin/usage/summary", adminOnly(handleAdminUsage(adminSvc)))
	mux.Handle("GET /api/v1/admin/audit", adminOnly(handleAdminAudit(adminSvc)))
	// 角色与授权（PAD-08 角色编辑器；admin:role:manage 随权限字典收口）
	mux.Handle("GET /api/v1/admin/roles", adminOnly(handleAdminListRoles(adminSvc)))
	mux.Handle("POST /api/v1/admin/roles", adminOnly(handleAdminCreateRole(adminSvc)))
	mux.Handle("PATCH /api/v1/admin/roles/{id}", adminOnly(handleAdminUpdateRole(adminSvc)))
	mux.Handle("DELETE /api/v1/admin/roles/{id}", adminOnly(handleAdminDeleteRole(adminSvc)))
	mux.Handle("GET /api/v1/admin/users/{id}/grants", adminOnly(handleAdminListGrants(adminSvc)))
	mux.Handle("POST /api/v1/admin/users/{id}/grants", adminOnly(handleAdminGrantRole(adminSvc)))
	mux.Handle("DELETE /api/v1/admin/grants/{gid}", adminOnly(handleAdminRevokeRole(adminSvc)))
	// 平台公告（PAD-15；admin:notice:publish 随权限字典收口）
	mux.Handle("GET /api/v1/admin/notices", adminOnly(handleAdminListNotices(adminSvc)))
	mux.Handle("POST /api/v1/admin/notices", adminOnly(handleAdminPublishNotice(adminSvc)))
	// 批量导入（PAD-06；admin:user:manage）
	mux.Handle("POST /api/v1/admin/users/import", adminOnly(handleAdminImportUsers(adminSvc)))
	// Agent 治理（PAD-14；admin:agent:revoke / platform:agent:killswitch）
	mux.Handle("GET /api/v1/admin/agent/users", adminOnly(handleAdminAgentUsers(adminSvc)))
	mux.Handle("POST /api/v1/admin/agent/revoke", adminOnly(handleAdminAgentRevoke(adminSvc)))
	mux.Handle("GET /api/v1/admin/agent/killswitch", adminOnly(handleAdminAgentKillswitch(adminSvc, false)))
	mux.Handle("PUT /api/v1/admin/agent/killswitch", adminOnly(handleAdminAgentKillswitch(adminSvc, true)))
	// 组织树（PAD-04；admin:org:manage——orgRepo 直接实现 DeptTreeReaderWriter）
	deptTree := func(h http.HandlerFunc) http.Handler { return adminOnly(h) }
	_ = deptTree
	mux.Handle("GET /api/v1/admin/org/tree", adminOnly(handleDeptTree(orgRepo)))
	mux.Handle("POST /api/v1/admin/org/depts", adminOnly(handleDeptCreate(orgRepo)))
	mux.Handle("PATCH /api/v1/admin/org/depts/{id}", adminOnly(handleDeptRename(orgRepo)))
	mux.Handle("DELETE /api/v1/admin/org/depts/{id}", adminOnly(handleDeptDelete(orgRepo)))
	// KB 治理（PAD-10；admin:kb:govern——v0.1 只读总览）
	mux.Handle("GET /api/v1/admin/kb/spaces", adminOnly(handleAdminKBSpaces(adminSvc)))
	// 离职交接（PAD-07；admin:user:offboard）
	mux.Handle("POST /api/v1/admin/users/{id}/offboard", adminOnly(handleAdminOffboard(adminSvc)))

	// WS 接入（14 篇 §2.1：token/did 走查询参数）
	mux.Handle("/ws/connect", http.HandlerFunc(gw.ServeWS))

	// ── 资源级 ACL（03 §4.4 第三层）：统一授权模型 + 管理 REST ──
	// dept/role 展开闭包：role 接 admin RoleRepo（user_role 表）；dept 展
	// 开随 user_dept 查询接线（org 域暂无按用户查部门——未注入=dept 层跳过，登记）
	var aclRepo orgacl.Repo
	if pgPool != nil {
		aclRepo = orgacl.NewPostgres(pgPool)
	} else {
		aclRepo = orgacl.NewMemory()
	}
	aclSvc := orgacl.New(aclRepo, orgacl.ResolveOptions{
		RoleIDsOf: func(tenantID, userID int64) []int64 {
			grants, err := roleStore.ListUserRoles(context.Background(), tenantID, userID)
			if err != nil {
				return nil
			}
			ids := make([]int64, 0, len(grants))
			for _, g := range grants {
				ids = append(ids, g.RoleID)
			}
			return ids
		},
	})
	mux.Handle("GET /api/v1/admin/acl", adminOnly(handleACLList(aclSvc)))
	mux.Handle("POST /api/v1/admin/acl", adminOnly(handleACLGrant(aclSvc)))
	mux.Handle("DELETE /api/v1/admin/acl/{id}", adminOnly(handleACLRevoke(aclSvc)))

	// ── 会议域（21 篇阶段一务实版）：预约/日历/RSVP/忙闲 ──
	// 媒体/信令复用 rtc（入会=join 模式群通话，call_id=meeting_no 约定）；
	// 推送经 hub 直推 meeting.*（瞬态，rtc 同款）
	var meetingRepoInst meetingrepo.Repo
	if pgPool != nil {
		meetingRepoInst = meetingrepo.NewPostgres(pgPool)
	} else {
		meetingRepoInst = meetingrepo.NewMemory()
	}
	meetPush := gateway.RtcPusher{Hub: hub}
	meetingMod := meeting.NewModule(meetingservice.Options{
		PushMeet: func(userID int64, typ string, payload any) {
			meetPush.PushRTC([]int64{userID}, typ, payload)
		},
	}, meetingRepoInst)
	meetingapi.RegisterRoutes(mux, authed, meetingMod.API())

	// ── 机器人域（20 篇阶段一+二：Incoming + Outgoing）──
	workerCtx, workerStop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer workerStop()
	// bot=特殊 user(type=2 永不登录)；跨域全闭包（D02 §4：不引 org/message/admin 包）
	var botRepo botrepo.Repo
	var botDeliveries botrepo.DeliveryRepo
	if pgPool != nil {
		botRepo = botrepo.NewPostgres(pgPool)
		botDeliveries = botrepo.NewPostgresDeliveries(pgPool)
	} else {
		botRepo = botrepo.NewMemory()
		botDeliveries = botrepo.NewMemoryDeliveries()
	}
	botMod := bot.NewModule(botservice.Options{
		// user(type=bot)：employee_no 走 bot- 前缀独立段（20 篇 §3.2，不占员工编号段）
		CreateUser: func(ctx context.Context, tenantID int64, name string) (int64, error) {
			u, err := orgRepo.CreateUser(ctx, orgapi.User{
				TenantID: tenantID, Type: orgapi.UserTypeBot,
				EmployeeNo:  "bot-" + strconv.FormatInt(time.Now().UnixNano(), 36),
				DisplayName: name, Status: orgapi.UserStatusActive,
			})
			if err != nil {
				return 0, err
			}
			return u.ID, nil
		},
		// 会话成员判定/安装（message 仓闭包；role=5 为 bot 成员，20 篇 §5）
		MemberRole: func(ctx context.Context, convID, userID int64) int {
			m, err := msgRepo.MemberOf(ctx, convID, userID)
			if err != nil || m == nil || m.Status != 1 {
				return 0
			}
			return m.Role
		},
		AddMember: func(ctx context.Context, convID, userID int64, role int) error {
			return msgRepo.AddMember(ctx, messagerepo.Member{ConvID: convID, UserID: userID, Role: role})
		},
		RemoveMember: func(ctx context.Context, convID, userID int64) error {
			return msgRepo.RemoveMember(ctx, convID, userID)
		},
		// 以 bot 身份走消息主干（seq/扇出/同步复用 message 服务；幂等键 bot- 前缀）
		SendMsg: func(ctx context.Context, senderID, convID int64, msgType string, body json.RawMessage, mentionUIDs []string) (int64, int64, error) {
			mentions := make([]messageapi.Mention, 0, len(mentionUIDs))
			for _, uid := range mentionUIDs {
				mentions = append(mentions, messageapi.Mention{UID: uid})
			}
			res, err := msgMod.API().Send(ctx, senderID, messageapi.SendPayload{
				ConvID:      messageapi.ConvID(strconv.FormatInt(convID, 10)),
				ClientMsgID: "bot-" + strconv.FormatInt(time.Now().UnixNano(), 36),
				Type:        msgType, Body: body, Mentions: mentions,
			})
			if err != nil {
				return 0, 0, err
			}
			return res.MsgID, res.Seq, nil
		},
		// 敏感词与人类消息同库同路径（20 篇 §7.2）
		SensitiveWords: func() []string {
			words, err := adminStore.EnabledSensitiveWords(context.Background(), 1)
			if err != nil {
				return nil
			}
			return words
		},
	}, botRepo, botDeliveries)
	botapi.RegisterAdminRoutes(mux, authed, botMod.API())
	mux.HandleFunc("POST /hook/bot/{hook_id}", botapi.HandleHookDeliver(botMod.API()))
	// Outgoing 事件订阅投递（20 §4.3 阶段二）：msg.created 消费 + 投递 worker
	if out := botMod.Outgoing(); out != nil {
		botapi.RegisterOutgoingRoutes(mux, authed, out)
		bus.Subscribe(eventbus.TopicMsgCreated, func(_ context.Context, evt eventbus.Event) error {
			e, ok := evt.Payload.(messageapi.MsgCreatedEvent)
			if !ok {
				return nil // payload 类型异常静默（gateway 同款容错）
			}
			out.OnMsgCreated(botservice.MsgCreatedLight{
				TenantID: 1, // 单租户阶段一（Message 无 tenant 冗余字段；多租户随 03 篇全面启用）
				MsgID:    e.Message.ID, ConvID: e.Message.ConvID,
				SenderID: e.Message.SenderID, SenderName: e.Message.SenderName,
				MsgType: e.Message.Type, Body: e.Message.Body,
				Mentions: mentionUIDsOf(e.Message.Mentions),
			})
			return nil
		})
		go out.Run(workerCtx)
	}

	// ── 邮件域（22 篇阶段一务实版）：内域收发 + 治理 REST ──
	// 邮件栈=进程内直投（docker-mailserver/auth-bridge/路径②随阶段二）；
	// 懒开户="登录即有邮箱"（user.offboarded 联动随 D02 消费方阶段二）；
	// 跨域全闭包（D02 §4：不引 org/admin/auth 包）
	var mailRepoInst mailrepo.Repo
	if pgPool != nil {
		mailRepoInst = mailrepo.NewPostgres(pgPool)
	} else {
		mailRepoInst = mailrepo.NewMemory()
	}
	mailPush := gateway.RtcPusher{Hub: hub} // mail.new 直推（瞬态不经 eventbus，rtc 同款）
	mailMod := mail.NewModule(mailservice.Options{
		DefaultDomain: envOr("BBW_MAIL_DOMAIN", "corp.company.internal"),
		// 懒开户寻址：employee_no@默认域（22 §4.1 命名策略）
		UserEmployeeNo: func(tenantID, userID int64) (string, error) {
			u, err := orgMod.API().GetUser(context.Background(), userID)
			if err != nil {
				return "", err
			}
			return u.EmployeeNo, nil
		},
		// 外发敏感词（04 篇库复用，bot 同款热更闭包）
		SensitiveWords: func() []string {
			words, err := adminStore.EnabledSensitiveWords(context.Background(), 1)
			if err != nil {
				return nil
			}
			return words
		},
		// 应用专用密码（auth 域 PBKDF2 闭包；吊销即时=在线校验）
		HashPwd:   authservice.HashPassword,
		VerifyPwd: authservice.VerifyPassword,
		PushMail: func(userID int64, payload any) {
			mailPush.PushRTC([]int64{userID}, "mail.new", payload)
		},
	}, mailRepoInst)
	mailAPI = mailMod.API() // mcpgw 闭包引用回填（前置声明处）
	mailapi.RegisterRoutes(mux, authed, mailMod.API())
	mailapi.RegisterAdminRoutes(mux, adminOnly, mailMod.API())

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
			// admin 权限点 v0.1：seed 即授权（阶段二换 role/user_role 表装配；PG 模式
			// scopes 不落库，管理判定走 BBW_ADMIN_ACCOUNTS=alice 白名单，登记）
			Scopes: []string{"im:message:send", "agent:session:use", "admin", "admin:user:manage", "admin:policy:manage", "admin:audit:read", "admin:usage:read"}},
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

// ── 管理域 REST 壳（D10 阶段一务实版：薄壳 → adminSvc → 统一响应包）──

// handleAdminDashboard 仪表盘聚合（API-ADM-01 务实版：六指标 + AI tokens 趋势）
func handleAdminDashboard(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := svc.Dashboard(r.Context(), httpx.TenantID(r.Context()))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleAdminUsers 用户列表（API-ADM-06 务实版：?keyword&status&cursor&limit）
func handleAdminUsers(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		status, _ := strconv.ParseInt(q.Get("status"), 10, 64)
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		resp, err := svc.ListUsers(r.Context(), httpx.TenantID(r.Context()),
			q.Get("keyword"), status, cursor, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// adminActor 管理写请求的操作人（uid）
func adminActor(r *http.Request) (int64, error) { return uidFrom(r) }

// handleAdminUserPatch 用户资料/状态（API-ADM-06 PATCH 务实版：v0.1 仅 status 字段）
func handleAdminUserPatch(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operatorID, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		targetID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Status int `json:"status"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if req.Status == 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "status 必填（1 启用 / 2 禁用）"))
			return
		}
		resp, err := svc.SetUserStatus(r.Context(), httpx.TenantID(r.Context()), operatorID, targetID, req.Status)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleAdminUserStatus 禁用/启用语义端点（API-ADM-08 务实版：disable|enable 路由共用）
func handleAdminUserStatus(svc adminapi.AdminService, status int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operatorID, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		targetID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		resp, err := svc.SetUserStatus(r.Context(), httpx.TenantID(r.Context()), operatorID, targetID, status)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleAdminAgentPolicy Agent 工具策略只读快照（API-ADM-14 务实版）
func handleAdminAgentPolicy(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := svc.AgentPolicy(r.Context(), httpx.TenantID(r.Context()))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleAdminListWords 敏感词分页列表（?cursor&limit；响应含 total 全量计数）
func handleAdminListWords(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.ParseInt(q.Get("limit"), 10, 64)
		resp, err := svc.ListSensitiveWords(r.Context(), httpx.TenantID(r.Context()), cursor, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleAdminAddWord 新增敏感词（mode=1 拦截；写后 message 域即时生效）
func handleAdminAddWord(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operatorID, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Word     string `json:"word"`
			Category string `json:"category"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		resp, err := svc.AddSensitiveWord(r.Context(), httpx.TenantID(r.Context()), operatorID, req.Word, req.Category)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleAdminDeleteWord 删除敏感词
func handleAdminDeleteWord(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operatorID, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.DeleteSensitiveWord(r.Context(), httpx.TenantID(r.Context()), operatorID, id); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

// handleAdminUsage AI 用量汇总（API-ADM-21 务实版：?days=7，按日/按 tier/按 scene）
func handleAdminUsage(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		days, _ := strconv.Atoi(r.URL.Query().Get("days"))
		resp, err := svc.UsageSummary(r.Context(), httpx.TenantID(r.Context()), days)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleAdminAudit 审计时间线（API-ADM-18 务实版：?cursor&limit，id 倒序）
func handleAdminAudit(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.ParseInt(q.Get("limit"), 10, 64)
		resp, err := svc.ListAudit(r.Context(), httpx.TenantID(r.Context()), cursor, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// ── rtc 域适配器（D04 阶段一追加）──

// rtcCardSink rtc.CardSink → message 服务适配：call_card 落流/回写
// （SendCard 参数序与 MessageService.SendCallCard 对齐；错误静默——卡片为辅链路不阻断信令）
type rtcCardSink struct{ msgs messageapi.MessageService }

// SendCard invite 时落卡（幂等键 callcard-<call_id>）→ 回链 msg_id
func (a rtcCardSink) SendCard(ctx context.Context, senderID, convID int64, clientMsgID string, body json.RawMessage) int64 {
	id, _ := a.msgs.SendCallCard(ctx, senderID, convID, clientMsgID, body)
	return id
}

// FinishCard 结束时 PATCH body（status=ended{duration,reason}）→ 复用 msg.updated 扇出
func (a rtcCardSink) FinishCard(ctx context.Context, msgID int64, body json.RawMessage) {
	_ = a.msgs.UpdateCallCard(ctx, msgID, body)
}

// ── 文档中心 REST 壳（D05 阶段一务实版：薄壳 → docSvc → 统一响应包）──

// docActor 文档域请求方（tenant + uid；v0.1 全 owner 私有）
func docActor(r *http.Request) (int64, int64, error) {
	uid, err := uidFrom(r)
	if err != nil {
		return 0, 0, err
	}
	return httpx.TenantID(r.Context()), uid, nil
}

// docIDFrom 路径文档 ID 解析
func docIDFrom(r *http.Request) (int64, error) { return pathID(r, "id") }

// handleDocListFiles 列表+名称模糊（API-DOC-03 务实版：owner 私有视图；
// ?q= 模糊 ?cursor= 键集翻页 "<ms>-<id>" ?limit=）
func handleDocListFiles(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		resp, err := svc.ListFiles(r.Context(), tenant, uid, q.Get("q"), q.Get("cursor"), limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleDocCreateFile 新建 markdown 文档（API-DOC-01 务实版：{title}，建 v1 空白文档；
// type/template_id/folder_id 不收——纯 markdown+无模板库，阶段二）
func handleDocCreateFile(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Title string `json:"title"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		doc, err := svc.CreateFile(r.Context(), tenant, uid, req.Title)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, doc)
	}
}

// handleDocGetFile 元数据+当前正文（API-DOC-04 务实版；v0.1 无 perm/presence 摘要）
func handleDocGetFile(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		doc, err := svc.GetFile(r.Context(), tenant, uid, docID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, doc)
	}
}

// handleDocRenameFile 重命名（API-DOC-05 务实版：{title}；6015 同名）
func handleDocRenameFile(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Title string `json:"title"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		doc, err := svc.RenameFile(r.Context(), tenant, uid, docID, req.Title)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, doc)
	}
}

// handleDocTrashFile 移入回收站（API-DOC-07 务实版：purge_at=+30d 保留期）
func handleDocTrashFile(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		doc, err := svc.TrashFile(r.Context(), tenant, uid, docID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, doc)
	}
}

// handleDocSaveContent 乐观锁保存正文（PUT content {content_md, base_version}；
// 基线落后 → 6004 版本冲突；成功 manual 快照 version+1 + 冗余正文回写）
func handleDocSaveContent(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			ContentMD   string `json:"content_md"`
			BaseVersion int64  `json:"base_version"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		resp, err := svc.SaveContent(r.Context(), tenant, uid, docID, req.BaseVersion, req.ContentMD)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleDocListVersions 版本时间线（API-DOC-21 务实版：cursor 倒序；v0.1 无大小/备注）
func handleDocListVersions(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		resp, err := svc.ListVersions(r.Context(), tenant, uid, docID, q.Get("cursor"), limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleDocRestoreVersion 恢复目标版本（API-DOC-22 务实版：version+1 snapshot=restore，
// 正文回写；6013 目标不存在）
func handleDocRestoreVersion(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		version, err := strconv.Atoi(r.PathValue("v"))
		if err != nil || version <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "目标版本号非法"))
			return
		}
		resp, err := svc.RestoreVersion(r.Context(), tenant, uid, docID, version)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleDocListTrash 回收站列表（API-DOC-27 务实版：owner 私有 + 过期行过滤）
func handleDocListTrash(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		resp, err := svc.ListTrash(r.Context(), tenant, uid, q.Get("cursor"), limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleDocRestoreFromTrash 回收站恢复（API-DOC-28 务实版：同名冲突加" (恢复)"后缀）
func handleDocRestoreFromTrash(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		resp, err := svc.RestoreFromTrash(r.Context(), tenant, uid, docID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// handleDocShare 分享占位（API-DOC-12 务实版：share_id+7d+假 URL；
// 外链解析页/doc_share 落库阶段二，登记）
func handleDocShare(svc docapi.DocService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, uid, err := docActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		docID, err := docIDFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		resp, err := svc.Share(r.Context(), tenant, uid, docID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, resp)
	}
}

// ── 文件 REST 壳（D06 阶段二：分片会话 + 分享外链） ──

// handleFileCheck 秒传预检（策略再校验；命中直接可发消息）
func handleFileCheck(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req fileapi.CheckReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.Check(r.Context(), httpx.TenantID(r.Context()), uid, req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleFileUploadInit 建分片会话（秒传命中直接回 file_id）
func handleFileUploadInit(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req fileapi.UploadInitReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.InitUpload(r.Context(), httpx.TenantID(r.Context()), uid, req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleFileUploadStatus 断点续传位图
func handleFileUploadStatus(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.UploadStatus(r.Context(), httpx.TenantID(r.Context()), uid, r.PathValue("id"))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleFileUploadPart 分片直传（body 原始字节；part_size 上限由 service 判 4009）
func handleFileUploadPart(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		no, err := strconv.Atoi(r.PathValue("no"))
		if err != nil || no < 1 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "分片号非法"))
			return
		}
		if err := svc.UploadPart(r.Context(), httpx.TenantID(r.Context()), uid,
			r.PathValue("id"), no, r.Body); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, fileapi.UploadPartResult{Received: true})
	}
}

// handleFileUploadComplete 合并+校验+落位（幂等：重复调用回放同结果）
func handleFileUploadComplete(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.CompleteUpload(r.Context(), httpx.TenantID(r.Context()), uid, r.PathValue("id"))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleFileShare 创建分享（owner only；code 一次性返回）
func handleFileShare(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		fileID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req fileapi.ShareReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.Share(r.Context(), httpx.TenantID(r.Context()), uid, fileID, req)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleFileShareResolve 外链解析（登录态；密码经 ?password=；命中计数+发票据）
func handleFileShareResolve(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.ResolveShare(r.Context(), httpx.TenantID(r.Context()), uid,
			r.PathValue("code"), r.URL.Query().Get("password"))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// handleFileShareRevoke 取消分享（creator only；链接即刻失效）
func handleFileShareRevoke(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.RevokeShare(r.Context(), httpx.TenantID(r.Context()), uid, r.PathValue("code")); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

// handleFileConvFiles 会话文件聚合（群文件页签；成员判定在 service）
func handleFileConvFiles(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		convID, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		items, err := svc.ListByConv(r.Context(), httpx.TenantID(r.Context()), uid, convID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}

// handleFileTransfers 本人传输记录（07 §5 跨端镜像；?direction=1|2&limit=）
func handleFileTransfers(svc fileapi.FileService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		direction, _ := strconv.Atoi(r.URL.Query().Get("direction"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		items, err := svc.ListTransfers(r.Context(), httpx.TenantID(r.Context()), uid, direction, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}

// seedBuiltinRoles 内置角色（is_builtin：名称/描述锁定，仅可改权限点）
func seedBuiltinRoles(store adminrepo.RoleRepo) {
	ctx := context.Background()
	builtin := []adminrepo.Role{
		{Name: "管理员", Description: "全部管理权限（内置）", IsBuiltin: true,
			Permissions: []string{"admin", "admin:user:manage", "admin:role:manage", "admin:policy:manage", "admin:kb:govern", "admin:audit:read", "admin:usage:read"}},
		{Name: "应用管理员", Description: "应用/技能/bot 管理（内置）", IsBuiltin: true,
			Permissions: []string{"admin:app:publish", "bot:manage"}},
	}
	for _, r := range builtin {
		r.TenantID = 1
		if _, err := store.InsertRole(ctx, r); err == nil {
			log.Printf("[admin] 内置角色就绪：%s（%d 权限点）", r.Name, len(r.Permissions))
		} // 已存在（幂等重启）静默跳过
	}
}

// ── 角色 REST 壳（PAD-08） ──

type roleReq struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

func handleAdminListRoles(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		items, err := svc.ListRoles(r.Context(), httpx.TenantID(r.Context()))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}

func handleAdminCreateRole(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req roleReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		role, err := svc.CreateRole(r.Context(), httpx.TenantID(r.Context()), op, req.Name, req.Description, req.Permissions)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, role)
	}
}

func handleAdminUpdateRole(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req roleReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.UpdateRole(r.Context(), httpx.TenantID(r.Context()), op, id, req.Name, req.Description, req.Permissions); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleAdminDeleteRole(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.DeleteRole(r.Context(), httpx.TenantID(r.Context()), op, id); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleAdminListGrants(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		items, err := svc.ListUserGrants(r.Context(), httpx.TenantID(r.Context()), uid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}

func handleAdminGrantRole(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		uid, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			RoleID int64 `json:"role_id"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.GrantRole(r.Context(), httpx.TenantID(r.Context()), op, uid, req.RoleID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleAdminRevokeRole(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		gid, err := pathID(r, "gid")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.RevokeRole(r.Context(), httpx.TenantID(r.Context()), op, gid); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

// ── 公告 REST 壳（PAD-15） ──

func handleAdminPublishNotice(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Title   string `json:"title"`
			Content string `json:"content"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		notice, err := svc.PublishNotice(r.Context(), httpx.TenantID(r.Context()), op, req.Title, req.Content)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, notice)
	}
}

func handleAdminListNotices(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		items, more, err := svc.ListNotices(r.Context(), httpx.TenantID(r.Context()), cursor, limit)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items, "has_more": more})
	}
}

// handleAdminImportUsers 批量导入（PAD-06；v0.1 同步 ≤100 行/次）
func handleAdminImportUsers(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Rows []adminapi.ImportUserRow `json:"rows"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res, err := svc.BatchImportUsers(r.Context(), httpx.TenantID(r.Context()), op, req.Rows)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, res)
	}
}

// ── Agent 治理 REST 壳（PAD-14） ──

func handleAdminAgentUsers(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		items, err := svc.ListAgentUsers(r.Context(), httpx.TenantID(r.Context()))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}

func handleAdminAgentRevoke(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			UserID int64 `json:"user_id"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.RevokeAgentAccess(r.Context(), httpx.TenantID(r.Context()), op, req.UserID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleAdminAgentKillswitch(svc adminapi.AdminService, isWrite bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant := httpx.TenantID(r.Context())
		if !isWrite {
			on, err := svc.AgentKillswitch(r.Context(), tenant, 0, false)
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			httpx.OK(w, r, map[string]any{"on": on})
			return
		}
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			On bool `json:"on"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		on, err := svc.AgentKillswitch(r.Context(), tenant, op, req.On)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"on": on})
	}
}

// ── 组织树 REST 壳（PAD-04；orgRepo 即 DeptTreeReaderWriter） ──

func handleDeptTree(tree orgapi.DeptTreeReaderWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodes, err := tree.ListTree(r.Context(), httpx.TenantID(r.Context()))
		if err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeInternal, "组织树读取失败"))
			return
		}
		httpx.OK(w, r, map[string]any{"items": nodes})
	}
}

func handleDeptCreate(tree orgapi.DeptTreeReaderWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ParentID int64  `json:"parent_id"`
			Name     string `json:"name"`
			Sort     int    `json:"sort"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		node, err := tree.CreateDept(r.Context(), httpx.TenantID(r.Context()), req.ParentID, req.Name, req.Sort)
		if err != nil {
			httpx.Fail(w, r, orgDeptErr(err))
			return
		}
		httpx.OK(w, r, node)
	}
}

func handleDeptRename(tree orgapi.DeptTreeReaderWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := tree.RenameDept(r.Context(), httpx.TenantID(r.Context()), id, req.Name); err != nil {
			httpx.Fail(w, r, orgDeptErr(err))
			return
		}
		httpx.OK(w, r, nil)
	}
}

func handleDeptDelete(tree orgapi.DeptTreeReaderWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := tree.DeleteDept(r.Context(), httpx.TenantID(r.Context()), id); err != nil {
			httpx.Fail(w, r, orgDeptErr(err))
			return
		}
		httpx.OK(w, r, nil)
	}
}

// orgDeptErr org 域 sentinel → errx 映射
func orgDeptErr(err error) error {
	switch err {
	case orgapi.ErrDeptName:
		return errx.New(errx.CodeBadRequest, "部门名必填（≤50 字）")
	case orgapi.ErrDeptNotFound:
		return errx.New(errx.CodeBadRequest, "部门不存在")
	case orgapi.ErrDeptNotEmpty:
		return errx.New(errx.CodeBadRequest, "部门下有子部门或成员，不可删除")
	}
	return err
}

// ── 资源级 ACL 管理端（03 §4.4；PAD 授权治理）──

func handleACLList(svc *orgacl.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		items, err := svc.ListGrants(r.Context(), httpx.TenantID(r.Context()), orgacl.EntryFilter{
			ResourceType: q.Get("resource_type"),
			ResourceID:   q.Get("resource_id"),
		})
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, items)
	}
}

func handleACLGrant(svc *orgacl.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			ResourceType string     `json:"resource_type"`
			ResourceID   string     `json:"resource_id"`
			GrantType    int        `json:"grant_type"`
			GrantTarget  int64      `json:"grant_target"`
			Perm         int        `json:"perm"`
			ExpiresAt    *time.Time `json:"expires_at"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var expires time.Time
		if req.ExpiresAt != nil {
			expires = *req.ExpiresAt
		}
		e, gerr := svc.Grant(r.Context(), orgacl.Entry{
			TenantID:     httpx.TenantID(r.Context()),
			ResourceType: req.ResourceType, ResourceID: req.ResourceID,
			GrantType: req.GrantType, GrantTarget: req.GrantTarget,
			Perm: req.Perm, GrantedBy: actor, ExpiresAt: expires,
		})
		if gerr != nil {
			if orgacl.IsInvalid(gerr) {
				httpx.Fail(w, r, errx.New(errx.CodeBadRequest, gerr.Error()))
				return
			}
			httpx.Fail(w, r, gerr)
			return
		}
		httpx.OK(w, r, e)
	}
}

func handleACLRevoke(svc *orgacl.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "id 非法"))
			return
		}
		if rerr := svc.Revoke(r.Context(), httpx.TenantID(r.Context()), id); rerr != nil {
			if rerr == orgacl.ErrNotFound {
				httpx.Fail(w, r, errx.New(errx.CodeNotFound, "授权不存在"))
				return
			}
			httpx.Fail(w, r, rerr)
			return
		}
		httpx.OK(w, r, map[string]bool{"ok": true})
	}
}

// mentionUIDsOf mentions → uid 字符串集（bot Outgoing @bot 判定口径）
func mentionUIDsOf(ms []messageapi.Mention) []string {
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		out = append(out, m.UID)
	}
	return out
}

// handleAdminKBSpaces KB 空间总览（PAD-10）
func handleAdminKBSpaces(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		items, err := svc.ListKBSpaces(r.Context(), httpx.TenantID(r.Context()))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}

// handleAdminOffboard 离职交接（PAD-07；禁用全链，后续事项端侧引导）
func handleAdminOffboard(svc adminapi.AdminService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		op, err := adminActor(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		uid, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := svc.OffboardUser(r.Context(), httpx.TenantID(r.Context()), op, uid); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, nil)
	}
}
