package oidc

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"strings"
	"testing"

	"github.com/baobaochat/server/internal/platform/agentjwt"
)

// genPEM 生成 P-256 EC 私钥 PEM（EC PRIVATE KEY 形态）
func genPEM(t *testing.T) string {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成私钥失败: %v", err)
	}
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
}

// （D38 批2：装载逻辑迁移 platform/agentjwt.LoadKey——本文件保留原五场景回归，
// 调用点改委托；kid 指纹口径见 TestSigningKeyIDIsFingerprint）

func TestLoadSigningKeyRawPEM(t *testing.T) {
	p := genPEM(t)
	k, err := agentjwt.LoadKey(p)
	if err != nil || k == nil {
		t.Fatalf("原始多行 PEM 应可解析：k=%v err=%v", k, err)
	}
	if k.Curve != elliptic.P256() {
		t.Fatalf("曲线应为 P-256")
	}
}

// .env 单行注入形态：base64 包裹的 PEM（scripts/release/gen-oidc-key.sh 产出）
func TestLoadSigningKeyBase64Wrapped(t *testing.T) {
	p := genPEM(t)
	b64 := base64.StdEncoding.EncodeToString([]byte(p))
	if strings.ContainsAny(b64, "\n\r") {
		t.Fatal("base64 形态必须单行")
	}
	k, err := agentjwt.LoadKey(b64)
	if err != nil || k == nil {
		t.Fatalf("base64 包裹 PEM 应可解析：k=%v err=%v", k, err)
	}
}

// gen-oidc-key.sh 的实际产出形态：PKCS8 PEM → base64 单行
func TestLoadSigningKeyPKCS8Base64(t *testing.T) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成私钥失败: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatalf("PKCS8 序列化失败: %v", err)
	}
	p := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	b64 := base64.StdEncoding.EncodeToString([]byte(p))
	got, err := agentjwt.LoadKey(b64)
	if err != nil || got == nil {
		t.Fatalf("PKCS8+base64 应可解析：k=%v err=%v", got, err)
	}
}

func TestLoadSigningKeyEmptyAndGarbage(t *testing.T) {
	if k, err := agentjwt.LoadKey(""); k != nil || err != nil {
		t.Fatalf("空串应返回 (nil,nil)：k=%v err=%v", k, err)
	}
	if _, err := agentjwt.LoadKey("not-a-key!!!"); err == nil {
		t.Fatal("非法输入应报错")
	}
}

func TestLoadSigningKeyRejectsNonP256(t *testing.T) {
	k384, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatalf("生成 P-384 失败: %v", err)
	}
	der, err := x509.MarshalECPrivateKey(k384)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	p := string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
	if _, err := agentjwt.LoadKey(p); err == nil {
		t.Fatal("非 P-256 曲线应报错（ES256 要求）")
	}
}

// kid=公钥指纹（D38 拍板 7）：换密钥即换 kid（旧固定串口径作废）；
// 签名/公钥两适配的 kid 一致
func TestSigningKeyIDIsFingerprint(t *testing.T) {
	k1 := genKey(t)
	k2 := genKey(t)
	sk := esSigningKey{key: k1}
	pk := esPublicKey{key: k1}
	if sk.ID() != pk.ID() {
		t.Fatal("签名/公钥两适配的 kid 应一致")
	}
	sk2 := esSigningKey{key: k2}
	if sk.ID() == sk2.ID() {
		t.Fatal("不同密钥 kid 应不同（轮换即换 kid）")
	}
	if len(sk.ID()) != 16 {
		t.Fatalf("kid 应 16 hex: %q", sk.ID())
	}
}

func genKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}
