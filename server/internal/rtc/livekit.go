// rtc 域 LiveKit 统一媒体面接入（D17 §3，2026-11-09 拍板：1v1/群一致走 SFU）：
//   - Access Token：零依赖手写 HS256 JWT（grants.video 与 livekit/protocol/auth 载荷对齐），
//     不引 livekit server-sdk-go（go.mod 保持仅 pgx，沿自研 WS/HTTP 口径）
//   - Webhook：livekit-server 回调 participant_joined/left、room_finished → 同步 CallRegistry
//     （服务端真相源：掉线/崩溃侧的离开由媒体面兜底回收，不再依赖端侧 rtc.bye）
//   - rtc.signal SDP/ICE 中转退役（D17 §7）：客户端经本文件签发的 token 直连 livekit；
//     Signal 处理器保留仅为兼容旧客户端，登记。
package rtc

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	errx "github.com/baobaowork/server/internal/platform/errors"
	rtcapi "github.com/baobaowork/server/internal/rtc/api"
)

// TokenTTLDefault 进房凭证有效期（对齐 05 篇 §4.2 通话最长时长 4h；通话中重取即可续）
const TokenTTLDefault = 4 * time.Hour

// roomIDPattern LiveKit room/identity 合法字符集（call_id 客户端生成 call-{ts}-{seq} 天然满足）
var roomIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)

// LiveKitParams 媒体面装配（main 经 BBW_LIVEKIT_* 环境变量注入；三项齐备才启用）
type LiveKitParams struct {
	URL        string   // 客户端连接地址（wss://host/rtc 或独立子域/端口；/rtc/config 与 token ack 下发）
	APIKey     string   // livekit API key（签发/验签同源）
	APISecret  string   // livekit API secret（HS256）
	ICEServers []string // 可选附加 ICE servers（urls 列表；内网 host 直连为主，TURN 兜底 P1）
}

// Enabled 媒体面已配置（未配置=开发模式：token/config 返回 5003，端侧无媒体降级）
func (p LiveKitParams) Enabled() bool {
	return p.URL != "" && p.APIKey != "" && p.APISecret != ""
}

// ---- LiveKit Access Token（手写 HS256 JWT） ----

// lkVideoGrant livekit grants.video（canPublish 等三态布尔此处恒显式 true）
type lkVideoGrant struct {
	Room           string `json:"room"`
	RoomJoin       bool   `json:"roomJoin"`
	CanPublish     bool   `json:"canPublish"`
	CanSubscribe   bool   `json:"canSubscribe"`
	CanPublishData bool   `json:"canPublishData"`
}

// lkClaimGrants livekit grants 嵌套层（video grant 在 grants.video——签错即连不上）
type lkClaimGrants struct {
	Video *lkVideoGrant `json:"video"`
}

// lkClaims JWT 载荷（与 livekit/protocol/auth AccessTokenClaims 字段对齐：
// sub/name 顶层、video grant 在 grants.video）
type lkClaims struct {
	Name      string        `json:"name,omitempty"`
	Metadata  string        `json:"metadata,omitempty"`
	Grants    lkClaimGrants `json:"grants"`
	Subject   string        `json:"sub"`
	Issuer    string        `json:"iss"`
	JTI       string        `json:"jti"`
	IssuedAt  int64         `json:"iat"`
	NotBefore int64         `json:"nbf"`
	Expires   int64         `json:"exp"`
}

// AccessToken 签发进房凭证：identity 唯一（uid:did，多端各自入房）、room=call_id。
func (p LiveKitParams) AccessToken(identity, name, room string, ttl time.Duration, now time.Time) string {
	claims := lkClaims{
		Name:      name,
		Grants:    lkClaimGrants{Video: &lkVideoGrant{Room: room, RoomJoin: true, CanPublish: true, CanSubscribe: true, CanPublishData: true}},
		Subject:   identity,
		Issuer:    p.APIKey,
		JTI:       randomID(),
		IssuedAt:  now.Unix(),
		NotBefore: now.Unix(),
		Expires:   now.Add(ttl).Unix(),
	}
	header := `{"alg":"HS256","typ":"JWT"}`
	hb, _ := json.Marshal(claims)
	signing := b64url([]byte(header)) + "." + b64url(hb)
	return signing + "." + b64url(hmacSHA256([]byte(p.APISecret), []byte(signing)))
}

// VerifyWebhook 验签 livekit webhook 的 Authorization JWT：签名 + iss + exp 三查
// （载荷哈希不校验——webhook token 仅证明发送方身份，事件体由内网链路承载，登记）。
func (p LiveKitParams) VerifyWebhook(authHeader string, now time.Time) error {
	if !p.Enabled() {
		return errx.New(errx.CodeRTCMediaNodeDown, "媒体面未配置")
	}
	parts := strings.Split(strings.TrimPrefix(authHeader, "Bearer "), ".")
	if len(parts) != 3 {
		return errx.New(errx.CodeAuthTokenRevoked, "webhook 令牌格式非法")
	}
	signing := parts[0] + "." + parts[1]
	want := b64url(hmacSHA256([]byte(p.APISecret), []byte(signing)))
	if !hmac.Equal([]byte(want), []byte(parts[2])) {
		return errx.New(errx.CodeAuthTokenRevoked, "webhook 验签失败")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return errx.New(errx.CodeAuthTokenRevoked, "webhook 令牌载荷非法")
	}
	var c struct {
		Issuer string `json:"iss"`
		Expire int64  `json:"exp"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return errx.New(errx.CodeAuthTokenRevoked, "webhook 令牌载荷非法")
	}
	if c.Issuer != p.APIKey {
		return errx.New(errx.CodeAuthTokenRevoked, "webhook 签发者不匹配")
	}
	if c.Expire != 0 && now.Unix() >= c.Expire {
		return errx.New(errx.CodeAuthTokenRevoked, "webhook 令牌已过期")
	}
	return nil
}

// ---- REST：媒体面配置与进房凭证（D17 §3.2/3.3；DTO 见 rtcapi） ----

// MediaConfig 媒体面配置下发
func (s *Service) MediaConfig() rtcapi.MediaConfigAck {
	return rtcapi.MediaConfigAck{LiveKitURL: s.opts.LK.URL, ICEServers: s.opts.LK.ICEServers}
}

// JoinToken 签发进房凭证（D17 §3.3）：校验 媒体面启用(5003) → 通话进行中(5010) →
// 成员资格(5011：1v1=主/被叫；群=会话成员) → 群席位(5002) → HS256 JWT。
func (s *Service) JoinToken(_ context.Context, uid int64, callID, did string) (*rtcapi.JoinTokenAck, error) {
	if !s.opts.LK.Enabled() {
		return nil, errx.New(errx.CodeRTCMediaNodeDown, "媒体面未配置")
	}
	if !roomIDPattern.MatchString(callID) {
		return nil, errx.New(errx.CodeBadRequest, "call_id 非法")
	}
	call, ok := s.reg.Get(callID)
	if !ok || !call.Active() {
		return nil, errx.New(errx.CodeRTCCallEnded, "通话已结束")
	}
	// 成员资格：1v1=主/被叫；群呼=会话成员可取（加入前先 rtc.join 占席，此处兜底放行）
	if !call.InCall(uid) && !(call.Group && s.opts.IsConvMember != nil && s.opts.IsConvMember(context.Background(), call.ConvID, uid)) {
		return nil, errx.New(errx.CodeRTCNotCallMember, "非通话成员")
	}
	if call.Group {
		if ids := s.regParticipantIDs(callID); len(ids) >= MaxGroupSeats {
			return nil, errx.New(errx.CodeRTCMemberLimit, "通话人数已达上限")
		}
	}
	identity := fmt.Sprintf("%d:%s", uid, sanitizeDid(did))
	return &rtcapi.JoinTokenAck{
		Token:    s.opts.LK.AccessToken(identity, s.nameOf(uid), callID, TokenTTLDefault, s.opts.now()),
		URL:      s.opts.LK.URL,
		Room:     callID,
		Identity: identity,
	}, nil
}

// ---- Webhook：livekit → CallRegistry 同步（D17 §3.4；DTO 见 rtcapi） ----

// HandleWebhook 媒体面事件同步：
//   - participant_joined：群呼未见注册（端侧跳过 rtc.join 直取 token）→ 补占席+广播 joined；
//     MarkConnected（connecting→connected，服务端权威，1v1/群通用，原 rtc.signal 近似判定退役）
//   - participant_left：群=单成员退出（复用 leaveGroup：剩余广播 left，全员退→all_left 窗口）；
//     1v1=任一端离开即整通结束（bye）——端侧崩溃/掉线兜底，正常挂断走 rtc.bye 先到先终结
//   - room_finished：房间回收（全员离开超时）→ 群=all_left；1v1=bye 兜底
func (s *Service) HandleWebhook(ctx context.Context, ev *rtcapi.WebhookEvent) {
	if ev == nil || ev.Room.Name == "" {
		return
	}
	callID := ev.Room.Name
	call, ok := s.reg.Get(callID)
	if !ok || !call.Active() {
		return // 通话已结束/未知房间（livekit 房间生命周期可长于通话注册表）
	}
	switch ev.Event {
	case "participant_joined":
		uid := uidOfIdentity(ev.Participant)
		if uid == 0 {
			return
		}
		if call.Group && !call.InCall(uid) {
			// 端侧未走 rtc.join（卡片直入）：补占席并广播（JoinParticipant 幂等）
			if s.opts.IsConvMember == nil || s.opts.IsConvMember(ctx, call.ConvID, uid) {
				s.reg.JoinParticipant(callID, uid, s.opts.now())
				s.reg.CancelAllLeftTimer(callID)
				s.pushState(s.regParticipantIDs(callID), callID, "joined", "", 0, didOfIdentity(ev.Participant), s.opts.now())
			}
		}
		if s.reg.MarkConnected(callID, s.opts.now()) {
			s.pushState(call.Recipients(), callID, rtcapi.StateConnected, "", 0, "", s.opts.now())
		}
	case "participant_left":
		uid := uidOfIdentity(ev.Participant)
		if uid == 0 {
			return
		}
		if call.Group {
			_ = s.leaveGroup(uid, call)
			return
		}
		if snap, ended := s.reg.End(callID, rtcapi.ReasonBye, s.opts.now()); ended {
			stopTimer(snap)
			s.finishAndNotify(snap, rtcapi.ReasonBye)
		}
	case "room_finished":
		reason := rtcapi.ReasonAllLeft
		if !call.Group {
			reason = rtcapi.ReasonBye
		}
		if snap, ended := s.reg.End(callID, reason, s.opts.now()); ended {
			stopTimer(snap)
			s.finishAndNotify(snap, reason)
		}
	}
}

// uidOfIdentity "10001:dev-device" → 10001（畸形=0）
func uidOfIdentity(p *rtcapi.WebhookParticipant) int64 {
	if p == nil {
		return 0
	}
	head, _, _ := strings.Cut(p.Identity, ":")
	uid, err := strconv.ParseInt(head, 10, 64)
	if err != nil || uid <= 0 {
		return 0
	}
	return uid
}

// didOfIdentity 提取 did 段（缺省空）
func didOfIdentity(p *rtcapi.WebhookParticipant) string {
	if p == nil {
		return ""
	}
	_, did, _ := strings.Cut(p.Identity, ":")
	return did
}

// sanitizeDid did 归一为 LiveKit identity 合法字符（非法字符折叠为 '-'，空回退 "web"）
func sanitizeDid(did string) string {
	var b strings.Builder
	for _, r := range did {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := b.String()
	if out == "" {
		return "web"
	}
	return out
}

func randomID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}
