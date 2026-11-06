// PG 实现（阶段二）：满足 Repo 接口，替换 NewMemory() 即可，service 无感知（D02 §3）。
// RLS：依赖连接池会话级 app.tenant=1 兜底（见 internal/platform/pgxpool 包注释）；
// 查询仍显式携带 tenant 条件，双保险——切换 NOBYPASSRLS 应用账号后行为不变。
package orgrepo

import (
	"context"
	"errors"

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
