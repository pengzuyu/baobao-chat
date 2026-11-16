// AI 供应商 REST（0023 表驱动多供应商；19 篇 §6.5 蓝图的 v0.1 子集）：
// 管理端 /api/v1/admin/ai/*（requirePerm admin:policy:manage）：
//
//	provider CRUD + 探活（probe=调上游 /models，兼"拉取模型清单"）+ fast/strong 默认路由 PUT；
//
// 用户端 /api/v1/me/ai/*（authed）：个人 BYOK CRUD + 探活；/api/v1/ai/providers/shared 公司级只读。
// me/settings（users.settings JSONB，0023 新列）：通用个人设置，首个消费者 ai_default 默认模型。
package main

import (
	"encoding/json"
	"net/http"

	"github.com/baobaochat/server/internal/aigw"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/httpx"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ── 供应商 CRUD（管理端 owner=公司级；用户端 owner=本人）──

func handleAIProviderList(reg *aigw.Registry, scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		list, err := reg.ListProviders(r.Context(), scope, uid)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": list})
	}
}

func handleAIProviderCreate(reg *aigw.Registry, personal bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var in aigw.ProviderInput
		if err := decodeJSON(r, &in); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		owner := int64(0) // 管理端=公司级
		if personal {
			owner = uid
		}
		dto, err := reg.CreateProvider(r.Context(), in, httpx.TenantID(r.Context()), owner)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, dto)
	}
}

func handleAIProviderUpdate(reg *aigw.Registry, personal bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if personal {
			if err := requireOwnedProvider(r, reg, uid, id); err != nil {
				httpx.Fail(w, r, err)
				return
			}
		}
		var in aigw.ProviderInput
		if err := decodeJSON(r, &in); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		dto, err := reg.UpdateProvider(r.Context(), id, in)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, dto)
	}
}

func handleAIProviderDelete(reg *aigw.Registry, personal bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if personal {
			if err := requireOwnedProvider(r, reg, uid, id); err != nil {
				httpx.Fail(w, r, err)
				return
			}
		}
		if err := reg.DeleteProvider(r.Context(), id); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"deleted": true})
	}
}

// ── 探活（表单"测试连通"用 Raw（未落库的 base/key）；已建用 ByID）──

type aiProbeReq struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
}

func handleAIProviderProbeRaw() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req aiProbeReq
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		ids, err := aigw.ProbeRaw(r.Context(), req.BaseURL, req.APIKey)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"models": ids})
	}
}

func handleAIProviderProbeByID(reg *aigw.Registry, personal bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		id, err := pathID(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if personal {
			if err := requireOwnedProvider(r, reg, uid, id); err != nil {
				httpx.Fail(w, r, err)
				return
			}
		}
		ids, err := reg.ProbeByID(r.Context(), id)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"models": ids})
	}
}

// ── 默认路由（fast/strong 主备）──

func handleAIRoutesGet(reg *aigw.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		routes, err := reg.GetRoutes(r.Context())
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": routes})
	}
}

func handleAIRoutesPut(reg *aigw.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var req struct {
			Items []aigw.RouteRuleDTO `json:"items"`
		}
		if err := decodeJSON(r, &req); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if err := reg.PutRoutes(r.Context(), req.Items, httpx.TenantID(r.Context()), uid); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		routes, err := reg.GetRoutes(r.Context())
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.OK(w, r, map[string]any{"items": routes})
	}
}

// ── me/settings（users.settings JSONB；PATCH 顶层浅合并）──

func handleMeSettingsGet(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var settings json.RawMessage
		if err := pool.QueryRow(r.Context(), `SELECT settings FROM users WHERE id=$1`, uid).Scan(&settings); err != nil {
			httpx.Fail(w, r, errx.New(errx.CodeInternal, "读取设置失败"))
			return
		}
		httpx.OK(w, r, settings) // RawMessage 原样嵌入 data
	}
}

func handleMeSettingsPatch(pool *pgxpool.Pool, reg *aigw.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := uidFrom(r)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var patch map[string]json.RawMessage
		if err := decodeJSON(r, &patch); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		// ai_default 键带语义校验（mode=provider 时走 p: 解析链验证供应商/清单归属）
		if raw, ok := patch["ai_default"]; ok {
			var d struct {
				Mode       string `json:"mode"` // org=跟随公司默认 | provider=指定
				ProviderID int64  `json:"providerId"`
				Model      string `json:"model"`
			}
			if err := json.Unmarshal(raw, &d); err != nil {
				httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "ai_default 格式非法"))
				return
			}
			switch d.Mode {
			case "org":
				// 跟随公司默认：清为标记形态
				norm, _ := json.Marshal(map[string]string{"mode": "org"})
				patch["ai_default"] = norm
			case "provider":
				if d.ProviderID <= 0 || d.Model == "" {
					httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "ai_default.providerId/model 必填"))
					return
				}
				if err := reg.ValidateChoice(httpx.TenantID(r.Context()), uid, d.ProviderID, d.Model); err != nil {
					httpx.Fail(w, r, err)
					return
				}
				norm, _ := json.Marshal(map[string]any{"mode": "provider", "providerId": d.ProviderID, "model": d.Model})
				patch["ai_default"] = norm
			default:
				httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "ai_default.mode 仅 org/provider"))
				return
			}
		}
		merged, _ := json.Marshal(patch)
		tag, err := pool.Exec(r.Context(),
			`UPDATE users SET settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb WHERE id=$1`, uid, string(merged))
		if err != nil || tag.RowsAffected() == 0 {
			httpx.Fail(w, r, errx.New(errx.CodeInternal, "保存设置失败"))
			return
		}
		httpx.OK(w, r, map[string]any{"ok": true})
	}
}

// ── 小工具 ──

// requireOwnedProvider 个人通道归属校验：仅 owner 本人可改/删/探活自己的 provider
func requireOwnedProvider(r *http.Request, reg *aigw.Registry, uid, id int64) error {
	p, err := reg.GetProvider(r.Context(), id)
	if err != nil {
		return err
	}
	if p.OwnerID == nil || *p.OwnerID != uid {
		return errx.New(errx.CodePermScopeInsufficient, "仅供应商所有者可操作")
	}
	return nil
}
