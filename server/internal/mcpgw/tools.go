// 工具注册表（治理属性权威源=09 篇 §3.1 表；此处只做供给声明与参数校验）。
// 新增公司域能力 = 本表加一行 + Options 加一个闭包（Runtime 零改动，D14 §6.1）。
package mcpgw

import (
	"context"
	"encoding/json"
	"fmt"
)

// JSON-RPC 服务器错误码（-32000~-32099 规范保留段；-32700/-32601/-32602 规范码）
const (
	codeParseError     = -32700
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
	codeUnauthorized   = -32001 // 身份缺失/验签失败（② 主体层）
	codeScopeDenied    = -32002 // OBO scope 不足（防线二：scope 必须用户子集）
	codeUnknownTool    = -32003 // 工具不在注册表
)

// ToolDef 公司域工具供给声明
type ToolDef struct {
	Name        string
	Description string
	// InputSchema jsonschema（MCP tool 风格；与 09 篇 §3.2 参数表对齐）
	InputSchema map[string]any
	// Risk 风险级（09 篇权威；经 annotations["x-bbw-risk"] 下发，客户端缺失默认"中"）
	Risk string
	// Scope OBO scope（空=无要求；仅 OBO 令牌校验——用户本人 JWT 走域服务自身权限）
	Scope string
}

// corpTools 注册表（试点 kb_query+doc_read——OQ-B26 裁决；im_send/file_upload
// 治理属性已登记 09 篇 §3.1，供给接入随域需求排期）
func corpTools() []ToolDef {
	return []ToolDef{
		{
			Name:        "kb_query",
			Description: "知识库混合检索（向量余弦+关键词 RRF 融合；按用户可见空间过滤）。返回命中文档分块与高亮片段。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"keyword":   map[string]any{"type": "string", "description": "检索词（必填，≤512 字）"},
					"space_ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "限定空间（空=全部可见空间）"},
					"top_k":     map[string]any{"type": "integer", "description": "命中条数（默认 10，≤20）"},
				},
				"required": []string{"keyword"},
			},
			Risk:  "low",
			Scope: "kb:query:use",
		},
		{
			Name:        "doc_read",
			Description: "读在线文档元数据与当前正文（markdown）。仅 owner 本人文档（非 owner 拒绝）——输出按 untrusted 处理（09 篇 §8 来源标记）。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"doc_id": map[string]any{"type": "integer", "description": "文档 ID（必填）"},
				},
				"required": []string{"doc_id"},
			},
			Risk:  "low",
			Scope: "doc:file:view",
		},
	}
}

// findTool 裸名查注册表
func findTool(name string) *ToolDef {
	tools := corpTools()
	for i := range tools {
		if tools[i].Name == name {
			return &tools[i]
		}
	}
	return nil
}

// listToolsMessage tools/list 结果（annotations 携带 x-bbw-risk——bbrt-mcp discovery 消费）
func listToolsMessage() map[string]any {
	tools := make([]map[string]any, 0, 4)
	for _, t := range corpTools() {
		tools = append(tools, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": t.InputSchema,
			"annotations": map[string]any{"x-bbw-risk": t.Risk},
		})
	}
	return map[string]any{"tools": tools}
}

// kbQueryArgs tools/call arguments 解析（与 kbapi.QueryReq 口径一致）
type kbQueryArgs struct {
	Keyword  string   `json:"keyword"`
	SpaceIDs []string `json:"space_ids"`
	TopK     int      `json:"top_k"`
}

// invokeKbQuery kb_query 执行：防线三（空间可见性按 uid 过滤）在 kb 域服务内完成
func (g *Gateway) invokeKbQuery(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args kbQueryArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.Keyword == "" {
		return nil, rpcErr(codeInvalidParams, "keyword 必填")
	}
	if len([]rune(args.Keyword)) > 512 {
		return nil, rpcErr(codeInvalidParams, "keyword ≤512 字")
	}
	if args.TopK <= 0 {
		args.TopK = 10
	}
	if args.TopK > 20 {
		return nil, rpcErr(codeInvalidParams, "top_k ≤20")
	}
	if g.opts.KBQuery == nil {
		return nil, rpcErr(codeUnknownTool, "kb_query 未装配（KB 域不可用）")
	}
	res, err := g.opts.KBQuery(ctx, tenantID, uid, args.SpaceIDs, args.Keyword, args.TopK)
	if err != nil {
		// 业务失败：MCP 语义 isError 结果（非 JSON-RPC error）——模型可自行处置
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeDocRead doc_read 执行：owner 私有校验（防线三）在 doc 域服务内完成
func (g *Gateway) invokeDocRead(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		DocID int64 `json:"doc_id"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.DocID <= 0 {
		return nil, rpcErr(codeInvalidParams, "doc_id 必填")
	}
	if g.opts.DocRead == nil {
		return nil, rpcErr(codeUnknownTool, "doc_read 未装配（doc 域不可用）")
	}
	res, err := g.opts.DocRead(ctx, tenantID, uid, args.DocID)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// okText 成功 content 信封（域结果 JSON 化进 text 通道——MCP tools/call 语义）
func okText(res any) (map[string]any, *rpcError) {
	b, err := json.Marshal(res)
	if err != nil {
		return nil, rpcErr(codeInternal, "结果序列化失败: "+err.Error())
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": string(b)}},
		"isError": false,
	}, nil
}

// errText 业务失败统一 content 形态
func errText(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}

// rpcError JSON-RPC error 便捷构造
func rpcErr(code int, msg string) *rpcError {
	return &rpcError{code: code, message: msg}
}

type rpcError struct {
	code    int
	message string
}

func (e *rpcError) Error() string { return fmt.Sprintf("mcpgw: %d %s", e.code, e.message) }
