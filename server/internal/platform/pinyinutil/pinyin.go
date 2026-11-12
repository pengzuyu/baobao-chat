// Package pinyinutil 姓名拼音工具（2026-11-12 通讯录工号方案+登录页搜人共用）：
// go-pinyin 封装——中文逐字转全拼/首字母（Normal 风格小写），ASCII 字母数字归一保留，
// 其余字符跳过；多音字取首读音，生成不准的场景（生僻字/姓氏多音）由端侧可改兜底。
package pinyinutil

import (
	"strings"

	"github.com/mozillazg/go-pinyin"
)

var args = pinyin.NewArgs()

// Pinyin 姓名全拼基名：张三→zhangsan；Jack张→jackzhang；O'Neil→oneil；纯符号→空串
func Pinyin(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
		case r >= 0x80:
			if py := pinyin.SinglePinyin(r, args); len(py) > 0 {
				b.WriteString(py[0])
			}
		}
	}
	return b.String()
}

// Initials 姓名拼音首字母：张三→zs；Jack张→jz（连续 ASCII 字母串取首字母，
// 每个汉字取拼音首字母；数字/符号跳过——登录页缩写检索用）
func Initials(name string) string {
	var b strings.Builder
	prevLetter := false
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			if !prevLetter { // 字母串首见才取——Jack→j 而非 jack
				lower := r | 0x20
				b.WriteRune(lower)
			}
			prevLetter = true
		case r >= 0x80:
			prevLetter = false
			if py := pinyin.SinglePinyin(r, args); len(py) > 0 && py[0] != "" {
				b.WriteByte(py[0][0])
			}
		default:
			prevLetter = false
		}
	}
	return b.String()
}
