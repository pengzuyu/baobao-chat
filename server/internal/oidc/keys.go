// Package oidc 实现 D28：bbc auth 对外的标准 OIDC Provider（zitadel/oidc v3 嵌入）。
// keys.go：ES256 签名密钥装载（env PEM 单密钥，手工轮换=拍板 10①；kid 静态）。
package oidc

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"

	jose "github.com/go-jose/go-jose/v4"
)

// keyID 静态 kid：手工轮换口径下换 env 私钥即换内容，kid 不需要区分新旧
// （旧 token ≤15min 自然过期后 jwks 无需双密钥窗口——D28 §10 收缩候选①落定）。
const keyID = "bbc-oidc-es256-1"

type esSigningKey struct{ key *ecdsa.PrivateKey }

func (k esSigningKey) SignatureAlgorithm() jose.SignatureAlgorithm { return jose.ES256 }
func (k esSigningKey) Key() any                                     { return k.key }
func (k esSigningKey) ID() string                                   { return keyID }

type esPublicKey struct{ key *ecdsa.PrivateKey }

func (k esPublicKey) ID() string                                   { return keyID }
func (k esPublicKey) Algorithm() jose.SignatureAlgorithm           { return jose.ES256 }
func (k esPublicKey) Use() string                                  { return "sig" }
func (k esPublicKey) Key() any                                     { return &k.key.PublicKey }

// loadSigningKey 解析 env 注入的 EC 私钥 PEM（EC PRIVATE KEY / PKCS8，P-256）。
// 空串返回 (nil, nil) 由调用方决定开发态兜底；格式非法显式报错。
func loadSigningKey(pemStr string) (*ecdsa.PrivateKey, error) {
	if pemStr == "" {
		return nil, nil
	}
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("BBC_OIDC_SIGNING_KEY 不是合法 PEM")
	}
	if k, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		if k.Curve != elliptic.P256() {
			return nil, errors.New("OIDC 签名密钥须为 P-256（ES256）")
		}
		return k, nil
	}
	anyKey, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("OIDC 签名密钥解析失败: %w", err)
	}
	k, ok := anyKey.(*ecdsa.PrivateKey)
	if !ok || k.Curve != elliptic.P256() {
		return nil, errors.New("OIDC 签名密钥须为 P-256 EC 私钥（ES256）")
	}
	return k, nil
}

// deriveCryptoKey op 库加密密钥（auth code 等对称加密用）：从签名密钥 PEM 派生
// sha256——单 env 双用途，轮换签名密钥即同步轮换加密密钥（code 60s 一次性，无兼容负担）。
func deriveCryptoKey(pemStr string) [32]byte {
	return sha256.Sum256([]byte("bbc-oidc-crypto|" + pemStr))
}
