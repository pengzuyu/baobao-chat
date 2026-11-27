// verify.go：登记时服务端校验（0.1.5）——minisign 验签 + 安装包内版本一致性。
// 识别与预检在前端（选文件时自动分配包/.sig、解包回填版本号），真正的验证在这里：
// 防「传错文件/改了包没换签名/版本填错」三类事故在 draft 阶段即失败。
//
// tauri 签名格式（minisign-verify 0.3 同语义，2026-11-27 用真产物逆向锁死）：
//   公钥 blob = "Ed" + keyID(8B) + ed25519 pub(32B)        → 42B
//   签名 blob = "ED" + keyID(8B) + ed25519 sig(64B)         → 74B（ED=pre-hashed；
//             消息 = BLAKE2b-512(制品全文)，普通 Ed25519（非 RFC 8032 ph 模式））
//   主验签通过后还须验 trusted comment 第二签名：ed25519 over (sig64 || trusted 文本)。
// tauri.conf.json 的 pubkey 与 .sig 文件均为「minisign 文件全文的 base64」单行封装。
package release

import (
	"archive/tar"
	"compress/gzip"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"golang.org/x/crypto/blake2b"
)

var (
	errSigFormat = errors.New("minisign: 格式非法（不是合法的公钥/签名文件）")
	errSigAlgo   = errors.New("minisign: 未知签名算法（既非 ED pre-hashed 也非 Ed 标准）")
	errKeyID     = errors.New("签名密钥与 updater 公钥不匹配（keyID 不一致：.sig 用了另一把私钥签的）")
	errSigBad    = errors.New("签名校验失败：.sig 与安装包不匹配（包内容与签名不符，或两者非同一产物）")
	// plist 版本正则：Info.plist XML 里 CFBundleShortVersionString 的 string 值
	plistVersionRe = regexp.MustCompile(`<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>`)
)

// minisignText 展开封装（tauri 的 pubkey/.sig 都是「文件全文 base64」单行；明文文本原样通过）
func minisignText(input string) string {
	input = strings.TrimSpace(input)
	if strings.HasPrefix(input, "untrusted comment:") {
		return input
	}
	if raw, err := base64.StdEncoding.DecodeString(input); err == nil && strings.HasPrefix(string(raw), "untrusted comment:") {
		return string(raw)
	}
	return input
}

// PubKey 解析后的公钥
type PubKey struct {
	keyID []byte // 8B
	pub   ed25519.PublicKey
}

// ParsePubKey 解 tauri pubkey（base64 单行或 minisign 公钥文件文本）
func ParsePubKey(input string) (*PubKey, error) {
	blob, err := firstBlobLine(minisignText(input))
	if err != nil {
		return nil, err
	}
	if len(blob) != 42 || string(blob[:2]) != "Ed" {
		return nil, errSigFormat
	}
	return &PubKey{keyID: blob[2:10], pub: ed25519.PublicKey(blob[10:])}, nil
}

// Signature 解析后的签名
type Signature struct {
	prehashed bool
	keyID     []byte // 8B
	sig       []byte // 64B
	trusted   string // trusted comment 内容（无前缀；可空）
	globalSig []byte // trusted comment 的第二签名（64B；可空）
}

// ParseSignature 解 .sig 文件内容（tauri 单行 base64 封装或 minisign 文件文本）
func ParseSignature(input string) (*Signature, error) {
	lines := strings.Split(minisignText(input), "\n")
	out := &Signature{}
	sigSeen := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "untrusted comment:") {
			continue
		}
		if strings.HasPrefix(line, "trusted comment:") {
			out.trusted = strings.TrimLeft(strings.TrimPrefix(line, "trusted comment:"), " ")
			continue
		}
		blob, err := base64.StdEncoding.DecodeString(line)
		if err != nil {
			return nil, errSigFormat
		}
		if !sigSeen {
			// "ED"(74B pre-hashed+keyID) 或 "Ed"(66B 标准 legacy)
			switch {
			case len(blob) == 74 && string(blob[:2]) == "ED":
				out.prehashed = true
				out.keyID = blob[2:10]
				out.sig = blob[10:]
			case len(blob) == 66 && string(blob[:2]) == "Ed":
				out.sig = blob[2:]
			default:
				return nil, errSigAlgo
			}
			sigSeen = true
			continue
		}
		if len(blob) == 64 {
			out.globalSig = blob
		}
	}
	if !sigSeen {
		return nil, errSigFormat
	}
	return out, nil
}

// firstBlobLine 取文本中第一行有效 base64 blob（公钥用）
func firstBlobLine(text string) ([]byte, error) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "untrusted comment:") || strings.HasPrefix(line, "trusted comment:") {
			continue
		}
		blob, err := base64.StdEncoding.DecodeString(line)
		if err != nil {
			return nil, errSigFormat
		}
		return blob, nil
	}
	return nil, errSigFormat
}

// VerifyMinisign 用 tauri pubkey（base64）对制品全文验签名（.sig 文件内容）。
// 语义与 minisign-verify 0.3 对齐：keyID 强校验；ED=BLAKE2b-512 摘要上的 Ed25519；
// trusted comment 第二签名存在即一并校验（防 comment 元数据被篡改）。
func VerifyMinisign(pubkeyB64, sigText string, data []byte) error {
	pk, err := ParsePubKey(pubkeyB64)
	if err != nil {
		return fmt.Errorf("公钥解析失败: %w", err)
	}
	sg, err := ParseSignature(sigText)
	if err != nil {
		return fmt.Errorf("签名解析失败: %w", err)
	}
	if len(sg.keyID) > 0 && !bytesEqual(pk.keyID, sg.keyID) {
		return errKeyID
	}
	msg := data
	if sg.prehashed {
		h := blake2b.Sum512(data)
		msg = h[:]
	}
	if !ed25519.Verify(pk.pub, msg, sg.sig) {
		return errSigBad
	}
	if len(sg.globalSig) > 0 {
		payload := append(append([]byte{}, sg.sig...), sg.trusted...)
		if !ed25519.Verify(pk.pub, payload, sg.globalSig) {
			return errors.New("trusted comment 校验失败：签名元数据（版本/文件名）与签名不符")
		}
	}
	return nil
}

func bytesEqual(a, b []byte) bool {
	return len(a) == len(b) && strings.EqualFold(string(a), string(b))
}

// ExtractPkgVersion 从 .app.tar.gz 流中提取 Info.plist 的 CFBundleShortVersionString。
// 流式遍历 tar entry，读到目标 plist 即提前终止；非 tar.gz/找不到 → 返回 ""（跳过校验）。
func ExtractPkgVersion(rd io.Reader) (string, error) {
	gz, err := gzip.NewReader(rd)
	if err != nil {
		return "", nil // 不是 gzip（如 AppImage/exe）：跳过版本校验
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return "", nil
		}
		if err != nil {
			return "", fmt.Errorf("tar 遍历失败: %w", err)
		}
		if strings.HasSuffix(hdr.Name, ".app/Contents/Info.plist") {
			// plist 可能是 XML 或二进制格式（tauri bundler 落 XML；二进制则正则不中→空=跳过）
			raw, err := io.ReadAll(io.LimitReader(tr, 1<<20))
			if err != nil {
				return "", fmt.Errorf("读 Info.plist 失败: %w", err)
			}
			if m := plistVersionRe.FindSubmatch(raw); m != nil {
				return string(m[1]), nil
			}
			return "", nil
		}
	}
}
