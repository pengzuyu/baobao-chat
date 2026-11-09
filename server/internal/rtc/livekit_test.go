// livekit.go 单测（D17）：token 载荷契约 / webhook 验签 / JoinToken 校验链 / webhook 同步
package rtc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	errx "github.com/baobaowork/server/internal/platform/errors"
	rtcapi "github.com/baobaowork/server/internal/rtc/api"
)

var testLK = LiveKitParams{URL: "ws://127.0.0.1:7880", APIKey: "bbwtest", APISecret: "test-secret-0123456789abcdef"}

// newLKService 可注入 LK/allLeftWindow 的装配（成员口径同 newTestService：conv=1 alice/bob）
func newLKService(lk LiveKitParams, allLeft time.Duration) (*Service, *fakePush, *fakeCard) {
	p := &fakePush{}
	card := &fakeCard{}
	members := map[int64]bool{10001: true, 10002: true}
	svc := New(NewRegistry(), p, card, Options{
		IsConvActive:  func(_ context.Context, convID int64) bool { return convID == 1 || convID == 2 },
		IsConvMember:  func(_ context.Context, _, uid int64) bool { return members[uid] },
		NameOf:        func(id int64) string { return "user-" + string(rune('0'+id%10)) },
		AllLeftWindow: allLeft,
		LK:            lk,
		Now:           func() time.Time { return time.UnixMilli(1760000000000) },
	})
	return svc, p, card
}

func decodeJWTPayload(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT 应为三段: %q", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("payload 解码: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("payload 反序列化: %v", err)
	}
	return m
}

// token 载荷与 livekit/protocol/auth 对齐（grants.video 嵌套层签错即连不上——契约钉死）
func TestAccessTokenClaims(t *testing.T) {
	now := time.UnixMilli(1760000000000)
	tok := testLK.AccessToken("10001:dev-device", "张三", "call-abc-1", 4*time.Hour, now)
	m := decodeJWTPayload(t, tok)
	if m["sub"] != "10001:dev-device" || m["name"] != "张三" || m["iss"] != "bbwtest" {
		t.Fatalf("基础声明不符: %v", m)
	}
	grants, ok := m["grants"].(map[string]any)
	if !ok {
		t.Fatalf("缺 grants 嵌套层: %v", m)
	}
	video, ok := grants["video"].(map[string]any)
	if !ok {
		t.Fatalf("缺 grants.video: %v", grants)
	}
	if video["room"] != "call-abc-1" || video["roomJoin"] != true ||
		video["canPublish"] != true || video["canSubscribe"] != true || video["canPublishData"] != true {
		t.Fatalf("video grant 不符: %v", video)
	}
	if int64(m["exp"].(float64)) != now.Add(4*time.Hour).Unix() {
		t.Fatalf("exp 不符: %v", m["exp"])
	}
	// 同源验签（webhook 验签器与 access token 同为 HS256+iss 口径）
	if err := testLK.VerifyWebhook(tok, now.Add(time.Minute)); err != nil {
		t.Fatalf("同源验签应通过: %v", err)
	}
}

func TestVerifyWebhook(t *testing.T) {
	now := time.UnixMilli(1760000000000)
	tok := testLK.AccessToken("x", "y", "r", time.Hour, now)
	if err := testLK.VerifyWebhook(tok, now); err != nil {
		t.Fatalf("合法令牌应通过: %v", err)
	}
	// 篡改签名
	bad := tok[:len(tok)-2] + "aa"
	if code := codeOf(t, testLK.VerifyWebhook(bad, now)); code != int(errx.CodeAuthTokenRevoked) {
		t.Fatalf("篡改签名应 1004: %d", code)
	}
	// 异密钥签发
	other := LiveKitParams{URL: "u", APIKey: "bbwtest", APISecret: "another-secret-0123456789"}
	if code := codeOf(t, other.VerifyWebhook(tok, now)); code != int(errx.CodeAuthTokenRevoked) {
		t.Fatalf("异密钥应 1004: %d", code)
	}
	// 过期
	if code := codeOf(t, testLK.VerifyWebhook(tok, now.Add(2*time.Hour))); code != int(errx.CodeAuthTokenRevoked) {
		t.Fatalf("过期应 1004: %d", code)
	}
	// 未配置媒体面
	if code := codeOf(t, LiveKitParams{}.VerifyWebhook(tok, now)); code != int(errx.CodeRTCMediaNodeDown) {
		t.Fatalf("未配置应 5003: %d", code)
	}
}

func TestJoinToken(t *testing.T) {
	ctx := context.Background()
	svc, _, _ := newLKService(testLK, time.Hour)

	// 媒体面未配置 → 5003
	svc2, _, _ := newLKService(LiveKitParams{}, time.Hour)
	_, jtErr := svc2.JoinToken(ctx, 10001, "ca-t", "")
	if code := codeOf(t, jtErr); code != int(errx.CodeRTCMediaNodeDown) {
		t.Fatalf("未配置应 5003: %d", code)
	}
	// 通话不存在 → 5010
	_, jtErr = svc.JoinToken(ctx, 10001, "ca-none", "")
	if code := codeOf(t, jtErr); code != int(errx.CodeRTCCallEnded) {
		t.Fatalf("不存在应 5010: %d", code)
	}
	// call_id 非法（room 字符集）
	_, jtErr = svc.JoinToken(ctx, 10001, "bad id!", "")
	if code := codeOf(t, jtErr); code != int(errx.CodeBadRequest) {
		t.Fatalf("非法 call_id 应 400: %d", code)
	}

	// 1v1：被叫可取；无关成员 5011
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{CallID: "ca-t1", ConvID: "1", CalleeID: "10002", CallType: rtcapi.CallTypeAudio}); err != nil {
		t.Fatalf("invite: %v", err)
	}
	_, jtErr = svc.JoinToken(ctx, 99999, "ca-t1", "")
	if code := codeOf(t, jtErr); code != int(errx.CodeRTCNotCallMember) {
		t.Fatalf("非成员应 5011: %d", code)
	}
	ack, err := svc.JoinToken(ctx, 10002, "ca-t1", "dev-device")
	if err != nil {
		t.Fatalf("被叫取 token: %v", err)
	}
	if ack.Room != "ca-t1" || ack.Identity != "10002:dev-device" || ack.URL != testLK.URL || ack.Token == "" {
		t.Fatalf("ack 不符: %+v", ack)
	}
	if m := decodeJWTPayload(t, ack.Token); m["sub"] != "10002:dev-device" {
		t.Fatalf("token sub 不符: %v", m["sub"])
	}

	// 群呼：会话成员可取（未 rtc.join 兜底放行）；席位满 5002
	// （先结束上面 1v1——主叫忙线 5004 判定按用户全集）
	if err := svc.Bye(ctx, 10001, rtcapi.CallIDPayload{CallID: "ca-t1"}); err != nil {
		t.Fatalf("bye: %v", err)
	}
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{CallID: "cg-t1", ConvID: "2", CallType: rtcapi.CallTypeVideo}); err != nil {
		t.Fatalf("群 invite: %v", err)
	}
	ack2, err := svc.JoinToken(ctx, 10002, "cg-t1", "")
	if err != nil || ack2.Room != "cg-t1" {
		t.Fatalf("群成员取 token: %+v %v", ack2, err)
	}
	_, jtErr = svc.JoinToken(ctx, 99999, "cg-t1", "")
	if code := codeOf(t, jtErr); code != int(errx.CodeRTCNotCallMember) {
		t.Fatalf("群非会话成员应 5011: %d", code)
	}
	// 填满 64 席（主叫已占 1，再灌 63）
	call, _ := svc.reg.Get("cg-t1")
	for i := 0; i < 63; i++ {
		svc.reg.JoinParticipant("cg-t1", int64(20000+i), time.Now())
	}
	if len(call.Participants) != 64 {
		t.Fatalf("预填席位不符: %d", len(call.Participants))
	}
	_, jtErr = svc.JoinToken(ctx, 10002, "cg-t1", "")
	if code := codeOf(t, jtErr); code != int(errx.CodeRTCMemberLimit) {
		t.Fatalf("席位满应 5002: %d", code)
	}
}

func webhookEv(event, room, identity string) *rtcapi.WebhookEvent {
	ev := &rtcapi.WebhookEvent{Event: event}
	ev.Room.Name = room
	if identity != "" {
		ev.Participant = &rtcapi.WebhookParticipant{Identity: identity, Name: "p"}
	}
	return ev
}

// webhook participant_joined → connected（服务端权威，原 rtc.signal 近似判定退役）
func TestWebhookJoinedConnected(t *testing.T) {
	ctx := context.Background()
	svc, push, _ := newLKService(testLK, time.Hour)
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{CallID: "cw-1", ConvID: "1", CalleeID: "10002", CallType: rtcapi.CallTypeAudio}); err != nil {
		t.Fatalf("invite: %v", err)
	}
	if err := svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "cw-1", Answer: true, DID: "d1"}); err != nil {
		t.Fatalf("accept: %v", err)
	}
	svc.HandleWebhook(ctx, webhookEv("participant_joined", "cw-1", "10001:d1"))
	states := push.of("rtc.state")
	found := false
	for _, s := range states {
		if strings.Contains(s, `"kind":"connected"`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("应推 connected: %v", states)
	}
	// 重复 joined 幂等（不重复推 connected）
	svc.HandleWebhook(ctx, webhookEv("participant_joined", "cw-1", "10002:d2"))
	if n := strings.Count(strings.Join(push.of("rtc.state"), "\n"), `"kind":"connected"`); n != 1 {
		t.Fatalf("connected 应仅推一次: %d", n)
	}
}

// webhook participant_left（1v1）→ 整通结束（bye）+ 卡片回写——掉线/崩溃兜底
func TestWebhookLeft1v1Ends(t *testing.T) {
	ctx := context.Background()
	svc, push, card := newLKService(testLK, time.Hour)
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{CallID: "cw-2", ConvID: "1", CalleeID: "10002", CallType: rtcapi.CallTypeAudio}); err != nil {
		t.Fatalf("invite: %v", err)
	}
	_ = svc.Accept(ctx, 10002, rtcapi.AcceptPayload{CallID: "cw-2", Answer: true})
	svc.HandleWebhook(ctx, webhookEv("participant_left", "cw-2", "10001:d1"))
	states := push.of("rtc.state")
	ended := false
	for _, s := range states {
		if strings.Contains(s, `"kind":"ended"`) && strings.Contains(s, `"reason":"bye"`) {
			ended = true
		}
	}
	if !ended || card.finish == 0 {
		t.Fatalf("应 ended(bye)+卡片回写: ended=%v finish=%d", ended, card.finish)
	}
	// 再 left（迟到事件）：注册表已回收，静默
	svc.HandleWebhook(ctx, webhookEv("participant_left", "cw-2", "10002:d2"))
}

// webhook 群呼：join 补占席+广播 → left 广播 → 全员退 → all_left 窗口结束
func TestWebhookGroupLifecycle(t *testing.T) {
	ctx := context.Background()
	svc, push, card := newLKService(testLK, 10*time.Millisecond)
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{CallID: "cg-w", ConvID: "1", CallType: rtcapi.CallTypeVideo}); err != nil {
		t.Fatalf("群 invite: %v", err)
	}
	// 成员未走 rtc.join 直连媒体面：webhook 补占席 + joined 广播
	svc.HandleWebhook(ctx, webhookEv("participant_joined", "cg-w", "10002:dev-device"))
	joined := false
	for _, s := range push.of("rtc.state") {
		if strings.Contains(s, `"kind":"joined"`) {
			joined = true
		}
	}
	if !joined {
		t.Fatal("应广播 joined")
	}
	// 双双退出 → all_left 窗口 → ended(all_left) + 卡片
	svc.HandleWebhook(ctx, webhookEv("participant_left", "cg-w", "10001:d1"))
	svc.HandleWebhook(ctx, webhookEv("participant_left", "cg-w", "10002:dev-device"))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, s := range push.of("rtc.state") {
			if strings.Contains(s, `"reason":"all_left"`) && card.finish > 0 {
				return // 通过
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("all_left 结束未产生: states=%v finish=%d", push.of("rtc.state"), card.finish)
}

// room_finished 兜底：群呼房间回收 → all_left；未知房间静默
func TestWebhookRoomFinished(t *testing.T) {
	ctx := context.Background()
	svc, push, _ := newLKService(testLK, time.Hour)
	svc.HandleWebhook(ctx, webhookEv("room_finished", "unknown-room", "")) // 未知：静默
	if n := len(push.of("rtc.state")); n != 0 {
		t.Fatalf("未知房间不应推送: %v", push.of("rtc.state"))
	}
	if _, err := svc.Invite(ctx, 10001, rtcapi.InvitePayload{CallID: "cg-f", ConvID: "1", CallType: rtcapi.CallTypeAudio}); err != nil {
		t.Fatalf("群 invite: %v", err)
	}
	svc.HandleWebhook(ctx, webhookEv("room_finished", "cg-f", ""))
	found := false
	for _, s := range push.of("rtc.state") {
		if strings.Contains(s, `"reason":"all_left"`) {
			found = true
		}
	}
	if !found {
		t.Fatal("room_finished 群呼应 all_left 结束")
	}
}
