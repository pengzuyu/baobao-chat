// 工具注册表（治理属性权威源=09 篇 §3.1 表；此处只做供给声明与参数校验）。
// 新增公司域能力 = 本表加一行 + Options 加一个闭包（Runtime 零改动，D14 §6.1）。
package mcpgw

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"
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
	// Risk 风险级（09 篇权威；经 annotations["x-bbc-risk"] 下发，客户端缺失默认"中"）
	Risk string
	// Scope OBO scope（空=无要求；仅 OBO 令牌校验——用户本人 JWT 走域服务自身权限）
	Scope string
}

// trialGatedKbTools 2026-11-26 全员试用收口：知识库四件工具随知识库域整域「敬请期待」
// 暂不对 Agent 开放——tools/list 不广播、tools/call 经 findTool 拦为未知工具；
// 注册表定义与执行闭包原样保留，恢复=清空本集合。
var trialGatedKbTools = map[string]bool{
	"kb_query":  true,
	"doc_read":  true,
	"kb_spaces": true,
	"kb_nodes":  true,
}

// corpTools 注册表（试点 kb_query——OQ-B26 裁决；im_send/file_upload
// 治理属性已登记 09 篇 §3.1，供给接入随域需求排期）
func corpTools() []ToolDef {
	all := []ToolDef{
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
			// B2（2026-11-23）：msg_type 扩 file——云盘文件发到会话（file_share 并入
			// 本工具，file 归属/未删校验走域 FileCheck 同链）
			Name:        "im_send",
			Description: "以发起用户身份发送消息到会话（text / agent_card / file）。file=把我的云盘文件发到会话（file_id 从 file_list 取）。高风险：外发影响他人且不可撤回；广播群目标会醒目提示。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"conv_id":  map[string]any{"type": "integer", "description": "目标会话 ID（必填）"},
					"msg_type": map[string]any{"type": "string", "enum": []string{"text", "agent_card", "file"}, "description": "消息类型"},
					"text":     map[string]any{"type": "string", "description": "msg_type=text 时的正文（≤5000 字）"},
					"card":     map[string]any{"type": "object", "description": "msg_type=agent_card 时的卡片体（08 篇）"},
					"file_id":  map[string]any{"type": "integer", "description": "msg_type=file 时的云盘文件 ID（必填）"},
					"name":     map[string]any{"type": "string", "description": "msg_type=file 时的展示文件名（可选，缺省 file）"},
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

		// ── B1 只读扩展（2026-11-23）：九件全 low 全档自动——把 app 感知面
		//（通讯录/会话/消息检索/KB 全文/日历/文件/在线状态）开给 Agent；
		// 数据可见性与 REST 同权（防线三在域服务按 uid 过滤）──

		{
			Name:        "org_search",
			Description: "通讯录搜人（工号/姓名/拼音全拼/首字母模糊匹配）。返回 uid、姓名、工号、部门路径——发消息前反查同事身份用。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string", "description": "检索词（必填，≤64 字）"},
					"limit": map[string]any{"type": "integer", "description": "条数（默认 20，≤50）"},
				},
				"required": []string{"query"},
			},
			Risk:  "low",
			Scope: "org:directory:read",
		},
		{
			Name:        "im_convs",
			Description: "列出我的会话（单聊含对端 uid 与姓名，群聊含成员数与最近消息摘要）。query 可选按会话名/对端名过滤——把『发给张三』解析成 conv_id 的入口。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string", "description": "按会话名/单聊对端姓名过滤（可选，≤64 字）"},
				},
			},
			Risk:  "low",
			Scope: "im:conv:read",
		},
		{
			Name:        "im_search",
			Description: "跨会话搜索我可见的历史消息（关键词 AND 过滤器）。返回命中消息摘要与所在会话。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"keyword": map[string]any{"type": "string", "description": "关键词（必填，≤64 字）"},
					"conv_id": map[string]any{"type": "integer", "description": "限定会话（可选）"},
					"from_uid": map[string]any{"type": "integer", "description": "限定发送人（可选）"},
					"type":     map[string]any{"type": "string", "description": "限定消息类型（可选，如 text）"},
					"from_ts":  map[string]any{"type": "integer", "description": "起始时间 ms 含边界（可选）"},
					"to_ts":    map[string]any{"type": "integer", "description": "截止时间 ms 含边界（可选）"},
					"cursor":   map[string]any{"type": "integer", "description": "翻页游标=上页最后一条 msg_id（可选）"},
					"limit":    map[string]any{"type": "integer", "description": "条数（默认 20，≤100）"},
				},
				"required": []string{"keyword"},
			},
			Risk:  "low",
			Scope: "im:message:search",
		},
		{
			// 09 篇 §3.1 原条目（OBO doc:file:view）兑现：旧文档中心域移除后
			// 以 kb 域文档（D24）供给——kb_query 命中后的全文读取通道
			Name:        "doc_read",
			Description: "读取知识库文档详情与全文分块（kb_query 命中后按 doc_id 取全文；空间可见性与本人一致）。",
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
		{
			Name:        "kb_spaces",
			Description: "列出我可见的知识库空间（公司库+个人库，含文档数与用量）。kb_query 定向检索前先看有哪些空间。",
			InputSchema: map[string]any{
				"type": "object",
				"properties":          map[string]any{},
				"additionalProperties": false,
			},
			Risk:  "low",
			Scope: "kb:read",
		},
		{
			Name:        "kb_nodes",
			Description: "列空间目录树（子目录+目录下文档；parent_id=0 为空间根）。浏览知识库结构定位文档。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"space_id":  map[string]any{"type": "integer", "description": "空间 ID（必填）"},
					"parent_id": map[string]any{"type": "integer", "description": "父目录 ID（0=空间根，默认 0）"},
				},
				"required": []string{"space_id"},
			},
			Risk:  "low",
			Scope: "kb:read",
		},
		{
			Name:        "calendar_query",
			Description: "查工作日历（每日工作日/休息日/节假日三态）。判断某天是否上班、安排定时任务用。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"year":  map[string]any{"type": "integer", "description": "年份（默认当前年）"},
					"month": map[string]any{"type": "integer", "description": "月份 1-12（可选，0=全年）"},
				},
			},
			Risk:  "low",
			Scope: "calendar:read",
		},
		{
			Name:        "file_list",
			Description: "列我的云盘文件或某会话的文件（名称/大小/类型/上传时间元数据；不含内容——下载走 file_upload 反向通道或前端）。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"conv_id": map[string]any{"type": "integer", "description": "会话文件（>0 生效；0/缺省=我的云盘）"},
				},
			},
			Risk:  "low",
			Scope: "file:read",
		},
		{
			Name:        "presences",
			Description: "查同事在线状态快照（online/away/busy/offline；隐身对观察者呈现 offline）。uids 可选过滤指定同事。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"uids": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "指定 uid 过滤（空=全量）"},
				},
			},
			Risk:  "low",
			Scope: "presence:read",
		},

		// ── B2 写批（2026-11-23）：agent 产出沉淀回 app；写权限校验（getSpaceFor
		// writable）在 kb 域服务=防线三；高危确认在客户端九步管线（CorpWrite）──

		{
			// D24 拍板「页面零写入 UI（API 留给 AI）」兑现：知识库写入唯一通道
			Name:        "doc_write",
			Description: "新建知识库文档（文本或 markdown 正文，同步清洗分段+嵌入）。写权限=本人可写空间；高危：写入共享知识面。编辑/重摄入走文档页或后续工具扩展。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"space_id": map[string]any{"type": "integer", "description": "目标空间 ID（必填；kb_spaces 查看）"},
					"title":    map[string]any{"type": "string", "description": "文档标题（必填，≤255 字）"},
					"content":  map[string]any{"type": "string", "description": "正文（必填；markdown 保留标题结构供分段）"},
					"format":   map[string]any{"type": "string", "enum": []string{"text", "markdown"}, "description": "正文格式（默认 text）"},
					"node_id":  map[string]any{"type": "integer", "description": "目标目录（0/缺省=空间根）"},
				},
				"required": []string{"space_id", "title", "content"},
			},
			Risk:  "high",
			Scope: "doc:file:edit",
		},

		// ── B4 严控批（2026-11-23）：群管理两件——触人面最大（拉人进共享空间），
		// high/CorpWrite 三档确认；广播群(type=3)不开放（发布权语义另归管理面）；
		// 踢人/解散/退群不开放（破坏性动作留人工）；租户开关=policy.disabled_tools ──

		{
			Name:        "group_create",
			Description: "创建群聊并成为群主（以发起用户身份；成员为发起人+指定 uid 列表）。高危：拉人进共享空间触人面最大。uid 从 org_search 反查。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":       map[string]any{"type": "string", "description": "群名（必填，≤64 字）"},
					"member_uids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "成员 uid 列表（1-499 人，发起人自动入群）"},
				},
				"required": []string{"name", "member_uids"},
			},
			Risk:  "high",
			Scope: "im:conv:manage",
		},
		{
			Name:        "group_invite",
			Description: "向已有群聊邀请成员（需发起人为群主/管理员，invite_policy 域内校验）。高危：触人面大。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"conv_id": map[string]any{"type": "integer", "description": "群聊会话 ID（必填）"},
					"uids":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "被邀请人 uid 列表（1-499）"},
				},
				"required": []string{"conv_id", "uids"},
			},
			Risk:  "high",
			Scope: "im:conv:manage",
		},
	}
	// 试用收口过滤（2026-11-26，见 trialGatedKbTools 注释）
	kept := make([]ToolDef, 0, len(all))
	for _, t := range all {
		if trialGatedKbTools[t.Name] {
			continue
		}
		kept = append(kept, t)
	}
	return kept
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

// listToolsMessage tools/list 结果（annotations 携带 x-bbc-risk——bbrt-mcp discovery 消费）
func listToolsMessage() map[string]any {
	tools := make([]map[string]any, 0, 4)
	for _, t := range corpTools() {
		tools = append(tools, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": t.InputSchema,
			"annotations": map[string]any{"x-bbc-risk": t.Risk},
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
		FileID  int64           `json:"file_id"`
		Name    string          `json:"name"`
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
	case "file":
		// B2：云盘文件发会话——file_id 必填（owner/未删校验在域 FileCheck）；
		// name 可选展示名（agent 从 file_list 已知），缺省 "file"
		if args.FileID <= 0 {
			return nil, rpcErr(codeInvalidParams, "msg_type=file 需 file_id")
		}
		if args.Name == "" {
			args.Name = "file"
		}
		if len([]rune(args.Name)) > 255 {
			return nil, rpcErr(codeInvalidParams, "name ≤255 字")
		}
		body, _ = json.Marshal(map[string]any{"file_id": args.FileID, "name": args.Name})
	default:
		return nil, rpcErr(codeInvalidParams, "msg_type ∈ text|agent_card|file")
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

// ── B1 只读九件 invoke：参数校验 → 闭包透传（防线三在域服务）──

// invokeOrgSearch org_search 执行
func (g *Gateway) invokeOrgSearch(ctx context.Context, tenantID, _ int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.Query == "" {
		return nil, rpcErr(codeInvalidParams, "query 必填")
	}
	if len([]rune(args.Query)) > 64 {
		return nil, rpcErr(codeInvalidParams, "query ≤64 字")
	}
	if args.Limit <= 0 {
		args.Limit = 20
	}
	if args.Limit > 50 {
		return nil, rpcErr(codeInvalidParams, "limit ≤50")
	}
	if g.opts.OrgSearch == nil {
		return nil, rpcErr(codeUnknownTool, "org_search 未装配（org 域不可用）")
	}
	res, err := g.opts.OrgSearch(ctx, tenantID, args.Query, args.Limit)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeImConvs im_convs 执行：query 过滤在闭包内（服务端无对应参数）
func (g *Gateway) invokeImConvs(ctx context.Context, _, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		Query string `json:"query"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if len([]rune(args.Query)) > 64 {
		return nil, rpcErr(codeInvalidParams, "query ≤64 字")
	}
	if g.opts.ImConvs == nil {
		return nil, rpcErr(codeUnknownTool, "im_convs 未装配（message 域不可用）")
	}
	res, err := g.opts.ImConvs(ctx, uid, args.Query)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeImSearch im_search 执行：SearchParams 投影透传
func (g *Gateway) invokeImSearch(ctx context.Context, _, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		Keyword string `json:"keyword"`
		ConvID  int64  `json:"conv_id"`
		FromUID int64  `json:"from_uid"`
		Type    string `json:"type"`
		FromTS  int64  `json:"from_ts"`
		ToTS    int64  `json:"to_ts"`
		Cursor  int64  `json:"cursor"`
		Limit   int    `json:"limit"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.Keyword == "" {
		return nil, rpcErr(codeInvalidParams, "keyword 必填")
	}
	if len([]rune(args.Keyword)) > 64 {
		return nil, rpcErr(codeInvalidParams, "keyword ≤64 字")
	}
	if args.Limit > 100 {
		return nil, rpcErr(codeInvalidParams, "limit ≤100")
	}
	if g.opts.ImSearch == nil {
		return nil, rpcErr(codeUnknownTool, "im_search 未装配（message 域不可用）")
	}
	res, err := g.opts.ImSearch(ctx, uid, ImSearchParams{
		Keyword: args.Keyword, ConvID: args.ConvID, FromUID: args.FromUID, Type: args.Type,
		FromTS: args.FromTS, ToTS: args.ToTS, Cursor: args.Cursor, Limit: args.Limit,
	})
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeDocRead doc_read 执行：meta+chunks 合并在闭包（kb 域）
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
		return nil, rpcErr(codeUnknownTool, "doc_read 未装配（kb 域不可用）")
	}
	res, err := g.opts.DocRead(ctx, tenantID, uid, args.DocID)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeKbSpaces kb_spaces 执行
func (g *Gateway) invokeKbSpaces(ctx context.Context, tenantID, uid int64, _ json.RawMessage) (any, *rpcError) {
	if g.opts.KbSpaces == nil {
		return nil, rpcErr(codeUnknownTool, "kb_spaces 未装配（kb 域不可用）")
	}
	res, err := g.opts.KbSpaces(ctx, tenantID, uid)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeKbNodes kb_nodes 执行
func (g *Gateway) invokeKbNodes(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		SpaceID  int64 `json:"space_id"`
		ParentID int64 `json:"parent_id"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.SpaceID <= 0 {
		return nil, rpcErr(codeInvalidParams, "space_id 必填")
	}
	if g.opts.KbNodes == nil {
		return nil, rpcErr(codeUnknownTool, "kb_nodes 未装配（kb 域不可用）")
	}
	res, err := g.opts.KbNodes(ctx, tenantID, uid, args.SpaceID, args.ParentID)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeCalendarQuery calendar_query 执行：year 缺省当前年，month 0=全年
func (g *Gateway) invokeCalendarQuery(ctx context.Context, tenantID int64, _ int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		Year  int `json:"year"`
		Month int `json:"month"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.Year <= 0 {
		args.Year = time.Now().Year()
	}
	if args.Month < 0 || args.Month > 12 {
		return nil, rpcErr(codeInvalidParams, "month ∈ 0-12")
	}
	if g.opts.CalendarQuery == nil {
		return nil, rpcErr(codeUnknownTool, "calendar_query 未装配（workday 域不可用）")
	}
	res, err := g.opts.CalendarQuery(ctx, tenantID, args.Year, args.Month)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeFileList file_list 执行：convID=0 我的云盘
func (g *Gateway) invokeFileList(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		ConvID int64 `json:"conv_id"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.ConvID < 0 {
		return nil, rpcErr(codeInvalidParams, "conv_id ≥0")
	}
	if g.opts.FileList == nil {
		return nil, rpcErr(codeUnknownTool, "file_list 未装配（file 域不可用）")
	}
	res, err := g.opts.FileList(ctx, tenantID, uid, args.ConvID)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokePresences presences 执行：uids 可选过滤；快照→观察者口径条目
func (g *Gateway) invokePresences(_ context.Context, _ int64, _ int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		IDs []int64 `json:"uids"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if len(args.IDs) > 200 {
		return nil, rpcErr(codeInvalidParams, "uids ≤200")
	}
	if g.opts.PresenceSnapshot == nil {
		return nil, rpcErr(codeUnknownTool, "presences 未装配（gateway 域不可用）")
	}
	snap := g.opts.PresenceSnapshot()
	filter := make(map[int64]bool, len(args.IDs))
	for _, id := range args.IDs {
		filter[id] = true
	}
	// 观察者口径条目（invisible→offline 在 Tracker.Snapshot 内）；uid 数值升序
	uids := make([]int64, 0, len(snap))
	for uid := range snap {
		if len(filter) > 0 && !filter[uid] {
			continue
		}
		uids = append(uids, uid)
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	items := make([]map[string]string, 0, len(uids))
	for _, uid := range uids {
		items = append(items, map[string]string{"uid": strconv.FormatInt(uid, 10), "status": snap[uid]})
	}
	return okText(map[string]any{"items": items})
}

// invokeDocWrite doc_write 执行：空间可写校验在 kb 域（getSpaceFor writable=防线三）
func (g *Gateway) invokeDocWrite(ctx context.Context, tenantID, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		SpaceID int64  `json:"space_id"`
		NodeID  int64  `json:"node_id"`
		Title   string `json:"title"`
		Content string `json:"content"`
		Format  string `json:"format"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.SpaceID <= 0 {
		return nil, rpcErr(codeInvalidParams, "space_id 必填")
	}
	if args.Title == "" || len([]rune(args.Title)) > 255 {
		return nil, rpcErr(codeInvalidParams, "title 必填（≤255 字）")
	}
	if args.Content == "" {
		return nil, rpcErr(codeInvalidParams, "content 必填")
	}
	// 工具层 1MB 上限（域内 MaxDocBytes 另有上限兜底）
	if len([]rune(args.Content)) > 1<<20 {
		return nil, rpcErr(codeInvalidParams, "content ≤1MB")
	}
	if args.Format != "" && args.Format != "text" && args.Format != "markdown" {
		return nil, rpcErr(codeInvalidParams, "format ∈ text|markdown")
	}
	if g.opts.DocWrite == nil {
		return nil, rpcErr(codeUnknownTool, "doc_write 未装配（kb 域不可用）")
	}
	res, err := g.opts.DocWrite(ctx, tenantID, uid, args.SpaceID, args.NodeID, args.Title, args.Format, args.Content)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeGroupCreate group_create 执行：type=2 普通群（发起人=owner 域内定）；
// 广播群/人数上限/重名校验在 message 域
func (g *Gateway) invokeGroupCreate(ctx context.Context, _, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		Name       string   `json:"name"`
		MemberUIDs []string `json:"member_uids"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.Name == "" || len([]rune(args.Name)) > 64 {
		return nil, rpcErr(codeInvalidParams, "name 必填（≤64 字）")
	}
	if len(args.MemberUIDs) == 0 || len(args.MemberUIDs) > 499 {
		return nil, rpcErr(codeInvalidParams, "member_uids 1-499 人")
	}
	if g.opts.GroupCreate == nil {
		return nil, rpcErr(codeUnknownTool, "group_create 未装配（message 域不可用）")
	}
	res, err := g.opts.GroupCreate(ctx, uid, args.Name, args.MemberUIDs)
	if err != nil {
		return errText(err.Error()), nil
	}
	return okText(res)
}

// invokeGroupInvite group_invite 执行：invite_policy/上限/已在会话校验在 message 域
func (g *Gateway) invokeGroupInvite(ctx context.Context, _, uid int64, raw json.RawMessage) (any, *rpcError) {
	var args struct {
		ConvID int64    `json:"conv_id"`
		UIDs   []string `json:"uids"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, rpcErr(codeInvalidParams, "arguments 非法: "+err.Error())
		}
	}
	if args.ConvID <= 0 {
		return nil, rpcErr(codeInvalidParams, "conv_id 必填")
	}
	if len(args.UIDs) == 0 || len(args.UIDs) > 499 {
		return nil, rpcErr(codeInvalidParams, "uids 1-499 人")
	}
	if g.opts.GroupInvite == nil {
		return nil, rpcErr(codeUnknownTool, "group_invite 未装配（message 域不可用）")
	}
	if err := g.opts.GroupInvite(ctx, uid, args.ConvID, args.UIDs); err != nil {
		return errText(err.Error()), nil
	}
	return okText(map[string]any{"invited": len(args.UIDs)})
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
