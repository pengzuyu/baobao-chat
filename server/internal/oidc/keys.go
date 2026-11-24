// Package oidc 实现 D28：bbc auth 对外的标准 OIDC Provider（zitadel/oidc v3 嵌入）。
// keys.go：ES256 签名密钥适配（op.SigningKey 接口）。
// 密钥装载已单源迁移 platform/agentjwt.LoadKey（D38 批2：agent 票与 OIDC 登录票
// 同一把私钥——生态应用经 jwks 验 agent 票，双密钥即验签失配）；kid=公钥指纹
// （拍板 7：轮换即换 kid，验证方缓存 miss → 重拉 jwks 自愈；旧固定串口径作废）。
package oidc

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/baobaochat/server/internal/platform/agentjwt"
)

type esSigningKey struct{ key *ecdsa.PrivateKey }

func (k esSigningKey) SignatureAlgorithm() jose.SignatureAlgorithm { return jose.ES256 }
func (k esSigningKey) Key() any                                    { return k.key }
func (k esSigningKey) ID() string                                  { return agentjwt.KidFor(&k.key.PublicKey) }

type esPublicKey struct{ key *ecdsa.PrivateKey }

func (k esPublicKey) ID() string                         { return agentjwt.KidFor(&k.key.PublicKey) }
func (k esPublicKey) Algorithm() jose.SignatureAlgorithm { return jose.ES256 }
func (k esPublicKey) Use() string                        { return "sig" }
func (k esPublicKey) Key() any                           { return &k.key.PublicKey }

// deriveCryptoKey op 库加密密钥（auth code 等对称加密用）：从签名私钥派生
// sha256——单 key 双用途，轮换签名密钥即同步轮换加密密钥（code 60s 一次性，无兼容负担）。
// （D38 批2：入参由 PEM 原文改为私钥对象——装载单源 agentjwt.LoadKey 后 module 不再持 PEM）
func deriveCryptoKey(key *ecdsa.PrivateKey) [32]byte {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		// 私钥来自已解析对象，序列化不可能失败；失败即装配错误早暴露
		panic("oidc: crypto key 派生: " + err.Error())
	}
	return sha256.Sum256(append([]byte("bbc-oidc-crypto|"), der...))
}
