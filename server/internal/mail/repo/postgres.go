// PG 实现：满足 Repo 接口（表见 migrations/0016_mail.sql）。
// RLS 依赖池会话级 app.tenant=1 兜底（internal/platform/pgxpool 包注释）；
// ID 分配 advisory lock 9125(mail 域低频表共享：domain/mailbox/folder/app_password)
// /9126(mail_message) + max(id)+1（雪花占位，13 篇 §1；xact lock 同事务可重入）。
package mailrepo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

const (
	lockKeyMail    int64 = 9125 // domain/mailbox/folder/app_password
	lockKeyMailMsg int64 = 9126 // mail_message
)

// Postgres 邮件域 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

// EnsureDefaultDomain seed 默认域（ON CONFLICT 幂等；已存在则读回）
func (p *Postgres) EnsureDefaultDomain(ctx context.Context, tenantID int64, domain string) (Domain, error) {
	d := Domain{TenantID: tenantID, Domain: domain, Mode: 1, IsDefault: true}
	err := p.pool.QueryRow(ctx, `
		INSERT INTO mail_domain (id, tenant_id, domain, mode, is_default)
		VALUES (COALESCE((SELECT max(id)+1 FROM mail_domain),1), $1, $2, 1, TRUE)
		ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
		RETURNING id, created_at`,
		tenantID, domain).Scan(&d.ID, &d.CreatedAt)
	if err != nil {
		return Domain{}, err
	}
	return d, nil
}

func (p *Postgres) ListDomains(ctx context.Context, tenantID int64) ([]Domain, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, domain, mode, is_default, created_at
		FROM mail_domain WHERE tenant_id=$1 ORDER BY id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Domain{}
	for rows.Next() {
		var d Domain
		if err := rows.Scan(&d.ID, &d.TenantID, &d.Domain, &d.Mode, &d.IsDefault, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *Postgres) GetMailboxByOwner(ctx context.Context, tenantID, userID int64) (*Mailbox, error) {
	return scanMailbox(p.pool.QueryRow(ctx, mailboxCols+`
		FROM mailbox WHERE tenant_id=$1 AND owner_user_id=$2`, tenantID, userID))
}

func (p *Postgres) GetMailboxByAddress(ctx context.Context, tenantID int64, address string) (*Mailbox, error) {
	return scanMailbox(p.pool.QueryRow(ctx, mailboxCols+`
		FROM mailbox WHERE tenant_id=$1 AND lower(address)=lower($2)`, tenantID, address))
}

// CreateMailbox 开户（事务内 AllocID + seed 六系统文件夹）
func (p *Postgres) CreateMailbox(ctx context.Context, mb Mailbox) (Mailbox, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Mailbox{}, err
	}
	defer tx.Rollback(ctx)
	if mb.ID == 0 {
		if mb.ID, err = bbwpg.AllocID(ctx, tx, lockKeyMail, "mailbox"); err != nil {
			return Mailbox{}, err
		}
	}
	if mb.CreatedAt.IsZero() {
		mb.CreatedAt = time.Now()
	}
	settings, _ := json.Marshal(mb.Settings)
	if err := tx.QueryRow(ctx, `
		INSERT INTO mailbox (id, tenant_id, domain_id, address, type, owner_user_id,
			govern_dept_id, quota_bytes, used_bytes, status, settings, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,0),$8,$9,$10,$11,$12)
		RETURNING created_at`,
		mb.ID, mb.TenantID, mb.DomainID, mb.Address, mb.Type, mb.OwnerUserID,
		mb.GovernDeptID, mb.QuotaBytes, mb.UsedBytes, mb.Status, settings, mb.CreatedAt).
		Scan(&mb.CreatedAt); err != nil {
		return Mailbox{}, err
	}
	for _, name := range SystemFolders {
		var fid int64
		if fid, err = bbwpg.AllocID(ctx, tx, lockKeyMail, "mail_folder_meta"); err != nil {
			return Mailbox{}, err
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO mail_folder_meta (id, tenant_id, mailbox_id, name, type)
			VALUES ($1,$2,$3,$4,$4)`, fid, mb.TenantID, mb.ID, name); err != nil {
			return Mailbox{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Mailbox{}, err
	}
	return mb, nil
}

func (p *Postgres) ListMailboxes(ctx context.Context, tenantID int64, status int) ([]Mailbox, error) {
	rows, err := p.pool.Query(ctx, mailboxCols+`
		FROM mailbox WHERE tenant_id=$1 AND ($2=0 OR status=$2) ORDER BY id`, tenantID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Mailbox{}
	for rows.Next() {
		mb, err := scanMailbox(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *mb)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateMailboxStatus(ctx context.Context, tenantID, mailboxID int64, status int) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE mailbox SET status=$1::smallint,
			suspended_at=CASE WHEN $1::smallint=2 THEN now() ELSE NULL END
		WHERE tenant_id=$2 AND id=$3`, status, tenantID, mailboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) AddUsage(ctx context.Context, _, mailboxID, delta int64) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE mailbox SET used_bytes=GREATEST(0, used_bytes+$1) WHERE id=$2`, delta, mailboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) UpdateSettings(ctx context.Context, _, mailboxID int64, s Settings) error {
	raw, _ := json.Marshal(s)
	tag, err := p.pool.Exec(ctx,
		`UPDATE mailbox SET settings=$1 WHERE id=$2`, raw, mailboxID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) ListFolders(ctx context.Context, mailboxID int64) ([]Folder, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, mailbox_id, name, total_count, unread_count
		FROM mail_folder_meta WHERE mailbox_id=$1 ORDER BY id`, mailboxID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.TenantID, &f.MailboxID, &f.Name, &f.TotalCount, &f.UnreadCount); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

const mailboxCols = `SELECT id, tenant_id, domain_id, address, type,
	COALESCE(owner_user_id,0), COALESCE(govern_dept_id,0), quota_bytes, used_bytes, status,
	COALESCE(settings,'{}'), created_at, COALESCE(suspended_at, 'epoch')`

func scanMailbox(row pgx.Row) (*Mailbox, error) {
	var mb Mailbox
	var settings []byte
	if err := row.Scan(&mb.ID, &mb.TenantID, &mb.DomainID, &mb.Address, &mb.Type,
		&mb.OwnerUserID, &mb.GovernDeptID, &mb.QuotaBytes, &mb.UsedBytes, &mb.Status,
		&settings, &mb.CreatedAt, &mb.SuspendedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal(settings, &mb.Settings)
	return &mb, nil
}

const msgCols = `SELECT id, tenant_id, mailbox_id, folder_id, message_id,
	COALESCE(in_reply_to,''), from_addr, to_addrs, cc_addrs, bcc_addrs,
	subject, snippet, COALESCE(body,''), has_attachment, attachments,
	flags, size, received_at`

func scanMessage(row pgx.Row) (*Message, error) {
	var m Message
	var to, cc, bcc, atts []byte
	if err := row.Scan(&m.ID, &m.TenantID, &m.MailboxID, &m.FolderID, &m.MessageID,
		&m.InReplyTo, &m.FromAddr, &to, &cc, &bcc,
		&m.Subject, &m.Snippet, &m.Body, &m.HasAttachment, &atts,
		&m.Flags, &m.Size, &m.ReceivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal(to, &m.ToAddrs)
	_ = json.Unmarshal(cc, &m.CcAddrs)
	_ = json.Unmarshal(bcc, &m.BccAddrs)
	_ = json.Unmarshal(atts, &m.Attachments)
	return &m, nil
}

func (p *Postgres) InsertMessage(ctx context.Context, m Message) (Message, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	if m.ID == 0 {
		if m.ID, err = bbwpg.AllocID(ctx, tx, lockKeyMailMsg, "mail_message"); err != nil {
			return Message{}, err
		}
	}
	if m.ReceivedAt.IsZero() {
		m.ReceivedAt = time.Now()
	}
	to, _ := json.Marshal(m.ToAddrs)
	cc, _ := json.Marshal(m.CcAddrs)
	bcc, _ := json.Marshal(m.BccAddrs)
	atts, _ := json.Marshal(m.Attachments)
	if err := tx.QueryRow(ctx, `
		INSERT INTO mail_message (id, tenant_id, mailbox_id, folder_id, message_id,
			in_reply_to, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, snippet,
			body, has_attachment, attachments, flags, size, body_state, received_at, fts)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9,$10,$11,$12,NULLIF($13,''),$14,$15,$16,$17,2,$18,
			to_tsvector('simple', coalesce($11,'') || ' ' || coalesce($19,'') || ' ' || coalesce($13,'')))
		RETURNING received_at`,
		m.ID, m.TenantID, m.MailboxID, m.FolderID, m.MessageID,
		m.InReplyTo, m.FromAddr, to, cc, bcc, m.Subject, m.Snippet,
		m.Body, m.HasAttachment, atts, m.Flags, m.Size, m.ReceivedAt, m.FromAddr).
		Scan(&m.ReceivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Message{}, err
		}
		// UK(mailbox_id, message_id) 幂等命中
		return Message{}, translateInsertErr(err)
	}
	// folder 计数（未读=flags 未置 seen）
	if _, err = tx.Exec(ctx, `
		UPDATE mail_folder_meta SET total_count=total_count+1,
			unread_count=unread_count + CASE WHEN $1 = 0 THEN 1 ELSE 0 END
		WHERE id=$2`, m.Flags&FlagSeen, m.FolderID); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	return m, nil
}

// translateInsertErr UK 冲突（23505）→ ErrDuplicateMessageID
func translateInsertErr(err error) error {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
		return ErrDuplicateMessageID
	}
	return err
}

func (p *Postgres) GetMessage(ctx context.Context, tenantID, msgID int64) (*Message, error) {
	return scanMessage(p.pool.QueryRow(ctx, msgCols+`
		FROM mail_message WHERE tenant_id=$1 AND id=$2`, tenantID, msgID))
}

func (p *Postgres) ListMessages(ctx context.Context, mailboxID, folderID, cursor int64, limit int, filter string) ([]Message, error) {
	filterCond := map[string]string{
		FilterUnread:  " AND (flags & 1) = 0",
		FilterStarred: " AND (flags & 2) <> 0",
		FilterAttach:  " AND has_attachment",
	}[filter]
	rows, err := p.pool.Query(ctx, msgCols+`
		FROM mail_message
		WHERE mailbox_id=$1 AND ($2=0 OR folder_id=$2) AND ($3=0 OR id<$3)`+filterCond+`
		ORDER BY received_at DESC, id DESC LIMIT $4`, mailboxID, folderID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateFlags(ctx context.Context, tenantID, msgID int64, mask, val int16) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var folderID int64
	var oldFlags int16
	if err := tx.QueryRow(ctx, `
		SELECT folder_id, flags FROM mail_message
		WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenantID, msgID).
		Scan(&folderID, &oldFlags); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	newFlags := (oldFlags &^ mask) | (val & mask)
	if _, err = tx.Exec(ctx,
		`UPDATE mail_message SET flags=$1 WHERE id=$2`, newFlags, msgID); err != nil {
		return err
	}
	// seen 位变化 → folder 未读计数同步
	if (oldFlags&FlagSeen == 0) != (newFlags&FlagSeen == 0) {
		delta := -1 // 未读→已读
		if newFlags&FlagSeen == 0 {
			delta = 1 // 已读→未读
		}
		if _, err = tx.Exec(ctx,
			`UPDATE mail_folder_meta SET unread_count=GREATEST(0, unread_count+$1) WHERE id=$2`,
			delta, folderID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *Postgres) MoveMessage(ctx context.Context, tenantID, msgID, folderID int64) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var mbID, srcFolder int64
	var flags int16
	if err := tx.QueryRow(ctx, `
		SELECT mailbox_id, folder_id, flags FROM mail_message
		WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, tenantID, msgID).
		Scan(&mbID, &srcFolder, &flags); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if srcFolder == folderID {
		return tx.Commit(ctx)
	}
	// 目标文件夹归属校验
	var dstMB int64
	if err := tx.QueryRow(ctx,
		`SELECT mailbox_id FROM mail_folder_meta WHERE id=$1`, folderID).Scan(&dstMB); err != nil {
		return ErrNotFound
	}
	if dstMB != mbID {
		return ErrNotFound
	}
	unread := int16(0)
	if flags&FlagSeen == 0 {
		unread = 1
	}
	tag, err := tx.Exec(ctx, `UPDATE mail_message SET folder_id=$1 WHERE id=$2`, folderID, msgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `
		UPDATE mail_folder_meta SET total_count=total_count-1, unread_count=unread_count-$1 WHERE id=$2`,
		unread, srcFolder); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
		UPDATE mail_folder_meta SET total_count=total_count+1, unread_count=unread_count+$1 WHERE id=$2`,
		unread, folderID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *Postgres) SearchMessages(ctx context.Context, tenantID int64, mailboxIDs []int64, q string, attachOnly bool, limit int) ([]Message, error) {
	needle := "%" + q + "%"
	rows, err := p.pool.Query(ctx, msgCols+`
		FROM mail_message
		WHERE tenant_id=$1 AND mailbox_id = ANY($2)
		  AND ($3='' OR subject ILIKE $3 OR from_addr ILIKE $3 OR snippet ILIKE $3 OR body ILIKE $3)
		  AND (NOT $4 OR has_attachment)
		ORDER BY received_at DESC, id DESC LIMIT $5`,
		tenantID, mailboxIDs, needle, attachOnly, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func (p *Postgres) CreateAppPassword(ctx context.Context, pwd AppPassword) (AppPassword, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return AppPassword{}, err
	}
	defer tx.Rollback(ctx)
	if pwd.ID == 0 {
		if pwd.ID, err = bbwpg.AllocID(ctx, tx, lockKeyMail, "mail_app_password"); err != nil {
			return AppPassword{}, err
		}
	}
	if pwd.CreatedAt.IsZero() {
		pwd.CreatedAt = time.Now()
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO mail_app_password (id, tenant_id, user_id, name, hash, created_at)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		pwd.ID, pwd.TenantID, pwd.UserID, pwd.Name, pwd.Hash, pwd.CreatedAt).
		Scan(&pwd.CreatedAt); err != nil {
		return AppPassword{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AppPassword{}, err
	}
	return pwd, nil
}

func (p *Postgres) ListAppPasswords(ctx context.Context, tenantID, userID int64) ([]AppPassword, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, user_id, name, created_at,
			COALESCE(last_used_at,'epoch'), COALESCE(revoked_at,'epoch')
		FROM mail_app_password
		WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL ORDER BY id`,
		tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AppPassword{}
	for rows.Next() {
		var pwd AppPassword
		if err := rows.Scan(&pwd.ID, &pwd.TenantID, &pwd.UserID, &pwd.Name,
			&pwd.CreatedAt, &pwd.LastUsedAt, &pwd.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, pwd)
	}
	return out, rows.Err()
}

func (p *Postgres) RevokeAppPassword(ctx context.Context, tenantID, id, userID int64) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE mail_app_password SET revoked_at=now()
		WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND revoked_at IS NULL`,
		tenantID, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetMailboxByID 主键查
func (p *Postgres) GetMailboxByID(ctx context.Context, tenantID, id int64) (*Mailbox, error) {
	return scanMailbox(p.pool.QueryRow(ctx, mailboxCols+`
		FROM mailbox WHERE tenant_id=$1 AND id=$2`, tenantID, id))
}
