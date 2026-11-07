// Outgoing Webhook 投递引擎（20 §4.3/§4.4 阶段二务实版）。
//
// 事件源 v0.1=msg.created 单源（审批结果/agent 任务完成随后续域事件接入，
// 登记）；三订阅模式（all/keyword/at_bot）× 源范围（conv_ids 授权集，空=
// 不投——显式授权原则）。投递=HTTP POST 回调 + HMAC 签名头（同 Incoming
// 算法，out 方向独立 secret）；重试 1min/5min/15min 共 4 次尝试→dead
// （人工重放）。Redis Stream 队列随多实例阶段二（v0.1 进程内 next_retry_at
// 轮询，DeliverDue 手动泵可测）；投递正文不落库（20 §5 digest 口径），
// 在途重试体缓存进程内——重启后 pending 行降级发元数据信封（接收方按
// event_id 幂等），登记。
package botservice

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	botapi "github.com/baobaowork/server/internal/bot/api"
	botrepo "github.com/baobaowork/server/internal/bot/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// OutTargetCfg 配置类型归位 api 包（协议层；repo 存储实体同构转换）

// errGone 订阅消失/停用哨兵（在途投递转 dead）
var errGone = errors.New("subscription gone")

// 订阅模式（20 §4.3 ① 三选一）
const (
	OutModeAll     = "all"
	OutModeKeyword = "keyword"
	OutModeAtBot   = "at_bot"
)

// 重试退避（20 §4.3：1min/5min/15min；attempt 0-3 共 4 次尝试）
var retryBackoff = [3]time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute}

const maxAttempts = 4

// MsgCreatedLight bot 侧轻事件结构（main 从 messageapi.MsgCreatedEvent 转换；
// 依赖倒置 D02 §4：bot 不引 message 包）
type MsgCreatedLight struct {
	TenantID   int64
	MsgID      int64
	ConvID     int64
	SenderID   int64
	SenderName string
	MsgType    string
	Body       json.RawMessage
	Mentions   []string // uid 字符串集（@bot 判定口径）
}

// Envelope 投递信封（20 §4.3：event/bot_id/ts/data + event_id 幂等键）
type Envelope struct {
	Event   string         `json:"event"`
	EventID string         `json:"event_id"`
	BotID   int64          `json:"bot_id"`
	TS      int64          `json:"ts"`
	Data    MsgCreatedData `json:"data"`
}

// MsgCreatedData 信封 data（消息摘要——外部系统消费字段）
type MsgCreatedData struct {
	MsgID      int64           `json:"msg_id"`
	ConvID     int64           `json:"conv_id"`
	SenderID   int64           `json:"sender_id"`
	SenderName string          `json:"sender_name"`
	MsgType    string          `json:"msg_type"`
	Body       json.RawMessage `json:"body"`
	Mentions   []string        `json:"mentions,omitempty"`
}

// Outgoing 投递引擎（装配：main 订阅 TopicMsgCreated + go Run(ctx)）
type Outgoing struct {
	repo       botrepo.Repo
	deliveries botrepo.DeliveryRepo
	opts       Options
	httpDo     func(*http.Request) (*http.Response, error) // 测试注入
	envMu      sync.RWMutex
	envelopes  map[string][]byte // eventID → 投递体（在途重试同体缓存）
}

// NewOutgoing 构造
func NewOutgoing(opts Options, r botrepo.Repo, d botrepo.DeliveryRepo) *Outgoing {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Outgoing{repo: r, deliveries: d, opts: opts, envelopes: map[string][]byte{}}
}

// SetHTTPDo 注入传输层（测试）
func (o *Outgoing) SetHTTPDo(do func(*http.Request) (*http.Response, error)) {
	o.httpDo = do
}

// OnMsgCreated 事件消费入口（main 装配 bus.Subscribe(TopicMsgCreated, …)→
// 类型转换后调用）：列 out 订阅 → 三模式匹配 + 源范围 → Enqueue（event_id
// 幂等）。消费侧故障只记审计不 panic（事件链不因 bot 域阻断）。
func (o *Outgoing) OnMsgCreated(evt MsgCreatedLight) {
	ctx := context.Background()
	hooks, err := o.repo.ListWebhooks(ctx, evt.TenantID, "out")
	if err != nil {
		o.audit("outgoing.list_failed", 0, false, err.Error())
		return
	}
	now := o.opts.Now()
	for _, w := range hooks {
		if w.Status != 1 || w.OutTargets == nil {
			continue
		}
		bot, berr := o.repo.GetBot(ctx, w.TenantID, w.BotID)
		if berr != nil || bot.Status != 1 {
			continue // bot 停用：不新增投递（20 §4.5）
		}
		if !matchOutgoing(repoCfgToAPI(w.OutTargets), &evt, bot.UserID) {
			continue
		}
		eventID := fmt.Sprintf("out-%d-%d-%s", w.ID, evt.MsgID, now.Format("20060102T150405.000000000"))
		payload, _ := json.Marshal(Envelope{
			Event: "msg.created", EventID: eventID, BotID: w.BotID, TS: now.Unix(),
			Data: MsgCreatedData{
				MsgID: evt.MsgID, ConvID: evt.ConvID, SenderID: evt.SenderID,
				SenderName: evt.SenderName, MsgType: evt.MsgType,
				Body: evt.Body, Mentions: evt.Mentions,
			},
		})
		if _, derr := o.deliveries.InsertDelivery(ctx, botrepo.Delivery{
			TenantID: w.TenantID, BotID: w.BotID, WebhookID: w.ID,
			EventID: eventID, EventType: "msg.created",
			PayloadDigest: digestHex(payload), TargetURL: w.CallbackURL,
			Status: 1, CreatedAt: now,
		}); derr != nil {
			if derr == botrepo.ErrDupDelivery {
				continue // 幂等：同事件重复消费静默
			}
			o.audit("outgoing.enqueue_failed", w.BotID, false, derr.Error())
			continue
		}
		o.envMu.Lock()
		o.envelopes[eventID] = payload // 在途重试同体
		o.envMu.Unlock()
	}
}

// DeliverDue 投递泵（Run worker 1s 轮询；测试手动驱动）。返回处理条数。
func (o *Outgoing) DeliverDue(ctx context.Context, limit int) int {
	if limit <= 0 {
		limit = 32
	}
	now := o.opts.Now()
	due, err := o.deliveries.DueDeliveries(ctx, 1, now, limit)
	if err != nil {
		o.audit("outgoing.due_failed", 0, false, err.Error())
		return 0
	}
	for _, d := range due {
		o.attemptOnce(ctx, d, now)
	}
	return len(due)
}

// Run worker 循环（main go Outgoing.Run(ctx)）
func (o *Outgoing) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			o.DeliverDue(ctx, 32)
		}
	}
}

// attemptOnce 单次投递：复查 webhook/bot 状态（停用→dead，20 §4.5）→
// HTTP → 结果回写（sent / 退避重试 / 4 次尽 dead）
func (o *Outgoing) attemptOnce(ctx context.Context, d botrepo.Delivery, now time.Time) {
	w, werr := o.repo.GetWebhook(ctx, d.TenantID, d.WebhookID)
	if werr == nil {
		if b, berr := o.repo.GetBot(ctx, d.TenantID, d.BotID); berr == nil && b.Status != 1 {
			werr = errGone // bot 停用：在途转 dead（原因=bot_disabled）
		}
	}
	if werr != nil || w.Status != 1 || w.OutTargets == nil {
		_ = o.deliveries.UpdateDeliveryAttempt(ctx, d.TenantID, d.ID, d.Attempt, 0,
			"subscription_gone_or_disabled", time.Time{}, 3)
		o.dropEnvelope(d.EventID)
		return
	}
	code, brief := o.post(w, d)
	attempt := d.Attempt + 1
	switch {
	case code >= 200 && code < 300:
		_ = o.deliveries.UpdateDeliveryAttempt(ctx, d.TenantID, d.ID, attempt, code, "", time.Time{}, 2)
		o.dropEnvelope(d.EventID)
	case attempt >= maxAttempts:
		_ = o.deliveries.UpdateDeliveryAttempt(ctx, d.TenantID, d.ID, attempt, code, brief, time.Time{}, 3)
		o.audit("outgoing.dead", d.BotID, false, brief)
		o.dropEnvelope(d.EventID)
	default:
		next := now.Add(retryBackoff[attempt-1])
		_ = o.deliveries.UpdateDeliveryAttempt(ctx, d.TenantID, d.ID, attempt, code, brief, next, 1)
	}
}

// post HTTP 投递：信封 + HMAC 头（同 Incoming 算法 ts.raw，out 独立 secret）
func (o *Outgoing) post(w *botrepo.Webhook, d botrepo.Delivery) (int, string) {
	body := o.envelopeOf(d)
	ts := strconv.FormatInt(o.opts.Now().Unix(), 10)
	req, err := http.NewRequest(http.MethodPost, w.CallbackURL, bytes.NewReader(body))
	if err != nil {
		return 0, "bad callback_url: " + err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-BBW-Timestamp", ts)
	req.Header.Set("X-BBW-Signature", "sha256="+hmacSHA256Hex(w.Secret, ts, body))
	do := o.httpDo
	if do == nil {
		do = (&http.Client{Timeout: 10 * time.Second}).Do // 20 §4.3 超时 10s
	}
	resp, err := do(req)
	if err != nil {
		return 0, "transport: " + err.Error()
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Sprintf("http %d", resp.StatusCode)
	}
	return resp.StatusCode, ""
}

// envelopeOf 投递体：在途缓存命中→原体；miss（重启后的 pending）→
// 元数据信封降级（data 空，接收方 event_id 幂等兜底）
func (o *Outgoing) envelopeOf(d botrepo.Delivery) []byte {
	o.envMu.RLock()
	body, ok := o.envelopes[d.EventID]
	o.envMu.RUnlock()
	if ok {
		return body
	}
	fallback, _ := json.Marshal(Envelope{
		Event: d.EventType, EventID: d.EventID, BotID: d.BotID, TS: d.CreatedAt.Unix(),
	})
	return fallback
}

func (o *Outgoing) dropEnvelope(eventID string) {
	o.envMu.Lock()
	delete(o.envelopes, eventID)
	o.envMu.Unlock()
}

// matchOutgoing 三模式匹配 + 源范围（conv 授权集；@bot=mentions 命中 bot user）
func matchOutgoing(cfg *botapi.OutTargetCfg, evt *MsgCreatedLight, botUserID int64) bool {
	if cfg == nil || len(cfg.ConvIDs) == 0 {
		return false // 显式授权原则：无源范围不投
	}
	convHit := false
	for _, c := range cfg.ConvIDs {
		if c == evt.ConvID {
			convHit = true
			break
		}
	}
	if !convHit {
		return false
	}
	switch cfg.Mode {
	case OutModeAll:
		return true
	case OutModeKeyword:
		text := messageText(evt.Body)
		for _, kw := range cfg.Keywords {
			if kw != "" && strings.Contains(text, kw) {
				return true
			}
		}
		return false
	case OutModeAtBot:
		uid := strconv.FormatInt(botUserID, 10)
		for _, m := range evt.Mentions {
			if m == uid {
				return true
			}
		}
		return false
	}
	return false
}

// messageText body 提取纯文本（text/md 消息 keyword 匹配口径）
func messageText(body json.RawMessage) string {
	var b struct {
		Text string `json:"text"`
		MD   string `json:"md"`
	}
	if json.Unmarshal(body, &b) != nil {
		return ""
	}
	return b.Text + "\n" + b.MD
}

func digestHex(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:8]) // 前 8 字节=16 hex（不存正文口径）
}

func (o *Outgoing) audit(action string, botID int64, ok bool, brief string) {
	if o.opts.Audit != nil {
		o.opts.Audit(AuditEntry{Action: action, BotID: botID, OK: ok, ErrCode: brief})
	}
}

// ReplayDead 死信重放（管理端；attempt 归零）
func (o *Outgoing) ReplayDead(ctx context.Context, tenantID, id int64) error {
	if err := o.deliveries.ReplayDelivery(ctx, tenantID, id); err != nil {
		return errx.New(errx.CodeBadRequest, "死信不存在或非 dead 态")
	}
	return nil
}

// ListDeliveries 投递记录（管理端；BOT-01 投递页数据源）
func (o *Outgoing) ListDeliveries(ctx context.Context, tenantID int64, f botrepo.DeliveryFilter) ([]botrepo.Delivery, error) {
	return o.deliveries.ListDeliveries(ctx, tenantID, f)
}

// CreateOutgoingWebhook 建订阅（out 方向；callback_url+三模式配置）
func (o *Outgoing) CreateOutgoingWebhook(ctx context.Context, tenantID, botID int64,
	callbackURL string, cfg botapi.OutTargetCfg) (*botapi.WebhookDTO, *botapi.SecretReveal, error) {
	if _, err := o.repo.GetBot(ctx, tenantID, botID); err != nil {
		return nil, nil, errx.New(errx.CodeBadRequest, "bot 不存在")
	}
	if !strings.HasPrefix(callbackURL, "https://") && !strings.HasPrefix(callbackURL, "http://") {
		return nil, nil, errx.New(errx.CodeBadRequest, "callback_url 须 http(s)://")
	}
	if cfg.Mode == "" {
		cfg.Mode = OutModeAll
	}
	switch cfg.Mode {
	case OutModeAll, OutModeKeyword, OutModeAtBot:
	default:
		return nil, nil, errx.New(errx.CodeBadRequest, "mode 须 all/keyword/at_bot")
	}
	if cfg.Mode == OutModeKeyword && len(cfg.Keywords) == 0 {
		return nil, nil, errx.New(errx.CodeBadRequest, "keyword 模式须配 keywords")
	}
	if len(cfg.ConvIDs) == 0 {
		return nil, nil, errx.New(errx.CodeBadRequest, "conv_ids 必填（源范围授权集）")
	}
	if len(cfg.EventTypes) == 0 {
		cfg.EventTypes = []string{"msg.created"}
	}
	secret := randHex(32)
	repoCfg := botrepo.OutTargetCfg(cfg) // 同构直转（字段与 json 标签一致）
	created, err := o.repo.CreateWebhook(ctx, botrepo.Webhook{
		TenantID: tenantID, BotID: botID, Direction: "out",
		CallbackURL: callbackURL, Secret: secret,
		OutTargets: &repoCfg, RateLimit: 30, Status: 1,
	})
	if err != nil {
		return nil, nil, err
	}
	return toWebhookDTO(&created), &botapi.SecretReveal{
		WebhookID: created.ID, Secret: secret,
	}, nil
}

// repoCfgToAPI 存储配置 → 协议配置（同构直转）
func repoCfgToAPI(c *botrepo.OutTargetCfg) *botapi.OutTargetCfg {
	if c == nil {
		return nil
	}
	return (*botapi.OutTargetCfg)(c)
}
