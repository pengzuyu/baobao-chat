// 服务层契约测试：Incoming 投递管线七步（20 篇 §4.2）+ 凭证生命周期 +
// 会话安装权限。HMAC/宽限/限流用注入时钟与同包签名函数构造精确态。
package botservice

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	botapi "github.com/baobaowork/server/internal/bot/api"
	"github.com/baobaowork/server/internal/bot/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

type fixture struct {
	svc    *Service
	now    time.Time
	sent   []sentMsg        // SendMsg 闭包观测
	audits []AuditEntry     // 审计观测
	roles  map[[2]int64]int // (conv,uid) → role
	words  []string
}

type sentMsg struct {
	sender  int64
	conv    int64
	typ     string
	body    json.RawMessage
	mention []string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{
		now:   time.Unix(1760000000, 0),
		roles: map[[2]int64]int{},
	}
	f.svc = NewService(Options{
		CreateUser: func(context.Context, int64, string) (int64, error) { return 777, nil },
		MemberRole: func(_ context.Context, convID, userID int64) int {
			return f.roles[[2]int64{convID, userID}]
		},
		AddMember: func(_ context.Context, convID, userID int64, _ int) error {
			f.roles[[2]int64{convID, userID}] = botapi.MemberRoleBot
			return nil
		},
		RemoveMember: func(_ context.Context, convID, userID int64) error {
			delete(f.roles, [2]int64{convID, userID})
			return nil
		},
		SendMsg: func(_ context.Context, senderID, convID int64, typ string, body json.RawMessage, mention []string) (int64, int64, error) {
			f.sent = append(f.sent, sentMsg{senderID, convID, typ, body, mention})
			return 501, 13, nil
		},
		SensitiveWords: func() []string { return f.words },
		Audit:          func(e AuditEntry) { f.audits = append(f.audits, e) },
		Now:            func() time.Time { return f.now },
		GracePeriod:    24 * time.Hour,
	}, botrepo.NewMemory())
	return f
}

// readyBot 建 bot + 启用 + 装 webhook + 装进会话（默认会话 9，授权集 {9}）
func (f *fixture) readyBot(t *testing.T, convID int64) (*botapi.BotDTO, *botapi.SecretReveal) {
	t.Helper()
	b, err := f.svc.CreateBot(context.Background(), 1, 42, botapi.CreateBotReq{Name: "CI 助手"})
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	if b.Status != botapi.StatusDisabled {
		t.Fatal("建即停用（装凭证前不可用，§4.1-②）")
	}
	if err := f.svc.SetBotStatus(context.Background(), 1, 42, b.ID, true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	_, reveal, err := f.svc.CreateIncomingWebhook(context.Background(), 1, b.ID,
		botapi.CreateWebhookReq{DefaultConvID: convID, Targets: []int64{convID}})
	if err != nil {
		t.Fatalf("CreateIncomingWebhook: %v", err)
	}
	f.roles[[2]int64{convID, 777}] = botapi.MemberRoleBot
	return b, reveal
}

func (f *fixture) sign(secret, ts string, body string) string {
	return "sha256=" + hmacSHA256Hex(secret, ts, []byte(body))
}

func (f *fixture) deliver(t *testing.T, reveal *botapi.SecretReveal, body string) (botapi.DeliverResult, error) {
	t.Helper()
	return f.deliverAt(t, reveal, body, f.now.Unix())
}

func (f *fixture) deliverAt(t *testing.T, reveal *botapi.SecretReveal, body string, ts int64) (botapi.DeliverResult, error) {
	t.Helper()
	tsRaw := strconv.FormatInt(ts, 10)
	return f.svc.Deliver(context.Background(), reveal.HookID, tsRaw,
		f.sign(reveal.Secret, tsRaw, body), []byte(body), "10.0.0.5")
}

func codeOf(t *testing.T, err error) errx.Code {
	t.Helper()
	if err == nil {
		t.Fatal("期望错误")
	}
	return errx.From(err).Code
}

/// ── 投递管线 ──

func TestDeliverHappyPathText(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)
	body := `{"msg_type":"text","target":{"conv_id":"9"},"text":"构建完成"}`
	res, err := f.deliver(t, reveal, body)
	if err != nil {
		t.Fatalf("投递失败: %v", err)
	}
	if res.MsgID != 501 || res.Seq != 13 {
		t.Fatalf("回执: %+v", res)
	}
	if len(f.sent) != 1 || f.sent[0].sender != 777 || f.sent[0].conv != 9 || f.sent[0].typ != "text" {
		t.Fatalf("SendMsg 参数: %+v", f.sent)
	}
	if !f.audits[len(f.audits)-1].OK || f.audits[len(f.audits)-1].Action != "deliver" {
		t.Fatalf("审计: %+v", f.audits)
	}
}

func TestDeliverDefaultConvWhenTargetOmitted(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)
	res, err := f.deliver(t, reveal, `{"msg_type":"text","text":"默认会话"}`)
	if err != nil {
		t.Fatalf("省略 target 应发默认会话: %v", err)
	}
	_ = res
	if f.sent[0].conv != 9 {
		t.Fatalf("应发默认会话 9: %+v", f.sent)
	}
}

func TestDeliverBotCardWithMentions(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)
	body := `{"msg_type":"bot_card","card":{"title":"流水线 #1284 失败","sections":[{"k":"分支","v":"feat/x"}],"links":[{"label":"日志","url":"https://ci.example.com/1284"}],"at_user_ids":["31"],"level":"error"}}`
	if _, err := f.deliver(t, reveal, body); err != nil {
		t.Fatalf("bot_card 投递: %v", err)
	}
	if f.sent[0].typ != "bot_card" || len(f.sent[0].mention) != 1 || f.sent[0].mention[0] != "31" {
		t.Fatalf("bot_card 发送参数: %+v", f.sent)
	}
}

func TestDeliverRejectsBadSignatureTimestampIP(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)
	body := `{"msg_type":"text","text":"x"}`

	// 签名不匹配 → 3030
	if _, err := f.svc.Deliver(context.Background(), reveal.HookID,
		strconv.FormatInt(f.now.Unix(), 10), "sha256="+strings.Repeat("0", 64), []byte(body), "10.0.0.5"); codeOf(t, err) != errx.CodeIMBotCredential {
		t.Fatal("坏签名应 3030")
	}
	// ts 越窗（>5min）→ 3030
	if _, err := f.deliverAt(t, reveal, body, f.now.Unix()-301); codeOf(t, err) != errx.CodeIMBotCredential {
		t.Fatal("防重放应 3030")
	}
	// 未知 hook → 3030
	if _, err := f.svc.Deliver(context.Background(), "nope", strconv.FormatInt(f.now.Unix(), 10), "", []byte("{}"), "10.0.0.5"); codeOf(t, err) != errx.CodeIMBotCredential {
		t.Fatal("未知 hook 应 3030")
	}
}

func TestDeliverTargetNotAuthorized(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)                     // 授权集 {9}
	f.roles[[2]int64{10, 777}] = botapi.MemberRoleBot // 会话 10 有成员但未授权
	body := `{"msg_type":"text","target":{"conv_id":"10"},"text":"x"}`
	if _, err := f.deliver(t, reveal, body); codeOf(t, err) != errx.CodeIMBotTargetDenied {
		t.Fatal("未授权目标应 3031")
	}
}

func TestDeliverBotNotMemberAnymore(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)
	delete(f.roles, [2]int64{9, 777}) // 被移出会话
	body := `{"msg_type":"text","text":"x"}`
	if _, err := f.deliver(t, reveal, body); codeOf(t, err) != errx.CodeIMBotTargetDenied {
		t.Fatal("非成员应 3031（§4.2-④ bot 仍是该会话成员）")
	}
}

func TestDeliverRateLimited(t *testing.T) {
	f := newFixture(t)
	b, _ := f.readyBot(t, 9)
	// 直接建一个 10/min 的 webhook（CreateWebhookReq 最小 10）
	_, reveal, err := f.svc.CreateIncomingWebhook(context.Background(), 1, b.ID,
		botapi.CreateWebhookReq{DefaultConvID: 9, RateLimit: 10})
	if err != nil {
		t.Fatalf("webhook: %v", err)
	}
	body := `{"msg_type":"text","text":"x"}`
	for i := 0; i < 10; i++ {
		if _, err := f.deliver(t, reveal, body); err != nil {
			t.Fatalf("第 %d 次不应限流: %v", i+1, err)
		}
	}
	if _, err := f.deliver(t, reveal, body); codeOf(t, err) != errx.CodeIMBotRateLimited {
		t.Fatal("第 11 次应 3032")
	}
	// 审计记录限流拒绝
	last := f.audits[len(f.audits)-1]
	if last.OK || last.ErrCode != "3032" {
		t.Fatalf("限流审计: %+v", last)
	}
	// 次分钟窗口重置
	f.now = f.now.Add(time.Minute)
	if _, err := f.deliver(t, reveal, body); err != nil {
		t.Fatalf("新窗口应放行: %v", err)
	}
}

func TestDeliverSensitiveWordBlocked(t *testing.T) {
	f := newFixture(t)
	f.words = []string{"机密词"}
	_, reveal := f.readyBot(t, 9)
	if _, err := f.deliver(t, reveal, `{"msg_type":"text","text":"含机密词的内容"}`); codeOf(t, err) != errx.CodeIMSensitiveBlocked {
		t.Fatal("敏感词应 3005（机器发送不豁免，§7.2）")
	}
	if len(f.sent) != 0 {
		t.Fatal("拦截不得触达消息主干")
	}
}

func TestDeliverDisabledBotRejected(t *testing.T) {
	f := newFixture(t)
	b, reveal := f.readyBot(t, 9)
	if err := f.svc.SetBotStatus(context.Background(), 1, 42, b.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.deliver(t, reveal, `{"msg_type":"text","text":"x"}`); codeOf(t, err) != errx.CodeIMBotCredential {
		t.Fatal("停用 bot 应 3030（即时失效）")
	}
}

func TestDeliverCardValidation(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)
	cases := []string{
		`{"msg_type":"bot_card","card":{"level":"fatal","title":"t"}}`,                           // 非法 level
		`{"msg_type":"bot_card","card":{"title":"t","sections":[` + sections21() + `]}}`,         // sections>20
		`{"msg_type":"bot_card","card":{"title":"t","links":[{"label":"x","url":"ftp://bad"}]}}`, // 非 http
		`{"msg_type":"bot_card","card":{}}`,                                                      // 缺 title
		`{"msg_type":"image"}`,                                                                   // 未知类型
	}
	for i, body := range cases {
		if _, err := f.deliver(t, reveal, body); codeOf(t, err) != errx.CodeBadRequest {
			t.Fatalf("用例 %d 应 9001: %v", i, err)
		}
	}
	// 空 text 走内容口径 3004（text ≤5000 字约束）
	if _, err := f.deliver(t, reveal, `{"msg_type":"text","text":""}`); codeOf(t, err) != errx.CodeIMContentTooLong {
		t.Fatal("空 text 应 3004")
	}
}

func sections21() string {
	parts := make([]string, 21)
	for i := range parts {
		parts[i] = `{"k":"k","v":"v"}`
	}
	return strings.Join(parts, ",")
}

/// ── 凭证轮换 ──

func TestRotateSecretGraceWindow(t *testing.T) {
	f := newFixture(t)
	_, reveal := f.readyBot(t, 9)
	body := `{"msg_type":"text","text":"x"}`

	// 轮换：新 secret 立即可用
	newReveal, err := f.svc.RotateSecret(context.Background(), 1, reveal.WebhookID)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if newReveal.Secret == reveal.Secret {
		t.Fatal("轮换应产生新 secret")
	}
	if _, err := f.deliver(t, newReveal, body); err != nil {
		t.Fatalf("新 secret 应立即生效: %v", err)
	}
	// 旧 secret 宽限期内仍可用（24h 双验签）
	if _, err := f.deliver(t, reveal, body); err != nil {
		t.Fatalf("宽限期内旧 secret 应可用: %v", err)
	}
	// 宽限期过后旧 secret 失效
	f.now = f.now.Add(25 * time.Hour)
	if _, err := f.deliver(t, reveal, body); codeOf(t, err) != errx.CodeIMBotCredential {
		t.Fatal("宽限期后旧 secret 应 3030")
	}
	if _, err := f.deliver(t, newReveal, body); err != nil {
		t.Fatalf("新 secret 不受宽限期影响: %v", err)
	}
}

/// ── 会话安装 ──

func TestInstallRequiresGroupAdmin(t *testing.T) {
	f := newFixture(t)
	b, _ := f.readyBot(t, 9)
	// actor 非群主/群管 → 403
	f.roles[[2]int64{9, 42}] = 3 // member
	if err := f.svc.Install(context.Background(), 1, 42, 9, b.ID); codeOf(t, err) != errx.CodePermACLDenied {
		t.Fatal("普通成员安装应拒绝")
	}
	// 群主 → OK，bot 以 role=bot 入会
	f.roles[[2]int64{9, 42}] = 1
	if err := f.svc.Install(context.Background(), 1, 42, 9, b.ID); err != nil {
		t.Fatalf("群主安装: %v", err)
	}
	if f.roles[[2]int64{9, 777}] != botapi.MemberRoleBot {
		t.Fatal("bot 应以 role=bot 入会")
	}
}
