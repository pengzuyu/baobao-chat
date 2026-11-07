// PG 实现（阶段二）：满足 Repo 接口，替换 NewMemory() 即可，service 无感知（D02 §3）。
// RLS：依赖连接池会话级 app.tenant=1 兜底（见 internal/platform/pgxpool 包注释）；
// 查询仍显式携带 tenant 条件，双保险——切换 NOBYPASSRLS 应用账号后行为不变。
package orgrepo

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/baobaowork/server/internal/org/api"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

// lockKeyUsers users 表 ID 分配的 advisory lock 键（全局唯一，见 AllocID）
const lockKeyUsers int64 = 9101

// Postgres users 表仓储
type Postgres struct{ pool *pgxpool.Pool }

// compile-time 接口断言
var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

// userCols 列清单（可空列 COALESCE 兜底，避免扫描 NULL 报错）
const userCols = `id, tenant_id, type, employee_no, display_name,
	COALESCE(email,''), COALESCE(phone,''), COALESCE(password_hash,''), status`

func scanUser(row pgx.Row) (*orgapi.User, error) {
	var u orgapi.User
	if err := row.Scan(&u.ID, &u.TenantID, &u.Type, &u.EmployeeNo, &u.DisplayName,
		&u.Email, &u.Phone, &u.PasswordHash, &u.Status); err != nil {
		return nil, err
	}
	// Scopes 不落库：权限点归属 role/user_role 表（03 篇 §4），阶段二接 RBAC 查询拼装（TODO）
	return &u, nil
}

// CreateUser 落库；ID 为 0 时表级分配（advisory lock + max+1，雪花占位，13 篇 §1）。
// 与内存版一致：登录名索引由 DB 查询承担（employee_no/email/phone 任一可登录，03 篇 §2.1）。
func (p *Postgres) CreateUser(ctx context.Context, u orgapi.User) (orgapi.User, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return orgapi.User{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	if u.ID == 0 {
		if u.ID, err = bbwpg.AllocID(ctx, tx, lockKeyUsers, "users"); err != nil {
			return orgapi.User{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, tenant_id, type, employee_no, display_name, email, phone, password_hash, status)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),$8,$9)`,
		u.ID, u.TenantID, u.Type, u.EmployeeNo, u.DisplayName, u.Email, u.Phone, u.PasswordHash, u.Status); err != nil {
		return orgapi.User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return orgapi.User{}, err
	}
	return u, nil
}

// GetUser 按 ID 查
func (p *Postgres) GetUser(ctx context.Context, id int64) (*orgapi.User, error) {
	u, err := scanUser(p.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, orgapi.ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

// GetUserByLogin 登录名查（工号/邮箱/手机号任一命中，03 篇 §2.1）
func (p *Postgres) GetUserByLogin(ctx context.Context, tenantID int64, username string) (*orgapi.User, error) {
	u, err := scanUser(p.pool.QueryRow(ctx, `
		SELECT `+userCols+` FROM users
		WHERE tenant_id=$1 AND (employee_no=$2 OR email=$2 OR phone=$2)
		LIMIT 1`, tenantID, username))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, orgapi.ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

// listUsersSQL 管理端列表查询（keyword ILIKE 工号/姓名/邮箱 + status + cursor 翻页）
const listUsersSQL = `
	SELECT ` + userCols + ` FROM users
	WHERE tenant_id=$1 AND ($2 = '' OR employee_no ILIKE '%'||$2||'%'
		OR display_name ILIKE '%'||$2||'%' OR COALESCE(email,'') ILIKE '%'||$2||'%')
	AND ($3 = 0 OR status = $3) AND id > $4
	ORDER BY id ASC LIMIT $5`

// ListUsers 用户列表（D10 阶段一：keyword/status/cursor；RLS app.tenant 兜底双保险）
func (p *Postgres) ListUsers(ctx context.Context, f orgapi.UserListFilter) ([]orgapi.User, bool, error) {
	rows, err := p.pool.Query(ctx, listUsersSQL,
		f.TenantID, f.Keyword, f.Status, f.Cursor, f.LimitOrDefault()+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	limit := f.LimitOrDefault()
	out := make([]orgapi.User, 0, limit)
	hasMore := false
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, false, err
		}
		if len(out) >= limit { // 取 limit+1 探测还有下一页，多出的一条丢弃
			hasMore = true
			break
		}
		out = append(out, *u)
	}
	return out, hasMore, rows.Err()
}

// CountUsers 用户总数
func (p *Postgres) CountUsers(ctx context.Context, tenantID int64) (int64, error) {
	var n int64
	if err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM users WHERE tenant_id=$1`, tenantID).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// SetUserStatus 状态变更（启用/禁用；updated_at 一并刷新）
func (p *Postgres) SetUserStatus(ctx context.Context, id int64, status int) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE users SET status=$2, updated_at=now() WHERE id=$1`, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return orgapi.ErrUserNotFound
	}
	return nil
}

// ── 组织树 PG 实现（0001 dept 表；物化路径随建随算） ──

const lockKeyDept int64 = 9125

func (p *Postgres) CreateDept(ctx context.Context, tenantID, parentID int64, name string, sort int) (*orgapi.DeptNode, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 50 {
		return nil, orgapi.ErrDeptName
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var parentPath string
	if parentID > 0 {
		if err := tx.QueryRow(ctx, `SELECT path FROM dept WHERE tenant_id=$1 AND id=$2`,
			tenantID, parentID).Scan(&parentPath); err != nil {
			return nil, orgapi.ErrDeptNotFound
		}
	}
	id, err := bbwpg.AllocID(ctx, tx, lockKeyDept, "dept")
	if err != nil {
		return nil, err
	}
	d := orgapi.Dept{ID: id, TenantID: tenantID, ParentID: parentID, Name: name, Sort: sort,
		Path: parentPath + strconv.FormatInt(id, 10) + "/"}
	if _, err := tx.Exec(ctx, `
		INSERT INTO dept (id, tenant_id, NULLIF($2,0), name, path, sort) VALUES ($1,$3,$2,$4,$5,$6)`,
		d.ID, parentID, tenantID, name, d.Path, sort); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	n := toNode(d)
	return &n, nil
}

func (p *Postgres) ListTree(ctx context.Context, tenantID int64) ([]orgapi.DeptNode, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, COALESCE(parent_id,0), name, path, sort FROM dept
		WHERE tenant_id=$1 ORDER BY sort, id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := map[int64]*orgapi.DeptNode{}
	order := []int64{}
	parents := map[int64]int64{}
	for rows.Next() {
		var n orgapi.DeptNode
		if err := rows.Scan(&n.ID, &n.ParentID, &n.Name, &n.Path, &n.Sort); err != nil {
			return nil, err
		}
		nodes[n.ID] = &n
		order = append(order, n.ID)
		parents[n.ID] = n.ParentID
	}
	// 倒序装配（子先于父）：塞给父时自身 children 已完整——避免自顶向下副本链丢深层
	roots := []int64{}
	for i := len(order) - 1; i >= 0; i-- {
		id := order[i]
		if pID := parents[id]; pID > 0 {
			if pn, ok := nodes[pID]; ok {
				pn.Children = append([]orgapi.DeptNode{*nodes[id]}, pn.Children...)
				continue
			}
		}
		roots = append([]int64{id}, roots...)
	}
	out := make([]orgapi.DeptNode, 0, len(roots))
	for _, id := range roots {
		out = append(out, *nodes[id])
	}
	return out, rows.Err()
}

func (p *Postgres) RenameDept(ctx context.Context, tenantID, deptID int64, name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 50 {
		return orgapi.ErrDeptName
	}
	tag, err := p.pool.Exec(ctx, `UPDATE dept SET name=$1, updated_at=now() WHERE tenant_id=$2 AND id=$3`,
		name, tenantID, deptID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return orgapi.ErrDeptNotFound
	}
	return nil
}

func (p *Postgres) DeleteDept(ctx context.Context, tenantID, deptID int64) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var child, members int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM dept WHERE tenant_id=$1 AND parent_id=$2`,
		tenantID, deptID).Scan(&child); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM user_dept WHERE tenant_id=$1 AND dept_id=$2`,
		tenantID, deptID).Scan(&members); err != nil {
		return err
	}
	if child > 0 || members > 0 {
		return orgapi.ErrDeptNotEmpty
	}
	tag, err := tx.Exec(ctx, `DELETE FROM dept WHERE tenant_id=$1 AND id=$2`, tenantID, deptID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return orgapi.ErrDeptNotFound
	}
	return tx.Commit(ctx)
}
