// Package adminrepo 管理域数据访问（D10 阶段一务实版；唯一允许写 SQL 的层——D02 §3）。
// 两块存储：审计动作（迁移 0010 admin_audit_action）+ 敏感词（迁移 0006 sensitive_word，
// 0006 建表本迁移域消费——阶段一 04 篇 §7.3 词库热更通道由本包承担）。
package adminrepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/baobaochat/server/internal/admin/api"
)

// sentinel 错误（service 层映射错误码）
var (
	// ErrDupWord 同租户同词已存在（UK(tenant_id,word)）
	ErrDupWord = errors.New("adminrepo: duplicate sensitive word")
	// ErrWordNotFound 敏感词不存在
	ErrWordNotFound = errors.New("adminrepo: sensitive word not found")
)

// AuditAction 审计动作行（迁移 0010 admin_audit_action 窄表）
type AuditAction struct {
	ID         int64
	TenantID   int64
	OperatorID int64
	Action     string // user.disable / user.enable / policy.sensitive_word.add|delete
	Target     string // 如 "user:10001" / "sensitive_word:12"
	Detail     json.RawMessage
	CreatedAt  time.Time
}

// SensitiveWord 敏感词行（迁移 0006 sensitive_word）
type SensitiveWord struct {
	ID        int64
	TenantID  int64
	Word      string
	Mode      int // 1 拦截 2 替换 3 审计
	Category  string
	Enabled   bool
	CreatedBy int64
	CreatedAt time.Time
}

// Repo 管理域仓储接口（内存/PG 双实现）
type Repo interface {
	// ── 审计（追加写；id 倒序时间线）──
	InsertAudit(ctx context.Context, a AuditAction) (AuditAction, error)
	// ListAudit cursor=上一页末条 id（0=首页），id 倒序；返回当页行 + has_more
	ListAudit(ctx context.Context, tenantID int64, cursor int64, limit int) ([]AuditAction, bool, error)

	// ── 敏感词（0006 表；管理端 CRUD + message 域热更源）──
	// InsertSensitiveWord UK(tenant_id,word) 冲突返回 ErrDupWord
	InsertSensitiveWord(ctx context.Context, w SensitiveWord) (SensitiveWord, error)
	// DeleteSensitiveWord 行不存在返回 ErrWordNotFound
	DeleteSensitiveWord(ctx context.Context, tenantID, id int64) error
	// ListSensitiveWords id 倒序 + cursor 翻页（v0.1 全量词量小，倒序即最新在前）
	ListSensitiveWords(ctx context.Context, tenantID int64, cursor int64, limit int) ([]SensitiveWord, bool, error)
	// CountSensitiveWords 全量计数（策略页副标题）
	CountSensitiveWords(ctx context.Context, tenantID int64) (int64, error)
	// EnabledSensitiveWords 启用且 mode=1（拦截）的词——message 域 3005 校验热更源；
	// PG 实现自带进程内缓存（写路径失效），内存实现直读
	EnabledSensitiveWords(ctx context.Context, tenantID int64) ([]string, error)
}

// UsageReader 用量读取（PG 模式：ai_usage_hourly 按日聚合；内存模式由 main 以
// aigw Meter snapshot 适配注入——admin 域不反向依赖 aigw 包，D02 §4）。
// 取舍登记：直读 aigw 域表属阶段一务实（aigw 未暴露聚合 API），阶段二换域间查询接口。
type UsageReader interface {
	// UsageRows 近 days 日（含今日）逐 (date,tier,scene) 行
	UsageRows(ctx context.Context, tenantID int64, days int) ([]adminapi.UsageRow, error)
}

// ── 角色与授权（0001 role/user_role 表；PAD-08 角色编辑器） ──

// Role 角色行（permissions=权限点数组；is_builtin 内置不可删改）
type Role struct {
	ID          int64
	TenantID    int64
	Name        string
	Description string
	Permissions []string
	IsBuiltin   bool
	CreatedAt   time.Time
}

// UserRole 授权行（scope 四档透传——D10；缺省 4 全租户）
type UserRole struct {
	ID        int64
	TenantID  int64
	UserID    int64
	RoleID    int64
	RoleName  string // 联查冗余（列表展示）
	UserName  string // 联查冗余
	// 数据范围（0001 DDL；D10 透传：1 本人 2 本部门 3 本部门及以下 4 全租户；
	// 2/3 须 ScopeDeptID>0；缺省 4=全租户与 v0.1 行为兼容）
	ScopeType   int
	ScopeDeptID int64
	CreatedAt   time.Time
}

// RoleRepo 角色管理仓储（admin 域独立接口，同 ShareRepo/TransferRepo 惯例）
type RoleRepo interface {
	// InsertRole UK(tenant,name) 冲突返回 ErrDupRole
	InsertRole(ctx context.Context, r Role) (Role, error)
	// UpdateRole 名称/描述/权限点（is_builtin 角色仅可改 permissions）
	UpdateRole(ctx context.Context, tenantID, id int64, name, description string, permissions []string) error
	// DeleteRole is_builtin 拒绝（ErrBuiltinRole）；级联清 user_role 由调用方先行
	DeleteRole(ctx context.Context, tenantID, id int64) error
	// ListRoles 全量（角色量小不分页）
	ListRoles(ctx context.Context, tenantID int64) ([]Role, error)
	// CountRoleUsers 各角色授权人数（map[roleID]count）
	CountRoleUsers(ctx context.Context, tenantID int64) (map[int64]int64, error)
	// InsertUserRole UK 冲突返回 ErrDupGrant
	InsertUserRole(ctx context.Context, ur UserRole) error
	// DeleteUserRole 收回授权
	DeleteUserRole(ctx context.Context, tenantID, id int64) error
	// ListUserRoles 按用户（授权管理入口）；联查 role.name/users.display_name
	ListUserRoles(ctx context.Context, tenantID int64, userID int64) ([]UserRole, error)
	// GetUserRole 按授权主键查单条（收回时定位受影响用户——perm.changed 推送用）
	GetUserRole(ctx context.Context, tenantID, grantID int64) (UserRole, error)
	// UserIDsOfRole 角色全部持有者（角色权限点变更时推送 perm.changed 用）
	UserIDsOfRole(ctx context.Context, tenantID, roleID int64) ([]int64, error)
	// PermissionPointsOf 用户有效权限点 = 全部授权角色 permissions 去重并集
	// （03 篇 §4；登录 perms 拼装与守卫判定共用，RBAC 阶段二）
	PermissionPointsOf(ctx context.Context, tenantID int64, userID int64) ([]string, error)
}

// 角色域 sentinel
var (
	ErrDupRole     = errors.New("adminrepo: duplicate role name")
	ErrBuiltinRole = errors.New("adminrepo: builtin role")
	ErrDupGrant    = errors.New("adminrepo: duplicate grant")
	ErrRoleGone    = errors.New("adminrepo: role not found")
)

// ── 平台公告（PAD-15；迁移 0015） ──

// Notice 公告行
type Notice struct {
	ID        int64
	TenantID  int64
	Title     string
	Content   string
	CreatedBy int64
	Reach     int // 广播落行数快照
	CreatedAt time.Time
}

// NoticeRepo 公告仓储
type NoticeRepo interface {
	InsertNotice(ctx context.Context, n Notice) (Notice, error)
	// ListNotices id 倒序 + cursor 翻页（v0.1 公告量小）
	ListNotices(ctx context.Context, tenantID int64, cursor int64, limit int) ([]Notice, bool, error)
}

// ErrNoticeNone 公告不存在 sentinel
var ErrNoticeNone = errors.New("adminrepo: notice not found")

// ── Agent 工具策略（迁移 0028；行级 subject 粒度，09 §5.2）──

// ErrToolPolicyNotFound 工具策略行不存在（删行回落默认场景）
var ErrToolPolicyNotFound = errors.New("adminrepo: tool policy not found")

// ToolPolicy agent_tool_policy 行
type ToolPolicy struct {
	ID           int64
	TenantID     int64
	Subject      string // 工具名/命名空间（app:ns:*）
	Allowed      bool
	RiskOverride string // JSON（空对象=不覆盖矩阵默认）
	Config       string // JSON 工具级扩展配置
	UpdatedBy    int64
	UpdatedAt    time.Time
}

// ToolPolicyRepo 工具策略仓储
type ToolPolicyRepo interface {
	// UpsertToolPolicy 插入/更新（UK(tenant,subject) 冲突=覆盖 allowed/risk/config）
	UpsertToolPolicy(ctx context.Context, p ToolPolicy) (ToolPolicy, error)
	// ListToolPolicies 租户全量行（subject 序）
	ListToolPolicies(ctx context.Context, tenantID int64) ([]ToolPolicy, error)
	// DeleteToolPolicy 删行（回落默认策略；不存在 ErrNotFound）
	DeleteToolPolicy(ctx context.Context, tenantID int64, subject string) error
}
