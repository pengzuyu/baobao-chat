// Package ecorepo 生态域仓储（首建：专家定义包，D14 §5/10 篇通道阶段一）。
package ecorepo

import (
	"context"
	"errors"
	"time"
)

// 哨兵
var (
	ErrNotFound = errors.New("eco: not found")
	ErrDupID    = errors.New("eco: duplicate expert_id")
)

// 来源
const (
	SourceCompany  = 1
	SourcePersonal = 2
)

// 状态
const (
	StatusDraft       = 1
	StatusPublished   = 2
	StatusUnpublished = 3
)

// Expert 专家定义包
type Expert struct {
	ID          int64
	TenantID    int64
	ExpertID    string // corp./dept./usr.{uid}.
	Version     string
	Display     string
	Summary     string
	Source      int
	OwnerUserID int64
	Manifest    string // YAML 原文
	Status      int
	CreatedBy   int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// ListFilter 清单过滤（零值=不过滤）
type ListFilter struct {
	Source int   // 1 company 2 personal
	Status int   // 默认仅 published 由服务层控制
	Owner  int64 // personal 归属
}

// Repo 生态域仓储
type Repo interface {
	Create(ctx context.Context, e Expert) (Expert, error)
	Get(ctx context.Context, tenantID, id int64) (*Expert, error)
	// GetByExpertID 按定义 ID（拉取去重）
	GetByExpertID(ctx context.Context, tenantID int64, expertID string) (*Expert, error)
	List(ctx context.Context, tenantID int64, f ListFilter) ([]Expert, error)
	UpdateStatus(ctx context.Context, tenantID, id int64, status int) error
	UpdateManifest(ctx context.Context, tenantID, id int64, version, display, summary, manifest string) error
	Delete(ctx context.Context, tenantID, id int64) error
}
