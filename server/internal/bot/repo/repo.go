// 仓储接口（memory/postgres 双模装配，D02 §7）。
package botrepo

import (
	"context"
	"errors"
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
	CallbackURL   string // out 方向回调（20 §4.3）
	Secret        string // v0.1 明文（HMAC 验签需参与计算；KMS 信封加密登记 OQ）
	PrevSecret    string // 轮换宽限（24h 双验签）
	PrevExpiresAt time.Time
	DefaultConvID int64
	Targets       []int64
	OutTargets    *OutTargetCfg // out 方向订阅配置（in 方向 nil；20 §4.3）
	IPAllowlist   []string
	RateLimit     int // msg/min
	Status        int
	RotatedAt     time.Time
	CreatedAt     time.Time
}

// OutTargetCfg out 方向订阅配置（bot_webhook.out_targets jsonb；
// 定义在 repo 侧避免 service 反向依赖，装配层零转换同构）
type OutTargetCfg struct {
	EventTypes []string `json:"event_types"`
	Mode       string   `json:"mode"` // all | keyword | at_bot
	Keywords   []string `json:"keywords,omitempty"`
	ConvIDs    []int64  `json:"conv_ids"` // 源范围授权集
}

// ErrDupDelivery event_id 幂等命中（重复事件静默吞并）
var ErrDupDelivery = errors.New("botrepo: duplicate delivery event_id")

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
	// ListWebhooks 按方向列（out 事件消费入口扫描；direction 空=全部）
	ListWebhooks(ctx context.Context, tenantID int64, direction string) ([]Webhook, error)
	// UpdateWebhookStatus 订阅停启用（Outgoing 消费/投递前复查）
	UpdateWebhookStatus(ctx context.Context, tenantID, webhookID int64, status int) error
	// RotateWebhookSecret prev=旧 secret 进入 24h 宽限
	RotateWebhookSecret(ctx context.Context, tenantID, webhookID int64, newSecret, prevSecret string, prevExpiresAt time.Time) error
}

// Delivery Outgoing 投递记录（20 §5 bot_delivery_log；status 1 pending 2 sent 3 dead）
type Delivery struct {
	ID            int64
	TenantID      int64
	BotID         int64
	WebhookID     int64
	EventID       string // 幂等键（信封 event_id=接收方去重口径）
	EventType     string // msg.created
	PayloadDigest string // sha256 前 16（不存正文）
	TargetURL     string
	Attempt       int
	NextRetryAt   time.Time // 零值=立即可投
	Status        int
	ResponseCode  int
	ErrorBrief    string
	CreatedAt     time.Time
}

// DeliveryFilter ListDeliveries 过滤（零值=不过滤）
type DeliveryFilter struct {
	BotID     int64
	WebhookID int64
	Status    int
	Limit     int
}

// DeliveryRepo Outgoing 投递仓储（memory/postgres 双模）
type DeliveryRepo interface {
	// InsertDelivery 落 pending（event_id UK 幂等：重复返回 ErrDupDelivery 静默吞并）
	InsertDelivery(ctx context.Context, d Delivery) (Delivery, error)
	GetDelivery(ctx context.Context, tenantID, id int64) (*Delivery, error)
	// UpdateDeliveryAttempt 单次投递结果回写（attempt/response/error/next_retry/status）
	UpdateDeliveryAttempt(ctx context.Context, tenantID, id int64, attempt, responseCode int, errBrief string, nextRetry time.Time, status int) error
	// DueDeliveries 到期待投集（pending 且 next_retry_at <= now；limit 上限）
	DueDeliveries(ctx context.Context, tenantID int64, now time.Time, limit int) ([]Delivery, error)
	ListDeliveries(ctx context.Context, tenantID int64, f DeliveryFilter) ([]Delivery, error)
	// ReplayDelivery dead → pending 重置（人工重放；attempt 归零）
	ReplayDelivery(ctx context.Context, tenantID, id int64) error
}
