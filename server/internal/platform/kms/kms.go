// Package kms 嵌入式密钥加密件（19 篇 §1.2-2「密钥不出网关」的 v0.1 落地形态）：
// AES-256-GCM + 主密钥环境注入（BBW_KMS_MASTER_KEY，base64(32B)），
// 密文自描述（kms:v1: 前缀）落业务表引用列；外部 KMS/SDK 阶段二替换，密文格式兼容演进。
// 生成主密钥：openssl rand -base64 32（不入 git/日志）。
package kms

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
)

// RefPrefix 密文引用前缀（api_key_ref 存储形态：kms:v1:<b64(nonce|ct)>）
const RefPrefix = "kms:v1:"

// ErrMasterKeyMissing 主密钥未配置（无法加密新密钥；解密已有引用同因）
var ErrMasterKeyMissing = errors.New("kms: 未配置 BBW_KMS_MASTER_KEY")

// ErrBadRef 引用格式非法或解密失败（密文损坏/主密钥不匹配）
var ErrBadRef = errors.New("kms: 引用非法或解密失败")

// KMS AES-GCM 加解密器（空实例 = 未配置；io 安全：每次加密随机 nonce）
type KMS struct {
	aead cipher.AEAD
}

// New 从 base64 主密钥构造（32 字节 → AES-256）；空串返回 nil
func New(masterKeyB64 string) (*KMS, error) {
	if masterKeyB64 == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(masterKeyB64))
	if err != nil {
		return nil, fmt.Errorf("kms: 主密钥非 base64: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("kms: 主密钥需 32 字节（AES-256），实际 %d", len(raw))
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &KMS{aead: aead}, nil
}

// Encrypt 明文 → 自描述引用（kms:v1:<b64(nonce|ct)>）
func (k *KMS) Encrypt(plain string) (string, error) {
	if k == nil {
		return "", ErrMasterKeyMissing
	}
	nonce := make([]byte, k.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := k.aead.Seal(nonce, nonce, []byte(plain), nil)
	return RefPrefix + base64.StdEncoding.EncodeToString(ct), nil
}

// Decrypt 引用 → 明文（非 kms:v1: 前缀的原样返回——兼容无密钥 provider 的空引用）
func (k *KMS) Decrypt(ref string) (string, error) {
	if !strings.HasPrefix(ref, RefPrefix) {
		return ref, nil
	}
	if k == nil {
		return "", ErrMasterKeyMissing
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(ref, RefPrefix))
	if err != nil {
		return "", ErrBadRef
	}
	ns := k.aead.NonceSize()
	if len(raw) <= ns {
		return "", ErrBadRef
	}
	plain, err := k.aead.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", ErrBadRef
	}
	return string(plain), nil
}

// MaskKey 密钥掩码（接口回显口径：仅留末 4 位）
func MaskKey(key string) string {
	if len(key) <= 4 {
		return "****"
	}
	return "****" + key[len(key)-4:]
}
