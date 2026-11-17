// Package adminapi 管理域对外接口与 DTO（D10；D02 §3：跨模块只 import 本包）。
// 阶段取舍登记（docs/detail/D10 §1 vs 务实范围）：
//   - RBAC 阶段二已接（权限点判定闭环）：登录/续签 perms = 行内 ∪ role/user_role 聚合；
//     per-route 守卫 requirePerm（2001）；权限点字典内嵌（perms.go，D12 §2.4）经
//     GET /admin/perm-points 下发；授权/收回/角色变更推 perm.changed；
//   - 仍不做：二次验证票据/双人审批（9008/9009 路径）、导入导出/交接异步任务、
//     user_role 部门数据范围（scope 阶段一恒 1，随 D12 组织树阶段二）。
package adminapi

import (
	"context"
)

// ── 仪表盘（API-ADM-01 务实版）──

// AITodayStat 今日 AI 调用（requests/tokens）
type AITodayStat struct {
	Requests    int64 `json:"requests"`
	TotalTokens int64 `json:"total_tokens"`
}

// TrendPoint 按日趋势点（今日 AI tokens 简表）
type TrendPoint struct {
	Date        string `json:"date"`
	TotalTokens int64  `json:"total_tokens"`
}

// Dashboard 六指标聚合 + AI tokens 趋势
// （在线数=hub 连接数（含一人多端），登记；存储量=file 未软删行 size 求和）
type Dashboard struct {
	AsOf             string       `json:"as_of"`
	UsersTotal       int64        `json:"users_total"`
	OnlineNow        int64        `json:"online_now"`
	SessionsToday    int64        `json:"sessions_today"`
	MsgsToday        int64        `json:"msgs_today"`
	AIToday          AITodayStat  `json:"ai_today"`
	KBDocs           int64        `json:"kb_docs"`
	FileStorageBytes int64        `json:"file_storage_bytes"`
	AITokensTrend    []TrendPoint `json:"ai_tokens_trend"`
}

// ── 用户管理（API-ADM-06/08 务实版）──

// AdminUser 管理端用户行（ID 字符串化透出，14 篇 §5 契约）
type AdminUser struct {
	ID          string   `json:"id"`
	EmployeeNo  string   `json:"employee_no"`
	DisplayName string   `json:"display_name"`
	Email       string   `json:"email,omitempty"`
	Status      int      `json:"status"` // 1 启用 2 禁用
	Scopes      []string `json:"scopes"`
}

// UserPage 用户列表分页（cursor=末条 id；空 next_cursor=到底）
type UserPage struct {
	Items      []AdminUser `json:"items"`
	HasMore    bool        `json:"has_more"`
	NextCursor string      `json:"next_cursor"`
}

// ── 策略查看（API-ADM-14 务实版：agent 域只读）──

// AgentPolicySnapshot agent_tool_policy 快照。
// 阶段一取舍：agent_tool_policy 表未建（09 篇 DDL 随 Agent 域阶段二落地），
// PG 模式探测表存在则读、否则返回默认策略 JSON；内存模式恒默认快照（只读展示）。
type AgentPolicySnapshot struct {
	Version   int            `json:"version"`
	UpdatedAt string         `json:"updated_at"`
	Source    string         `json:"source"` // "default" | "table"
	Policy    map[string]any `json:"policy"`
	// 行级覆盖明细（source=table 时携带；编辑器数据源——D7）
	Rows []AgentToolPolicyRow `json:"rows,omitempty"`
}

// AgentToolPolicyRow agent_tool_policy 行（编辑器/写接口口径）
type AgentToolPolicyRow struct {
	Subject      string `json:"subject"`       // 工具名/命名空间（app:ns:*）
	Allowed      bool   `json:"allowed"`
	RiskOverride string `json:"risk_override"` // JSON（"{}"=矩阵默认）
	Config       string `json:"config"`        // JSON 扩展配置
	UpdatedBy    string `json:"updated_by"`
	UpdatedAt    string `json:"updated_at"`
}

// AgentToolPolicyReq PUT /admin/policies/agent/tools
type AgentToolPolicyReq struct {
	Subject      string `json:"subject"`
	Allowed      *bool  `json:"allowed"` // 指针：显式传 false 合法
	RiskOverride string `json:"risk_override"` // 空=保持；"{}"=清空覆盖
	Config       string `json:"config"`
}

// SensitiveWord 敏感词行（迁移 0006 sensitive_word）
type SensitiveWord struct {
	ID        string `json:"id"`
	Word      string `json:"word"`
	Mode      int    `json:"mode"` // 1 拦截 2 替换 3 审计（v0.1 管理端仅支持 1）
	Category  string `json:"category,omitempty"`
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"created_at"`
}

// WordPage 敏感词分页（total 为全量计数——策略页副标题用）
type WordPage struct {
	Items      []SensitiveWord `json:"items"`
	Total      int64           `json:"total"`
	HasMore    bool            `json:"has_more"`
	NextCursor string          `json:"next_cursor"`
}

// ── AI 用量（API-ADM-21 务实版）──

// UsageRow 用量原始行（repo/适配器产出：date 维已按日截断）
type UsageRow struct {
	Date             string
	Tier             string
	Scene            string
	Requests         int64
	PromptTokens     int64
	CompletionTokens int64
	TotalTokens      int64
}

// UsageDaily 按日聚合
type UsageDaily struct {
	Date             string `json:"date"`
	Requests         int64  `json:"requests"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
}

// UsageByDim 按 tier/scene 维度汇总
type UsageByDim struct {
	Key         string `json:"key"`
	Requests    int64  `json:"requests"`
	TotalTokens int64  `json:"total_tokens"`
}

// UsageSummary 用量汇总（近 N 日；日粒度表 + tier/scene 两维汇总）
type UsageSummary struct {
	AsOf    string       `json:"as_of"`
	Days    int          `json:"days"`
	Mode    string       `json:"mode"` // "pg"（ai_usage_hourly）| "memory"（Meter snapshot）
	Daily   []UsageDaily `json:"daily"`
	ByTier  []UsageByDim `json:"by_tier"`
	ByScene []UsageByDim `json:"by_scene"`
	Total   UsageDaily   `json:"total"`
}

// ── 审计日志（API-ADM-18 务实版：v0.1 落 admin_audit_action 窄表）──

// AuditItem 审计行（操作人名称经 org 域闭包解析；解析失败回退 uid 字符串）
type AuditItem struct {
	ID           string         `json:"id"`
	OperatorID   string         `json:"operator_id"`
	OperatorName string         `json:"operator_name"`
	Action       string         `json:"action"`
	Target       string         `json:"target"`
	Detail       map[string]any `json:"detail,omitempty"`
	CreatedAt    string         `json:"created_at"`
}

// AuditPage 审计分页（id 倒序时间线；cursor=末条 id）
type AuditPage struct {
	Items      []AuditItem `json:"items"`
	HasMore    bool        `json:"has_more"`
	NextCursor string      `json:"next_cursor"`
}

// AdminService 管理域服务接口（main 路由壳消费）
// RoleDTO 角色行（PAD-08 角色编辑器）
type RoleDTO struct {
	ID          int64    `json:"id,string"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Permissions []string `json:"permissions"`
	IsBuiltin   bool     `json:"is_builtin"`
	UserCount   int64    `json:"user_count"` // 授权人数
	CreatedAt   int64    `json:"created_at"` // ms
}

// GrantDTO 授权行（用户视角）
type GrantDTO struct {
	ID        int64  `json:"id,string"`
	UserID    int64  `json:"user_id,string"`
	RoleID    int64  `json:"role_id,string"`
	RoleName  string `json:"role_name"`
	CreatedAt int64  `json:"created_at"` // ms
}

// NoticeDTO 公告行（PAD-15）
type NoticeDTO struct {
	ID        int64  `json:"id,string"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	CreatedBy int64  `json:"created_by,string"`
	Reach     int    `json:"reach"`      // 广播落行数（全员触达快照）
	CreatedAt int64  `json:"created_at"` // ms
}

// ImportUserRow 导入输入行（empno,name,email；初始口令=工号+!BBC，首登改密阶段二接 03 篇）
type ImportUserRow struct {
	Empno string `json:"empno"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// CreateUserReq 单建用户（2026-11-12 通讯录合并页：组织树上直接开人）——
// 初始口令=工号+!BBC 首登强制改密（与批量导入同口径）；EmployeeNo 空则服务端
// 按姓名全拼自动生成（重名两位补零递增 zhangsan02，用户拍板口径）
type CreateUserReq struct {
	EmployeeNo  string `json:"employee_no,omitempty"` // 空串=自动生成建议值
	DisplayName string `json:"display_name"`
	Email       string `json:"email,omitempty"`
	DeptID      int64  `json:"dept_id,omitempty"` // >0 建成即挂该部门并标主部门
	RoleID      int64  `json:"role_id,omitempty"` // >0 建成即授予角色（scope=4 全租户）
}

// ImportRow 导入行结果（PAD-06）
type ImportRow struct {
	Row    int    `json:"row"` // 1 起行号（不含表头）
	Empno  string `json:"empno"`
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"` // 失败原因（工号已存在/格式非法）
}

// ImportResult 批量导入结果
type ImportResult struct {
	Created int         `json:"created"`
	Failed  int         `json:"failed"`
	Rows    []ImportRow `json:"rows"`
}

// AgentUserRow Agent 活跃用户行（PAD-14；aigw 计量按用户聚合）
type AgentUserRow struct {
	UserID   int64  `json:"user_id,string"`
	Name     string `json:"name"`
	Requests int64  `json:"requests"`  // 计量窗内请求数
	Tokens   int64  `json:"tokens"`    // prompt+completion
	Sessions int    `json:"sessions"`  // 活跃会话数（X-BBC-Agent-Session 去重）
	LastHour int64  `json:"last_hour"` // 最近开票小时（ms）
}

// KBSpaceRow KB 治理总览行（PAD-10；全量空间视角——绕过用户可见性）
type KBSpaceRow struct {
	ID         int64  `json:"id,string"`
	Type       string `json:"type"` // personal|dept|company
	Name       string `json:"name"`
	Status     string `json:"status"` // active|archived（D8 治理态）
	OwnerID    int64  `json:"owner_id,string"`
	OwnerName  string `json:"owner_name"`
	DocCount   int64  `json:"doc_count"`
	QuotaBytes int64  `json:"quota_bytes"`
	UsedBytes  int64  `json:"used_bytes"`
}

type AdminService interface {
	// ── 离职交接（PAD-07；admin:user:offboard——OQ-A06 阶段一手动触发）──
	// OffboardUser 禁用全链（状态+踢线+令牌吊销）+ 审计；群主转让/文档归属
	// 留存提示由端侧引导（阶段四接 HR 事件联动，登记）
	OffboardUser(ctx context.Context, tenantID, operatorID, userID int64) error
	// ── KB 治理（PAD-10；admin:kb:govern——v0.1 只读总览，空间停用/删除随 D07 敏感治理阶段二）──
	ListKBSpaces(ctx context.Context, tenantID int64) ([]KBSpaceRow, error)
	// SetKBSpaceStatus KB 空间停用/启用（D8 治理；闭包转 kb 域）
	SetKBSpaceStatus(ctx context.Context, tenantID, spaceID int64, archived bool) error
	// DeleteKBSpace KB 空间删除（级联；personal 7010）
	DeleteKBSpace(ctx context.Context, tenantID, spaceID int64) error
	// ── Agent 治理（PAD-14；admin:agent:revoke / platform:agent:killswitch）──
	ListAgentUsers(ctx context.Context, tenantID int64) ([]AgentUserRow, error)
	// RevokeAgentAccess 吊销该用户 Agent 通道（OBO/refresh 全失效+踢线）
	RevokeAgentAccess(ctx context.Context, tenantID, operatorID, userID int64) error
	// AgentKillswitch 平台总闸（true=紧急停止；生效路径阶段二接 OBO 签发闸门，登记）
	AgentKillswitch(ctx context.Context, tenantID, operatorID int64, on bool) (bool, error)
	// AgentKillOn 总闸状态读（main 装配消费：auth OBO 签发 + aigw 每请求双点）
	AgentKillOn() bool
	// ── 批量导入（PAD-06；v0.1 同步 ≤100 行/次，admin_task 异步化阶段二登记）──
	BatchImportUsers(ctx context.Context, tenantID, operatorID int64, rows []ImportUserRow) (*ImportResult, error)
	// ── 单建用户（2026-11-12 通讯录合并页）──
	// CreateUser 单建（工号空=按姓名全拼自动生成；可选挂部门/授权/审计；初始口令=工号+!BBC）
	CreateUser(ctx context.Context, tenantID, operatorID int64, req CreateUserReq) (*AdminUser, error)
	// SuggestEmpno 工号建议（姓名→全拼小写；重名 zhangsan02 两位补零递增；前端预填可改）
	SuggestEmpno(ctx context.Context, tenantID int64, name string) (string, error)
	// ── 平台公告（PAD-15；admin:notice:publish）──
	PublishNotice(ctx context.Context, tenantID, operatorID int64, title, content string) (*NoticeDTO, error)
	ListNotices(ctx context.Context, tenantID int64, cursor int64, limit int) ([]NoticeDTO, bool, error)
	// ── 角色与授权（PAD-08；admin:role:manage）──
	ListRoles(ctx context.Context, tenantID int64) ([]RoleDTO, error)
	CreateRole(ctx context.Context, tenantID, operatorID int64, name, description string, permissions []string) (*RoleDTO, error)
	UpdateRole(ctx context.Context, tenantID, operatorID, roleID int64, name, description string, permissions []string) error
	DeleteRole(ctx context.Context, tenantID, operatorID, roleID int64) error
	// GrantRole 授予（D10：scope 四档透传——1 本人 2 本部门 3 本部门及以下 4 全租户；
	// 2/3 须 deptID>0；权限判定引擎按 scope 收敛随 S5 判定链接线）
	GrantRole(ctx context.Context, tenantID, operatorID, userID, roleID int64, scopeType int, scopeDeptID int64) error
	RevokeRole(ctx context.Context, tenantID, operatorID, grantID int64) error
	ListUserGrants(ctx context.Context, tenantID, userID int64) ([]GrantDTO, error)
	// IsAdmin 管理员判定 v0.2（有效权限点 admin:*/platform:* / 应急白名单；03 篇 §4）
	IsAdmin(ctx context.Context, tenantID, userID int64) bool
	// HasPerm 权限点判定（per-route 守卫：requirePerm 工厂消费；2001 拒绝前置）
	HasPerm(ctx context.Context, tenantID, userID int64, code string) bool
	// MyPermPoints 当前用户权限摘要（GET /me/permissions；perm.changed 后端侧重拉源）
	MyPermPoints(ctx context.Context, tenantID, userID int64) ([]string, error)
	// Dashboard 仪表盘聚合
	Dashboard(ctx context.Context, tenantID int64) (*Dashboard, error)
	// ListUsers 用户列表
	ListUsers(ctx context.Context, tenantID int64, keyword string, status, cursor int64, limit int) (*UserPage, error)
	// SetUserStatus 启用/禁用（禁用=踢线+吊销 refresh+审计；enable 幂等恢复）
	SetUserStatus(ctx context.Context, tenantID, operatorID, targetUserID int64, status int) (*AdminUser, error)
	// AgentPolicy agent 工具策略只读快照
	AgentPolicy(ctx context.Context, tenantID int64) (*AgentPolicySnapshot, error)
	// UpdateAgentToolPolicy 行级 upsert（D7：快照 source 切 table；热更事件随 Agent 域阶段二）
	UpdateAgentToolPolicy(ctx context.Context, tenantID, updatedBy int64, req AgentToolPolicyReq) (*AgentPolicySnapshot, error)
	// DeleteAgentToolPolicy 删行回落默认（subject 不存在 9002）
	DeleteAgentToolPolicy(ctx context.Context, tenantID int64, subject string) (*AgentPolicySnapshot, error)
	// ListSensitiveWords 敏感词分页
	ListSensitiveWords(ctx context.Context, tenantID int64, cursor, limit int64) (*WordPage, error)
	// AddSensitiveWord 新增敏感词（默认 mode=1 拦截；UK 冲突→9001）+审计
	AddSensitiveWord(ctx context.Context, tenantID, operatorID int64, word, category string) (*SensitiveWord, error)
	// DeleteSensitiveWord 删除敏感词 + 审计
	DeleteSensitiveWord(ctx context.Context, tenantID, operatorID, id int64) error
	// UsageSummary 用量汇总（days 缺省 7，上限 30）
	UsageSummary(ctx context.Context, tenantID int64, days int) (*UsageSummary, error)
	// ListAudit 审计时间线
	ListAudit(ctx context.Context, tenantID int64, cursor, limit int64) (*AuditPage, error)
}
