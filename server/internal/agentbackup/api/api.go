// Package agentbackupapi Agent 会话云端备份对外契约（08 篇 §6.3 四 API + blob 下载；
// OQ-B09 端侧加密零知识：服务端只过手密文与密钥 envelope，不解析）。
package agentbackupapi

import (
	"context"
	"time"
)

// CreatePayload POST /agent/sessions/backups
type CreatePayload struct {
	LocalSessionID string `json:"local_session_id"`
	Title          string `json:"title"`
	EncAlg         string `json:"enc_alg"`      // 端侧声明（AES-256-GCM）
	KeyEnvelope    string `json:"key_envelope"` // 密钥信封 JSON（wrapped DEK ×2：口令/恢复码）
	Data           []byte `json:"data"`         // 事件 JSONL 密文（base64 解码后字节）
}

// BackupDTO 备份行（列表/创建响应；含 envelope 供跨设备恢复取回）
type BackupDTO struct {
	ID             string `json:"id"`
	LocalSessionID string `json:"localSessionId"`
	Title          string `json:"title"`
	EncAlg         string `json:"encAlg"`
	KeyEnvelope    string `json:"keyEnvelope"`
	Size           int64  `json:"size"`
	CreatedAt      int64  `json:"createdAt"` // ms
}

// TicketDTO 恢复下载凭证（120s 一次性，07 篇 §4.3 同款口径）
type TicketDTO struct {
	Ticket    string `json:"ticket"`
	URL       string `json:"url"`
	ExpiresIn int    `json:"expires_in"` // 秒
}

// BlobResult 一次性票据消费后的密文体（ReadTicket）
type BlobResult struct {
	Row         BackupDTO
	Data        []byte
	ConsumedAt  time.Time
}

// Service 备份域服务接口（REST 壳依赖）
type Service interface {
	// Create 创建备份（幂等：同 Idempotency-Key 返回既有行）；密文落盘 + 索引行
	Create(ctx context.Context, tenantID, userID int64, p CreatePayload, idempotencyKey string) (*BackupDTO, error)
	// List 我的备份（created_at 倒序）
	List(ctx context.Context, tenantID, userID int64) ([]BackupDTO, error)
	// IssueRestoreTicket 恢复下载凭证（仅本人备份；120s 一次性）
	IssueRestoreTicket(ctx context.Context, tenantID, userID, id int64) (*TicketDTO, error)
	// ReadTicket 消费票据取密文（一次性；过期/未知名 → 9002/9004）
	ReadTicket(ctx context.Context, ticket string) (*BlobResult, error)
	// Delete 删除备份（索引行 + 盘上密文）
	Delete(ctx context.Context, tenantID, userID, id int64) error
}
