// Package adminapi 管理域对外接口与 DTO（D10 阶段一务实版；D02 §3：跨模块只 import 本包）。
// 阶段一取舍登记（docs/detail/D10 §1 vs 务实范围）：
//   - 不做：二次验证票据/双人审批/异步任务（导入导出/交接）/角色 CRUD/部门树管理；
//   - 权限判定 v0.1：scope 含 "admin"/"admin:*" 或 empno 命中 BBW_ADMIN_ACCOUNTS 白名单
//     （正式 RBAC 权限点矩阵随阶段二 role/user_role 落地）。
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

type AdminService interface {
	// ── 角色与授权（PAD-08；admin:role:manage）──
	ListRoles(ctx context.Context, tenantID int64) ([]RoleDTO, error)
	CreateRole(ctx context.Context, tenantID, operatorID int64, name, description string, permissions []string) (*RoleDTO, error)
	UpdateRole(ctx context.Context, tenantID, operatorID, roleID int64, name, description string, permissions []string) error
	DeleteRole(ctx context.Context, tenantID, operatorID, roleID int64) error
	GrantRole(ctx context.Context, tenantID, operatorID, userID, roleID int64) error
	RevokeRole(ctx context.Context, tenantID, operatorID, grantID int64) error
	ListUserGrants(ctx context.Context, tenantID, userID int64) ([]GrantDTO, error)
	// IsAdmin 管理员判定 v0.1（scope admin:* / empno 白名单）
	IsAdmin(ctx context.Context, tenantID, userID int64) bool
	// Dashboard 仪表盘聚合
	Dashboard(ctx context.Context, tenantID int64) (*Dashboard, error)
	// ListUsers 用户列表
	ListUsers(ctx context.Context, tenantID int64, keyword string, status, cursor int64, limit int) (*UserPage, error)
	// SetUserStatus 启用/禁用（禁用=踢线+吊销 refresh+审计；enable 幂等恢复）
	SetUserStatus(ctx context.Context, tenantID, operatorID, targetUserID int64, status int) (*AdminUser, error)
	// AgentPolicy agent 工具策略只读快照
	AgentPolicy(ctx context.Context, tenantID int64) (*AgentPolicySnapshot, error)
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
