// 搜索（PIM-07 服务端态）与收藏（PIM-08）用例：D03 §3.7/§3.8、API-IM-10/11/12。
// 覆盖：收藏幂等/上限 3022/取消/列表倒序/type 过滤/撤回占位语义；
// 搜索命中+高亮定位字段/过滤器组合/keyword 边界/分页翻页/可见性。
package messageservice

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/baobaochat/server/internal/message/api"
	errx "github.com/baobaochat/server/internal/platform/errors"
)

// favOrFail 便捷收藏（失败即 Fatal）
func favOrFail(t *testing.T, svc *Service, uid, msgID int64) *messageapi.FavoriteResult {
	t.Helper()
	res, err := svc.Favorite(context.Background(), uid, msgID)
	if err != nil {
		t.Fatalf("favorite %d: %v", msgID, err)
	}
	return res
}

// bob 发言到 conv1（sender=10002，便于 from_uid 过滤用例）
func bobSend(t *testing.T, svc *Service, cmid, text string) *messageapi.SendResult {
	t.Helper()
	res, err := svc.Send(context.Background(), 10002, textPayload(1, cmid, text))
	if err != nil {
		t.Fatalf("bob send %s: %v", cmid, err)
	}
	return res
}

func TestFavoriteIdempotentAndLimit(t *testing.T) {
	// MaxFavorites=3 便于触发 3022（默认 1000 条造数代价高）
	svc, _, _ := seedFixture(t, Options{MaxFavorites: 3})
	ctx := context.Background()

	m1 := sendText(t, svc, 1, "f-1", "第一条")
	m2 := sendText(t, svc, 1, "f-2", "第二条")
	m3 := sendText(t, svc, 1, "f-3", "第三条")
	m4 := sendText(t, svc, 1, "f-4", "第四条")

	r1 := favOrFail(t, svc, 10001, m1.MsgID)
	if r1.Duplicate {
		t.Fatalf("首次收藏不应标记幂等命中: %+v", r1)
	}
	if r1.FavoriteID == 0 || r1.CreatedAt == 0 {
		t.Fatalf("favorite_id/created_at 应回填: %+v", r1)
	}
	// 幂等：重复收藏返回原 favorite_id（不占新额度）
	r1b := favOrFail(t, svc, 10001, m1.MsgID)
	if r1b.FavoriteID != r1.FavoriteID || !r1b.Duplicate {
		t.Fatalf("重复收藏应幂等返回原行: %+v vs %+v", r1, r1b)
	}
	favOrFail(t, svc, 10001, m2.MsgID)
	favOrFail(t, svc, 10001, m3.MsgID)
	// 上限 3：第 4 条 → 3022
	if _, err := svc.Favorite(ctx, 10001, m4.MsgID); errx.From(err).Code != errx.CodeIMFavoriteLimit {
		t.Fatalf("超限收藏应 3022: %v", err)
	}
	// 撤回额度后可再收藏
	if err := svc.Unfavorite(ctx, 10001, m2.MsgID); err != nil {
		t.Fatalf("unfavorite: %v", err)
	}
	favOrFail(t, svc, 10001, m4.MsgID)
}

func TestFavoriteNotFoundAndNotMember(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()
	// 消息不存在 → 3017
	if _, err := svc.Favorite(ctx, 10001, 999999); errx.From(err).Code != errx.CodeIMMessageNotFound {
		t.Fatalf("收藏不存在消息应 3017: %v", err)
	}
	// 非会话成员 → 3001（alice 不在 conv2 广播群的 publisher 角色但成员在——用 99999 外人视角）
	res := sendText(t, svc, 1, "f-nm", "成员可见")
	_ = res
	if _, err := svc.Favorite(ctx, 99999, res.MsgID); errx.From(err).Code != errx.CodeIMNotInConversation {
		t.Fatalf("非成员收藏应 3001: %v", err)
	}
	// Unfavorite 幂等：未收藏 no-op
	if err := svc.Unfavorite(ctx, 10001, 424242); err != nil {
		t.Fatalf("取消不存在的收藏应 no-op: %v", err)
	}
}

func TestListFavoritesOrderAndTypeFilter(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()

	m1 := sendText(t, svc, 1, "l-1", "文本一")
	m2 := sendText(t, svc, 1, "l-2", "文本二")
	m3 := sendText(t, svc, 1, "l-3", "文本三")
	favOrFail(t, svc, 10001, m1.MsgID)
	favOrFail(t, svc, 10001, m2.MsgID)
	favOrFail(t, svc, 10001, m3.MsgID)

	list, err := svc.ListFavorites(ctx, 10001, "", 0, 20)
	if err != nil {
		t.Fatalf("list favorites: %v", err)
	}
	if len(list.Items) != 3 || list.HasMore {
		t.Fatalf("收藏列表应 3 条无更多: %+v", list)
	}
	// 倒序：最新收藏在前（m3 → m2 → m1）
	want := []int64{m3.MsgID, m2.MsgID, m1.MsgID}
	for i, item := range list.Items {
		if item.Msg == nil || item.Msg.ID != want[i] {
			t.Fatalf("列表第 %d 条应为 msg %d: %+v", i, want[i], item.Msg)
		}
		if item.Conv.ID != "1" || item.Conv.Name != "alice-bob" || item.Conv.Type != messageapi.ConvSingle {
			t.Fatalf("conv 快照应回填会话 1: %+v", item.Conv)
		}
		if item.Msg.SenderName == "" {
			t.Fatalf("sender_name 应回填（高亮/渲染字段）: %+v", item.Msg)
		}
	}
	// type 过滤：text 命中；非存在类型空集
	textList, _ := svc.ListFavorites(ctx, 10001, "text", 0, 20)
	if len(textList.Items) != 3 {
		t.Fatalf("type=text 应 3 条: %d", len(textList.Items))
	}
	imgList, _ := svc.ListFavorites(ctx, 10001, "image", 0, 20)
	if len(imgList.Items) != 0 {
		t.Fatalf("type=image 应空: %d", len(imgList.Items))
	}
	// 翻页：limit=2 → 第一页 2 条 + hasMore，cursor=最后一条收藏 id 续拉
	page1, _ := svc.ListFavorites(ctx, 10001, "", 0, 2)
	if len(page1.Items) != 2 || !page1.HasMore || page1.NextCursor == "" {
		t.Fatalf("分页第一页异常: %+v", page1)
	}
	page2, _ := svc.ListFavorites(ctx, 10001, "", mustParseI64(t, page1.NextCursor), 2)
	if len(page2.Items) != 1 || page2.HasMore {
		t.Fatalf("分页第二页异常: %+v", page2)
	}
	if page2.Items[0].Msg.ID != m1.MsgID {
		t.Fatalf("第二页应为最早收藏: %+v", page2.Items[0].Msg)
	}
}

func TestFavoriteRecalledRendersPlaceholder(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()

	res := sendText(t, svc, 1, "rc-fav", "撤回后仍可收藏")
	if _, err := svc.Recall(ctx, 10001, res.MsgID, ""); err != nil {
		t.Fatalf("recall: %v", err)
	}
	// 撤回消息可收藏（快照仅存 msg_id+conv_id）
	favOrFail(t, svc, 10001, res.MsgID)
	list, err := svc.ListFavorites(ctx, 10001, "", 0, 20)
	if err != nil || len(list.Items) != 1 {
		t.Fatalf("收藏列表: %v %d", err, len(list.Items))
	}
	msg := list.Items[0].Msg
	if msg == nil || msg.Status != messageapi.MsgRecalled {
		// 占位语义：快照实时取，status=2 → 端内渲染"原消息已撤回"占位
		t.Fatalf("撤回消息收藏项应携带 status=2 快照: %+v", msg)
	}
	// 撤回正文不可检索：搜索不应命中
	sr, err := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "撤回后仍可收藏"})
	if err != nil || len(sr.Items) != 0 {
		t.Fatalf("撤回正文不可检索: %v %d", err, len(sr.Items))
	}
}

// seedSearch 搜索夹具：conv1（alice/bob）5 条命中 + 1 条不命中 + conv3 群（alice/bob/carol）2 条命中。
// conv3 用 groupFixture 的建群路径（seedFixture 已占 conv 1/2 → 群 ID=3）。
func seedSearch(t *testing.T) (*Service, []int64) {
	t.Helper()
	svc, _, _, conv3 := groupFixture(t, Options{})
	send := func(conv int64, cmid, text string) int64 {
		return sendText(t, svc, conv, cmid, text).MsgID
	}
	ids := []int64{
		send(1, "s-1", "顶针计划 Alpha 版本发布"),
		send(1, "s-2", "顶针计划 Beta 延期一周"),
		bobSend(t, svc, "s-3", "顶针计划评审通过").MsgID, // from_uid 过滤目标（bob=10002）
		send(1, "s-4", "无关消息一条"),
		send(1, "s-5", "顶针计划 GA 收尾"),
		send(conv3, "s-6", "群里同步：顶针计划冻结"),
		send(conv3, "s-7", "顶针计划发布会安排"),
	}
	return svc, ids
}

func TestSearchKeywordHitAndHighlightFields(t *testing.T) {
	svc, _ := seedSearch(t)
	ctx := context.Background()

	res, err := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "顶针计划"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(res.Items) != 6 {
		t.Fatalf("命中应 6 条（撤回不可检索口径无关，纯子串）: %d", len(res.Items))
	}
	// 高亮定位所需字段：msg 全量 + conv_name + sender_name + highlight 区间
	first := res.Items[0]
	if first.ConvName == "" || first.SenderName == "" {
		t.Fatalf("conv_name/sender_name 应回填: %+v", first)
	}
	if first.Msg.ConvID == 0 || first.Msg.Type != "text" || len(first.Msg.Body) == 0 {
		t.Fatalf("msg 快照应含 conv_id/type/body（端内 substring 高亮依据）: %+v", first.Msg)
	}
	for _, it := range res.Items {
		if len(it.Highlight) == 0 || it.Highlight[0].End <= it.Highlight[0].Start {
			t.Fatalf("text 命中应带 highlight 区间: %+v", it)
		}
	}
	// 不命中关键词
	none, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "不存在的词"})
	if len(none.Items) != 0 || none.HasMore {
		t.Fatalf("无命中应空集: %+v", none)
	}
}

func TestSearchFiltersCombination(t *testing.T) {
	svc, ids := seedSearch(t)
	ctx := context.Background()

	// from_uid=bob → 仅 s-3
	bySender, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "顶针计划", FromUID: 10002})
	if len(bySender.Items) != 1 || bySender.Items[0].Msg.ID != ids[2] {
		t.Fatalf("from_uid 过滤应仅 bob 的 s-3: %+v", bySender.Items)
	}
	// conv_id=3 → 群内 2 条
	byConv, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "顶针计划", ConvID: 3})
	if len(byConv.Items) != 2 {
		t.Fatalf("conv_id 过滤应 2 条: %d", len(byConv.Items))
	}
	for _, it := range byConv.Items {
		if it.Msg.ConvID != 3 {
			t.Fatalf("conv_id 过滤泄漏其它会话: %+v", it.Msg)
		}
	}
	// type=text → 全命中（夹具全 text）；type=file → 空
	byType, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "顶针", Type: "text"})
	if len(byType.Items) != 6 {
		t.Fatalf("type=text 应 6 条: %d", len(byType.Items))
	}
	noType, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "顶针", Type: "file"})
	if len(noType.Items) != 0 {
		t.Fatalf("type=file 应空: %d", len(noType.Items))
	}
	// from_ts/to_ts 时间窗：s-1..s-5 同毫秒夹具不可分——用未来窗口排除全部/全窗口包含校验方向
	future, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{
		Keyword: "顶针计划", FromTS: 2760000000000, ToTS: 2760000000001,
	})
	if len(future.Items) != 0 {
		t.Fatalf("时间窗外应空: %d", len(future.Items))
	}
	wide, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{
		Keyword: "顶针计划", FromTS: 0, ToTS: 2760000000000,
	})
	if len(wide.Items) != 6 {
		t.Fatalf("宽窗口应 6 条: %d", len(wide.Items))
	}
	// 可见性：carol（10003）不在 conv1 → 搜索仅见群内 2 条
	carol, _ := svc.SearchMessages(ctx, 10003, messageapi.SearchParams{Keyword: "顶针计划"})
	if len(carol.Items) != 2 {
		t.Fatalf("可见性过滤：carol 应仅群内 2 条: %d", len(carol.Items))
	}
}

func TestSearchKeywordBoundary(t *testing.T) {
	svc, _, _ := seedFixture(t, Options{})
	ctx := context.Background()
	sendText(t, svc, 1, "b-1", "英文 CaseInsensitive 匹配")

	cases := []struct {
		kw   string
		want errx.Code
	}{
		{"", errx.CodeBadRequest},                      // 缺失
		{"   ", errx.CodeBadRequest},                   // 纯空白
		{strings.Repeat("字", 65), errx.CodeBadRequest}, // 65 字超限
		{strings.Repeat("字", 64), 0},                   // 64 字合法（不命中但不应报错）
	}
	for _, c := range cases {
		_, err := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: c.kw})
		if c.want == 0 {
			if err != nil {
				t.Fatalf("keyword=%q 不应报错: %v", c.kw, err)
			}
			continue
		}
		if errx.From(err).Code != c.want {
			t.Fatalf("keyword=%q 应 %d: %v", c.kw, c.want, err)
		}
	}
	// 大小写不敏感（对齐 PG ILIKE 口径）
	hit, err := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "caseinsensitive"})
	if err != nil || len(hit.Items) != 1 {
		t.Fatalf("大小写不敏感命中: %v %d", err, len(hit.Items))
	}
}

func TestSearchPaginationByMsgIDCursor(t *testing.T) {
	svc, ids := seedSearch(t)
	ctx := context.Background()

	// 命中 6 条按 msg_id 倒序；limit=2 翻 3 页
	p1, err := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{Keyword: "顶针计划", Limit: 2})
	if err != nil || len(p1.Items) != 2 || !p1.HasMore {
		t.Fatalf("第 1 页: %v %+v", err, p1)
	}
	if p1.Items[0].Msg.ID != ids[6] || p1.Items[1].Msg.ID != ids[5] {
		t.Fatalf("第 1 页应为最新两条（倒序）: %d %d", p1.Items[0].Msg.ID, p1.Items[1].Msg.ID)
	}
	p2, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{
		Keyword: "顶针计划", Limit: 2, Cursor: mustParseI64(t, p1.NextCursor),
	})
	if len(p2.Items) != 2 || !p2.HasMore {
		t.Fatalf("第 2 页异常: %+v", p2)
	}
	p3, _ := svc.SearchMessages(ctx, 10001, messageapi.SearchParams{
		Keyword: "顶针计划", Limit: 2, Cursor: mustParseI64(t, p2.NextCursor),
	})
	if len(p3.Items) != 2 || p3.HasMore {
		t.Fatalf("第 3 页应 2 条且无更多: %+v", p3)
	}
	// 全页拼回 = 倒序全集
	got := append(append(append([]int64{}, p1.Items[0].Msg.ID, p1.Items[1].Msg.ID),
		p2.Items[0].Msg.ID, p2.Items[1].Msg.ID), p3.Items[0].Msg.ID, p3.Items[1].Msg.ID)
	want := []int64{ids[6], ids[5], ids[4], ids[2], ids[1], ids[0]}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("翻页第 %d 条应为 %d got %d（%v）", i, want[i], got[i], got)
		}
	}
	_ = fmt.Sprint() // 保持 fmt 导入（want 打印在失败分支使用）
}
