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
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	messageapi "github.com/baobaochat/server/internal/message/api"
	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

// advisory lock 键（表级 ID 分配互斥，见 AllocID）
const (
	lockKeyConversation int64 = 9102
	lockKeyConvMember   int64 = 9105
	lockKeyConvApply    int64 = 9106
	lockKeyMsgFavorite  int64 = 9107
	lockKeyUserNotif    int64 = 9108 // user_notification（D03 PIM-09）
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

// msgCols 消息列（ts/edited_at 毫秒化；SenderName 不落库，由 service 层 NameOf 实时解析）
const msgCols = `id, conv_id, seq, client_msg_id, sender_id, type, body, mentions,
	reply_to_seq, ext, status,
	(extract(epoch from COALESCE(edited_at, to_timestamp(0)))*1000)::bigint,
	COALESCE(edit_version, 1), (extract(epoch from ts)*1000)::bigint`

func scanMessage(row pgx.Row) (*messageapi.Message, error) {
	var (
		m        messageapi.Message
		body     []byte
		mentions []byte
		ext      []byte
		replyTo  *int64
	)
	if err := row.Scan(&m.ID, &m.ConvID, &m.Seq, &m.ClientMsgID, &m.SenderID, &m.Type,
		&body, &mentions, &replyTo, &ext, &m.Status, &m.EditedAt, &m.EditVersion, &m.TS); err != nil {
		return nil, err
	}
	if len(body) > 0 {
		m.Body = json.RawMessage(body)
	}
	if len(mentions) > 0 {
		_ = json.Unmarshal(mentions, &m.Mentions)
	}
	if len(ext) > 0 {
		m.Ext = json.RawMessage(ext)
	}
	if replyTo != nil {
		m.ReplyToSeq = *replyTo
	}
	// 旧版语义：首版 edit_version 落库默认 1，API 侧"未编辑=0"对齐（D03 §6.3）
	if m.EditVersion <= 1 {
		m.EditVersion = 0
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
		if c.ID, err = bbcpg.AllocID(ctx, tx, lockKeyConversation, "conversation"); err != nil {
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
// member_count 口径=在群成员数：新增行或「已退/被移出 → 复活」均递增（Remove/Quit 已递减，
// 复活不补则计数漂移）；仅覆盖在群成员（幂等拉人）不重复递增。
// 会话不存在时 no-op 同内存版。
func (p *Postgres) AddMember(ctx context.Context, m Member) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	// 原状态探测（FOR UPDATE 防并发复活双计）：NULL=新行
	var oldStatus *int
	if err = tx.QueryRow(ctx,
		`SELECT status FROM conversation_member WHERE conv_id=$1 AND user_id=$2 FOR UPDATE`,
		m.ConvID, m.UserID).Scan(&oldStatus); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	reactivated := oldStatus != nil && *oldStatus != 1
	if oldStatus == nil {
		// advisory lock 串行化 max(id)+1（与 AllocID 同思路）
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKeyConvMember); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO conversation_member (id, tenant_id, conv_id, user_id, role, mute_until, status, join_at)
			SELECT (SELECT COALESCE(max(id),0)+1 FROM conversation_member),
			       c.tenant_id, c.id, $2, COALESCE(NULLIF($3,0),3), $4, COALESCE(NULLIF($5,0),1), now()
			FROM conversation c WHERE c.id = $1`,
			m.ConvID, m.UserID, m.Role, timeOrNull(m.MuteUntil), m.Status); err != nil {
			return err
		}
	} else {
		if _, err = tx.Exec(ctx, `
			UPDATE conversation_member
			SET status = 1, role = COALESCE(NULLIF($3,0),role), mute_until = $4, join_at = now()
			WHERE conv_id = $1 AND user_id = $2`,
			m.ConvID, m.UserID, m.Role, timeOrNull(m.MuteUntil)); err != nil {
			return err
		}
	}
	if oldStatus == nil || reactivated { // 新增/复活才递增（幂等拉人不动计数）
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
			body, mentions, reply_to_seq, ext, status, ts)
		SELECT $1, c.tenant_id, c.id, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10,
		       to_timestamp($11::double precision/1000)
		FROM conversation c WHERE c.id = $12`,
		m.ID, m.Seq, m.ClientMsgID, m.SenderID, m.Type,
		jsonOrNull(m.Body), mentionsJSON(m.Mentions), i64OrNull(m.ReplyToSeq),
		jsonOrNull(m.Ext), m.Status, m.TS, m.ConvID)
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

// GetMessageByID 按消息 ID 查（编辑/撤回/回应入口；不存在返回 ErrNotFound）
func (p *Postgres) GetMessageByID(ctx context.Context, msgID int64) (*messageapi.Message, error) {
	m, err := scanMessage(p.pool.QueryRow(ctx,
		`SELECT `+msgCols+` FROM message WHERE id=$1 ORDER BY created_at DESC LIMIT 1`, msgID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, messageapi.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return m, nil
}

// GetMessageBySeq 会话内按 seq 查（引用快照构建；不存在返回 nil,nil——service 兜底空快照）
func (p *Postgres) GetMessageBySeq(ctx context.Context, convID, seq int64) (*messageapi.Message, error) {
	m, err := scanMessage(p.pool.QueryRow(ctx,
		`SELECT `+msgCols+` FROM message WHERE conv_id=$1 AND seq=$2 LIMIT 1`, convID, seq))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return m, nil
}

// UpdateMessage 行更新（body/ext/status/edited_at/edit_version；分区表按 id+最新 created_at 定位）
func (p *Postgres) UpdateMessage(ctx context.Context, m messageapi.Message) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE message SET body=$2::jsonb, ext=$3::jsonb, status=$4,
			edited_at=CASE WHEN $5::bigint > 0 THEN to_timestamp($5::double precision/1000) ELSE NULL END,
			edit_version=$6
		WHERE id=$1 AND created_at = (SELECT max(created_at) FROM message WHERE id=$1)`,
		m.ID, jsonOrNull(m.Body), jsonOrNull(m.Ext), m.Status, m.EditedAt, max(m.EditVersion, 1))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return messageapi.ErrNotFound
	}
	return nil
}

// UserConvState 读用户会话态（无记录返回零值）
func (p *Postgres) UserConvState(ctx context.Context, userID, convID int64) (UserConvState, error) {
	var s UserConvState
	err := p.pool.QueryRow(ctx,
		`SELECT pinned, mute, COALESCE(draft,'') FROM user_conv_state WHERE user_id=$1 AND conv_id=$2`,
		userID, convID).Scan(&s.Pinned, &s.Mute, &s.Draft)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserConvState{}, nil
	}
	return s, err
}

// SetUserConvState upsert（全字段覆盖，service 层合并后写）；首写 tenant_id 取自会话行（同 SetReadSeq）
func (p *Postgres) SetUserConvState(ctx context.Context, userID, convID int64, s UserConvState) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO user_conv_state (user_id, conv_id, tenant_id, pinned, mute, draft)
		SELECT $2, c.id, c.tenant_id, $3, $4, $5 FROM conversation c WHERE c.id = $1
		ON CONFLICT (user_id, conv_id) DO UPDATE
			SET pinned=$3, mute=$4, draft=$5, updated_at=now()`,
		convID, userID, s.Pinned, s.Mute, s.Draft)
	return err
}

// CountPinned 用户当前置顶数（OQ-B06 上限校验）
func (p *Postgres) CountPinned(ctx context.Context, userID int64) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM user_conv_state WHERE user_id=$1 AND pinned`, userID).Scan(&n)
	return n, err
}

// ListMessagesLatest 最新 N 条（order=-seq 语义）：倒序取 N 再升序返回（D03 API-IM-04）
func (p *Postgres) ListMessagesLatest(ctx context.Context, convID int64, limit int) ([]messageapi.Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := p.pool.Query(ctx,
		`SELECT `+msgCols+` FROM message WHERE conv_id=$1 ORDER BY seq DESC LIMIT $2`, convID, limit)
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
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

// ListReceipts 全成员回执行（API-IM-06 已读面板；空集=全员从未已读）
func (p *Postgres) ListReceipts(ctx context.Context, convID int64) ([]Receipt, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT user_id, delivered_seq, read_seq FROM message_receipt WHERE conv_id=$1`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Receipt{}
	for rows.Next() {
		var r Receipt
		if err := rows.Scan(&r.UserID, &r.DeliveredSeq, &r.ReadSeq); err != nil {
			return nil, err
		}
		r.ConvID = convID
		out = append(out, r)
	}
	return out, rows.Err()
}

// ── 群管理（D03 §3.5/§3.6/§4.1 INT-IM-15~19；表见 migrations/0001/0004）──

// UpdateMemberRole 角色变更（status 非 0 时一并覆盖；行不存在返回 ErrNotFound）
func (p *Postgres) UpdateMemberRole(ctx context.Context, convID, userID int64, role, status int) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE conversation_member
		SET role = $3,
		    status = CASE WHEN $4 > 0 THEN $4 ELSE status END
		WHERE conv_id = $1 AND user_id = $2`,
		convID, userID, role, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return messageapi.ErrNotFound
	}
	return nil
}

// markMemberStatus 退群/移出共用：status 仅在「原在群」时迁移（S2 状态机）并递减 member_count
func (p *Postgres) markMemberStatus(ctx context.Context, convID, userID int64, status int) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	tag, err := tx.Exec(ctx, `
		UPDATE conversation_member SET status=$3, mute_until=NULL
		WHERE conv_id=$1 AND user_id=$2 AND status=1`, convID, userID, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		if _, err = tx.Exec(ctx,
			`UPDATE conversation SET member_count = member_count - 1
			 WHERE id=$1 AND member_count > 0`, convID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// RemoveMember 移出（status=3）
func (p *Postgres) RemoveMember(ctx context.Context, convID, userID int64) error {
	return p.markMemberStatus(ctx, convID, userID, 3)
}

// QuitMember 退群（status=2）
func (p *Postgres) QuitMember(ctx context.Context, convID, userID int64) error {
	return p.markMemberStatus(ctx, convID, userID, 2)
}

// MuteMember 单人禁言（零值=解除）
func (p *Postgres) MuteMember(ctx context.Context, convID, userID int64, until time.Time) error {
	_, err := p.pool.Exec(ctx,
		`UPDATE conversation_member SET mute_until=$3 WHERE conv_id=$1 AND user_id=$2`,
		convID, userID, timeOrNull(until))
	return err
}

// UpdateConversationMeta 群名/群主变更（空串/0 = 不变；转让用）
func (p *Postgres) UpdateConversationMeta(ctx context.Context, convID int64, name string, ownerID int64) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE conversation SET
			name    = COALESCE(NULLIF($2, ''), name),
			owner_id = COALESCE(NULLIF($3, 0), owner_id),
			updated_at = now()
		WHERE id = $1`, convID, name, ownerID)
	return err
}

// FindSingleConv 单聊去重：双方均为在群成员的 active 单聊（INT-IM-15）
func (p *Postgres) FindSingleConv(ctx context.Context, userA, userB int64) (*Conversation, error) {
	c, err := scanConversation(p.pool.QueryRow(ctx, `
		SELECT `+convCols+`
		FROM conversation c
		WHERE c.type = 1 AND c.status = 1
			AND EXISTS (SELECT 1 FROM conversation_member a
				WHERE a.conv_id = c.id AND a.user_id = $1 AND a.status = 1)
			AND EXISTS (SELECT 1 FROM conversation_member b
				WHERE b.conv_id = c.id AND b.user_id = $2 AND b.status = 1)
		LIMIT 1`, userA, userB))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// FindSelfConv 自聊会话复用：活跃成员恰含自己一人的 active 单聊（2026-11-26）。
// 不用 FindSingleConv(uid, uid) 代替——双 EXISTS 对同 uid 恒真，会误命中任意单聊
func (p *Postgres) FindSelfConv(ctx context.Context, userID int64) (*Conversation, error) {
	c, err := scanConversation(p.pool.QueryRow(ctx, `
		SELECT `+convCols+`
		FROM conversation c
		WHERE c.type = 1 AND c.status = 1
			AND EXISTS (SELECT 1 FROM conversation_member m
				WHERE m.conv_id = c.id AND m.user_id = $1 AND m.status = 1)
			AND NOT EXISTS (SELECT 1 FROM conversation_member o
				WHERE o.conv_id = c.id AND o.user_id <> $1 AND o.status = 1)
		LIMIT 1`, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// ListMembersDetailed 成员行明细（全状态；join_at 直读 timestamptz——Member.JoinAt
// 即 time.Time，毫秒化在 DTO 层做。2026-11-12 修复：原第 5 列选 epoch 毫秒 bigint
// 却扫进 time.Time，PG 二进制协议必炸 9004——conv.create 落库成功后 buildDetail 恒
// 失败（残迹：重复单聊行），PG 模式建会话从未走通）
func (p *Postgres) ListMembersDetailed(ctx context.Context, convID int64) ([]Member, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT user_id, role, status, mute_until, join_at
		FROM conversation_member WHERE conv_id=$1 ORDER BY join_at, user_id`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Member{}
	for rows.Next() {
		var (
			m    Member
			mute *time.Time
		)
		if err := rows.Scan(&m.UserID, &m.Role, &m.Status, &mute, &m.JoinAt); err != nil {
			return nil, err
		}
		m.ConvID = convID
		if mute != nil {
			m.MuteUntil = *mute
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetGroupSetting 群设置（无记录返回默认值）
func (p *Postgres) GetGroupSetting(ctx context.Context, convID int64) (GroupSetting, error) {
	var (
		s       GroupSetting
		muteAll *time.Time
		annoTS  *time.Time
		history bool
		anno    *string
	)
	err := p.pool.QueryRow(ctx, `
		SELECT join_mode, invite_policy, mention_all_policy, mute_all_until,
			history_visible, announcement, announcement_ts
		FROM group_setting WHERE conv_id=$1`, convID).
		Scan(&s.JoinMode, &s.InvitePolicy, &s.MentionAllPolicy, &muteAll, &history, &anno, &annoTS)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultGroupSetting(convID), nil
	}
	if err != nil {
		return GroupSetting{}, err
	}
	s.ConvID = convID
	s.HistoryVisible = history
	if muteAll != nil {
		s.MuteAllUntil = *muteAll
	}
	if annoTS != nil {
		s.AnnouncementTS = *annoTS
	}
	if anno != nil {
		s.Announcement = *anno
	}
	return s, nil
}

// UpsertGroupSetting 整行覆盖（service 合并默认值后写；tenant_id 取自会话行）
func (p *Postgres) UpsertGroupSetting(ctx context.Context, s GroupSetting) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO group_setting (conv_id, tenant_id, join_mode, invite_policy, mention_all_policy,
			mute_all_until, history_visible, announcement, announcement_ts)
		SELECT $1, c.tenant_id, $2, $3, $4, $5, $6, $7, $8
		FROM conversation c WHERE c.id = $1
		ON CONFLICT (conv_id) DO UPDATE SET
			join_mode = $2, invite_policy = $3, mention_all_policy = $4,
			mute_all_until = $5, history_visible = $6, announcement = $7, announcement_ts = $8`,
		s.ConvID, s.JoinMode, s.InvitePolicy, s.MentionAllPolicy,
		timeOrNull(s.MuteAllUntil), s.HistoryVisible,
		strOrNull(s.Announcement), timeOrNull(s.AnnouncementTS))
	return err
}

// strOrNull TEXT 列空值编码（announcement 清空用 NULL 语义对齐内存版零值）
func strOrNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// CreateApply 入群申请（ID=0 时表级分配；uk_apply_pending 冲突由 service 前置查重规避）
func (p *Postgres) CreateApply(ctx context.Context, a Apply) (Apply, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Apply{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	if a.ID == 0 {
		if a.ID, err = bbcpg.AllocID(ctx, tx, lockKeyConvApply, "conversation_apply"); err != nil {
			return Apply{}, err
		}
	}
	created := a.CreatedAt
	if created.IsZero() {
		created = time.Now()
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO conversation_apply (id, tenant_id, conv_id, user_id, reason, status, created_at)
		SELECT $1, c.tenant_id, c.id, $2, $3, $4, $5
		FROM conversation c WHERE c.id = $6`,
		a.ID, a.UserID, a.Reason, a.Status, created, a.ConvID); err != nil {
		return Apply{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Apply{}, err
	}
	a.CreatedAt = created
	return a, nil
}

// GetApplyByID 查申请（不存在返回 ErrNotFound）
func (p *Postgres) GetApplyByID(ctx context.Context, id int64) (*Apply, error) {
	var (
		a         Apply
		handledBy *int64
		handledAt *time.Time
	)
	err := p.pool.QueryRow(ctx, `
		SELECT id, conv_id, user_id, COALESCE(reason,''), status, handled_by, handled_at, created_at
		FROM conversation_apply WHERE id=$1`, id).
		Scan(&a.ID, &a.ConvID, &a.UserID, &a.Reason, &a.Status, &handledBy, &handledAt, &a.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, messageapi.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if handledBy != nil {
		a.HandledBy = *handledBy
	}
	if handledAt != nil {
		a.HandledAt = *handledAt
	}
	return &a, nil
}

// UpdateApplyStatus 状态机流转（approve→2/reject→3/过期→4）
func (p *Postgres) UpdateApplyStatus(ctx context.Context, id int64, status int, handledBy int64, handledAt time.Time) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE conversation_apply
		SET status=$2, handled_by=$3, handled_at=$4
		WHERE id=$1`, id, status, i64OrNull(handledBy), timeOrNull(handledAt))
	return err
}

// ListAppliesByConv 按状态列申请（status=0 全部；待审懒过期由 service 承担）
func (p *Postgres) ListAppliesByConv(ctx context.Context, convID int64, status int) ([]Apply, error) {
	q := `SELECT id, conv_id, user_id, COALESCE(reason,''), status, handled_by, handled_at, created_at
		FROM conversation_apply WHERE conv_id=$1`
	args := []any{convID}
	if status != 0 {
		args = append(args, status)
		q += ` AND status=$` + strconv.Itoa(len(args))
	}
	q += ` ORDER BY created_at DESC LIMIT 100`
	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Apply{}
	for rows.Next() {
		var (
			a         Apply
			handledBy *int64
			handledAt *time.Time
		)
		if err := rows.Scan(&a.ID, &a.ConvID, &a.UserID, &a.Reason, &a.Status, &handledBy, &handledAt, &a.CreatedAt); err != nil {
			return nil, err
		}
		if handledBy != nil {
			a.HandledBy = *handledBy
		}
		if handledAt != nil {
			a.HandledAt = *handledAt
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ── 搜索（D03 §3.7 PIM-07 服务端态；API-IM-12）──

// likeEscape ILIKE 通配符转义（keyword 作为纯子串语义，%/_/\ 按字面匹配）
func likeEscape(s string) string {
	r := strings.ReplaceAll(s, `\`, `\\`)
	r = strings.ReplaceAll(r, `%`, `\%`)
	return strings.ReplaceAll(r, `_`, `\_`)
}

// SearchMessages 服务端态搜索（阶段一 ILIKE；zhparser 全文索引阶段二）：
// 可见性=发起者在群成员的会话（JOIN conversation_member status=1）；
// 命中口径 body->>'text' / body->>'name'（与内存版 searchableTextOf 一致）；
// 已撤回(status=2)不可检索；msg_id 倒序分页（cursor=上一页最后一条 msg_id）。
func (p *Postgres) SearchMessages(ctx context.Context, f SearchFilter) ([]messageapi.Message, error) {
	if f.Limit <= 0 || f.Limit > 100 {
		f.Limit = 20
	}
	q := `SELECT m.id, m.conv_id, m.seq, m.client_msg_id, m.sender_id, m.type, m.body, m.mentions,
		m.reply_to_seq, m.ext, m.status,
		(extract(epoch from COALESCE(m.edited_at, to_timestamp(0)))*1000)::bigint,
		COALESCE(m.edit_version, 1), (extract(epoch from m.ts)*1000)::bigint
	FROM message m
	JOIN conversation_member cm ON cm.conv_id = m.conv_id AND cm.user_id = $1 AND cm.status = 1
	WHERE m.status <> 2
		AND (m.body->>'text' ILIKE '%' || $2 || '%' ESCAPE '\' OR m.body->>'name' ILIKE '%' || $2 || '%' ESCAPE '\')`
	args := []any{f.UserID, likeEscape(f.Keyword)}
	if f.FromUID > 0 {
		args = append(args, f.FromUID)
		q += ` AND m.sender_id = $` + strconv.Itoa(len(args))
	}
	if f.ConvID > 0 {
		args = append(args, f.ConvID)
		q += ` AND m.conv_id = $` + strconv.Itoa(len(args))
	}
	if f.Type != "" {
		args = append(args, f.Type)
		q += ` AND m.type = $` + strconv.Itoa(len(args))
	}
	if f.FromTS > 0 {
		args = append(args, float64(f.FromTS))
		q += ` AND m.ts >= to_timestamp($` + strconv.Itoa(len(args)) + `::double precision/1000)`
	}
	if f.ToTS > 0 {
		args = append(args, float64(f.ToTS))
		q += ` AND m.ts <= to_timestamp($` + strconv.Itoa(len(args)) + `::double precision/1000)`
	}
	if f.Cursor > 0 {
		args = append(args, f.Cursor)
		q += ` AND m.id < $` + strconv.Itoa(len(args))
	}
	args = append(args, f.Limit)
	q += ` ORDER BY m.id DESC LIMIT $` + strconv.Itoa(len(args))

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

// ── 收藏（D03 §3.8 PIM-08；§6.1 message_favorite，迁移 0005）──

// AddFavorite 收藏（UK(user_id,msg_id) 冲突幂等返回现值 created=false；
// tenant_id 取自消息所属会话行——RLS 写入检查需要）
func (p *Postgres) AddFavorite(ctx context.Context, userID, msgID, convID int64) (Favorite, bool, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Favorite{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	var favID int64
	if favID, err = bbcpg.AllocID(ctx, tx, lockKeyMsgFavorite, "message_favorite"); err != nil {
		return Favorite{}, false, err
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO message_favorite (id, tenant_id, user_id, msg_id, conv_id)
		SELECT $1, c.tenant_id, $2, $3, c.id FROM conversation c WHERE c.id = $4
		ON CONFLICT (user_id, msg_id) DO NOTHING`,
		favID, userID, msgID, convID)
	if err != nil {
		return Favorite{}, false, err
	}
	if tag.RowsAffected() == 0 { // 已收藏：返回现值（幂等）
		if err = tx.Commit(ctx); err != nil {
			return Favorite{}, false, err
		}
		cur, err := p.getFavorite(ctx, userID, msgID)
		if err != nil {
			return Favorite{}, false, err
		}
		return *cur, false, nil
	}
	if err = tx.Commit(ctx); err != nil {
		return Favorite{}, false, err
	}
	cur, err := p.getFavorite(ctx, userID, msgID)
	if err != nil {
		return Favorite{}, false, err
	}
	return *cur, true, nil
}

// getFavorite 查收藏行（不存在返回 ErrNotFound）
func (p *Postgres) getFavorite(ctx context.Context, userID, msgID int64) (*Favorite, error) {
	var f Favorite
	err := p.pool.QueryRow(ctx, `
		SELECT id, user_id, msg_id, conv_id, created_at
		FROM message_favorite WHERE user_id=$1 AND msg_id=$2`, userID, msgID).
		Scan(&f.ID, &f.UserID, &f.MsgID, &f.ConvID, &f.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, messageapi.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// RemoveFavorite 取消收藏（不存在 no-op，幂等）
func (p *Postgres) RemoveFavorite(ctx context.Context, userID, msgID int64) error {
	_, err := p.pool.Exec(ctx,
		`DELETE FROM message_favorite WHERE user_id=$1 AND msg_id=$2`, userID, msgID)
	return err
}

// ListFavorites 收藏列表（created_at 倒序 + id 次序稳定；type 过滤经消息行 JOIN；
// cursor=收藏 id，0=首页）
func (p *Postgres) ListFavorites(ctx context.Context, userID int64, msgType string, cursor int64, limit int) ([]Favorite, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	q := `SELECT f.id, f.user_id, f.msg_id, f.conv_id, f.created_at
		FROM message_favorite f`
	args := []any{userID}
	if msgType != "" {
		q += ` JOIN message m ON m.id = f.msg_id AND m.type = $2`
		args = append(args, msgType)
	}
	q += ` WHERE f.user_id = $1`
	if cursor > 0 {
		args = append(args, cursor)
		q += ` AND f.id < $` + strconv.Itoa(len(args))
	}
	args = append(args, limit)
	q += ` ORDER BY f.created_at DESC, f.id DESC LIMIT $` + strconv.Itoa(len(args))

	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Favorite{}
	for rows.Next() {
		var f Favorite
		if err := rows.Scan(&f.ID, &f.UserID, &f.MsgID, &f.ConvID, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// CountFavorites 收藏总数（上限 1000 校验依据）
func (p *Postgres) CountFavorites(ctx context.Context, userID int64) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM message_favorite WHERE user_id=$1`, userID).Scan(&n)
	return n, err
}

// ExistsFavorite UK(user_id,msg_id) 探测
func (p *Postgres) ExistsFavorite(ctx context.Context, userID, msgID int64) (bool, error) {
	var exists bool
	err := p.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM message_favorite WHERE user_id=$1 AND msg_id=$2)`,
		userID, msgID).Scan(&exists)
	return exists, err
}

// ── 通知（D03 §3.9 PIM-09；user_notification，迁移 0007）──

// scanNotifCols 通知行统一列清单（与 scanNotif 对齐）
const notifCols = `id, tenant_id, user_id, kind, conv_id, msg_id, seq, title, digest, count, created_at, read_at`

// scanNotif 行扫描（可空列用指针承接）
func scanNotif(row pgx.Row) (*Notification, error) {
	var (
		n                  Notification
		convID, msgID, seq *int64
		readAt             *time.Time
	)
	if err := row.Scan(&n.ID, &n.TenantID, &n.UserID, &n.Kind, &convID, &msgID, &seq,
		&n.Title, &n.Digest, &n.Count, &n.CreatedAt, &readAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, messageapi.ErrNotFound
		}
		return nil, err
	}
	if convID != nil {
		n.ConvID = *convID
	}
	if msgID != nil {
		n.MsgID = *msgID
	}
	if seq != nil {
		n.Seq = *seq
	}
	if readAt != nil {
		n.ReadAt = *readAt
	}
	return &n, nil
}

// notifTenantExpr tenant_id 取值表达式：优先随会话行（RLS 写入检查同收藏），
// 无会话行（agent_done 预留等）回落池会话级 app.tenant 设置
func notifTenantExpr() string {
	return `COALESCE((SELECT c.tenant_id FROM conversation c WHERE c.id = $2),
		current_setting('app.tenant', true)::BIGINT)`
}

// InsertNotification 新增通知行（ID advisory lock 9108 + max+1 分配）
func (p *Postgres) InsertNotification(ctx context.Context, n Notification) (Notification, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Notification{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	if n.ID, err = bbcpg.AllocID(ctx, tx, lockKeyUserNotif, "user_notification"); err != nil {
		return Notification{}, err
	}
	tenantExpr := notifTenantExpr()
	if _, err = tx.Exec(ctx, `
		INSERT INTO user_notification
			(id, tenant_id, user_id, kind, conv_id, msg_id, seq, title, digest, count, created_at, read_at)
		VALUES ($1, `+tenantExpr+`, $3, $4, NULLIF($5::bigint,0), NULLIF($6::bigint,0), NULLIF($7::bigint,0),
			$8, $9, $10, $11, NULL)`,
		n.ID, n.ConvID, n.UserID, n.Kind, n.ConvID, n.MsgID, n.Seq,
		n.Title, n.Digest, n.Count, n.CreatedAt); err != nil {
		return Notification{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Notification{}, err
	}
	return n, nil
}

// InsertMergedNotification 聚合写入（D03 §3.9 同 (user,kind,conv) 10s 窗口合并"×N"）：
// FOR UPDATE 锁候选行防并发双开新行；窗口以 n.CreatedAt（服务端注入时钟）为基准。
func (p *Postgres) InsertMergedNotification(ctx context.Context, n Notification, window time.Duration) (Notification, bool, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Notification{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // 提交后 Rollback 为 no-op
	cutoff := n.CreatedAt.Add(-window)
	var mergeID int64
	err = tx.QueryRow(ctx, `
		SELECT id FROM user_notification
		WHERE user_id=$1 AND kind=$2 AND conv_id=$3 AND read_at IS NULL AND created_at > $4
		ORDER BY id DESC LIMIT 1 FOR UPDATE`,
		n.UserID, n.Kind, n.ConvID, cutoff).Scan(&mergeID)
	if err == nil {
		// 命中窗口内行：count+1、digest 覆盖最新内容（"×N"由 count 列承载）
		if _, err = tx.Exec(ctx,
			`UPDATE user_notification SET count = count + 1, digest = $2 WHERE id = $1`,
			mergeID, n.Digest); err != nil {
			return Notification{}, false, err
		}
		row := tx.QueryRow(ctx, `SELECT `+notifCols+` FROM user_notification WHERE id=$1`, mergeID)
		merged, serr := scanNotif(row)
		if serr != nil {
			return Notification{}, false, serr
		}
		if err = tx.Commit(ctx); err != nil {
			return Notification{}, false, err
		}
		return *merged, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Notification{}, false, err
	}
	// 未命中：新行（同 InsertNotification 路径，事务内完成）
	if n.ID, err = bbcpg.AllocID(ctx, tx, lockKeyUserNotif, "user_notification"); err != nil {
		return Notification{}, false, err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO user_notification
			(id, tenant_id, user_id, kind, conv_id, msg_id, seq, title, digest, count, created_at, read_at)
		VALUES ($1, `+notifTenantExpr()+`, $3, $4, NULLIF($5::bigint,0), NULLIF($6::bigint,0), NULLIF($7::bigint,0),
			$8, $9, $10, $11, NULL)`,
		n.ID, n.ConvID, n.UserID, n.Kind, n.ConvID, n.MsgID, n.Seq,
		n.Title, n.Digest, n.Count, n.CreatedAt); err != nil {
		return Notification{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Notification{}, false, err
	}
	return n, false, nil
}

// ListNotifications 用户通知列表（id 倒序 + cursor 翻页；kind/unread 过滤）
func (p *Postgres) ListNotifications(ctx context.Context, f NotificationFilter) ([]Notification, error) {
	if f.Limit <= 0 || f.Limit > 100 {
		f.Limit = 20
	}
	q := `SELECT ` + notifCols + ` FROM user_notification WHERE user_id = $1`
	args := []any{f.UserID}
	if f.Kind != "" {
		args = append(args, f.Kind)
		q += ` AND kind = $` + strconv.Itoa(len(args))
	}
	if f.UnreadOnly {
		q += ` AND read_at IS NULL`
	}
	if f.Cursor > 0 {
		args = append(args, f.Cursor)
		q += ` AND id < $` + strconv.Itoa(len(args))
	}
	args = append(args, f.Limit)
	q += ` ORDER BY id DESC LIMIT $` + strconv.Itoa(len(args))

	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Notification{}
	for rows.Next() {
		n, err := scanNotif(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *n)
	}
	return out, rows.Err()
}

// MarkNotificationsRead 已读（all/ids 二选一；仅本人行；幂等跳过已读行；返回更新行数）
func (p *Postgres) MarkNotificationsRead(ctx context.Context, userID int64, ids []int64, all bool, readAt time.Time) (int64, error) {
	var tag pgconn.CommandTag
	var err error
	if all {
		tag, err = p.pool.Exec(ctx,
			`UPDATE user_notification SET read_at=$1 WHERE user_id=$2 AND read_at IS NULL`,
			readAt, userID)
	} else {
		if len(ids) == 0 {
			return 0, nil
		}
		tag, err = p.pool.Exec(ctx,
			`UPDATE user_notification SET read_at=$1 WHERE user_id=$2 AND read_at IS NULL AND id = ANY($3)`,
			readAt, userID, ids)
	}
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// CountUnreadNotifications 未读计数（红点数据源；99+ 封顶在端内）
func (p *Postgres) CountUnreadNotifications(ctx context.Context, userID int64) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM user_notification WHERE user_id=$1 AND read_at IS NULL`, userID).
		Scan(&n)
	return n, err
}

// ── 管理端统计（D10 仪表盘跨域闭包；可选接口见 repo.go StatsReader）──

var _ StatsReader = (*Postgres)(nil)

// CountActiveConvsSince 活跃会话数（status=active 且 last_msg_ts ≥ since；"会话数(今日)"口径）
func (p *Postgres) CountActiveConvsSince(ctx context.Context, tenantID int64, since time.Time) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM conversation WHERE tenant_id=$1 AND status=1 AND last_msg_ts >= $2`,
		tenantID, since).Scan(&n)
	return n, err
}

// CountMsgsSince 消息数（ts ≥ since，含已撤回/编辑——发送口径）
func (p *Postgres) CountMsgsSince(ctx context.Context, tenantID int64, since time.Time) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx,
		`SELECT count(*) FROM message WHERE tenant_id=$1 AND ts >= $2`,
		tenantID, since).Scan(&n)
	return n, err
}
