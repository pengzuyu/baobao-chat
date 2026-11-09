// Package stickerapi 表情包域对外接口与 DTO（0022 迁移；自定义表情包完整版）。
// 可见性：个人集仅 owner；公共集（owner NULL）status=1 全员可读。
// 公共集治理（建/上架/加图）经 admin 路由守卫（admin:policy:manage）进入，
// service 以 allowPublic 标记区分个人/管理端调用。
package stickerapi

import "context"

// StickerItemDTO 表情条目（图片经 file 域票据另取，不冗余 URL）
type StickerItemDTO struct {
	ID     string `json:"id"`
	FileID string `json:"fileId"`
	Name   string `json:"name,omitempty"`
}

// StickerSetDTO 表情集（个人/公共；items 内联——集与条目量小，一次组装）
type StickerSetDTO struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	IsPublic bool             `json:"isPublic"`
	Status   int              `json:"status"` // 公共集 1 上架 2 下架（个人集恒 1）
	Items    []StickerItemDTO `json:"items"`
}

// LibraryDTO 表情库（面板一次拉全：我的 + 启用中的公共集）
type LibraryDTO struct {
	Mine   []StickerSetDTO `json:"mine"`
	Public []StickerSetDTO `json:"public"`
}

// Service 表情包域服务接口
type Service interface {
	// Library 我的集（owner=userID）+ 启用中公共集（items 内联）
	Library(ctx context.Context, userID int64) (*LibraryDTO, error)
	// AdminLibrary 全部公共集（含下架；管理端治理列表）
	AdminLibrary(ctx context.Context) ([]StickerSetDTO, error)
	// CreateSet 建个人集（≤10 个/人）
	CreateSet(ctx context.Context, userID int64, name string) (*StickerSetDTO, error)
	// CreatePublicSet 建租户公共集（仅 admin 路由进入；allowPublic 语义见包注释）
	CreatePublicSet(ctx context.Context, userID int64, name string) (*StickerSetDTO, error)
	// AddItem 加图：个人集仅 owner；公共集仅管理端（allowPublic=true）
	AddItem(ctx context.Context, userID int64, setID, fileID int64, name string, allowPublic bool) (*StickerItemDTO, error)
	// RemoveItem 删条目：个人集 owner / 公共集仅管理端
	RemoveItem(ctx context.Context, userID int64, itemID int64, allowPublic bool) error
	// RemoveSet 删集（连带条目）：同 RemoveItem 权限
	RemoveSet(ctx context.Context, userID int64, setID int64, allowPublic bool) error
	// SetPublicStatus 公共集上下架（仅管理端；个人集不可下架）
	SetPublicStatus(ctx context.Context, setID int64, status int) error
	// CheckUsable 消息发送校验（msg type=sticker）：条目存在且对 sender 可见
	// （个人集 owner=sender / 公共集 status=1）。返回条目 file_id 供 body 比对。
	CheckUsable(ctx context.Context, senderID, itemID int64) (fileID int64, err error)
}
