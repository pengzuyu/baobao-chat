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

func TestLoadSigningKeyRawPEM(t *testing.T) {
	p := genPEM(t)
	k, err := loadSigningKey(p)
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
	k, err := loadSigningKey(b64)
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
	got, err := loadSigningKey(b64)
	if err != nil || got == nil {
		t.Fatalf("PKCS8+base64 应可解析：k=%v err=%v", got, err)
	}
}

func TestLoadSigningKeyEmptyAndGarbage(t *testing.T) {
	if k, err := loadSigningKey(""); k != nil || err != nil {
		t.Fatalf("空串应返回 (nil,nil)：k=%v err=%v", k, err)
	}
	if _, err := loadSigningKey("not-a-key!!!"); err == nil {
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
	if _, err := loadSigningKey(p); err == nil {
		t.Fatal("非 P-256 曲线应报错（ES256 要求）")
	}
}