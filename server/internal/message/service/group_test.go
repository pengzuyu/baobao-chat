// 群管理全链路用例（D03 §4.1 INT-IM-15~19 / S2 状态机 / PIM-12 系统消息 kind）：
// 覆盖角色矩阵每条拒绝路径、系统消息 kind 断言、单聊去重、申请状态机（待审/通过/拒绝/7 天过期）。
package messageservice

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	messageapi "github.com/baobaowork/server/internal/message/api"
	messagerepo "github.com/baobaowork/server/internal/message/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/eventbus"
)

// captureConvUpdated 订阅采集 conv.updated 事件载荷（kind 断言用）
func captureConvUpdated(bus *eventbus.InMemory) func() []messageapi.ConvUpdatedEvent {
	var mu sync.Mutex
	var out []messageapi.ConvUpdatedEvent
	bus.Subscribe(eventbus.TopicConvUpdated, func(_ context.Context, e eventbus.Event) error {
		if evt, ok := e.Payload.(messageapi.ConvUpdatedEvent); ok {
			mu.Lock()
			out = append(out, evt)
			mu.Unlock()
		}
		return nil
	})
	return func() []messageapi.ConvUpdatedEvent {
		mu.Lock()
		defer mu.Unlock()
		return append([]messageapi.ConvUpdatedEvent(nil), out...)
	}
}

// groupFixture：群 conv（alice=10001 owner / bob=10002 member / carol=10003 admin）。
// conv ID 由内存仓自增决定：seedFixture 已占 1/2 → 本 fixture 群为 3。
func groupFixture(t *testing.T, opts Options) (*Service, *messagerepo.Memory, *eventbus.InMemory, int64) {
	t.Helper()
	if opts.Now == nil {
		opts.Now = func() time.Time { return time.UnixMilli(1760000000000) }
	}
	svc, r, bus := seedFixture(t, opts)
	ctx := context.Background()
	detail, err := svc.CreateConversation(ctx, 10001, messageapi.ConvCreatePayload{
		Type: messageapi.ConvGroup, Name: "测试群", MemberIDs: []string{"10002", "10003"},
	})
	if err != nil {
		t.Fatalf("建群: %v", err)
	}
	convID := mustParseI64(t, detail.ID)
	// carol 提为管理员（角色矩阵：admin 档）
	if err := svc.SetMemberRole(ctx, 10001, messageapi.MemberRolePayload{
		ConvID: cid(convID), UID: "10003", Role: messageapi.MemberAdmin,
	}); err != nil {
		t.Fatalf("设管: %v", err)
	}
	return svc, r, bus, convID
}

// lastSystemBody 取会话内最后一条 system 消息的 body（PIM-12 kind 断言）
func lastSystemBody(t *testing.T, svc *Service, convID int64) messageapi.SystemBody {
	t.Helper()
	msgs, err := svc.ListMessagesLatest(context.Background(), convID, 50)
	if err != nil {
		t.Fatalf("拉消息: %v", err)
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Type == "system" {
			return decodeSystemBody(msgs[i].Body)
		}
	}
	t.Fatalf("会话 %d 无 system 消息", convID)
	return messageapi.SystemBody{}
}

// hasSystemKind 会话内是否出现过指定 kind 的 system 消息
func hasSystemKind(t *testing.T, svc *Service, convID int64, kind string) bool {
	t.Helper()
	msgs, err := svc.ListMessagesLatest(context.Background(), convID, 50)
	if err != nil {
		t.Fatalf("拉消息: %v", err)
	}
	for _, m := range msgs {
		if m.Type == "system" && decodeSystemBody(m.Body).Kind == kind {
			return true
		}
	}
	return false
}

func codeOf(err error) errx.Code { return errx.From(err).Code }

// ── conv.create ──

// 单聊去重：同对成员复用已有 active 单聊（INT-IM-15）
func TestConvCreateSingleDedup(t *testing.T) {
	svc, _, _, _ := groupFixture(t, Options{})
	ctx := context.Background()
	first, err := svc.CreateConversation(ctx, 10001, messageapi.ConvCreatePayload{
		Type: messageapi.ConvSingle, MemberIDs: []string{"10002"},
	})
	if err != nil {
		t.Fatalf("首发单聊: %v", err)
	}
	// 反向再建（bob 发起）也应复用
	second, err := svc.CreateConversation(ctx, 10002, messageapi.ConvCreatePayload{
		Type: messageapi.ConvSingle, MemberIDs: []string{"10001"},
	})
	if err != nil {
		t.Fatalf("重复单聊: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("单聊应去重复用: %s vs %s", first.ID, second.ID)
	}
	// 参数错误：单聊恰 1 人 / 群名必填校验在 9001
	if _, err := svc.CreateConversation(ctx, 10001, messageapi.ConvCreatePayload{
		Type: messageapi.ConvSingle, MemberIDs: []string{},
	}); codeOf(err) != errx.CodeBadRequest {
		t.Fatalf("单聊 0 人应 9001: %v", err)
	}
	if _, err := svc.CreateConversation(ctx, 10001, messageapi.ConvCreatePayload{
		Type: messageapi.ConvGroup, Name: "", MemberIDs: []string{"10002"},
	}); err == nil {
		t.Fatalf("群名必填")
	}
	// 成员上限：普通群 500（3010）——压低上限注入验证拒绝路径
	svc.opts.MaxGroupMembers = 2
	if _, err := svc.CreateConversation(ctx, 10001, messageapi.ConvCreatePayload{
		Type: messageapi.ConvGroup, Name: "超限群", MemberIDs: []string{"10002", "10003"},
	}); codeOf(err) != errx.CodeIMMemberLimit {
		t.Fatalf("超上限应 3010: %v", err)
	}
}

// 建群：owner 落位 + 系统消息 group.created + 事件 kind=meta
func TestConvCreateGroupOwnerAndSystemMessage(t *testing.T) {
	svc, _, bus, convID := groupFixture(t, Options{})
	convUpdated := captureConvUpdated(bus) // 订阅后再建第二个群，事件从 0 计
	ctx := context.Background()
	if !hasSystemKind(t, svc, convID, messageapi.SysKindGroupCreated) {
		t.Fatalf("建群应产生 group.created 系统消息")
	}
	member, _ := svc.repo.MemberOf(ctx, convID, 10001)
	if member == nil || member.Role != messageapi.MemberOwner {
		t.Fatalf("创建者应为 owner: %+v", member)
	}
	detail, err := svc.GetConvDetail(ctx, 10001, convID)
	if err != nil {
		t.Fatalf("详情: %v", err)
	}
	if detail.MemberCount != 3 || detail.GroupSetting == nil || detail.GroupSetting.MentionAllPolicy != 2 {
		t.Fatalf("详情不符: %+v", detail)
	}
	// 事件：新建群恰发 1 条 conv.updated(kind=meta)
	_, err = svc.CreateConversation(ctx, 10001, messageapi.ConvCreatePayload{
		Type: messageapi.ConvGroup, Name: "第二群", MemberIDs: []string{"10002"},
	})
	if err != nil {
		t.Fatalf("二次建群: %v", err)
	}
	n := 0
	for _, evt := range convUpdated() {
		if evt.Kind == "meta" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("conv.updated(meta) 事件数=%d want 1", n)
	}
}

// ── 邀请与成员校验（INT-IM-16）──

func TestAddMembersMatrix(t *testing.T) {
	svc, _, _, convID := groupFixture(t, Options{})
	ctx := context.Background()
	// 默认 invite_policy=all：member 可邀
	if err := svc.AddMembers(ctx, 10002, messageapi.MemberAddPayload{
		ConvID: cid(convID), UIDs: []string{"10004"},
	}); err != nil {
		t.Fatalf("member 默认策略应可邀: %v", err)
	}
	// 已在会话 → 3012
	if err := svc.AddMembers(ctx, 10001, messageapi.MemberAddPayload{
		ConvID: cid(convID), UIDs: []string{"10004"},
	}); codeOf(err) != errx.CodeIMALreadyInConv {
		t.Fatalf("重复邀请应 3012: %v", err)
	}
	// 目标不可加入（NameOf 解析失败）→ 3011
	svc.opts.NameOf = func(id int64) string { return "" }
	if err := svc.AddMembers(ctx, 10001, messageapi.MemberAddPayload{
		ConvID: cid(convID), UIDs: []string{"99999"},
	}); codeOf(err) != errx.CodeIMTargetNotJoinable {
		t.Fatalf("无效目标应 3011: %v", err)
	}
	svc.opts.NameOf = nil
	// invite_policy=仅管理：member 拒（3015）
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), InvitePolicy: intPtr(2),
	}); err != nil {
		t.Fatalf("收紧邀请策略: %v", err)
	}
	if err := svc.AddMembers(ctx, 10002, messageapi.MemberAddPayload{
		ConvID: cid(convID), UIDs: []string{"10005"},
	}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("仅管理策略 member 邀请应 3015: %v", err)
	}
	// admin 仍可邀
	if err := svc.AddMembers(ctx, 10003, messageapi.MemberAddPayload{
		ConvID: cid(convID), UIDs: []string{"10005"},
	}); err != nil {
		t.Fatalf("admin 邀请应通过: %v", err)
	}
	// 上限 3010：把上限压到当前人数
	conv, _ := svc.repo.GetConversation(ctx, convID)
	svc.opts.MaxGroupMembers = conv.MemberCount
	if err := svc.AddMembers(ctx, 10001, messageapi.MemberAddPayload{
		ConvID: cid(convID), UIDs: []string{"10006"},
	}); codeOf(err) != errx.CodeIMMemberLimit {
		t.Fatalf("超上限应 3010: %v", err)
	}
	// 系统消息 kind=member.joined
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMemberJoined {
		t.Fatalf("邀请系统消息 kind=%q", body.Kind)
	}
}

// ── 移出矩阵（INT-IM-17）──

func TestRemoveMemberMatrix(t *testing.T) {
	svc, r, _, convID := groupFixture(t, Options{})
	ctx := context.Background()
	// member 无权 → 3015
	if err := svc.RemoveMember(ctx, 10002, messageapi.MemberRemovePayload{
		ConvID: cid(convID), UID: "10003",
	}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("member 移出应 3015: %v", err)
	}
	// admin 不能移 admin/owner → 3015
	if err := svc.RemoveMember(ctx, 10003, messageapi.MemberRemovePayload{
		ConvID: cid(convID), UID: "10001",
	}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("admin 移 owner 应 3015: %v", err)
	}
	// 目标不在会话 → 3011
	if err := svc.RemoveMember(ctx, 10001, messageapi.MemberRemovePayload{
		ConvID: cid(convID), UID: "88888",
	}); codeOf(err) != errx.CodeIMTargetNotJoinable {
		t.Fatalf("目标缺席应 3011: %v", err)
	}
	// owner 移 member 成功；member_count 递减；系统消息 member.removed
	before, _ := svc.repo.GetConversation(ctx, convID)
	if err := svc.RemoveMember(ctx, 10001, messageapi.MemberRemovePayload{
		ConvID: cid(convID), UID: "10002",
	}); err != nil {
		t.Fatalf("owner 移出: %v", err)
	}
	after, _ := svc.repo.GetConversation(ctx, convID)
	if after.MemberCount != before.MemberCount-1 {
		t.Fatalf("member_count 应递减: %d → %d", before.MemberCount, after.MemberCount)
	}
	if m, _ := svc.repo.MemberOf(ctx, convID, 10002); m == nil || m.Status != 3 {
		t.Fatalf("被移出者 status 应=3: %+v", m)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMemberRemoved {
		t.Fatalf("移出系统消息 kind=%q", body.Kind)
	}
	_ = r
}

// ── 退群（INT-IM-19：owner 3016）──

func TestQuitOwnerRejectedAndMemberOK(t *testing.T) {
	svc, r, _, convID := groupFixture(t, Options{})
	ctx := context.Background()
	// 群主退群 → 3016
	if err := svc.QuitConversation(ctx, 10001, convID); codeOf(err) != errx.CodeIMOwnerCannotQuit {
		t.Fatalf("群主退群应 3016: %v", err)
	}
	// member 退群成功：status=2 + 计数递减 + member.quit
	if err := svc.QuitConversation(ctx, 10002, convID); err != nil {
		t.Fatalf("member 退群: %v", err)
	}
	if m, _ := svc.repo.MemberOf(ctx, convID, 10002); m == nil || m.Status != 2 {
		t.Fatalf("退群者 status 应=2: %+v", m)
	}
	conv, _ := svc.repo.GetConversation(ctx, convID)
	if conv.MemberCount != 2 {
		t.Fatalf("member_count=2 want: %d", conv.MemberCount)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMemberQuit {
		t.Fatalf("退群系统消息 kind=%q", body.Kind)
	}
	// 退群后重复退 → 3001
	if err := svc.QuitConversation(ctx, 10002, convID); codeOf(err) != errx.CodeIMNotInConversation {
		t.Fatalf("重复退群应 3001: %v", err)
	}
	// 再邀请复活：计数回到 3（AddMember 复活补计数）
	if err := svc.AddMembers(ctx, 10001, messageapi.MemberAddPayload{
		ConvID: cid(convID), UIDs: []string{"10002"},
	}); err != nil {
		t.Fatalf("复活: %v", err)
	}
	conv, _ = svc.repo.GetConversation(ctx, convID)
	if conv.MemberCount != 3 {
		t.Fatalf("复活后 member_count 应=3: %d", conv.MemberCount)
	}
	_ = r
}

// ── 角色与转让（INT-IM-17/19）──

func TestSetMemberRoleMatrix(t *testing.T) {
	svc, _, _, convID := groupFixture(t, Options{})
	ctx := context.Background()
	// admin 无权设角色 → 3015
	if err := svc.SetMemberRole(ctx, 10003, messageapi.MemberRolePayload{
		ConvID: cid(convID), UID: "10002", Role: messageapi.MemberAdmin,
	}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("admin 设管应 3015: %v", err)
	}
	// owner 设管成功 + member.role.changed
	if err := svc.SetMemberRole(ctx, 10001, messageapi.MemberRolePayload{
		ConvID: cid(convID), UID: "10002", Role: messageapi.MemberAdmin,
	}); err != nil {
		t.Fatalf("owner 设管: %v", err)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMemberRoleChanged || body.Extra != "admin" {
		t.Fatalf("设管系统消息不符: %+v", body)
	}
	// 转让：owner ⇄ target；owner.transferred + conv.owner_id 变更
	if err := svc.SetMemberRole(ctx, 10001, messageapi.MemberRolePayload{
		ConvID: cid(convID), UID: "10002", Role: messageapi.MemberOwner,
	}); err != nil {
		t.Fatalf("转让: %v", err)
	}
	conv, _ := svc.repo.GetConversation(ctx, convID)
	if conv.OwnerID != 10002 {
		t.Fatalf("owner_id 应已转让: %d", conv.OwnerID)
	}
	if m, _ := svc.repo.MemberOf(ctx, convID, 10001); m == nil || m.Role != messageapi.MemberMember {
		t.Fatalf("原 owner 应降 member: %+v", m)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindOwnerTransferred {
		t.Fatalf("转让系统消息 kind=%q", body.Kind)
	}
	// 转让后原 owner 退群不再 3016（已是 member）
	if err := svc.QuitConversation(ctx, 10001, convID); err != nil {
		t.Fatalf("转让后原 owner 退群: %v", err)
	}
}

// ── 禁言矩阵 + 全员禁言 + @全体策略（INT-IM-17 / 04 篇 §4.5.3）──

func TestMuteMatrixAndMuteAll(t *testing.T) {
	svc, _, _, convID := groupFixture(t, Options{})
	ctx := context.Background()
	base := svc.opts.Now()
	muteFor := 30 * time.Minute

	// member 无权禁言 → 3015
	if err := svc.UpdateConvSetting(ctx, 10002, messageapi.ConvSettingPayload{
		ConvID: cid(convID), MuteMember: &messageapi.MuteMemberPatch{UID: "10003", Until: base.Add(muteFor).UnixMilli()},
	}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("member 禁言应 3015: %v", err)
	}
	// admin 不能禁 owner/admin → 3015
	if err := svc.UpdateConvSetting(ctx, 10003, messageapi.ConvSettingPayload{
		ConvID: cid(convID), MuteMember: &messageapi.MuteMemberPatch{UID: "10001", Until: base.Add(muteFor).UnixMilli()},
	}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("admin 禁 owner 应 3015: %v", err)
	}
	// 超 30 天 → 9001
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), MuteMember: &messageapi.MuteMemberPatch{UID: "10002", Until: base.Add(31 * 24 * time.Hour).UnixMilli()},
	}); codeOf(err) != errx.CodeBadRequest {
		t.Fatalf("禁言 >30 天应 9001: %v", err)
	}
	// admin 禁 member 成功（矩阵允许）；系统消息 member.muted + until
	until := base.Add(muteFor).UnixMilli()
	if err := svc.UpdateConvSetting(ctx, 10003, messageapi.ConvSettingPayload{
		ConvID: cid(convID), MuteMember: &messageapi.MuteMemberPatch{UID: "10002", Until: until},
	}); err != nil {
		t.Fatalf("admin 禁 member: %v", err)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMemberMuted || body.Until != until {
		t.Fatalf("禁言系统消息不符: %+v", body)
	}
	// 被禁者发消息 → 3006
	if _, err := svc.Send(ctx, 10002, textPayload(convID, "muted-1", "hi")); codeOf(err) != errx.CodeIMMuted {
		t.Fatalf("被禁言发送应 3006: %v", err)
	}
	// 解除 → member.unmuted，发送恢复
	if err := svc.UpdateConvSetting(ctx, 10003, messageapi.ConvSettingPayload{
		ConvID: cid(convID), MuteMember: &messageapi.MuteMemberPatch{UID: "10002", Until: 0},
	}); err != nil {
		t.Fatalf("解除禁言: %v", err)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMemberUnmuted {
		t.Fatalf("解除系统消息 kind=%q", body.Kind)
	}
	if _, err := svc.Send(ctx, 10002, textPayload(convID, "unmute-1", "hi")); err != nil {
		t.Fatalf("解除后发送: %v", err)
	}

	// @全体默认仅管理（mention_all_policy=2）：member 带 all=true → 3014
	mentionAll := []messageapi.Mention{{All: true, Range: [2]int{0, 3}}}
	if _, err := svc.Send(ctx, 10002, messageapi.SendPayload{
		ConvID: messageapi.ConvID(fmt.Sprintf("%d", convID)), ClientMsgID: "at-all-1",
		Type: "text", Body: mustJSON(textBody{Text: "@全体 注意"}), Mentions: mentionAll,
	}); codeOf(err) != errx.CodeIMMentionAllDenied {
		t.Fatalf("member @全体应 3014: %v", err)
	}
	// admin 可 @全体
	if _, err := svc.Send(ctx, 10003, messageapi.SendPayload{
		ConvID: messageapi.ConvID(fmt.Sprintf("%d", convID)), ClientMsgID: "at-all-2",
		Type: "text", Body: mustJSON(textBody{Text: "@全体 发布"}), Mentions: mentionAll,
	}); err != nil {
		t.Fatalf("admin @全体: %v", err)
	}

	// 全员禁言：member 发送 3006；owner/admin 豁免；mute.all.on 系统消息
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), MuteAllUntil: int64Ptr(base.Add(1 * time.Hour).UnixMilli()),
	}); err != nil {
		t.Fatalf("全员禁言: %v", err)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMuteAllOn {
		t.Fatalf("全员禁言系统消息 kind=%q", body.Kind)
	}
	if _, err := svc.Send(ctx, 10002, textPayload(convID, "mall-1", "hi")); codeOf(err) != errx.CodeIMMuted {
		t.Fatalf("全员禁言 member 发送应 3006: %v", err)
	}
	if _, err := svc.Send(ctx, 10003, textPayload(convID, "mall-2", "hi")); err != nil {
		t.Fatalf("全员禁言 admin 应豁免: %v", err)
	}
	// 解除全员禁言 → mute.all.off
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), MuteAllUntil: int64Ptr(0),
	}); err != nil {
		t.Fatalf("解除全员禁言: %v", err)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMuteAllOff {
		t.Fatalf("解除全员禁言系统消息 kind=%q", body.Kind)
	}
}

// ── 公告（INT-IM-18）──

func TestAnnouncementChanged(t *testing.T) {
	svc, _, bus, convID := groupFixture(t, Options{})
	convUpdated := captureConvUpdated(bus)
	ctx := context.Background()
	// member 无权 → 3015
	if err := svc.UpdateConvSetting(ctx, 10002, messageapi.ConvSettingPayload{
		ConvID: cid(convID), Announcement: strPtr("越权公告"),
	}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("member 发公告应 3015: %v", err)
	}
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), Announcement: strPtr("3 月迭代启动会 15:00"),
	}); err != nil {
		t.Fatalf("发公告: %v", err)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindAnnouncementChanged {
		t.Fatalf("公告系统消息 kind=%q", body.Kind)
	}
	detail, _ := svc.GetConvDetail(ctx, 10001, convID)
	if detail.GroupSetting == nil || detail.GroupSetting.Announcement != "3 月迭代启动会 15:00" {
		t.Fatalf("公告未落库: %+v", detail.GroupSetting)
	}
	// 事件 kind=announcement
	found := false
	for _, evt := range convUpdated() {
		if evt.Kind == "announcement" {
			found = true
			if evt.Setting == nil || evt.Setting.Announcement != "3 月迭代启动会 15:00" {
				t.Fatalf("announcement 事件应带设置快照: %+v", evt.Setting)
			}
		}
	}
	if !found {
		t.Fatalf("缺少 conv.updated(announcement) 事件")
	}
}

// ── 解散（INT-IM-19）──

func TestDissolve(t *testing.T) {
	svc, _, _, convID := groupFixture(t, Options{})
	ctx := context.Background()
	// admin 无权 → 3015
	if err := svc.DissolveConversation(ctx, 10003, convID); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("admin 解散应 3015: %v", err)
	}
	if err := svc.DissolveConversation(ctx, 10001, convID); err != nil {
		t.Fatalf("owner 解散: %v", err)
	}
	conv, _ := svc.repo.GetConversation(ctx, convID)
	if conv.Status != messageapi.ConvDissolved {
		t.Fatalf("status 应=2: %d", conv.Status)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindConvDissolved {
		t.Fatalf("解散系统消息 kind=%q", body.Kind)
	}
	// 解散后发送 → 3002
	if _, err := svc.Send(ctx, 10001, textPayload(convID, "after-dissolve", "hi")); codeOf(err) != errx.CodeIMConvDissolved {
		t.Fatalf("解散后发送应 3002: %v", err)
	}
}

// ── 申请状态机（PIM-06：待审/通过/拒绝/7 天过期）──

func TestApplyStateMachine(t *testing.T) {
	svc, _, _, convID := groupFixture(t, Options{})
	ctx := context.Background()

	// 成员申请 → 3012
	if _, err := svc.ApplyJoin(ctx, 10002, messageapi.ApplyPayload{ConvID: cid(convID)}); codeOf(err) != errx.CodeIMALreadyInConv {
		t.Fatalf("成员申请应 3012: %v", err)
	}
	// 仅邀请模式 → 3015
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), JoinMode: intPtr(3),
	}); err != nil {
		t.Fatalf("切仅邀请: %v", err)
	}
	if _, err := svc.ApplyJoin(ctx, 10004, messageapi.ApplyPayload{ConvID: cid(convID)}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("仅邀请申请应 3015: %v", err)
	}
	// 恢复需审批
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), JoinMode: intPtr(2),
	}); err != nil {
		t.Fatalf("切需审批: %v", err)
	}

	// 待审：申请成功 + apply.submitted 审批卡；同群同人待审幂等
	res, err := svc.ApplyJoin(ctx, 10004, messageapi.ApplyPayload{ConvID: cid(convID), Reason: "想加入"})
	if err != nil || res.ApplyID == "" {
		t.Fatalf("申请: %v %+v", err, res)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindApplySubmitted || body.Extra != "想加入" {
		t.Fatalf("申请系统消息不符: %+v", body)
	}
	dup, err := svc.ApplyJoin(ctx, 10004, messageapi.ApplyPayload{ConvID: cid(convID)})
	if err != nil || dup.ApplyID != res.ApplyID {
		t.Fatalf("重复申请应幂等: %v %+v", err, dup)
	}
	// member 无权审批 → 3015
	if err := svc.HandleApply(ctx, 10002, messageapi.ApplyHandlePayload{ApplyID: res.ApplyID, Action: "approve"}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("member 审批应 3015: %v", err)
	}

	// 拒绝路径：另一个申请人 10005
	res2, _ := svc.ApplyJoin(ctx, 10005, messageapi.ApplyPayload{ConvID: cid(convID), Reason: "me too"})
	if err := svc.HandleApply(ctx, 10003, messageapi.ApplyHandlePayload{ApplyID: res2.ApplyID, Action: "reject"}); err != nil {
		t.Fatalf("admin 拒绝: %v", err)
	}
	// 重复处理 → 3015
	if err := svc.HandleApply(ctx, 10001, messageapi.ApplyHandlePayload{ApplyID: res2.ApplyID, Action: "approve"}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("已处理申请应 3015: %v", err)
	}

	// 通过：入群 + member.joined（join_by_apply 文案路径）
	if err := svc.HandleApply(ctx, 10001, messageapi.ApplyHandlePayload{ApplyID: res.ApplyID, Action: "approve"}); err != nil {
		t.Fatalf("owner 通过: %v", err)
	}
	if m, _ := svc.repo.MemberOf(ctx, convID, 10004); m == nil || m.Status != 1 {
		t.Fatalf("通过后应入群: %+v", m)
	}
	if body := lastSystemBody(t, svc, convID); body.Kind != messageapi.SysKindMemberJoined || !body.JoinByApply {
		t.Fatalf("通过申请系统消息不符: %+v", body)
	}
	// 通过后再处理 → 3015
	if err := svc.HandleApply(ctx, 10001, messageapi.ApplyHandlePayload{ApplyID: res.ApplyID, Action: "reject"}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("已通过再处理应 3015: %v", err)
	}
}

// 7 天过期：时钟注入推进 → status=4，审批拒绝 3015
func TestApplyExpiredAfter7Days(t *testing.T) {
	svc, _, _, convID := groupFixture(t, Options{})
	base := svc.opts.Now()
	ctx := context.Background()
	if err := svc.UpdateConvSetting(ctx, 10001, messageapi.ConvSettingPayload{
		ConvID: cid(convID), JoinMode: intPtr(2),
	}); err != nil {
		t.Fatalf("切需审批: %v", err)
	}
	res, err := svc.ApplyJoin(ctx, 10006, messageapi.ApplyPayload{ConvID: cid(convID), Reason: "过期的申请"})
	if err != nil {
		t.Fatalf("申请: %v", err)
	}
	// 推进 7 天 + 1s
	svc.opts.Now = func() time.Time { return base.Add(7*24*time.Hour + time.Second) }
	if err := svc.HandleApply(ctx, 10001, messageapi.ApplyHandlePayload{ApplyID: res.ApplyID, Action: "approve"}); codeOf(err) != errx.CodeIMApplyInvalid {
		t.Fatalf("过期审批应 3015: %v", err)
	}
	applyID := mustParseI64(t, res.ApplyID)
	apply, _ := svc.repo.GetApplyByID(ctx, applyID)
	if apply == nil || apply.Status != messagerepo.ApplyExpired {
		t.Fatalf("申请应已过期(status=4): %+v", apply)
	}
	// 未入群
	if m, _ := svc.repo.MemberOf(ctx, convID, 10006); m != nil && m.Status == 1 {
		t.Fatalf("过期申请不应入群")
	}
}

// ── 小工具 ──

func cid(convID int64) messageapi.ConvID { return messageapi.ConvID(fmt.Sprintf("%d", convID)) }

func intPtr(v int) *int       { return &v }
func int64Ptr(v int64) *int64 { return &v }
func strPtr(v string) *string { return &v }

func mustParseI64(t *testing.T, s string) int64 {
	t.Helper()
	var v int64
	if _, err := fmt.Sscanf(s, "%d", &v); err != nil {
		t.Fatalf("解析 %q: %v", s, err)
	}
	return v
}
