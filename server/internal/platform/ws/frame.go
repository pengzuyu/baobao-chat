// Package ws 最小 RFC6455 实现（零第三方依赖）：帧编解码、握手、Conn 读写。
// 阶段一覆盖服务端所需子集：文本帧信封 + ping/pong + close；分片/压缩不协商
// （14 篇 §2.2：信封内不携带二进制，大流量走文件预签名直传）。
package ws

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Opcode 帧操作码（RFC6455 §5.2）
type Opcode byte

const (
	OpContinuation Opcode = 0x0
	OpText         Opcode = 0x1
	OpBinary       Opcode = 0x2
	OpClose        Opcode = 0x8
	OpPing         Opcode = 0x9
	OpPong         Opcode = 0xA
)

// IsControl 控制帧（不可分片、载荷 ≤125）
func (op Opcode) IsControl() bool { return op&0x8 != 0 }

// Valid 已知操作码白名单
func (op Opcode) Valid() bool {
	switch op {
	case OpContinuation, OpText, OpBinary, OpClose, OpPing, OpPong:
		return true
	}
	return false
}

// MaxPayload 单帧载荷上限（信封 JSON 远小于此；防御恶意帧）
const MaxPayload = 1 << 20 // 1 MiB

// 帧级错误（读取侧拒绝并断开）
var (
	ErrUnmaskedClient  = errors.New("ws: client frame must be masked")
	ErrMaskedServer    = errors.New("ws: server frame must not be masked")
	ErrControlFragment = errors.New("ws: control frame must not be fragmented")
	ErrControlTooLong  = errors.New("ws: control frame payload >125")
	ErrPayloadTooLarge = errors.New("ws: payload exceeds limit")
	ErrRSVSet          = errors.New("ws: RSV bits set without negotiation")
	ErrInvalidOpcode   = errors.New("ws: invalid opcode")
)

const (
	finBit  = 0x80
	rsvBits = 0x70
	maskBit = 0x80
	opBits  = 0x0F
)

// Frame 单个 WS 帧（解码后 Payload 已解掩码）
type Frame struct {
	Fin     bool
	Opcode  Opcode
	Payload []byte
}

// ReadFrame 从 r 读取一帧。
// requireMask=true 为服务端视角：客户端帧必须带掩码（RFC6455 §5.1，防中间代理缓存攻击）。
func ReadFrame(r io.Reader, requireMask bool) (*Frame, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	fin := hdr[0]&finBit != 0
	if hdr[0]&rsvBits != 0 {
		return nil, ErrRSVSet
	}
	op := Opcode(hdr[0] & opBits)
	if !op.Valid() {
		return nil, ErrInvalidOpcode
	}
	masked := hdr[1]&maskBit != 0
	length := uint64(hdr[1] & 0x7F)

	// 扩展长度：126→uint16，127→uint64
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	// 控制帧约束：FIN=1 且 ≤125
	if op.IsControl() {
		if !fin {
			return nil, ErrControlFragment
		}
		if length > 125 {
			return nil, ErrControlTooLong
		}
	}
	if length > MaxPayload {
		return nil, ErrPayloadTooLarge
	}
	if requireMask && !masked {
		return nil, ErrUnmaskedClient
	}
	if !requireMask && masked {
		return nil, ErrMaskedServer
	}

	// 帧布局：头2B + [扩展长度] + [掩码键4B] + 载荷（RFC6455 §5.1——掩码键在载荷之前）
	var key [4]byte
	if masked {
		if _, err := io.ReadFull(r, key[:]); err != nil {
			return nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	if masked {
		unmask(payload, key)
	}
	return &Frame{Fin: fin, Opcode: op, Payload: payload}, nil
}

// unmask 原地异或解掩码（RFC6455 §5.3：key[i % 4]）
func unmask(p []byte, key [4]byte) {
	for i := range p {
		p[i] ^= key[i%4]
	}
}

// Encode 序列化帧到 w。服务端发送不带掩码；客户端方向传 mask=true。
// 控制帧超长在编码侧同样拒绝（防御性，两端一致）。
func (f *Frame) Encode(w io.Writer, mask bool, key [4]byte) error {
	if !f.Opcode.Valid() {
		return ErrInvalidOpcode
	}
	if f.Opcode.IsControl() {
		if !f.Fin {
			return ErrControlFragment
		}
		if len(f.Payload) > 125 {
			return ErrControlTooLong
		}
	}

	b0 := byte(f.Opcode)
	if f.Fin {
		b0 |= finBit
	}
	var hdr []byte
	hdr = append(hdr, b0)

	n := len(f.Payload)
	lenByte := byte(0)
	switch {
	case n <= 125:
		lenByte = byte(n)
	case n <= 0xFFFF:
		lenByte = 126
	default:
		lenByte = 127
	}
	if mask {
		lenByte |= maskBit
	}
	hdr = append(hdr, lenByte)
	switch lenByte & 0x7F {
	case 126:
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(n))
		hdr = append(hdr, ext[:]...)
	case 127:
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		hdr = append(hdr, ext[:]...)
	}
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if mask {
		if _, err := w.Write(key[:]); err != nil {
			return err
		}
		maskedPayload := make([]byte, n)
		for i := 0; i < n; i++ {
			maskedPayload[i] = f.Payload[i] ^ key[i%4]
		}
		// 掩码分支内独立声明 err（此前误用 = 引用了不存在的变量）
		if _, err := w.Write(maskedPayload); err != nil {
			return err
		}
		return nil
	}
	_, err := w.Write(f.Payload)
	return err
}

// ReadTextFrame 从带缓冲读取器读文本帧（信封通道；非文本帧返回 ErrInvalidOpcode）
func ReadTextFrame(r *bufio.Reader) (*Frame, error) {
	f, err := ReadFrame(r, true)
	if err != nil {
		return nil, err
	}
	if f.Opcode != OpText {
		return nil, fmt.Errorf("%w: want text got %d", ErrInvalidOpcode, f.Opcode)
	}
	return f, nil
}
