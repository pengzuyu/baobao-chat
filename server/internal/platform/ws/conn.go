package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RFC6455 §1.3 握手 GUID
const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// CloseCode 应用层关闭码（RFC6455 §7.4）
const (
	CloseNormal      uint16 = 1000
	CloseGoingAway   uint16 = 1001
	CloseProtocolErr uint16 = 1002
	CloseInternal    uint16 = 1011
	CloseAuthFailed  uint16 = 4001 // 14 篇 §2.1：WS 认证失败关闭码
)

// AcceptKey 计算 Sec-WebSocket-Accept（SHA-1(key+GUID) 的 base64）
func AcceptKey(key string) string {
	h := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}

// Upgrade 校验并完成服务端握手（Hijack 后 ResponseWriter 不可再用）
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if r.Method != http.MethodGet {
		http.Error(w, "websocket: GET required", http.StatusMethodNotAllowed)
		return nil, fmt.Errorf("ws: method %s", r.Method)
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!headerContainsToken(r.Header.Get("Connection"), "upgrade") {
		http.Error(w, "websocket: not an upgrade request", http.StatusBadRequest)
		return nil, fmt.Errorf("ws: missing upgrade headers")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		http.Error(w, "websocket: version != 13", http.StatusUpgradeRequired)
		return nil, fmt.Errorf("ws: bad version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "websocket: missing key", http.StatusBadRequest)
		return nil, fmt.Errorf("ws: missing key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket: hijack unsupported", http.StatusInternalServerError)
		return nil, fmt.Errorf("ws: response writer not hijackable")
	}
	netConn, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + AcceptKey(key) + "\r\n\r\n"
	if _, err := brw.WriteString(resp); err != nil {
		netConn.Close()
		return nil, err
	}
	if err := brw.Flush(); err != nil {
		netConn.Close()
		return nil, err
	}
	return NewConn(brw.Reader, netConn, netConn), nil
}

// headerContainsToken 逐 token 比较（值可能为 "keep-alive, Upgrade"）
func headerContainsToken(v, token string) bool {
	for _, part := range strings.Split(v, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// Conn 服务端侧 WS 连接：读客户端（帧必须带掩码），写不掩码；写侧串行化
type Conn struct {
	r   *bufio.Reader
	nc  net.Conn // 底层连接（可设置 deadline；测试可为 nil）
	wmu sync.Mutex
	w   io.Writer
}

// NewConn r=帧读取源，w=帧写出目标，nc=底层连接（deadline/close 用，可 nil）
func NewConn(r io.Reader, w io.Writer, nc net.Conn) *Conn {
	br, ok := r.(*bufio.Reader)
	if !ok {
		br = bufio.NewReader(r)
	}
	return &Conn{r: br, w: w, nc: nc}
}

// ReadFrame 读一帧（服务端视角：强制客户端掩码）
func (c *Conn) ReadFrame() (*Frame, error) { return ReadFrame(c.r, true) }

// WriteFrame 写一帧（服务端不掩码；写锁保证信封不交错）
func (c *Conn) WriteFrame(f *Frame) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	var zero [4]byte
	return f.Encode(c.w, false, zero)
}

// WriteText 发送文本帧（信封 JSON）
func (c *Conn) WriteText(b []byte) error {
	return c.WriteFrame(&Frame{Fin: true, Opcode: OpText, Payload: b})
}

// WritePing 心跳探测
func (c *Conn) WritePing(data []byte) error {
	return c.WriteFrame(&Frame{Fin: true, Opcode: OpPing, Payload: data})
}

// WritePong 回应心跳
func (c *Conn) WritePong(data []byte) error {
	return c.WriteFrame(&Frame{Fin: true, Opcode: OpPong, Payload: data})
}

// WriteClose 发送 close 帧后即结束写入（对端应回 close，双向关闭）
func (c *Conn) WriteClose(code uint16, reason string) error {
	payload := make([]byte, 2, 2+len(reason))
	binary.BigEndian.PutUint16(payload, code)
	payload = append(payload, []byte(reason)...)
	return c.WriteFrame(&Frame{Fin: true, Opcode: OpClose, Payload: payload})
}

// SetReadDeadline 读超时：心跳超时判定用（14 篇 §2.1：60s 无心跳判定半开断开）
func (c *Conn) SetReadDeadline(t time.Time) error {
	if c.nc != nil {
		return c.nc.SetReadDeadline(t)
	}
	return nil
}

// Close 关闭底层连接
func (c *Conn) Close() error {
	if c.nc != nil {
		return c.nc.Close()
	}
	return nil
}

// RemoteAddr 对端地址（nc 为 nil 时返回空）
func (c *Conn) RemoteAddr() net.Addr {
	if c.nc != nil {
		return c.nc.RemoteAddr()
	}
	return nil
}

// randomMaskKey 生成客户端方向掩码键
func randomMaskKey() [4]byte {
	var k [4]byte
	if _, err := rand.Read(k[:]); err != nil {
		panic(fmt.Sprintf("ws: rand: %v", err))
	}
	return k
}
