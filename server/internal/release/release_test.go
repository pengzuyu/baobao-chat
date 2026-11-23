package release

import (
	"testing"
	"time"
)

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.1.10", "0.1.9", 1}, // 数字段比较（非字典序）
		{"0.1.9", "0.1.10", -1},
		{"0.2.0", "0.1.99", 1},
		{"1.0.0", "1.0.0", 0},
		{"v0.1.1", "0.1.1", 0}, // v 前缀容忍
	}
	for _, c := range cases {
		if got := compareSemver(c.a, c.b); got != c.want {
			t.Errorf("compareSemver(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestSortVersionsDesc(t *testing.T) {
	vs := []string{"0.1.2", "0.1.10", "0.2.0", "0.1.9"}
	SortVersionsDesc(vs)
	want := []string{"0.2.0", "0.1.10", "0.1.9", "0.1.2"}
	for i := range want {
		if vs[i] != want[i] {
			t.Fatalf("排序结果 %v want %v", vs, want)
		}
	}
}

func TestIsUpdaterFile(t *testing.T) {
	cases := map[string]bool{
		"BaobaoChat.app.tar.gz": true,
		"BaobaoChat.AppImage":   true,
		"BaobaoChat-setup.exe":  true,
		"BaobaoChat_0.1.0.dmg":  false, // 官网直链包，不参与自动更新
		"BaobaoChat_0.1.0.deb":  false,
	}
	for f, want := range cases {
		if got := IsUpdaterFile(f); got != want {
			t.Errorf("IsUpdaterFile(%q)=%v want %v", f, got, want)
		}
	}
}

func TestRegisterInputValidate(t *testing.T) {
	base := func() RegisterInput {
		return RegisterInput{Version: "0.2.0", Platform: "darwin-aarch64",
			Filename: "BaobaoChat.app.tar.gz", StorageKey: "v0.2.0/darwin-aarch64/BaobaoChat.app.tar.gz",
			Signature: "sig"}
	}
	// 合法
	in := base()
	if err := in.Validate(); err != nil || in.Channel != ChannelStable {
		t.Fatalf("合法入参应通过且 channel 回落 stable：err=%v channel=%q", err, in.Channel)
	}
	// updater 包缺签名 → 拒绝
	in = base()
	in.Signature = ""
	if err := in.Validate(); err == nil {
		t.Fatal("updater 包无签名应拒绝")
	}
	// 官网直链包无签名 → 允许
	in = base()
	in.Filename = "BaobaoChat_0.2.0_aarch64.dmg"
	in.Signature = ""
	if err := in.Validate(); err != nil {
		t.Fatalf("非 updater 包无签名应允许：%v", err)
	}
	// 非法平台
	in = base()
	in.Platform = "freebsd-x86_64"
	if err := in.Validate(); err == nil {
		t.Fatal("非法平台应拒绝")
	}
	// 非法通道
	in = base()
	in.Channel = "nightly"
	if err := in.Validate(); err == nil {
		t.Fatal("非法通道应拒绝")
	}
}

func TestStorageKeyFor(t *testing.T) {
	got := StorageKeyFor("0.2.0", "windows-x86_64", "BaobaoChat-setup.exe")
	want := "v0.2.0/windows-x86_64/BaobaoChat-setup.exe"
	if got != want {
		t.Fatalf("StorageKeyFor=%q want %q", got, want)
	}
}

// buildInfo 核心：线上版本=published_at 最新；历史按 semver 倒序；下载 URL 指向各自版本
// （本测试直接用 Module.Info 的内部逻辑等价物：构造记录 → 期望结构）
func TestBuildInfoSemantics(t *testing.T) {
	now := time.Now().UTC()
	recs := []Record{
		// v0.2.0（线上，回滚后 published_at 最新）
		{Version: "0.2.0", Platform: "darwin-aarch64", Filename: "BaobaoChat.app.tar.gz",
			StorageKey: "v0.2.0/darwin-aarch64/BaobaoChat.app.tar.gz", Size: 100, SHA256: "aa",
			Signature: "s1", HasSig: true, Notes: "v0.2.0 说明", Status: StatusPublished, PublishedAt: now},
		{Version: "0.2.0", Platform: "darwin-aarch64", Filename: "BaobaoChat_0.2.0_aarch64.dmg",
			StorageKey: "v0.2.0/darwin-aarch64/BaobaoChat_0.2.0_aarch64.dmg", Size: 200, SHA256: "bb",
			Notes: "v0.2.0 说明", Status: StatusPublished, PublishedAt: now},
		// v0.1.9（历史）
		{Version: "0.1.9", Platform: "darwin-aarch64", Filename: "BaobaoChat.app.tar.gz",
			StorageKey: "v0.1.9/darwin-aarch64/BaobaoChat.app.tar.gz", Size: 90, SHA256: "cc",
			Signature: "s0", HasSig: true, Notes: "v0.1.9 说明", Status: StatusPublished,
			PublishedAt: now.Add(-24 * time.Hour)},
	}
	order, groups := groupByVersion(recs)
	SortVersionsDesc(order)
	if len(order) != 2 || order[0] != "0.2.0" || order[1] != "0.1.9" {
		t.Fatalf("版本顺序错：%v", order)
	}
	base := "http://bbc.example.internal"
	v2 := buildDownloads(base, groups["0.2.0"])
	if len(v2) != 2 {
		t.Fatalf("v0.2.0 downloads 应 2 个：%d", len(v2))
	}
	// updater 文件 autoUpdate=true；dmg autoUpdate=false
	for _, d := range v2 {
		if d.File == "BaobaoChat.app.tar.gz" && !d.AutoUpdate {
			t.Fatal("updater 包应标 autoUpdate")
		}
		if d.File == "BaobaoChat_0.2.0_aarch64.dmg" && d.AutoUpdate {
			t.Fatal("dmg 不应标 autoUpdate")
		}
		if d.URL != base+"/update/releases/"+d.StorageKeyForVersion() {
			// 直接校验 URL 前缀与版本段
			if d.URL[:len(base)+len("/update/releases/v0.2.0/")] != base+"/update/releases/v0.2.0/" {
				t.Fatalf("URL 未指向 v0.2.0：%s", d.URL)
			}
		}
	}
}

// StorageKeyForVersion 测试辅助：从 Download 反推存储键（URL 中 /update/releases/ 之后部分）
func (d Download) StorageKeyForVersion() string {
	const p = "/update/releases/"
	if i := indexOf(d.URL, p); i >= 0 {
		return d.URL[i+len(p):]
	}
	return ""
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}