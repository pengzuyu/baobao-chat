// perms.go —— 权限点字典（RBAC 阶段二）。
// 权威清单：D12 §2.4 + 12 篇 §6.3 admin:notice:publish + 22 篇 mail 域 2 项；
// rtc/meeting 域 5 项与 file:share:create 随 2026-11 产品瘦身二阶段移除；
// admin:user:offboard 随离职交接功能下线移除（2026-11-18，v3）。
// 服务端内嵌（D02 §10），经 GET /api/v1/admin/perm-points 下发；前端不硬编码（D10 PAD-08）。
// 新增权限点必须先在 D12 §2.4 与 03 篇 §4.1 登记（14 篇同款规则）。
package adminapi

// PermPoint 权限点条目
type PermPoint struct {
	Code   string `json:"code"`
	Domain string `json:"domain"`
	Desc   string `json:"desc"`
}

// PermGroup 按域分组（PAD-08 权限点树第一层）
type PermGroup struct {
	Domain string      `json:"domain"`
	Label  string      `json:"label"`
	Points []PermPoint `json:"points"`
}

// PermPointsDoc 字典文档（GET /admin/perm-points 响应体）
type PermPointsDoc struct {
	Version int         `json:"version"` // 字典版本（点集变更时 +1）
	Total   int         `json:"total"`
	Groups  []PermGroup `json:"groups"`
}

// permDictionary 权威字典（域顺序同 03 篇 §4.1）
var permDictionary = []PermGroup{
	{"im", "即时通讯", []PermPoint{
		{"im:message:send", "im", "发消息"},
		{"im:group:create", "im", "建群"},
		{"im:group:manage", "im", "群管理（改名/成员/解散）"},
		{"im:message:recall_any", "im", "撤回他人消息"},
		{"im:group:create_broadcast", "im", "创建全员/部门广播群"},
		{"im:broadcast:publish", "im", "广播群发帖（publisher）"},
	}},
	{"file", "文件", []PermPoint{
		{"file:upload", "file", "上传文件"},
		{"file:manage_all", "file", "管理全域文件"},
	}},
	{"kb", "知识库", []PermPoint{
		{"kb:space:create", "kb", "创建空间"},
		{"kb:space:admin", "kb", "空间管理"},
		{"kb:doc:contribute", "kb", "投稿文档"},
		{"kb:query:use", "kb", "检索使用"},
		{"kb:doc:delete", "kb", "删除文档"},
		{"kb:doc:sensitive", "kb", "敏感标记"},
		{"kb:space:audit:read", "kb", "空间审计查看"},
		{"kb:crawl:manage", "kb", "采集源管理（阶段四预留）"},
	}},
	{"agent", "智能体", []PermPoint{
		{"agent:session:use", "agent", "使用 Agent 会话"},
		{"agent:tool:run_command", "agent", "执行命令工具"},
		{"agent:mode:full_auto", "agent", "全自动模式"},
		{"agent:app:install", "agent", "安装生态应用"},
		{"agent:delegate:use", "agent", "使用本地委派（D17）"},
	}},
	{"mail", "邮件", []PermPoint{
		{"mail:use", "mail", "使用邮箱（22 篇）"},
		{"mail:agent_tool", "mail", "Agent 邮件工具（默认关，22 篇）"},
	}},
	{"admin", "租户管理", []PermPoint{
		{"admin:org:manage", "admin", "组织树维护"},
		{"admin:user:manage", "admin", "用户生命周期（新建/禁用/导入）"},
		{"admin:role:manage", "admin", "角色 CRUD/编辑器"},
		{"admin:role:assign", "admin", "成员授权/收回"},
		{"admin:app:publish", "admin", "应用发布/下架"},
		{"admin:policy:manage", "admin", "安全/合规策略"},
		{"admin:audit:read", "admin", "审计检索"},
		{"admin:audit:export", "admin", "审计导出"},
		{"admin:usage:read", "admin", "用量与配额查看"},
		{"admin:kb:govern", "admin", "知识库治理"},
		{"admin:agent:revoke", "admin", "吊销 Agent 会话"},
		{"admin:notice:publish", "admin", "租户公告发布（12 篇 §6.3）"},
		{"admin:mail:govern", "admin", "邮件域治理（22 篇）"},
	}},
	{"platform", "平台运营", []PermPoint{
		{"platform:tenant:manage", "platform", "租户生命周期"},
		{"platform:quota:manage", "platform", "套餐配额"},
		{"platform:monitor:read", "platform", "平台监控"},
		{"platform:agent:killswitch", "platform", "Agent 全局总闸"},
	}},
}

var (
	permIndex    map[string]struct{}
	permDocTotal int
)

func init() {
	permIndex = map[string]struct{}{}
	for _, g := range permDictionary {
		for _, p := range g.Points {
			permIndex[p.Code] = struct{}{}
		}
		permDocTotal += len(g.Points)
	}
}

// PermPoints 字典文档（只读快照；version 随字典内容演进手动 +1；
// v3=2026-11-18 删 admin:user:offboard——离职交接功能整域下线）
func PermPoints() PermPointsDoc {
	return PermPointsDoc{Version: 3, Total: permDocTotal, Groups: permDictionary}
}

// KnownPermPoint 权限点是否在权威字典内（角色保存校验用）
func KnownPermPoint(code string) bool {
	_, ok := permIndex[code]
	return ok
}
