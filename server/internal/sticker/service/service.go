// Package stickerservice 表情包业务逻辑（0022 迁移）。
// 权限口径：个人集 owner 全权；公共集仅管理端（allowPublic=true，经 admin:policy:manage
// 路由守卫进入）；FileCheck 注入校验上传文件归属（同 message 域 file 口径）。
package stickerservice

import (
	"context"
	"strconv"

	errx "github.com/baobaochat/server/internal/platform/errors"
	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
	stickerapi "github.com/baobaochat/server/internal/sticker/api"
	stickerrepo "github.com/baobaochat/server/internal/sticker/repo"
)

// Options 装配期注入
type Options struct {
	// TenantID 阶段一默认租户（与 auth DefaultTenant 同源 bbcpg.DefaultTenantID）
	TenantID int64
	// FileCheck 上传文件归属校验（file 域；nil=跳过——内存/测试装配）
	FileCheck func(ctx context.Context, ownerID, fileID int64) error
	// MaxPersonalSets 个人集上限（默认 10）
	MaxPersonalSets int
}

func (o *Options) fillDefaults() {
	if o.TenantID == 0 {
		o.TenantID = bbcpg.DefaultTenantID
	}
	if o.MaxPersonalSets == 0 {
		o.MaxPersonalSets = 10
	}
}

// Service 实现 stickerapi.Service
type Service struct {
	repo stickerrepo.Repo
	opts Options
}

// New 构造
func New(opts Options, repo stickerrepo.Repo) *Service {
	opts.fillDefaults()
	return &Service{repo: repo, opts: opts}
}

var _ stickerapi.Service = (*Service)(nil)

func dtoOfSet(s stickerrepo.Set, items []stickerapi.StickerItemDTO) stickerapi.StickerSetDTO {
	return stickerapi.StickerSetDTO{
		ID: strconv.FormatInt(s.ID, 10), Name: s.Name,
		IsPublic: s.OwnerID == 0, Status: s.Status, Items: items,
	}
}

// Library 我的集 + 启用中公共集（items 内联一次组装）
func (s *Service) Library(ctx context.Context, userID int64) (*stickerapi.LibraryDTO, error) {
	sets, err := s.repo.ListSets(ctx, s.opts.TenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	ids := make([]int64, 0, len(sets))
	for _, st := range sets {
		if st.OwnerID == userID || (st.OwnerID == 0 && st.Status == 1) {
			ids = append(ids, st.ID)
		}
	}
	items, err := s.repo.ListItemsOfSets(ctx, ids)
	if err != nil {
		return nil, errx.From(err)
	}
	bySet := map[int64][]stickerapi.StickerItemDTO{}
	for _, it := range items {
		bySet[it.SetID] = append(bySet[it.SetID], stickerapi.StickerItemDTO{
			ID: strconv.FormatInt(it.ID, 10), FileID: strconv.FormatInt(it.FileID, 10), Name: it.Name,
		})
	}
	out := &stickerapi.LibraryDTO{Mine: []stickerapi.StickerSetDTO{}, Public: []stickerapi.StickerSetDTO{}}
	for _, st := range sets {
		if st.OwnerID == userID {
			out.Mine = append(out.Mine, dtoOfSet(st, bySet[st.ID]))
		} else if st.OwnerID == 0 && st.Status == 1 {
			out.Public = append(out.Public, dtoOfSet(st, bySet[st.ID]))
		}
	}
	return out, nil
}

// AdminLibrary 全部公共集（含下架；管理端治理列表，经 admin 路由守卫进入）
func (s *Service) AdminLibrary(ctx context.Context) ([]stickerapi.StickerSetDTO, error) {
	sets, err := s.repo.ListSets(ctx, s.opts.TenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	ids := make([]int64, 0, len(sets))
	for _, st := range sets {
		if st.OwnerID == 0 {
			ids = append(ids, st.ID)
		}
	}
	items, err := s.repo.ListItemsOfSets(ctx, ids)
	if err != nil {
		return nil, errx.From(err)
	}
	bySet := map[int64][]stickerapi.StickerItemDTO{}
	for _, it := range items {
		bySet[it.SetID] = append(bySet[it.SetID], stickerapi.StickerItemDTO{
			ID: strconv.FormatInt(it.ID, 10), FileID: strconv.FormatInt(it.FileID, 10), Name: it.Name,
		})
	}
	out := []stickerapi.StickerSetDTO{}
	for _, st := range sets {
		if st.OwnerID == 0 {
			out = append(out, dtoOfSet(st, bySet[st.ID]))
		}
	}
	return out, nil
}

// CreateSet 建个人集（≤上限；名字 ≤50 字）
func (s *Service) CreateSet(ctx context.Context, userID int64, name string) (*stickerapi.StickerSetDTO, error) {
	if len(name) == 0 || len(name) > 50 {
		return nil, errx.New(errx.CodeBadRequest, "集名 1~50 字")
	}
	sets, err := s.repo.ListSets(ctx, s.opts.TenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	n := 0
	for _, st := range sets {
		if st.OwnerID == userID {
			n++
		}
	}
	if n >= s.opts.MaxPersonalSets {
		return nil, errx.New(errx.CodeBadRequest, "个人表情集已达上限（10 个）")
	}
	created, err := s.repo.InsertSet(ctx, stickerrepo.Set{TenantID: s.opts.TenantID, Name: name, OwnerID: userID})
	if err != nil {
		return nil, errx.From(err)
	}
	dto := dtoOfSet(created, []stickerapi.StickerItemDTO{})
	return &dto, nil
}

// CreatePublicSet 建租户公共集（管理端；owner NULL）
func (s *Service) CreatePublicSet(ctx context.Context, userID int64, name string) (*stickerapi.StickerSetDTO, error) {
	if len(name) == 0 || len(name) > 50 {
		return nil, errx.New(errx.CodeBadRequest, "集名 1~50 字")
	}
	_ = userID // 操作者经路由守卫（admin:policy:manage）；审计阶段二接 admin 域
	created, err := s.repo.InsertSet(ctx, stickerrepo.Set{TenantID: s.opts.TenantID, Name: name, OwnerID: 0})
	if err != nil {
		return nil, errx.From(err)
	}
	dto := dtoOfSet(created, []stickerapi.StickerItemDTO{})
	return &dto, nil
}

// AddItem 加图：个人集仅 owner；公共集仅 allowPublic（管理端）。首图自动回填封面。
func (s *Service) AddItem(ctx context.Context, userID, setID, fileID int64, name string, allowPublic bool) (*stickerapi.StickerItemDTO, error) {
	st, err := s.repo.GetSet(ctx, setID)
	if err != nil {
		return nil, errx.From(err)
	}
	if st.TenantID != s.opts.TenantID {
		return nil, errx.New(errx.CodeNotFound, "表情集不存在")
	}
	if st.OwnerID == 0 {
		if !allowPublic {
			return nil, errx.New(errx.CodePermPointDenied, "公共表情集请由管理员在管理端维护")
		}
	} else if st.OwnerID != userID {
		return nil, errx.New(errx.CodePermPointDenied, "仅本人表情集可添加")
	}
	if s.opts.FileCheck != nil {
		if err := s.opts.FileCheck(ctx, userID, fileID); err != nil {
			return nil, err
		}
	}
	if len(name) > 50 {
		name = name[:50]
	}
	it, err := s.repo.InsertItem(ctx, stickerrepo.Item{TenantID: s.opts.TenantID, SetID: setID, FileID: fileID, Name: name})
	if err != nil {
		if err == stickerrepo.ErrDupItem {
			return nil, errx.New(errx.CodeBadRequest, "该图片已在表情集中")
		}
		return nil, errx.From(err)
	}
	if st.CoverFileID == 0 {
		_ = s.repo.UpdateSetCover(ctx, setID, fileID)
	}
	dto := stickerapi.StickerItemDTO{ID: strconv.FormatInt(it.ID, 10), FileID: strconv.FormatInt(it.FileID, 10), Name: it.Name}
	return &dto, nil
}

// RemoveItem 删条目（owner / 管理端公共集）
func (s *Service) RemoveItem(ctx context.Context, userID, itemID int64, allowPublic bool) error {
	it, err := s.repo.GetItem(ctx, itemID)
	if err != nil {
		return errx.From(err)
	}
	st, err := s.repo.GetSet(ctx, it.SetID)
	if err != nil {
		return errx.From(err)
	}
	if st.OwnerID == 0 {
		if !allowPublic {
			return errx.New(errx.CodePermPointDenied, "公共表情集请由管理员在管理端维护")
		}
	} else if st.OwnerID != userID {
		return errx.New(errx.CodePermPointDenied, "仅本人表情集可删除")
	}
	if err := s.repo.DeleteItem(ctx, itemID); err != nil {
		return errx.From(err)
	}
	return nil
}

// RemoveSet 删集（连带条目；owner / 管理端公共集）
func (s *Service) RemoveSet(ctx context.Context, userID, setID int64, allowPublic bool) error {
	st, err := s.repo.GetSet(ctx, setID)
	if err != nil {
		return errx.From(err)
	}
	if st.OwnerID == 0 {
		if !allowPublic {
			return errx.New(errx.CodePermPointDenied, "公共表情集请由管理员在管理端维护")
		}
	} else if st.OwnerID != userID {
		return errx.New(errx.CodePermPointDenied, "仅本人表情集可删除")
	}
	if err := s.repo.DeleteSet(ctx, setID); err != nil {
		return errx.From(err)
	}
	return nil
}

// SetPublicStatus 公共集上下架（管理端）
func (s *Service) SetPublicStatus(ctx context.Context, setID int64, status int) error {
	if status != 1 && status != 2 {
		return errx.New(errx.CodeBadRequest, "status 应为 1/2")
	}
	st, err := s.repo.GetSet(ctx, setID)
	if err != nil {
		return errx.From(err)
	}
	if st.OwnerID != 0 {
		return errx.New(errx.CodeBadRequest, "个人表情集无上下架概念")
	}
	if err := s.repo.UpdateSetStatus(ctx, setID, status); err != nil {
		return errx.From(err)
	}
	return nil
}

// CheckUsable 发送校验：条目存在且对 sender 可见（个人 owner=sender / 公共启用）
func (s *Service) CheckUsable(ctx context.Context, senderID, itemID int64) (int64, error) {
	it, err := s.repo.GetItem(ctx, itemID)
	if err != nil {
		return 0, errx.New(errx.CodeNotFound, "表情不存在或已删除")
	}
	st, err := s.repo.GetSet(ctx, it.SetID)
	if err != nil {
		return 0, errx.New(errx.CodeNotFound, "表情不存在或已删除")
	}
	if st.OwnerID != 0 {
		if st.OwnerID != senderID {
			return 0, errx.New(errx.CodePermACLDenied, "仅本人表情可发送")
		}
	} else if st.Status != 1 {
		return 0, errx.New(errx.CodeNotFound, "表情已下架")
	}
	return it.FileID, nil
}
