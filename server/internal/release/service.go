// service.go：清单生成与发布业务（Module 方法；路由见 api.go/update.go）。
package release

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Options 装配参数
type Options struct {
	// PublicBase 兜底对外地址（如 http://bbc.example.internal；空=完全按请求推导）
	PublicBase string
}

// Module 客户端发布模块
type Module struct {
	store     *Store
	opts      Options
	presigner Presigner // nil=未启用对象存储（上传接口报错提示）
	auditFn   auditHook // nil=不记审计
}

// NewModule 装配（presigner 可为 nil；audit 可为 nil）
func NewModule(db *pgxpool.Pool, opts Options, presigner Presigner, audit auditHook) *Module {
	return &Module{store: NewStore(db), opts: opts, presigner: presigner, auditFn: audit}
}

// Store 暴露存储层（api/update handler 用）
func (m *Module) Store() *Store { return m.store }

// baseURL 解析对外基址：优先请求推导（nginx 透传 Host），回落配置
func (m *Module) baseURL(scheme, host string) string {
	if host != "" {
		if scheme == "" {
			scheme = "http"
		}
		return scheme + "://" + host
	}
	return strings.TrimSuffix(m.opts.PublicBase, "/")
}

// fileURL 制品下载地址（nginx 直出：/update/releases/<storage_key>）
func fileURL(base, storageKey string) string {
	return base + "/update/releases/" + storageKey
}

// groupByVersion 记录按版本分组（输入已按 published_at DESC）
func groupByVersion(recs []Record) (order []string, groups map[string][]Record) {
	groups = make(map[string][]Record, 8)
	for _, r := range recs {
		if _, ok := groups[r.Version]; !ok {
			order = append(order, r.Version)
		}
		groups[r.Version] = append(groups[r.Version], r)
	}
	return order, groups
}

// buildDownloads 单版本下载项（跳过 .sig；autoUpdate=updater 文件且有签名）
func buildDownloads(base string, recs []Record) []Download {
	out := make([]Download, 0, len(recs))
	for _, r := range recs {
		out = append(out, Download{
			Platform:   r.Platform,
			Label:      PlatformLabel(r.Platform),
			File:       r.Filename,
			URL:        fileURL(base, r.StorageKey),
			Size:       r.Size,
			SHA256:     r.SHA256,
			AutoUpdate: IsUpdaterFile(r.Filename) && r.HasSig,
		})
	}
	return out
}

// Info 生成官网下载数据（/update/release-info.json）：线上版本 + 全历史
func (m *Module) Info(ctx context.Context, tenantID int64, channel, base string) (*ReleaseInfo, error) {
	recs, err := m.store.PublishedByChannel(ctx, tenantID, channel)
	if err != nil {
		return nil, err
	}
	order, groups := groupByVersion(recs) // order 首项 = published_at 最新的版本 = 线上
	SortVersionsDesc(order)

	entries := make([]ReleaseEntry, 0, len(order))
	for _, v := range order {
		rs := groups[v]
		// date/notes 取该版本最新一条（整版本发布时一致）
		date := rs[0].PublishedAt
		if date.IsZero() {
			date = rs[0].CreatedAt
		}
		entries = append(entries, ReleaseEntry{
			Version:   v,
			Date:      date.UTC().Format(time.RFC3339),
			Notes:     rs[0].Notes,
			Downloads: buildDownloads(base, rs),
		})
	}
	info := &ReleaseInfo{Releases: entries}
	if len(entries) > 0 {
		info.Version = entries[0].Version
		info.Date = entries[0].Date
		info.Notes = entries[0].Notes
		info.Downloads = entries[0].Downloads
	}
	return info, nil
}

// LatestManifest 生成 Tauri updater 清单（/update/latest.json）：
// 仅含线上版本，且每平台必须有签名（无签名的包不可用于应用内更新）。
// 无任何可用平台时返回 version="" 的清单（客户端视为无更新）。
func (m *Module) LatestManifest(ctx context.Context, tenantID int64, channel, base string) (*LatestManifest, error) {
	recs, err := m.store.PublishedByChannel(ctx, tenantID, channel)
	if err != nil {
		return nil, err
	}
	if len(recs) == 0 {
		return &LatestManifest{Platforms: map[string]UpdatePayload{}}, nil
	}
	// 线上版本 = published_at 最新记录所属版本
	live := recs[0].Version
	plats := make(map[string]UpdatePayload, 4)
	var notes string
	var pubDate time.Time
	for _, r := range recs {
		if r.Version != live {
			continue
		}
		if notes == "" {
			notes = r.Notes
		}
		if r.PublishedAt.After(pubDate) {
			pubDate = r.PublishedAt
		}
		if !IsUpdaterFile(r.Filename) || !r.HasSig {
			continue // 官网直链包或无签名的包不进 updater 清单
		}
		plats[r.Platform] = UpdatePayload{
			Signature: r.Signature,
			URL:       fileURL(base, r.StorageKey),
		}
	}
	return &LatestManifest{
		Version:   live,
		Notes:     notes,
		PubDate:   pubDate.UTC().Format(time.RFC3339),
		Platforms: plats,
	}, nil
}

// RegisterInput 登记制品入参
type RegisterInput struct {
	Version    string `json:"version"`
	Channel    string `json:"channel"`
	Platform   string `json:"platform"`
	Filename   string `json:"filename"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	StorageKey string `json:"storage_key"`
	Signature  string `json:"signature"`
	Notes      string `json:"notes"`
}

// Validate 入参校验
func (in *RegisterInput) Validate() error {
	if in.Version == "" || in.Filename == "" || in.StorageKey == "" || in.Platform == "" {
		return fmt.Errorf("version/filename/platform/storage_key 必填")
	}
	if in.Channel == "" {
		in.Channel = ChannelStable
	}
	if in.Channel != ChannelStable && in.Channel != ChannelBeta {
		return fmt.Errorf("channel 仅支持 stable/beta")
	}
	valid := false
	for _, p := range Platforms {
		if p.Key == in.Platform {
			valid = true
			break
		}
	}
	if !valid {
		return fmt.Errorf("platform 不支持：%s", in.Platform)
	}
	if IsUpdaterFile(in.Filename) && in.Signature == "" {
		return fmt.Errorf("自动更新包必须有 minisign 签名（.sig 内容）")
	}
	return nil
}

// StorageKeyFor 制品存储键（版本/平台/文件名；与 nginx /update/releases/ 路径一一对应）
func StorageKeyFor(version, platform, filename string) string {
	return fmt.Sprintf("v%s/%s/%s", version, platform, filename)
}