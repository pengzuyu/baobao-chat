// 技能仓储双实现（0034 / E4）。
package ecorepo

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

// ── memory ──

// SkillMemory 技能内存仓
type SkillMemory struct {
	mu     sync.Mutex
	skills map[int64]*Skill
	insts  map[int64]*SkillInstall
	seq    int64
}

var _ SkillRepo = (*SkillMemory)(nil)

// NewSkillMemory 构造
func NewSkillMemory() *SkillMemory {
	return &SkillMemory{skills: map[int64]*Skill{}, insts: map[int64]*SkillInstall{}}
}

// InsertSkill 建（UK 冲突→ErrSkillDup）
func (m *SkillMemory) InsertSkill(_ context.Context, s Skill) (Skill, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.skills {
		if ex.TenantID == s.TenantID && ex.SkillID == s.SkillID {
			return Skill{}, ErrSkillDup
		}
	}
	m.seq++
	s.ID = m.seq
	now := time.Now()
	s.CreatedAt, s.UpdatedAt = now, now
	m.skills[s.ID] = &s
	return s, nil
}

// GetSkill 查
func (m *SkillMemory) GetSkill(_ context.Context, tenantID, id int64) (*Skill, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.skills[id]; ok && s.TenantID == tenantID {
		cp := *s
		return &cp, nil
	}
	return nil, ErrSkillNotFound
}

// ListSkills 全量
func (m *SkillMemory) ListSkills(_ context.Context, tenantID int64) ([]Skill, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Skill{}
	for _, s := range m.skills {
		if s.TenantID == tenantID {
			out = append(out, *s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// ListPublishedSkills published
func (m *SkillMemory) ListPublishedSkills(_ context.Context, tenantID int64) ([]Skill, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Skill{}
	for _, s := range m.skills {
		if s.TenantID == tenantID && s.Status == "published" {
			out = append(out, *s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// UpdateSkill 更新（覆盖式：manifest/version/policy/描述）
func (m *SkillMemory) UpdateSkill(_ context.Context, tenantID, id int64, name, description, manifest, version string, policy int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.skills[id]
	if !ok || s.TenantID != tenantID {
		return ErrSkillNotFound
	}
	if name != "" {
		s.Name = name
	}
	if description != "" {
		s.Description = description
	}
	if manifest != "" {
		s.Manifest = manifest
	}
	if version != "" {
		s.CurrentVersion = version
	}
	if policy >= 1 && policy <= 3 {
		s.Policy = policy
	}
	s.UpdatedAt = time.Now()
	return nil
}

// SetSkillStatus 状态
func (m *SkillMemory) SetSkillStatus(_ context.Context, tenantID, id int64, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.skills[id]
	if !ok || s.TenantID != tenantID {
		return ErrSkillNotFound
	}
	s.Status = status
	s.UpdatedAt = time.Now()
	return nil
}

// UpsertSkillInstall 安装/升级
func (m *SkillMemory) UpsertSkillInstall(_ context.Context, i SkillInstall) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, ex := range m.insts {
		if ex.TenantID == i.TenantID && ex.SkillRowID == i.SkillRowID && ex.UserID == i.UserID {
			ex.Version, ex.InstalledAt = i.Version, time.Now()
			_ = id
			return nil
		}
	}
	m.seq++
	i.ID = m.seq
	i.InstalledAt = time.Now()
	m.insts[i.ID] = &i
	return nil
}

// ListSkillInstallsByUser 用户安装集
func (m *SkillMemory) ListSkillInstallsByUser(_ context.Context, tenantID, userID int64) ([]SkillInstall, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []SkillInstall{}
	for _, i := range m.insts {
		if i.TenantID == tenantID && i.UserID == userID {
			out = append(out, *i)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].InstalledAt.After(out[j].InstalledAt) })
	return out, nil
}

// DeleteSkillInstall 卸载（幂等）
func (m *SkillMemory) DeleteSkillInstall(_ context.Context, tenantID, skillRowID, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, ex := range m.insts {
		if ex.TenantID == tenantID && ex.SkillRowID == skillRowID && ex.UserID == userID {
			delete(m.insts, id)
			return nil
		}
	}
	return nil
}

// ── PG（lock 9137）──

// SkillPostgres 技能 PG 仓储
type SkillPostgres struct{ pool *pgxpool.Pool }

var _ SkillRepo = (*SkillPostgres)(nil)

// NewPostgresSkills 构造
func NewPostgresSkills(pool *pgxpool.Pool) SkillRepo { return &SkillPostgres{pool: pool} }

const lockKeyEcoSkill int64 = 9137

const skillCols = `id, tenant_id, skill_id, name, COALESCE(description,''), policy, status,
	COALESCE(current_version,''), manifest, created_by, created_at, updated_at`

func scanSkill(row pgx.Row) (*Skill, error) {
	var s Skill
	if err := row.Scan(&s.ID, &s.TenantID, &s.SkillID, &s.Name, &s.Description, &s.Policy, &s.Status,
		&s.CurrentVersion, &s.Manifest, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrSkillNotFound
		}
		return nil, err
	}
	return &s, nil
}

// InsertSkill 建
func (p *SkillPostgres) InsertSkill(ctx context.Context, s Skill) (Skill, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Skill{}, err
	}
	defer tx.Rollback(ctx)
	if s.ID == 0 {
		if s.ID, err = bbcpg.AllocID(ctx, tx, lockKeyEcoSkill, "eco_skill"); err != nil {
			return Skill{}, err
		}
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO eco_skill (id, tenant_id, skill_id, name, description, policy, status, current_version, manifest, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9)
		RETURNING created_at, updated_at`,
		s.ID, s.TenantID, s.SkillID, s.Name, s.Description, s.Policy, s.CurrentVersion, s.Manifest, s.CreatedBy).
		Scan(&s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		if isAppDup(err) {
			return Skill{}, ErrSkillDup
		}
		return Skill{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Skill{}, err
	}
	return s, nil
}

// GetSkill 查
func (p *SkillPostgres) GetSkill(ctx context.Context, tenantID, id int64) (*Skill, error) {
	return scanSkill(p.pool.QueryRow(ctx, `SELECT `+skillCols+` FROM eco_skill WHERE tenant_id=$1 AND id=$2`, tenantID, id))
}

func scanSkills(rows pgx.Rows) ([]Skill, error) {
	defer rows.Close()
	out := []Skill{}
	for rows.Next() {
		var s Skill
		if err := rows.Scan(&s.ID, &s.TenantID, &s.SkillID, &s.Name, &s.Description, &s.Policy, &s.Status,
			&s.CurrentVersion, &s.Manifest, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ListSkills 全量
func (p *SkillPostgres) ListSkills(ctx context.Context, tenantID int64) ([]Skill, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+skillCols+` FROM eco_skill WHERE tenant_id=$1 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	return scanSkills(rows)
}

// ListPublishedSkills published
func (p *SkillPostgres) ListPublishedSkills(ctx context.Context, tenantID int64) ([]Skill, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+skillCols+` FROM eco_skill
		WHERE tenant_id=$1 AND status='published' ORDER BY name`, tenantID)
	if err != nil {
		return nil, err
	}
	return scanSkills(rows)
}

// UpdateSkill 更新
func (p *SkillPostgres) UpdateSkill(ctx context.Context, tenantID, id int64, name, description, manifest, version string, policy int) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE eco_skill SET
			name=COALESCE(NULLIF($3,''), name),
			description=COALESCE(NULLIF($4,''), description),
			manifest=COALESCE(NULLIF($5,''), manifest),
			current_version=COALESCE(NULLIF($6,''), current_version),
			policy=CASE WHEN $7 BETWEEN 1 AND 3 THEN $7 ELSE policy END,
			updated_at=now()
		WHERE tenant_id=$1 AND id=$2`, tenantID, id, name, description, manifest, version, policy)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSkillNotFound
	}
	return nil
}

// SetSkillStatus 状态
func (p *SkillPostgres) SetSkillStatus(ctx context.Context, tenantID, id int64, status string) error {
	tag, err := p.pool.Exec(ctx, `UPDATE eco_skill SET status=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`, tenantID, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSkillNotFound
	}
	return nil
}

// UpsertSkillInstall 安装
func (p *SkillPostgres) UpsertSkillInstall(ctx context.Context, i SkillInstall) error {
	var id int64
	if err := p.pool.QueryRow(ctx, `SELECT COALESCE(max(id),0)+1 FROM eco_skill_install`).Scan(&id); err != nil {
		return err
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO eco_skill_install (id, tenant_id, skill_row_id, user_id, version)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (tenant_id, skill_row_id, user_id) DO UPDATE
			SET version=$5, installed_at=now()`,
		id, i.TenantID, i.SkillRowID, i.UserID, i.Version)
	return err
}

// ListSkillInstallsByUser 用户安装集
func (p *SkillPostgres) ListSkillInstallsByUser(ctx context.Context, tenantID, userID int64) ([]SkillInstall, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, skill_row_id, user_id, version, installed_at
		FROM eco_skill_install WHERE tenant_id=$1 AND user_id=$2 ORDER BY installed_at DESC`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SkillInstall{}
	for rows.Next() {
		var i SkillInstall
		if err := rows.Scan(&i.ID, &i.TenantID, &i.SkillRowID, &i.UserID, &i.Version, &i.InstalledAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// DeleteSkillInstall 卸载
func (p *SkillPostgres) DeleteSkillInstall(ctx context.Context, tenantID, skillRowID, userID int64) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM eco_skill_install WHERE tenant_id=$1 AND skill_row_id=$2 AND user_id=$3`,
		tenantID, skillRowID, userID)
	return err
}
