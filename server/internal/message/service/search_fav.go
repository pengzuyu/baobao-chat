// 搜索（PIM-07 服务端态）与收藏（PIM-08）：D03 §3.7/§3.8、API-IM-10/11/12、INT-IM-21。
//   - 搜索：keyword 校验（非空白 ≤64 字 9001）→ 过滤器 AND → 仅本人可见会话（在群成员），
//     msg_id 倒序分页；命中片段高亮区间服务端顺带下发（端内 substring 高亮兜底）。
//   - 收藏：幂等 UK(user_id,msg_id)、上限 1000（3022）；快照仅存 msg_id+conv_id，
//     详情实时取——撤回消息可收藏，列表渲染占位（msg.status=2）。
package messageservice

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	messageapi "github.com/baobaowork/server/internal/message/api"
	messagerepo "github.com/baobaowork/server/internal/message/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// Favorite 收藏（D03 API-IM-10/INT-IM-06）：
// ① 消息存在（3017）② 会话成员校验（3019/3002/3001，撤回消息亦可收藏）
// ③ 幂等前置：已收藏直接返回原行（不占新额度）④ 上限校验（≥1000 → 3022）⑤ 落库。
func (s *Service) Favorite(ctx context.Context, userID, msgID int64) (*messageapi.FavoriteResult, error) {
	msg, err := s.repo.GetMessageByID(ctx, msgID)
	if err != nil {
		return nil, errx.New(errx.CodeIMMessageNotFound, "消息不存在")
	}
	if err := s.mustActiveMember(ctx, msg.ConvID, userID); err != nil {
		return nil, err
	}
	if exists, _ := s.repo.ExistsFavorite(ctx, userID, msgID); exists {
		cur, created, err := s.repo.AddFavorite(ctx, userID, msgID, msg.ConvID) // 幂等命中返回现值
		if err != nil {
			return nil, errx.From(err)
		}
		_ = created
		return &messageapi.FavoriteResult{
			FavoriteID: cur.ID, CreatedAt: cur.CreatedAt.UnixMilli(), Duplicate: true,
		}, nil
	}
	if n, err := s.repo.CountFavorites(ctx, userID); err != nil {
		return nil, errx.From(err)
	} else if n >= int64(s.opts.MaxFavorites) {
		return nil, errx.New(errx.CodeIMFavoriteLimit, "收藏数量超限（每人 ≤1000 条）")
	}
	fav, created, err := s.repo.AddFavorite(ctx, userID, msgID, msg.ConvID)
	if err != nil {
		return nil, errx.From(err)
	}
	// 并发兜底：校验与写入之间他人并发收藏导致超限——UK 落库成功即可接受（软上限）
	return &messageapi.FavoriteResult{
		FavoriteID: fav.ID, CreatedAt: fav.CreatedAt.UnixMilli(), Duplicate: !created,
	}, nil
}

// Unfavorite 取消收藏（幂等：不存在 no-op，D03 API-IM-10 DELETE）
func (s *Service) Unfavorite(ctx context.Context, userID, msgID int64) error {
	if err := s.repo.RemoveFavorite(ctx, userID, msgID); err != nil {
		return errx.From(err)
	}
	return nil
}

// ListFavorites 收藏列表（D03 API-IM-11）：created_at 倒序 + type 过滤 + cursor 翻页；
// 逐条联表回消息实时快照（撤回 → status=2 端内占位）与会话名。
func (s *Service) ListFavorites(ctx context.Context, userID int64, msgType string, cursor int64, limit int) (*messageapi.FavoriteListResult, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	favs, err := s.repo.ListFavorites(ctx, userID, msgType, cursor, limit+1)
	if err != nil {
		return nil, errx.From(err)
	}
	hasMore := len(favs) > limit
	if hasMore {
		favs = favs[:limit]
	}
	out := &messageapi.FavoriteListResult{Items: []messageapi.FavoriteItem{}, HasMore: hasMore}
	for _, f := range favs {
		item := messageapi.FavoriteItem{
			ID:        f.ID,
			Conv:      messageapi.FavoriteConv{ID: strconv.FormatInt(f.ConvID, 10)},
			CreatedAt: f.CreatedAt.UnixMilli(),
		}
		// 消息实时快照（详情实时取：撤回后 status=2 → 列表渲染占位）
		if msg, err := s.repo.GetMessageByID(ctx, f.MsgID); err == nil && msg != nil {
			if msg.SenderName == "" {
				msg.SenderName = s.nameOf(msg.SenderID)
			}
			item.Msg = msg
		}
		// 来源会话名（会话已删等异常降级为空名——卡片仍可点击跳转）
		if conv, err := s.repo.GetConversation(ctx, f.ConvID); err == nil {
			item.Conv.Name, item.Conv.Type = conv.Name, conv.Type
		}
		out.Items = append(out.Items, item)
	}
	if n := len(favs); n > 0 {
		out.NextCursor = strconv.FormatInt(favs[n-1].ID, 10)
	}
	return out, nil
}

// SearchMessages 服务端态搜索（D03 API-IM-12）：
// keyword 校验（非空白/≤64 字 9001）→ repo 过滤器检索 → 补 conv_name/sender_name/高亮区间。
func (s *Service) SearchMessages(ctx context.Context, userID int64, p messageapi.SearchParams) (*messageapi.SearchResult, error) {
	p.Keyword = strings.TrimSpace(p.Keyword)
	if p.Keyword == "" {
		return nil, errx.New(errx.CodeBadRequest, "keyword 必填（非空白）")
	}
	if utf8.RuneCountInString(p.Keyword) > s.opts.MaxSearchKeywordRuns {
		return nil, errx.New(errx.CodeBadRequest, "keyword 超 64 字上限")
	}
	if p.Limit <= 0 || p.Limit > 100 {
		p.Limit = 20
	}
	msgs, err := s.repo.SearchMessages(ctx, messagerepo.SearchFilter{
		UserID: userID, Keyword: p.Keyword, FromUID: p.FromUID, ConvID: p.ConvID,
		Type: p.Type, FromTS: p.FromTS, ToTS: p.ToTS, Cursor: p.Cursor, Limit: p.Limit + 1,
	})
	if err != nil {
		return nil, errx.From(err)
	}
	hasMore := len(msgs) > p.Limit
	if hasMore {
		msgs = msgs[:p.Limit]
	}
	out := &messageapi.SearchResult{Items: []messageapi.SearchItem{}, HasMore: hasMore}
	convNames := map[int64]string{} // 会话名缓存（同会话多次命中免查）
	for i := range msgs {
		msg := msgs[i]
		if msg.SenderName == "" {
			msg.SenderName = s.nameOf(msg.SenderID)
		}
		name, ok := convNames[msg.ConvID]
		if !ok {
			if conv, err := s.repo.GetConversation(ctx, msg.ConvID); err == nil {
				name = conv.Name
			}
			convNames[msg.ConvID] = name
		}
		out.Items = append(out.Items, messageapi.SearchItem{
			Msg: msg, ConvName: name, SenderName: msg.SenderName,
			Highlight: highlightsOf(msg, p.Keyword),
		})
	}
	if n := len(msgs); n > 0 {
		out.NextCursor = strconv.FormatInt(msgs[n-1].ID, 10)
	}
	return out, nil
}

// highlightsOf 命中片段区间（text 消息 body.text 内字节偏移，最多 3 处；
// 大小写不敏感对齐 PG ILIKE / 内存子串匹配口径；端内 substring 高亮兜底）
func highlightsOf(m messageapi.Message, keyword string) []messageapi.SearchHighlight {
	if m.Type != "text" || len(m.Body) == 0 {
		return nil
	}
	var tb struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(m.Body, &tb); err != nil || tb.Text == "" {
		return nil
	}
	text, kw := strings.ToLower(tb.Text), strings.ToLower(keyword)
	var out []messageapi.SearchHighlight
	for from := 0; len(out) < 3; {
		idx := strings.Index(text[from:], kw)
		if idx < 0 {
			break
		}
		start := from + idx
		out = append(out, messageapi.SearchHighlight{Start: start, End: start + len(kw)})
		from = start + len(kw)
	}
	return out
}
