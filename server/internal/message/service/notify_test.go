// 通知中心生成/聚合/读写测试（D03 §3.9 PIM-09）：
//   - 四源生成：mention（显式 uid + all 全员命中）/ reply（引用目标作者）/ apply（owner+admin）/
//     announcement（全体成员，含广播群 broadcast.published）
//   - 聚合：同 (user,kind,conv) 10s 窗口合并 count+1 不新增行；时钟推进 11s 后开新行；
//     不同 kind / 已读行不合并
//   - 已读：单条 ids / 全部 all；unread 计数
//   - 越权：第二用户读不到本人通知（列表/计数/已读均按 userID 过滤）
//   - WS 事件：生成成功发布 notification.new（payload 含 id/kind/count）
package messageservice

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/baobaowork/server/internal/message/api"
	"github.com/baobaowork/server/internal/message/repo"
	"github.com/baobaowork/server/internal/platform/eventbus"
)

// fakeClock 时钟注入（Options.Now）：窗口判定/已读时间戳可测
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// seedNotifyFixture 群 conv1：alice=10001(owner)/bob=10002(member)/carol=10003(admin)/dave=10004(member)
// 广播群 conv2：alice=member、root=10005(publisher)
func seedNotifyFixture(t *testing.T) (*Service, *messagerepo.Memory, *eventbus.InMemory, *fakeClock) {
	t.Helper()
	r := messagerepo.NewMemory()
	bus := eventbus.New()
	clk := &fakeClock{now: time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)}
	svc := New(Options{Now: clk.Now}, r, bus)
	ctx := context.Background()

	c1, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvGroup, Name: "项目组"})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []messagerepo.Member{
		{ConvID: c1.ID, UserID: 10001, Role: messageapi.MemberOwner, Status: 1},
		{ConvID: c1.ID, UserID: 10002, Role: messageapi.MemberMember, Status: 1},
		{ConvID: c1.ID, UserID: 10003, Role: messageapi.MemberAdmin, Status: 1},
		{ConvID: c1.ID, UserID: 10004, Role: messageapi.MemberMember, Status: 1},
	} {
		if err := r.AddMember(ctx, m); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.UpsertGroupSetting(ctx, messagerepo.DefaultGroupSetting(c1.ID)); err != nil {
		t.Fatal(err)
	}

	c2, err := r.CreateConversation(ctx, messagerepo.Conversation{TenantID: 1, Type: messageapi.ConvBroadcast, Name: "全员大群"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AddMember(ctx, messagerepo.Member{ConvID: c2.ID, UserID: 10001, Role: messageapi.MemberMember, Status: 1}); err != nil {
		t.Fatal(err)
	}
	if err := r.AddMember(ctx, messagerepo.Member{ConvID: c2.ID, UserID: 10005, Role: messageapi.MemberPublisher, Status: 1}); err != nil {
		t.Fatal(err)
	}
	return svc, r, bus, clk
}

// mentionPayload 带 mentions 的发送载荷
func mentionPayload(conv int64, cmid, text string, ms ...messageapi.Mention) messageapi.SendPayload {
	body, _ := json.Marshal(map[string]string{"text": text})
	return messageapi.SendPayload{
		ConvID: messageapi.ConvID(strconv.FormatInt(conv, 10)), ClientMsgID: cmid,
		Type: "text", Body: body, Mentions: ms,
	}
}

// listFor 列表查询捷径
func listFor(t *testing.T, svc *Service, uid int64, kind string, unreadOnly bool) []messageapi.NotificationItem {
	t.Helper()
	res, err := svc.ListNotifications(context.Background(), uid, kind, unreadOnly, 0, 50)
	if err != nil {
		t.Fatalf("list uid=%d kind=%s: %v", uid, kind, err)
	}
	return res.Items
}

// ── ① mention：显式 uid 命中（发送者/未提及者不生成）──
func TestNotifyMentionDirect(t *testing.T) {
	svc, _, _, _ := seedNotifyFixture(t)
	ctx := context.Background()
	if _, err := svc.Send(ctx, 10001, mentionPayload(1, "m-1", "请在周五前提交",
		messageapi.Mention{UID: "10002"})); err != nil {
		t.Fatal(err)
	}
	items := listFor(t, svc, 10002, "mention", false)
	if len(items) != 1 {
		t.Fatalf("bob 应恰 1 条 mention 通知, got %d", len(items))
	}
	if items[0].Title == "" || items[0].Digest != "请在周五前提交" || items[0].Count != 1 {
		t.Fatalf("通知内容不符: %+v", items[0])
	}
	if items[0].Seq == 0 || items[0].ConvID != "1" {
		t.Fatalf("mention 应携带定位依据 conv/seq: %+v", items[0])
	}
	// 发送者本人与未提及者无通知
	if got := listFor(t, svc, 10001, "", false); len(got) != 0 {
		t.Fatalf("发送者不应生成通知, got %d", len(got))
	}
	if got := listFor(t, svc, 10003, "", false); len(got) != 0 {
		t.Fatalf("未提及者不应生成通知, got %d", len(got))
	}
}

// ── ① mention：all 命中全员（owner 发 @全体，策略默认=仅管理放行）──
func TestNotifyMentionAll(t *testing.T) {
	svc, _, _, _ := seedNotifyFixture(t)
	ctx := context.Background()
	if _, err := svc.Send(ctx, 10001, mentionPayload(1, "m-all", "全员周会",
		messageapi.Mention{All: true})); err != nil {
		t.Fatal(err)
	}
	// bob/carol/dave 各 1 条；发送者 alice 无
	for _, uid := range []int64{10002, 10003, 10004} {
		if got := listFor(t, svc, uid, "mention", false); len(got) != 1 {
			t.Fatalf("uid=%d @全体应生成 1 条 mention, got %d", uid, len(got))
		}
	}
	if got := listFor(t, svc, 10001, "mention", false); len(got) != 0 {
		t.Fatalf("发送者不应自通知, got %d", len(got))
	}
}

// ── ① reply：引用目标消息作者收 kind=reply（提及旁路不触发 mention）──
func TestNotifyReplyTargetAuthor(t *testing.T) {
	svc, _, _, _ := seedNotifyFixture(t)
	ctx := context.Background()
	base, err := svc.Send(ctx, 10002, textPayload(1, "bob-1", "我的疑问是…"))
	if err != nil {
		t.Fatal(err)
	}
	p := textPayload(1, "alice-r1", "答复如上")
	p.ReplyToSeq = base.Seq
	if _, err := svc.Send(ctx, 10001, p); err != nil {
		t.Fatal(err)
	}
	items := listFor(t, svc, 10002, "reply", false)
	if len(items) != 1 {
		t.Fatalf("bob 应恰 1 条 reply 通知, got %d", len(items))
	}
	if items[0].Seq != base.Seq+1 {
		t.Fatalf("reply 通知应定位到回复消息 seq, want %d got %d", base.Seq+1, items[0].Seq)
	}
	// 引用者本人无 reply 通知；回复不触发 mention
	if got := listFor(t, svc, 10001, "", false); len(got) != 0 {
		t.Fatalf("回复者不应生成通知, got %d", len(got))
	}
	if got := listFor(t, svc, 10002, "mention", false); len(got) != 0 {
		t.Fatalf("纯回复不应生成 mention, got %d", len(got))
	}
	// 自回复（bob 引用自己消息）不通知
	self, err := svc.Send(ctx, 10002, textPayload(1, "bob-2", "补充"))
	if err != nil {
		t.Fatal(err)
	}
	p2 := textPayload(1, "bob-3", "自回复")
	p2.ReplyToSeq = self.Seq
	if _, err := svc.Send(ctx, 10002, p2); err != nil {
		t.Fatal(err)
	}
	if got := listFor(t, svc, 10002, "reply", false); len(got) != 1 {
		t.Fatalf("自回复不应新增通知, got %d", len(got))
	}
}

// ── ② apply：owner+admin 收 kind=apply；普通成员/申请人无 ──
func TestNotifyApplyToOwnerAdmin(t *testing.T) {
	svc, r, _, _ := seedNotifyFixture(t)
	ctx := context.Background()
	// 外部申请者（10006 非成员；10004 是在群成员会被 3012 拒）
	if err := r.AddMember(ctx, messagerepo.Member{ConvID: 999, UserID: 10006, Status: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApplyJoin(ctx, 10006, messageapi.ApplyPayload{
		ConvID: "1", Reason: "想加入项目组",
	}); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []int64{10001, 10003} {
		items := listFor(t, svc, uid, "apply", false)
		if len(items) != 1 {
			t.Fatalf("uid=%d(owner/admin) 应收 1 条 apply 通知, got %d", uid, len(items))
		}
		if items[0].Digest != "想加入项目组" {
			t.Fatalf("apply 通知 digest 应为申请理由: %+v", items[0])
		}
	}
	if got := listFor(t, svc, 10002, "apply", false); len(got) != 0 {
		t.Fatalf("普通成员不应收 apply 通知, got %d", len(got))
	}
	// apply.submitted 系统消息本身不进通知中心（kind 不出现在任何分组）
	if got := listFor(t, svc, 10001, "mention", false); len(got) != 0 {
		t.Fatalf("系统消息不应生成 mention, got %d", len(got))
	}
}

// ── ③ announcement：公告变更/广播发布 → 全体在群成员（操作者除外）──
func TestNotifyAnnouncementToMembers(t *testing.T) {
	svc, _, _, _ := seedNotifyFixture(t)
	ctx := context.Background()
	anno := "本周五 18:00 例会改线上"
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: "1", Announcement: &anno,
	}); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []int64{10002, 10003, 10004} {
		items := listFor(t, svc, uid, "announcement", false)
		if len(items) != 1 {
			t.Fatalf("uid=%d 应收 1 条公告通知, got %d", uid, len(items))
		}
		if items[0].Digest != anno {
			t.Fatalf("公告 digest 不符: %+v", items[0])
		}
	}
	if got := listFor(t, svc, 10001, "announcement", false); len(got) != 0 {
		t.Fatalf("操作者不应自通知, got %d", len(got))
	}
	// 广播群：publisher 发布 → 成员收「发布了新公告」
	broad := "全员系统升级通知"
	if err := svc.UpdateConvSetting(ctx, 10005, messageapi.ConvSettingPayload{
		ConvID: "2", Announcement: &broad,
	}); err != nil {
		t.Fatal(err)
	}
	items := listFor(t, svc, 10001, "announcement", false)
	if len(items) != 1 || items[0].Title != "「全员大群」发布了新公告" {
		t.Fatalf("广播群公告通知不符: %+v", items)
	}
}

// ── 聚合：10s 窗口合并 count+1 不增行；11s 后新行；跨 kind/已读行不合并 ──
func TestNotifyMergeWindow(t *testing.T) {
	svc, _, _, clk := seedNotifyFixture(t)
	ctx := context.Background()
	sendMention := func(cmid, text string) {
		t.Helper()
		if _, err := svc.Send(ctx, 10001, mentionPayload(1, cmid, text,
			messageapi.Mention{UID: "10002"})); err != nil {
			t.Fatal(err)
		}
	}
	sendMention("w-1", "第一条")
	clk.Advance(2 * time.Second)
	sendMention("w-2", "第二条")
	clk.Advance(3 * time.Second)
	sendMention("w-3", "第三条")
	items := listFor(t, svc, 10002, "mention", false)
	if len(items) != 1 {
		t.Fatalf("10s 窗口内 3 条应合并为 1 行, got %d", len(items))
	}
	if items[0].Count != 3 {
		t.Fatalf("合并计数应为 3, got %d", items[0].Count)
	}
	if items[0].Digest != "第三条" {
		t.Fatalf("合并后 digest 应为最新内容, got %q", items[0].Digest)
	}
	// 时钟推进 11s（窗口外）→ 新行
	clk.Advance(11 * time.Second)
	sendMention("w-4", "窗口外")
	items = listFor(t, svc, 10002, "mention", false)
	if len(items) != 2 {
		t.Fatalf("窗口外应开新行（共 2 行）, got %d", len(items))
	}
	if items[0].Count != 1 || items[0].Digest != "窗口外" {
		t.Fatalf("新行应从 count=1 起算: %+v", items[0])
	}
	// 跨 kind 不合并：同窗口内 reply 落独立行
	base, err := svc.Send(ctx, 10002, textPayload(1, "bob-x", "疑问"))
	if err != nil {
		t.Fatal(err)
	}
	p := textPayload(1, "alice-x", "回复")
	p.ReplyToSeq = base.Seq
	if _, err := svc.Send(ctx, 10001, p); err != nil {
		t.Fatal(err)
	}
	if got := listFor(t, svc, 10002, "reply", false); len(got) != 1 {
		t.Fatalf("同窗口不同 kind 不应合并 mention, reply 行数=%d", len(got))
	}
	// 已读行不再作为合并目标：读掉后同窗口再触发 → 新行
	if err := svc.MarkNotificationsRead(ctx, 10002, messageapi.NotificationReadPayload{All: true}); err != nil {
		t.Fatal(err)
	}
	sendMention("w-5", "已读后")
	items = listFor(t, svc, 10002, "mention", false)
	if len(items) != 3 {
		t.Fatalf("已读行不应被合并，应开新行（共 3 行 mention）, got %d", len(items))
	}
}

// ── 已读：单条 ids / 全部 all；unread 计数 ──
func TestNotifyMarkReadAndCount(t *testing.T) {
	svc, _, _, _ := seedNotifyFixture(t)
	ctx := context.Background()
	if _, err := svc.Send(ctx, 10001, mentionPayload(1, "r-1", "@你", messageapi.Mention{UID: "10002"})); err != nil {
		t.Fatal(err)
	}
	base, err := svc.Send(ctx, 10002, textPayload(1, "r-2", "底稿"))
	if err != nil {
		t.Fatal(err)
	}
	p := textPayload(1, "r-3", "回复")
	p.ReplyToSeq = base.Seq
	if _, err := svc.Send(ctx, 10001, p); err != nil {
		t.Fatal(err)
	}
	cnt, err := svc.UnreadNotificationCount(ctx, 10002)
	if err != nil {
		t.Fatal(err)
	}
	if cnt.Count != 2 {
		t.Fatalf("未读应 2, got %d", cnt.Count)
	}
	mentionID := listFor(t, svc, 10002, "mention", false)[0].ID
	if err := svc.MarkNotificationsRead(ctx, 10002, messageapi.NotificationReadPayload{IDs: []string{mentionID}}); err != nil {
		t.Fatal(err)
	}
	cnt, _ = svc.UnreadNotificationCount(ctx, 10002)
	if cnt.Count != 1 {
		t.Fatalf("单条已读后未读应 1, got %d", cnt.Count)
	}
	// unread_only 过滤
	if got := listFor(t, svc, 10002, "", true); len(got) != 1 || got[0].Kind != "reply" {
		t.Fatalf("unread_only 应只剩 reply: %+v", got)
	}
	// 全部已读 → 清零
	if err := svc.MarkNotificationsRead(ctx, 10002, messageapi.NotificationReadPayload{All: true}); err != nil {
		t.Fatal(err)
	}
	cnt, _ = svc.UnreadNotificationCount(ctx, 10002)
	if cnt.Count != 0 {
		t.Fatalf("全部已读后应清零, got %d", cnt.Count)
	}
	// 入参校验：空 ids 且非 all → 9001
	if err := svc.MarkNotificationsRead(ctx, 10002, messageapi.NotificationReadPayload{}); err == nil {
		t.Fatal("空 ids 且非 all 应报错")
	}
}

// ── 越权：第二用户读不到本人通知（列表/计数/已读均按本人过滤）──
func TestNotifyIsolationBetweenUsers(t *testing.T) {
	svc, _, _, _ := seedNotifyFixture(t)
	ctx := context.Background()
	if _, err := svc.Send(ctx, 10001, mentionPayload(1, "iso-1", "只给 bob", messageapi.Mention{UID: "10002"})); err != nil {
		t.Fatal(err)
	}
	// carol 列表/计数为空
	if got := listFor(t, svc, 10003, "", false); len(got) != 0 {
		t.Fatalf("他人通知不可见, got %d", len(got))
	}
	cnt, _ := svc.UnreadNotificationCount(ctx, 10003)
	if cnt.Count != 0 {
		t.Fatalf("他人未读计数应为 0, got %d", cnt.Count)
	}
	// carol 拿 bob 的通知 ID 标已读：不影响 bob 行（仓储恒按 userID 过滤）
	bobItem := listFor(t, svc, 10002, "mention", false)[0]
	if err := svc.MarkNotificationsRead(ctx, 10003, messageapi.NotificationReadPayload{IDs: []string{bobItem.ID}}); err != nil {
		t.Fatal(err)
	}
	cnt, _ = svc.UnreadNotificationCount(ctx, 10002)
	if cnt.Count != 1 {
		t.Fatalf("越权已读不应生效, bob 未读应 1, got %d", cnt.Count)
	}
	// kind 白名单校验
	if _, err := svc.ListNotifications(ctx, 10002, "bogus", false, 0, 20); err == nil {
		t.Fatal("非法 kind 应报错")
	}
}

// ── WS 事件：生成/合并均发布 notification.new（payload 携带 id/kind/count；合并时 count 为合并后值）──
func TestNotifyPublishesNotificationNew(t *testing.T) {
	svc, _, bus, _ := seedNotifyFixture(t)
	ctx := context.Background()
	var mu sync.Mutex
	var pushes []messageapi.NotificationPushPayload
	bus.Subscribe(eventbus.TopicNotification, func(_ context.Context, evt eventbus.Event) error {
		if e, ok := evt.Payload.(messageapi.NotificationEvent); ok {
			mu.Lock()
			pushes = append(pushes, e.Push)
			mu.Unlock()
		}
		return nil
	})
	if _, err := svc.Send(ctx, 10001, mentionPayload(1, "p-1", "第一条",
		messageapi.Mention{UID: "10002"})); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Send(ctx, 10001, mentionPayload(1, "p-2", "第二条",
		messageapi.Mention{UID: "10002"})); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(pushes) != 2 {
		t.Fatalf("两次触发应各推 1 条 notification.new, got %d", len(pushes))
	}
	if pushes[0].Kind != "mention" || pushes[0].ID == "" || pushes[0].ConvID != "1" {
		t.Fatalf("推送载荷不符: %+v", pushes[0])
	}
	if pushes[1].Count != 2 || pushes[1].Digest != "第二条" {
		t.Fatalf("合并推送应携带合并后 count/digest: %+v", pushes[1])
	}
}

// ── 翻页：cursor（id 倒序）与 hasMore/nextCursor ──
func TestNotifyListPaging(t *testing.T) {
	svc, _, _, clk := seedNotifyFixture(t)
	ctx := context.Background()
	// 依次跨窗口生成 3 行（间隔 11s 保证不合并）
	for i := 1; i <= 3; i++ {
		if _, err := svc.Send(ctx, 10001, mentionPayload(1, "pg-"+strconv.Itoa(i), "第"+strconv.Itoa(i)+"条",
			messageapi.Mention{UID: "10002"})); err != nil {
			t.Fatal(err)
		}
		clk.Advance(11 * time.Second)
	}
	page1, err := svc.ListNotifications(ctx, 10002, "mention", false, 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page1.Items) != 2 || !page1.HasMore || page1.NextCursor == "" {
		t.Fatalf("首页应 2 条且 hasMore: %+v", page1)
	}
	cur, _ := strconv.ParseInt(page1.NextCursor, 10, 64)
	page2, err := svc.ListNotifications(ctx, 10002, "mention", false, cur, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.Items) != 1 || page2.HasMore {
		t.Fatalf("次页应 1 条且无更多: %+v", page2)
	}
	// id 倒序：首页首条 id > 次页首条 id
	a, _ := strconv.ParseInt(page1.Items[0].ID, 10, 64)
	b, _ := strconv.ParseInt(page2.Items[0].ID, 10, 64)
	if a <= b {
		t.Fatalf("应按 id 倒序: %d vs %d", a, b)
	}
}

// ── Agent 任务终态上报（④号事件源，14 篇 §3.3 OQ-C32：落卡+跨端事件+幂等+cancelled 不落卡）──
func TestReportAgentTask(t *testing.T) {
	svc, _, bus, clk := seedNotifyFixture(t)
	ctx := context.Background()
	var mu sync.Mutex
	var tasks []messageapi.AgentTaskEvent
	bus.Subscribe(eventbus.TopicAgentTaskDone, func(_ context.Context, evt eventbus.Event) error {
		if e, ok := evt.Payload.(messageapi.AgentTaskEvent); ok {
			mu.Lock()
			tasks = append(tasks, e)
			mu.Unlock()
		}
		return nil
	})

	// done：落卡 + 发事件
	if err := svc.ReportAgentTask(ctx, 10001, messageapi.AgentTaskReportPayload{
		RunID: "r-1", Kind: "delegate", Status: "done", SessionID: "s-1",
		Title: "修复登录超时", Summary: "改了 auth.go 重试逻辑", ChangedFilesCount: 2, OriginDID: "did-A",
	}); err != nil {
		t.Fatal(err)
	}
	items := listFor(t, svc, 10001, "agent_done", false)
	if len(items) != 1 || items[0].Title != "任务「修复登录超时」已完成" ||
		items[0].Digest != "改了 auth.go 重试逻辑" {
		t.Fatalf("done 应落 kind=agent_done 卡: %+v", items)
	}
	mu.Lock()
	if len(tasks) != 1 || tasks[0].Task.RunID != "r-1" || tasks[0].UserID != 10001 || tasks[0].Task.OriginDID != "did-A" {
		t.Fatalf("应发布 1 条 agent.task.completed: %+v", tasks)
	}
	mu.Unlock()

	// 幂等：同 run_id+status 重报 → 不新增行、不再发事件（宿主重试安全）
	if err := svc.ReportAgentTask(ctx, 10001, messageapi.AgentTaskReportPayload{
		RunID: "r-1", Kind: "delegate", Status: "done", SessionID: "s-1", Title: "修复登录超时",
	}); err != nil {
		t.Fatal(err)
	}
	if got := len(listFor(t, svc, 10001, "agent_done", false)); got != 1 {
		t.Fatalf("重报不应新增落卡, got %d", got)
	}
	mu.Lock()
	if len(tasks) != 1 {
		t.Fatalf("重报不应重复发事件, got %d", len(tasks))
	}
	mu.Unlock()

	// 同 run 不同终态（重试竞态后到 cancelled）→ 允许各自一次
	if err := svc.ReportAgentTask(ctx, 10001, messageapi.AgentTaskReportPayload{
		RunID: "r-1", Kind: "delegate", Status: "cancelled", SessionID: "s-1",
	}); err != nil {
		t.Fatal(err)
	}

	// cancelled：只发事件、不落卡
	if got := len(listFor(t, svc, 10001, "agent_done", false)); got != 1 {
		t.Fatalf("cancelled 不应落卡, got %d", got)
	}
	mu.Lock()
	if len(tasks) != 2 || tasks[1].Task.Status != "cancelled" {
		t.Fatalf("cancelled 应仍发跨端事件: %+v", tasks)
	}
	mu.Unlock()

	// 10s 窗口内第二个 run done → 聚合 count=2（"×N"渲染依据）
	if err := svc.ReportAgentTask(ctx, 10001, messageapi.AgentTaskReportPayload{
		RunID: "r-2", Kind: "expert", Status: "failed", SessionID: "s-2", Title: "代码评审",
	}); err != nil {
		t.Fatal(err)
	}
	items = listFor(t, svc, 10001, "agent_done", false)
	if len(items) != 1 || items[0].Count != 2 {
		t.Fatalf("窗口内多 run 应合并 count=2: %+v", items)
	}
	clk.Advance(11 * time.Second)

	// 枚举校验
	for _, bad := range []messageapi.AgentTaskReportPayload{
		{Kind: "delegate", Status: "done"},                         // 缺 run_id
		{RunID: "r-9", Kind: "bogus", Status: "done"},              // 非法 kind
		{RunID: "r-9", Kind: "probe", Status: "interrupted"},       // 非法 status（终态三枚举外）
	} {
		if err := svc.ReportAgentTask(ctx, 10001, bad); err == nil {
			t.Fatalf("非法上报应报错: %+v", bad)
		}
	}
}
