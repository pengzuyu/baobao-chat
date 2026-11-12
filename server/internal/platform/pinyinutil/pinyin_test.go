package pinyinutil

import "testing"

func TestPinyin(t *testing.T) {
	cases := map[string]string{
		"张三":    "zhangsan",
		"李四":    "lisi",
		"Jack张":  "jackzhang",
		"王-五.":   "wangwu",
		"O'Neil": "oneil",
		"···":     "",
	}
	for in, want := range cases {
		if got := Pinyin(in); got != want {
			t.Fatalf("Pinyin(%q)=%q want %q", in, got, want)
		}
	}
}

func TestInitials(t *testing.T) {
	cases := map[string]string{
		"张三":    "zs",
		"Jack张":  "jz",
		"欧阳锋":    "oyf",
		"O'Neil": "on",
		"···":     "",
	}
	for in, want := range cases {
		if got := Initials(in); got != want {
			t.Fatalf("Initials(%q)=%q want %q", in, got, want)
		}
	}
}
