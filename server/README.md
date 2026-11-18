# bbc-server（阶段一：模块化单体骨架）

BaobaoChat 服务端阶段一代码骨架：**Go 1.22 · 标准库自研 WS/JWT · pgx（唯一第三方依赖）**。
范围：auth / org / message 三模块 + gateway + platform 基础设施。
存储双模：`BBC_DB_DSN` 非空 → PostgreSQL（pgx + 启动迁移 + RLS 兜底）；空 → 内存仓储（测试路径不变）。

## 目录职责

```
server/
├─ cmd/bbc-server/main.go       # 装配所有模块 + HTTP/WS 监听 + 优雅退出
├─ internal/
│  ├─ platform/                 # 公共基础设施（无业务语义）
│  │  ├─ config/                # 配置：默认值 < 环境变量（BBC_ 前缀）
│  │  ├─ errors/                # 全量错误码注册表（14 篇 §7）+ E 类型
│  │  ├─ authjwt/               # HS256 JWT 自实现（crypto/hmac，含 OBO act 声明）
│  │  ├─ eventbus/              # 进程内 pub/sub：至少一次 + 死信 + Dedup 幂等骨架
│  │  ├─ httpx/                 # 统一响应包 {code,data,trace_id} + 中间件链 + 令牌桶
│  │  └─ ws/                    # RFC6455 帧编解码/握手/Conn（服务端子集）
│  ├─ auth/                     # 登录/refresh 一次性轮换链/OBO 签发（scope 子集校验）
│  │  └─ api|service|repo|module.go
│  ├─ org/                      # 用户/组织（阶段一：用户读取 + 口令哈希归属）
│  ├─ message/                  # seq 分配/client_msg_id 幂等/已读游标/事件发布
│  └─ gateway/                  # WS 信封路由/心跳/hub 推送扇出（msg.created→msg.new）
├─ migrations/0001_init.sql     # PG DDL：13 张表 + RLS 策略 + message 按月分区模板
├─ Dockerfile                   # golang:1.22-alpine → distroless 多阶段
└─ go.mod
```

依赖规则（D02 §4，CI 后续以 import-lint 强制）：模块间只 import 对方 `api/`；
service 只依赖本模块 repo 与其他模块 api；任何模块不得 import gateway。

## 运行 / 测试 / 构建

```bash
# 本地运行（默认 :8080，含 alice/bob 演示数据，口令 demo-pass-123；不设 DSN 即内存模式）
export BBC_JWT_SECRET="$(openssl rand -hex 32)"
go run ./cmd/bbc-server

# PG 模式：设 BBC_DB_DSN（启动自动迁移，幂等；seed 幂等，重启不重复灌数据）
export BBC_DB_DSN='postgres://bbc:...@127.0.0.1:5432/bbc?sslmode=disable'
go run ./cmd/bbc-server

# 单测（表驱动，覆盖 auth/message/ws/eventbus/httpx/gateway 核心逻辑）
go vet ./... && go test ./...

# PG 集成测试（build tag `pg`，未设 BBC_PG_TEST_DSN 自动 skip；CI 用 service container）
BBC_PG_TEST_DSN='postgres://bbc:...@127.0.0.1:5432/bbc?sslmode=disable' \
  go test -tags pg ./internal/message/repo/ -run TestPGSmoke -v

# Docker
docker build -t bbc-server . && docker run -p 8080:8080 -e BBC_JWT_SECRET=... bbc-server
```

快速联调：
```bash
# 登录
curl -s localhost:8080/api/v1/auth/login -d \
  '{"tenant_id":1,"username":"alice","password":"demo-pass-123","did":"dev-1"}'
# 响应包：{"code":0,"data":{"access_token":...,"refresh_token":...},"trace_id":"..."}
# OBO（需 access）
curl -s localhost:8080/api/v1/auth/obo/token -H "Authorization: Bearer <access>" \
  -d '{"agent_session_id":"as-1","scope":["im:message:send"]}'
# WS（任意客户端）
wscat "ws://localhost:8080/ws/connect?token=<access>&did=dev-1"
# > {"v":1,"id":"c-1","type":"ping"}            → {"type":"pong","ack":"c-1"}
# > {"v":1,"id":"c-2","type":"msg.send","payload":{"conv_id":1,"client_msg_id":"u-1","type":"text","body":{"text":"hi"}}}
#   → {"type":"msg.send.ack","ack":"c-2","payload":{"seq":1,...}} + 对端 msg.new
```

## 设计映射表

| 设计文档 | 代码落点 |
|---|---|
| D02 §3 模块内分层 | `internal/<mod>/{api,service,repo}` + `module.go` 构造注入 |
| D02 §4 依赖规则 | 各模块仅暴露 `api` 接口；gateway → messageapi；auth → orgapi |
| D02 §5 事件总线 | `platform/eventbus`（topic 注册表含 msg.created/policy.updated/user.updated…） |
| D02 §6 中间件链 | `httpx.Chain(mux, Trace, Recovery, AccessLog, RateLimit, …)` + 路由级 `Auth→Tenant` |
| 14 篇 §2.2 信封 | `gateway/envelope.go`（v/id/ack/type/ts/code/payload；ping→pong、req→req.ack） |
| 14 篇 §5.2 响应包 | `httpx`（成功 {code,data,trace_id}；失败 +message/details） |
| 14 篇 §7 错误码 | `platform/errors/codes.go`（1xxx–9xxx 全量常量） |
| 03 篇 §2.2 令牌 | `auth/service`：access 15min / refresh 30d 一次性轮换（重放→全下线）/ 设备绑定 |
| 03 篇 §6 OBO | `IssueOBO`：scope ⊆ 用户权限否则 1006；`act.agent_session` 归因 |
| 04 篇 §4.1 发送时序 | `messageservice.Send`：幂等前置→校验(3001/3002/3013/3006)→策略(3004/3005)→seq 分配（会话锁）→落库→冗余→msg.created |
| 04 篇 §4.2 已读 | `MarkRead`：read_seq 只进不退取 max；越过 latest_seq 拒 3018 |
| 04 篇 §5.1 数据模型 | `migrations/0001_init.sql`（含 RLS 与按月分区模板、分区 UK 陷阱注释） |
| 13 篇 §1 公共规范 | 雪花 ID 占位、tenant_id 全表、timestamptz、大对象不进 DB |

## 阶段一 → 阶段二 TODO

- [ ] 口令哈希换 argon2id（现 PBKDF2-SHA256 自实现，向量测试已锚定 RFC 7914）
- [ ] JWT 换 ES256 + `/.well-known/jwks.json`（现 HS256）
- [x] repo 内存实现 → PG（pgx，`BBC_DB_DSN` 切换，接口不变；sqlc 代码生成待接）
- [ ] seq 分配 → Redis INCR（现 PG 行锁 UPDATE 原子分配；启动对齐 max(seq)+1）
- [ ] 事件总线 → NATS/Redis Streams（接口不变）；audit 死信接告警
- [ ] 限流三档（租户/用户/Agent）接 Redis；WS 在线状态 `t:{tid}:online:{uid}`
- [ ] 其余模块（file/doc/kb/eco/admin/audit/notify/aigw）按 D02 §2 表补齐
- [ ] 契约 golden JSON（test/contract）与 RLS 强制测试基类（D02 §9）
