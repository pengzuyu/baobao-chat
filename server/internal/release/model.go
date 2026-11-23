// Package release 客户端安装包发布管理（D39）。
//
// 目标：管理员在桌面端管理后台上传产物并发布，服务端动态生成客户端更新清单
// （/update/latest.json）与官网下载数据（/update/release-info.json）；
// 制品存对象存储（RustFS 桶 bbc-releases），由接入层 nginx 直出（不经 Go 服务）。
//
// 与脚本链路（scripts/release/gen-manifest.mjs + publish.sh）的关系：
// 本模块是主路径；脚本链路保留为无服务端/离线应急路径，二者数据源不同
// （本模块用 DB，脚本用静态文件），同一时刻择一使用。
package release

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 状态机
const (
	StatusDraft     = "draft"     // 已上传未发布
	StatusPublished = "published" // 已发布（参与分发；线上版本=published_at 最新者）
	StatusRevoked   = "revoked"   // 已撤回（从 latest 与历史均移除；已安装用户不受影响）
)

// 通道（业界惯例：稳定/内测；D39 对齐 VS Code stable/insider）
const (
	ChannelStable = "stable"
	ChannelBeta   = "beta"
)

// Platform 平台规格（key 与 Tauri updater 清单一致）
type Platform struct {
	Key       string
	Label     string
	updaterRe *regexp.Regexp
}

// Platforms 支持的平台（顺序即展示顺序）
var Platforms = []Platform{
	{"darwin-aarch64", "macOS（Apple 芯片）", regexp.MustCompile(`\.app\.tar\.gz$`)},
	{"darwin-x86_64", "macOS（Intel 芯片）", regexp.MustCompile(`\.app\.tar\.gz$`)},
	{"linux-x86_64", "Linux（AppImage）", regexp.MustCompile(`\.AppImage$`)},
	{"windows-x86_64", "Windows（NSIS）", regexp.MustCompile(`-setup\.exe$`)},
}

// PlatformLabel 平台展示名
func PlatformLabel(key string) string {
	for _, p := range Platforms {
		if p.Key == key {
			return p.Label
		}
	}
	return key
}

// IsUpdaterFile 是否参与应用内自动更新（需 minisign 签名）
func IsUpdaterFile(filename string) bool {
	for _, p := range Platforms {
		if p.updaterRe.MatchString(filename) {
			return true
		}
	}
	return false
}

// Record 一条制品记录（client_release 行）
type Record struct {
	ID          int64     `json:"id"`
	Version     string    `json:"version"`
	Channel     string    `json:"channel"`
	Platform    string    `json:"platform"`
	Filename    string    `json:"filename"`
	Size        int64     `json:"size"`
	SHA256      string    `json:"sha256"`
	StorageKey  string    `json:"storage_key"`
	Signature   string    `json:"-"`
	HasSig      bool      `json:"has_signature"`
	Notes       string    `json:"notes"`
	Status      string    `json:"status"`
	PublishedAt time.Time `json:"published_at,omitzero"`
	CreatedAt   time.Time `json:"created_at"`
}

// Download 官网/清单下载项
type Download struct {
	Platform   string `json:"platform"`
	Label      string `json:"label"`
	File       string `json:"file"`
	URL        string `json:"url"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	AutoUpdate bool   `json:"autoUpdate"`
}

// ReleaseEntry 单个版本（官网历史列表项 / 清单 releases 数组元素）
type ReleaseEntry struct {
	Version   string     `json:"version"`
	Date      string     `json:"date"` // RFC3339
	Notes     string     `json:"notes"`
	Downloads []Download `json:"downloads"`
}

// LatestManifest Tauri updater 清单（/update/latest.json）
type LatestManifest struct {
	Version   string                   `json:"version"`
	Notes     string                   `json:"notes"`
	PubDate   string                   `json:"pub_date"`
	Platforms map[string]UpdatePayload `json:"platforms"`
}

// UpdatePayload updater 单平台载荷
type UpdatePayload struct {
	Signature string `json:"signature"`
	URL       string `json:"url"`
}

// ReleaseInfo 官网下载数据（/update/release-info.json）
type ReleaseInfo struct {
	Version   string         `json:"version"`
	Date      string         `json:"date"`
	Notes     string         `json:"notes"`
	Downloads []Download     `json:"downloads"`
	Releases  []ReleaseEntry `json:"releases"`
}

// compareSemver 语义化版本比较（返回 -1/0/1）；非法段按 0 处理
func compareSemver(a, b string) int {
	as := strings.Split(strings.TrimPrefix(a, "v"), ".")
	bs := strings.Split(strings.TrimPrefix(b, "v"), ".")
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var ai, bi int
		if i < len(as) {
			ai, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			bi, _ = strconv.Atoi(bs[i])
		}
		if ai != bi {
			if ai > bi {
				return 1
			}
			return -1
		}
	}
	return 0
}

// SortVersionsDesc 版本倒序（纯数字段比较，0.1.10 > 0.1.9）
func SortVersionsDesc(versions []string) {
	sort.Slice(versions, func(i, j int) bool { return compareSemver(versions[i], versions[j]) > 0 })
}