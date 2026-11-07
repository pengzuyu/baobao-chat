// Package adminrepo 管理域数据访问（D10 阶段一务实版；唯一允许写 SQL 的层——D02 §3）。
// 两块存储：审计动作（迁移 0010 admin_audit_action）+ 敏感词（迁移 0006 sensitive_word，
// 0006 建表本迁移域消费——阶段一 04 篇 §7.3 词库热更通道由本包承担）。
package adminrepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/baobaowork/server/internal/admin/api"
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
