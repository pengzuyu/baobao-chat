// 技能包仓储（eco_skill/install；0034 / E4）。
package ecorepo

import (
	"context"
	"errors"
	"time"
)

// ErrSkillNotFound / ErrSkillDup 技能域 sentinel
var (
	ErrSkillNotFound = errors.New("ecorepo: skill not found")
	ErrSkillDup      = errors.New("ecorepo: duplicate skill_id")
)

// Skill eco_skill 行
type Skill struct {
	ID             int64
	TenantID       int64
	SkillID        string
	Name           string
	Description    string
	Policy         int // 1 force 2 recommend 3 optional
	Status         string
	CurrentVersion string
	Manifest       string // YAML 原文
	CreatedBy      int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// SkillInstall 安装行
type SkillInstall struct {
	ID          int64
	TenantID    int64
	SkillRowID  int64
	UserID      int64
	Version     string
	InstalledAt time.Time
}

// SkillRepo 技能仓储（E4）
type SkillRepo interface {
	InsertSkill(ctx context.Context, s Skill) (Skill, error)
	GetSkill(ctx context.Context, tenantID, id int64) (*Skill, error)
	ListSkills(ctx context.Context, tenantID int64) ([]Skill, error)          // 管理端全量
	ListPublishedSkills(ctx context.Context, tenantID int64) ([]Skill, error) // 用户 catalog
	UpdateSkill(ctx context.Context, tenantID, id int64, name, description, manifest, version string, policy int) error
	SetSkillStatus(ctx context.Context, tenantID, id int64, status string) error

	UpsertSkillInstall(ctx context.Context, i SkillInstall) error
	ListSkillInstallsByUser(ctx context.Context, tenantID, userID int64) ([]SkillInstall, error)
	DeleteSkillInstall(ctx context.Context, tenantID, skillRowID, userID int64) error
}
