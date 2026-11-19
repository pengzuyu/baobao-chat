package workdayservice

import (
	"context"
	"testing"
	"time"

	errx "github.com/baobaochat/server/internal/platform/errors"
	workdayapi "github.com/baobaochat/server/internal/workday/api"
	workdayrepo "github.com/baobaochat/server/internal/workday/repo"
)

func newSvc(t *testing.T) (*Service, *workdayrepo.Memory, *[]string) {
	t.Helper()
	repo := workdayrepo.NewMemory()
	audits := []string{}
	svc := New(Options{
		Now: func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		Audit: func(_ context.Context, _, _ int64, action, _ string, _ map[string]any) error {
			audits = append(audits, action)
			return nil
		},
	}, repo)
	return svc, repo, &audits
}

func mustCode(t *testing.T, err error, want errx.Code) {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误码 %d，实际 nil", want)
	}
	if got := errx.From(err).Code; got != want {
		t.Fatalf("错误码不符: got=%d want=%d (%v)", got, want, err)
	}
}

// 默认规则：2026 全年 365 天，周一~五工作日、六日周末
func TestYearDefaults(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	y, err := svc.Year(ctx, 1, 2026)
	if err != nil {
		t.Fatal(err)
	}
	if len(y.Days) != 365 {
		t.Fatalf("2026 应 365 天，got %d", len(y.Days))
	}
	byDate := map[string]workdayapi.DayDTO{}
	for _, d := range y.Days {
		byDate[d.Date] = d
	}
	if d := byDate["2026-01-01"]; d.Type != workdayapi.TypeWorkday || d.Source != "default" {
		t.Fatalf("2026-01-01 应默认工作日: %+v", d)
	}
	if d := byDate["2026-01-03"]; d.Type != workdayapi.TypeWeekend {
		t.Fatalf("2026-01-03 应周末: %+v", d)
	}
}

// 手工设置：节假日 + 调休上班；改回默认等价项自动归一删除
func TestUpsertAndNormalize(t *testing.T) {
	svc, _, audits := newSvc(t)
	ctx := context.Background()

	err := svc.UpsertDays(ctx, 1, 100, 2026, []workdayapi.DayInput{
		{Date: "2026-01-01", Type: "holiday", Name: "元旦"},
		{Date: "2026-01-03", Type: "workday", Name: "调休上班"},
	})
	if err != nil {
		t.Fatal(err)
	}
	y, _ := svc.Year(ctx, 1, 2026)
	byDate := map[string]workdayapi.DayDTO{}
	for _, d := range y.Days {
		byDate[d.Date] = d
	}
	if d := byDate["2026-01-01"]; d.Type != workdayapi.TypeHoliday || d.Name != "元旦" || d.Source != "manual" {
		t.Fatalf("元旦设置不符: %+v", d)
	}
	if d := byDate["2026-01-03"]; d.Type != workdayapi.TypeWorkday || d.Name != "调休上班" {
		t.Fatalf("调休设置不符: %+v", d)
	}

	// 把 01-01 改回“工作日且无名称”= 默认 → 归一删除
	if err := svc.UpsertDays(ctx, 1, 100, 2026, []workdayapi.DayInput{
		{Date: "2026-01-01", Type: "workday", Name: ""},
	}); err != nil {
		t.Fatal(err)
	}
	y, _ = svc.Year(ctx, 1, 2026)
	for _, d := range y.Days {
		if d.Date == "2026-01-01" && d.Source != "default" {
			t.Fatalf("01-01 应回落默认: %+v", d)
		}
	}
	if len(*audits) != 2 {
		t.Fatalf("应有 2 条审计，got %v", *audits)
	}
}

// 校验：日期/类型/年份/重复
func TestUpsertValidation(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	cases := []struct {
		name string
		in   workdayapi.DayInput
		code errx.Code
	}{
		{"宽松日期", workdayapi.DayInput{Date: "2026-1-1", Type: "holiday"}, errx.CodeWorkdayParamInvalid},
		{"类型非法", workdayapi.DayInput{Date: "2026-01-01", Type: "rest"}, errx.CodeWorkdayParamInvalid},
		{"跨年", workdayapi.DayInput{Date: "2027-01-01", Type: "holiday"}, errx.CodeWorkdayParamInvalid},
	}
	for _, c := range cases {
		if err := svc.UpsertDays(ctx, 1, 100, 2026, []workdayapi.DayInput{c.in}); err == nil {
			t.Fatalf("%s: 应报错", c.name)
		} else if got := errx.From(err).Code; got != c.code {
			t.Fatalf("%s: code=%d want=%d", c.name, got, c.code)
		}
	}
	// 重复日期
	if err := svc.UpsertDays(ctx, 1, 100, 2026, []workdayapi.DayInput{
		{Date: "2026-01-01", Type: "holiday"}, {Date: "2026-01-01", Type: "holiday"},
	}); err == nil {
		t.Fatal("重复日期应报错")
	}
	if err := svc.UpsertDays(ctx, 1, 100, 1999, []workdayapi.DayInput{{Date: "1999-01-01", Type: "holiday"}}); err == nil {
		t.Fatal("年份越界应报错")
	}
}

// 重置：指定日期 / 整年
func TestReset(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	_ = svc.UpsertDays(ctx, 1, 100, 2026, []workdayapi.DayInput{
		{Date: "2026-05-01", Type: "holiday", Name: "劳动节"},
		{Date: "2026-10-01", Type: "holiday", Name: "国庆节"},
	})
	if err := svc.ResetDays(ctx, 1, 100, 2026, []string{"2026-05-01"}); err != nil {
		t.Fatal(err)
	}
	y, _ := svc.Year(ctx, 1, 2026)
	for _, d := range y.Days {
		if d.Date == "2026-05-01" && d.Source != "default" {
			t.Fatalf("05-01 应重置: %+v", d)
		}
		if d.Date == "2026-10-01" && d.Source == "default" {
			t.Fatalf("10-01 不应被重置: %+v", d)
		}
	}
	if err := svc.ResetDays(ctx, 1, 100, 2026, nil); err != nil {
		t.Fatal(err)
	}
	y, _ = svc.Year(ctx, 1, 2026)
	for _, d := range y.Days {
		if d.Source != "default" {
			t.Fatalf("整年重置后仍有例外: %+v", d)
		}
	}
}

// 导入：dryRun 预览不落库；apply 生效；replace 以默认规则为底
func TestImport(t *testing.T) {
	svc, _, audits := newSvc(t)
	ctx := context.Background()
	_ = svc.UpsertDays(ctx, 1, 100, 2026, []workdayapi.DayInput{
		{Date: "2026-10-01", Type: "holiday", Name: "国庆节"},
	})

	// dryRun：新增 1 天（05-01），不动库
	res, err := svc.Import(ctx, 1, 100, workdayapi.ImportReq{
		Version: 1, Year: 2026, DryRun: true,
		Days: []workdayapi.DayInput{{Date: "2026-05-01", Type: "holiday", Name: "劳动节"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 || res.Changed != 0 || res.Removed != 0 {
		t.Fatalf("dryRun 差异不符: %+v", res)
	}
	y, _ := svc.Year(ctx, 1, 2026)
	for _, d := range y.Days {
		if d.Date == "2026-05-01" && d.Source != "default" {
			t.Fatalf("dryRun 不应落库: %+v", d)
		}
	}

	// merge apply
	res, err = svc.Import(ctx, 1, 100, workdayapi.ImportReq{
		Version: 1, Year: 2026, Mode: "merge",
		Days: []workdayapi.DayInput{{Date: "2026-05-01", Type: "holiday", Name: "劳动节"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 1 {
		t.Fatalf("apply 差异不符: %+v", res)
	}
	y, _ = svc.Year(ctx, 1, 2026)
	found := false
	for _, d := range y.Days {
		if d.Date == "2026-05-01" && d.Type == workdayapi.TypeHoliday && d.Source == "import" {
			found = true
		}
	}
	if !found {
		t.Fatal("导入未生效")
	}

	// replace 空列表 → 全部例外清除（含此前手工的 10-01）
	res, err = svc.Import(ctx, 1, 100, workdayapi.ImportReq{Version: 1, Year: 2026, Mode: "replace"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Removed != 2 {
		t.Fatalf("replace 空列表应移除 2 条例外: %+v", res)
	}
	y, _ = svc.Year(ctx, 1, 2026)
	for _, d := range y.Days {
		if d.Source != "default" {
			t.Fatalf("replace 后仍有例外: %+v", d)
		}
	}
	if len(*audits) != 3 { // upsert + import apply + import replace
		t.Fatalf("审计次数不符: %v", *audits)
	}
}

// 导入校验：年份不匹配 / 格式非法
func TestImportValidation(t *testing.T) {
	svc, _, _ := newSvc(t)
	ctx := context.Background()
	_, err := svc.Import(ctx, 1, 100, workdayapi.ImportReq{
		Version: 1, Year: 2026, Days: []workdayapi.DayInput{{Date: "2027-01-01", Type: "holiday"}},
	})
	mustCode(t, err, errx.CodeWorkdayYearMismatch)

	_, err = svc.Import(ctx, 1, 100, workdayapi.ImportReq{Version: 9, Year: 2026})
	mustCode(t, err, errx.CodeWorkdayImportInvalid)

	_, err = svc.Import(ctx, 1, 100, workdayapi.ImportReq{Version: 1, Year: 2026, Mode: "overwrite"})
	mustCode(t, err, errx.CodeWorkdayImportInvalid)
}

// 导出：与导入同 schema，全年 365 天
func TestExport(t *testing.T) {
	svc, _, _ := newSvc(t)
	dto, err := svc.Export(context.Background(), 1, 2026, "")
	if err != nil {
		t.Fatal(err)
	}
	if dto.Version != 1 || dto.Year != 2026 || dto.Region != "CN" || len(dto.Days) != 365 {
		t.Fatalf("导出结构不符: %+v", dto)
	}
}
