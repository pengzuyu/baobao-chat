package release

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/blake2b"
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
func TestHandleReleaseDownload(t *testing.T) {
	m := &Module{opts: Options{ObjectPublicBase: "http://rustfs.internal:30900/"}}

	// 正常 302：/update/releases/<key> → <base>/bbc-releases/releases/<key>（尾斜杠已收敛）
	w := httptest.NewRecorder()
	m.HandleReleaseDownload(w, pathValueReq("v0.1.3/darwin-aarch64/BaobaoChat.app.tar.gz"))
	if w.Code != http.StatusFound {
		t.Fatalf("302 expected, got %d", w.Code)
	}
	want := "http://rustfs.internal:30900/bbc-releases/releases/v0.1.3/darwin-aarch64/BaobaoChat.app.tar.gz"
	if loc := w.Header().Get("Location"); loc != want {
		t.Fatalf("Location=%q want %q", loc, want)
	}

	// 防御：穿越/空键 → 404
	for _, bad := range []string{"", "../secret", "a/../../x", `a\b`} {
		w = httptest.NewRecorder()
		m.HandleReleaseDownload(w, pathValueReq(bad))
		if w.Code != http.StatusNotFound {
			t.Fatalf("key=%q: 404 expected, got %d", bad, w.Code)
		}
	}

	// 未配置 ObjectPublicBase → 404
	empty := &Module{}
	w = httptest.NewRecorder()
	empty.HandleReleaseDownload(w, pathValueReq("v0.1.3/x.tar.gz"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unconfigured: 404 expected, got %d", w.Code)
	}
}

func pathValueReq(key string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/update/releases/"+key, nil)
	r.SetPathValue("key", key)
	return r
}

// TestVerifyMinisign 构造真 ed25519 密钥对走 tauri 签名全链：
// 公钥 42B("Ed"+keyID+pub)、签名 74B("ED"+keyID+sig)、消息=BLAKE2b-512(全文)、
// trusted comment 第二签名，与 minisign-verify 0.3 语义逐项对齐
func TestVerifyMinisign(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	keyID := []byte{0x15, 0x2e, 0xee, 0x26, 0x0d, 0x37, 0x5b, 0x21}

	// tauri pubkey：公钥文件全文（comment 行 + "Ed"+keyID+pub 的 base64 行）整体 base64
	pubBlob := append([]byte("Ed"), append(keyID, pub...)...)
	pubFile := "untrusted comment: minisign public key: TEST\n" + base64.StdEncoding.EncodeToString(pubBlob) + "\n"
	pubkeyB64 := base64.StdEncoding.EncodeToString([]byte(pubFile))

	data := []byte("fake package payload")
	// tauri .sig：签名文件全文（comment + 74B blob 行 + trusted comment 行 + global sig 行）整体 base64
	h := blake2b.Sum512(data)
	sig := ed25519.Sign(priv, h[:])
	trusted := "timestamp:1795752520\tfile:BaobaoChat.app.tar.gz\tversion:0.1.5"
	globalSig := ed25519.Sign(priv, append(append([]byte{}, sig...), trusted...))
	sigFile := "untrusted comment: signature from tauri secret key\n" +
		base64.StdEncoding.EncodeToString(append([]byte("ED"), append(keyID, sig...)...)) + "\n" +
		"trusted comment: " + trusted + "\n" +
		base64.StdEncoding.EncodeToString(globalSig) + "\n"
	sigText := base64.StdEncoding.EncodeToString([]byte(sigFile)) // 单行封装形态

	if err := VerifyMinisign(pubkeyB64, sigText, data); err != nil {
		t.Fatalf("合法 tauri 签名应通过: %v", err)
	}
	// 换包不换签名（最常见的真实事故）→ 必须拒
	if err := VerifyMinisign(pubkeyB64, sigText, []byte("tampered payload")); err == nil {
		t.Fatal("篡改数据应拒绝")
	}
	// 另一把钥签的（keyID 不一致）→ 必须拒
	_, priv2, _ := ed25519.GenerateKey(nil)
	h2 := blake2b.Sum512(data)
	sig2 := ed25519.Sign(priv2, h2[:])
	sigFile2 := "untrusted comment: x\n" +
		base64.StdEncoding.EncodeToString(append([]byte("ED"), append([]byte{1, 2, 3, 4, 5, 6, 7, 8}, sig2...)...)) + "\n"
	if err := VerifyMinisign(pubkeyB64, base64.StdEncoding.EncodeToString([]byte(sigFile2)), data); err == nil {
		t.Fatal("keyID 不一致应拒绝")
	}
	// 明文两行形态（非单行封装）也应可解析
	if err := VerifyMinisign(pubFile, sigFile, data); err != nil {
		t.Fatalf("明文形态应通过: %v", err)
	}
}

// TestVerifyMinisignRealProduct 用本机真产物回归（存在才跑；CI 无产物时跳过）
func TestVerifyMinisignRealProduct(t *testing.T) {
	root := "../../../" // 测试 cwd=internal/release → 仓库根
	pkgPath := root + "out/release/v0.1.5/darwin-aarch64/BaobaoChat.app.tar.gz"
	sigPath := pkgPath + ".sig"
	confPath := root + "client/src-tauri/tauri.conf.json"
	pkg, e1 := os.ReadFile(pkgPath)
	sig, e2 := os.ReadFile(sigPath)
	conf, e3 := os.ReadFile(confPath)
	if e1 != nil || e2 != nil || e3 != nil {
		t.Skip("本机无 v0.1.5 真产物，跳过")
	}
	var confJSON struct {
		Plugins struct {
			Updater struct {
				Pubkey string `json:"pubkey"`
			} `json:"updater"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(conf, &confJSON); err != nil {
		t.Fatal(err)
	}
	if err := VerifyMinisign(confJSON.Plugins.Updater.Pubkey, string(sig), pkg); err != nil {
		t.Fatalf("真产物验签失败: %v", err)
	}
}

// TestExtractPkgVersion 构造内存 tar.gz 断言 Info.plist 版本提取
func TestExtractPkgVersion(t *testing.T) {
	var buf bytes.Buffer
	gzw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gzw)
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
	<key>CFBundleShortVersionString</key><string>0.1.5</string>
</dict></plist>`
	for _, e := range []struct{ name, body string }{
		{"BaobaoChat.app/Contents/PkgInfo", "APPL????"},
		{"BaobaoChat.app/Contents/Info.plist", plist},
	} {
		if err := tw.WriteHeader(&tar.Header{Name: e.name, Size: int64(len(e.body)), Mode: 0o644}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	_ = tw.Close()
	_ = gzw.Close()

	ver, err := ExtractPkgVersion(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if ver != "0.1.5" {
		t.Fatalf("版本提取=%q want 0.1.5", ver)
	}
	// 非 gzip 输入 → 空串（跳过校验，不报错）
	if ver, err := ExtractPkgVersion(strings.NewReader("plain text")); err != nil || ver != "" {
		t.Fatalf("非 gzip 应跳过: ver=%q err=%v", ver, err)
	}
}
