// Package agentbackuprepo Agent 会话云端备份索引仓储（08 篇 §5.2；memory/postgres 双实现）。
// 零知识边界（OQ-B09）：本域只见密文尺寸与密钥 envelope，事件明文永不过服务端。
package agentbackuprepo

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound 备份行不存在
var ErrNotFound = errors.New("agentbackuprepo: not found")

// ErrDuplicateIdem 同 Idempotency-Key 重复创建（service 层转为返回既有行）
var ErrDuplicateIdem = errors.New("agentbackuprepo: duplicate idempotency key")

// Row agent_session_backup 行
type Row struct {
	ID             int64
	TenantID       int64
	UserID         int64
	LocalSessionID string
	Title          string
	EncAlg         string
	KeyEnvelope    string // 端侧密钥信封 JSON（wrapped DEK；服务端不解析）
	Size           int64
	IdempotencyKey string // 空=无幂等约束
	CreatedAt      time.Time
}

// Repo 备份索引仓储接口
type Repo interface {
	// Insert 落行（IdempotencyKey 非空且同用户已存在 → ErrDuplicateIdem）
	Insert(ctx context.Context, r Row) (Row, error)
	// GetByIdempotency 幂等命中查询（无/空 key 返回 nil）
	GetByIdempotency(ctx context.Context, userID int64, key string) (*Row, error)
	// Get 行详情（越权由 service 层 tenant/user 校验）
	Get(ctx context.Context, id int64) (*Row, error)
	// ListByUser 我的备份（created_at 倒序）
	ListByUser(ctx context.Context, tenantID, userID int64) ([]Row, error)
	// Delete 删行（不存在返回 ErrNotFound）
	Delete(ctx context.Context, id int64) error
}
