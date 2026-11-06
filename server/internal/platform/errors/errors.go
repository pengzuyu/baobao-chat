package errors

import (
	stderrors "errors"
	"fmt"
)

// E 统一业务错误：Code 必须取自 codes.go 注册表（14 篇 §7）。
type E struct {
	Code    Code
	Msg     string
	Details any // 可选结构化细节（如 retry_after_seconds），随响应包 details 下发
}

func (e *E) Error() string { return fmt.Sprintf("[%d] %s", e.Code, e.Msg) }

// New 构造业务错误
func New(code Code, msg string) *E { return &E{Code: code, Msg: msg} }

// NewWithDetails 构造带细节的业务错误
func NewWithDetails(code Code, msg string, details any) *E {
	return &E{Code: code, Msg: msg, Details: details}
}

// From 归一化任意 error 为 *E。
// 未知错误一律映射 9004 且不透出内部细节（14 篇 §7：9004/9005 靠 trace_id 排查）。
// nil → 返回 Code=0 的零值 E，保证调用方 From(err).Code 永不解引用 nil。
func From(err error) *E {
	if err == nil {
		return &E{Code: CodeOK}
	}
	var e *E
	if stderrors.As(err, &e) {
		return e
	}
	return &E{Code: CodeInternal, Msg: "internal error"}
}
