// Outgoing 投递引擎测试（20 §4.3/§4.4）：三模式匹配 → Enqueue 幂等 →
// 投递成功/退避重试/死信重放 → 订阅停用转 dead。
package botservice

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	botapi "github.com/baobaowork/server/internal/bot/api"
	botrepo "github.com/baobaowork/server/internal/bot/repo"
)

func newOutgoing(t *testing.T) (*Outgoing, botrepo.Repo, *botrepo.MemoryDeliveries, *fakeTransport) {
	t.Helper()
	repo := botrepo.NewMemory()
	dl := botrepo.NewMemoryDeliveries()
	tr := &fakeTransport{}
	now := time.UnixMilli(1760000000000)
	o := NewOutgoing(Options{Now: func() time.Time { return now }}, repo, dl)
	o.SetHTTPDo(tr.do)
	return o, repo, dl, tr
}

func seedBotAndHook(t *testing.T, repo botrepo.Repo, mode string, keywords []string) (botID, hookID int64) {
	t.Helper()
	ctx := context.Background()
	b, err := repo.CreateBot(ctx, botrepo.Bot{TenantID: 1, UserID: 5001, Name: "值班bot", OwnerUserID: 9, Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	cfg := botapi.OutTargetCfg{Mode: mode, Keywords: keywords, ConvIDs: []int64{77}}
	w, err := repo.CreateWebhook(ctx, botrepo.Webhook{
		TenantID: 1, BotID: b.ID, Direction: "out", CallbackURL: "https://oa.example/hook",
		Secret: "out-secret", Status: 1,
		OutTargets: &botrepo.OutTargetCfg{Mode: cfg.Mode, Keywords: cfg.Keywords, ConvIDs: cfg.ConvIDs},
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.ID, w.ID
}

func msgEvent(convID int64, text string, mentions ...string) MsgCreatedLight {
	body, _ := json.Marshal(map[string]any{"text": text})
	return MsgCreatedLight{
		TenantID: 1, MsgID: 9001, ConvID: convID, SenderID: 10001, SenderName: "张三",
		MsgType: "text", Body: body, Mentions: mentions,
	}
}

// 三模式匹配 + 源范围授权
func TestMatchOutgoingModes(t *testing.T) {
	cfg := func(mode string, kw []string) *botapi.OutTargetCfg {
		return &botapi.OutTargetCfg{Mode: mode, Keywords: kw, ConvIDs: []int64{77}}
	}
	ok := msgEvent(77, "投诉处理")
	if !matchOutgoing(cfg(OutModeAll, nil), &ok, 5001) {
		t.Fatal("all 模式授权群应命中")
	}
	other := msgEvent(78, "x")
	if matchOutgoing(cfg(OutModeAll, nil), &other, 5001) {
		t.Fatal("未授权群不应命中")
	}
	complaint := msgEvent(77, "我要投诉")
	if !matchOutgoing(cfg(OutModeKeyword, []string{"投诉", "退款"}), &complaint, 5001) {
		t.Fatal("keyword 命中")
	}
	chatter := msgEvent(77, "正常聊天")
	if matchOutgoing(cfg(OutModeKeyword, []string{"投诉"}), &chatter, 5001) {
		t.Fatal("keyword 未命中")
	}
	atBot := msgEvent(77, "谁值班", "5001")
	if !matchOutgoing(cfg(OutModeAtBot, nil), &atBot, 5001) {
		t.Fatal("@bot 命中（uid=bot user）")
	}
	atOther := msgEvent(77, "谁值班", "10002")
	if matchOutgoing(cfg(OutModeAtBot, nil), &atOther, 5001) {
		t.Fatal("@他人不应命中")
	}
	var nilCfg *botapi.OutTargetCfg
	if matchOutgoing(nilCfg, &ok, 5001) {
		t.Fatal("nil 配置不投")
	}
}

// 全链：匹配 → Enqueue（HMAC 信封投出）→ 2xx → sent + 幂等
func TestOutgoingDeliverSuccess(t *testing.T) {
	o, repo, dl, tr := newOutgoing(t)
	seedBotAndHook(t, repo, OutModeAll, nil)
	o.OnMsgCreated(msgEvent(77, "构建完成"))
	// 重复消费同事件幂等
	o.OnMsgCreated(msgEvent(77, "构建完成"))

	due := o.DeliverDue(context.Background(), 10)
	if due != 1 {
		t.Fatalf("幂等后应仅 1 条待投：%d", due)
	}
	if len(tr.reqs) != 1 {
		t.Fatalf("投递请求数：%d", len(tr.reqs))
	}
	req := tr.reqs[0]
	if req.url != "https://oa.example/hook" {
		t.Fatalf("回调地址：%s", req.url)
	}
	if req.sig == "" || !strings.HasPrefix(req.sig, "sha256=") {
		t.Fatal("HMAC 签名头缺失")
	}
	var env Envelope
	if err := json.Unmarshal(req.body, &env); err != nil || env.Event != "msg.created" {
		t.Fatalf("信封：%v %v", err, env)
	}
	if env.Data.MsgID != 9001 || env.Data.SenderName != "张三" {
		t.Fatalf("信封 data：%+v", env.Data)
	}
	list, _ := dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{})
	if len(list) != 1 || list[0].Status != 2 {
		t.Fatalf("应 sent：%+v", list)
	}
}

// 失败退避：503 → attempt 1 + next_retry 1min；时钟推进重投至 4 次尽 dead
func TestOutgoingRetryBackoffToDead(t *testing.T) {
	o, repo, dl, tr := newOutgoing(t)
	seedBotAndHook(t, repo, OutModeKeyword, []string{"故障"})
	o.OnMsgCreated(msgEvent(77, "线上故障告警"))
	tr.status = 503

	o.DeliverDue(context.Background(), 10) // 第 1 次
	list, _ := dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{})
	d := list[0]
	if d.Attempt != 1 || d.Status != 1 || d.ErrorBrief != "http 503" {
		t.Fatalf("首次失败态：%+v", d)
	}
	// 未到退避时间：泵空转不重投
	o.DeliverDue(context.Background(), 10)
	if l, _ := dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{}); l[0].Attempt != 1 {
		t.Fatal("退避窗口内不应重投")
	}
	// 推进时钟：1min → 第 2 次；5min → 第 3 次；15min → 第 4 次 → dead
	base := time.UnixMilli(1760000000000)
	for i, advance := range []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute} {
		base = base.Add(advance)
		o.opts.Now = func() time.Time { return base }
		o.DeliverDue(context.Background(), 10)
		if l, _ := dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{}); l[0].Attempt != i+2 {
			t.Fatalf("第 %d 轮 attempt 应 %d", i+2, i+2)
		}
	}
	list, _ = dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{})
	if list[0].Status != 3 || list[0].Attempt != 4 {
		t.Fatalf("4 次尽应 dead：%+v", list[0])
	}
	// 死信重放 → pending attempt 归零 → 修好回调再投成功
	tr.status = 200
	if err := o.ReplayDead(context.Background(), 1, list[0].ID); err != nil {
		t.Fatal(err)
	}
	o.DeliverDue(context.Background(), 10)
	if l, _ := dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{}); l[0].Status != 2 {
		t.Fatal("重放后应 sent")
	}
	// 非 dead 态重放拒绝
	if err := o.ReplayDead(context.Background(), 1, list[0].ID); err == nil {
		t.Fatal("sent 态重放应拒绝")
	}
}

// 订阅停用/消失：在途投递转 dead（subscription_gone）
func TestOutgoingDeadOnDisabled(t *testing.T) {
	o, repo, dl, _ := newOutgoing(t)
	_, hookID := seedBotAndHook(t, repo, OutModeAll, nil)
	o.OnMsgCreated(msgEvent(77, "x"))
	// 停用 webhook 后再泵
	if err := repo.UpdateWebhookStatus(context.Background(), 1, hookID, 2); err != nil {
		t.Fatal(err)
	}
	o.DeliverDue(context.Background(), 10)
	list, _ := dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{})
	if len(list) != 1 || list[0].Status != 3 || list[0].ErrorBrief != "subscription_gone_or_disabled" {
		t.Fatalf("停用应转 dead：%+v", list)
	}
}

// bot 停用：不新增投递（20 §4.5）
func TestOutgoingNoEnqueueForDisabledBot(t *testing.T) {
	o, repo, dl, _ := newOutgoing(t)
	botID, _ := seedBotAndHook(t, repo, OutModeAll, nil)
	if err := repo.UpdateBotStatus(context.Background(), 1, botID, 2); err != nil {
		t.Fatal(err)
	}
	o.OnMsgCreated(msgEvent(77, "x"))
	if l, _ := dl.ListDeliveries(context.Background(), 1, botrepo.DeliveryFilter{}); len(l) != 0 {
		t.Fatal("停用 bot 不应入队")
	}
}

// 订阅创建护栏：mode 越界/keyword 缺词/无源范围
func TestCreateOutgoingValidation(t *testing.T) {
	o, repo, _, _ := newOutgoing(t)
	botID, _ := seedBotAndHook(t, repo, OutModeAll, nil)
	ctx := context.Background()
	if _, _, err := o.CreateOutgoingWebhook(ctx, 1, botID, "ftp://x", botapi.OutTargetCfg{Mode: OutModeAll, ConvIDs: []int64{1}}); err == nil {
		t.Fatal("非 http(s) 应拒")
	}
	if _, _, err := o.CreateOutgoingWebhook(ctx, 1, botID, "https://x", botapi.OutTargetCfg{Mode: "sometimes", ConvIDs: []int64{1}}); err == nil {
		t.Fatal("mode 越界应拒")
	}
	if _, _, err := o.CreateOutgoingWebhook(ctx, 1, botID, "https://x", botapi.OutTargetCfg{Mode: OutModeKeyword, ConvIDs: []int64{1}}); err == nil {
		t.Fatal("keyword 缺词应拒")
	}
	if _, _, err := o.CreateOutgoingWebhook(ctx, 1, botID, "https://x", botapi.OutTargetCfg{Mode: OutModeAll}); err == nil {
		t.Fatal("无源范围应拒")
	}
	dto, reveal, err := o.CreateOutgoingWebhook(ctx, 1, botID, "https://oa.example/cb", botapi.OutTargetCfg{
		Mode: OutModeKeyword, Keywords: []string{"工单"}, ConvIDs: []int64{5},
	})
	if err != nil || dto == nil || reveal.Secret == "" {
		t.Fatalf("合法创建：%v", err)
	}
	if dto.OutMode != OutModeKeyword || dto.CallbackURL != "https://oa.example/cb" {
		t.Fatalf("DTO 摘要：%+v", dto)
	}
}

// fakeTransport 投递桩（记录请求；status 可切换）
type fakeTransport struct {
	reqs   []capturedReq
	status int
}

type capturedReq struct {
	url  string
	sig  string
	body []byte
}

func (f *fakeTransport) do(req *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(req.Body)
	f.reqs = append(f.reqs, capturedReq{
		url: req.URL.String(), sig: req.Header.Get("X-BBW-Signature"), body: body,
	})
	code := f.status
	if code == 0 {
		code = 200
	}
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader("{}")),
		Header:     http.Header{},
	}, nil
}
