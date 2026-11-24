# D38 统一身份票据与生态 MCP 验签设计（agent 票 ES256 单票制 + 零登记接入）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（2026-11-24 落稿） |
| 上游文档 | [03-身份认证与权限体系](../03-身份认证与权限体系.md) · [D22-插件系统](D22-插件系统详细设计.md) · [D26-个人MCP接入面](D26-个人MCP接入面设计.md) · [D28-OIDC统一认证](D28-OIDC统一认证与生态接入面设计.md) |
| 本篇定位 | agent 出站访问 MCP 的身份票据**终态设计**：ES256 单票制（生态应用 aud=端点 URL，corp/aigw 逻辑受众收编）、生态应用零登记接入（公开 jwks + 本地验签）、装配驱动换票（没装就没票）、运行时零参与 |

---

## 0. 拍板点（2026-11-24 会话裁决，勿重提）

| # | 拍板 | 内容 |
|---|---|---|
| 1 | **统一单票制** | 一种 agent 票（ES256 + iss/aud/act/scope）。「内部票（HS256）/代理票（ES256）」双轨方案否决——迁移问题不考虑（无存量用户），直接终态；corp、aigw 的 agent 票同轨收编，`authjwt` HS256 只留主 access（用户身份） |
| 2 | **受众 = 目的地** | 生态应用 aud = 其 MCP 端点 URL（原样字符串）；corp/aigw 用逻辑名 `bbc-corp` / `bbc-aigw`（保留名白名单，部署常量）。逻辑名不走 URL 的原因：客户端 gateway 地址与服务端 PUBLIC_URL 部署形态下不一致，URL 受众在内部端点上有对不齐的坑 |
| 3 | **零登记** | 生态应用不在 bbc 注册任何 client/凭证：验票只需公开 jwks + 本地验签。OIDC 登录接入（RP，D28）是独立另一条线，两者可只占其一。签发方对 aud 只做格式闸（§3.3），不查任何登记表 |
| 4 | **scope 默认全量** | 票 scope = 用户有效权限点全集（与 corp 现状一致——mcpgw 的 tool.Scope 防线依赖全量）；插件可用 `x-bbc-auth.scope` 声明收窄（可选）。细粒度权限治理有诉求再做 |
| 5 | **url 只许打包写死** | 插件 `.mcp.json` 的 url 唯一合法形态=作者打包时定死的 `http(s)://` 字符串。部署变量 `${BBC_SERVER_URL}` **永久移除（以后也不做）**；管理员运行时改 url **永久移除（以后也不做）**；url 引用 `${CONFIG:*}` 拒绝发布（票不可被引到用户可控地址） |
| 6 | **主令牌回落删除** | 换票失败 → 不发票 → 该 server 调用 401。现状「OBO 签发失败回落重发主 access」（agent_bridge.rs answer_renew / set_access_token 失败分支）是凭证外泄通道（03 §6.5 反模式），本篇修复。`BBC_RT_TOKEN` 静态兜底仅保留为开发态联调（`--dev-token` 语义），正式链路一律不回落 |
| 7 | **kid 改公钥指纹** | keys.go 的固定 `kid="bbc-oidc-es256-1"` 必须改：kid = 公钥 SHA-256 前 16 hex。统一后全部 agent 票压在这一把 ES256 密钥上，kid 固定会让轮换后所有验签方（含 corp/aigw/全部生态应用）缓存失配且不自愈 |
| 8 | **stdio 永不需要令牌** | stdio 子进程经宿主独占管道通信，无跨网络边界，无验证方——`x-bbc-auth` 声明在 stdio server 上**直接拒绝装配**。stdio 身份通道仅 `${BBC_USER_ID}`/`${BBC_USER_NAME}`（明文标识非凭证），凭证通道仅 `${CONFIG:key}`（用户自己的 key） |
| 9 | **票据代模型（齐进齐出）** | 全部受众的票同批签发、同 TTL、同时到期；续签=一次 `obo.renew` 全量重签。看护线程只盯单一「下一代签发时刻」。逐受众独立续签否决（票龄分叉复杂度不值） |
| 10 | **换票运行时零参与** | 换票只发生在壳（持主 access、连服务端）；运行时 `TokenProvider` 纯内存查取，调用路径零网络。缓存没有 → 不带 Authorization → 401 |
| 11 | **act 保持设备级** | `act.sub = desktop-{did}`（归因前缀），粒度粗于 03 §6.2 的会话级设想——每会话票需 TokenProvider 感知会话 ID，改动面大，**登记不修**，会话级另立项 |
| 12 | **旧写法归一** | 插件 headers 中 `${BBC_USER_TOKEN}` 旧写法 = `x-bbc-auth {type:obo}` 等价形式，装配器识别后自动归一（aud=该 server url），旧插件零修改升级新票。usesIdentity 探测逻辑已覆盖两种写法 |

**对 D28 拍板 9 的修订**：D28 曾将「按 server 独立签发 / RFC 8693 换票」整体挂起，一期走「宽松 aud + 单一全局 token 注入」。本篇推翻该挂起：宽松 aud 方案在代码中从未落地（内部票至今无 aud），且 aud 绑定方案对内部零改动（mcpgw/aigw 仅换验签闭包）反而比通用受众方案（要动全部内部验签语义）更小。audience 语义取 `aud=消费方标识`（RFC 8693 同款语义），但不引入 token exchange grant——壳直接批量签发，无换票环节。

---

## 1. 背景与问题（2026-11-24 代码调查结论）

### 1.1 现状

- agent 票 = HS256 内部 OBO（`authjwt.Signer` 签发，无 iss/aud；[auth.go IssueOBO](../../server/internal/auth/service/auth.go)）。消费方两处：`/mcp/corp`（mcpgw `claims()`）与 aigw（`Gateway.auth`），均为 `authjwt.Parse` HS256 共享密钥验签。
- 插件/个人 MCP 的身份注入 = 作者手写 headers `${BBC_USER_TOKEN}`（D22 §6.1/L4），运行时逐请求替换 `OboCache` 单值（全机一张）。
- 生态应用已会验的登录票 = OIDC ES256 JWT（D28 批1 已落地，`AccessTokenTypeJWT`），与 agent 票两套算法两套字段互不相认。
- 签名密钥：`BBC_OIDC_SIGNING_KEY`（ES256 P-256，PEM/base64 双形态），kid 为固定常量（[keys.go](../../server/internal/oidc/keys.go)）。

### 1.2 缺口

| 缺口 | 后果 |
|---|---|
| agent 票 HS256 无 iss/aud | 生态应用验不了（能验即能签=能伪造）；「不同应用不用自己发 key」的目标无法达成 |
| 换票失败回落主 access | OBO 端点故障时**用户主令牌被注入所有 MCP 请求头**，无 act 标记——03 §6.5 反模式现行犯 |
| kid 固定 | 轮换签名密钥后 kid 不变，按 kid 缓存公钥的验证方全部失配且不自愈 |
| url 不参与变量替换 | （参考事实）`mcp_server_wire` 的 url 分支直接透传；本篇拍板 5 后该行为即为终态，仅补 `${CONFIG:}` 拒绝校验 |

---

## 2. 令牌契约（对生态应用的唯一契约）

```json
// header
{ "alg": "ES256", "kid": "<公钥 SHA-256 前 16 hex>", "typ": "JWT" }
// payload
{
  "iss": "https://bbc.example.com/oauth2",       // 复用 D28 OIDC issuer 与签名密钥
  "sub": "10023",                                 // 用户 uid（字符串）
  "aud": ["https://oa.company.internal/mcp"],     // 生态应用=端点 URL；corp/aigw=逻辑名
  "client_id": "bbc-agent",                       // 固定标识（签发主体=bbc agent 面）
  "tenant": 1,
  "scope": ["kb:read", "oa:read"],                // 用户有效权限点（默认全量；声明可收窄）
  "act": { "sub": "desktop-<did>" },              // 代行主体（RFC 8693 act；设备级）
  "jti": "<32hex>", "iat": ..., "nbf": ..., "exp": ...
}
```

| 字段 | 语义 | 应用怎么用 |
|---|---|---|
| `sub` | 用户 uid，权限按此人判定 | 用户识别与授权（数据范围/审计主体） |
| `aud` | 该票的预期消费方 | **必须精确等于自己登记的端点 URL**，不等即 401 |
| `act` | agent 代行（desktop-{did}） | 有则记审计；权限不放宽也不收紧（03 §6.3） |
| `scope` | bbc 权限点子集 | 按需消费；多数应用按 sub 查自身权限体系，可不看 |

### 2.1 验签规则（验证方义务）

1. `alg` 白名单只认 `ES256`（防 alg=none/算法混淆）；
2. 按 `kid` 取公钥本地验签；kid 未命中 → 重拉一次 `/.well-known/jwks.json` 后重试；
3. `iss` 精确匹配 bbc 的 OIDC issuer；
4. `exp` 未过（±60s 容差）、`nbf` 已到；
5. `aud` 包含自己登记的端点 URL。

「有效」= 签名真（bbc 私钥所签）+ 时间真（未过期）+ 目的地真（aud 是我）。**本地验签不覆盖「签发后吊销」**——缺口由 15min TTL 兜底（登出/停用后最大暴露 15min）；实时吊销为可选增强（§10），不进基础契约。

### 2.2 三种票的边界（统一后仍存的区分——角色区分，非票型区分）

| 票 | 算法 | 受众 | 消费方 | 备注 |
|---|---|---|---|---|
| **agent 票**（本篇） | ES256 | 端点 URL / 逻辑名 | corp、aigw、生态应用 | 统一单票制 |
| 主 access | HS256（不动） | 无 | `/api/v1/*`、WS（httpx.Auth） | 用户身份；是否迁 ES256 是 D28 §9-3 既有开放问题，不掺本篇 |
| 本机凭证 | 随机串非 JWT | — | `/mcp/local`（B3）、D30 外部接入 | 本机回环，不属本篇 |

隔离性：agent 票（ES256）打不回 bbc 内部接口（httpx.Auth 只认 HS256，返回 1004）；主 access 无 aud 无 ES256 签名，任何生态应用验不过。**算法层天然隔离，无越界通道。**

---

## 3. 票据全链

### 3.1 受众集合 = 当前装配（没装就没票）

```
受众集合 = 系统级常驻（bbc-corp、bbc-aigw）
         ∪ 已安装且启用且声明统一身份的插件 server（aud = 其 url）
         ∪ 个人 MCP 里声明统一身份的 server（aud = 其 url）
```

卸载/禁用 → 装配重推 → 受众消失 → 缓存条目清除 + 运行时断开该 server（既有重配语义）。票的存在面恒等于用户实际授权的工具面。

### 3.2 换票触发点（事件驱动，仅四个，全部在壳）

| # | 触发事件 | 动作 |
|---|---|---|
| 1 | 登录 / 静默刷新成功（`auth_set_token`） | 按当前装配受众集合**全量重签**下发 |
| 2 | 装配变更（安装/卸载/启禁插件、个人 MCP 增删改、换账号） | 装配重推 → 受众集变化 → 全量重签（票据代 N+1） |
| 3 | 票进入到期前 2min 窗（运行时看护线程，30s 巡检，`RENEW_WINDOW` 不变） | 一次 `obo.renew` → 壳全量重签下发 |
| 4 | 运行时重启（崩溃后惰性拉起 ready 兜底） | 重推装配 + 全量重签（既有路径） |

无定时扫描、无服务端轮询。权限调岗无需前端参与：续签时服务端「续签即重算」scope（超出 1006 拒签），≤15min 收敛。

### 3.3 换票 API 与格式闸

```
POST /api/v1/auth/obo/token
Authorization: Bearer <主 access>            ← 唯一身份来源
{
  "agent_session_id": "desktop-<did>",       ← act 归因（必填）
  "audiences": [                             ← ≤32 个
    { "aud": "bbc-corp" },
    { "aud": "bbc-aigw" },
    { "aud": "https://oa.company.internal/mcp", "scope": ["oa:read"] }   // scope 缺省=全量
  ]
}
→
{ "code": 0, "data": {
    "tokens": [
      { "audience": "bbc-corp", "token": "eyJ...", "exp": 1763961600, "scopes": [...] },
      { "audience": "https://oa.company.internal/mcp", "token": "eyJ...", "exp": ... }
    ] } }
```

| 字段 | 服务端处置 |
|---|---|
| 主 access | 验签 → sub/tenant/用户状态 → scope 上限 |
| `agent_session_id` | 原样进 `act`（不校验格式） |
| `aud` | **格式闸**（下表），通过后原样进 aud claim——不查任何登记表 |
| `scope` | 校验 ⊆ 用户有效权限（超出 1006）；缺省=全量 |

**aud 格式闸**（签发方唯一把关）：

| 取值 | 处置 |
|---|---|
| `https://` 开头 URL | 通过（生态应用类） |
| `bbc-corp` / `bbc-aigw`（保留名白名单，与验证端同源常量） | 通过 |
| `http://` URL、其他字符串、重复、超 32 个 | 拒 **1015**（新错误码：audience 非法） |

### 3.4 运行时铁律

`TokenProvider` 签名改为带受众：`Arc<dyn Fn(&str) -> Option<String> + Send + Sync>`。调用工具 = 按 server 的 audience 查内存缓存；**缓存没有 → 不注入 Authorization → 401**，绝不在调用路径发起网络换票。理由：换票 HTTP 往返塞进工具调用路径意味着秒级阻塞与翻倍的失败分支；预换+看护让调用路径只碰内存（corp 现状同款行为）。

### 3.5 协议改动（bbrt-protocol）

| 消息 | 改动 |
|---|---|
| `McpTransportWire::Http` | 增 `auth: Option<McpAuthWire>`；`McpAuthWire { r#type: "obo", audience: String, scope: Vec<String> }`——**audience 由宿主装配期显式填入 wire**（生态=url、corp=bbc-corp），RT 不做任何推导 |
| `obo.token`（NTF） | 载荷改 `tokens: Vec<OboTokenEntry { audience, token, exp, scopes }>`（全代下发） |
| `obo.renew`（REQ） | 去 `scopes` 字段（代模型全量续），保留 `reason` |

---

## 4. 各层改动

### 4.1 服务端

| 改动 | 文件 | 说明 |
|---|---|---|
| 签名能力单源化 | **`platform/agentjwt`（新 crate 目录）** | ES256 签发+验签+claims 映射三合一：`LoadKey`（迁移自 oidc/keys.go 的 PEM/base64 解析）、`Sign(claims)`、`Verify(token) -> authjwt.Claims 形状`（Subject/TenantID/Scope[]/Actor——**验签方式换了，claims 结构不变**，mcpgw/aigw 业务逻辑零改动）；保留名常量 `bbc-corp`/`bbc-aigw` 单源于此；kid=公钥指纹 |
| IssueOBO 重写 | `auth/service/auth.go` + `auth/api/api.go` | `OBOReq` 改 `{agent_session_id, audiences: [{aud, scope}]}`；逐受众签 ES256（经 Options 注入的 `SignAgent` 闭包——auth 不反向依赖 oidc/agentjwt 包，D02 依赖规则）；killswitch（1013）与 scope 子集校验（1006）语义保留 |
| kid 指纹 | `oidc/keys.go` | kid = 公钥 SHA-256 前 16 hex；loadSigningKey 迁入 platform/agentjwt，oidc 改为薄包装（私钥单源） |
| mcpgw/aigw 验签切换 | `mcpgw/module.go`、`aigw` 装配点、`cmd/bbc-server/main.go:487` | verify 闭包从 `authAPI.Verify`（HS256）换 `agentjwt.Verify`（ES256+aud 校验：mcpgw 校验含 `bbc-corp`、aigw 含 `bbc-aigw`）；actOf 归因改票内 `act.sub` 优先（`_meta.bbcAct`/`X-BBC-Act` 头通道退役）；IsOBO=act 非空（killswitch 闸语义不变） |
| 错误码 | `platform/errors/codes.go` | 新增 1015（audience 非法） |

**零新表、零新 env、零迁移**：签名密钥复用 `BBC_OIDC_SIGNING_KEY`（已有）；签发无状态不落库（同内部 OBO 现状）；开发态临时密钥逻辑随 LoadKey 单源保留。

### 4.2 运行时（agent/crates）

| 改动 | 文件 |
|---|---|
| `TokenProvider` 带受众 | `bbrt-mcp/src/call.rs` |
| HttpTransport 持 audience、按受众取票注入 | `bbrt-mcp/src/transport.rs`（stdio 拒 auth 声明在此校验） |
| `OboCache` 单值 → 按受众键控（`set_generation` / `get(aud)` / `needs_renew` 任一进窗 / `retain` 清孤儿受众） | `bbrt-hostapi/src/obo.rs`（`RENEW_WINDOW` 不变） |
| mcp_tokens 闭包带受众；corp 受众=bbc-corp；看护线程改单一时刻（任一受众进窗→一次 renew）；静态 token 兜底降级为开发态 | `bbrt/src/main.rs` |
| aigw 客户端 token provider 固定受众 bbc-aigw | `bbrt-aigw/src/client.rs` |

### 4.3 宿主（client/src-tauri）

| 改动 | 文件 |
|---|---|
| 装配器解析 `x-bbc-auth`；`${BBC_USER_TOKEN}` 归一（拍板 12）；wire 填 auth+audience；**stdio 含 auth 声明拒装** | `agent_bridge.rs`（assemble_mcp_servers / mcp_server_wire） |
| `set_access_token` 收集受众 → 批量换票 → `obo.token{tokens[]}`；`answer_renew` 全量重签；**删除两处回落主 access 分支**（拍板 6） | `agent_bridge.rs` |
| 个人面校验：`x-bbc-auth` 仅 http 形态可声明；usesIdentity 探测扩展 | `mcp_commands.rs` |

### 4.4 前端（client/src）

| 改动 | 文件 |
|---|---|
| 个人 MCP 编辑器：HTTP 鉴权方式二选一（统一身份 / 自定义请求头） | `McpSettingsPage.tsx` + `mcp.ts` |
| 安装确认文案带目的地：「将以你的身份访问 oa.company.internal」 | `PluginPage.tsx` |

### 4.5 插件校验（双端）

| 改动 | 文件 |
|---|---|
| url 含 `${CONFIG:` → 拒包；`x-bbc-auth` 结构校验（type=obo、scope 数组、stdio 不可声明）；usesIdentity 探测覆盖 `x-bbc-auth` | `eco/service/plugin_validate.go` + 客户端复跑轻校验（`features/eco/api/plugins.ts`）同步 |

---

## 5. url 与插件配置规则（拍板 5/8 展开）

```jsonc
// .mcp.json（唯一合法形态：url 打包写死）
{
  "mcpServers": {
    "oa":     { "url": "https://oa.company.internal/mcp",
                "x-bbc-auth": { "type": "obo" } },
    "oa-ro":  { "url": "https://oa.company.internal/mcp",
                "x-bbc-auth": { "type": "obo", "scope": ["oa:read"] } },   // 可选收窄
    "gitlab": { "url": "https://gitlab.company.com/api/mcp",
                "headers": { "Private-Token": "${CONFIG:gitlab_token}" } } // 外部系统自己的 key
  }
}
```

| 规则 | 判定层 |
|---|---|
| url 必须 `http(s)://` 开头（既有） | 服务端发布校验 + 客户端复跑 |
| url 禁止 `${CONFIG:`（任何变量）——票不可被引到用户可控地址 | 同上，新增 |
| `x-bbc-auth` 仅 HTTP 形态可声明；stdio 声明 → 拒包 | 同上 |
| `x-bbc-auth.scope` 各项须为合法权限点命名（格式校验；运行期服务端 1006 兜底） | 同上 |
| headers `${BBC_USER_TOKEN}` 旧写法 → 装配器归一为统一身份（拍板 12），**头写法不再推荐、文档标注 legacy** | 宿主装配器 |

个人 MCP（D26 面）同规则 + 用户可自填任意 url（用户自有凭证风险归属清晰；声明统一身份时确认弹窗明示目的地）。

---

## 6. 安全分析（攻击面 → 处置）

| # | 攻击面 | 处置 |
|---|---|---|
| ① | 串票：拿 A 应用的票打 B | aud 精确校验 → 401。代价：应用无法「一份票通吃自家多端点」，多入口须各自登记 aud（接入文档写明） |
| ② | 票被引到恶意地址 | url 分层（拍板 5）：市场插件 url 只许打包写死 + 禁 `${CONFIG:}`；个人面用户自担（弹窗明示目的地）。恶意地址最多拿到 `sub=自己、aud=恶意域` 的票——不能访问 bbc 内部（算法隔离），仅身份信息暴露 |
| ③ | 主令牌外泄 | 回落分支删除（拍板 6）；换票失败 → 401 |
| ④ | 越权访问他人数据 | sub=用户本人，应用按 sub 判权限；agent 不增不减能力（03 §6.3）；发起侧另有九步门控+审批卡 |
| ⑤ | 登出/停用后残留 | 已签票 ≤15min 自然死亡；壳清缓存不再续；新票拒签。实时吊销为可选增强（§10） |
| ⑥ | 票出现不该出现的地方 | 不进 WebView、不落盘（既有）；stdio 拒声明（拍板 8）；`obo.token` 含多张票后日志只打受众数与长度，不打 token |
| ⑦ | 轮换后验证方全部失配 | kid 改公钥指纹（拍板 7），kid miss → 重拉 jwks 自愈 |
| ⑧ | killswitch | 换票拒 1013；mcpgw/aigw 存量票请求仍被 oboGate 拦（双点拦截不变） |
| ⑨ | alg 混淆 / alg=none | 验证方 alg 白名单 ES256（契约 2.1）；签发端固定 ES256 |

---

## 7. 生态应用接入指南（契约面摘要）

应用需要的全部「知识」与「动作」：

| 需要 | 来源 | 性质 |
|---|---|---|
| bbc 公钥 | `GET {issuer}/.well-known/jwks.json`（公开无鉴权；启动拉、按 kid 缓存、miss 重拉） | 公开信息 |
| issuer 地址 | 应用自身部署配置（与配数据库地址同性质） | 部署事实 |

```go
// 全部接入代码（Go / golang-jwt v5）
func bbcAuth(myAud string) func(http.Handler) http.Handler {
    ks := NewJWKS(os.Getenv("BBC_ISSUER") + "/.well-known/jwks.json")
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
            tok, err := jwt.Parse(raw, ks.Keyfunc,
                jwt.WithValidMethods([]string{"ES256"}),
                jwt.WithIssuer(os.Getenv("BBC_ISSUER")),
                jwt.WithAudience(myAud), jwt.WithExpirationRequired(),
                jwt.WithLeeway(60*time.Second))
            if err != nil || !tok.Valid {
                w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
                http.Error(w, "invalid token", http.StatusUnauthorized); return
            }
            next.ServeHTTP(w, r.WithContext(withUser(r.Context(), tok.Claims.GetSubject())))
        })
    }
}
```

完整可跑示例随批 7 落 `examples/mcp-resource-server/`（Go：jwks 缓存中间件 + aud 校验 + 401 `WWW-Authenticate` + 串票拒绝演示）；`examples/oidc-rp`（D28 登录接入示例）不受影响，两者并存演示两条独立接入线。

---

## 8. 实施批次（每批一提交一推送）

| # | 事项 | 验证 |
|---|---|---|
| 1 | 本文档 + detail/README 索引 + 03/D22/D26/D28 追记 | — |
| 2 | platform/agentjwt（LoadKey/Sign/Verify/claims 映射/保留名常量）+ kid 指纹 + 1015 + IssueOBO 批量受众 + 单测 | go build/vet/test 绿 |
| 3 | mcpgw/aigw verify 切换（aud 校验、actOf 改票内 act）+ 测试改造 | go test 绿；corp 工具面回归 |
| 4 | 协议（wire.auth / obo.token tokens[] / obo.renew 简化）+ bbrt-mcp（TokenProvider/transport/stdio 拒声明）+ bbrt-hostapi（OboCache 键控）+ bbrt/aigw 接线 | cargo test（agent 工作区）绿 |
| 5 | 宿主：装配器（x-bbc-auth 解析/归一/audience 填充/stdio 拒装）+ 批量换票 + 全量续签 + 回落删除 + 个人面校验 | cargo build（src-tauri）绿 |
| 6 | 前端（个人 MCP 鉴权方式/安装文案）+ 服务端发布校验扩展 + 客户端复跑同步 | tsc 0 错 + vite build 绿 |
| 7 | 接入指南文档（docs/ 或 README 段）+ examples/mcp-resource-server + 真机验收 | §9 全项 |

## 9. 真机验收清单

1. 装带 `x-bbc-auth` 的插件 → 登录 → 抓包：生态端点请求头为 ES256 三段 JWT，aud=插件 url，act=desktop-{did}；
2. corp 工具照常工作（aud=bbc-corp）；aigw LLM 调用照常（aud=bbc-aigw）；
3. **任何 MCP 请求头不出现主 access**：模拟换票失败（停 obo 端点）→ 生态/corp 调用 401，抓包确认无主令牌泄漏；
4. 续签无感：T+13min 自动换代，应用侧仅见 jti 变化；旧票过期后请求带新票；
5. 卸载插件 → 受众消失、缓存清、无调用；重装 → 新代补入；
6. stdio server 声明 `x-bbc-auth` → 安装/装配被拒（双端校验）；
7. url 含 `${CONFIG:` → 发布被拒；
8. 旧式 `${BBC_USER_TOKEN}` headers 插件 → 自动归一正常工作（零修改升级）；
9. killswitch 拉下 → 换票 1013 + 存量票调用被 oboGate 拦；
10. 密钥轮换：换 `BBC_OIDC_SIGNING_KEY` → 应用侧 kid miss → 重拉 jwks → 恢复（无人工干预）；
11. 串票：A 应用的票打 B 应用 → 401；agent 票调 `/api/v1/*` → 1004（算法隔离）；
12. examples/mcp-resource-server 对着真机 bbc 跑通验签全链；
13. 未登录 → 生态调用 401；定时任务无人值守期间照常续票（壳活着）。

## 10. 开放问题

| # | 问题 | 处置 |
|---|---|---|
| 1 | 实时吊销（introspection 供资源服务器查询 / jti 吊销名单） | 可选增强；需签发落库（打破零迁移），有租户提诉求再立项 |
| 2 | act 会话级（每会话独立票，03 §6.2 原设想） | 需 TokenProvider 感知会话 ID，另立项 |
| 3 | 细粒度 scope 治理（租户策略约束插件可声明的 scope 集） | 有诉求再做（拍板 4） |
| 4 | 主 access 是否 ES256 化 | D28 §9-3 既有开放问题，不掺本篇 |
| 5 | SSE / streamable HTTP transport（D26 OQ-2 顺延） | 现单请求单连接 POST 口径不变 |
