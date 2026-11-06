package ws

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 客户端方向编码：随机掩码
func encodeClient(t *testing.T, f *Frame, key [4]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := f.Encode(&buf, true, key); err != nil {
		t.Fatalf("encode client: %v", err)
	}
	return buf.Bytes()
}

func TestFrameRoundtripMasked(t *testing.T) {
	// 固定掩码键 + 已知向量：key=0x01020304, "Hello" → 掩码后 "Igohn"
	f := &Frame{Fin: true, Opcode: OpText, Payload: []byte("Hello")}
	raw := encodeClient(t, f, [4]byte{1, 2, 3, 4})
	// 掩码后的载荷字节位于 头2字节 + 掩码4字节 之后
	if got := string(raw[6:]); got != "Igohn" {
		t.Fatalf("掩码向量不符: %q", got)
	}
	got, err := ReadFrame(bytes.NewReader(raw), true)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if !got.Fin || got.Opcode != OpText || string(got.Payload) != "Hello" {
		t.Fatalf("roundtrip 不一致: %+v %q", got, got.Payload)
	}
}

func TestFrameRoundtripServerUnmasked(t *testing.T) {
	f := &Frame{Fin: true, Opcode: OpText, Payload: []byte(`{"v":1}`)}
	var buf bytes.Buffer
	if err := f.Encode(&buf, false, [4]byte{}); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFrame(bytes.NewReader(buf.Bytes()), false)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if string(got.Payload) != `{"v":1}` {
		t.Fatalf("payload=%q", got.Payload)
	}
}

// 表驱动：非法帧必须被读取侧拒绝
func TestReadFrameRejects(t *testing.T) {
	big := make([]byte, 200) // 触发 126 扩展长度路径的合法载荷

	mkControl126 := func() []byte { // FIN+ping, len=126（非法：控制帧 >125）
		b := []byte{0x89, 0x7E, 0x00, 0x80}
		return append(b, make([]byte, 128)...)
	}
	mkTooLarge := func() []byte { // len=127 路径，超过 MaxPayload
		b := []byte{0x82, 0xFF}
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], MaxPayload+1)
		b = append(b, ext[:]...)
		return b
	}

	cases := []struct {
		name string
		raw  []byte
		want error
	}{
		{"客户端帧无掩码", []byte{0x81, 0x05, 'h', 'e', 'l', 'l', 'o'}, ErrUnmaskedClient},
		{"控制帧分片", []byte{0x09, 0x00}, ErrControlFragment},
		{"控制帧超长", mkControl126(), ErrControlTooLong},
		{"载荷超上限", mkTooLarge(), ErrPayloadTooLarge},
		{"RSV 位被置位", []byte{0xC1, 0x00}, ErrRSVSet},
		{"未知 opcode", []byte{0x87, 0x00}, ErrInvalidOpcode},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := ReadFrame(bytes.NewReader(c.raw), true); err != c.want {
				t.Fatalf("err=%v want=%v", err, c.want)
			}
		})
	}

	// 掩码但非完整载荷 → io.ErrUnexpectedEOF（截断帧）
	trunc := encodeClient(t, &Frame{Fin: true, Opcode: OpText, Payload: big}, randomMaskKey())
	if _, err := ReadFrame(bytes.NewReader(trunc[:len(trunc)-10]), true); err != io.ErrUnexpectedEOF {
		t.Fatalf("截断帧 err=%v", err)
	}
}

// 扩展长度路径：126（≤65535）与 127（>65535）
func TestExtendedLengthRoundtrip(t *testing.T) {
	for _, n := range []int{200, 70000} {
		payload := bytes.Repeat([]byte{0xA5}, n)
		f := &Frame{Fin: true, Opcode: OpBinary, Payload: payload}
		raw := encodeClient(t, f, randomMaskKey())
		got, err := ReadFrame(bytes.NewReader(raw), true)
		if err != nil {
			t.Fatalf("len=%d: %v", n, err)
		}
		if len(got.Payload) != n || !bytes.Equal(got.Payload, payload) {
			t.Fatalf("len=%d roundtrip 失败", n)
		}
	}
}

// ping/pong/close/text 在 Conn 上的写出与再解析
func TestConnPingPongClose(t *testing.T) {
	var out bytes.Buffer
	c := NewConn(bytes.NewReader(nil), &out, nil)

	if err := c.WritePing([]byte("hb")); err != nil {
		t.Fatal(err)
	}
	if err := c.WritePong([]byte("hb")); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteText([]byte(`{"v":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteClose(CloseNormal, "bye"); err != nil {
		t.Fatal(err)
	}

	// 快照后统一解析（bytes.Buffer 是消耗性的）
	snap := append([]byte(nil), out.Bytes()...)
	r := bufio.NewReader(bytes.NewReader(snap))
	ops := []struct {
		op   Opcode
		want string
	}{{OpPing, "hb"}, {OpPong, "hb"}, {OpText, `{"v":1}`}, {OpClose, ""}}
	var last *Frame
	for i, e := range ops {
		f, err := ReadFrame(r, false)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if f.Opcode != e.op {
			t.Fatalf("frame %d op=%d want=%d", i, f.Opcode, e.op)
		}
		if e.want != "" && string(f.Payload) != e.want {
			t.Fatalf("frame %d payload=%q", i, f.Payload)
		}
		last = f
	}
	// close 帧载荷前两字节为状态码 1000
	if last == nil || last.Opcode != OpClose || binary.BigEndian.Uint16(last.Payload[:2]) != 1000 {
		t.Fatal("close 帧状态码不符")
	}
}

// RFC6455 §1.3 示例向量
func TestAcceptKey(t *testing.T) {
	got := AcceptKey("dGhlIHNhbXBsZSBub25jZQ==")
	if got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("accept key=%q", got)
	}
}

// ---- 握手 ----

// hijackRecorder 实现 http.Hijacker 的最小 ResponseWriter（用 net.Pipe 承接 hijack）
type hijackRecorder struct {
	header http.Header
	conn   net.Conn
}

func (h *hijackRecorder) Header() http.Header         { return h.header }
func (h *hijackRecorder) WriteHeader(int)             {}
func (h *hijackRecorder) Write(b []byte) (int, error) { return len(b), nil }

func (h *hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return h.conn, bufio.NewReadWriter(bufio.NewReader(h.conn), bufio.NewWriter(h.conn)), nil
}

func newWSRequest(key string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/ws/connect", nil)
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Sec-WebSocket-Version", "13")
	if key != "" {
		r.Header.Set("Sec-WebSocket-Key", key)
	}
	return r
}

func TestUpgradeHandshake(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	rec := &hijackRecorder{header: http.Header{}, conn: serverConn}

	// pipe 同步无缓冲：先起 goroutine 收响应
	respCh := make(chan []byte, 1)
	go func() {
		b, _ := io.ReadAll(clientConn)
		respCh <- b
	}()

	conn, err := Upgrade(rec, newWSRequest("dGhlIHNhbXBsZSBub25jZQ=="))
	if err != nil {
		t.Fatalf("Upgrade: %v", err)
	}
	// 握手后连接可用：写入一帧文本
	if err := conn.WriteText([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close() // 触发对端 EOF 结束 io.ReadAll

	resp := string(<-respCh)
	if !strings.Contains(resp, "101 Switching Protocols") {
		t.Fatalf("响应非 101: %q", resp)
	}
	if !strings.Contains(resp, "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") {
		t.Fatalf("accept key 错误: %q", resp)
	}
	if !strings.Contains(resp, "hi") {
		// 握手响应与后续帧都应到达对端
		t.Fatalf("握手后续帧未送达: %q", resp)
	}
}

// 表驱动：握手前置校验
func TestUpgradeRejects(t *testing.T) {
	post := newWSRequest("k")
	post.Method = http.MethodPost
	oldVer := newWSRequest("k")
	oldVer.Header.Set("Sec-WebSocket-Version", "8")

	cases := []struct {
		name string
		req  *http.Request
	}{
		{"缺 Key", newWSRequest("")},
		{"非 GET", post},
		{"版本错误", oldVer},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := &hijackRecorder{header: http.Header{}}
			if _, err := Upgrade(rec, c.req); err == nil {
				t.Fatal("应拒绝")
			}
		})
	}
}
