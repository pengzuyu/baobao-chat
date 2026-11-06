// Package gateway WS 接入层：信封编解码（14 篇 §2.2）、连接管理、消息路由、推送扇出。
package gateway

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// 协议版本（14 篇 §2.2：v=1）
const ProtocolVersion = 1

// Envelope WS 消息信封：请求 {v,id,type,ts,payload} / ack {...,ack,code} / 推送 {v,id,type,ts,payload}
type Envelope struct {
	V       int             `json:"v"`
	ID      string          `json:"id"` // c- 客户端 / s- 服务端前缀
	Ack     string          `json:"ack,omitempty"`
	Type    string          `json:"type"` // 域.动作（14 篇 §3 注册表）
	TS      int64           `json:"ts,omitempty"`
	Code    int             `json:"code"` // ack：0=成功必须显式输出（客户端 code===0 判定；曾因 omitempty 省略 0 导致发送误判失败）
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Decode 客户端请求解码：v 必须为 1，id/type 必填
func Decode(data []byte) (*Envelope, error) {
	var e Envelope
	if err := json.Unmarshal(data, &e); err != nil {
		return nil, fmt.Errorf("envelope json: %w", err)
	}
	if e.V != ProtocolVersion {
		return nil, fmt.Errorf("envelope v=%d 不支持（当前 %d）", e.V, ProtocolVersion)
	}
	if e.ID == "" {
		return nil, fmt.Errorf("envelope id 必填")
	}
	if e.Type == "" {
		return nil, fmt.Errorf("envelope type 必填")
	}
	return &e, nil
}

// Encode 序列化（出站前校验不变量）
func (e *Envelope) Encode() ([]byte, error) {
	if e.V != ProtocolVersion || e.ID == "" || e.Type == "" {
		return nil, fmt.Errorf("envelope 不完整: v=%d id=%q type=%q", e.V, e.ID, e.Type)
	}
	return json.Marshal(e)
}

// ackTypeFor 请求→回执类型：ping→pong；其余 req.ack（14 篇 §2.2）
func ackTypeFor(reqType string) string {
	if reqType == "ping" {
		return "pong"
	}
	return reqType + ".ack"
}

// NewAck 构造成对回执：ack=请求 id、type=ackTypeFor(req)、code=0 成功
func NewAck(req *Envelope, code int, payload any) *Envelope {
	e := &Envelope{
		V:    ProtocolVersion,
		ID:   NewServerID(),
		Ack:  req.ID,
		Type: ackTypeFor(req.Type),
		Code: code,
		TS:   NowMillis(),
	}
	if payload != nil {
		b, err := json.Marshal(payload)
		if err == nil {
			e.Payload = b
		}
	}
	return e
}

// NewPush 构造服务端推送（无对应请求）
func NewPush(typ string, payload any) *Envelope {
	e := &Envelope{V: ProtocolVersion, ID: NewServerID(), Type: typ, TS: NowMillis()}
	if payload != nil {
		if b, err := json.Marshal(payload); err == nil {
			e.Payload = b
		}
	}
	return e
}

// NowMillis 可注入时钟（测试）
var NowMillis = func() int64 { return time.Now().UnixMilli() }

// NewServerID 服务端信封 ID：s- + 自增（雪花占位）
func NewServerID() string {
	return "s-" + strconv.FormatInt(serverIDSeq(), 10)
}
