// util.go：三子域（skills/plugins/expert）共用的格式校验 helper。
// 原定义在 app.go（D09 生态应用），应用子域 2026-11-25 整域退役后迁此。
package ecoservice

import (
	"strconv"
	"strings"
)

// validAppID 命名空间标识校验（小写字母数字与 . _ -）
func validAppID(s string) bool {
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !ok {
			return false
		}
	}
	return true
}

// validSemver 语义化版本校验（x.y.z，每段数字 ≤8 位）
func validSemver(v string) bool {
	parts := strings.Split(strings.TrimSpace(v), ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if p == "" || len(p) > 8 {
			return false
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func i64s(n int64) string { return strconv.FormatInt(n, 10) }
