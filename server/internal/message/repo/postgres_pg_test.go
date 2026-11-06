//go:build pg

// PG 集成冒烟（build tag `pg`，默认 go test 不编译）。
//
//	本地：BBW_PG_TEST_DSN='postgres://bbw:...@127.0.0.1:5432/bbw?sslmode=disable' \
//	      go test -tags pg ./internal/message/repo/ -run TestPGSmoke -v
//
// 未设置 BBW_PG_TEST_DSN 即 skip；CI 后续以 service container 注入同变量。
// 直接用库（不建临时表）：测试数据带纳秒后缀，结束清理。
package messagerepo

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	orgapi "github.com/baobaowork/server/internal/org/api"
	orgrepo "github.com/baobaowork/server/internal/org/repo"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"

	authrepo "github.com/baobaowork/server/internal/auth/repo"
	messageapi "github.com/baobaowork/server/internal/message/api"
)

func TestPGSmoke(t *testing.T) {
	dsn := os.Getenv("BBW_PG_TEST_DSN")
	if dsn == "" {
		t.Skip("BBW_PG_TEST_DSN 未设置，跳过 PG 集成测试")
	}
	ctx := context.Background()
	pool, err := bbwpg.New(ctx, dsn)
	if err != nil {
		t.Fatalf("建池: %v", err)
	}
	// 注意顺序：t.Cleanup 为 LIFO——先注册 pool.Close（最后执行），
	// 再注册数据清理（在连接存活期间执行）；若用 defer pool.Close() 会在
	// cleanup 之前跑（函数 defer 先于框架 cleanup），清理必然失败。
	t.Cleanup(pool.Close)
	// 迁移幂等：外部通道（compose init）已直灌时按 Probe 补登记跳过
	if err := bbwpg.Migrate(ctx, pool); err != nil {
		t.Fatalf("迁移: %v", err)
	}

	sfx := strconv.FormatInt(time.Now().UnixNano(), 10)
	t.Cleanup(func() { // 清理本轮及历史遗留的冒烟数据
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
		DisplayName: "SmokeA", Email: "pgsmoke-a-" + sfx + "@bbw.io",
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
	if got, err := orgR.GetUserByLogin(ctx, 1, "pgsmoke-a-"+sfx+"@bbw.io"); err != nil || got.ID != u1.ID { // 邮箱登录名
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
