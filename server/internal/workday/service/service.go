// Package workdayservice 工作日日历服务（D35）：默认规则 + 例外覆盖。
//
// 默认规则：周一~五=工作日、六日=周末（不落库）；表里只存例外。读取时合并成
// 全年 365/366 天给客户端；导入按“合并后的最终视图”计算差异，落库时只保留
// 与默认规则不同的日期，避免 yearly 365 行冗余。
package workdayservice

import (
	"context"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	errx "github.com/baobaochat/server/internal/platform/errors"
	workdayapi "github.com/baobaochat/server/internal/workday/api"
	workdayrepo "github.com/baobaochat/server/internal/workday/repo"
)

const (
	minYear    = 2000
	maxYear    = 2100
	maxDays    = 366
	maxName    = 40 // 节假日名/说明 ≤40 字
	maxDiffs   = 100
	dateLayout = "2006-01-02"
)

// Options 服务配置
type Options struct {
	// Now 时钟注入（测试）
	Now func() time.Time
	// Audit 管理端写操作审计回调（main 装配接 admin 域；nil=跳过）
	Audit func(ctx context.Context, tenantID, operatorID int64, action, target string, detail map[string]any) error
}

func (o *Options) fillDefaults() {
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Service 工作日日历服务
type Service struct {
	repo workdayrepo.Repo
	opts Options
}

var _ workdayapi.Service = (*Service)(nil)

// New 构造
func New(opts Options, r workdayrepo.Repo) *Service {
	opts.fillDefaults()
	return &Service{repo: r, opts: opts}
}

// ── 类型映射 ────────────────────────────────────────────────────────────────

// defaultType 默认规则：周一~五=1(工作日)，六日=2(周末)
func defaultType(t time.Time) int16 {
	if wd := t.UTC().Weekday(); wd == time.Saturday || wd == time.Sunday {
		return 2
	}
	return 1
}

func typeCode(name string) (int16, bool) {
	switch name {
	case workdayapi.TypeWorkday:
		return 1, true
	case workdayapi.TypeWeekend:
		return 2, true
	case workdayapi.TypeHoliday:
		return 3, true
	}
	return 0, false
}

func typeName(code int16) string {
	switch code {
	case 1:
		return workdayapi.TypeWorkday
	case 2:
		return workdayapi.TypeWeekend
	case 3:
		return workdayapi.TypeHoliday
	}
	return workdayapi.TypeWorkday
}

func dayKey(t time.Time) string { return t.UTC().Format(dateLayout) }

func dayStart(year int) time.Time { return time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC) }
func yearEnd(year int) time.Time  { return time.Date(year+1, 1, 1, 0, 0, 0, 0, time.UTC) }

func validateYear(year int) error {
	if year < minYear || year > maxYear {
		return errx.New(errx.CodeWorkdayParamInvalid, "年份越界（2000-2100）")
	}
	return nil
}

// parseDate 严格 YYYY-MM-DD（拒绝 2026-1-1 之类宽松写法）
func parseDate(s string) (time.Time, error) {
	t, err := time.ParseInLocation(dateLayout, s, time.UTC)
	if err != nil || t.Format(dateLayout) != s {
		return time.Time{}, errx.New(errx.CodeWorkdayParamInvalid, "日期格式非法："+s)
	}
	return t, nil
}

func checkName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > maxName {
		return "", errx.New(errx.CodeWorkdayParamInvalid, "日历名称超长（≤40 字）")
	}
	return name, nil
}

// ── 读 ──────────────────────────────────────────────────────────────────────

// Year 全年合并视图
func (s *Service) Year(ctx context.Context, tenantID int64, year int) (*workdayapi.YearDTO, error) {
	days, err := s.merged(ctx, tenantID, year)
	if err != nil {
		return nil, err
	}
	return &workdayapi.YearDTO{Year: year, Days: days}, nil
}

// merged 默认规则 + 例外合并成全年
func (s *Service) merged(ctx context.Context, tenantID int64, year int) ([]workdayapi.DayDTO, error) {
	if err := validateYear(year); err != nil {
		return nil, err
	}
	rows, err := s.repo.ListYear(ctx, tenantID, dayStart(year), yearEnd(year))
	if err != nil {
		return nil, err
	}
	byDay := make(map[string]workdayrepo.Override, len(rows))
	for _, r := range rows {
		byDay[dayKey(r.Day)] = r
	}
	out := make([]workdayapi.DayDTO, 0, 366)
	for t := dayStart(year); t.Before(yearEnd(year)); t = t.AddDate(0, 0, 1) {
		k := dayKey(t)
		if r, ok := byDay[k]; ok {
			src := r.Source
			if src == "" {
				src = "manual"
			}
			out = append(out, workdayapi.DayDTO{Date: k, Type: typeName(r.DayType), Name: r.Name, Source: src})
			continue
		}
		out = append(out, workdayapi.DayDTO{Date: k, Type: typeName(defaultType(t)), Source: "default"})
	}
	return out, nil
}

// Export 导出全年合并 JSON（与导入同 schema）
func (s *Service) Export(ctx context.Context, tenantID int64, year int, region string) (*workdayapi.ExportDTO, error) {
	days, err := s.merged(ctx, tenantID, year)
	if err != nil {
		return nil, err
	}
	if region == "" {
		region = "CN"
	}
	return &workdayapi.ExportDTO{Version: 1, Year: year, Region: region, Days: days}, nil
}

// ── 写 ──────────────────────────────────────────────────────────────────────

// UpsertDays 批量设置例外（等于默认规则且无名称 → 归一为删除）
func (s *Service) UpsertDays(ctx context.Context, tenantID, operatorID int64, year int, days []workdayapi.DayInput) error {
	if err := validateYear(year); err != nil {
		return err
	}
	if len(days) == 0 {
		return errx.New(errx.CodeWorkdayParamInvalid, "days 不能为空")
	}
	if len(days) > maxDays {
		return errx.New(errx.CodeWorkdayTooManyDays, "单次最多 366 天")
	}
	seen := map[string]struct{}{}
	var upserts, deletes []workdayrepo.Override
	now := s.opts.Now()
	for _, in := range days {
		t, err := parseDate(in.Date)
		if err != nil {
			return err
		}
		if t.Year() != year {
			return errx.New(errx.CodeWorkdayParamInvalid, "日期不属于所选年份："+in.Date)
		}
		code, ok := typeCode(in.Type)
		if !ok {
			return errx.New(errx.CodeWorkdayParamInvalid, "日期类型非法："+in.Type)
		}
		name, err := checkName(in.Name)
		if err != nil {
			return err
		}
		if _, dup := seen[in.Date]; dup {
			return errx.New(errx.CodeWorkdayParamInvalid, "日期重复："+in.Date)
		}
		seen[in.Date] = struct{}{}
		row := workdayrepo.Override{TenantID: tenantID, Day: t, DayType: code, Name: name, Source: "manual", UpdatedBy: operatorID, UpdatedAt: now}
		if code == defaultType(t) && name == "" {
			deletes = append(deletes, row)
			continue
		}
		upserts = append(upserts, row)
	}
	if err := s.repo.DeleteMany(ctx, tenantID, daysOf(deletes)); err != nil {
		return err
	}
	if err := s.repo.UpsertMany(ctx, upserts); err != nil {
		return err
	}
	s.audit(ctx, tenantID, operatorID, "workday.calendar.upsert", year, map[string]any{
		"upsert": len(upserts), "reset": len(deletes),
	})
	return nil
}

// ResetDays 恢复默认（dates 空=整年）
func (s *Service) ResetDays(ctx context.Context, tenantID, operatorID int64, year int, dates []string) error {
	if err := validateYear(year); err != nil {
		return err
	}
	if len(dates) == 0 {
		if err := s.repo.DeleteRange(ctx, tenantID, dayStart(year), yearEnd(year)); err != nil {
			return err
		}
		s.audit(ctx, tenantID, operatorID, "workday.calendar.reset", year, map[string]any{"scope": "year"})
		return nil
	}
	if len(dates) > maxDays {
		return errx.New(errx.CodeWorkdayTooManyDays, "单次最多 366 天")
	}
	seen := map[string]struct{}{}
	list := make([]time.Time, 0, len(dates))
	for _, d := range dates {
		t, err := parseDate(d)
		if err != nil {
			return err
		}
		if t.Year() != year {
			return errx.New(errx.CodeWorkdayParamInvalid, "日期不属于所选年份："+d)
		}
		if _, dup := seen[d]; dup {
			continue
		}
		seen[d] = struct{}{}
		list = append(list, t)
	}
	if err := s.repo.DeleteMany(ctx, tenantID, list); err != nil {
		return err
	}
	s.audit(ctx, tenantID, operatorID, "workday.calendar.reset", year, map[string]any{"days": len(list)})
	return nil
}

// Import JSON 导入：dryRun 只算差异；merge 叠加、replace 以默认规则为底重放
func (s *Service) Import(ctx context.Context, tenantID, operatorID int64, req workdayapi.ImportReq) (*workdayapi.ImportResult, error) {
	if req.Version != 0 && req.Version != 1 {
		return nil, errx.New(errx.CodeWorkdayImportInvalid, "不支持的 version")
	}
	if err := validateYear(req.Year); err != nil {
		return nil, err
	}
	mode := req.Mode
	if mode == "" {
		mode = "merge"
	}
	if mode != "merge" && mode != "replace" {
		return nil, errx.New(errx.CodeWorkdayImportInvalid, "mode 只能是 merge/replace")
	}
	if len(req.Days) > maxDays {
		return nil, errx.New(errx.CodeWorkdayTooManyDays, "单次最多 366 天")
	}

	current, err := s.merged(ctx, tenantID, req.Year)
	if err != nil {
		return nil, err
	}
	curByDay := make(map[string]workdayapi.DayDTO, len(current))
	for _, d := range current {
		curByDay[d.Date] = d
	}

	// 目标视图
	next := make(map[string]workdayapi.DayDTO, len(current))
	if mode == "replace" {
		for _, d := range current {
			t, _ := parseDate(d.Date)
			next[d.Date] = workdayapi.DayDTO{Date: d.Date, Type: typeName(defaultType(t)), Source: "default"}
		}
	} else {
		for k, v := range curByDay {
			next[k] = v
		}
	}
	seen := map[string]struct{}{}
	for _, in := range req.Days {
		t, err := parseDate(in.Date)
		if err != nil {
			return nil, err
		}
		if t.Year() != req.Year {
			return nil, errx.New(errx.CodeWorkdayYearMismatch, "导入日期不属于该年份："+in.Date)
		}
		code, ok := typeCode(in.Type)
		if !ok {
			return nil, errx.New(errx.CodeWorkdayImportInvalid, "日期类型非法："+in.Type)
		}
		name, err := checkName(in.Name)
		if err != nil {
			return nil, err
		}
		if _, dup := seen[in.Date]; dup {
			return nil, errx.New(errx.CodeWorkdayImportInvalid, "导入日期重复："+in.Date)
		}
		seen[in.Date] = struct{}{}
		next[in.Date] = workdayapi.DayDTO{Date: in.Date, Type: typeName(code), Name: name, Source: "import"}
	}

	res := &workdayapi.ImportResult{DryRun: req.DryRun, Changes: []workdayapi.DiffRow{}}
	for t := dayStart(req.Year); t.Before(yearEnd(req.Year)); t = t.AddDate(0, 0, 1) {
		k := dayKey(t)
		old := curByDay[k]
		nw := next[k]
		if old.Type == nw.Type && old.Name == nw.Name {
			res.Unchanged++
			continue
		}
		action := "changed"
		def := typeName(defaultType(t))
		if old.Source == "default" {
			action = "added"
			res.Added++
		} else if nw.Type == def && nw.Name == "" {
			action = "removed"
			res.Removed++
		} else {
			res.Changed++
		}
		if len(res.Changes) < maxDiffs {
			res.Changes = append(res.Changes, workdayapi.DiffRow{
				Date: k, Action: action,
				OldType: old.Type, NewType: nw.Type, OldName: old.Name, NewName: nw.Name,
			})
		}
	}
	if req.DryRun {
		return res, nil
	}

	// 落库：replace 先清年，再写非默认行；merge 逐条 upsert/归一删除
	if mode == "replace" {
		if err := s.repo.DeleteRange(ctx, tenantID, dayStart(req.Year), yearEnd(req.Year)); err != nil {
			return nil, err
		}
	}
	now := s.opts.Now()
	var upserts []workdayrepo.Override
	var deletes []time.Time
	if mode == "replace" {
		for _, in := range req.Days {
			t, _ := parseDate(in.Date)
			code, _ := typeCode(in.Type)
			if code == defaultType(t) && in.Name == "" {
				continue
			}
			upserts = append(upserts, workdayrepo.Override{
				TenantID: tenantID, Day: t, DayType: code, Name: in.Name, Source: "import",
				UpdatedBy: operatorID, UpdatedAt: now,
			})
		}
	} else {
		for _, in := range req.Days {
			t, _ := parseDate(in.Date)
			code, _ := typeCode(in.Type)
			if code == defaultType(t) && in.Name == "" {
				deletes = append(deletes, t)
				continue
			}
			upserts = append(upserts, workdayrepo.Override{
				TenantID: tenantID, Day: t, DayType: code, Name: in.Name, Source: "import",
				UpdatedBy: operatorID, UpdatedAt: now,
			})
		}
	}
	if err := s.repo.DeleteMany(ctx, tenantID, deletes); err != nil {
		return nil, err
	}
	if err := s.repo.UpsertMany(ctx, upserts); err != nil {
		return nil, err
	}
	s.audit(ctx, tenantID, operatorID, "workday.calendar.import", req.Year, map[string]any{
		"mode": mode, "added": res.Added, "changed": res.Changed, "removed": res.Removed,
	})
	return res, nil
}

func (s *Service) audit(ctx context.Context, tenantID, operatorID int64, action string, year int, detail map[string]any) {
	if s.opts.Audit == nil {
		return
	}
	_ = s.opts.Audit(ctx, tenantID, operatorID, action, "workday_calendar:"+strconv.Itoa(year), detail)
}

func daysOf(rows []workdayrepo.Override) []time.Time {
	out := make([]time.Time, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Day)
	}
	return out
}
