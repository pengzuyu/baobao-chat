// KMS 加解密往返/掩码/未配置行为测试。
package kms

import (
	"encoding/base64"
	"strings"
	"testing"
)

func testMaster() string {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(i)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	k, err := New(testMaster())
	if err != nil || k == nil {
		t.Fatalf("构造失败: %v %v", k, err)
	}
	ref, err := k.Encrypt("sk-test-1234567890abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ref, RefPrefix) {
		t.Fatalf("引用应带前缀: %s", ref)
	}
	plain, err := k.Decrypt(ref)
	if err != nil || plain != "sk-test-1234567890abcdef" {
		t.Fatalf("往返失败: %q %v", plain, err)
	}
}

func TestEncryptNonceRandomized(t *testing.T) {
	k, _ := New(testMaster())
	r1, _ := k.Encrypt("same-input")
	r2, _ := k.Encrypt("same-input")
	if r1 == r2 {
		t.Fatal("同明文两次加密密文应不同（随机 nonce）")
	}
}

func TestDecryptPlainPassThrough(t *testing.T) {
	// 兼容：非 kms:v1: 引用原样返回（无密钥 provider 的空串/历史数据）
	var k *KMS
	if s, err := k.Decrypt(""); err != nil || s != "" {
		t.Fatalf("空引用应透传: %q %v", s, err)
	}
	if s, err := k.Decrypt("legacy"); err != nil || s != "legacy" {
		t.Fatalf("无前缀引用应透传: %q %v", s, err)
	}
}

func TestNilKMSRefusesEncrypt(t *testing.T) {
	var k *KMS
	if _, err := k.Encrypt("secret"); err != ErrMasterKeyMissing {
		t.Fatalf("未配置应拒绝加密: %v", err)
	}
	// kms:v1: 引用在未配置时解密也应明确报错
	if _, err := k.Decrypt(RefPrefix + "AAAA"); err != ErrMasterKeyMissing {
		t.Fatalf("未配置应拒绝解密: %v", err)
	}
}

func TestMasterKeyValidation(t *testing.T) {
	if _, err := New("not-base64!!!"); err == nil {
		t.Fatal("非 base64 应报错")
	}
	short := base64.StdEncoding.EncodeToString(make([]byte, 16))
	if _, err := New(short); err == nil {
		t.Fatal("16 字节应报错")
	}
	if k, err := New(""); err != nil || k != nil {
		t.Fatal("空主密钥应返回 (nil,nil)=未配置")
	}
}

func TestBadRefRejected(t *testing.T) {
	k, _ := New(testMaster())
	if _, err := k.Decrypt(RefPrefix + "###notb64###"); err != ErrBadRef {
		t.Fatalf("非法 base64 应 ErrBadRef: %v", err)
	}
	if _, err := k.Decrypt(RefPrefix + base64.StdEncoding.EncodeToString([]byte("short"))); err != ErrBadRef {
		t.Fatalf("截断密文应 ErrBadRef: %v", err)
	}
	// 主密钥不匹配：另一 KMS 实例解不开
	other := make([]byte, 32)
	for i := range other {
		other[i] = byte(255 - i)
	}
	k2, _ := New(base64.StdEncoding.EncodeToString(other))
	ref, _ := k.Encrypt("x")
	if _, err := k2.Decrypt(ref); err != ErrBadRef {
		t.Fatalf("异主密钥应解密失败: %v", err)
	}
}

func TestMaskKey(t *testing.T) {
	if MaskKey("abcdefgh") != "****efgh" {
		t.Fatal("长密钥应留末 4 位")
	}
	if MaskKey("abc") != "****" {
		t.Fatal("短密钥应全掩")
	}
}
