// Package acl 资源级 ACL（03 篇 §4.4 第三层）：统一授权模型
// resource(resource_type, resource_id) × grant(user/dept/role/tenant) → perm。
// 消费方（kb 空间/共享邮箱/doc 文件夹/分享链接）经判定链取最大权限；
// "拒绝"仅显式黑名单场景（知识库敏感节点，11 篇——阶段二）。
//
// v0.1 判定链落地：user 直授 + tenant 公开两层；dept/role 授权经闭包
// 注入（Options.DeptIDsOf/RoleIDsOf——装配时接 user_role/user_dept 查询，
// 未注入=跳过该层），判定语义与表结构对齐 03 篇全模型。短时缓存
// （Redis TTL 60s）随多实例部署阶段二。
package acl

import (
	"context"
	"time"
)

// Perm 权限档位（数值可比：判定取最大；03 §4.4 viewer|commenter|editor|owner）
const (
	PermNone      = 0
	PermViewer    = 1
	PermCommenter = 2
	PermEditor    = 3
	PermOwner     = 4
)

// GrantType 授权主体类型
const (
	GrantUser   = 1 // grant_target=user_id
	GrantDept   = 2 // grant_target=dept_id
	GrantRole   = 3 // grant_target=role_id
	GrantTenant = 4 // 租户内公开（target=0）
)

// Entry 单条授权
type Entry struct {
	ID           int64
	TenantID     int64
	ResourceType string // kb.space | mail.shared | doc.folder | file.share | conv
	ResourceID   string
	GrantType    int
	GrantTarget  int64
	Perm         int
	GrantedBy    int64
	ExpiresAt    time.Time // 零值=永久
	CreatedAt    time.Time
}

// EntryFilter ListGrants 过滤（零值字段=不过滤）
type EntryFilter struct {
	ResourceType string
	ResourceID   string
}

// Repo 资源授权仓储（memory/postgres 双模）
type Repo interface {
	// Grant 落授权（同 resource+grant 唯一：重复=覆盖 perm/expires 幂等）
	Grant(ctx context.Context, e Entry) (Entry, error)
	// Revoke 撤销（不存在返回 ErrNotFound）
	Revoke(ctx context.Context, tenantID, id int64) error
	// ListGrants 授权清单（管理端视角；filter 空=全部，按 id 升序）
	ListGrants(ctx context.Context, tenantID int64, f EntryFilter) ([]Entry, error)
	// EffectiveForUser 用户视角的有效授权集（user 直授 + 注入的 dept/role
	// 展开集 + tenant 公开；过期行已滤）——判定链数据源
	EffectiveForUser(ctx context.Context, tenantID int64, resourceType, resourceID string,
		userID int64, deptIDs, roleIDs []int64) ([]Entry, error)
}

// ResolveOptions 判定链装配（dept/role 展开闭包——main 接 admin/org 查询）
type ResolveOptions struct {
	// DeptIDsOf 用户部门集（未注入=dept 层跳过）
	DeptIDsOf func(tenantID, userID int64) []int64
	// RoleIDsOf 用户角色集（未注入=role 层跳过）
	RoleIDsOf func(tenantID, userID int64) []int64
	Now       func() time.Time
}

// Service 判定链服务
type Service struct {
	repo Repo
	opts ResolveOptions
}

// New 构造
func New(r Repo, opts ResolveOptions) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{repo: r, opts: opts}
}

// Resolve 有效权限（03 §4.4"逐层取最大"：user > dept/role > tenant 公开；
// 过期授权不参与；未授权=PermNone）
func (s *Service) Resolve(ctx context.Context, tenantID int64,
	resourceType, resourceID string, userID int64) int {
	var deptIDs, roleIDs []int64
	if s.opts.DeptIDsOf != nil {
		deptIDs = s.opts.DeptIDsOf(tenantID, userID)
	}
	if s.opts.RoleIDsOf != nil {
		roleIDs = s.opts.RoleIDsOf(tenantID, userID)
	}
	entries, err := s.repo.EffectiveForUser(ctx, tenantID, resourceType, resourceID, userID, deptIDs, roleIDs)
	if err != nil {
		return PermNone // 判定失败=拒绝（fail-closed）
	}
	best := PermNone
	for _, e := range entries {
		// 层级加权已由 perm 数值承载（授权写入侧保证 tenant 公开不高于
		// editor——"公开 owner"无业务意义，服务端 Grant 拒绝）
		if e.Perm > best {
			best = e.Perm
		}
	}
	return best
}

// CanView ≥viewer
func (s *Service) CanView(ctx context.Context, tenantID int64,
	resourceType, resourceID string, userID int64) bool {
	return s.Resolve(ctx, tenantID, resourceType, resourceID, userID) >= PermViewer
}

// CanEdit ≥editor
func (s *Service) CanEdit(ctx context.Context, tenantID int64,
	resourceType, resourceID string, userID int64) bool {
	return s.Resolve(ctx, tenantID, resourceType, resourceID, userID) >= PermEditor
}

// IsOwner =owner
func (s *Service) IsOwner(ctx context.Context, tenantID int64,
	resourceType, resourceID string, userID int64) bool {
	return s.Resolve(ctx, tenantID, resourceType, resourceID, userID) == PermOwner
}

// Grant 管理面落授权（tenant 公开档位护栏：GrantTenant 仅允许
// viewer/commenter/editor——公开 owner 无业务意义）
func (s *Service) Grant(ctx context.Context, e Entry) (Entry, error) {
	if e.GrantType == GrantTenant && e.Perm == PermOwner {
		return Entry{}, errInvalid("tenant 公开授权不可为 owner")
	}
	if e.Perm < PermViewer || e.Perm > PermOwner {
		return Entry{}, errInvalid("perm 越界")
	}
	if e.GrantType < GrantUser || e.GrantType > GrantTenant {
		return Entry{}, errInvalid("grant_type 越界")
	}
	if e.GrantType != GrantTenant && e.GrantTarget <= 0 {
		return Entry{}, errInvalid("grant_target 必填")
	}
	if !e.ExpiresAt.IsZero() && !e.ExpiresAt.After(s.opts.Now()) {
		return Entry{}, errInvalid("expires_at 须晚于当前")
	}
	return s.repo.Grant(ctx, e)
}

// Revoke 管理面撤销
func (s *Service) Revoke(ctx context.Context, tenantID, id int64) error {
	return s.repo.Revoke(ctx, tenantID, id)
}

// ListGrants 管理面清单
func (s *Service) ListGrants(ctx context.Context, tenantID int64, f EntryFilter) ([]Entry, error) {
	return s.repo.ListGrants(ctx, tenantID, f)
}
