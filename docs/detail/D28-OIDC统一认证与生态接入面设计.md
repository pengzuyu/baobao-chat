# D28 OIDC 统一认证与生态接入面设计（OP 化 + 授权确认链 + 认证域 P0 欠账）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.2（2026-11-16 落稿；同日修订：web 兜底升级为 IdP 浏览器会话，见 §0 拍板 7） |
| 上游文档 | [03-身份认证与权限体系](../03-身份认证与权限体系.md) · [10-生态应用接入](../10-生态应用接入与技能分发设计.md) · [D22-插件系统](D22-插件系统详细设计.md) |
| 本篇定位 | bbc auth 长出标准 **OIDC Provider（OP）对外接入面**，让生态/第三方 web 应用以标准协议接入统一登录；同时收口认证域三项 P0 欠账（refresh 落钥匙串 / RT 切 OBO / 登出清理） |

---

## 0. 拍板点（2026-11-16 会话裁决，勿重提）

| # | 拍板 | 内容 |
|---|---|---|
| 1 | **OIDC 化** | bbc auth 对外做标准 OIDC Provider，目标是「兼容各个应用」（含通用第三方软件），不自创私有协议面 |
| 2 | **嵌 `zitadel/oidc` 库**（建议倾向，评审可改） | 协议正确性（discovery/ID Token/nonce/PKCE/标准 scope）由库保证；我们只实现 Storage 接口接 PG；保留单二进制部署。替代方案「自研 OIDC 全套」被否——出错面大、工作量 2-3 倍 |
| 3 | **一期只做生态应用接入面**（建议倾向，评审可改） | RP = 生态/第三方 web 应用。桌面端自身账密登录、agent OBO、内生态 token（HS256 JWT）**一期全部不动**；桌面端迁移 OIDC 为二期开放问题（§10） |
| 4 | **OIDC 面强制 ES256** | 非对称签名 + jwks 公钥发布是 OP 的前提；**内部 HS256 一期并行保留、互不影响**（两套签发独立），统一时机见 §10 |
| 5 | **既有红线全部保留** | 主 access token / refresh token 不出桌面；插件 `${BBC_USER_TOKEN}` HTTP-only 不变；03 §6.5 反模式清单继续有效 |
| 6 | 推翻记录 | 前轮讨论中的「路线甲：自研薄协议面（自定义 6 端点）」被拍板 1/2 取代，勿再按其设计 |
| 7 | **web 兜底 = 正式 IdP 浏览器会话**（v0.2 修订，2026-11-16 用户质询后） | 弃 v0.1「一次性 10min cookie」口径：HttpOnly+Secure+SameSite=Lax cookie + `oidc_web_session` 表；**默认 7 天滑动**（租户可配 1-30 天；关「记住此浏览器」= 浏览器会话 cookie 关窗即失效）；设备列表可见、可远端下线；改密/禁用全吊销；高敏 scope 或 `prompt=login`/`max_age` 越界强制重输口令。**SSO 免密由此会话承载** |
| 8 | **不独立服务：单体内新增 `internal/oidc` 模块**（2026-11-16 拍板） | zitadel/oidc 以子路由挂现有 bbc-server 的 `/oauth2/*`，与 internal/auth 同进程；不拆独立部署单元。理由与未来拆分触发条件见 §3.2 |
| 9 | ~~aud 多应用适配暂不处理~~（2026-11-16 拍板 → **2026-11-24 被 D38 推翻**，见 §6.5 追记） | 原口径：宽松 aud + 单一全局 `${BBC_USER_TOKEN}`、按 server 独立签发整体挂起。**现行口径：agent 票 ES256 单票制、aud=端点 URL 精确绑定、corp/aigw 逻辑受众收编（[D38](D38-统一身份票据与生态MCP验签设计.md)），勿再按挂起口径设计** |
| 10 | **收缩候选落定**（2026-11-16 开工裁决） | ①密钥双 key 轮换窗口→**手工轮换文档**；②per-client TTL 列→**v1 写死默认值**；③introspection **保留**；④Q2 深链确认链**保持批次序不后置**（按现行批次顺序执行） |

---

## 1. 背景：现状与缺口（2026-11-16 代码调查结论）

### 1.1 已有（不动）

- 账密登录 + HS256 JWT access（15min）+ opaque refresh（30 天滑动、一次性轮换、重放全下线、did 绑定）——`server/internal/auth/service/auth.go`
- OBO 签发端点 `POST /api/v1/auth/obo/token`（scope 子集强制、`act` 归因、≤15min、killswitch）——服务端已实现
- RBAC/数据范围/ACL、device 表、refresh_token 会话表（含轮换审计链）
- 形式 1（agent 接插件自动填 token）：`${BBC_USER_TOKEN}` 由 RT 调用期动态注入 HTTP header（`agent_bridge.rs:988-1002`），stdio env 置空（D22 HTTP-only）

### 1.2 缺口（本篇补）

| 缺口 | 现状 |
|---|---|
| OIDC/OAuth 协议面 | **不存在**。无 authorize/token/jwks/userinfo 端点；错误码 1010-1013 占位零引用（`internal/platform/errors/codes.go:24-28`） |
| 非对称签名 | HS256 对称密钥，公钥无法发布给第三方（能验即能伪造）——`internal/platform/authjwt/jwt.go`（jwt.go:3 已挂 ES256+jwks TODO） |
| 形式 2（web 应用 → desktop 点头像授权） | **完全不存在**。无 deep link 注册、无本地监听、无确认链 |
| desktop「长期登录」 | refresh 仅存内存（`client/src/features/auth/store/auth.ts:15`），重启/刷新即重登；03 §2.3 设计未落地 |
| RT 拿主 token | 客户端从未调 `/auth/obo/token`，RT 缓存的是 UI 主 access token（03 §6.5 反模式 #2：无 act、scope 全量） |
| 登出残留 | 无 `auth_clear_token`，Rust `Shared.token` 登出不清；did 硬编码 `dev-device`（App.tsx:188）；改密不吊销 refresh |

---

## 2. 总体架构

### 2.1 角色与令牌边界

```
┌─────────────────┐  授权码+PKCE   ┌──────────────────┐   ES256+jwks   ┌──────────────┐
│  生态/第三方应用  │ ────────────► │   bbc auth (OP)   │ ◄──────────── │ 任何标准 RP 库 │
│  (Relying Party) │ ◄──────────── │  zitadel/oidc 嵌入 │  本地验签零调用 │  (各语言通用)  │
└─────────────────┘  per-app JWT   └──────────────────┘               └──────────────┘
                                        ▲  WS(oidc.confirm_req) + 深链 bbc://auth
                                        │
                                 ┌──────────────┐
                                 │ bbc desktop  │ ←— 第一方客户端：自身登录一期不走 OIDC，
                                 │ (授权确认终端) │    以「已登录身份」代用户点头像确认授权
                                 └──────────────┘

内生态（一期不动）：桌面 UI / bbrt RT / aigw / /mcp/corp —— 维持 HS256 access + OBO
```

### 2.2 授权全链（形式 2 正式形态）

```
1. web 应用 → GET /oauth2/authorize?client_id&redirect_uri&scope&state&nonce&code_challenge(S256)&response_type=code
2. OP 创建 AuthRequest → 302 到宿主「授权等待页」/oauth2/wait?req={id}（服务端渲染，见 §5）
3. 等待页：显示 6 位确认码 + 发起深链 bbc://auth?req={id} 拉起 desktop
   ├─ desktop 在线已登录 → 弹确认卡（client 名/logo/scope 清单/同一 6 位码）
   │    用户点头像 → desktop 以自身 access token 调 POST /oauth2/confirm{req, code6}
   │    → OP 校验（用户身份+6位码一致+未超时）→ op.ApproveAuthRequest
   ├─ desktop 未登录 → desktop 弹自身登录页，登录后回到确认卡
   └─ 无 desktop（深链超时/失败）→ 等待页回落账密表单（§5.3）→ 登录建 IdP 浏览器会话（7 天滑动）→ 页面内确认
        会话期内再从任何应用发起 bbc 登录 = 免密直达 consent（SSO；grant 已覆盖则静默跳回）
4. OP 签发一次性 code（60s、绑定 req）→ 302 redirect_uri?code&state
5. web 应用 → POST /oauth2/token（code + code_verifier，PKCE 校验）
   → access_token(JWT: iss/aud=client_id/sub/tenant/scope 子集/exp≤15min) + id_token + refresh_token
6. 应用侧每次请求本地验签（拉一次 /.well-known/jwks.json 缓存 kid），0 网络调用
   高敏操作选配 POST /oauth2/introspection 实时校验；登出调 /oauth2/revoke
```

安全要点（沿用 03 §2.1.1 既定骨架，方向反用）：code 一次性 60s；**6 位确认码双端一致核对**（防伪造深链钓鱼：恶意程序能拉起 desktop，但没有网页上显示的正确 6 位码就过不了确认）；state/nonce 由 RP 侧库标准处理；redirect_uri 精确匹配白名单；PKCE S256 对 public client 强制（机密客户端另发 client_secret，一期默认只开 public）。

### 2.3 令牌模型（OIDC 面，与内部令牌并行）

| 令牌 | 形态 | TTL | 撤销 |
|---|---|---|---|
| OIDC access | JWT **ES256**（iss/aud/sub/tenant/scope/exp/jti） | ≤15min | 自然过期；introspection 可实时查 |
| OIDC ID Token | 库标准签发（nonce/at_hash） | 短 | 一次性消费 |
| OIDC refresh | opaque，轮换制（与内部 refresh 同语义） | 30 天滑动 | /oauth2/revoke + 管理端吊销 |
| 内部 access（不动） | JWT HS256 | 15min | 现状 |
| OBO（批0 起 RT 改用） | JWT HS256 + act | ≤15min | killswitch + 续签重算 |

---

## 3. zitadel/oidc 集成层

- 依赖：`github.com/zitadel/oidc/v3`（go 1.26 兼容；具体接入 API 以当时版本为准，本节按 v3 模型设计，编码期校准）。
- 挂载：`op.NewServer(...)` 以 subrouter 挂 `/oauth2/*`，discovery 自动暴露 `/.well-known/openid-configuration`（issuer=`https://{域名}/oauth2`）；与现有 `/api/v1` 信封体系互不干扰。
- **Storage 接口实现**（宿主唯一要写的适配层，~几百行）：
  - `Client` 查询 → `oidc_client` 表（§4）
  - `AuthRequest` 生命周期（创建/查询/保存 code/消费）→ `oidc_auth_request` 表
  - access/refresh 签发回调 → 复用既有用户 scope 聚合逻辑（auth.go:153-176 同源），**scope 必须是用户权限子集**（OBO 端点同款校验，1006 语义）
  - `SigningKey` 轮换 → §3.1
  - `UserInfo` → `oidc_grant` + user 表拼装
- **自定义 claims**：access token 注入 `tenant`/`scope`（bbc 权限点字典）；ID Token 走库标准结构。RP 若要展示名，走 `/oauth2/userinfo`（sub/name/employee_no/tenant）。
- 错误响应走 **OAuth2 标准格式**（`error=invalid_client/invalid_grant/...` HTTP 400/401），**不走 bbc `{code,data}` 信封**——两者并存，路由前缀区分。

### 3.0 模块归属（拍板 8）

新增 `server/internal/oidc/` 模块，按既有 `internal/*` 惯例分层（api 适配 zitadel Storage 接口 / repo 走 PG / service 复用 auth 域的用户 scope 聚合与登录锁定），在 `main.go` 以子路由挂 `/oauth2/*`。zitadel 依赖被隔离在该模块内，`internal/platform/authjwt`（内部 HS256）不动。

### 3.1 签名密钥与 jwks

- ES256 密钥对：env `BBC_OIDC_SIGNING_KEY`（PEM/base64，随部署注入；生成脚本进 `deploy/compose`，与 `BBC_JWT_SECRET` 同级管理，★上线必改）。
- kid 轮换：按库的 key rotation 接口双密钥并存窗口（新签用新 kid，jwks 同时发布新旧公钥；旧密钥仅验签直至其签发的 token 全部过期 ≤15min 后下线）。
- jwks 端点由库提供（`/.well-known/jwks.json`），应用侧启动拉取 + kid 未命中重拉。

### 3.2 为什么不是独立服务（拍板 8 依据）

| 拆服务的经典触发条件 | bbc 现状 |
|---|---|
| 独立伸缩（流量差异大） | ❌ OP 流量=登录时才发生（authorize/token/jwks），相对 IM/WS 可忽略；jwks 被应用缓存后更是接近零 |
| 独立故障域（一个挂不能拖垮另一个） | ❌ 登录/refresh 本来就在主服务里，拆 OIDC 拆不走认证；且 OP 挂不影响已登录用户（应用本地验签），共享故障域的实际代价≈0 |
| 独立发布节奏/团队边界 | ❌ 单仓库单团队，无边界收益 |
| 技术栈不同 | ❌ 同为 Go |
| 安全隔离（密钥独占进程） | ❌ 主进程已持有 JWT_SECRET 与 KMS 主密钥，ES256 私钥不引入新的暴露等级 |

反面的**硬成本**：拆出去立即需要——服务间认证（03 §2.4 的 svc token + mTLS **尚未实现**，等于先造未落地的基建）、独立 compose 服务与监控、共享 PG 的跨服务会话查询、desktop `/oauth2/confirm` 的跨服务转发。全部是为拆而拆的成本，零收益。

**未来值得拆的触发信号**（记档，触发再议）：① 对外多租户运营，OP 流量与主业务解耦诉求出现；② 需要把签名私钥隔离到专属进程/HSM 级保护；③ 生态应用规模大到需要独立对 OP 做灰度/版本。届时迁移路径平滑：模块已按 internal/oidc 独立分层，抽出=换 main+加 svc token，不动表结构与协议面。

部署侧变化仅两处：compose `.env.tpl` 增 `BBC_OIDC_SIGNING_KEY`（★上线必改，与 BBC_JWT_SECRET 同级）；nginx 无需新 location（`/oauth2/*` 沿用既有 `/` → app 代理）。app×2 副本无状态兼容：AuthRequest/web_session/refresh 全在 PG，两副本行为一致，jwks 同源同密钥。

---

## 4. 数据模型（迁移 0038 起，注意已存在两份 0037 撞号）

```sql
-- 0038_oidc.sql
oidc_client(
  id, tenant_id,
  client_id TEXT UNIQUE,          -- 应用标识
  client_secret_hash TEXT NULL,   -- 机密客户端才有；public client(PKCE-only) 为空
  name, logo_file_id,             -- 确认卡展示
  redirect_uris JSONB,            -- 精确匹配白名单
  scopes JSONB,                   -- 允许申请的 bbc 权限点白名单（发布时静态校验）
  grant_types JSONB DEFAULT '["authorization_code"]',
  access_ttl_sec INT DEFAULT 900, refresh_ttl_sec INT DEFAULT 2592000,
  status,                         -- active / disabled（下架即拒新授权）
  created_by, created_at, updated_at)

oidc_auth_request(
  id, client_id, user_id NULL,    -- desktop/web 确认后回填
  did NULL,                       -- 发起确认的 desktop 设备（审计）
  scopes JSONB, nonce TEXT, state TEXT,
  pkce_challenge TEXT, pkce_method TEXT,
  code_hash TEXT NULL,            -- 签发后存 sha256；一次性消费（consumed_at）
  confirm_code TEXT,              -- 6 位确认码 hash
  status,                         -- pending/approved/denied/expired/consumed
  expires_at, approved_at, consumed_at, created_at)

oidc_grant(                       -- 用户×应用授权记录（「已授权应用」页 + 撤销依据）
  id, tenant_id, user_id, client_id, scopes JSONB,
  granted_at, last_used_at, revoked_at NULL)

oidc_refresh_token(               -- 与内部 refresh_token 分表：client 维度+grant 关联
  id, grant_id, user_id, client_id, did,
  token_hash UNIQUE, rotated_from, status, expires_at, created_at)

oidc_web_session(                 -- IdP 浏览器会话（web 兜底登录态，SSO 免密载体）v0.2 增
  id, tenant_id, user_id, did,    -- did=浏览器首次登录生成的稳定设备号
  token_hash UNIQUE,              -- HttpOnly cookie 中 opaque 值的 sha256
  sliding_expires_at,             -- 滑动过期（默认 7d，每次使用续期）
  user_agent, ip, last_used_at, status, created_at, revoked_at)
```

- 客户端注册入口：admin 后台「生态应用 → OIDC 凭证」页（`admin:app:publish` 权限，与 eco_app 上架联动：发布应用时可一键生成 client_id；一期也允许纯手工注册不挂 eco_app）。
- 用户面「已授权应用」：设置页列出自身 oidc_grant + 一键撤销（撤销 = 吊销该应用全部 refresh + grant 置 revoked）。
- web 会话进设备列表（「浏览器会话」一类，did 维度）可单条远端下线；改密/用户禁用全部吊销（与既有全端下线链路汇合）。
- 审计事件：`auth.oidc.request` / `auth.oidc.approve` / `auth.oidc.deny` / `auth.oidc.token` / `auth.oidc.revoke`（subject=用户，含 client_id）。

---

## 5. 授权确认交互（desktop 点头像）

### 5.1 desktop 确认卡（一期主体交互）

- 深链：`tauri.conf.json` 注册 URL scheme `bbc`（`bbc://auth?req=...`）；等待页 JS 尝试唤起，300ms 无响应视为无 desktop（回落 §5.3）。
- desktop 收到深链 → 弹确认卡：应用名+logo、申请 scope 的人类可读清单、**页面同源 6 位码**、用户自己头像（点击即确认）。
- 确认动作：`POST /oauth2/confirm {req_id, confirm_code}`，鉴权用 desktop 自身 access token（Bearer）——服务端由此得知「用户是谁」，回填 AuthRequest.user_id。
- 防钓鱼分层：
  - 6 位码双端一致（等待页显示 ↔ 确认卡显示 ↔ 请求携带，三者核对）——防「恶意程序伪造深链让用户误确认」；
  - 确认卡明示「将授权 XX 应用以你的身份访问：…」——防 scope 混淆；
  - 单 req 300s 过期；单 desktop 并发未决确认 ≤3。
- 已有 grant 覆盖所申请 scope 时：确认卡降级为轻量形态（点头像即走、免 6 位码）；新 scope 走完整卡。`prompt=consent` 强制完整卡。
- desktop 未登录：先弹自身登录页，登录成功后确认卡复现（req 未过期则无需重走）。

### 5.2 服务端「授权等待页」

- `GET /oauth2/wait?req={id}`：服务端 `html/template` 单页（**零前端工程依赖**，Go 内嵌模板，几十行）——展示 6 位码、深链尝试、账密回落表单、超时/拒绝态。
- 轮询感知：页面 2s 轮询 `GET /oauth2/wait/status?req={id}`（或 SSE），确认完成即由库完成 302 回 redirect_uri。
- ⚠ 与「客户端形态仅桌面端」拍板（2026-11-08）的关系：**不冲突**——该页是 IdP 协议必需的浏览器交互面（Keycloak 同款），不是产品客户端形态，不进 client 前端工程、不进 tauri 分发。

### 5.3 无 desktop 兜底（账密 + IdP 浏览器会话）★v0.2 修订

- 等待页内嵌表单 → `POST /oauth2/web-login`（argon2id 校验复用）→ 建立 **IdP 浏览器会话**（`oidc_web_session`，§4）→ 页面内呈现 consent（scope 清单）确认 → Approve → 302 回应用。
- 会话 cookie：HttpOnly + Secure + SameSite=Lax，仅 `/oauth2/*` 路径；**默认 7 天滑动**（每次使用续期；租户可配 1-30 天），未勾「记住此浏览器」则降级为浏览器会话 cookie（关窗即失效）。
- **SSO 语义**：会话有效期内 Bob 再从**任何**应用走 bbc 登录 → authorize 直接识别会话，免密直达 consent；该应用 grant 已覆盖时静默跳回。「7 天退出登录」即此滑动窗口，到期或被下线后下一次登录重输口令。
- 会话不顶替认证：高敏 scope 或 `prompt=login` / `max_age` 越界时，即使会话有效也强制重输口令（标准 OIDC 语义）。
- 防爆破复用既有登录锁定计数；**等待页未决请求本身**仍 300s 一次性（§2.2），与登录态是两个东西。
- 修订记录：v0.1 曾定为「一次性 10min cookie」——安全上成立（无长期 web 凭证），但牺牲了 SSO 免密（每个应用每次都重输口令，统一登录的「统一」名存实亡）；经用户质询后升级为本节口径。7 天会话的安全前提是**可撤销**：会话表 + 设备列表远端下线 + 改密全吊销——与「refresh 落钥匙串」同一原则（能撤销的长凭证才配长寿命）。

### 5.4 错误码启用

1010 请求过期/已使用 · 1011 已拒绝 · 1012 确认码不匹配 · 1013 code 无效——本篇正式启用（此前占位零引用）；OIDC 协议端点错误另走 OAuth2 标准格式（§3）。

---

## 6. 与现有体系的关系（一期不动清单）

| 体系 | 一期处置 |
|---|---|
| 桌面端账密登录 / refresh / WS 认证 | 不动（批0 只补钥匙串落盘与清理欠账） |
| bbrt RT 供给 | 批0 从「主 token」切到 `/auth/obo/token` 签的 OBO token（act 归因+scope 子集）；与 OIDC 面无耦合 |
| aigw / /mcp/corp / 插件 `${BBC_USER_TOKEN}` | 不动（HTTP-only 语义不变） |
| 内部 HS256 | 与 OIDC ES256 双轨并行；统一切换时机开放（§10） |
| svc token / mTLS（03 §2.4） | 不属本篇 |
| OBO 与 RFC 8693 token exchange 对齐 | 二期开放问题 |

---

## 6.5 MCP 消费侧的三类信任域（谁的 MCP 认谁的 token）★v0.2 增

> 背景：生态应用以插件形式接入、插件按 MCP 对接应用（D22 既定）。关键认知：**「应用支持 OIDC」≠「应用认 bbc 的 token」**——支持 OIDC 登录只是它当 RP（把登录托付给 bbc）；要在它的 API/MCP 网关上验证 bbc 签发的 token，必须由**应用侧主动配置 bbc 的 jwks**。只有自己生态的应用和公司控制的网关会这么做，SaaS 不会为任何客户配置外部 IdP 联邦。

| 类 | 谁的 MCP | 例 | MCP 认什么凭证 | bbc 侧机制 |
|---|---|---|---|---|
| A | **bbc 生态应用**（D28 RP） | 用 bbc 统一登录的自研/外包应用，其 MCP 面对 agent 开放 | **bbc 签发的 OBO token**（sub=用户、act=agent 会话、aud=该应用；应用侧用 bbc jwks 本地验签） | RT 调用期注入 `${BBC_USER_TOKEN}`（既有机制零改动）；aud 精确到应用依赖 RFC 8693（§9） |
| B | **公司自建 MCP 网关**（corp 源） | 内部 OA/ERP/知识库包装的 `/mcp/corp` | 同 A（OBO + act 归因） | D22/D14 既定三源装配 corp>插件>个人，已有 |
| C | **第三方 SaaS 的 MCP** | GitHub/Notion/Slack 官方 remote MCP、社区 stdio MCP | **它们自己的凭证**——bbc token 永远无效，不必尝试 | 三条子路：①D26 个人 MCP：keyring 存其 API key（`${CONFIG:key}`，**今天就能用**）②bbc 作为 OAuth client 对其授权服务器走 MCP 授权规范（OAuth 2.1）自动拿 token 落 keyring——bbrt-mcp 需补 OAuth client 能力（§9 开放问题）③服务端连接器代持（10 篇 §6.3 B：凭证 KMS + 转发携带用户上下文头）——团队共享服务账号场景 |

**对 A 类的 aud 细节**：多 server 是装配**常态**而非异常——三源装配（`assemble_mcp_servers`）在登录/配置期把 corp 网关+全部已装插件+个人 MCP 的整套清单一次推给 RT，装 N 个生态插件即同时挂 N 个 A 类 MCP，且一条 agent 指令可交叉调用多应用工具。问题不在「能否同时连」而在**一份全局 token（OboCache 单值 → `${BBC_USER_TOKEN}` 注入所有 server）无法同时对多个受众有效**：若各 A 类网关严格校验 aud=自身 client_id，同一 token 必然顾此失彼。解法三档：一期宽松 aud（网关接受 `aud=自身或 bbc-agent 通用受众`，注入机制零改动，OBO ≤15min+scope 子集下边际风险小）；中期按 server 独立签发（注入协议升级）；终态 RFC 8693 换票（基础 OBO 换 aud=目标应用窄票，微软 OBO 同款）——编码期与 Storage 适配一并定档位。B 类无此矛盾：corp 网关是「一个 server 挂多个内部系统」，受众天然单一。

**两车道结论**：生态原生应用（A/B）= bbc token 直达（OIDC RP + MCP 验 bbc jwks + OBO 归因）；第三方包装（C）= 用它们的凭证（keyring/OAuth client/服务端代持）。车道判断发生在插件装配期（manifest 声明），不在运行时。

> **★追记（2026-11-24，D38 落稿）**：A 类 MCP 票据形态已由 **[D38](D38-统一身份票据与生态MCP验签设计.md)** 定稿并推翻本篇拍板 9 的挂起——agent 票统一 ES256 单票制（复用本篇 OIDC issuer 与签名密钥），aud=端点 URL（零登记、公开 jwks 本地验签），corp/aigw 逻辑受众 `bbc-corp`/`bbc-aigw` 收编；不引入 RFC 8693 token exchange grant（壳批量直签，无换票环节）；kid 改公钥指纹（kid miss 重拉 jwks 自愈）。登录接入（RP）与 MCP 验签两条线独立并存：应用只用「agent 调 MCP」不注册 client；要「用户用 bbc 登录其页面」才走本篇 client 注册。



## 7. 批次划分

### 批0：认证域 P0 欠账（与 OIDC 无依赖，可先行）

1. refresh token 落 OS 钥匙串（keyring 3.6.3 已在）+ 启动静默刷新直达主界面（03 §2.3 落地）；
2. RT 供给切 OBO：`auth_set_token` 链路改为宿主持 access token 调 `/auth/obo/token`（agent_session_id 取当前 RT 会话，scope 默认用户全量子集）→ `obo.token` 下发；`obo.renew` 走真换签而非重发缓存；
3. `auth_clear_token`（登出清 Rust 缓存+通知 RT 销毁 OBO）+ did 真实化（Rust 生成稳定设备 ID 替换 `dev-device`）+ 改密吊销全部 refresh。

### 批1：OIDC 地基（服务端）

依赖引入 `zitadel/oidc/v3`；迁移 0038；Storage 适配层；ES256 密钥装载/轮换 + jwks + discovery；authorize/token 端点（授权码+PKCE，web-login 兜底闭环先跑通纯 web 路径）；oidc_client admin CRUD。

### 批2：desktop 确认链

URL scheme `bbc://` 注册；深链路由到确认卡；确认卡 UI（antd，复用 D26 组件口径）；`POST /oauth2/confirm`；等待页深链尝试+轮询；6 位码全链。

### 批3：授权管理与撤销面

用户面「已授权应用」页（oidc_grant 列表+撤销）；introspection/revoke/userinfo 端点；admin OIDC 凭证管理页（与 eco_app 发布联动）；审计事件接入。

### 批4：文档回填与示例

03 篇修订（§2.1 登录方式表补「生态应用 OIDC 接入」节，§7 接口表补 /oauth2/*）；14 篇协议注册表登记；`examples/` 增一个最小 RP 示例（Go 或 Node，演示 jwks 本地验签）；README 部署段补 `BBC_OIDC_SIGNING_KEY`。

---

## 8. 真机验收清单

1. **标准 RP 兼容**：用通用软件实测走通授权码+PKCE 全链（候选：Grafana OIDC 登录 / oidc.comdebug 工具 / keycloak 客户端模拟），jwks 本地验签通过；
2. desktop 在线：web 应用发起 → 深链拉起 desktop → 6 位码核对 → 点头像 → code 回调 → 换 token → 带 token 调 userinfo 成功；
3. desktop 未登录：先登录后确认卡复现，全链通；
4. 无 desktop：等待页账密兜底 + consent 确认全链通；7 天内第二个应用免密直达（SSO）；浏览器会话在设备列表远端下线后立即失效；
5. 6 位码错误 3 次 → req 作废（1012）；深链钓鱼模拟（伪造 req）确认卡显示的 6 位码与页面不一致 → 无法确认；
6. 撤销链：「已授权应用」撤销 → 该应用 refresh 立即不可换新（introspection 返回 inactive）；
7. 密钥轮换：换 kid 后新旧 token 各自可验、jwks 双公钥、15min 后旧密钥下线；
8. 批0 三项：重启 desktop 免重登直达主界面；RT 持有的是 OBO token（服务端日志 act 归因可见）；登出后 Rust 侧 token 清空、改密后全端 refresh 失效。

---

## 9. 开放问题

1. 桌面端自身登录是否二期迁 OIDC（public client + PKCE，统一内外协议）——收益 dogfood，代价重写 refresh/静默续期/WS 链路；
2. OBO 与 RFC 8693 token exchange 对齐（生态应用换票标准化；A 类 MCP 多应用并发时的 aud 精确化依赖此项，§6.5）；
3. **bbrt-mcp 的 OAuth client 能力**：对 C 类 remote MCP（MCP 授权规范=OAuth 2.1）自动走授权 dance 并把 token 落 keyring——补上后 C 类从「手工填 API key」升级为「点一次授权」；
3. 内部 HS256 → ES256 统一切换时机（jwt.go:3 既定 TODO，可借本篇密钥基建顺路做）；
4. 机密客户端（client_secret）形态：一期只开 public client 是否够用（公司内部 web 应用均为前端持有，PKCE 足够）；
5. Device Code Flow（CLI/电视类设备）：zitadel/oidc 支持，是否纳入二期；
6. OIDC refresh 与内部 refresh 是否最终合表（一期分表，观察管理面诉求）。

---

## 10. 依赖与风险

- 依赖：zitadel/oidc v3（新依赖树：go-jose 等）；tauri deep-link 插件（desktop 侧新权限，capabilities 白名单登记）；
- 风险：① zitadel/oidc Storage 接口随版本演进，适配层要锁版本（go.mod 锁 + Cargo.lock 同款纪律）；② 等待页是服务端渲染新形态，与 client 工程完全隔离，评审时确认视觉口径（复用 D27 黑白反色主题的手工 CSS，几十行）；③ 迁移撞号（两份 0037）——0038 起顺序编，psql 手工补口径不变；
- 不做（一期）：单点登出（front/back-channel logout）、CIBA、动态客户端注册、prompt 参数全集（仅支持 consent/login 语义子集）。
- **v1 收缩候选（2026-11-16 过度设计评估，待拍板）**：①密钥双 key 轮换窗口 → 降级为手工轮换文档（换 env+重启；15min TTL 下最多废 15 分钟已签 token，成本可接受）；②oidc_client 的 per-client TTL 两列 → v1 写死默认值；③introspection 建议保留（库近零成本，高敏场景需要）；④批 Q2 深链确认链**可整体后置**——Q1 纯 web 路径已达成「兼容各个应用」目标，Q2 是差异化体验（免密+密码不出第一方页面）非兼容必需，后置不阻塞 OIDC 上线。
