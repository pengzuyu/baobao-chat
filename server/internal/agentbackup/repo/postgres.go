// PG 实现（表见 migrations/0025_agent_session_backup.sql；lock 9132——
// org 9101 · message 9102-9108 · file 9109/9120/9121 · kb 9110-9113 · admin 9114-9115
// · doc 9116-9117 · org dept/acl 9125/9127 · meeting 9129-9130 · eco 9131 已占）。
package agentbackuprepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

const lockKeyAgentBackup int64 = 9132

// Postgres Agent 备份索引 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

const cols = `id, tenant_id, user_id, local_session_id, COALESCE(title,''), enc_alg,
	key_envelope, size, COALESCE(idempotency_key,''), created_at`

func scan(row pgx.Row) (*Row, error) {
	var r Row
	if err := row.Scan(&r.ID, &r.TenantID, &r.UserID, &r.LocalSessionID, &r.Title, &r.EncAlg,
		&r.KeyEnvelope, &r.Size, &r.IdempotencyKey, &r.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &r, nil
}

// Insert 落行；ID 经 advisory lock 9132 + max+1；幂等冲突（uq_agent_backup_idem）→ ErrDuplicateIdem
func (p *Postgres) Insert(ctx context.Context, r Row) (Row, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Row{}, err
	}
	defer tx.Rollback(ctx)
	if r.ID == 0 {
		if r.ID, err = bbwpg.AllocID(ctx, tx, lockKeyAgentBackup, "agent_session_backup"); err != nil {
			return Row{}, err
		}
	}
	var idem any
	if r.IdempotencyKey != "" {
		idem = r.IdempotencyKey
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO agent_session_backup
			(id, tenant_id, user_id, local_session_id, title, enc_alg, key_envelope, size, idempotency_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id, created_at`,
		r.ID, r.TenantID, r.UserID, r.LocalSessionID, r.Title, r.EncAlg, r.KeyEnvelope, r.Size, idem).
		Scan(&r.ID, &r.CreatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Row{}, ErrDuplicateIdem
		}
		return Row{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Row{}, err
	}
	return r, nil
}

// GetByIdempotency 幂等命中查询
func (p *Postgres) GetByIdempotency(ctx context.Context, userID int64, key string) (*Row, error) {
	if key == "" {
		return nil, nil
	}
	return scan(p.pool.QueryRow(ctx,
		`SELECT `+cols+` FROM agent_session_backup WHERE user_id=$1 AND idempotency_key=$2`,
		userID, key))
}

// Get 行详情
func (p *Postgres) Get(ctx context.Context, id int64) (*Row, error) {
	return scan(p.pool.QueryRow(ctx, `SELECT `+cols+` FROM agent_session_backup WHERE id=$1`, id))
}

// ListByUser 我的备份（created_at 倒序，id 降序兜底稳定）
func (p *Postgres) ListByUser(ctx context.Context, tenantID, userID int64) ([]Row, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT `+cols+` FROM agent_session_backup
		WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC, id DESC`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.ID, &r.TenantID, &r.UserID, &r.LocalSessionID, &r.Title, &r.EncAlg,
			&r.KeyEnvelope, &r.Size, &r.IdempotencyKey, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Delete 删行
func (p *Postgres) Delete(ctx context.Context, id int64) error {
	ct, err := p.pool.Exec(ctx, `DELETE FROM agent_session_backup WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
