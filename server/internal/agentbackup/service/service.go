// Package agentbackupservice Agent 会话云端备份服务（08 篇 §5.2/§6.3；OQ-B09 端侧加密）。
// 零知识边界：事件密文原样过手（base64→盘），密钥 envelope 随行存储供跨设备取回，
// 服务端不持有任何可解密材料。密文 v0.1 落本地盘 DATA_DIR/agent-backup/
// {tenant}/{user}/{id}.bin（对象存储/预签名随 file 域对象化阶段二切换，迁移 0025 注记）。
package agentbackupservice

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	agentbackupapi "github.com/baobaowork/server/internal/agentbackup/api"
	agentbackuprepo "github.com/baobaowork/server/internal/agentbackup/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// maxBackupBytes 单备份密文上限（事件 JSONL 会话级 MB 级；32MB 防滥用）
const maxBackupBytes = 32 << 20

// ticketTTL 恢复票据有效期（07 篇 §4.3 ①同款 120s）
const ticketTTL = 120 * time.Second

// Options 服务配置
type Options struct {
	// DataDir BBW_DATA_DIR（密文落盘根；空=当前目录，测试可指 t.TempDir）
	DataDir string
	// Now 时钟注入（测试）
	Now func() time.Time
}

func (o *Options) fillDefaults() {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.DataDir == "" {
		o.DataDir = os.Getenv("BBW_DATA_DIR")
	}
	if o.DataDir == "" {
		o.DataDir = "."
	}
}

// ticketEntry 一次性票据（内存态；file 域同款取舍，阶段二 Redis TTL）
type ticketEntry struct {
	row       agentbackuprepo.Row
	expiresAt time.Time
}

// Service 备份服务
type Service struct {
	repo    agentbackuprepo.Repo
	opts    Options
	mu      sync.Mutex
	tickets map[string]ticketEntry
}

// New 构造
func New(opts Options, r agentbackuprepo.Repo) *Service {
	opts.fillDefaults()
	return &Service{repo: r, opts: opts, tickets: map[string]ticketEntry{}}
}

// blobPath 密文路径（DATA_DIR/agent-backup/{tenant}/{user}/{id}.bin）
func (s *Service) blobPath(tenantID, userID, id int64) string {
	return filepath.Join(s.opts.DataDir, "agent-backup",
		strconv.FormatInt(tenantID, 10), strconv.FormatInt(userID, 10),
		fmt.Sprintf("%d.bin", id))
}

// Create 创建备份（幂等命中返回既有行）
func (s *Service) Create(ctx context.Context, tenantID, userID int64, p agentbackupapi.CreatePayload, idempotencyKey string) (*agentbackupapi.BackupDTO, error) {
	if p.LocalSessionID == "" || p.EncAlg == "" || p.KeyEnvelope == "" {
		return nil, errx.New(errx.CodeBadRequest, "local_session_id/enc_alg/key_envelope 必填")
	}
	if len(p.Data) == 0 || int64(len(p.Data)) > maxBackupBytes {
		return nil, errx.New(errx.CodeBadRequest, "密文体为空或超过 32MB 上限")
	}
	// 幂等：同 Idempotency-Key 直接返回既有行（08 篇 §6.3）
	if idempotencyKey != "" {
		if ex, err := s.repo.GetByIdempotency(ctx, userID, idempotencyKey); err == nil && ex != nil {
			dto := toDTO(*ex)
			return &dto, nil
		}
	}
	row, err := s.repo.Insert(ctx, agentbackuprepo.Row{
		TenantID: tenantID, UserID: userID,
		LocalSessionID: p.LocalSessionID, Title: p.Title,
		EncAlg: p.EncAlg, KeyEnvelope: p.KeyEnvelope,
		Size: int64(len(p.Data)), IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		if err == agentbackuprepo.ErrDuplicateIdem {
			// 并发竞态兜底：重查返回既有行
			if ex, qerr := s.repo.GetByIdempotency(ctx, userID, idempotencyKey); qerr == nil && ex != nil {
				dto := toDTO(*ex)
				return &dto, nil
			}
		}
		return nil, errx.From(err)
	}
	// 密文落盘（先写临时文件再原子改名，避免半写行）
	path := s.blobPath(tenantID, userID, row.ID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		_ = s.repo.Delete(ctx, row.ID) // 回滚索引行（盘失败不留孤儿行）
		return nil, errx.New(errx.CodeInternal, "备份落盘失败")
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, p.Data, 0o600); err != nil {
		_ = s.repo.Delete(ctx, row.ID)
		return nil, errx.New(errx.CodeInternal, "备份落盘失败")
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		_ = s.repo.Delete(ctx, row.ID)
		return nil, errx.New(errx.CodeInternal, "备份落盘失败")
	}
	dto := toDTO(row)
	return &dto, nil
}

// List 我的备份
func (s *Service) List(ctx context.Context, tenantID, userID int64) ([]agentbackupapi.BackupDTO, error) {
	rows, err := s.repo.ListByUser(ctx, tenantID, userID)
	if err != nil {
		return nil, errx.From(err)
	}
	out := make([]agentbackupapi.BackupDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, toDTO(r))
	}
	return out, nil
}

// IssueRestoreTicket 恢复下载凭证（120s 一次性）
func (s *Service) IssueRestoreTicket(ctx context.Context, tenantID, userID, id int64) (*agentbackupapi.TicketDTO, error) {
	row, err := s.repo.Get(ctx, id)
	if err != nil || row.TenantID != tenantID || row.UserID != userID {
		return nil, errx.New(errx.CodeNotFound, "备份不存在")
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, errx.New(errx.CodeInternal, "票据生成失败")
	}
	ticket := hex.EncodeToString(raw)
	s.mu.Lock()
	// 过期票据顺带清扫（低成本惰性回收）
	now := s.opts.Now()
	for k, t := range s.tickets {
		if now.After(t.expiresAt) {
			delete(s.tickets, k)
		}
	}
	s.tickets[ticket] = ticketEntry{row: *row, expiresAt: now.Add(ticketTTL)}
	s.mu.Unlock()
	return &agentbackupapi.TicketDTO{
		Ticket:    ticket,
		URL:       "/api/v1/agent/sessions/backups/blob/" + ticket,
		ExpiresIn: int(ticketTTL.Seconds()),
	}, nil
}

// ReadTicket 消费票据取密文（一次性）
func (s *Service) ReadTicket(_ context.Context, ticket string) (*agentbackupapi.BlobResult, error) {
	if ticket == "" {
		return nil, errx.New(errx.CodeBadRequest, "票据必填")
	}
	s.mu.Lock()
	entry, ok := s.tickets[ticket]
	if ok {
		delete(s.tickets, ticket) // 一次性：取出即焚
	}
	s.mu.Unlock()
	if !ok || s.opts.Now().After(entry.expiresAt) {
		return nil, errx.New(errx.CodeNotFound, "票据无效或已过期")
	}
	data, err := os.ReadFile(s.blobPath(entry.row.TenantID, entry.row.UserID, entry.row.ID))
	if err != nil {
		return nil, errx.New(errx.CodeNotFound, "备份密文缺失")
	}
	dto := toDTO(entry.row)
	return &agentbackupapi.BlobResult{Row: dto, Data: data, ConsumedAt: s.opts.Now()}, nil
}

// Delete 删除备份（索引 + 盘上密文）
func (s *Service) Delete(ctx context.Context, tenantID, userID, id int64) error {
	row, err := s.repo.Get(ctx, id)
	if err != nil || row.TenantID != tenantID || row.UserID != userID {
		return errx.New(errx.CodeNotFound, "备份不存在")
	}
	if err := s.repo.Delete(ctx, id); err != nil {
		return errx.From(err)
	}
	_ = os.Remove(s.blobPath(tenantID, userID, id)) // 密文缺失不阻断（幂等）
	return nil
}

func toDTO(r agentbackuprepo.Row) agentbackupapi.BackupDTO {
	return agentbackupapi.BackupDTO{
		ID:             strconv.FormatInt(r.ID, 10),
		LocalSessionID: r.LocalSessionID,
		Title:          r.Title,
		EncAlg:         r.EncAlg,
		KeyEnvelope:    r.KeyEnvelope,
		Size:           r.Size,
		CreatedAt:      r.CreatedAt.UnixMilli(),
	}
}
