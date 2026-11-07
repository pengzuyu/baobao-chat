// Package botapi 机器人域对外接口与 DTO（20 篇 · 阶段一务实版）。
//
// v0.1 务实口径（相对 20 篇全量的裁剪，逐条登记）：
//   - 落地：bot 身份（user.type=bot，org 域既有枚举）+ bot 主档 + Incoming Webhook
//     全链（HMAC 验签/防重放/IP 白名单/限流/目标授权/敏感词/bot_card 校验/以 bot
//     身份走消息主干）+ 管理 REST 核心（创建/列表/详情/停启用/webhook 创建与轮换/
//     会话安装与移出）+ 错误码 3030–3033（codes.go 已预登记）；
//   - 不做（登记阶段二+）：Outgoing 事件订阅投递（重试队列 1/5/15min + 死信 +
//     bot_delivery_log 需 Redis Stream，随 16 篇 Redis 引入落地）、@bot 唤醒路由
//     （依赖 Outgoing）、审批/Agent 任务事件源（生产者未接）、BOT-01 管理页与
//     bot.updated WS 推送（client 侧）、租户级全局限流（600/min，同批登记）；
//   - 口径处置：20 篇 §3.3 "secret_hash 落库（bcrypt）" 与 §4.2 HMAC 验签内在
//     矛盾（验 HMAC 需 secret 明文参与计算，哈希不可逆）——v0.1 按行业惯例
//     （GitHub/Slack webhook signing secret）存明文，生产环境信封加密随 15 篇
//     自建 KMS（OQ-D12）落地，登记开放问题；
//   - bot 消息 bot_user 永不登录（无口令无设备）；停用即时失效在单体内由
//     "每请求查 bot/webhook 状态" 天然保证（无独立缓存层，Redis 标记阶段二）。
package botapi

import (
	"context"
	"encoding/json"

	botrepo "github.com/baobaowork/server/internal/bot/repo"
)

// 状态（bot 主档与 webhook 共用口径：1 启用 2 停用）
const (
	StatusActive   = 1
	StatusDisabled = 2
)

// 会话成员 role=bot 值（message 域 Member.Role int：1 owner/2 admin/3 member/
// 4 publisher；5=bot 为本域扩展——20 篇 §5 回填 conversation_member role=bot）
const MemberRoleBot = 5

// BotDTO bot 主档
type BotDTO struct {
	ID          int64  `json:"id,string"`
	TenantID    int64  `json:"-"`
	UserID      int64  `json:"user_id,string"` // 消息 sender 即此 user（type=bot）
	DeptID      int64  `json:"dept_id,string,omitempty"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	OwnerUserID int64  `json:"owner_user_id,string"` // 创建/负责开发者
	Status      int    `json:"status"`               // 1 启用 2 停用
	CreatedAt   int64  `json:"created_at"`           // ms
}

// WebhookDTO webhook 配置（secret 永不出现——仅创建/轮换响应一次性明文）
type WebhookDTO struct {
	ID            int64    `json:"id,string"`
	BotID         int64    `json:"bot_id,string"`
	Direction     string   `json:"direction"` // in（out 阶段二）
	HookID        string   `json:"hook_id,omitempty"`
	DefaultConvID int64    `json:"default_conv_id,string,omitempty"`
	Targets       []int64  `json:"targets,omitempty"`      // 授权会话集（in 方向）
	CallbackURL   string   `json:"callback_url,omitempty"` // out 方向回调（20 §4.3）
	OutMode       string   `json:"out_mode,omitempty"`     // all|keyword|at_bot（out 方向）
	Keywords      []string `json:"keywords,omitempty"`     // keyword 模式过滤词
	IPAllowlist   []string `json:"ip_allowlist,omitempty"`
	RateLimit     int      `json:"rate_limit"` // msg/min（默认 30，10–120）
	Status        int      `json:"status"`
	RotatedAt     int64    `json:"rotated_at,omitempty"` // ms
	CreatedAt     int64    `json:"created_at"`
}

// SecretReveal 一次性 secret 展示（创建/轮换响应；库中零留存由服务层保证）
type SecretReveal struct {
	WebhookID int64  `json:"webhook_id,string"`
	HookID    string `json:"hook_id"`
	Secret    string `json:"secret"` // 仅本次响应携带，关闭弹窗即不可再取
	URL       string `json:"url"`    // /hook/bot/{hook_id}
}

// CreateBotReq 创建请求（A 档二次验证随 BOT-01 页面阶段二；v0.1 管理权限点
// bot:manage 缺省放行登记——03 篇权限点字典接线后收口）
type CreateBotReq struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	DeptID      int64  `json:"dept_id"`
}

// CreateWebhookReq Incoming webhook 创建
type CreateWebhookReq struct {
	DefaultConvID int64    `json:"default_conv_id"` // 省略 target 时的默认会话
	Targets       []int64  `json:"targets"`         // 授权会话集（含 DefaultConvID 语义）
	IPAllowlist   []string `json:"ip_allowlist"`
	RateLimit     int      `json:"rate_limit"` // 0=默认 30
}

// HookPayload Incoming 投递载荷（20 篇 §6.1；msg_type 三选一）
type HookPayload struct {
	MsgType string          `json:"msg_type"` // text|markdown|bot_card
	Target  json.RawMessage `json:"target"`   // {"conv_id":"…"} 省略=默认会话
	Text    string          `json:"text"`
	MD      string          `json:"md"`
	Card    json.RawMessage `json:"card"`
}

// DeliverResult Incoming 投递结果（入口响应 data）
type DeliverResult struct {
	MsgID int64 `json:"msg_id,string"`
	Seq   int64 `json:"seq"`
}

// BotService 机器人域服务接口（REST 壳与 HookHandler 依赖）
type BotService interface {
	// CreateBot 建 user(type=bot)+bot 主档（默认 disabled——装凭证前不可用）
	CreateBot(ctx context.Context, tenantID, ownerID int64, req CreateBotReq) (*BotDTO, error)
	ListBots(ctx context.Context, tenantID int64, status int) ([]BotDTO, error)
	GetBot(ctx context.Context, tenantID, botID int64) (*BotDTO, error)
	// SetBotStatus 停启用（停用即时失效：hook 端点与发送路径均复查状态）
	SetBotStatus(ctx context.Context, tenantID, actorID, botID int64, active bool) error

	// CreateIncomingWebhook 生成 hook_id+secret（一次性返回明文）
	CreateIncomingWebhook(ctx context.Context, tenantID, botID int64, req CreateWebhookReq) (*WebhookDTO, *SecretReveal, error)
	// RotateSecret 轮换：新 secret 立即生效，旧 secret 24h 宽限双验签
	RotateSecret(ctx context.Context, tenantID, webhookID int64) (*SecretReveal, error)

	// Install / Uninstall 会话安装与移出（群主/群管理员——20 篇 bot:install）
	Install(ctx context.Context, tenantID, actorID, convID, botID int64) error
	Uninstall(ctx context.Context, tenantID, actorID, convID, botID int64) error

	// Deliver Incoming 投递核心（验签→限流→授权→安检→发送；20 篇 §4.2）
	Deliver(ctx context.Context, hookID, ts, sig string, raw []byte, clientIP string) (DeliverResult, error)
}

// OutTargetCfg out 方向订阅配置（20 §4.3；out_targets jsonb 同构）
type OutTargetCfg struct {
	EventTypes []string `json:"event_types"`
	Mode       string   `json:"mode"`               // all | keyword | at_bot
	Keywords   []string `json:"keywords,omitempty"` // keyword 模式过滤词
	ConvIDs    []int64  `json:"conv_ids"`           // 源范围授权集
}

// CreateOutgoingReq POST /bots/{id}/webhooks/outgoing
type CreateOutgoingReq struct {
	CallbackURL string       `json:"callback_url"`
	Targets     OutTargetCfg `json:"targets"`
}

// DeliveryDTO 投递记录（BOT-01 投递页）
type DeliveryDTO struct {
	ID           int64  `json:"id,string"`
	BotID        int64  `json:"bot_id,string"`
	WebhookID    int64  `json:"webhook_id,string"`
	EventID      string `json:"event_id"`
	EventType    string `json:"event_type"`
	TargetURL    string `json:"target_url"`
	Attempt      int    `json:"attempt"`
	Status       int    `json:"status"` // 1 pending 2 sent 3 dead
	ResponseCode int    `json:"response_code,omitempty"`
	ErrorBrief   string `json:"error_brief,omitempty"`
	CreatedAt    int64  `json:"created_at"` // ms
}

// OutgoingService Outgoing 管理面窄接口（handlers 依赖倒置；实现=botservice.Outgoing）
type OutgoingService interface {
	CreateOutgoingWebhook(ctx context.Context, tenantID, botID int64, callbackURL string, cfg OutTargetCfg) (*WebhookDTO, *SecretReveal, error)
	ListDeliveries(ctx context.Context, tenantID int64, f botrepo.DeliveryFilter) ([]botrepo.Delivery, error)
	ReplayDead(ctx context.Context, tenantID, id int64) error
}
