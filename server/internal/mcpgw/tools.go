// 工具注册表（治理属性权威源=09 篇 §3.1 表；此处只做供给声明与参数校验）。
// 新增公司域能力 = 本表加一行 + Options 加一个闭包（Runtime 零改动，D14 §6.1）。
package mcpgw

import (
	"bytes"
	"context"
	"encoding/base64"
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

// corpTools 注册表（试点 kb_query——OQ-B26 裁决；im_send/file_upload
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
			// 09 篇 §3.2.6：外发不可撤回影响他人 → 全模式确认（永不全自动）——
			// 门控在客户端九步管线（high→CorpWrite），服务端只做成员资格校验（域服务 3001）
			Name:        "im_send",
			Description: "以发起用户身份发送消息到会话（text 或 agent_card）。高风险：外发影响他人且不可撤回；广播群目标会醒目提示。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"conv_id":  map[string]any{"type": "integer", "description": "目标会话 ID（必填）"},
					"msg_type": map[string]any{"type": "string", "enum": []string{"text", "agent_card"}, "description": "消息类型"},
					"text":     map[string]any{"type": "string", "description": "msg_type=text 时的正文（≤5000 字）"},
					"card":     map[string]any{"type": "object", "description": "msg_type=agent_card 时的卡片体（08 篇）"},
				},
				"required": []string{"conv_id", "msg_type"},
			},
			Risk:  "high",
			Scope: "im:message:send",
		},
		{
			// D18 §3.5（2026-11-10 修订）：agent 上下文自读通道——升级/继续不搬
			// 运卡片内容，agent 持 conv_id 自行读取会话记录（含此前 agent_card
			// 结论）。低风险只读；成员校验在闭包（防线三）
			Name:        "im_history",
			Description: "读取会话最近消息（自读上下文：了解群聊讨论与此前 Agent 回答）。返回按时间升序的摘要行数组；agent_card 提炼为【Agent】结论。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"conv_id": map[string]any{"type": "integer", "description": "会话 ID（必填）"},
					"limit":   map[string]any{"type": "integer", "description": "条数（默认 50，≤100）"},
				},
				"required": []string{"conv_id"},
			},
			Risk:  "low",
			Scope: "",
		},
		{
			// 22 篇 §4.7 mail.read：低风险全模式自动；仅本人邮箱（共享邮箱
			// ACL 随 resource_acl 接入扩展）；列表摘要瘦身防全文灌上下文
			Name:        "mail_read",
			Description: "检索/读取本人邮箱邮件（22 篇 Agent 邮件工具）。msg_id 空且 query 空=按文件夹列未读优先摘要；query 非空=全文检索（主题/发件人/摘要）；msg_id 非空=单封详情（含正文）。共享邮箱随 ACL 授权扩展。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"msg_id":      map[string]any{"type": "integer", "description": "单封详情（优先生效）"},
					"query":       map[string]any{"type": "string", "description": "检索词（≤256 字；空=列表）"},
					"folder":      map[string]any{"type": "string", "enum": []string{"inbox", "sent", "drafts", "trash", "junk", "archive"}, "description": "列表文件夹（默认 inbox）"},
					"attach_only": map[string]any{"type": "boolean", "description": "仅带附件"},
					"limit":       map[string]any{"type": "integer", "description": "条数（默认 10，≤50）"},
				},
			},
			Risk:  "low",
			Scope: "mail:agent_tool",
		},
		{
			// 22 篇 §4.7 mail.send：高危永不全自动（外发影响他人不可撤回，
			// 09 篇矩阵逐次人工确认——Agent 通道不放宽敏感词/外域/限流/配额）
			Name:        "mail_send",
			Description: "以发起用户身份发送邮件（22 篇 Agent 邮件工具）。高风险：外发影响他人且不可撤回；内网域仅本域收件；外发检查链（敏感词/频率/配额）与人工发送同权生效。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"to":          map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "收件人地址集（必填）"},
					"cc":          map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "抄送"},
					"subject":     map[string]any{"type": "string", "description": "主题（≤255 字）"},
					"body":        map[string]any{"type": "string", "description": "正文（≤1MB）"},
					"in_reply_to": map[string]any{"type": "string", "description": "回复关联 message_id（可选）"},
				},
				"required": []string{"to", "subject", "body"},
			},
			Risk:  "high",
			Scope: "mail:agent_tool",
		},
		{
			// 09 篇 §3.2.7：外传工作区文件 → ask/auto-edit 确认（medium）；
			// 内容经 b64 随调用上送（Runtime 读本地文件），存储/去重/票据归 file 域
			Name:        "file_upload",
			Description: "上传文件到云盘或会话（以发起用户身份持有）。返回 file_id 与下载票据句柄；单文件 ≤20MB。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"filename":     map[string]any{"type": "string", "description": "文件名（必填，含扩展名）"},
					"content_b64":  map[string]any{"type": "string", "description": "文件内容 base64（必填；b64 后体积计入请求上限）"},
					"content_type": map[string]any{"type": "string", "description": "MIME 类型（缺省按扩展名推断）"},
					"conv_id":      map[string]any{"type": "integer", "description": "关联会话（0/缺省=仅云盘）"},
				},
				"required": []string{"filename", "content_b64"},
			},
			Risk:  "medium",
			Scope: "file:upload",
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

// invokeImSend im_send 执行：成员资格/敏感词/频率校验在 message 域服务（防线三）
func (g *Gateway) invokeImSend(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		ConvID  int64           `json:"conv_id"`
		MsgType string          `json:"msg_type"`
		Text    string          `json:"text"`
		Card    json.RawMessage `json:"card"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.ConvID <= 0 {
		return nil, rpcErr(codeInvalidParams, "conv_id 必填")
	}
	var body json.RawMessage
	switch args.MsgType {
	case "text":
		if args.Text == "" {
			return nil, rpcErr(codeInvalidParams, "msg_type=text 需 text")
		}
		body, _ = json.Marshal(map[string]string{"text": args.Text})
	case "agent_card":
		if len(args.Card) == 0 {
			return nil, rpcErr(codeInvalidParams, "msg_type=agent_card 需 card")
		}
		body = args.Card
	default:
		return nil, rpcErr(codeInvalidParams, "msg_type ∈ text|agent_card")
	}
	if g.opts.ImSend == nil {
		return nil, rpcErr(codeUnknownTool, "im_send 未装配（message 域不可用）")
	}
	res, err := g.opts.ImSend(ctx, tenantID, uid, args.ConvID, args.MsgType, body)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeImHistory im_history 执行：低风险只读；成员校验经闭包（message 域 GetConvDetail）
func (g *Gateway) invokeImHistory(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		ConvID int64 `json:"conv_id"`
		Limit  int   `json:"limit"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.ConvID <= 0 {
		return nil, rpcErr(codeInvalidParams, "conv_id 必填")
	}
	if args.Limit <= 0 {
		args.Limit = 50
	}
	if args.Limit > 100 {
		args.Limit = 100
	}
	if g.opts.ImHistory == nil {
		return nil, rpcErr(codeUnknownTool, "im_history 未装配（message 域不可用）")
	}
	lines, err := g.opts.ImHistory(ctx, tenantID, uid, args.ConvID, args.Limit)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(lines)
}

// invokeFileUpload file_upload 执行：b64 解码后交 file 域（去重/限长/票据=防线三）
func (g *Gateway) invokeFileUpload(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		Filename    string `json:"filename"`
		ContentB64  string `json:"content_b64"`
		ContentType string `json:"content_type"`
		ConvID      int64  `json:"conv_id"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.Filename == "" || len([]rune(args.Filename)) > 255 {
		return nil, rpcErr(codeInvalidParams, "filename 必填（≤255 字）")
	}
	content, derr := base64.StdEncoding.DecodeString(args.ContentB64)
	if derr != nil {
		return nil, rpcErr(codeInvalidParams, "content_b64 非法 base64: "+derr.Error())
	}
	if len(content) == 0 {
		return nil, rpcErr(codeInvalidParams, "content_b64 为空")
	}
	if g.opts.FileUpload == nil {
		return nil, rpcErr(codeUnknownTool, "file_upload 未装配（file 域不可用）")
	}
	res, err := g.opts.FileUpload(ctx, tenantID, uid, args.Filename, args.ContentType, args.ConvID, bytes.NewReader(content))
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeMailRead mail_read 执行：防线三（本人邮箱归属）在 mail 域服务
func (g *Gateway) invokeMailRead(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		MsgID      int64  `json:"msg_id"`
		Query      string `json:"query"`
		Folder     string `json:"folder"`
		AttachOnly bool   `json:"attach_only"`
		Limit      int    `json:"limit"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if len([]rune(args.Query)) > 256 {
		return nil, rpcErr(codeInvalidParams, "query ≤256 字")
	}
	if args.Limit <= 0 {
		args.Limit = 10
	}
	if args.Limit > 50 {
		return nil, rpcErr(codeInvalidParams, "limit ≤50")
	}
	if g.opts.MailRead == nil {
		return nil, rpcErr(codeUnknownTool, "mail_read 未装配（mail 域不可用）")
	}
	res, err := g.opts.MailRead(ctx, tenantID, uid, args.MsgID, args.Query, args.Folder, args.AttachOnly, args.Limit)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeMailSend mail_send 执行：检查链（敏感词/外域/限流/配额）在
// mail 域服务（22 §7 人与 Agent 同权）；高危确认在客户端九步管线
func (g *Gateway) invokeMailSend(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		To        []string `json:"to"`
		Cc        []string `json:"cc"`
		Subject   string   `json:"subject"`
		Body      string   `json:"body"`
		InReplyTo string   `json:"in_reply_to"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if len(args.To) == 0 {
		return nil, rpcErr(codeInvalidParams, "to 必填")
	}
	if len([]rune(args.Subject)) > 255 {
		return nil, rpcErr(codeInvalidParams, "subject ≤255 字")
	}
	if len([]rune(args.Body)) > 1<<20 {
		return nil, rpcErr(codeInvalidParams, "body ≤1MB")
	}
	if g.opts.MailSend == nil {
		return nil, rpcErr(codeUnknownTool, "mail_send 未装配（mail 域不可用）")
	}
	res, err := g.opts.MailSend(ctx, tenantID, uid, args.To, args.Cc, args.Subject, args.Body, args.InReplyTo)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
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
