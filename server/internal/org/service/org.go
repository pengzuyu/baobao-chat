// Package orgservice 组织域业务逻辑（阶段一：用户读取；组织树/异动引擎见 D12，阶段二）
package orgservice

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/baobaowork/server/internal/org/api"
	"github.com/baobaowork/server/internal/org/repo"
	"github.com/baobaowork/server/internal/platform/pinyinutil"
)

// Service 实现 orgapi.UserReader
type Service struct {
	repo orgrepo.Repo
}

// New 构造（依赖注入，禁止全局单例——D02 §3）
func New(r orgrepo.Repo) *Service { return &Service{repo: r} }

// compile-time 接口断言
var _ orgapi.UserReader = (*Service)(nil)
var _ orgapi.UserAdminReader = (*Service)(nil)
var _ orgapi.DeptScopeReader = (*Service)(nil)

// GetUserByLogin 登录名查用户
func (s *Service) GetUserByLogin(ctx context.Context, tenantID int64, username string) (*orgapi.User, error) {
	return s.repo.GetUserByLogin(ctx, tenantID, username)
}

// GetUser 按 ID 查用户
func (s *Service) GetUser(ctx context.Context, id int64) (*orgapi.User, error) {
	return s.repo.GetUser(ctx, id)
}

// ── 管理端扩展（D10 阶段一务实版；透传仓储，业务约束由 admin 域施加）──

// ListUsers 用户列表（keyword/status/cursor 翻页）
func (s *Service) ListUsers(ctx context.Context, f orgapi.UserListFilter) ([]orgapi.User, bool, error) {
	return s.repo.ListUsers(ctx, f)
}

// CountUsers 用户总数
func (s *Service) CountUsers(ctx context.Context, tenantID int64) (int64, error) {
	return s.repo.CountUsers(ctx, tenantID)
}

// SetUserStatus 启用/禁用
func (s *Service) SetUserStatus(ctx context.Context, id int64, status int) error {
	return s.repo.SetUserStatus(ctx, id, status)
}

// SetPassword 改密+清首登标志（D11；hash 由 auth 域闭包生成，透传仓储）
func (s *Service) SetPassword(ctx context.Context, tenantID, userID int64, passwordHash string) error {
	return s.repo.SetPassword(ctx, tenantID, userID, passwordHash)
}

// ── 部门归属读（kb 三层知识检索消费；orgapi.DeptScopeReader 实现）──

// UserDeptIDsOf 用户直接所属部门集 + 主部门 ID（primary=0 表示未挂任何部门）
func (s *Service) UserDeptIDsOf(ctx context.Context, tenantID, userID int64) (map[int64]bool, int64, error) {
	rows, err := s.repo.ListUserDepts(ctx, tenantID, userID)
	if err != nil {
		return nil, 0, err
	}
	ids := make(map[int64]bool, len(rows))
	primary := int64(0)
	for _, r := range rows {
		ids[r.DeptID] = true
		if r.IsPrimary {
			primary = r.DeptID
		}
	}
	if primary == 0 && len(rows) > 0 {
		primary = rows[0].DeptID // 无主标记时取首行兜底（数据防御）
	}
	return ids, primary, nil
}

// UserDeptChainOf 用户可见部门集 = 直接部门 ∪ 各部门祖先链（深度无关：
// 沿 parent 向上取并集；visited 防环兜底脏数据；未挂部门=空集）
func (s *Service) UserDeptChainOf(ctx context.Context, tenantID, userID int64) (map[int64]bool, error) {
	direct, _, err := s.UserDeptIDsOf(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	chain := make(map[int64]bool, len(direct)*2)
	if len(direct) == 0 {
		return chain, nil
	}
	// ListTree 为嵌套树（根数组+Children）：一次深度遍历展平为 parent 映射
	parent := make(map[int64]int64)
	var walk func(n orgapi.DeptNode, parentID int64)
	walk = func(n orgapi.DeptNode, parentID int64) {
		if _, dup := parent[n.ID]; dup {
			return // 重复/环防御：首见即登记
		}
		parent[n.ID] = parentID
		for _, c := range n.Children {
			walk(c, n.ID)
		}
	}
	tree, err := s.repo.ListTree(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, r := range tree {
		walk(r, 0)
	}
	for d := range direct {
		cur, visited := d, map[int64]bool{}
		for cur != 0 && !visited[cur] {
			visited[cur] = true
			chain[cur] = true
			cur = parent[cur] // 未知部门（已删/跨租户）→ 缺项 0 终止
		}
	}
	return chain, nil
}

/* ── 通讯录检索（2026-11-12：登录页搜人预登录公开版 + 用户面全员版共用内核）── */

// UserCard 通讯录卡片行（登录页下拉一项；org_path=主部门链路名 xx公司/a部门/xx组）。
// 预登录公开口径：不含 uid（防匿名枚举用户 ID）；登录后需 uid 发消息走 DirectoryUser
type UserCard struct {
	EmployeeNo string `json:"employee_no"`
	Name       string `json:"display_name"`
	OrgPath    string `json:"org_path"`
}

// DirectoryUser 用户面通讯录行（登录后；含 uid——发起单聊 conv.create 需要）
type DirectoryUser struct {
	UID        string `json:"uid"`
	EmployeeNo string `json:"employee_no"`
	Name       string `json:"display_name"`
	OrgPath    string `json:"org_path"`
}

// DirectoryFilter 用户面通讯录检索过滤：Q 同搜人（工号/姓名/拼音全拼/首字母）；
// DeptID>0 按部门过滤（任一挂靠命中，与管理端部门成员口径一致）；
// Ungrouped 仅未挂任何部门的用户（虚拟「未分组」——自助注册用户默认落此组，
// 管理员挂部门后自动离开，无 dept 记录零迁移）
type DirectoryFilter struct {
	Q         string
	DeptID    int64
	Ungrouped bool
	Cursor    string
	Limit     int
}

// UserDirectorySearch 登录页搜人（预登录公开）：薄委托共享内核，剥 uid 出公开卡片。
func (s *Service) UserDirectorySearch(ctx context.Context, tenantID int64, q, cursor string, limit int) ([]UserCard, string, error) {
	rows, next, err := s.directory(ctx, tenantID, DirectoryFilter{Q: q, Cursor: cursor, Limit: limit})
	if err != nil {
		return nil, "", err
	}
	cards := make([]UserCard, len(rows))
	for i, r := range rows {
		cards[i] = UserCard{EmployeeNo: r.EmployeeNo, Name: r.Name, OrgPath: r.OrgPath}
	}
	return cards, next, nil
}

// DirectoryUsers 用户面通讯录检索（登录后；含 uid + 部门/未分组过滤）。
func (s *Service) DirectoryUsers(ctx context.Context, tenantID int64, f DirectoryFilter) ([]DirectoryUser, string, error) {
	return s.directory(ctx, tenantID, f)
}

// directory 共享内核：q 命中 工号/姓名/拼音全拼/拼音首字母（不区分大小写）；
// 仅启用中人类账号；按工号升序 cursor 翻页（cursor=上一页末条工号，空=首页，
// 搜索态与翻页可叠加——q 变化前端重置 cursor）。内存实现（v0.1 用户量级）：全量用户
// 一次 + 部门挂靠按部门聚合（部门数小，避免按用户 N+1）。
func (s *Service) directory(ctx context.Context, tenantID int64, f DirectoryFilter) ([]DirectoryUser, string, error) {
	limit := f.Limit
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	q := strings.ToLower(strings.TrimSpace(f.Q))
	cursor := strings.TrimSpace(f.Cursor)

	users, _, err := s.repo.ListUsers(ctx, orgapi.UserListFilter{TenantID: tenantID, Status: orgapi.UserStatusActive, Limit: 5000})
	if err != nil {
		return nil, "", err
	}

	// 部门 id→名字/父链（ListTree 嵌套树展平，一次深度遍历）
	type deptMeta struct {
		name   string
		parent int64
	}
	depts := make(map[int64]deptMeta)
	var walk func(n orgapi.DeptNode, parentID int64)
	walk = func(n orgapi.DeptNode, parentID int64) {
		if _, dup := depts[n.ID]; dup {
			return
		}
		depts[n.ID] = deptMeta{name: n.Name, parent: parentID}
		for _, c := range n.Children {
			walk(c, n.ID)
		}
	}
	tree, err := s.repo.ListTree(ctx, tenantID)
	if err != nil {
		return nil, "", err
	}
	for _, r := range tree {
		walk(r, 0)
	}
	orgPath := func(deptID int64) string {
		var names []string
		cur, visited := deptID, map[int64]bool{}
		for cur != 0 && !visited[cur] {
			visited[cur] = true
			d, ok := depts[cur]
			if !ok {
				break
			}
			names = append(names, d.name)
			cur = d.parent
		}
		// names 目前 dept→root，反转成 root→dept 后以 / 连接
		for i, j := 0, len(names)-1; i < j; i, j = i+1, j-1 {
			names[i], names[j] = names[j], names[i]
		}
		return strings.Join(names, "/")
	}

	// 用户→部门集 + 主部门（按部门聚合成员，primary 优先；部门集兼做
	// deptID 过滤与「未分组」判定）
	memberOf := make(map[int64]map[int64]bool)
	primaryOf := make(map[int64]int64)
	for id := range depts {
		rows, derr := s.repo.ListDeptUsers(ctx, tenantID, id)
		if derr != nil {
			continue
		}
		for _, u := range rows {
			set := memberOf[u.UserID]
			if set == nil {
				set = make(map[int64]bool)
				memberOf[u.UserID] = set
			}
			set[id] = true
			if _, seen := primaryOf[u.UserID]; !seen || u.IsPrimary {
				primaryOf[u.UserID] = id
			}
		}
	}

	// 过滤（q 空=全量）+ 工号升序 + cursor 之后的 limit+1 条探测 has_more
	matched := make([]orgapi.User, 0, len(users))
	for _, u := range users {
		if u.Type != orgapi.UserTypeHuman || u.Status != orgapi.UserStatusActive {
			continue
		}
		if f.DeptID > 0 && !memberOf[u.ID][f.DeptID] {
			continue
		}
		if f.Ungrouped && len(memberOf[u.ID]) > 0 {
			continue
		}
		if q != "" {
			full, initials := pinyinutil.Pinyin(u.DisplayName), pinyinutil.Initials(u.DisplayName)
			if !(strings.Contains(strings.ToLower(u.EmployeeNo), q) ||
				strings.Contains(strings.ToLower(u.DisplayName), q) ||
				strings.Contains(full, q) ||
				strings.Contains(initials, q)) {
				continue
			}
		}
		matched = append(matched, u)
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i].EmployeeNo < matched[j].EmployeeNo })

	page := make([]DirectoryUser, 0, limit)
	next := ""
	for _, u := range matched {
		if cursor != "" && u.EmployeeNo <= cursor {
			continue
		}
		if len(page) >= limit {
			next = page[len(page)-1].EmployeeNo
			break
		}
		page = append(page, DirectoryUser{
			UID:        strconv.FormatInt(u.ID, 10),
			EmployeeNo: u.EmployeeNo,
			Name:       u.DisplayName,
			OrgPath:    orgPath(primaryOf[u.ID]),
		})
	}
	return page, next, nil
}
