// PG 实现（阶段二）：满足 Repo 接口，替换 NewMemory() 即可，service 无感知。
// 表结构见 migrations/0001_init.sql；RLS 依赖池会话级 app.tenant=1 兜底
// （见 internal/platform/pgxpool 包注释）。
// 关键点：
//   - AllocSeq 行锁原子分配（UPDATE ... RETURNING），等价 Redis INCR 的会话内全序；
//   - message 为按月分区表，无法建全局 UK(conv_id, client_msg_id)——幂等以查重前置
//   - 23505 兜底实现，跨进程/跨月重试由 Redis 幂等键承接（14 篇 §5.1，TODO）；
//   - SetReadSeq 以 GREATEST 在 SQL 层保证只进不退（04 篇 §4.2）。
package messagerepo

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	messageapi "github.com/baobaowork/server/internal/message/api"
	bbwpg "github.com/baobaowork/server/internal/platform/pgxpool"
)

// advisory lock 键（表级 ID 分配互斥，见 AllocID）
const (
	lockKeyConversation int64 = 9102
	lockKeyConvMember   int64 = 9105
)

// Postgres message 域 PG 仓储
type Postgres struct{ pool *pgxpool.Pool }

// compile-time 接口断言
var _ Repo = (*Postgres)(nil)

// NewPostgres 构造（返回接口类型）
func NewPostgres(pool *pgxpool.Pool) Repo { return &Postgres{pool: pool} }

// ── 可空列编码/解码辅助 ──

// jsonOrNull JSONB 列编码：空值落 NULL
func jsonOrNull(b []byte) any {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	return string(b)
}

func mentionsJSON(ms []messageapi.Mention) any {
	if len(ms) == 0 {
		return nil
	}
	b, err := json.Marshal(ms)
	if err != nil {
		return nil
	}
	return string(b)
}

func i64OrNull(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func timeOrNull(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

// msgCols 消息列（ts 毫秒化；SenderName 不落库，由 service 层 NameOf 实时解析）
const msgCols = `id, conv_id, seq, client_msg_id, sender_id, type, body, mentions,
	reply_to_seq, status, (extract(epoch from ts)*1000)::bigint`

func scanMessage(row pgx.Row) (*messageapi.Message, error) {
	var (
		m        messageapi.Message
		body     []byte
		mentions []byte
		replyTo  *int64
	)
	if err := row.Scan(&m.ID, &m.ConvID, &m.Seq, &m.ClientMsgID, &m.SenderID, &m.Type,
		&body, &mentions, &replyTo, &m.Status, &m.TS); err != nil {
		return nil, err
	}
	if len(body) > 0 {
		m.Body = json.RawMessage(body)
	}
	if len(mentions) > 0 {
		_ = json.Unmarshal(mentions, &m.Mentions)
	}
	if replyTo != nil {
		m.ReplyToSeq = *replyTo
	}
	return &m, nil
}

// convCols 会话列（last_msg_ts 毫秒化；可空列 COALESCE 兜底）。统一 c. 前缀：join 场景防歧义
const convCols = `c.id, c.tenant_id, c.type, COALESCE(c.name,''), COALESCE(c.owner_id,0),
	c.latest_seq, c.member_count, c.status, (extract(epoch from COALESCE(c.last_msg_ts, to_timestamp(0)))*1000)::bigint`

func scanConversation(row pgx.Row) (*Conversation, error) {
	var c Conversation
	if err := row.Scan(&c.ID, &c.TenantID, &c.Type, &c.Name, &c.OwnerID,
		&c.LatestSeq, &c.MemberCount, &c.Status, &c.LastMsgTS); err != nil {
		return nil, err
	}
	return &c, nil
}

// ── 会话 ──

// CreateConversation 建会话；ID=0 时表级分配（advisory lock + max+1，雪花占位，13 篇 §1）
func (p *Postgres) CreateConversation(ctx context.Context, c Conversation) (Conversation, error) {
	if c.Status == 0 {
		c.Status = messageapi.ConvActive
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	if c.ID == 0 {
		if c.ID, err = bbwpg.AllocID(ctx, tx, lockKeyConversation, "conversation"); err != nil {
			return Conversation{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation (id, tenant_id, type, name, owner_id, status)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		c.ID, c.TenantID, c.Type, c.Name, i64OrNull(c.OwnerID), c.Status); err != nil {
		return Conversation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Conversation{}, err
	}
	c.MemberCount = 0 // 新会话成员数为 0（AddMember 时递增）
	return c, nil
}

// DissolveConversation 解散（04 篇 §4.5.2：status=dissolved 只读；不存在时 no-op 同内存版）
func (p *Postgres) DissolveConversation(ctx context.Context, convID int64) error {
	_, err := p.pool.Exec(ctx,
		`UPDATE conversation SET status=$2, updated_at=now() WHERE id=$1`, convID, messageapi.ConvDissolved)
	return err
}

// GetConversation 查会话
func (p *Postgres) GetConversation(ctx context.Context, convID int64) (*Conversation, error) {
	c, err := scanConversation(p.pool.QueryRow(ctx,
		`SELECT `+convCols+` FROM conversation c WHERE c.id=$1`, convID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, messageapi.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// AddMember upsert 覆盖语义（与内存版一致：重复加人=复活并覆盖 role/mute_until）。
// id 无库端默认值：advisory lock 串行化 + max(id)+1 行内子查询分配（雪花占位）。
// xmax=0 判定本次为新增 INSERT（PG 无 INSERTED 语义的惯用法），新增才递增 member_count；
// 会话不存在时 SELECT 空 → no-op 同内存版。
func (p *Postgres) AddMember(ctx context.Context, m Member) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	// advisory lock 串行化 max(id)+1（与 AllocID 同思路；此处 id 经行内子查询随 INSERT 生成）
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKeyConvMember); err != nil {
		return err
	}
	var inserted bool
	err = tx.QueryRow(ctx, `
		INSERT INTO conversation_member (id, tenant_id, conv_id, user_id, role, mute_until, status)
		SELECT (SELECT COALESCE(max(id),0)+1 FROM conversation_member),
		       c.tenant_id, c.id, $2, COALESCE(NULLIF($3,0),3), $4, COALESCE(NULLIF($5,0),1)
		FROM conversation c WHERE c.id = $1
		ON CONFLICT (conv_id, user_id) DO UPDATE
			SET status = 1, role = EXCLUDED.role, mute_until = EXCLUDED.mute_until
		RETURNING (xmax = 0)`,
		m.ConvID, m.UserID, m.Role, timeOrNull(m.MuteUntil), m.Status).Scan(&inserted)
	switch {
	case errors.Is(err, pgx.ErrNoRows): // 会话不存在：no-op（同内存版）
		return tx.Commit(ctx)
	case err != nil:
		return err
	}
	if inserted { // 新成员才递增 member_count（与 upsert 同事务，原子）
		if _, err = tx.Exec(ctx,
			`UPDATE conversation SET member_count = member_count + 1 WHERE id=$1`, m.ConvID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ── 消息 ──

// AllocSeq 会话内 seq 行锁原子分配：UPDATE latest_seq+1 RETURNING（04 篇 §4.1；
// 生产高并发换 Redis INCR 单点分配，服务重启以分区 max(seq) 对齐——本实现天然持久无需对齐）
func (p *Postgres) AllocSeq(ctx context.Context, convID int64) (int64, error) {
	var seq int64
	err := p.pool.QueryRow(ctx,
		`UPDATE conversation SET latest_seq = latest_seq + 1, updated_at = now()
		 WHERE id = $1 RETURNING latest_seq`, convID).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, messageapi.ErrNotFound
	}
	return seq, err
}

// InsertMessage 落库（分区路由按 created_at=now()；tenant_id 取自会话行，RLS 写入检查需要）
func (p *Postgres) InsertMessage(ctx context.Context, m messageapi.Message) error {
	// 查重前置：分区表无全局 UK，命中同 client_msg_id 即拒绝（与内存版语义一致；
	// 进程内由 service 会话锁串行化，多实例一致性见包注释 TODO）
	if dup, err := p.FindByClientMsgID(ctx, m.ConvID, m.ClientMsgID); err != nil {
		return err
	} else if dup != nil {
		return ErrDuplicateClientMsgID
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO message (id, tenant_id, conv_id, seq, client_msg_id, sender_id, type,
			body, mentions, reply_to_seq, status, ts)
		SELECT $1, c.tenant_id, c.id, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9,
		       to_timestamp($10::double precision/1000)
		FROM conversation c WHERE c.id = $11`,
		m.ID, m.Seq, m.ClientMsgID, m.SenderID, m.Type,
		jsonOrNull(m.Body), mentionsJSON(m.Mentions), i64OrNull(m.ReplyToSeq), m.Status, m.TS, m.ConvID)
	if err != nil {
		var pe *pgconn.PgError
		if errors.As(err, &pe) && pe.Code == "23505" { // 唯一冲突兜底（未来补建分区本地 UK 时生效）
			return ErrDuplicateClientMsgID
		}
	}
	return err
}

// FindByClientMsgID 幂等命中查询（未命中返回 nil,nil）
func (p *Postgres) FindByClientMsgID(ctx context.Context, convID int64, clientMsgID string) (*messageapi.Message, error) {
	m, err := scanMessage(p.pool.QueryRow(ctx,
		`SELECT `+msgCols+` FROM message WHERE conv_id=$1 AND client_msg_id=$2
		 ORDER BY seq DESC LIMIT 1`, convID, clientMsgID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return m, nil
}

// ListMessages after<seq<before 升序；limit≤0 或 >100 取 20（与内存版一致，14 篇 §4.2）
func (p *Postgres) ListMessages(ctx context.Context, convID, after, before int64, limit int) ([]messageapi.Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	q := `SELECT ` + msgCols + ` FROM message WHERE conv_id=$1`
	args := []any{convID}
	if after > 0 {
		args = append(args, after)
		q += ` AND seq > $` + strconv.Itoa(len(args))
	}
	if before > 0 {
		args = append(args, before)
		q += ` AND seq < $` + strconv.Itoa(len(args))
	}
	args = append(args, limit)
	q += ` ORDER BY seq ASC LIMIT $` + strconv.Itoa(len(args))

	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []messageapi.Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

// LastMessage 会话最后一条（按 seq；空会话返回 nil,nil）
func (p *Postgres) LastMessage(ctx context.Context, convID int64) (*messageapi.Message, error) {
	m, err := scanMessage(p.pool.QueryRow(ctx,
		`SELECT `+msgCols+` FROM message WHERE conv_id=$1 ORDER BY seq DESC LIMIT 1`, convID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return m, nil
}

// MaxMessageID 库内最大消息 ID（service 启动时对齐内存计数器，防 PG 模式重启后 ID 回卷）
func (p *Postgres) MaxMessageID(ctx context.Context) (int64, error) {
	var id int64
	err := p.pool.QueryRow(ctx, `SELECT COALESCE(max(id),0) FROM message`).Scan(&id)
	return id, err
}

// TouchConversation 发送后冗余更新：latest_seq 只进不退取 GREATEST；last_msg_ts 覆盖（同内存版）
func (p *Postgres) TouchConversation(ctx context.Context, convID, seq, ts int64) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE conversation
		SET latest_seq = GREATEST(latest_seq, $2),
		    last_msg_ts = to_timestamp($3::double precision/1000),
		    updated_at = now()
		WHERE id = $1`, convID, seq, ts)
	return err
}

// ── 成员查询 ──

// MemberOf 查单个成员（不存在返回 nil,nil）
func (p *Postgres) MemberOf(ctx context.Context, convID, userID int64) (*Member, error) {
	var (
		m    Member
		mute *time.Time
	)
	err := p.pool.QueryRow(ctx,
		`SELECT role, status, mute_until FROM conversation_member WHERE conv_id=$1 AND user_id=$2`,
		convID, userID).Scan(&m.Role, &m.Status, &mute)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.ConvID, m.UserID = convID, userID
	if mute != nil {
		m.MuteUntil = *mute
	}
	return &m, nil
}

// MembersOf 在群成员 ID 列表（status=1，扇出目标）
func (p *Postgres) MembersOf(ctx context.Context, convID int64) ([]int64, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT user_id FROM conversation_member WHERE conv_id=$1 AND status=1`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ListUserConversations 用户会话列表（成员身份 join；last_msg_ts 倒序同内存版，04 篇 D3 §3.1）
func (p *Postgres) ListUserConversations(ctx context.Context, userID int64) ([]Conversation, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT `+convCols+`
		FROM conversation c
		JOIN conversation_member m ON m.conv_id = c.id AND m.user_id = $1 AND m.status = 1
		ORDER BY c.last_msg_ts DESC NULLS LAST`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Conversation{}
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// ── 回执 ──

// GetReceipt 回执游标（无记录返回零值，同内存版）
func (p *Postgres) GetReceipt(ctx context.Context, convID, userID int64) (Receipt, error) {
	var r Receipt
	err := p.pool.QueryRow(ctx,
		`SELECT delivered_seq, read_seq FROM message_receipt WHERE conv_id=$1 AND user_id=$2`,
		convID, userID).Scan(&r.DeliveredSeq, &r.ReadSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return Receipt{ConvID: convID, UserID: userID}, nil
	}
	if err != nil {
		return Receipt{}, err
	}
	r.ConvID, r.UserID = convID, userID
	return r, nil
}

// SetReadSeq 已读游标：GREATEST 在 SQL 层保证只进不退（04 篇 §4.2，即便调用方失守也不回退）；
// 首写 tenant_id 取自会话行（RLS 写入检查需要）
func (p *Postgres) SetReadSeq(ctx context.Context, convID, userID, readSeq int64) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO message_receipt (tenant_id, conv_id, user_id, read_seq, updated_at)
		SELECT c.tenant_id, c.id, $2, $3, now() FROM conversation c WHERE c.id = $1
		ON CONFLICT (conv_id, user_id) DO UPDATE
			SET read_seq = GREATEST(message_receipt.read_seq, EXCLUDED.read_seq), updated_at = now()`,
		convID, userID, readSeq)
	return err
}
