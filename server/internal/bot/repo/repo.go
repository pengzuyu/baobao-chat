// 仓储接口（memory/postgres 双模装配，D02 §7）。
package botrepo

import (
	"context"
	"time"
)

// Bot 主档（20 篇 §5；停用不改删——历史消息 sender 回链）
type Bot struct {
	ID          int64
	TenantID    int64
	UserID      int64 // 关联 user.type=bot（UK）
	DeptID      int64
	Name        string
	Description string
	OwnerUserID int64
	Status      int // 1 active 2 disabled
	CreatedAt   time.Time
}

// Webhook 凭证与配置（20 篇 §5；v0.1 仅 in 方向）
type Webhook struct {
	ID            int64
	TenantID      int64
	BotID         int64
	Direction     string // in | out(阶段二)
	HookID        string // UK（in 方向 URL 组成，随机不可枚举）
	Secret        string // v0.1 明文（HMAC 验签需参与计算；KMS 信封加密登记 OQ）
	PrevSecret    string // 轮换宽限（24h 双验签）
	PrevExpiresAt time.Time
	DefaultConvID int64
	Targets       []int64
	IPAllowlist   []string
	RateLimit     int // msg/min
	Status        int
	RotatedAt     time.Time
	CreatedAt     time.Time
}

// Repo 机器人域仓储
type Repo interface {
	CreateBot(ctx context.Context, b Bot) (Bot, error)
	GetBot(ctx context.Context, tenantID, botID int64) (*Bot, error)
	// GetBotByUser 按 sender 回链（发送路径复查停用状态用）
	GetBotByUser(ctx context.Context, tenantID, userID int64) (*Bot, error)
	ListBots(ctx context.Context, tenantID int64, status int) ([]Bot, error) // status 0=全部
	UpdateBotStatus(ctx context.Context, tenantID, botID int64, status int) error

	CreateWebhook(ctx context.Context, w Webhook) (Webhook, error)
	GetWebhook(ctx context.Context, tenantID, webhookID int64) (*Webhook, error)
	GetWebhookByHookID(ctx context.Context, hookID string) (*Webhook, error)
	// RotateWebhookSecret prev=旧 secret 进入 24h 宽限
	RotateWebhookSecret(ctx context.Context, tenantID, webhookID int64, newSecret, prevSecret string, prevExpiresAt time.Time) error
}
