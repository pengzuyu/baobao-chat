// adminrepo PG 实现：admin_audit_action（迁移 0010）+ sensitive_word（迁移 0006）+
// ai_usage_hourly 聚合（aigw 域表，阶段一务实直读，登记见 repo.go UsageReader）。
// RLS：依赖连接池会话级 app.tenant=1 兜底；查询仍显式携带 tenant 条件，双保险。
package adminrepo

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/baobaowork/server/internal/admin/api"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

// advisory lock 键（表级 ID 分配互斥；org 9101 / message 9102-9108 / file 9109 /
// kb 9110-9113 已占——D10 本域取 9114 起）
const (
	lockKeyAdminAudit int64 = 9114 // admin_audit_action
	lockKeySenseWord  int64 = 9115 // sensitive_word
)

// Postgres PG 实现
type Postgres struct {
	pool *pgxpool.Pool

	// 敏感词缓存（EnabledSensitiveWords 为 message 域每条消息发送路径热更源，
	// 不能逐条打 DB）：进程内首次加载 + 本进程写路径即时失效；多实例热更
	// 经阶段二 policy.updated 事件广播（当前单实例部署，登记）
	wordMu     sync.RWMutex
	wordCache  []string
	wordLoaded bool
}

var _ Repo = (*Postgres)(nil)
var _ UsageReader = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

// ── 审计 ──

// InsertAudit 落库；ID 经 advisory lock 9114 + max+1 分配（雪花占位，13 篇 §1）
func (p *Postgres) InsertAudit(ctx context.Context, a AuditAction) (AuditAction, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return AuditAction{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	if a.ID, err = bbwpg.AllocID(ctx, tx, lockKeyAdminAudit, "admin_audit_action"); err != nil {
		return AuditAction{}, err
	}
	detail := a.Detail
	if len(detail) == 0 {
		detail = []byte("{}")
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_audit_action (id, tenant_id, operator_id, action, target, detail, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()))`,
		a.ID, a.TenantID, a.OperatorID, a.Action, a.Target, detail, nullTime(a.CreatedAt)); err != nil {
		return AuditAction{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuditAction{}, err
	}
	return a, nil
}

// ListAudit id 倒序时间线 + cursor 翻页（limit+1 探测 has_more）
func (p *Postgres) ListAudit(ctx context.Context, tenantID int64, cursor int64, limit int) ([]AuditAction, bool, error) {
	limit = limitOrDefault(limit)
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, operator_id, action, target, detail::text, created_at
		FROM admin_audit_action
		WHERE tenant_id=$1 AND ($2 = 0 OR id < $2)
		ORDER BY id DESC LIMIT $3`, tenantID, cursor, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := make([]AuditAction, 0, limit)
	hasMore := false
	for rows.Next() {
		var a AuditAction
		var detail string
		if err := rows.Scan(&a.ID, &a.TenantID, &a.OperatorID, &a.Action, &a.Target, &detail, &a.CreatedAt); err != nil {
			return nil, false, err
		}
		a.Detail = []byte(detail)
		if len(out) >= limit {
			hasMore = true
			break
		}
		out = append(out, a)
	}
	return out, hasMore, rows.Err()
}

// ── 敏感词 ──

// InsertSensitiveWord UK(tenant_id,word) 冲突（23505）→ ErrDupWord
func (p *Postgres) InsertSensitiveWord(ctx context.Context, w SensitiveWord) (SensitiveWord, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return SensitiveWord{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if w.ID, err = bbwpg.AllocID(ctx, tx, lockKeySenseWord, "sensitive_word"); err != nil {
		return SensitiveWord{}, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO sensitive_word (id, tenant_id, word, mode, category, enabled, created_by)
		VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7)`,
		w.ID, w.TenantID, w.Word, w.Mode, w.Category, w.Enabled, w.CreatedBy)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return SensitiveWord{}, ErrDupWord
		}
		return SensitiveWord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SensitiveWord{}, err
	}
	p.invalidateWordCache()
	return w, nil
}

// DeleteSensitiveWord 删除（连带失效缓存）
func (p *Postgres) DeleteSensitiveWord(ctx context.Context, tenantID, id int64) error {
	tag, err := p.pool.Exec(ctx,
		`DELETE FROM sensitive_word WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrWordNotFound
	}
	p.invalidateWordCache()
	return nil
}

// ListSensitiveWords id 倒序 + cursor 翻页
func (p *Postgres) ListSensitiveWords(ctx context.Context, tenantID int64, cursor int64, limit int) ([]SensitiveWord, bool, error) {
	limit = limitOrDefault(limit)
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, word, mode, COALESCE(category,''), enabled, created_by, created_at
		FROM sensitive_word
		WHERE tenant_id=$1 AND ($2 = 0 OR id < $2)
		ORDER BY id DESC LIMIT $3`, tenantID, cursor, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := make([]SensitiveWord, 0, limit)
	hasMore := false
	for rows.Next() {
		var w SensitiveWord
		if err := rows.Scan(&w.ID, &w.TenantID, &w.Word, &w.Mode, &w.Category, &w.Enabled, &w.CreatedBy, &w.CreatedAt); err != nil {
			return nil, false, err
		}
		if len(out) >= limit {
			hasMore = true
			break
		}
		out = append(out, w)
	}
	return out, hasMore, rows.Err()
}

// CountSensitiveWords 全量计数
func (p *Postgres) CountSensitiveWords(ctx context.Context, tenantID int64) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM sensitive_word WHERE tenant_id=$1`, tenantID).Scan(&n)
	return n, err
}

// EnabledSensitiveWords mode=1 且启用的词（进程内缓存；写路径失效）
func (p *Postgres) EnabledSensitiveWords(ctx context.Context, tenantID int64) ([]string, error) {
	p.wordMu.RLock()
	if p.wordLoaded {
		out := make([]string, len(p.wordCache))
		copy(out, p.wordCache)
		p.wordMu.RUnlock()
		return out, nil
	}
	p.wordMu.RUnlock()

	words, err := p.loadEnabledWords(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	p.wordMu.Lock()
	p.wordCache, p.wordLoaded = words, true
	p.wordMu.Unlock()
	out := make([]string, len(words))
	copy(out, words)
	return out, nil
}

func (p *Postgres) loadEnabledWords(ctx context.Context, tenantID int64) ([]string, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT word FROM sensitive_word WHERE tenant_id=$1 AND enabled AND mode=1`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var w string
		if err := rows.Scan(&w); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (p *Postgres) invalidateWordCache() {
	p.wordMu.Lock()
	p.wordCache, p.wordLoaded = nil, false
	p.wordMu.Unlock()
}

// ── 用量（ai_usage_hourly 聚合；阶段一务实直读 aigw 域表，登记）──

// UsageRows 近 days 日逐 (date,tier,scene) 聚合行
func (p *Postgres) UsageRows(ctx context.Context, tenantID int64, days int) ([]adminapi.UsageRow, error) {
	since := time.Now().UTC().AddDate(0, 0, -(days - 1)).Truncate(24 * time.Hour)
	rows, err := p.pool.Query(ctx, `
		SELECT to_char(date_trunc('day', hour_bucket), 'YYYY-MM-DD') AS d, tier, scene,
			sum(requests), sum(prompt_tokens), sum(completion_tokens), sum(total_tokens)
		FROM ai_usage_hourly
		WHERE tenant_id=$1 AND hour_bucket >= $2
		GROUP BY 1, 2, 3
		ORDER BY 1`, tenantID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []adminapi.UsageRow{}
	for rows.Next() {
		var r adminapi.UsageRow
		if err := rows.Scan(&r.Date, &r.Tier, &r.Scene, &r.Requests, &r.PromptTokens, &r.CompletionTokens, &r.TotalTokens); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// nullTime 零值时间落 NULL（created_at 交库端 now()）
func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
