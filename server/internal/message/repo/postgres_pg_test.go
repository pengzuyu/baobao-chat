//go:build pg

// PG 集成冒烟（build tag `pg`，默认 go test 不编译）。
//
//	本地：BBC_PG_TEST_DSN='postgres://bbc:...@127.0.0.1:5432/bbc?sslmode=disable' \
//	      go test -tags pg ./internal/message/repo/ -run TestPGSmoke -v
//
// 未设置 BBC_PG_TEST_DSN 即 skip；CI 后续以 service container 注入同变量。
// 直接用库（不建临时表）：测试数据带纳秒后缀，结束清理。
package messagerepo

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	orgapi "github.com/baobaochat/server/internal/org/api"
	orgrepo "github.com/baobaochat/server/internal/org/repo"
	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"

	authrepo "github.com/baobaochat/server/internal/auth/repo"
	messageapi "github.com/baobaochat/server/internal/message/api"
)

func TestPGSmoke(t *testing.T) {
	dsn := os.Getenv("BBC_PG_TEST_DSN")
	if dsn == "" {
		t.Skip("BBC_PG_TEST_DSN 未设置，跳过 PG 集成测试")
	}
	ctx := context.Background()
	pool, err := bbcpg.New(ctx, dsn)
	if err != nil {
		t.Fatalf("建池: %v", err)
	}
	// 注意顺序：t.Cleanup 为 LIFO——先注册 pool.Close（最后执行），
	// 再注册数据清理（在连接存活期间执行）；若用 defer pool.Close() 会在
	// cleanup 之前跑（函数 defer 先于框架 cleanup），清理必然失败。
	t.Cleanup(pool.Close)
	// 迁移幂等：外部通道（compose init）已直灌时按 Probe 补登记跳过
	if err := bbcpg.Migrate(ctx, pool); err != nil {
		t.Fatalf("迁移: %v", err)
	}

	sfx := strconv.FormatInt(time.Now().UnixNano(), 10)
	t.Cleanup(func() { // 清理本轮及历史遗留的冒烟数据
		_, _ = pool.Exec(ctx, `DELETE FROM user_notification WHERE user_id IN (SELECT id FROM users WHERE employee_no LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM message_favorite WHERE user_id IN (SELECT id FROM users WHERE employee_no LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM message WHERE conv_id IN (SELECT id FROM conversation WHERE name LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM message_receipt WHERE conv_id IN (SELECT id FROM conversation WHERE name LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM conversation_member WHERE conv_id IN (SELECT id FROM conversation WHERE name LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM conversation WHERE name LIKE 'pgsmoke-%'`)
		_, _ = pool.Exec(ctx, `DELETE FROM refresh_token WHERE user_id IN (SELECT id FROM users WHERE employee_no LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM device WHERE user_id IN (SELECT id FROM users WHERE employee_no LIKE 'pgsmoke-%')`)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE employee_no LIKE 'pgsmoke-%'`)
	})

	// ── org：用户增查 ──
	orgR := orgrepo.NewPostgres(pool)
	u1, err := orgR.CreateUser(ctx, orgapi.User{
		TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "pgsmoke-a-" + sfx,
		DisplayName: "SmokeA", Email: "pgsmoke-a-" + sfx + "@bbc.io",
		PasswordHash: "x", Status: orgapi.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	u2, err := orgR.CreateUser(ctx, orgapi.User{
		TenantID: 1, Type: orgapi.UserTypeHuman, EmployeeNo: "pgsmoke-b-" + sfx,
		DisplayName: "SmokeB", PasswordHash: "x", Status: orgapi.UserStatusActive,
	})
	if err != nil {
		t.Fatalf("CreateUser2: %v", err)
	}
	if u1.ID == 0 || u2.ID == u1.ID {
		t.Fatalf("用户 ID 分配异常: %d %d", u1.ID, u2.ID)
	}
	if got, err := orgR.GetUser(ctx, u1.ID); err != nil || got.DisplayName != "SmokeA" {
		t.Fatalf("GetUser: %v %+v", err, got)
	}
	if got, err := orgR.GetUserByLogin(ctx, 1, "pgsmoke-a-"+sfx+"@bbc.io"); err != nil || got.ID != u1.ID { // 邮箱登录名
		t.Fatalf("GetUserByLogin(email): %v %+v", err, got)
	}
	if _, err := orgR.GetUser(ctx, -1); err != orgapi.ErrUserNotFound {
		t.Fatalf("GetUser(不存在) 应返回 ErrUserNotFound，得到 %v", err)
	}

	// ── message：会话/成员/seq/消息/回执 全链路 ──
	mr := NewPostgres(pool)
	conv, err := mr.CreateConversation(ctx, Conversation{
		TenantID: 1, Type: messageapi.ConvSingle, Name: "pgsmoke-" + sfx,
	})
	if err != nil || conv.ID == 0 {
		t.Fatalf("CreateConversation: %v %+v", err, conv)
	}
	if conv.Status != messageapi.ConvActive {
		t.Fatalf("新会话状态应为 active，得到 %d", conv.Status)
	}
	for _, uid := range []int64{u1.ID, u2.ID} {
		if err := mr.AddMember(ctx, Member{ConvID: conv.ID, UserID: uid}); err != nil {
			t.Fatalf("AddMember: %v", err)
		}
	}
	if err := mr.AddMember(ctx, Member{ConvID: conv.ID, UserID: u1.ID, Role: messageapi.MemberAdmin}); err != nil {
		t.Fatalf("AddMember upsert: %v", err)
	}
	if m, err := mr.MemberOf(ctx, conv.ID, u1.ID); err != nil || m == nil || m.Role != messageapi.MemberAdmin || m.Status != 1 {
		t.Fatalf("MemberOf(upsert 覆盖语义): %v %+v", err, m)
	}
	if ids, err := mr.MembersOf(ctx, conv.ID); err != nil || len(ids) != 2 { // upsert 不重复计人
		t.Fatalf("MembersOf: %v %v", err, ids)
	}
	if c, err := mr.GetConversation(ctx, conv.ID); err != nil || c.MemberCount != 2 {
		t.Fatalf("GetConversation(member_count): %v %+v", err, c)
	}

	// seq 行锁原子分配：新会话应从 1 递增
	seq1, err := mr.AllocSeq(ctx, conv.ID)
	if err != nil || seq1 != 1 {
		t.Fatalf("AllocSeq#1: %v %d", err, seq1)
	}
	msg := messageapi.Message{
		ID: 9_900_000_001, ConvID: conv.ID, Seq: seq1, ClientMsgID: "pgsmoke-" + sfx,
		SenderID: u1.ID, Type: "text", Body: []byte(`{"text":"hello pg"}`),
		Status: messageapi.MsgNormal, TS: time.Now().UnixMilli(),
	}
	if err := mr.InsertMessage(ctx, msg); err != nil {
		t.Fatalf("InsertMessage: %v", err)
	}
	dup := msg
	dup.ID, dup.Seq = 9_900_000_002, 2
	if err := mr.InsertMessage(ctx, dup); err != ErrDuplicateClientMsgID {
		t.Fatalf("InsertMessage(重复 client_msg_id) 应返回 ErrDuplicateClientMsgID，得到 %v", err)
	}
	if got, err := mr.FindByClientMsgID(ctx, conv.ID, msg.ClientMsgID); err != nil || got == nil || got.Seq != seq1 || got.ID != msg.ID {
		t.Fatalf("FindByClientMsgID: %v %+v", err, got)
	}
	// 注：body 落 JSONB 后按 PG 规范形存储（键序/空白可能重排），断言按语义比较
	if list, err := mr.ListMessages(ctx, conv.ID, 0, 0, 20); err != nil || len(list) != 1 ||
		!strings.Contains(string(list[0].Body), `"hello pg"`) {
		t.Fatalf("ListMessages: %v %+v", err, list)
	}
	if list, err := mr.ListMessages(ctx, conv.ID, seq1, 0, 20); err != nil || len(list) != 0 { // after=seq1 → 空
		t.Fatalf("ListMessages(after): %v %+v", err, list)
	}
	// MaxMessageID 为可选接口（service 启动时探测对齐内存 ID 计数器，见 service.New）
	idAlloc, ok := mr.(interface {
		MaxMessageID(context.Context) (int64, error)
	})
	if !ok {
		t.Fatal("PG 仓储应实现 MaxMessageID 可选接口")
	}
	if max, err := idAlloc.MaxMessageID(ctx); err != nil || max < msg.ID {
		t.Fatalf("MaxMessageID: %v %d", err, max)
	}
	if last, err := mr.LastMessage(ctx, conv.ID); err != nil || last == nil || last.ClientMsgID != msg.ClientMsgID {
		t.Fatalf("LastMessage: %v %+v", err, last)
	}
	// 新交互路径（D03）：按 ID/seq 查、编辑更新（edit_version/ext）、会话态 upsert
	if got, err := mr.GetMessageByID(ctx, msg.ID); err != nil || got == nil || got.Seq != seq1 {
		t.Fatalf("GetMessageByID: %v %+v", err, got)
	}
	if got, err := mr.GetMessageBySeq(ctx, conv.ID, seq1); err != nil || got == nil || got.ID != msg.ID {
		t.Fatalf("GetMessageBySeq: %v %+v", err, got)
	}
	if got, err := mr.GetMessageBySeq(ctx, conv.ID, 424242); err != nil || got != nil {
		t.Fatalf("GetMessageBySeq(幽灵 seq) 应 nil,nil: %v %+v", err, got)
	}
	upd, err := mr.GetMessageByID(ctx, msg.ID)
	if err != nil || upd == nil {
		t.Fatalf("GetMessageByID(编辑前): %v %+v", err, upd)
	}
	upd.Status = messageapi.MsgEdited
	upd.EditedAt = time.Now().UnixMilli()
	upd.EditVersion = 2
	upd.Ext = []byte(`{"reactions":{"👍":["1"]},"reply_digest":{"sender_id":"1","type":"text","digest":"d","seq":1}}`)
	if err := mr.UpdateMessage(ctx, *upd); err != nil {
		t.Fatalf("UpdateMessage: %v", err)
	}
	if got, err := mr.GetMessageByID(ctx, msg.ID); err != nil || got.Status != messageapi.MsgEdited ||
		got.EditVersion != 2 || got.EditedAt == 0 || !strings.Contains(string(got.Ext), `"👍"`) {
		t.Fatalf("UpdateMessage 落库校验: %v %+v %s", err, got, got.Ext)
	}
	if _, err := mr.UserConvState(ctx, u1.ID, conv.ID); err != nil {
		t.Fatalf("UserConvState(空): %v", err)
	}
	if err := mr.SetUserConvState(ctx, u1.ID, conv.ID, UserConvState{Pinned: true, Draft: "写一半"}); err != nil {
		t.Fatalf("SetUserConvState: %v", err)
	}
	if st, err := mr.UserConvState(ctx, u1.ID, conv.ID); err != nil || !st.Pinned || st.Draft != "写一半" {
		t.Fatalf("UserConvState 读回: %v %+v", err, st)
	}
	// upsert 覆盖（pinned 翻回 false）
	if err := mr.SetUserConvState(ctx, u1.ID, conv.ID, UserConvState{Draft: ""}); err != nil {
		t.Fatal(err)
	}
	if st, _ := mr.UserConvState(ctx, u1.ID, conv.ID); st.Pinned {
		t.Fatal("upsert 未覆盖 pinned")
	}
	if err := mr.TouchConversation(ctx, conv.ID, seq1, msg.TS); err != nil {
		t.Fatalf("TouchConversation: %v", err)
	}
	if c, err := mr.GetConversation(ctx, conv.ID); err != nil || c.LatestSeq != 1 || c.LastMsgTS == 0 {
		t.Fatalf("GetConversation(冗余): %v %+v", err, c)
	}
	convs, err := mr.ListUserConversations(ctx, u1.ID)
	if err != nil || len(convs) == 0 || convs[0].ID != conv.ID {
		t.Fatalf("ListUserConversations: %v %+v", err, convs)
	}

	// 回执：只进不退
	if r, err := mr.GetReceipt(ctx, conv.ID, u2.ID); err != nil || r.ReadSeq != 0 {
		t.Fatalf("GetReceipt(初始): %v %+v", err, r)
	}
	if err := mr.SetReadSeq(ctx, conv.ID, u2.ID, 1); err != nil {
		t.Fatalf("SetReadSeq: %v", err)
	}
	if err := mr.SetReadSeq(ctx, conv.ID, u2.ID, 0); err != nil { // 回退上报
		t.Fatalf("SetReadSeq(回退): %v", err)
	}
	if r, err := mr.GetReceipt(ctx, conv.ID, u2.ID); err != nil || r.ReadSeq != 1 {
		t.Fatalf("GetReceipt(只进不退): %v %+v", err, r)
	}

	// ── 搜索（PIM-07 服务端态：ILIKE + 过滤器 + 可见性 + msg_id 倒序分页）──
	for i, txt := range []string{`{"text":"pgsmoke 关键词甲"}`, `{"text":"PGSMOKE 关键词乙"}`, `{"text":"无关文案"}`} {
		seqX, err := mr.AllocSeq(ctx, conv.ID)
		if err != nil {
			t.Fatalf("AllocSeq(search#%d): %v", i, err)
		}
		mx := messageapi.Message{
			ID: 9_900_000_100 + int64(i), ConvID: conv.ID, Seq: seqX,
			ClientMsgID: fmt.Sprintf("pgsmoke-s-%s-%d", sfx, i),
			SenderID:    u1.ID, Type: "text", Body: []byte(txt),
			Status: messageapi.MsgNormal, TS: time.Now().UnixMilli(),
		}
		if err := mr.InsertMessage(ctx, mx); err != nil {
			t.Fatalf("InsertMessage(search#%d): %v", i, err)
		}
	}
	// 大小写不敏感（ILIKE 口径）+ 可见性（u1 在群）
	hits, err := mr.SearchMessages(ctx, SearchFilter{UserID: u1.ID, Keyword: "pgsmoke"})
	if err != nil || len(hits) != 2 {
		t.Fatalf("SearchMessages: %v %d", err, len(hits))
	}
	if hits[0].ID <= hits[1].ID {
		t.Fatalf("搜索结果应 msg_id 倒序: %d %d", hits[0].ID, hits[1].ID)
	}
	if !strings.Contains(string(hits[0].Body), "关键词乙") { // 最新（ID 更大）在前
		t.Fatalf("倒序首条应含 关键词乙: %s", hits[0].Body)
	}
	// from_uid 过滤（u2 无命中消息）+ 非成员可见性（u2 被移出后不可见）
	if bySender, err := mr.SearchMessages(ctx, SearchFilter{UserID: u1.ID, Keyword: "pgsmoke", FromUID: u2.ID}); err != nil || len(bySender) != 0 {
		t.Fatalf("SearchMessages(from_uid): %v %d", err, len(bySender))
	}
	// cursor 翻页：limit=1 → 首条最新，cursor 续拉次条
	p1, err := mr.SearchMessages(ctx, SearchFilter{UserID: u1.ID, Keyword: "pgsmoke", Limit: 1})
	if err != nil || len(p1) != 1 || p1[0].ID != hits[0].ID {
		t.Fatalf("SearchMessages(分页1): %v %+v", err, p1)
	}
	p2, err := mr.SearchMessages(ctx, SearchFilter{UserID: u1.ID, Keyword: "pgsmoke", Limit: 1, Cursor: p1[0].ID})
	if err != nil || len(p2) != 1 || p2[0].ID != hits[1].ID {
		t.Fatalf("SearchMessages(分页2): %v %+v", err, p2)
	}

	// ── 收藏（PIM-08：UK 幂等/倒序/type 过滤/count/exists）──
	f1, created, err := mr.AddFavorite(ctx, u1.ID, msg.ID, conv.ID)
	if err != nil || !created || f1.ID == 0 {
		t.Fatalf("AddFavorite#1: %v %+v created=%v", err, f1, created)
	}
	f1b, created, err := mr.AddFavorite(ctx, u1.ID, msg.ID, conv.ID) // UK 幂等
	if err != nil || created || f1b.ID != f1.ID {
		t.Fatalf("AddFavorite(重复应幂等返回原行): %v %+v vs %+v created=%v", err, f1b, f1, created)
	}
	favMsg2 := int64(9_900_000_101) // 关键词乙消息
	f2, _, err := mr.AddFavorite(ctx, u1.ID, favMsg2, conv.ID)
	if err != nil {
		t.Fatalf("AddFavorite#2: %v", err)
	}
	if n, err := mr.CountFavorites(ctx, u1.ID); err != nil || n != 2 {
		t.Fatalf("CountFavorites: %v %d", err, n)
	}
	if ok, err := mr.ExistsFavorite(ctx, u1.ID, msg.ID); err != nil || !ok {
		t.Fatalf("ExistsFavorite: %v %v", err, ok)
	}
	if ok, err := mr.ExistsFavorite(ctx, u2.ID, msg.ID); err != nil || ok {
		t.Fatalf("ExistsFavorite(他人应 false): %v %v", err, ok)
	}
	favs, err := mr.ListFavorites(ctx, u1.ID, "", 0, 20)
	if err != nil || len(favs) != 2 || favs[0].ID != f2.ID { // created_at 倒序：最新收藏在前
		t.Fatalf("ListFavorites(倒序): %v %+v", err, favs)
	}
	favsText, err := mr.ListFavorites(ctx, u1.ID, "text", 0, 20)
	if err != nil || len(favsText) != 2 {
		t.Fatalf("ListFavorites(type=text): %v %d", err, len(favsText))
	}
	if favsFile, err := mr.ListFavorites(ctx, u1.ID, "file", 0, 20); err != nil || len(favsFile) != 0 {
		t.Fatalf("ListFavorites(type=file 应空): %v %d", err, len(favsFile))
	}
	if err := mr.RemoveFavorite(ctx, u1.ID, msg.ID); err != nil {
		t.Fatalf("RemoveFavorite: %v", err)
	}
	if n, _ := mr.CountFavorites(ctx, u1.ID); n != 1 {
		t.Fatalf("RemoveFavorite 后应剩 1: %d", n)
	}
	if err := mr.RemoveFavorite(ctx, u1.ID, msg.ID); err != nil { // 重复取消 no-op
		t.Fatalf("RemoveFavorite(重复应 no-op): %v", err)
	}

	// ── 通知（PIM-09：聚合窗口合并/倒序翻页/已读/计数/越权过滤）──
	base := time.Now()
	n1, merged, err := mr.InsertMergedNotification(ctx, Notification{
		UserID: u1.ID, Kind: messageapi.NotifyKindMention, ConvID: conv.ID, MsgID: msg.ID, Seq: seq1,
		Title: "SmokeA 在「pgsmoke」中@了你", Digest: "第一条", Count: 1, CreatedAt: base,
	}, 10*time.Second)
	if err != nil || merged || n1.ID == 0 {
		t.Fatalf("InsertMergedNotification#1: %v %+v merged=%v", err, n1, merged)
	}
	n2, merged, err := mr.InsertMergedNotification(ctx, Notification{
		UserID: u1.ID, Kind: messageapi.NotifyKindMention, ConvID: conv.ID, MsgID: msg.ID, Seq: seq1,
		Title: "SmokeA 在「pgsmoke」中@了你", Digest: "第二条", Count: 1, CreatedAt: base.Add(2 * time.Second),
	}, 10*time.Second)
	if err != nil || !merged || n2.ID != n1.ID || n2.Count != 2 || n2.Digest != "第二条" {
		t.Fatalf("InsertMergedNotification(10s 窗口应合并 count+1): %v %+v merged=%v", err, n2, merged)
	}
	n3, merged, err := mr.InsertMergedNotification(ctx, Notification{
		UserID: u1.ID, Kind: messageapi.NotifyKindReply, ConvID: conv.ID, MsgID: msg.ID, Seq: seq1,
		Title: "SmokeA 回复了你", Digest: "跨 kind", Count: 1, CreatedAt: base.Add(3 * time.Second),
	}, 10*time.Second)
	if err != nil || merged || n3.ID == n1.ID {
		t.Fatalf("InsertMergedNotification(跨 kind 不合并): %v %+v merged=%v", err, n3, merged)
	}
	list, err := mr.ListNotifications(ctx, NotificationFilter{UserID: u1.ID})
	if err != nil || len(list) != 2 || list[0].ID != n3.ID || list[1].Count != 2 {
		t.Fatalf("ListNotifications(id 倒序+合并计数): %v %+v", err, list)
	}
	onlyMention, err := mr.ListNotifications(ctx, NotificationFilter{UserID: u1.ID, Kind: messageapi.NotifyKindMention})
	if err != nil || len(onlyMention) != 1 || onlyMention[0].ID != n1.ID {
		t.Fatalf("ListNotifications(kind 过滤): %v %+v", err, onlyMention)
	}
	if cnt, err := mr.CountUnreadNotifications(ctx, u1.ID); err != nil || cnt != 2 {
		t.Fatalf("CountUnreadNotifications: %v %d", err, cnt)
	}
	if cnt, err := mr.CountUnreadNotifications(ctx, u2.ID); err != nil || cnt != 0 { // 越权：他人恒 0
		t.Fatalf("CountUnreadNotifications(他人): %v %d", err, cnt)
	}
	if n, err := mr.MarkNotificationsRead(ctx, u1.ID, []int64{n1.ID}, false, base.Add(time.Second)); err != nil || n != 1 {
		t.Fatalf("MarkNotificationsRead(ids): %v %d", err, n)
	}
	if n, err := mr.MarkNotificationsRead(ctx, u1.ID, []int64{n1.ID}, false, base.Add(time.Second)); err != nil || n != 0 {
		t.Fatalf("MarkNotificationsRead(已读行应跳过): %v %d", err, n)
	}
	unread, err := mr.ListNotifications(ctx, NotificationFilter{UserID: u1.ID, UnreadOnly: true})
	if err != nil || len(unread) != 1 || unread[0].ID != n3.ID {
		t.Fatalf("ListNotifications(unread_only): %v %+v", err, unread)
	}
	if n, err := mr.MarkNotificationsRead(ctx, u1.ID, nil, true, base.Add(2*time.Second)); err != nil || n != 1 {
		t.Fatalf("MarkNotificationsRead(all): %v %d", err, n)
	}
	if cnt, _ := mr.CountUnreadNotifications(ctx, u1.ID); cnt != 0 {
		t.Fatalf("全部已读后应清零: %d", cnt)
	}
	// 已读行不参与合并：窗口内再次触发 → 新行
	n4, merged, err := mr.InsertMergedNotification(ctx, Notification{
		UserID: u1.ID, Kind: messageapi.NotifyKindMention, ConvID: conv.ID, MsgID: msg.ID, Seq: seq1,
		Title: "t", Digest: "已读后", Count: 1, CreatedAt: base.Add(4 * time.Second),
	}, 10*time.Second)
	if err != nil || merged || n4.ID == n1.ID {
		t.Fatalf("InsertMergedNotification(已读行不合并): %v %+v merged=%v", err, n4, merged)
	}

	if err := mr.DissolveConversation(ctx, conv.ID); err != nil {
		t.Fatalf("DissolveConversation: %v", err)
	}
	if c, err := mr.GetConversation(ctx, conv.ID); err != nil || c.Status != messageapi.ConvDissolved {
		t.Fatalf("GetConversation(解散): %v %+v", err, c)
	}

	// ── auth：令牌轮换链 + 设备 upsert ──
	tr := authrepo.NewPostgresTokens(pool)
	dr := authrepo.NewPostgresDevices(pool)
	dev, err := dr.Upsert(ctx, authrepo.Device{UserID: u1.ID, DID: "pgsmoke-did-" + sfx,
		DeviceName: "mac", OS: "darwin", LastActiveAt: time.Now()})
	if err != nil || dev.ID == 0 {
		t.Fatalf("Device Upsert: %v %+v", err, dev)
	}
	dev2, err := dr.Upsert(ctx, authrepo.Device{UserID: u1.ID, DID: "pgsmoke-did-" + sfx,
		DeviceName: "mac-pro", OS: "darwin", LastActiveAt: time.Now()})
	if err != nil || dev2.ID != dev.ID || dev2.DeviceName != "mac-pro" {
		t.Fatalf("Device Upsert(同 did 应更新): %v %+v", err, dev2)
	}
	if got, err := dr.FindByDID(ctx, u1.ID, "pgsmoke-did-"+sfx); err != nil || got == nil || got.ID != dev.ID {
		t.Fatalf("FindByDID: %v %+v", err, got)
	}

	tk, err := tr.Create(ctx, authrepo.RefreshToken{
		UserID: u1.ID, DeviceID: dev.ID, TokenHash: "pgsmoke-hash-" + sfx,
		ExpiresAt: time.Now().Add(time.Hour), Status: authrepo.RefreshActive, CreatedAt: time.Now(),
	})
	if err != nil || tk.ID == 0 {
		t.Fatalf("Token Create: %v %+v", err, tk)
	}
	if got, err := tr.FindByTokenHash(ctx, "pgsmoke-hash-"+sfx); err != nil || got == nil || got.ID != tk.ID {
		t.Fatalf("FindByTokenHash: %v %+v", err, got)
	}
	if err := tr.UpdateStatus(ctx, tk.ID, authrepo.RefreshRotated); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	next := tk.ID
	tk2, err := tr.Create(ctx, authrepo.RefreshToken{
		UserID: u1.ID, DeviceID: dev.ID, TokenHash: "pgsmoke-hash2-" + sfx,
		ExpiresAt: time.Now().Add(time.Hour), RotatedFrom: &next,
		Status: authrepo.RefreshActive, CreatedAt: time.Now(),
	})
	if err != nil || tk2.ID == tk.ID {
		t.Fatalf("Token Create#2: %v %+v", err, tk2)
	}
	if err := tr.RevokeForUser(ctx, u1.ID, 0, true); err != nil {
		t.Fatalf("RevokeForUser: %v", err)
	}
	if got, _ := tr.FindByTokenHash(ctx, "pgsmoke-hash2-"+sfx); got == nil || got.Status != authrepo.RefreshRevoked {
		t.Fatalf("吊销后状态应为 revoked: %+v", got)
	}
	// RevokeForUser(all) 覆盖所有状态（含已轮换的旧 token）→ 3，与内存版语义一致
	if got, _ := tr.FindByTokenHash(ctx, "pgsmoke-hash-"+sfx); got == nil || got.RotatedFrom != nil || got.Status != authrepo.RefreshRevoked {
		t.Fatalf("轮换链查询: %+v", got)
	}
}
