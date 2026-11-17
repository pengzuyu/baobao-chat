// presence 快照 REST 壳（GET /api/v1/presences，04 篇 §5.3 配套）：
// 登录/重连后首拉种子，此后靠 presence.changed 推送增量维持。
// uid 字符串口径对齐 presence.changed；uid 升序稳定输出。
package gateway

import (
	"net/http"
	"sort"
	"strconv"

	"github.com/baobaochat/server/internal/platform/httpx"
)

// HandlePresences 在线状态快照（观察者口径：invisible→offline；v0.1 单租户全量）
func (g *Gateway) HandlePresences() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		snap := g.presence.Snapshot()
		uids := make([]int64, 0, len(snap))
		for uid := range snap {
			uids = append(uids, uid)
		}
		sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
		items := make([]map[string]string, 0, len(uids))
		for _, uid := range uids {
			items = append(items, map[string]string{"uid": strconv.FormatInt(uid, 10), "status": snap[uid]})
		}
		httpx.OK(w, r, map[string]any{"items": items})
	}
}
