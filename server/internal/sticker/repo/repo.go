// Package stickerrepo 表情包域仓储（memory/postgres 双实现；ID 阶段一自增占位雪花，同 message 口径）。
package stickerrepo

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound 集/条目不存在
var ErrNotFound = errors.New("stickerrepo: not found")

// ErrDupItem 同集同图重复（uk_sticker_set_file）
var ErrDupItem = errors.New("stickerrepo: duplicate sticker item")

// Set sticker_set 行（OwnerID 0=租户公共集）
type Set struct {
	ID          int64
	TenantID    int64
	Name        string
	CoverFileID int64
	OwnerID     int64
	Status      int // 1 启用 2 停用（公共集下架）
	CreatedAt   time.Time
}

// Item sticker 行
type Item struct {
	ID        int64
	TenantID  int64
	SetID     int64
	FileID    int64
	Name      string
	Sort      int
	CreatedAt time.Time
}

// Repo 表情包仓储接口
type Repo interface {
	InsertSet(ctx context.Context, s Set) (Set, error)
	GetSet(ctx context.Context, id int64) (*Set, error)
	ListSets(ctx context.Context, tenantID int64) ([]Set, error)
	UpdateSetStatus(ctx context.Context, id int64, status int) error
	UpdateSetCover(ctx context.Context, id, coverFileID int64) error
	DeleteSet(ctx context.Context, id int64) error // 连带条目（无外键，两条 SQL）

	InsertItem(ctx context.Context, it Item) (Item, error) // 同集同图 → ErrDupItem
	GetItem(ctx context.Context, id int64) (*Item, error)
	ListItemsOfSets(ctx context.Context, setIDs []int64) ([]Item, error)
	DeleteItem(ctx context.Context, id int64) error
}
