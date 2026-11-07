// adminrepo 内存实现（阶段一无 PG 依赖跑通全链路；并发安全单锁足够）
package adminrepo

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Memory 内存实现
type Memory struct {
	mu       sync.Mutex
	audit    []AuditAction           // 追加序=id 升序（ListAudit 反向遍历）
	words    map[int64]SensitiveWord // wordID → 行
	wordIdx  map[string]int64        // tenantID|word → id（UK(tenant,word) 兜底）
	nextID   int64                   // 审计行 ID 自增
	wordNext int64                   // 敏感词 ID 自增
}

// NewMemory 构造
func NewMemory() *Memory {
	return &Memory{words: map[int64]SensitiveWord{}, wordIdx: map[string]int64{}}
}

var _ Repo = (*Memory)(nil)

func wordKey(tenantID int64, word string) string {
	return strconv.FormatInt(tenantID, 10) + "|" + word
}

// InsertAudit 追加（ID 自增，雪花占位；CreatedAt 零值取当前时刻）
func (m *Memory) InsertAudit(_ context.Context, a AuditAction) (AuditAction, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	a.ID = m.nextID
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now()
	}
	m.audit = append(m.audit, a)
	return a, nil
}

// ListAudit id 倒序时间线 + cursor 翻页
func (m *Memory) ListAudit(_ context.Context, tenantID int64, cursor int64, limit int) ([]AuditAction, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	limit = limitOrDefault(limit)
	out := make([]AuditAction, 0, limit)
	hasMore := false
	for i := len(m.audit) - 1; i >= 0; i-- {
		a := m.audit[i]
		if a.TenantID != tenantID {
			continue
		}
		if cursor > 0 && a.ID >= cursor {
			continue
		}
		if len(out) >= limit {
			hasMore = true
			break
		}
		out = append(out, a)
	}
	return out, hasMore, nil
}

// InsertSensitiveWord UK(tenant,word) 冲突返回 ErrDupWord
func (m *Memory) InsertSensitiveWord(_ context.Context, w SensitiveWord) (SensitiveWord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := wordKey(w.TenantID, w.Word)
	if _, dup := m.wordIdx[key]; dup {
		return SensitiveWord{}, ErrDupWord
	}
	m.wordNext++
	w.ID = m.wordNext
	if w.CreatedAt.IsZero() {
		w.CreatedAt = time.Now()
	}
	m.words[w.ID] = w
	m.wordIdx[key] = w.ID
	return w, nil
}

// DeleteSensitiveWord 删除（连带 UK 索引）
func (m *Memory) DeleteSensitiveWord(_ context.Context, tenantID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, ok := m.words[id]
	if !ok || w.TenantID != tenantID {
		return ErrWordNotFound
	}
	delete(m.words, id)
	delete(m.wordIdx, wordKey(w.TenantID, w.Word))
	return nil
}

// ListSensitiveWords id 倒序 + cursor 翻页（新词在前）
func (m *Memory) ListSensitiveWords(_ context.Context, tenantID int64, cursor int64, limit int) ([]SensitiveWord, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]int64, 0, len(m.words))
	for id, w := range m.words {
		if w.TenantID == tenantID {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
	limit = limitOrDefault(limit)
	out := make([]SensitiveWord, 0, limit)
	hasMore := false
	for _, id := range ids {
		if cursor > 0 && id >= cursor {
			continue
		}
		if len(out) >= limit {
			hasMore = true
			break
		}
		out = append(out, m.words[id])
	}
	return out, hasMore, nil
}

// CountSensitiveWords 全量计数
func (m *Memory) CountSensitiveWords(_ context.Context, tenantID int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, w := range m.words {
		if w.TenantID == tenantID {
			n++
		}
	}
	return n, nil
}

// EnabledSensitiveWords mode=1 且启用的词（内存直读，无缓存必要）
func (m *Memory) EnabledSensitiveWords(_ context.Context, tenantID int64) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.words))
	for _, w := range m.words {
		if w.TenantID == tenantID && w.Enabled && w.Mode == 1 {
			out = append(out, w.Word)
		}
	}
	return out, nil
}

func limitOrDefault(limit int) int {
	if limit <= 0 || limit > 100 {
		return 20
	}
	return limit
}
