// PG 实现：满足 Repo 接口（表见 migrations/0012_bot.sql）。
// RLS 依赖池会话级 app.tenant=1 兜底（internal/platform/pgxpool 包注释）；
// ID 分配 advisory lock 9118(bot)/9119(bot_webhook) + max(id)+1（雪花占位，13 篇 §1）。
package botrepo

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

const (
	lockKeyBot     int64 = 9118 // bot
	lockKeyWebhook int64 = 9119 // bot_webhook
)

// Postgres 机器人域 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

const botCols = `id, tenant_id, user_id, COALESCE(dept_id,0), name,
	COALESCE(description,''), owner_user_id, status, created_at`

func scanBot(row pgx.Row) (*Bot, error) {
	var b Bot
	if err := row.Scan(&b.ID, &b.TenantID, &b.UserID, &b.DeptID, &b.Name,
		&b.Description, &b.OwnerUserID, &b.Status, &b.CreatedAt); err != nil {
		return nil, err
	}
	return &b, nil
}

// CreateBot 新增（bot 主档；user(type=bot) 由服务层经闭包先行创建）
func (p *Postgres) CreateBot(ctx context.Context, b Bot) (Bot, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Bot{}, err
	}
	defer tx.Rollback(ctx)
	if b.ID == 0 {
		if b.ID, err = bbwpg.AllocID(ctx, tx, lockKeyBot, "bot"); err != nil {
			return Bot{}, err
		}
	}
	if b.CreatedAt.IsZero() {
		b.CreatedAt = time.Now()
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO bot (id, tenant_id, user_id, dept_id, name, description, owner_user_id, status, created_at)
		VALUES ($1,$2,$3,NULLIF($4,0),$5,NULLIF($6,''),$7,$8,$9)
		RETURNING created_at`,
		b.ID, b.TenantID, b.UserID, b.DeptID, b.Name, b.Description, b.OwnerUserID, b.Status, b.CreatedAt).
		Scan(&b.CreatedAt); err != nil {
		return Bot{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Bot{}, err
	}
	return b, nil
}

func (p *Postgres) GetBot(ctx context.Context, tenantID, botID int64) (*Bot, error) {
	return scanBot(p.pool.QueryRow(ctx,
		`SELECT `+botCols+` FROM bot WHERE tenant_id=$1 AND id=$2`, tenantID, botID))
}

func (p *Postgres) GetBotByUser(ctx context.Context, tenantID, userID int64) (*Bot, error) {
	return scanBot(p.pool.QueryRow(ctx,
		`SELECT `+botCols+` FROM bot WHERE tenant_id=$1 AND user_id=$2`, tenantID, userID))
}

func (p *Postgres) ListBots(ctx context.Context, tenantID int64, status int) ([]Bot, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+botCols+` FROM bot WHERE tenant_id=$1 AND ($2=0 OR status=$2)
		ORDER BY id`, tenantID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Bot{}
	for rows.Next() {
		var b Bot
		if err := rows.Scan(&b.ID, &b.TenantID, &b.UserID, &b.DeptID, &b.Name,
			&b.Description, &b.OwnerUserID, &b.Status, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateBotStatus(ctx context.Context, tenantID, botID int64, status int) error {
	tag, err := p.pool.Exec(ctx,
		`UPDATE bot SET status=$1, updated_at=now() WHERE tenant_id=$2 AND id=$3`, status, tenantID, botID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

const webhookCols = `id, tenant_id, bot_id, direction, hook_id, secret,
	COALESCE(prev_secret,''), COALESCE(prev_expires_at, to_timestamp(0)),
	COALESCE(default_conv_id,0), COALESCE(targets,'[]'::jsonb), COALESCE(ip_allowlist,'[]'::jsonb),
	COALESCE(rate_limit,30), status, COALESCE(rotated_at, to_timestamp(0)), created_at`

// direction 列为 SMALLINT（1 in 2 out），仓储侧与 string 形态互转
func dirFromDB(v int16) string {
	if v == 2 {
		return "out"
	}
	return "in"
}

func dirToDB(s string) int16 {
	if s == "out" {
		return 2
	}
	return 1
}

func scanWebhook(row pgx.Row) (*Webhook, error) {
	var (
		w              Webhook
		dirDB          int16
		targets, allow []byte
	)
	if err := row.Scan(&w.ID, &w.TenantID, &w.BotID, &dirDB, &w.HookID, &w.Secret,
		&w.PrevSecret, &w.PrevExpiresAt, &w.DefaultConvID, &targets, &allow,
		&w.RateLimit, &w.Status, &w.RotatedAt, &w.CreatedAt); err != nil {
		return nil, err
	}
	w.Direction = dirFromDB(dirDB)
	if len(targets) > 0 {
		_ = json.Unmarshal(targets, &w.Targets)
	}
	if len(allow) > 0 {
		_ = json.Unmarshal(allow, &w.IPAllowlist)
	}
	return &w, nil
}

// CreateWebhook 新增（targets/ip_allowlist jsonb）
func (p *Postgres) CreateWebhook(ctx context.Context, w Webhook) (Webhook, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Webhook{}, err
	}
	defer tx.Rollback(ctx)
	if w.ID == 0 {
		if w.ID, err = bbwpg.AllocID(ctx, tx, lockKeyWebhook, "bot_webhook"); err != nil {
			return Webhook{}, err
		}
	}
	if w.CreatedAt.IsZero() {
		w.CreatedAt = time.Now()
	}
	targets, _ := json.Marshal(w.Targets)
	allow, _ := json.Marshal(w.IPAllowlist)
	if err := tx.QueryRow(ctx, `
		INSERT INTO bot_webhook (id, tenant_id, bot_id, direction, hook_id, secret,
			default_conv_id, targets, ip_allowlist, rate_limit, status, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,0),$8,$9,$10,$11,$12)
		RETURNING created_at`,
		w.ID, w.TenantID, w.BotID, dirToDB(w.Direction), w.HookID, w.Secret,
		w.DefaultConvID, targets, allow, w.RateLimit, w.Status, w.CreatedAt).
		Scan(&w.CreatedAt); err != nil {
		return Webhook{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Webhook{}, err
	}
	return w, nil
}

func (p *Postgres) GetWebhook(ctx context.Context, tenantID, webhookID int64) (*Webhook, error) {
	return scanWebhook(p.pool.QueryRow(ctx,
		`SELECT `+webhookCols+` FROM bot_webhook WHERE tenant_id=$1 AND id=$2`, tenantID, webhookID))
}

func (p *Postgres) GetWebhookByHookID(ctx context.Context, hookID string) (*Webhook, error) {
	return scanWebhook(p.pool.QueryRow(ctx,
		`SELECT `+webhookCols+` FROM bot_webhook WHERE hook_id=$1`, hookID))
}

func (p *Postgres) RotateWebhookSecret(ctx context.Context, tenantID, webhookID int64, newSecret, prevSecret string, prevExpiresAt time.Time) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE bot_webhook SET secret=$1, prev_secret=NULLIF($2,''), prev_expires_at=$3,
			rotated_at=now(), updated_at=now()
		WHERE tenant_id=$4 AND id=$5`,
		newSecret, prevSecret, prevExpiresAt, tenantID, webhookID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
