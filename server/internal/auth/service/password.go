package authservice

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
)

// 口令方案：阶段一 PBKDF2-HMAC-SHA256 自实现（零第三方依赖）。
// TODO(阶段二)：换 argon2id（golang.org/x/crypto/argon2，03 篇 §2.1 口径），
// 格式前缀 pbkdf2-sha256$ → argon2id$，登录时按前缀兼容校验并择机重哈希。
const (
	pwScheme  = "pbkdf2-sha256"
	pwIter    = 60000 // 平衡安全与登录时延（CI/低配环境可降，勿低于 10000）
	pwSaltLen = 16
	pwKeyLen  = 32
)

// pbkdf2SHA256 PBKDF2（RFC 8018 §5.2）：DK = T1⊕T2⊕…⊕Tc，Ti = F(P,S,c,i)
func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	numBlocks := (keyLen + prf.Size() - 1) / prf.Size()
	dk := make([]byte, 0, numBlocks*prf.Size())
	var cnt [4]byte
	for block := 1; block <= numBlocks; block++ {
		// U1 = PRF(P, S || INT(i))（大端 4 字节块序号）
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(cnt[:], uint32(block))
		prf.Write(cnt[:])
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iter; i++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		dk = append(dk, t...)
	}
	return dk[:keyLen]
}

// hashWithIter 指定迭代次数哈希（测试用低迭代加速）
func hashWithIter(password string, iter int) (string, error) {
	salt := make([]byte, pwSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk := pbkdf2SHA256([]byte(password), salt, iter, pwKeyLen)
	return fmt.Sprintf("%s$%d$%s$%s", pwScheme, iter,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(dk)), nil
}

// HashPassword 生成存储哈希（格式：scheme$iter$salt$dk）
func HashPassword(password string) (string, error) { return hashWithIter(password, pwIter) }

// VerifyPassword 校验；格式非法/口令错误都返回 false（不区分原因，防侧信道）
func VerifyPassword(stored, password string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != pwScheme {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(password), salt, iter, len(want))
	// 常数时间比较，防时序攻击
	return subtle.ConstantTimeCompare(got, want) == 1
}
