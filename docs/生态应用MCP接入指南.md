# 生态应用 MCP 统一身份接入指南

> 适用对象：为 bbc 平台提供 MCP 能力的**生态应用开发者**。你的应用把自己的工具以
> MCP 端点暴露给用户的 agent，agent 以**该用户本人的身份**调用——你不需要发放任何
> key/token，只需要**本地验签**。设计依据：[D38-统一身份票据与生态MCP验签设计](detail/D38-统一身份票据与生态MCP验签设计.md)。

---

## 1. 你需要做的全部事情

| # | 事项 | 性质 |
|---|---|---|
| 1 | 在自己的部署配置里写上 bbc 的 **issuer 地址**（如 `https://bbc.example.com/oauth2`；内网无 TLS 部署直接配 `http://<内网IP>:<端口>/oauth2`，明文全链支持） | 部署事实（与配数据库地址同性质） |
| 2 | 启动时拉一次 **jwks 公钥**（`GET {issuer}/.well-known/openid-configuration` → `jwks_uri`；公开端点无鉴权） | 公开信息 |
| 3 | MCP 端点套一个 **30 行验签中间件**（本文 §3） | 一次性代码 |

**不需要**：注册应用、申请 client_id/secret、实现刷新逻辑、调用 bbc 的任何接口。

> 辨析：如果你的应用**另外**想让人类用户用 bbc 账号登录它的 Web 界面，那走的是
> OIDC 登录接入（[D28](detail/D28-OIDC统一认证与生态接入面设计.md)，需要注册
> client）——与本文的 MCP 验签**两条独立线**，可只占其一。内网明文部署下该线同样
> 可用：issuer 配 `http://` 地址，RP 回调直接注册 `http://` 回调（web 类型 + code
> 流放行，未注册回调仍精确匹配拒绝）。

## 2. agent 发来的票长什么样

```
Authorization: Bearer <JWT>
header: {"alg":"ES256","kid":"<公钥指纹 16hex>","typ":"JWT"}
payload:
{
  "iss":  "https://bbc.example.com/oauth2",
  "sub":  "10023",                                  // 用户 uid（权限唯一依据）
  "aud":  ["https://oa.example.internal/mcp"],      // 预期消费方 = 你的 MCP 端点 URL
  "client_id": "bbc-agent",
  "tenant": 1,
  "scope": ["kb:read", ...],                        // bbc 权限点（默认用户全量）
  "act":  {"sub":"desktop-a1b2c3"},                 // 代行主体（agent 设备；记审计用）
  "jti": "...", "iat": ..., "nbf": ..., "exp": ...  // 15 分钟
}
```

**「有效」= 三层本地检查**：签名真（bbc 私钥所签）+ 时间真（未过期）+ 目的地真
（`aud` 包含你登记的端点 URL）。伪造任何一项都需要 bbc 的私钥，而私钥只在 bbc。

票 15 分钟换新一张（agent 侧全自动，你无感知，只看到审计里 `jti` 变化）。你**不实现
任何刷新**——验证是无状态的。

## 3. 验签中间件（Go 示例，全部接入代码）

```go
func bbcAuth(myAud string) func(http.Handler) http.Handler {
    ks := NewJWKS(os.Getenv("BBC_ISSUER")) // 启动拉 jwks、按 kid 缓存、miss 重拉一次
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
            tok, err := jwt.Parse(raw, ks.Keyfunc,
                jwt.WithValidMethods([]string{"ES256"}),   // ① 算法白名单（只认 ES256）
                jwt.WithIssuer(os.Getenv("BBC_ISSUER")),   // ② iss 精确匹配
                jwt.WithAudience(myAud),                   // ③ aud = 我的端点（串票在此被打掉）
                jwt.WithExpirationRequired(),
                jwt.WithLeeway(60*time.Second))            // ④ 时间容差 ±60s
            if err != nil || !tok.Valid {
                w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
                http.Error(w, "invalid token", http.StatusUnauthorized)
                return
            }
            // 验签通过：sub=用户 → 业务按此执行；act 有值 → 记审计（不改变权限判定）
            next.ServeHTTP(w, r.WithContext(withUser(r.Context(), userOf(tok))))
        })
    }
}
// http.Handle("POST /mcp", bbcAuth("https://oa.example.internal/mcp")(mcpHandler))
```

**验签规则逐条**（任何语言等价实现）：

| # | 检查 | 失败含义 |
|---|---|---|
| ① | `header.alg == "ES256"`（白名单，防 alg=none/算法混淆） | 非 bbc 票系 |
| ② | 按 `kid` 取公钥验签；**kid 未命中 → 重拉一次 jwks 再试**（密钥轮换自愈） | 伪造/轮换窗口 |
| ③ | `payload.iss == issuer`（精确） | 别的签发方 |
| ④ | `exp` 未过（±60s）、`nbf` 已到 | 过期票 |
| ⑤ | `payload.aud` **包含**你登记的端点 URL | 串票（别的应用的票） |

可运行示例（含 jwks 缓存/aud 拒绝/MCP 回显全链）：[examples/mcp-resource-server](../examples/mcp-resource-server)。

## 4. 业务侧怎么消费票内字段

| 字段 | 怎么用 |
|---|---|
| `sub` | **权限唯一依据**：按该 uid 查你自己域内的权限/数据可见性（与人类用户登录同一套判定） |
| `act` | 有值 = agent 代行：审计记 `subject=sub / actor=agent:<act>`；**不因是 agent 放宽或收紧权限** |
| `scope` | 可选消费的权限点收窄（多数应用按 `sub` 查自身体系，可忽略）；为空数组 = 用户全量 |
| `tenant` | 多租户计量/隔离（单租户部署可忽略） |

**一致性要求**：你的 MCP 端点 URL（你配置的 `myAud`）必须与 bbc 侧登记该应用时用的
地址**逐字符相同**——它就是受众比对值。多端点（如 `/mcp` 与 `/mcp/admin`）各自是
独立受众，或在同一验签后按路径细分。

## 5. 401 处置速查

| 现象 | 原因 | 处置 |
|---|---|---|
| 请求无 Authorization 头 | 用户未登录 / 宿主换票失败（降级不发票） | 401 照回；agent 会把失败如实呈现给用户 |
| `kid 未命中` | bbc 轮换了签名密钥 | **重拉一次 jwks** 即恢复（必须实现） |
| `aud 不含本端点` | 串票 / 端点 URL 与 bbc 侧登记不一致 | 401；核对两边的 URL 逐字符一致 |
| `iss 不符` | issuer 配置错（http/https、端口、路径） | 核对部署配置 |
| `token 过期` | 票超 15min（agent 正常应在到期前 2min 自动续） | 401 照回；连续出现说明 agent 侧续签异常 |

## 6. 与「自己发 key」模式的对比（为什么这是更好的生态契约）

| | 传统 API key | bbc 统一身份（本方案） |
|---|---|---|
| 应用侧发放/存储 key | 要（逐用户） | **不要** |
| 密钥泄漏面 | 每用户一把 key，泄漏即冒用 | 公钥公开无风险；伪造需 bbc 私钥 |
| 用户换密/离职 | 逐个吊销 key | 15min 自然死亡，零操作 |
| 审计 | 应用自行约定 | `sub`+`act` 双写口径（与 bbc 内部一致） |
| 接入工作量 | 发 key + 查表 | **一个验签中间件** |

**安全边界与诚实话**：本地验签覆盖「签发真/未过期/目的地真」，不覆盖「签发后被
吊销」——登出/停用后的票最多再有效 15 分钟（短 TTL 是吊销兜底）。需要实时吊销的
极少数应用可自行维护 `jti` 黑名单，或将来接入 bbc 的 introspection（可选增强，
[D38 §10-1](detail/D38-统一身份票据与生态MCP验签设计.md)）。

---

变更与运维侧（管理员视角）：插件打包规则（url 只许写死、`x-bbc-auth` 声明）、
受众格式闸与错误码 1015、验收清单见 [D38](detail/D38-统一身份票据与生态MCP验签设计.md)。
