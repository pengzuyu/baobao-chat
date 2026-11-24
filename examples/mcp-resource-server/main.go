// 最小 MCP 资源服务器示例 —— D38 批7。
//
// 演示生态应用侧接入 bbc 统一身份（agent 票 ES256）的全部工作量：
// discovery 发现 jwks → 按 kid 缓存公钥 → 本地验签（alg 白名单/iss/exp/nbf/aud）
// → 按票内 sub 执行业务、act 记审计。无登记、无 key、无对 bbc 的出站依赖
// （jwks 是公开端点）。任何语言/框架（Spring Security、passport、Gin 中间件）
// 接线方式同理——填 issuer + 自己的端点 URL 即可。
//
// 运行：BBC_ISSUER=http://127.0.0.1:8080/oauth2 PORT=7081 go run .
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ── jwks 缓存（验证方全部状态：一把公钥表）───────────────────────────────────

type jwksCache struct {
	mu     sync.Mutex
	keys   map[string]*ecdsa.PublicKey // kid → 公钥
	issuer string
	client *http.Client
}

// refresh 拉一次 discovery → jwks_uri → 公钥表（启动 + kid miss 时）
func (c *jwksCache) refresh(ctx context.Context) error {
 disco := strings.TrimSuffix(c.issuer, "/") + "/.well-known/openid-configuration"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, disco, nil)
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("discovery 不可达: %w", err)
	}
	defer resp.Body.Close()
	var meta struct {
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil || meta.JWKSURI == "" {
		return fmt.Errorf("discovery 解析失败: %v", err)
	}
	req2, _ := http.NewRequestWithContext(ctx, http.MethodGet, meta.JWKSURI, nil)
	resp2, err := c.client.Do(req2)
	if err != nil {
		return fmt.Errorf("jwks 不可达: %w", err)
	}
	defer resp2.Body.Close()
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			Crv string `json:"crv"`
			X   string `json:"x"`
			Y   string `json:"y"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&set); err != nil {
		return fmt.Errorf("jwks 解析失败: %w", err)
	}
	keys := map[string]*ecdsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "EC" || k.Crv != "P-256" {
			continue
		}
		x, e1 := base64.RawURLEncoding.DecodeString(k.X)
		y, e2 := base64.RawURLEncoding.DecodeString(k.Y)
		if e1 != nil || e2 != nil {
			continue
		}
		keys[k.Kid] = &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	}
	if len(keys) == 0 {
		return errors.New("jwks 无可用 EC 公钥")
	}
	c.mu.Lock()
	c.keys = keys
	c.mu.Unlock()
	return nil
}

// keyfunc 按 header.kid 选公钥；miss → 强制重拉一次（密钥轮换自愈，D38 拍板 7）
func (c *jwksCache) keyfunc(ctx context.Context) jwt.Keyfunc {
	return func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		c.mu.Lock()
		key := c.keys[kid]
		c.mu.Unlock()
		if key != nil {
			return key, nil
		}
		if err := c.refresh(ctx); err != nil {
			return nil, fmt.Errorf("kid 未命中且 jwks 重拉失败: %w", err)
		}
		c.mu.Lock()
		key = c.keys[kid]
		c.mu.Unlock()
		if key == nil {
			return nil, errors.New("kid 未命中")
		}
		return key, nil
	}
}

// ── 验签中间件（生态应用接入的全部代码，约 30 行）───────────────────────────

type identityKey struct{}

// claims 票内字段（验签通过后注入 request context 供业务使用）
type claims struct {
	Sub   string   // 用户 uid（业务按此定位用户——权限唯一依据）
	Tenant int64   // 租户
	Act   string   // 代行主体（desktop-{did}；有值记审计——agent 调用）
	Scope []string // bbc 权限点（可选收窄；多数应用按 sub 查自身权限体系，可不消费）
}

func bbcAuth(ks *jwksCache, issuer, myAud string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		tok, err := jwt.Parse(raw, ks.keyfunc(r.Context()),
			jwt.WithValidMethods([]string{"ES256"}),            // ① 算法白名单（防 alg=none/混淆）
			jwt.WithIssuer(issuer),                              // ② 签发方精确匹配
			jwt.WithAudience(myAud),                             // ③ 受众=我的端点（串票在此被打掉）
			jwt.WithExpirationRequired(),                        // ④ 时间窗（±60s 容差）
			jwt.WithLeeway(60*time.Second),
		)
		if err != nil || !tok.Valid {
			w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
			http.Error(w, "invalid token: "+errMessage(err), http.StatusUnauthorized)
			return
		}
		mapClaims := tok.Claims.(jwt.MapClaims)
		id := claims{Sub: strClaim(mapClaims, "sub"), Tenant: numClaim(mapClaims, "tenant")}
		if act, _ := mapClaims["act"].(map[string]any); act != nil {
			id.Act, _ = act["sub"].(string)
		}
		if sc, ok := mapClaims["scope"].([]any); ok {
			for _, s := range sc {
				if v, ok := s.(string); ok {
					id.Scope = append(id.Scope, v)
				}
			}
		}
		// 审计双写口径（D38 §6.3）：subject=用户 / actor=agent（act 有值时）
		if id.Act != "" {
			log.Printf("[audit] subject=%s actor=agent:%s resource=%s", id.Sub, id.Act, r.URL.Path)
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, id)))
	})
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func strClaim(m jwt.MapClaims, k string) string {
	v, _ := m[k].(string)
	return v
}

func numClaim(m jwt.MapClaims, k string) int64 {
	f, _ := m[k].(float64)
	return int64(f)
}

// ── MCP 端点（单端点 JSON-RPC；业务按 sub 执行——这里只回显身份证明链路）────

func main() {
	issuer := env("BBC_ISSUER", "http://127.0.0.1:8080/oauth2")
	port := env("PORT", "7081")
	// 我的端点地址 = 我的受众（目的地即受众，D38 拍板 2——部署事实，无需登记）
	myAud := env("MY_AUD", "http://127.0.0.1:"+port+"/mcp")

	ks := &jwksCache{issuer: issuer, client: &http.Client{Timeout: 5 * time.Second}}
	if err := ks.refresh(context.Background()); err != nil {
		log.Fatalf("jwks 预热失败（bbc-server 未起？）: %v", err)
	}
	log.Printf("jwks 预热完成（%d 把公钥）issuer=%s aud=%s", func() int {
		ks.mu.Lock()
		defer ks.mu.Unlock()
		return len(ks.keys)
	}(), issuer, myAud)

	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Context().Value(identityKey{}).(claims)
		var req struct {
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		respond := func(result any) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		}
		switch req.Method {
		case "initialize":
			respond(map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "mcp-resource-example", "version": "0.1.0"},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "ping":
			respond(map[string]any{})
		case "tools/list":
			respond(map[string]any{"tools": []map[string]any{{
				"name":        "whoami",
				"description": "回显票内身份（证明 agent 票链路）",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			}}})
		case "tools/call":
			// 业务按 id.Sub 定位用户（权限判定在你的域内完成——票只证明「是谁」）
			respond(map[string]any{
				"content": []map[string]any{{
					"type": "text",
					"text": fmt.Sprintf("sub=%s tenant=%d act=%s scope=%v —— 验签通过，业务按 sub 执行",
						id.Sub, id.Tenant, id.Act, id.Scope),
				}},
			})
		default:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"error": map[string]any{"code": -32601, "message": "method not found: " + req.Method},
			})
		}
	})

	mux := http.NewServeMux()
	mux.Handle("POST /mcp", bbcAuth(ks, issuer, myAud, mcp)) // 全部接入=这一行包装
	log.Printf("MCP 资源服务器就绪: http://127.0.0.1:%s/mcp", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
