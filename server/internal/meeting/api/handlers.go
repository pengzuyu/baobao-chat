// REST 壳（meeting 包内自持；authed 由 main 挂载）。响应统一 platform/httpx。
package meetingapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	meetingservice "github.com/baobaowork/server/internal/meeting/service"
	errx "github.com/baobaowork/server/internal/platform/errors"
	"github.com/baobaowork/server/internal/platform/httpx"
)

// RegisterRoutes 会议路由（21 §6；阶段一：预约/即时/日历/忙闲/RSVP/
// 改期取消/入会状态；周期会与纪要阶段二）
func RegisterRoutes(mux *http.ServeMux, authed func(http.HandlerFunc) http.Handler, svc *meetingservice.Service) {
	mux.Handle("POST /api/v1/meetings", authed(handleCreate(svc)))
	mux.Handle("GET /api/v1/meetings", authed(handleListMy(svc)))
	mux.Handle("GET /api/v1/meetings/{id}", authed(handleGet(svc)))
	mux.Handle("POST /api/v1/meetings/{id}/rsvp", authed(handleRSVP(svc)))
	mux.Handle("POST /api/v1/meetings/{id}/reschedule", authed(handleReschedule(svc)))
	mux.Handle("POST /api/v1/meetings/{id}/cancel", authed(handleCancel(svc)))
	mux.Handle("POST /api/v1/meetings/{id}/start", authed(handleStart(svc)))
	mux.Handle("POST /api/v1/meetings/{id}/end", authed(handleEnd(svc)))
	mux.Handle("GET /api/v1/meetings/calendar", authed(handleCalendar(svc)))
	mux.Handle("GET /api/v1/meetings/freebusy", authed(handleFreeBusy(svc)))
	// 周期系列（21 §4.2）
	mux.Handle("POST /api/v1/meetings/recurrence", authed(handleCreateRecurring(svc)))
	mux.Handle("GET /api/v1/meetings/series/{sid}", authed(handleSeriesList(svc)))
	mux.Handle("POST /api/v1/meetings/{id}/series-split", authed(handleSeriesSplit(svc)))
	mux.Handle("POST /api/v1/meetings/series/{sid}/update-all", authed(handleSeriesUpdateAll(svc)))
}

func handleCreateRecurring(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Title        string                   `json:"title"`
			AgendaMD     string                   `json:"agenda_md"`
			StartTimeMS  int64                    `json:"start_time"`
			EndTimeMS    int64                    `json:"end_time"`
			TZ           string                   `json:"tz"`
			ConvID       int64                    `json:"conv_id"`
			Participants []int64                  `json:"participants"`
			SkipHolidays bool                     `json:"skip_holidays"`
			Rule         meetingservice.RecurRule `json:"rule"`
		}
		if !decode(w, r, &req) {
			return
		}
		list, err := svc.CreateRecurring(r.Context(), tenantOf(r), actorOf(r), meetingservice.CreateRecurringReq{
			CreateReq: meetingservice.CreateReq{
				Title: req.Title, AgendaMD: req.AgendaMD,
				StartTime: time.UnixMilli(req.StartTimeMS), EndTime: time.UnixMilli(req.EndTimeMS),
				TZ: req.TZ, ConvID: req.ConvID, Participants: req.Participants,
			},
			Rule: req.Rule, SkipHolidays: req.SkipHolidays,
		})
		respond(w, r, list, err)
	}
}

func handleSeriesList(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid, err := strconv.ParseInt(r.PathValue("sid"), 10, 64)
		if err != nil || sid <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "sid 非法"))
			return
		}
		list, lerr := svc.SeriesList(r.Context(), tenantOf(r), actorOf(r), sid)
		respond(w, r, list, lerr)
	}
}

func handleSeriesSplit(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		newSID, err := svc.SplitSeries(r.Context(), tenantOf(r), actorOf(r), id)
		respond(w, r, map[string]int64{"new_series_id": newSID}, err)
	}
}

func handleSeriesUpdateAll(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid, err := strconv.ParseInt(r.PathValue("sid"), 10, 64)
		if err != nil || sid <= 0 {
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "sid 非法"))
			return
		}
		var body struct {
			Title    string `json:"title"`
			AgendaMD string `json:"agenda_md"`
		}
		if !decode(w, r, &body) {
			return
		}
		respond(w, r, map[string]bool{"ok": true},
			svc.UpdateSeriesAll(r.Context(), tenantOf(r), actorOf(r), sid, body.Title, body.AgendaMD))
	}
}

func handleCreate(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Title        string  `json:"title"`
			AgendaMD     string  `json:"agenda_md"`
			Instant      bool    `json:"instant"`
			StartTimeMS  int64   `json:"start_time"` // ms（即时会可缺省）
			EndTimeMS    int64   `json:"end_time"`
			TZ           string  `json:"tz"`
			ConvID       int64   `json:"conv_id"`
			Participants []int64 `json:"participants"`
		}
		if !decode(w, r, &req) {
			return
		}
		m, err := svc.Create(r.Context(), tenantOf(r), actorOf(r), meetingservice.CreateReq{
			Title: req.Title, AgendaMD: req.AgendaMD, Instant: req.Instant,
			StartTime: time.UnixMilli(req.StartTimeMS), EndTime: time.UnixMilli(req.EndTimeMS),
			TZ: req.TZ, ConvID: req.ConvID, Participants: req.Participants,
		})
		respond(w, r, m, err)
	}
}

func handleListMy(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		from, to, ok := windowOf(w, r, q.Get("from"), q.Get("to"))
		if !ok {
			return
		}
		list, err := svc.ListMy(r.Context(), tenantOf(r), actorOf(r), from, to,
			q.Get("include_canceled") == "1")
		respond(w, r, list, err)
	}
}

func handleGet(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		m, err := svc.Get(r.Context(), tenantOf(r), actorOf(r), id)
		respond(w, r, m, err)
	}
}

func handleRSVP(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		var body struct {
			RSVP int `json:"rsvp"`
		}
		if !decode(w, r, &body) {
			return
		}
		respond(w, r, map[string]bool{"ok": true},
			svc.RSVP(r.Context(), tenantOf(r), actorOf(r), id, body.RSVP))
	}
}

func handleReschedule(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		var body struct {
			StartTimeMS int64 `json:"start_time"`
			EndTimeMS   int64 `json:"end_time"`
		}
		if !decode(w, r, &body) {
			return
		}
		respond(w, r, map[string]bool{"ok": true},
			svc.Reschedule(r.Context(), tenantOf(r), actorOf(r), id,
				time.UnixMilli(body.StartTimeMS), time.UnixMilli(body.EndTimeMS)))
	}
}

func handleCancel(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true},
			svc.Cancel(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleStart(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		no, err := svc.StartLive(r.Context(), tenantOf(r), actorOf(r), id)
		respond(w, r, map[string]string{"meeting_no": no}, err)
	}
}

func handleEnd(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r, "id")
		if !ok {
			return
		}
		respond(w, r, map[string]bool{"ok": true},
			svc.EndLive(r.Context(), tenantOf(r), actorOf(r), id))
	}
}

func handleCalendar(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		from, to, ok := windowOf(w, r, q.Get("from"), q.Get("to"))
		if !ok {
			return
		}
		list, err := svc.CalendarEvents(r.Context(), tenantOf(r), actorOf(r), from, to)
		respond(w, r, list, err)
	}
}

func handleFreeBusy(svc *meetingservice.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		from, to, ok := windowOf(w, r, q.Get("from"), q.Get("to"))
		if !ok {
			return
		}
		var uids []int64
		for _, s := range splitCSV(q.Get("uids")) {
			if id, err := strconv.ParseInt(s, 10, 64); err == nil {
				uids = append(uids, id)
			}
		}
		blocks, err := svc.FreeBusy(r.Context(), tenantOf(r), uids, from, to)
		respond(w, r, blocks, err)
	}
}

// ---------------------------------------------------------------------------
// 薄壳工具
// ---------------------------------------------------------------------------

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || len(raw) == 0 {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 读取失败/为空"))
		return false
	}
	if err := json.Unmarshal(raw, v); err != nil {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "body 解析失败"))
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(key), 10, 64)
	if err != nil || id <= 0 {
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "id 非法"))
		return 0, false
	}
	return id, true
}

// windowOf from/to 毫秒时间窗（缺省=未来 7 天）
func windowOf(w http.ResponseWriter, r *http.Request, fromStr, toStr string) (time.Time, time.Time, bool) {
	from, err1 := strconv.ParseInt(fromStr, 10, 64)
	to, err2 := strconv.ParseInt(toStr, 10, 64)
	if err1 != nil || err2 != nil {
		if fromStr == "" && toStr == "" {
			now := time.Now()
			return now, now.Add(7 * 24 * time.Hour), true
		}
		httpx.Fail(w, r, errx.New(errx.CodeBadRequest, "from/to 毫秒时间戳"))
		return time.Time{}, time.Time{}, false
	}
	return time.UnixMilli(from), time.UnixMilli(to), true
}

func splitCSV(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(c)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

func respond(w http.ResponseWriter, r *http.Request, data any, err error) {
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.OK(w, r, data)
}

func actorOf(r *http.Request) int64 {
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	return uid
}

func tenantOf(r *http.Request) int64 { return 1 } // 单租户阶段一
