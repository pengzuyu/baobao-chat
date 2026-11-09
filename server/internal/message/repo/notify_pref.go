// 用户通知偏好仓储双实现（0030 / D12）。
package messagerepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NotifyPrefMemory 偏好内存仓储
type NotifyPrefMemory struct {
	rows map[int64]NotifyPref // userID → 行
}

// NewNotifyPrefMemory 构造
func NewNotifyPrefMemory() *NotifyPrefMemory { return &NotifyPrefMemory{rows: map[int64]NotifyPref{}} }

// GetNotifyPref（无行 nil）
func (m *NotifyPrefMemory) GetNotifyPref(_ context.Context, tenantID, userID int64) (*NotifyPref, error) {
	if p, ok := m.rows[userID]; ok && p.TenantID == tenantID {
		cp := p
		return &cp, nil
	}
	return nil, nil
}

// SetNotifyPref upsert
func (m *NotifyPrefMemory) SetNotifyPref(_ context.Context, p NotifyPref) error {
	if p.UpdatedAt.IsZero() {
		p.UpdatedAt = time.Now()
	}
	m.rows[p.UserID] = p
	return nil
}

// NotifyPrefPostgres 偏好 PG 仓储
type NotifyPrefPostgres struct{ pool *pgxpool.Pool }

var _ NotifyPrefRepo = (*NotifyPrefPostgres)(nil)

// NewNotifyPrefPostgres 构造
func NewNotifyPrefPostgres(pool *pgxpool.Pool) NotifyPrefRepo {
	return &NotifyPrefPostgres{pool: pool}
}

// GetNotifyPref（无行 nil）
func (p *NotifyPrefPostgres) GetNotifyPref(ctx context.Context, tenantID, userID int64) (*NotifyPref, error) {
	var np NotifyPref
	err := p.pool.QueryRow(ctx, `
		SELECT user_id, tenant_id, msg_notify, mention_notify, dnd_range, updated_at
		FROM user_notify_pref WHERE tenant_id=$1 AND user_id=$2`, tenantID, userID).
		Scan(&np.UserID, &np.TenantID, &np.MsgNotify, &np.MentionNotify, &np.DndRange, &np.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &np, nil
}

// SetNotifyPref upsert
func (p *NotifyPrefPostgres) SetNotifyPref(ctx context.Context, np NotifyPref) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO user_notify_pref (user_id, tenant_id, msg_notify, mention_notify, dnd_range, updated_at)
		VALUES ($1,$2,$3,$4,$5, now())
		ON CONFLICT (user_id) DO UPDATE
			SET msg_notify=$3, mention_notify=$4, dnd_range=$5, updated_at=now()`,
		np.UserID, np.TenantID, np.MsgNotify, np.MentionNotify, np.DndRange)
	return err
}
