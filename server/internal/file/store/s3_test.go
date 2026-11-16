// S3 存储层单测（D25 O1）：构造校验/键布局/预签名 URL 结构离线验证
//（PresignHTTP 纯计算，静态凭证零网络）；真机集成链由 BBW_TEST_S3_ADDR 门控（O2 验收）。
package store

import (
	"context"
	"crypto/sha256"
	"strings"
	"testing"
	"time"
)

func TestNewS3Validation(t *testing.T) {
	if _, err := NewS3(S3Options{}); err == nil {
		t.Fatal("空 endpoint 应拒绝")
	}
	if _, err := NewS3(S3Options{Endpoint: "http://rustfs:9000", PublicEndpoint: "://bad"}); err == nil {
		t.Fatal("非法对外端点应拒绝")
	}
	// 多级前缀拒绝（仅支持一级 /oss）
	if _, err := NewS3(S3Options{Endpoint: "http://rustfs:9000", PublicEndpoint: "https://d.com/a/b"}); err == nil {
		t.Fatal("多级前缀应拒绝")
	}
	s, err := NewS3(S3Options{Endpoint: "http://rustfs:9000"})
	if err != nil {
		t.Fatal(err)
	}
	if s.bucket != "bbw-data" || s.publicBase != "http://rustfs:9000" || s.urlPrefix != "" {
		t.Fatalf("默认值错误: %+v", s)
	}
}

func TestS3KeyLayout(t *testing.T) {
	if got := BlobKey(3, "abcdef1234"); got != "t/3/ab/abcdef1234" {
		t.Fatalf("内容键布局错误: %s", got)
	}
	if got := MpKey("up-1"); got != "s/up-1" {
		t.Fatalf("会话键错误: %s", got)
	}
	if got := s3StagingKey("up-1", 7); got != "s2/up-1/00007" {
		t.Fatalf("兼容分片键错误: %s", got)
	}
}

// TestS3PresignOffline 预签名 URL 结构（D25 拍板②核心语义）：
// ①签名路径=去前缀规范路径（/bucket/key）；②返回 URL 拼回 /oss 前缀；
// ③query 携带 partNumber/uploadId/X-Amz-Expires 与签名四件套。
func TestS3PresignOffline(t *testing.T) {
	s, err := NewS3(S3Options{
		Endpoint: "http://rustfs:9000",
		PublicEndpoint: "https://chat.example.com/oss",
		AccessKey: "ak", SecretKey: "sk",
	})
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.PresignPart(context.Background(), "up-9", "S3UPID", 12, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u, "https://chat.example.com/oss/bbw-data/s/up-9?") {
		t.Fatalf("URL 前缀拼回错误: %s", u)
	}
	for _, kv := range []string{"partNumber=12", "uploadId=S3UPID", "X-Amz-Expires=3600", "X-Amz-Algorithm=AWS4-HMAC-SHA256", "X-Amz-Signature=", "X-Amz-Credential=ak%2F"} {
		if !strings.Contains(u, kv) {
			t.Fatalf("query 缺 %s: %s", kv, u)
		}
	}
	g, err := s.PresignGet(context.Background(), "t/1/ab/abcd", 120*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(g, "https://chat.example.com/oss/bbw-data/t/1/ab/abcd?") {
		t.Fatalf("GET 预签名前缀错误: %s", g)
	}
	if !strings.Contains(g, "X-Amz-Expires=120") {
		t.Fatalf("GET 时效错误: %s", g)
	}

	// 无前缀形态（内网直连）：URL 即内部路径
	s2, _ := NewS3(S3Options{Endpoint: "http://192.168.1.8:9000", AccessKey: "ak", SecretKey: "sk"})
	u2, err := s2.PresignGet(context.Background(), "t/1/ab/abcd", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u2, "http://192.168.1.8:9000/bbw-data/t/1/ab/abcd?") {
		t.Fatalf("直连形态错误: %s", u2)
	}
}

// TestS3CountingReader 超限即停（不无界缓冲）
func TestS3CountingReader(t *testing.T) {
	cr := &countingReader{r: strings.NewReader("1234567890"), max: 5, sha: sha256.New()}
	buf := make([]byte, 4)
	var n int64
	for {
		_, err := cr.Read(buf)
		n = cr.n
		if cr.tooLarge {
			break
		}
		if err != nil {
			t.Fatalf("意外 EOF: %d", n)
		}
	}
	if n != 8 { // 4+4：第二块读满后累计 8 > 5 判超限
		t.Fatalf("超限计数错误: %d", n)
	}
}
