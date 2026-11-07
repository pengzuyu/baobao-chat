// DeliveryRepo PG 实现（表见 migrations/0018_bot_delivery_log.sql）。
// ID 分配 advisory lock 9128 + max(id)+1（雪花占位，13 篇 §1）。
package botrepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

const lockKeyDelivery int64 = 9128

// PostgresDeliveries Outgoing 投递 PG 仓储
type PostgresDeliveries struct{ pool *pgxpool.Pool }

var _ DeliveryRepo = (*PostgresDeliveries)(nil)

// NewPostgresDeliveries 构造（返回接口类型）
func NewPostgresDeliveries(pool *pgxpool.Pool) DeliveryRepo {
	return &PostgresDeliveries{pool: pool}
}

const deliveryCols = `id, tenant_id, bot_id, webhook_id, event_id, event_type,
	payload_digest, target_url, attempt, COALESCE(next_retry_at, 'epoch'),
	status, COALESCE(response_code,0), COALESCE(error_brief,''), created_at`

func scanDelivery(row pgx.Row) (*Delivery, error) {
	var d Delivery
	if err := row.Scan(&d.ID, &d.TenantID, &d.BotID, &d.WebhookID, &d.EventID, &d.EventType,
		&d.PayloadDigest, &d.TargetURL, &d.Attempt, &d.NextRetryAt,
		&d.Status, &d.ResponseCode, &d.ErrorBrief, &d.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if d.NextRetryAt.Equal(time.Unix(0, 0).UTC()) {
		d.NextRetryAt = time.Time{}
	}
	return &d, nil
}

func (p *PostgresDeliveries) InsertDelivery(ctx context.Context, d Delivery) (Delivery, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Delivery{}, err
	}
	defer tx.Rollback(ctx)
	if d.ID == 0 {
		if d.ID, err = bbwpg.AllocID(ctx, tx, lockKeyDelivery, "bot_delivery_log"); err != nil {
			return Delivery{}, err
		}
	}
	var next *time.Time
	if !d.NextRetryAt.IsZero() {
		next = &d.NextRetryAt
	}
	if d.Status == 0 {
		d.Status = 1
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO bot_delivery_log (id, tenant_id, bot_id, webhook_id, event_id,
			event_type, payload_digest, target_url, attempt, next_retry_at, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING created_at`,
		d.ID, d.TenantID, d.BotID, d.WebhookID, d.EventID,
		d.EventType, d.PayloadDigest, d.TargetURL, d.Attempt, next, d.Status).
		Scan(&d.CreatedAt); err != nil {
		return Delivery{}, translateDeliveryErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Delivery{}, err
	}
	return d, nil
}

// translateDeliveryErr UK(tenant,event_id) 23505 → ErrDupDelivery
func translateDeliveryErr(err error) error {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
		return ErrDupDelivery
	}
	return err
}

func (p *PostgresDeliveries) GetDelivery(ctx context.Context, tenantID, id int64) (*Delivery, error) {
	return scanDelivery(p.pool.QueryRow(ctx,
		`SELECT `+deliveryCols+` FROM bot_delivery_log WHERE tenant_id=$1 AND id=$2`, tenantID, id))
}

func (p *PostgresDeliveries) UpdateDeliveryAttempt(ctx context.Context, tenantID, id int64,
	attempt, responseCode int, errBrief string, nextRetry time.Time, status int) error {
	var next *time.Time
	if !nextRetry.IsZero() {
		next = &nextRetry
	}
	tag, err := p.pool.Exec(ctx, `
		UPDATE bot_delivery_log SET attempt=$1, response_code=NULLIF($2,0),
			error_brief=NULLIF($3,''), next_retry_at=$4, status=$5, updated_at=now()
		WHERE tenant_id=$6 AND id=$7`,
		attempt, responseCode, errBrief, next, status, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresDeliveries) DueDeliveries(ctx context.Context, tenantID int64, now time.Time, limit int) ([]Delivery, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+deliveryCols+` FROM bot_delivery_log
		WHERE tenant_id=$1 AND status=1 AND (next_retry_at IS NULL OR next_retry_at<=$2)
		ORDER BY id LIMIT $3`, tenantID, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func (p *PostgresDeliveries) ListDeliveries(ctx context.Context, tenantID int64, f DeliveryFilter) ([]Delivery, error) {
	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx, `
		SELECT `+deliveryCols+` FROM bot_delivery_log
		WHERE tenant_id=$1 AND ($2=0 OR bot_id=$2) AND ($3=0 OR webhook_id=$3)
		  AND ($4=0 OR status=$4)
		ORDER BY id DESC LIMIT $5`, tenantID, f.BotID, f.WebhookID, f.Status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func (p *PostgresDeliveries) ReplayDelivery(ctx context.Context, tenantID, id int64) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE bot_delivery_log SET status=1, attempt=0, next_retry_at=NULL,
			error_brief='', updated_at=now()
		WHERE tenant_id=$1 AND id=$2 AND status=3`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
