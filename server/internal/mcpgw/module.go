// Package mcpgw 公司域能力 MCP 网关供给层（D14 §6.1/§6.2，2026-11-07 裁决）。
//
// 服务端把公司域 API 包成 MCP server 暴露（JSON-RPC 2.0 over HTTP POST，
// 单端点无会话态——Runtime 侧 bbrt-mcp 连接期 initialize + tools/list 动态发现
// mcp.{server}.{tool}，tools/call 受控调用）。Runtime 内置工具不再硬编码公司域
// 能力（09 篇 §3.1 注记）：新增服务/旧服务加能力 = 纯服务端动作，Runtime 零改动。
//
// 三层身份（D14 §6.2）：
//
//	① 连接层：单体部署下连接即本服务，无独立互信凭证（生态外部 connector 的
//	   KMS 代持凭证为 10 篇 §5 路径 B，随 D09 落地）；
//	② 主体层：sub=用户——每请求携带 OBO/用户 JWT（Authorization: Bearer，
//	   stdio 语义的 params._meta.bbwObo 同样收下），权限唯一依据；数据过滤
//	   （空间可见性）由域服务按 uid 执行（防线三 RLS）；
//	③ 归因层：act（agent:{session} / expert:{personaId}:{activationId}）——
//	   params._meta.bbwAct 或 X-BBW-Act 头，仅审计不影响权限。
//
// 工具治理属性（风险级/OBO scope/门控）权威源仍是 09 篇 §3.1 表——供给方式与
// 治理解耦：风险级经 tools/list annotations["x-bbw-risk"] 声明（客户端默认"中"），
// OBO scope 最小化在本层验签后校验（防线二），客户端九步管线 gate/审批照常执行。
//
// 工具范围（OQ-B26 试点 kb_query+doc_read 已落；im_send/file_upload 治理属性
// 登记于 09 篇 §3.1，供给随本层补齐——Runtime 零改动即自动发现）。
package mcpgw

import (
	"context"
	"encoding/json"
	"io"

	"github.com/baobaowork/server/internal/platform/authjwt"
)

// AuditEntry MCP 工具调用审计行（D14 §6.2 审计看 ③：subject/actor 双写口径；
// v0.1 经注入闭包落日志，阶段二并入 admin_operation 哈希链——15 篇/登记）
type AuditEntry struct {
	TenantID int64
	Subject  int64  // sub=用户（uid）
	OBO      bool   // 是否 Agent 代理令牌
	Act      string // 归因身份（仅审计）
	Tool     string // 工具名（裸名，非 mcp.* 全名）
	OK       bool
	ErrCode  string // 失败时的错误码（JSON-RPC code 或域错误码）
	Duration int64  // 耗时 ms
}

// Options 装配闭包（D02 §4 跨域不引包：kb/message 等域能力经 main 装配注入）
type Options struct {
	// Verify 令牌验签（auth 域 API 注入；nil=拒绝一切——网关必须鉴权）
	Verify func(ctx context.Context, token string) (*authjwt.Claims, error)
	// KBQuery 知识库混合检索（kb 域注入：空间可见性按 uid 前置过滤=防线三）
	KBQuery func(ctx context.Context, tenantID, uid int64, spaceIDs []string, keyword string, topK int) (any, error)
	// DocRead 在线文档读取（doc 域注入：owner 私有校验在域服务=防线三）
	DocRead func(ctx context.Context, tenantID, uid, docID int64) (any, error)
	// ImSend 消息发送（message 域注入：成员资格/敏感词/频率校验在域服务）
	ImSend func(ctx context.Context, tenantID, uid, convID int64, msgType string, body json.RawMessage) (any, error)
	// FileUpload 文件上传（file 域注入：b64 已解码为流；去重/限长在域服务）
	FileUpload func(ctx context.Context, tenantID, uid int64, name, contentType string, convID int64, r io.Reader) (any, error)
	// Audit 审计闭包（nil=仅结构化日志兜底）
	Audit func(ctx context.Context, e AuditEntry)
}

// Module MCP 网关模块（D02 §3：构造注入，无全局态）
type Module struct {
	gw *Gateway
}

// NewModule 装配（main 调用；ServerName 为 serverInfo.name 与日志标识）
func NewModule(opts Options) *Module {
	return &Module{gw: &Gateway{opts: opts}}
}

// API 网关接入层（路由挂载用）
func (m *Module) API() *Gateway { return m.gw }
