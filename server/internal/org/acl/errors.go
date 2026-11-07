// 仓储接口哨兵与轻量错误（acl 包内自持）。
package acl

import "errors"

// ErrNotFound 撤销目标不存在
var ErrNotFound = errors.New("acl: entry not found")

type invalidArg struct{ msg string }

func (e invalidArg) Error() string { return "acl: " + e.msg }

func errInvalid(msg string) error { return invalidArg{msg: msg} }

// IsInvalid 管理面参数校验错误判定（handler 翻 400）
func IsInvalid(err error) bool {
	var ia invalidArg
	return errors.As(err, &ia)
}
