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
//	   stdio 语义的 params._meta.bbcObo 同样收下），权限唯一依据；数据过滤
//	   （空间可见性）由域服务按 uid 执行（防线三 RLS）；
//	③ 归因层：act（agent:{session} / expert:{personaId}:{activationId}）——
//	   params._meta.bbcAct 或 X-BBC-Act 头，仅审计不影响权限。
//
// 工具治理属性（风险级/OBO scope/门控）权威源仍是 09 篇 §3.1 表——供给方式与
// 治理解耦：风险级经 tools/list annotations["x-bbc-risk"] 声明（客户端默认"中"），
// OBO scope 最小化在本层验签后校验（防线二），客户端九步管线 gate/审批照常执行。
//
// 工具范围（OQ-B26 试点 kb_query 已落；im_send/file_upload 治理属性
// 登记于 09 篇 §3.1，供给随本层补齐——Runtime 零改动即自动发现。
// B1 只读扩展（2026-11-23）：org_search/im_convs/im_search/doc_read/kb_spaces/
// kb_nodes/calendar_query/file_list/presences 九件——doc_read 旧文档中心域移除后
// 以 kb 域文档（D24）重新供给，同名不同源。
package mcpgw

import (
	"context"
	"encoding/json"
	"io"

	"github.com/baobaochat/server/internal/platform/authjwt"
)

// ImSearchParams 消息搜索入参（message 域 SearchParams 的 mcpgw 投影——
// 跨域不引包，装配处映射；字段语义见 messageapi.SearchParams 注释）
type ImSearchParams struct {
	Keyword string
	ConvID  int64
	FromUID int64
	Type    string
	FromTS  int64 // ms 含边界
	ToTS    int64 // ms 含边界
	Cursor  int64 // 上一页最后一条 msg_id；0=首页
	Limit   int   // ≤0 或 >100 域内取 20
}

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
	// ImSend 消息发送（message 域注入：成员资格/敏感词/频率校验在域服务）
	ImSend func(ctx context.Context, tenantID, uid, convID int64, msgType string, body json.RawMessage) (any, error)
	// ImHistory 会话历史读取（D18 §3.5 修订：agent 持 conv_id 自读上下文——含
	// agent_card 结论提炼；成员校验+行摘要在闭包内，message 域注入）
	ImHistory func(ctx context.Context, tenantID, uid, convID int64, limit int) ([]string, error)
	// FileUpload 文件上传（file 域注入：b64 已解码为流；去重/限长在域服务）
	FileUpload func(ctx context.Context, tenantID, uid int64, name, contentType string, convID int64, r io.Reader) (any, error)
	// MailRead 邮件检索/读取（mail 域注入：本人邮箱归属=防线三；22 §4.7）
	MailRead func(ctx context.Context, tenantID, uid int64, msgID int64, query, folder string, attachOnly bool, limit int) (any, error)
	// MailSend 邮件外发（mail 域注入：检查链同权；高危确认在客户端管线）
	MailSend func(ctx context.Context, tenantID, uid int64, to, cc []string, subject, body, inReplyTo string) (any, error)

	// ── B1 只读扩展（2026-11-23）：感知面九件，全部 low 风险全档自动；
	// 闭包同样跨域注入（D02 §4），数据可见性=本人/全员口径与 REST 一致 ──

	// OrgSearch 通讯录搜人（org 域注入：工号/姓名/拼音模糊；全员可见口径）
	OrgSearch func(ctx context.Context, tenantID int64, q string, limit int) (any, error)
	// ImConvs 我的会话列表（message 域注入：按成员身份聚合；query 可选名称过滤）
	ImConvs func(ctx context.Context, uid int64, query string) (any, error)
	// ImSearch 全局消息搜索（message 域注入：仅本人可见会话；SearchParams 的 mcpgw 投影）
	ImSearch func(ctx context.Context, uid int64, p ImSearchParams) (any, error)
	// DocRead KB 文档详情+全文分块（kb 域注入：meta 与 chunks 合并；空间可见性在域服务）
	DocRead func(ctx context.Context, tenantID, uid, docID int64) (any, error)
	// KbSpaces 可见空间列表（kb 域注入）
	KbSpaces func(ctx context.Context, tenantID, uid int64) (any, error)
	// KbNodes 空间目录树（kb 域注入：parentID=0 空间根）
	KbNodes func(ctx context.Context, tenantID, uid, spaceID, parentID int64) (any, error)
	// CalendarQuery 工作日历（workday 域注入：month 0=全年；装配后回填——域模块晚于本网关）
	CalendarQuery func(ctx context.Context, tenantID int64, year, month int) (any, error)
	// FileList 文件列表（file 域注入：convID=0 我的云盘，>0 会话文件）
	FileList func(ctx context.Context, tenantID, uid, convID int64) (any, error)
	// PresenceSnapshot 在线状态快照（gateway 域注入：观察者口径 invisible→offline）
	PresenceSnapshot func() map[int64]string
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
