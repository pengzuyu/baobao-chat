// 服务层：bot 主档/webhook 凭证生命周期 + Incoming 投递管线（20 篇 §4.1/§4.2）。
//
// 跨域能力经 Options 闭包注入（D02 §4：不引 org/message/admin 包）：
// user(type=bot) 创建、会话成员判定/安装、消息主干发送、敏感词库。
package botservice

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	errx "github.com/baobaowork/server/internal/platform/errors"

	"github.com/baobaowork/server/internal/bot/api"
	"github.com/baobaowork/server/internal/bot/repo"
)

// Options 装配闭包（main 注入；nil 的能力即拒绝——安全侧能力不可缺省放行）
type Options struct {
	// CreateUser 建 user(type=bot)（org 域；employee_no 走 bot- 前缀独立段，永不登录）
	CreateUser func(ctx context.Context, tenantID int64, name string) (userID int64, err error)
	// MemberRole 会话内角色（0=非成员；1 owner 2 admin 3 member 4 publisher 5 bot）
	MemberRole func(ctx context.Context, convID, userID int64) int
	// AddMember / RemoveMember 会话安装与移出（message 域仓）
	AddMember    func(ctx context.Context, convID, userID int64, role int) error
	RemoveMember func(ctx context.Context, convID, userID int64) error
	// SendMsg 以 bot 身份走消息主干（seq 分配/扇出/同步由 message 服务负责）
	SendMsg func(ctx context.Context, senderID, convID int64, msgType string, body json.RawMessage, mentionUIDs []string) (msgID, seq int64, err error)
	// SensitiveWords 敏感词库（admin 域热更闭包，与人类消息同库同路径——20 篇 §7.2）
	SensitiveWords func() []string
	// Audit 审计闭包（nil=log 兜底；15 篇哈希链阶段二统一）
	Audit func(e AuditEntry)
	// Now 测试时钟（nil=time.Now）
	Now func() time.Time
	// GracePeriod secret 轮换宽限（缺省 24h；测试可缩短）
	GracePeriod time.Duration
}

// AuditEntry bot 域审计行（20 篇 §7.1：投递记调用方 IP/hook_id/conv_id/digest 不存正文）
type AuditEntry struct {
	Action   string // create/disable/enable/webhook/rotate/install/uninstall/deliver
	Tenant   int64
	Actor    int64 // 操作者（deliver 时为空——调用方是外部系统，记 ClientIP）
	BotID    int64
	ConvID   int64
	ClientIP string
	HookID   string
	OK       bool
	ErrCode  string
}

// Service BotService 实现
type Service struct {
	opts Options
	repo botrepo.Repo
	// 滑动分钟窗限流（webhookID → 窗口；20 篇 §4.2-③ 令牌桶名义，实现口径登记）
	rl   map[int64]*rlWindow
	rlMu sync.Mutex
}

// rlWindow 单分钟窗口计数
type rlWindow struct {
	minute int64 // unix 分钟号
	count  int
}

// NewService 装配
func NewService(opts Options, r botrepo.Repo) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.GracePeriod <= 0 {
		opts.GracePeriod = 24 * time.Hour
	}
	return &Service{opts: opts, repo: r, rl: map[int64]*rlWindow{}}
}

func (s *Service) audit(e AuditEntry) {
	if e.OK {
		e.ErrCode = ""
	}
	if s.opts.Audit != nil {
		s.opts.Audit(e)
		return
	}
	log.Printf("[bot] action=%s tenant=%d actor=%d bot=%d conv=%d ip=%s hook=%s ok=%v err=%s",
		e.Action, e.Tenant, e.Actor, e.BotID, e.ConvID, e.ClientIP, e.HookID, e.OK, e.ErrCode)
}

// ── 主档 ──

func (s *Service) CreateBot(ctx context.Context, tenantID, ownerID int64, req botapi.CreateBotReq) (*botapi.BotDTO, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" || utf8.RuneCountInString(name) > 50 {
		return nil, errx.New(errx.CodeBadRequest, "名称必填（≤50 字）")
	}
	if s.opts.CreateUser == nil {
		return nil, errx.New(errx.CodeInternal, "bot 身份通道未装配")
	}
	uid, err := s.opts.CreateUser(ctx, tenantID, name)
	if err != nil {
		return nil, err
	}
	b, err := s.repo.CreateBot(ctx, botrepo.Bot{
		TenantID: tenantID, UserID: uid, DeptID: req.DeptID,
		Name: name, Description: strings.TrimSpace(req.Description),
		OwnerUserID: ownerID, Status: botapi.StatusDisabled, // 建即停用：装凭证前不可用（§4.1-②）
	})
	if err != nil {
		return nil, err
	}
	s.audit(AuditEntry{Action: "create", Tenant: tenantID, Actor: ownerID, BotID: b.ID, OK: true})
	return toBotDTO(&b), nil
}

func (s *Service) ListBots(ctx context.Context, tenantID int64, status int) ([]botapi.BotDTO, error) {
	bots, err := s.repo.ListBots(ctx, tenantID, status)
	if err != nil {
		return nil, err
	}
	out := make([]botapi.BotDTO, 0, len(bots))
	for i := range bots {
		out = append(out, *toBotDTO(&bots[i]))
	}
	return out, nil
}

func (s *Service) GetBot(ctx context.Context, tenantID, botID int64) (*botapi.BotDTO, error) {
	b, err := s.repo.GetBot(ctx, tenantID, botID)
	if err != nil {
		return nil, errx.New(errx.CodeBadRequest, "bot 不存在")
	}
	return toBotDTO(b), nil
}

func (s *Service) SetBotStatus(ctx context.Context, tenantID, actorID, botID int64, active bool) error {
	status := botapi.StatusDisabled
	if active {
		status = botapi.StatusActive
	}
	if err := s.repo.UpdateBotStatus(ctx, tenantID, botID, status); err != nil {
		return errx.New(errx.CodeBadRequest, "bot 不存在")
	}
	action := "disable"
	if active {
		action = "enable"
	}
	s.audit(AuditEntry{Action: action, Tenant: tenantID, Actor: actorID, BotID: botID, OK: true})
	return nil
}

// ── webhook 凭证 ──

func (s *Service) CreateIncomingWebhook(ctx context.Context, tenantID, botID int64, req botapi.CreateWebhookReq) (*botapi.WebhookDTO, *botapi.SecretReveal, error) {
	if _, err := s.repo.GetBot(ctx, tenantID, botID); err != nil {
		return nil, nil, errx.New(errx.CodeBadRequest, "bot 不存在")
	}
	if req.DefaultConvID == 0 {
		return nil, nil, errx.New(errx.CodeBadRequest, "default_conv_id 必填（默认投递会话）")
	}
	// 授权会话集 = targets ∪ {default}（§4.2-④；默认会话天然授权）
	targets := uniqueInts(append(append([]int64{}, req.Targets...), req.DefaultConvID))
	rate := req.RateLimit
	if rate == 0 {
		rate = 30
	}
	if rate < 10 || rate > 120 {
		return nil, nil, errx.New(errx.CodeBadRequest, "rate_limit 10–120 msg/min")
	}
	for _, cidr := range req.IPAllowlist {
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return nil, nil, errx.New(errx.CodeBadRequest, "IP 白名单非法 CIDR: "+cidr)
		}
	}
	hookID := randHex(16)
	secret := randHex(32)
	w, err := s.repo.CreateWebhook(ctx, botrepo.Webhook{
		TenantID: tenantID, BotID: botID, Direction: "in",
		HookID: hookID, Secret: secret,
		DefaultConvID: req.DefaultConvID, Targets: targets,
		IPAllowlist: req.IPAllowlist, RateLimit: rate,
		Status: botapi.StatusActive,
	})
	if err != nil {
		return nil, nil, err
	}
	s.audit(AuditEntry{Action: "webhook", Tenant: tenantID, BotID: botID, ConvID: req.DefaultConvID, HookID: hookID, OK: true})
	return toWebhookDTO(&w), &botapi.SecretReveal{
		WebhookID: w.ID, HookID: hookID, Secret: secret, URL: "/hook/bot/" + hookID,
	}, nil
}

// RotateSecret 轮换：旧 secret 进 24h 宽限（双验签，旧签名命中写审计告警）
func (s *Service) RotateSecret(ctx context.Context, tenantID, webhookID int64) (*botapi.SecretReveal, error) {
	w, err := s.repo.GetWebhook(ctx, tenantID, webhookID)
	if err != nil {
		return nil, errx.New(errx.CodeBadRequest, "webhook 不存在")
	}
	newSecret := randHex(32)
	grace := s.opts.Now().Add(s.opts.GracePeriod)
	if err := s.repo.RotateWebhookSecret(ctx, tenantID, webhookID, newSecret, w.Secret, grace); err != nil {
		return nil, err
	}
	s.audit(AuditEntry{Action: "rotate", Tenant: tenantID, BotID: w.BotID, HookID: w.HookID, OK: true})
	return &botapi.SecretReveal{WebhookID: w.ID, HookID: w.HookID, Secret: newSecret, URL: "/hook/bot/" + w.HookID}, nil
}

// ── 会话安装 ──

func (s *Service) Install(ctx context.Context, tenantID, actorID, convID, botID int64) error {
	if s.opts.MemberRole == nil || s.opts.AddMember == nil {
		return errx.New(errx.CodeInternal, "会话通道未装配")
	}
	if role := s.opts.MemberRole(ctx, convID, actorID); role != 1 && role != 2 {
		return errx.New(errx.CodePermACLDenied, "仅群主/群管理员可添加机器人")
	}
	b, err := s.repo.GetBot(ctx, tenantID, botID)
	if err != nil {
		return errx.New(errx.CodeBadRequest, "bot 不存在")
	}
	if err := s.opts.AddMember(ctx, convID, b.UserID, botapi.MemberRoleBot); err != nil {
		return err
	}
	s.audit(AuditEntry{Action: "install", Tenant: tenantID, Actor: actorID, BotID: botID, ConvID: convID, OK: true})
	return nil
}

func (s *Service) Uninstall(ctx context.Context, tenantID, actorID, convID, botID int64) error {
	if s.opts.MemberRole == nil || s.opts.RemoveMember == nil {
		return errx.New(errx.CodeInternal, "会话通道未装配")
	}
	if role := s.opts.MemberRole(ctx, convID, actorID); role != 1 && role != 2 {
		return errx.New(errx.CodePermACLDenied, "仅群主/群管理员可移除机器人")
	}
	b, err := s.repo.GetBot(ctx, tenantID, botID)
	if err != nil {
		return errx.New(errx.CodeBadRequest, "bot 不存在")
	}
	if err := s.opts.RemoveMember(ctx, convID, b.UserID); err != nil {
		return err
	}
	s.audit(AuditEntry{Action: "uninstall", Tenant: tenantID, Actor: actorID, BotID: botID, ConvID: convID, OK: true})
	return nil
}

// ── Incoming 投递（§4.2 七步）──

func (s *Service) Deliver(ctx context.Context, hookID, tsRaw, sig string, raw []byte, clientIP string) (botapi.DeliverResult, error) {
	// ① 定位凭证 + 双状态复查（停用即时失效：单体每请求直查，无缓存层）
	w, err := s.repo.GetWebhookByHookID(ctx, hookID)
	if err != nil || w.Direction != "in" || w.Status != botapi.StatusActive {
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotCredential, "无效 hook")
	}
	b, err := s.repo.GetBot(ctx, w.TenantID, w.BotID)
	if err != nil || b.Status != botapi.StatusActive {
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotCredential, "bot 已停用")
	}
	// ② 验签：ts ±5min 防重放 + HMAC（轮换宽限双验签）；IP 白名单
	ts, terr := strconv.ParseInt(tsRaw, 10, 64)
	now := s.opts.Now()
	if terr != nil {
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotCredential, "时间戳非法")
	}
	if d := now.Unix() - ts; d > 300 || d < -300 {
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotCredential, "时间戳越窗（±5min）")
	}
	if !ipAllowed(w.IPAllowlist, clientIP) {
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotCredential, "IP 不在白名单")
	}
	mac := strings.TrimPrefix(sig, "sha256=")
	usedPrev := false
	switch {
	case hmacSHA256Hex(w.Secret, tsRaw, raw) == mac:
	case w.PrevSecret != "" && !now.After(w.PrevExpiresAt) && hmacSHA256Hex(w.PrevSecret, tsRaw, raw) == mac:
		usedPrev = true // 宽限期内旧签名命中——告警提示切换（§3.3）
	default:
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotCredential, "签名不匹配")
	}
	// ③ 限流（bot 级滑动分钟窗）
	if !s.allow(w.ID, w.RateLimit, now) {
		s.audit(AuditEntry{Action: "deliver", Tenant: w.TenantID, BotID: w.BotID, HookID: hookID, ClientIP: clientIP, ErrCode: "3032"})
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotRateLimited, "频率超限")
	}
	// ④ 目标授权：body.target.conv_id ∈ 授权集 + bot 仍是会话成员
	var p botapi.HookPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return botapi.DeliverResult{}, errx.New(errx.CodeBadRequest, "body 非法 JSON")
	}
	convID := w.DefaultConvID
	if len(p.Target) > 0 {
		var t struct {
			ConvID string `json:"conv_id"`
		}
		if err := json.Unmarshal(p.Target, &t); err == nil && t.ConvID != "" {
			c, cerr := strconv.ParseInt(t.ConvID, 10, 64)
			if cerr != nil {
				return botapi.DeliverResult{}, errx.New(errx.CodeBadRequest, "conv_id 非法")
			}
			convID = c
		}
	}
	if !containsInt(w.Targets, convID) {
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotTargetDenied, "投递目标未授权")
	}
	if s.opts.MemberRole == nil || s.opts.MemberRole(ctx, convID, b.UserID) == 0 {
		return botapi.DeliverResult{}, errx.New(errx.CodeIMBotTargetDenied, "bot 不在目标会话")
	}
	// ⑤ 内容安检：类型校验 + 敏感词（同库同路径，命中 3005 拒投并告警）
	msgType, body, mentions, verr := validatePayload(&p)
	if verr != nil {
		return botapi.DeliverResult{}, verr
	}
	if hit := sensitiveHit(s.opts.SensitiveWords, p.Text, p.MD, body); hit != "" {
		s.audit(AuditEntry{Action: "deliver", Tenant: w.TenantID, BotID: w.BotID, ConvID: convID, HookID: hookID, ClientIP: clientIP, ErrCode: "3005"})
		return botapi.DeliverResult{}, errx.New(errx.CodeIMSensitiveBlocked, "内容命中敏感词")
	}
	// ⑥ 发送：以 bot 的 user_id 走消息主干
	if s.opts.SendMsg == nil {
		return botapi.DeliverResult{}, errx.New(errx.CodeInternal, "消息通道未装配")
	}
	msgID, seq, err := s.opts.SendMsg(ctx, b.UserID, convID, msgType, body, mentions)
	if err != nil {
		return botapi.DeliverResult{}, err // message 域错误原样回传（3005/3007/…）
	}
	// ⑦ 审计（调用方 IP/hook/会话；内容 digest 不存正文）
	s.audit(AuditEntry{
		Action: "deliver", Tenant: w.TenantID, BotID: w.BotID, ConvID: convID,
		HookID: hookID, ClientIP: clientIP, OK: true,
	})
	if usedPrev {
		log.Printf("[bot] 宽限期内旧 secret 命中（请通知接收方切换）: hook=%s bot=%d", hookID, w.BotID)
	}
	return botapi.DeliverResult{MsgID: msgID, Seq: seq}, nil
}

// allow 滑动分钟窗限流（webhook 级；租户级全局 600/min 阶段二登记）
func (s *Service) allow(webhookID int64, rate int, now time.Time) bool {
	s.rlMu.Lock()
	defer s.rlMu.Unlock()
	minute := now.Unix() / 60
	w, ok := s.rl[webhookID]
	if !ok || w.minute != minute {
		s.rl[webhookID] = &rlWindow{minute: minute, count: 1}
		return true
	}
	if w.count >= rate {
		return false
	}
	w.count++
	return true
}

// validatePayload 类型/长度/卡片结构校验（§7.3：sections ≤20、总长 ≤4000、@ ≤10、links https）
func validatePayload(p *botapi.HookPayload) (string, json.RawMessage, []string, error) {
	switch p.MsgType {
	case "text":
		if p.Text == "" || utf8.RuneCountInString(p.Text) > 5000 {
			return "", nil, nil, errx.New(errx.CodeIMContentTooLong, "text 必填（≤5000 字）")
		}
		return "text", mustJSON(map[string]string{"text": p.Text}), nil, nil
	case "markdown":
		if p.MD == "" || utf8.RuneCountInString(p.MD) > 5000 {
			return "", nil, nil, errx.New(errx.CodeIMContentTooLong, "md 必填（≤5000 字）")
		}
		return "markdown", mustJSON(map[string]string{"md": p.MD}), nil, nil
	case "bot_card":
		var card struct {
			Title    string          `json:"title"`
			Sections json.RawMessage `json:"sections"`
			Links    json.RawMessage `json:"links"`
			AtUIDs   []string        `json:"at_user_ids"`
			Level    string          `json:"level"`
		}
		if err := json.Unmarshal(p.Card, &card); err != nil || card.Title == "" {
			return "", nil, nil, errx.New(errx.CodeBadRequest, "card 非法（title 必填）")
		}
		if utf8.RuneCountInString(card.Title) > 200 {
			return "", nil, nil, errx.New(errx.CodeBadRequest, "card.title ≤200 字")
		}
		if card.Level != "" && card.Level != "info" && card.Level != "warn" && card.Level != "error" {
			return "", nil, nil, errx.New(errx.CodeBadRequest, "card.level ∈ info|warn|error")
		}
		var sections []map[string]string
		if len(card.Sections) > 0 {
			_ = json.Unmarshal(card.Sections, &sections)
		}
		if len(sections) > 20 {
			return "", nil, nil, errx.New(errx.CodeBadRequest, "card.sections ≤20 项")
		}
		if len(card.AtUIDs) > 10 {
			return "", nil, nil, errx.New(errx.CodeBadRequest, "at_user_ids ≤10")
		}
		var links []map[string]string
		if len(card.Links) > 0 {
			_ = json.Unmarshal(card.Links, &links)
		}
		for _, l := range links {
			u := l["url"]
			if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
				return "", nil, nil, errx.New(errx.CodeBadRequest, "card.links.url 须 http(s)://")
			}
		}
		total := utf8.RuneCountInString(card.Title) + runeLen(sections)
		for _, l := range links {
			total += utf8.RuneCountInString(l["label"]) + utf8.RuneCountInString(l["url"])
		}
		if total > 4000 {
			return "", nil, nil, errx.New(errx.CodeBadRequest, "card 总长 ≤4000 字")
		}
		// links 域名租户白名单：v0.1 未配置白名单即放行（登记：BOT-01 策略位阶段二）
		return "bot_card", p.Card, card.AtUIDs, nil
	default:
		return "", nil, nil, errx.New(errx.CodeBadRequest, "msg_type ∈ text|markdown|bot_card")
	}
}

// sensitiveHit 敏感词命中（text/md/card 全通道；20 篇 §7.2 机器发送不豁免）
func sensitiveHit(words func() []string, text, md string, card json.RawMessage) string {
	if words == nil {
		return ""
	}
	hay := text + "\n" + md + "\n" + string(card)
	for _, w := range words() {
		if w != "" && strings.Contains(hay, w) {
			return w
		}
	}
	return ""
}

// hmacSHA256Hex 20 篇 §4.2-②：HMAC-SHA256(secret, "{ts}.{raw}") hex
func hmacSHA256Hex(secret, ts string, raw []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}

func ipAllowed(cidrs []string, ip string) bool {
	if len(cidrs) == 0 {
		return true
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	for _, c := range cidrs {
		if _, n, err := net.ParseCIDR(c); err == nil && n.Contains(parsed) {
			return true
		}
	}
	return false
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("bot: rand: %v", err)) // crypto/rand 失败不可恢复（authjwt 同口径）
	}
	return hex.EncodeToString(b)
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func runeLen(sections []map[string]string) int {
	n := 0
	for _, s := range sections {
		for k, v := range s {
			n += utf8.RuneCountInString(k) + utf8.RuneCountInString(v)
		}
	}
	return n
}

func containsInt(list []int64, v int64) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func uniqueInts(in []int64) []int64 {
	seen := map[int64]bool{}
	out := []int64{}
	for _, v := range in {
		if v != 0 && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func toBotDTO(b *botrepo.Bot) *botapi.BotDTO {
	return &botapi.BotDTO{
		ID: b.ID, TenantID: b.TenantID, UserID: b.UserID, DeptID: b.DeptID,
		Name: b.Name, Description: b.Description, OwnerUserID: b.OwnerUserID,
		Status: b.Status, CreatedAt: b.CreatedAt.UnixMilli(),
	}
}

func toWebhookDTO(w *botrepo.Webhook) *botapi.WebhookDTO {
	dto := &botapi.WebhookDTO{
		ID: w.ID, BotID: w.BotID, Direction: w.Direction, HookID: w.HookID,
		DefaultConvID: w.DefaultConvID, Targets: w.Targets, IPAllowlist: w.IPAllowlist,
		RateLimit: w.RateLimit, Status: w.Status, CreatedAt: w.CreatedAt.UnixMilli(),
	}
	if !w.RotatedAt.IsZero() {
		dto.RotatedAt = w.RotatedAt.UnixMilli()
	}
	if w.OutTargets != nil { // out 方向摘要（20 §4.3）
		dto.CallbackURL = w.CallbackURL
		dto.OutMode = w.OutTargets.Mode
		dto.Keywords = w.OutTargets.Keywords
	}
	return dto
}
