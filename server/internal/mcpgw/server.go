// 接入层：单端点 JSON-RPC 2.0 over HTTP POST（无会话态——每次请求独立验签，
// 与 bbrt-mcp「连接生命周期与宿主进程一致、身份逐请求传播」的口径对齐）。
package mcpgw

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/baobaowork/server/internal/platform/authjwt"
)

// ServerName serverInfo.name（bbrt-mcp 诊断/健康面板展示；命名空间段 corp 由
// Runtime 侧配置决定，工具全名约定 mcp.corp.kb_query）
const ServerName = "bbw-corp"

// Gateway MCP HTTP 接入层
type Gateway struct {
	opts Options
}

// jsonrpcFrame 请求帧（通知无 id）
type jsonrpcFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// HandleMCP POST /mcp/corp：鉴权（② 主体层）→ 分发 → 审计（③ 归因层）
func (g *Gateway) HandleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// 32MB：file_upload 的 content_b64 通道（20MB 文件 b64 后 ~27MB 文本）；
	// 其余工具 params 远小于此，不构成放大面（网关级限流在外层 httpx.RateLimit）
	var frame jsonrpcFrame
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&frame); err != nil {
		http.Error(w, "parse error", http.StatusBadRequest)
		return
	}
	// 通知（无 id）：语义上无需回包；鉴权后静默收下（202）
	if len(frame.ID) == 0 || string(frame.ID) == "null" {
		if _, rerr := g.claims(r, frame.Params); rerr != nil {
			g.writeRPCError(w, frame.ID, rerr)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}

	claims, rerr := g.claims(r, frame.Params)
	if rerr != nil {
		g.writeRPCError(w, frame.ID, rerr)
		return
	}

	var (
		result any
		err    *rpcError
	)
	start := time.Now()
	switch frame.Method {
	case "initialize":
		result = map[string]any{
			"protocolVersion": protocolVersion(frame.Params),
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": ServerName, "version": "0.1.0"},
		}
	case "notifications/initialized":
		// 有 id 的非常规形态：按通知收下回空结果（宽容——bbrt-mcp 走无 id 通知）
		result = map[string]any{}
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = listToolsMessage()
	case "tools/call":
		result, err = g.handleCall(r, claims, frame.Params)
	default:
		err = rpcErr(codeMethodNotFound, "未知方法: "+frame.Method)
	}

	// 审计（tools/call 记全链；握手/发现不记——无数据面语义）
	if frame.Method == "tools/call" {
		// 业务失败（MCP isError 结果）对审计可见：网关受理成功 ≠ 域执行成功
		bizFail := false
		if m, ok := result.(map[string]any); ok {
			if b, _ := m["isError"].(bool); b {
				bizFail = true
			}
		}
		g.audit(r.Context(), claims, frame.Params, actOf(frame.Params, r.Header.Get("X-BBW-Act")), err, bizFail, time.Since(start))
	}

	if err != nil {
		g.writeRPCError(w, frame.ID, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(frame.ID), "result": result})
}

// handleCall tools/call：scope 校验（防线二）→ 注册表分发（防线三在域服务）
func (g *Gateway) handleCall(r *http.Request, claims *authjwt.Claims, params json.RawMessage) (any, *rpcError) {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments,omitempty"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpcErr(codeInvalidParams, "params 非法: "+err.Error())
		}
	}
	tool := findTool(p.Name)
	if tool == nil {
		return nil, rpcErr(codeUnknownTool, "未知工具: "+p.Name)
	}
	// OBO scope 最小化（09 篇防线二：scope 必须用户子集；用户本人 JWT 不查——
	// 其权限即本人权限，数据过滤在域服务）
	if claims.IsOBO() && tool.Scope != "" && !hasScope(claims.Scope, tool.Scope) {
		return nil, rpcErr(codeScopeDenied, "OBO 令牌缺少 scope: "+tool.Scope)
	}
	uid, _ := strconv.ParseInt(claims.Subject, 10, 64)
	tenant := claims.TenantID
	if tenant <= 0 {
		tenant = 1
	}
	switch p.Name {
	case "kb_query":
		res, err := g.invokeKbQuery(r.Context(), tenant, uid, p.Arguments)
		return res, err
	case "doc_read":
		res, err := g.invokeDocRead(r.Context(), tenant, uid, p.Arguments)
		return res, err
	case "im_send":
		res, err := g.invokeImSend(r.Context(), tenant, uid, p.Arguments)
		return res, err
	case "file_upload":
		res, err := g.invokeFileUpload(r.Context(), tenant, uid, p.Arguments)
		return res, err
	default:
		return nil, rpcErr(codeUnknownTool, "工具未接线: "+p.Name)
	}
}

// claims 主体身份提取（②）：Authorization: Bearer 优先（HTTP 通道），
// params._meta.bbwObo 兜底（stdio 语义身份随行——call.rs 注记的传输层差异在此吸收）
func (g *Gateway) claims(r *http.Request, params json.RawMessage) (*authjwt.Claims, *rpcError) {
	if g.opts.Verify == nil {
		return nil, rpcErr(codeUnauthorized, "网关未配置鉴权")
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer"))
	if token == "" {
		token = metaString(params, "bbwObo")
	}
	if token == "" {
		return nil, rpcErr(codeUnauthorized, "缺少主体令牌（Authorization: Bearer 或 _meta.bbwObo）")
	}
	c, err := g.opts.Verify(r.Context(), token)
	if err != nil {
		return nil, rpcErr(codeUnauthorized, "令牌验签失败: "+err.Error())
	}
	if _, perr := strconv.ParseInt(c.Subject, 10, 64); perr != nil {
		return nil, rpcErr(codeUnauthorized, "sub 非用户 uid: "+c.Subject)
	}
	return c, nil
}

// audit 审计闭包（③ 归因：act 仅记录；失败时 ErrCode 便于对账）
func (g *Gateway) audit(ctx context.Context, claims *authjwt.Claims, params json.RawMessage, act string, err *rpcError, bizFail bool, d time.Duration) {
	entry := AuditEntry{
		TenantID: claims.TenantID,
		OBO:      claims.IsOBO(),
		Act:      act,
		Duration: d.Milliseconds(),
	}
	entry.Subject, _ = strconv.ParseInt(claims.Subject, 10, 64)
	var p struct {
		Name string `json:"name"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p)
		entry.Tool = p.Name
	}
	switch {
	case err != nil:
		entry.ErrCode = strconv.Itoa(err.code)
	case bizFail:
		entry.ErrCode = "tool_error" // 域执行失败（isError 结果，原因在 content）
	default:
		entry.OK = true
	}
	if g.opts.Audit != nil {
		g.opts.Audit(ctx, entry)
		return
	}
	log.Printf("[mcpgw] tool=%s tenant=%d subject=%d obo=%v act=%s ok=%v err=%s %dms",
		entry.Tool, entry.TenantID, entry.Subject, entry.OBO, entry.Act, entry.OK, entry.ErrCode, entry.Duration)
}

// writeRPCError JSON-RPC error 回包（HTTP 200——传输层成功、方法层失败）
func (g *Gateway) writeRPCError(w http.ResponseWriter, id json.RawMessage, e *rpcError) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": e.code, "message": e.message},
	})
}

// actOf 归因身份（③）：_meta.bbwAct 优先，X-BBW-Act 头兜底（10 篇 §5）
func actOf(params json.RawMessage, headerAct string) string {
	if v := metaString(params, "bbwAct"); v != "" {
		return v
	}
	return headerAct
}

// metaString params._meta.{key} 字符串取值
func metaString(params json.RawMessage, key string) string {
	if len(params) == 0 {
		return ""
	}
	var p struct {
		Meta map[string]string `json:"_meta"`
	}
	if json.Unmarshal(params, &p) != nil {
		return ""
	}
	return p.Meta[key]
}

// hasScope scope 列表包含判定
func hasScope(scopes []string, want string) bool {
	for _, s := range scopes {
		if s == want {
			return true
		}
	}
	return false
}

// protocolVersion 宽容回声客户端请求版本（bbrt-mcp conn.rs 收下任意回报）
func protocolVersion(params json.RawMessage) string {
	if len(params) > 0 {
		var p struct {
			V string `json:"protocolVersion"`
		}
		if json.Unmarshal(params, &p) == nil && p.V != "" {
			return p.V
		}
	}
	return "2024-11-05"
}
