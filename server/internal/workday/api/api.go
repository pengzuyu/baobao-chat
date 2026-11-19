// Package workdayapi 工作日日历域对外接口与 DTO（D35 Agent 定时任务）。
//
// 口径：默认规则周一~五工作日、六日周末；存储层只落“默认之外”的例外
// （法定节假日/调休上班/手工改过的周末），读取时合并成全年 365/366 天。
// 三态 wire 名：workday（工作日，含调休上班）/ weekend（周末）/ holiday（节假日）。
package workdayapi

import "context"

// 三态 wire 值（DB day_type 1/2/3 与之一一对应）
const (
	TypeWorkday = "workday"
	TypeWeekend = "weekend"
	TypeHoliday = "holiday"
)

// DayDTO 单日日历项（source: default=默认规则 / manual=管理员设置 / import=导入）
type DayDTO struct {
	Date   string `json:"date"` // YYYY-MM-DD
	Type   string `json:"type"`
	Name   string `json:"name"`
	Source string `json:"source"`
}

// YearDTO 全年日历（365/366 天，按日期升序）
type YearDTO struct {
	Year int      `json:"year"`
	Days []DayDTO `json:"days"`
}

// DayInput 批量设置/导入的单日入参（name 可空）
type DayInput struct {
	Date string `json:"date"`
	Type string `json:"type"`
	Name string `json:"name"`
}

// ImportReq 导入请求。version 缺省按 1；mode 缺省 merge；dryRun=true 只算差异不落库。
type ImportReq struct {
	Version int        `json:"version"`
	Year    int        `json:"year"`
	Region  string     `json:"region"`
	Mode    string     `json:"mode"` // merge|replace
	DryRun  bool       `json:"dryRun"`
	Days    []DayInput `json:"days"`
}

// DiffRow 导入差异行（预览用，最多 100 条）
type DiffRow struct {
	Date    string `json:"date"`
	Action  string `json:"action"` // added|changed|removed
	OldType string `json:"oldType,omitempty"`
	NewType string `json:"newType,omitempty"`
	OldName string `json:"oldName,omitempty"`
	NewName string `json:"newName,omitempty"`
}

// ImportResult 导入结果/预览
type ImportResult struct {
	Added     int       `json:"added"`
	Changed   int       `json:"changed"`
	Removed   int       `json:"removed"`
	Unchanged int       `json:"unchanged"`
	DryRun    bool      `json:"dryRun"`
	Changes   []DiffRow `json:"changes"`
}

// ExportDTO 导出文件（与导入同 schema，可跨租户复用）
type ExportDTO struct {
	Version int      `json:"version"`
	Year    int      `json:"year"`
	Region  string   `json:"region"`
	Days    []DayDTO `json:"days"`
}

// Service 工作日日历服务接口
type Service interface {
	// Year 全年合并视图（任何登录用户可读；客户端定时任务同步用）
	Year(ctx context.Context, tenantID int64, year int) (*YearDTO, error)
	// UpsertDays 批量设置例外（管理端；等于默认规则的条目自动归一为删除）
	UpsertDays(ctx context.Context, tenantID, operatorID int64, year int, days []DayInput) error
	// ResetDays 恢复默认（dates 空=整年）
	ResetDays(ctx context.Context, tenantID, operatorID int64, year int, dates []string) error
	// Import JSON 导入（dryRun 返回差异预览；merge/replace 两模式）
	Import(ctx context.Context, tenantID, operatorID int64, req ImportReq) (*ImportResult, error)
	// Export 导出全年合并 JSON
	Export(ctx context.Context, tenantID int64, year int, region string) (*ExportDTO, error)
}
